/**
 * The outbound link to the relay.
 *
 * This machine always dials out; the relay never dials in. That is the whole reason the
 * plugin works behind a home router without port forwarding, and it means a firewall
 * that blocks inbound traffic costs us nothing.
 *
 * Frames follow the relay's protocol contract, agreed out of band rather than through
 * shared types. Change the contract first, then both sides.
 */

import {
  PROTOCOL_VERSION,
  type ApprovalRequest, type DeviceCredentials, type PocketAction, type QuestionAsk, type SessionSummary,
} from './types.ts'
import type { ProjectedEvent } from './sessions.ts'

/** Connection states the settings page shows. */
export type RelayState = 'offline' | 'connecting' | 'online'

/** Reconnect backoff bounds. */
const BACKOFF_MIN_MS = 1_000
const BACKOFF_MAX_MS = 60_000

/** Heartbeat period. Must stay under the ALB's 60s idle timeout or the connection dies silently. */
const HEARTBEAT_MS = 30_000

/** What the relay client needs from its host. */
export interface RelayOptions {
  /** Relay origin, e.g. https://api.a2hmarket.ai/a2hmarket-pocket */
  readonly relayOrigin: string
  readonly credentials: DeviceCredentials
  /** dsh's own version, for the hello frame. */
  readonly dshVersion: string
  readonly pluginVersion: string
  /** Current sessions, read fresh at each hello. Async: it reads persisted state too. */
  readonly listSessions: () => Promise<SessionSummary[]>
  /** Handles an action a phone sent. */
  readonly onAction: (action: PocketAction) => void
  /** Reports how many phones are watching, so approvals know whether to wait for one. */
  readonly onViewers: (count: number) => void
  /** Reports state changes so the settings page can show them. */
  readonly onState: (state: RelayState, error?: string) => void
  readonly log: {
    info(message: string, ...args: readonly unknown[]): void
    warn(message: string, ...args: readonly unknown[]): void
    debug(message: string, ...args: readonly unknown[]): void
  }
}

/** A one-time ticket plus which relay instance to spend it on. */
interface Ticket {
  readonly ticket: string
  /** The `?slot=` value. 0 when the relay is a single instance. */
  readonly shard: number
}

/** Actions a phone may send. Anything else is ignored rather than answered. */
const ACTIONS = new Set([
  'session.open', 'session.send', 'approval.respond', 'turn.stop', 'device.rename',
  'model.list', 'model.select', 'session.create', 'session.more', 'session.list', 'session.rename', 'session.archive', 'pair.request', 'settings.list', 'settings.set',
  'question.respond',
])

/**
 * Holds one WebSocket to the relay, re-dialling it whenever it drops.
 *
 * Node's global WebSocket is used rather than a dependency: dsh requires Node 22.19+,
 * where it is a stable global, and the host half is bundled with zero runtime
 * dependencies on purpose.
 */
export class RelayClient {
  private socket: WebSocket | undefined
  private heartbeat: ReturnType<typeof setInterval> | undefined
  private retry: ReturnType<typeof setTimeout> | undefined
  private attempt = 0
  private stopped = false
  private state: RelayState = 'offline'

  private readonly options: RelayOptions

  constructor(options: RelayOptions) {
    this.options = options
  }

  /** Dial the relay and keep it dialled. */
  start(): void {
    this.stopped = false
    void this.dial()
  }

  /** Stop for good: no further reconnects. */
  stop(): void {
    this.stopped = true
    this.clearTimers()
    const socket = this.socket
    this.socket = undefined
    // 1000 = normal closure. The relay marks the device offline either way, but a clean
    // code keeps "the user switched it off" out of the relay's error logs.
    socket?.close(1000, 'stopped')
    this.setState('offline')
  }

  /** @returns The current connection state. */
  currentState(): RelayState {
    return this.state
  }

  /**
   * Send one projected session event, if connected.
   * @param projected - The event to forward.
   */
  sendSessionEvent(projected: ProjectedEvent): void {
    this.send({ t: 'session/event', sessionId: projected.sessionId, event: projected.event })
  }

  /**
   * Send the model catalog for one session.
   * @param sessionId - The session it describes.
   * @param catalog - Current selection plus the options.
   */
  sendModelCatalog(sessionId: string, catalog: Record<string, unknown>): void {
    this.send({ t: 'model/catalog', sessionId, ...catalog })
  }

  /**
   * Send one page of a session's past.
   * @param sessionId - The session it belongs to.
   * @param page - Projected events plus paging state.
   */
  sendHistory(sessionId: string, page: Record<string, unknown>): void {
    this.send({ t: 'session/history', sessionId, ...page })
  }

  /**
   * Hand the signing key to a phone that does not have it yet.
   * @param key - base64url key.
   */
  sendPairingKey(key: string): void {
    this.send({ t: 'pair/key', key })
  }

  /**
   * Send the settings a phone may show.
   * @param groups - Flattened setting groups.
   */
  sendSettings(groups: readonly unknown[]): void {
    this.send({ t: 'settings/list', groups })
  }

  /** Push the current session list. */
  sendSessionList(): void {
    void this.options.listSessions()
      .then((sessions) => { this.send({ t: 'session/list', sessions }) })
      .catch(() => { /* 列不出来就不推；下一次 hello 或事件会再带上 */ })
  }

  /**
   * Tell the phones something they asked for did not happen.
   *
   * 🔴 Without this a plugin-side failure only reaches this machine's log, and the phone
   * shows nothing at all — "I pressed send and nothing happened" is harder to diagnose
   * than any error message. Sending an image is the case that made this necessary: the
   * bytes can be refused for half a dozen reasons the person can actually act on
   * (too big, wrong format, no attachment store on this machine).
   *
   * @param code - Short machine-readable reason.
   * @param message - What to show the person. Never a path or a stack.
   */
  sendError(code: string, message: string): void {
    this.send({ t: 'error', code, message })
  }

  /**
   * Put the agent's question to the watching phones.
   *
   * Unlike an approval this always goes out, even with nobody attached: the host keeps
   * the question pending and replays it to whoever opens the stream next, so there is
   * nothing here to fail.
   *
   * @param ask - The question and its rpcId.
   */
  sendQuestion(ask: QuestionAsk): void {
    this.send({ t: 'question/ask', ...ask })
  }

  /**
   * Tell the phones a question is no longer open.
   *
   * It may have been answered on the computer, or on another phone, or the turn may have
   * been cancelled underneath it. All three look the same from here and all three mean
   * the same thing on screen: take the card down.
   *
   * @param rpcId - The question that closed.
   */
  sendQuestionResolved(rpcId: string): void {
    this.send({ t: 'question/resolved', rpcId })
  }

  /**
   * Ask the watching phones to decide one tool call.
   * @param request - The pending decision.
   * @returns false when there is no live connection to ask over.
   */
  sendApproval(request: ApprovalRequest): boolean {
    const socket = this.socket
    if (socket === undefined || socket.readyState !== WebSocket.OPEN) return false
    this.send({ t: 'approval/request', ...request })
    return true
  }

  private async dial(): Promise<void> {
    if (this.stopped) return
    this.setState('connecting')
    let ticket: Ticket
    try {
      ticket = await this.fetchTicket()
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error)
      this.options.log.warn('[pocket] could not get a relay ticket: %s', detail)
      this.setState('offline', detail)
      this.scheduleRetry()
      return
    }
    if (this.stopped) return

    /*
     * 🔴 `slot` decides which relay instance this lands on, and the phone must land on
     * the same one — the relay's routing table is per-instance memory, so a mismatch
     * shows up as "device online, not one message gets through", with clean logs on both
     * sides. Both sides read the number from the same database row, so they cannot
     * disagree; all this end has to do is pass it along unchanged.
     *
     * A relay that does not shard answers 0, and the load balancer has no rule for a
     * slot — both are harmless, which is what lets an older phone or an older plugin keep
     * working while the other end has already been updated.
     */
    const url = `${this.options.relayOrigin.replace(/^http/, 'ws')}/ws/device`
      + `?ticket=${encodeURIComponent(ticket.ticket)}&slot=${String(ticket.shard)}`
    const socket = new WebSocket(url)
    this.socket = socket

    socket.addEventListener('open', () => {
      this.attempt = 0
      this.setState('online')
      this.startHeartbeat()
      this.options.log.info('[pocket] connected to the relay')
      // hello 要带会话列表，而列表要读持久化存储，所以是异步的。
      // 读失败也要把 hello 发出去：没有 hello，relay 根本不认这台设备上线。
      void this.options.listSessions()
        .catch(() => [] as SessionSummary[])
        .then((sessions) => {
          this.send({
            t: 'device/hello',
            protocolVersion: PROTOCOL_VERSION,
            deviceId: this.options.credentials.deviceId,
            deviceName: this.options.credentials.deviceName,
            dshVersion: this.options.dshVersion,
            pluginVersion: this.options.pluginVersion,
            sessions,
          })
        })
    })

    socket.addEventListener('message', (event: MessageEvent) => {
      this.receive(typeof event.data === 'string' ? event.data : '')
    })

    socket.addEventListener('close', (event: CloseEvent) => {
      this.clearTimers()
      this.socket = undefined
      // Nobody can be watching over a closed socket. Saying so explicitly keeps the
      // approval answerer from waiting on phones that are no longer reachable.
      this.guard('viewer count reset', () => { this.options.onViewers(0) })
      this.setState('offline')
      if (!this.stopped) {
        this.options.log.debug('[pocket] relay connection closed (code=%s), will retry', event.code)
        this.scheduleRetry()
      }
    })

    socket.addEventListener('error', () => {
      /*
       * No detail is available here by design — the WebSocket error event carries none,
       * and inventing one ("network error") would be a guess printed as a fact. The
       * close event follows and drives the retry.
       */
      this.options.log.debug('[pocket] relay socket error')
    })
  }

  private async fetchTicket(): Promise<Ticket> {
    /*
     * The device-scoped endpoint, not the account one: this machine holds a device
     * secret, not an access token. The endpoint sits under /public/* because the gateway
     * would not recognise this credential — it defends itself with the secret check and
     * a rate limit.
     */
    const response = await fetch(`${this.options.relayOrigin}/api/v1/public/pocket/device-ticket`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ deviceSecret: this.options.credentials.token }),
    })
    if (!response.ok) {
      throw new Error(`ticket request failed (HTTP ${String(response.status)})`)
    }
    // 🔴 HTTP 200 is not success: ApiResponse returns 200 for business failures too.
    const body = await response.json() as { data?: { ticket?: string, shard?: number } | null }
    const ticket = body.data?.ticket
    if (typeof ticket !== 'string' || ticket === '') {
      throw new Error('the relay issued no ticket; this machine may have been revoked')
    }
    // A relay from before sharding sends no shard; 0 is where its single instance is.
    return { ticket, shard: typeof body.data?.shard === 'number' ? body.data.shard : 0 }
  }

  /**
   * Run a handler without letting it take the harness down.
   *
   * 🔴 These callbacks run from a WebSocket event. A throw inside one has no catcher
   * above it, so Node re-raises it on the next tick and **the whole dsh process exits** —
   * which is exactly what happened when a service was read without being injected
   * (2026-08-31). A relay-carried frame must never be able to do that: the worst a bad
   * frame deserves is a log line.
   *
   * @param label - What was being done, for the log.
   * @param run - The handler.
   */
  private guard(label: string, run: () => void): void {
    try {
      run()
    } catch (error) {
      this.options.log.warn('[pocket] %s failed and was contained: %s', label, String(error))
    }
  }

  private receive(payload: string): void {
    if (payload === '') return
    let frame: { t?: unknown }
    try {
      frame = JSON.parse(payload) as { t?: unknown }
    } catch {
      // Never log the payload itself — it could carry session content back at us.
      this.options.log.warn('[pocket] dropped an unparseable frame from the relay')
      return
    }
    const type = typeof frame.t === 'string' ? frame.t : undefined
    if (type === undefined) return
    if (type === 'ping') {
      this.send({ t: 'pong' })
      return
    }
    if (type === 'pong') return
    if (type === 'viewer/count') {
      const count = (frame as { count?: unknown }).count
      this.guard('viewer count', () => { this.options.onViewers(typeof count === 'number' ? count : 0) })
      return
    }
    if (type === 'error') {
      const code = (frame as { code?: unknown }).code
      this.options.log.warn('[pocket] the relay refused a frame: %s', typeof code === 'string' ? code : 'unknown')
      return
    }
    if (!ACTIONS.has(type)) {
      this.options.log.debug('[pocket] ignoring an unknown action: %s', type)
      return
    }
    this.guard(`action ${String(frame['t'])}`, () => { this.options.onAction(frame as unknown as PocketAction) })
  }

  private send(frame: Record<string, unknown>): void {
    const socket = this.socket
    if (socket === undefined || socket.readyState !== WebSocket.OPEN) return
    socket.send(JSON.stringify(frame))
  }

  private startHeartbeat(): void {
    this.heartbeat = setInterval(() => { this.send({ t: 'ping' }) }, HEARTBEAT_MS)
    this.heartbeat.unref?.()
  }

  private scheduleRetry(): void {
    this.attempt += 1
    /*
     * Exponential backoff with jitter. The jitter matters more than the curve: when the
     * relay restarts, every device that was connected wakes up at once, and without it
     * they would all re-dial on the same schedule and knock it over again.
     */
    const base = Math.min(BACKOFF_MIN_MS * 2 ** (this.attempt - 1), BACKOFF_MAX_MS)
    const delay = base / 2 + Math.random() * (base / 2)
    this.retry = setTimeout(() => { void this.dial() }, delay)
    this.retry.unref?.()
  }

  private clearTimers(): void {
    if (this.heartbeat !== undefined) clearInterval(this.heartbeat)
    if (this.retry !== undefined) clearTimeout(this.retry)
    this.heartbeat = undefined
    this.retry = undefined
  }

  private setState(state: RelayState, error?: string): void {
    this.state = state
    this.options.onState(state, error)
  }
}
