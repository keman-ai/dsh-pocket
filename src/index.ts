/**
 * Host half: the local surface of pocket.
 *
 * It serves four routes on dsh's own web server — status, link, callback, unlink — and
 * owns the credentials for this machine. The relay connection is driven from here too,
 * but only ever outbound: this plugin never makes dsh listen on anything the loopback
 * port does not already listen on.
 *
 * The client half calls these routes with a same-origin fetch rather than ctx.remote —
 * the remote capability set is fixed at api-remotes build time and third-party plugins
 * cannot add to it (packages/api/remotes/README.zh.md).
 */

import type { IncomingMessage, ServerResponse } from 'node:http'
import type {
  Context, SessionProjectionCache, SessionProjectionRegistry, SessionQueryEngine, SessionRecord,
} from '@deepseek-ai/cordis'
import { clearCredentials, profileDirOf, readCredentials, writeCredentials } from './credentials.ts'
import { beginLink, cancelLink, isLinking, needsSecretUpgrade, upgradeToDeviceSecret, type LinkEndpoints } from './link.ts'
import { PhoneApprovals } from './approvals.ts'
import { runAction, speak } from './actions.ts'
import { PhoneQuestions } from './questions.ts'
import { archiveSession, createSession, readHistory, renameSession } from './history.ts'
import { readCatalog, selectModel, takeFailure } from './models.ts'
import { readSettings, updateSetting } from './settings.ts'
import { workspaceOfSession } from './workspaces.ts'
import { clearPairingKey, pairingKey, rotatePairingKey, verifyApproval } from './pairing.ts'
import { RelayClient, type RelayState } from './relay.ts'
import { SessionProjector } from './sessions.ts'
import type { PocketAction, PocketStatus, SessionSummary } from './types.ts'

export * from './types.ts'

/** Plugin name (the `name` of the loader entry). */
export const name = 'dsh-pocket'

/**
 * The web server carries the local routes; the session store is what pocket projects to
 * the phone. Neither is optional, so both are hard injections.
 */
export const inject = ['webServer', 'sessions', 'agents']

/** Route prefix. The client half builds its URLs from the same constant. */
export const API_PREFIX = '/pocket/api'

/** Plugin version, sent in the hello frame. Bump it together with package.json. */
const PLUGIN_VERSION = '0.1.0'

/** Default endpoints. Overridable so a staging profile can point elsewhere. */
const DEFAULT_ACCOUNT_ORIGIN = 'https://account.a2hmarket.ai'
const DEFAULT_USER_ORIGIN = 'https://api.a2hmarket.ai/findu-user'
/*
 * 🔴 Deliberately the load balancer's own name, not the CDN in front of it.
 *
 * The relay client derives its WebSocket URL from this origin, and a CDN is the wrong
 * carrier for a long-lived socket: it adds its own idle and connection timeouts on top
 * of the ones we already have to reason about, and buys nothing — this is a native
 * client, there is nothing to cache or accelerate.
 *
 * The REST calls ride the same origin for a simpler reason: one origin means one place
 * to point at a staging deployment.
 */
const DEFAULT_RELAY_ORIGIN = 'https://api-prod.a2hmarket.ai/a2hmarket-pocket'

/** Plugin config. */
export interface Config {
  /**
   * Whether the relay connection is allowed at all.
   *
   * 🔴 Defaults to false, and the bundle ships it false. Attaching a machine that can run
   * bash to a public relay is the user's decision to make in Settings, not something a
   * profile turns on behind their back.
   */
  readonly enabled?: boolean
  /** Account site origin, serving the approval page. */
  readonly accountOrigin?: string
  /** findu-user origin, serving the code-for-token exchange. */
  readonly userOrigin?: string
  /** Relay origin. */
  readonly relayOrigin?: string
}

/** JSON response. */
function json(res: ServerResponse, status: number, body: unknown): void {
  const payload = JSON.stringify(body)
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
    'content-length': Buffer.byteLength(payload),
  })
  res.end(payload)
}

/**
 * Allow state-changing operations only from a direct local connection.
 *
 * Only the socket's peer address counts, and any forwarding header is an outright
 * refusal — a reverse proxy relaying an external request also looks like 127.0.0.1 on
 * the socket, so the address alone would hollow out the guarantee.
 */
function isDirectLoopback(req: IncomingMessage): boolean {
  if (req.headers['x-forwarded-for'] !== undefined || req.headers['x-forwarded-host'] !== undefined) return false
  const address = req.socket.remoteAddress ?? ''
  return address === '127.0.0.1' || address === '::1' || address === '::ffff:127.0.0.1'
}

/** Same-origin POST: when Origin is present it must match Host, blocking other pages from commanding the local port. */
function isSameOrigin(req: IncomingMessage): boolean {
  const origin = req.headers.origin
  if (origin === undefined) return true
  try {
    return new URL(origin).host === req.headers.host
  } catch {
    return false
  }
}

/**
 * Mount pocket's local surface.
 * @param ctx - Host plugin context.
 * @param config - Resolved plugin config.
 */
export function apply(ctx: Context, config?: Config): void {
  const endpoints: LinkEndpoints = {
    accountOrigin: config?.accountOrigin ?? DEFAULT_ACCOUNT_ORIGIN,
    userOrigin: config?.userOrigin ?? DEFAULT_USER_ORIGIN,
    relayOrigin: config?.relayOrigin ?? DEFAULT_RELAY_ORIGIN,
  }
  const enabled = config?.enabled ?? false
  const profileDir = profileDirOf(ctx.baseUrl)

  let relay: RelayClient | undefined
  let relayState: RelayState = 'offline'
  let lastError: string | undefined
  let viewers = 0
  let droppedApprovals = 0

  const projector = new SessionProjector((projected) => { relay?.sendSessionEvent(projected) })

  const approvals = new PhoneApprovals({
    viewers: () => viewers,
    ask: (request) => relay?.sendApproval(request) ?? false,
    log: ctx.logger,
  })

  /**
   * The session list comes from sessionQuery — the whole corpus, including sessions
   * that were never loaded into memory.
   *
   * 🔴 Not ctx.sessions.list(): that holds only what is live right now, so after any
   * dsh restart it is empty and the phone shows "no sessions on this machine" while
   * dsh's own window lists dozens. sessionQuery is optional; without it, fall back to
   * the live list — worse than the real thing, better than nothing.
   */
  /**
   * The title dsh's own list shows, read the way it reads it: live sessions from the
   * projection registry, cold ones from the persisted projection cache. Neither path
   * loads a full log — that cache exists for exactly this listing case.
   *
   * Any failure means "no title". A row missing its title is degraded; throwing here
   * would blank the whole list.
   */
  const titleOf = (record: SessionRecord): string | undefined => {
    try {
      const live = ctx.sessions.get(record.header.id)
      const block = live !== undefined
        ? ctx.get<SessionProjectionRegistry>('sessionProjections')?.snapshot(live)
        : ctx.get<SessionProjectionCache>('sessionProjectionCache')?.cachedSnapshot(record.header)
      const title = block?.values['title']
      return typeof title === 'string' && title !== '' ? title : undefined
    } catch {
      return undefined
    }
  }

  const listSessions = async (): Promise<SessionSummary[]> => {
    // 一次列表一次工作区查询，而不是每个会话查一次。
    const workspaces = await workspaceOfSession(ctx)
    const workspaceOf = (sessionId: string): string | undefined => workspaces.get(sessionId)

    const query = ctx.get<SessionQueryEngine>('sessionQuery')
    if (query === undefined) {
      return projector.summaries(ctx.sessions.list().map((session) => ({
        header: session.header, live: true, persisted: false,
      })), titleOf, workspaceOf)
    }
    return projector.summaries(await query.listSessions(), titleOf, workspaceOf)
  }

  const renameDevice = (name: string): void => {
    if (profileDir === undefined) return
    const current = readCredentials(profileDir)
    if (current === undefined) return
    writeCredentials(profileDir, { ...current, deviceName: name })
  }

  /*
   * The agent's questions. Built before the relay because `onAction` closes over it;
   * it stays idle until a phone attaches (see `setViewers`).
   */
  const questions = new PhoneQuestions({
    viewers: () => viewers,
    ask: (ask) => { relay?.sendQuestion(ask) },
    resolved: (rpcId) => { relay?.sendQuestionResolved(rpcId) },
    log: ctx.logger,
  })
  /*
   * Join the answerer chain. Same waterfall shape as approvals: answer to claim the
   * question, or call next() to hand it to whoever else is listening — the desktop UI.
   */
  /*
   * 🔴 `true` 是 prepend，不是可有可无的第三个参数。
   *
   * 瀑布按注册顺序走，而浏览器那套 UI 的答复者在 web-app bundle 里、加载在本插件之前。
   * 它接下提问之后就坐等电脑前的人回答——电脑上没开着页面时它等到天荒地老，本插件永远
   * 轮不到。实测：agent 调了 ask_user_question、turn 一直挂着，而插件的 questionsSeen
   * 始终是 0。
   *
   * 前插在这里是安全的，因为本插件只在**真有手机在看**时才接：没人看就立刻 next() 交回去，
   * 抢不走电脑端的决定权。
   */
  ctx.effect(
    () => ctx.on('user-questions/request', (request, next) => questions.answer(request, next), true),
    'pocket: user-question answerer',
  )
  ctx.effect(() => () => { questions.releaseAll() }, 'pocket: release pending questions')

  const onAction = (action: PocketAction): void => {
    if (action.t === 'approval.respond') {
      /*
       * 🔴 Verify before honouring.
       *
       * This frame crossed the relay, which is not in the trust boundary: unsigned,
       * whoever controls the relay could mint an approval and have this machine run
       * whatever the agent just asked to run. The signature reduces the relay to a dumb
       * pipe — it can read frames and drop them, but it cannot manufacture a new
       * approval.
       */
      if (profileDir === undefined) return
      const signature = action.sig
      if (signature === undefined
        || !verifyApproval(pairingKey(profileDir), action.requestId, action.decision, signature)) {
        droppedApprovals += 1
        ctx.logger.warn('[pocket] an approval answer failed signature check and was dropped')
        return
      }
      approvals.resolve(action.requestId, action.decision)
      return
    }
    if (action.t === 'pair.request') {
      /*
       * Hand over the signing key.
       *
       * ⚠️ This crosses the relay, which is a deliberate trade-off (owner's call,
       * 2026-08-27: scanning a code was judged too much friction, and the account is
       * accepted as the gate). The signature therefore stops other connections from
       * forging an approval, but not the relay itself.
       *
       * Restoring "not even the relay" needs only the delivery changed back to
       * out-of-band — which is why the signing machinery is kept rather than deleted.
       */
      if (profileDir !== undefined) relay?.sendPairingKey(pairingKey(profileDir).toString('base64url'))
      return
    }
    if (action.t === 'settings.list') {
      void readSettings(ctx).then((groups) => { relay?.sendSettings(groups) })
      return
    }
    if (action.t === 'settings.set') {
      void updateSetting(ctx, action.ns, action.patch)
        // 改完把整组重读一遍：权威值在 dsh 那边，手机上显示的应该是它确认后的结果。
        .then(() => readSettings(ctx))
        .then((groups) => { relay?.sendSettings(groups) })
      return
    }
    if (action.t === 'session.list') {
      relay?.sendSessionList()
      return
    }
    if (action.t === 'session.open') {
      // 打开会话先补历史：一屏空白等着下一条消息，不是「打开会话」该有的样子。
      void readHistory(ctx, action.sessionId).then((page) => {
        if (page !== undefined) relay?.sendHistory(action.sessionId, { ...page })
      })
      return
    }
    if (action.t === 'session.more') {
      void readHistory(ctx, action.sessionId, action.beforeSeq).then((page) => {
        if (page !== undefined) relay?.sendHistory(action.sessionId, { ...page })
      })
      return
    }
    if (action.t === 'session.create') {
      void createSession(ctx).then((sessionId) => {
        if (sessionId === undefined) {
          relay?.sendError('create-failed', '新建会话失败')
          return
        }
        // 建完把列表重推一遍，手机上立刻能看到新会话。
        relay?.sendSessionList()
      })
      return
    }
    if (action.t === 'session.rename') {
      void renameSession(ctx, action.sessionId, action.title).then((ok) => {
        if (ok) relay?.sendSessionList()
      })
      return
    }
    if (action.t === 'session.archive') {
      void archiveSession(ctx, action.sessionId).then((ok) => {
        if (ok) relay?.sendSessionList()
      })
      return
    }
    if (action.t === 'model.list') {
      void readCatalog(ctx, action.sessionId).then((catalog) => {
        if (catalog !== undefined) {
          relay?.sendModelCatalog(action.sessionId, { ...catalog })
          return
        }
        relay?.sendError('model-catalog-failed', takeFailure() ?? '读不到模型列表')
      })
      return
    }
    if (action.t === 'model.select') {
      void selectModel(ctx, action.sessionId, action.provider, action.model)
        // Re-read the catalog after switching: the phone's "current" must follow, and the
    // authoritative value lives in dsh.
        .then(() => readCatalog(ctx, action.sessionId))
        .then((catalog) => {
          if (catalog !== undefined) relay?.sendModelCatalog(action.sessionId, { ...catalog })
        })
      return
    }
    if (action.t === 'question.respond') {
      questions.resolve(action.rpcId, action.answers.map((a) => ({
        id: a.id,
        selected: [...a.selected],
        ...(a.custom === undefined ? {} : { custom: a.custom }),
      })))
      return
    }
    if (action.t === 'session.send') {
      void speak(ctx, action.sessionId, action.text, action.images ?? [])
        .then((reason) => {
          if (reason === undefined) return
          // 🔴 必须回给手机。只写本机日志的话，手机上就是「点了发送，然后什么都没发生」。
          ctx.logger.warn('[pocket] 消息没发出去：%s', reason)
          relay?.sendError('send-failed', reason)
        })
      return
    }
    const outcome = runAction(ctx, action, renameDevice)
    if (outcome === 'no-such-session') {
      // A phone's view can be seconds stale, so this is ordinary rather than an error.
      ctx.logger.debug('[pocket] %s targeted a session that is no longer live', action.t)
    }
  }

  const startRelay = (): void => {
    if (!enabled || profileDir === undefined || relay !== undefined) return
    const credentials = readCredentials(profileDir)
    if (credentials === undefined) return

    /*
     * Machines linked before device secrets existed still hold an access token. Trade it
     * for a device secret and carry on — asking the person to authorise again for a
     * change they never asked for would be the wrong bill to hand them, and every hour
     * that PAT stays on disk is an hour it can be read out of this process.
     */
    if (needsSecretUpgrade(credentials)) {
      void upgradeToDeviceSecret(endpoints, credentials)
        .then((upgraded) => {
          writeCredentials(profileDir, upgraded)
          ctx.logger.info('[pocket] traded the account token for a device secret')
          startRelay()
        })
        .catch((error: unknown) => {
          lastError = error instanceof Error ? error.message : String(error)
          ctx.logger.warn('[pocket] could not obtain a device secret: %s', lastError)
        })
      return
    }
    relay = new RelayClient({
      relayOrigin: endpoints.relayOrigin,
      credentials,
      dshVersion: process.env['DSH_VERSION'] ?? 'unknown',
      pluginVersion: PLUGIN_VERSION,
      listSessions,
      onAction,
      onViewers: (count) => {
        const before = viewers
        viewers = count
        /*
         * 🔴 Push the session list whenever someone NEW attaches, not only on 0 → 1.
         *
         * A device sends its list once, inside `device/hello`, at its own connect time
         * and never again on its own — so every phone that attaches later depends on
         * this. The first version fired only when the count rose from zero: the first
         * phone worked, the second one (or the same person opening a second tab) never
         * saw a session list at all.
         *
         * Phones already watching receive one extra list. Harmless — handling
         * `session/list` is something they do anyway.
         */
        if (count > before) relay?.sendSessionList()
        // Open the question stream only while somebody is watching; it also carries every
        // session event, which pocket already has from its own listener.
        // 没人看时正在等的提问要交回本地链路，否则电脑那边会一直卡着
        if (count === 0) questions.releaseAll()
      },
      onState: (state, error) => {
        relayState = state
        lastError = error
      },
      log: ctx.logger,
    })
    relay.start()
  }

  const stopRelay = (): void => {
    relay?.stop()
    relay = undefined
    relayState = 'offline'
    viewers = 0
  }

  const status = (): PocketStatus => {
    if (profileDir === undefined) {
      return {
        enabled, linked: false, connection: 'offline', viewers: 0, linking: false,
        droppedApprovals,
        questionsSeen: questions.seen,
        lastError: 'cannot resolve the profile directory',
      }
    }
    const credentials = readCredentials(profileDir)
    if (credentials === undefined) {
      return {
        enabled, linked: false, connection: 'offline', viewers: 0, linking: isLinking(),
        droppedApprovals,
      questionsSeen: questions.seen,
        ...(lastError === undefined ? {} : { lastError }),
      }
    }
    return {
      enabled,
      linked: true,
      deviceId: credentials.deviceId,
      deviceName: credentials.deviceName,
      connection: relayState,
      viewers,
      linking: isLinking(),
      droppedApprovals,
      questionsSeen: questions.seen,
      ...(lastError === undefined ? {} : { lastError }),
    }
  }

  const handle = async (req: IncomingMessage, res: ServerResponse): Promise<void> => {
    const url = new URL(req.url ?? '/', `http://${req.headers.host ?? 'localhost'}`)
    const path = url.pathname

    if (path === `${API_PREFIX}/status`) {
      json(res, 200, status())
      return
    }

    // Everything below changes state and must come from this machine's own browser.
    if (!isDirectLoopback(req) || !isSameOrigin(req)) {
      json(res, 403, { error: 'forbidden' })
      return
    }

    if (path === `${API_PREFIX}/link` && req.method === 'POST') {
      if (profileDir === undefined) {
        json(res, 500, { error: 'cannot resolve the profile directory' })
        return
      }
      // The approval happens in a browser; this only starts it and polls. The settings
      // page watches /status for the result.
      const started = beginLink(endpoints, (outcome) => {
        if (!outcome.ok) {
          lastError = outcome.detail
          ctx.logger.warn('[pocket] linking failed: %s', outcome.detail)
          return
        }
        lastError = undefined
        writeCredentials(profileDir, outcome.credentials)
        ctx.logger.info('[pocket] this machine is linked as %s', outcome.credentials.deviceId)
        startRelay()
      })
      json(res, 200, started)
      return
    }

    if (path === `${API_PREFIX}/pairing/rotate` && req.method === 'POST') {
      if (profileDir !== undefined) rotatePairingKey(profileDir)
      ctx.logger.info('[pocket] signing key rotated; phones will pick up the new one on reconnect')
      json(res, 200, { ok: true })
      return
    }

    if (path === `${API_PREFIX}/unlink` && req.method === 'POST') {
      cancelLink()
      // Drop the connection before the credentials: the other order leaves a live socket
      // authenticated by a token this machine has already forgotten.
      stopRelay()
      if (profileDir !== undefined) {
        clearCredentials(profileDir)
        // The key goes with the credentials: keeping one that signs for an unlinked
        // machine has no meaning.
        clearPairingKey(profileDir)
      }
      ctx.logger.info('[pocket] this machine is no longer linked')
      json(res, 200, status())
      return
    }

    json(res, 404, { error: 'not found' })
  }

  ctx.effect(() => ctx.webServer.register({
    kind: 'prefix',
    path: '/pocket',
    handler: (req, res) => { void handle(req, res) },
  }), 'pocket: local routes')

  // The feed runs whether or not a phone is attached: the projector also maintains the
  // session index, which the next hello needs to be correct.
  ctx.effect(() => ctx.on('session/event', (session, event) => {
    projector.accept(session, event)
  }), 'pocket: session feed')

  /*
   * Join the approval chain. Registered whether or not a phone is attached: the answerer
   * checks that itself and steps aside in one call, which is cheaper and far safer than
   * adding and removing a waterfall listener as phones come and go.
   */
  // 同上：前插，且只在有人看时才接（见 approvals.ts 的「让路」那半边）
  ctx.effect(() => ctx.on('approval/request', (req, next) => approvals.answer(req, next), true),
    'pocket: approval answerer')

  ctx.effect(() => () => {
    stopRelay()
    approvals.dispose()
    projector.dispose()
  }, 'pocket: relay lifetime')

  startRelay()
}
