/**
 * Pulling a session's past out of dsh.
 *
 * A phone that opens a session should see the conversation, not an empty screen waiting
 * for the next message. dsh already answers this with `session.history`, and its events
 * are ordinary log events — the same shape the live feed carries — so both paths go
 * through one projection and render identically.
 *
 * Nothing is cached here. History is fetched when a phone asks and forgotten after it is
 * sent: holding transcripts in this process would undo the one property the whole design
 * is built on, that session content lives in exactly two places, the machine and the
 * phone looking at it.
 */

import type { Context, SessionEvent, SessionHistoryRecord } from '@deepseek-ai/cordis'
import { attempt, sessions, workspaces } from './models.ts'
import { projectHistory } from './sessions.ts'
import type { PocketSessionEvent } from './types.ts'

/**
 * How many messages to fetch per page.
 *
 * 🔴 dsh counts *messages*, and one page of them expands to thousands of raw log events
 * — every streamed token is one. Fifteen fills a phone screen several times over and
 * keeps the projected frame small enough to cross the wire comfortably.
 */
const PAGE_SIZE = 15

/**
 * Cap on the text a single history page may carry.
 *
 * A frame that grows without bound eventually exceeds some limit somewhere — and the way
 * that failure shows up is the frame silently vanishing, which reads as "opening a
 * session hangs forever" with clean logs on both sides. Better to drop the oldest lines
 * here, where the reason is visible.
 */
const PAGE_TEXT_BUDGET = 120_000

/**
 * Turn history rows back into session events.
 *
 * 🔴 A page holds two shapes. Providers stream token-sized deltas, so dsh packs each run
 * of them into one `chunkrow/*` row rather than storing hundreds of near-identical lines.
 * A reader that only understands `{type:'event'}` therefore drops **every assistant reply
 * in the page** and shows a conversation of nothing but the person's own messages.
 *
 * Each run collapses to a single event rather than one per member: the projection would
 * coalesce them anyway, and re-inflating a run only to re-join it wastes the compression
 * that made the row worth packing.
 *
 * @param records - Rows as the controller returned them, oldest first.
 * @returns Events in the same order.
 */
function expand(records: readonly SessionHistoryRecord[]): SessionEvent[] {
  const out: SessionEvent[] = []
  for (const record of records) {
    if (record.type === 'event') {
      out.push(record.event)
      continue
    }
    /*
     * ⚠️ The kind lives on the inner event, not on the record. The record only says
     * "this row is a packed run"; `chunkrow/text-chunks` and the run's seq/time sit one
     * level down. Reading them off the record matches nothing and drops every reply.
     */
    const run = record.event
    const text = (run.data?.texts ?? []).join('')
    if (text === '') continue
    // tool-call runs carry argument fragments, not prose; the tool/call event beside them
    // already says what was called, so they add nothing a phone can read.
    const kind = run.type === 'chunkrow/reasoning-chunks'
      ? 'reasoning-delta'
      : run.type === 'chunkrow/text-chunks' ? 'text-delta' : undefined
    if (kind === undefined) continue
    out.push({
      type: 'assistant/chunk',
      seq: run.seq,
      time: run.time,
      data: { chunk: { type: kind, text } },
    } as SessionEvent)
  }
  return out
}

/** One page of a session's past, ready for the wire. */
export interface HistoryPage {
  readonly events: PocketSessionEvent[]
  readonly hasMore: boolean
  /** Seq of the oldest raw event, for asking for the page before it. */
  readonly oldestSeq?: number
}

/**
 * Read one page of history.
 *
 * @param ctx - Host plugin context.
 * @param sessionId - Session to read.
 * @param beforeSeq - Fetch events older than this seq; omit for the latest page.
 * @returns The page, or undefined when dsh could not answer.
 */
export async function readHistory(
  ctx: Context,
  sessionId: string,
  beforeSeq?: number,
): Promise<HistoryPage | undefined> {
  const controller = sessions(ctx)
  if (controller === undefined) return undefined
  const address = { kind: 'session' as const, sessionId }

  /*
   * 🔴 The cut to page back from comes from `follow()`'s opening frame — there is no
   * "give me the newest end" constant. An earlier version passed `throughSeq: 0`, which
   * asks for everything up to sequence zero: every page came back empty and the phone
   * showed a blank conversation with no error anywhere.
   *
   * The opening frame also carries the first page itself, so the common case costs one
   * call, not two.
   */
  const opening = await attempt(ctx, 'history opening frame', async () => {
    const abort = new AbortController()
    try {
      for await (const frame of controller.follow({ address, maxMessages: PAGE_SIZE }, abort.signal)) {
        if (frame.type !== 'snapshot') continue
        return frame
      }
      return undefined
    } finally {
      // One frame is all we came for; the live stream is already covered by session/event.
      abort.abort()
    }
  })
  if (opening?.cursor === undefined) return undefined

  let records = opening.records ?? []
  let more = opening.hasMore === true
  if (beforeSeq !== undefined) {
    const page = await attempt(ctx, 'history page', async () => controller.page({
      address,
      throughSeq: opening.cursor as number,
      beforeSeq,
      maxMessages: PAGE_SIZE,
    }, AbortSignal.timeout(30_000)))
    if (page === undefined) return undefined
    records = page.records
    more = page.hasMore
  }

  const raw = expand(records)

  const oldest = raw[0]?.seq
  const projected = projectHistory(raw)

  // Trim from the front: the newest lines are the ones a person wants to see first.
  let budget = PAGE_TEXT_BUDGET
  const kept: typeof projected = []
  for (let i = projected.length - 1; i >= 0; i -= 1) {
    const event = projected[i]
    if (event === undefined) continue
    budget -= JSON.stringify(event.payload).length
    if (budget < 0) break
    kept.unshift(event)
  }

  return {
    events: kept,
    // Trimming means there is more, even when dsh said this was the whole page.
    hasMore: more || kept.length < projected.length,
    ...(oldest === undefined ? {} : { oldestSeq: oldest }),
  }
}

/**
 * Start a new session on this machine.
 *
 * No cwd is passed: dsh's default is the right answer here. A phone has no sensible
 * directory picker, and picking directories is one of the things the harness pins to
 * loopback anyway.
 *
 * @param ctx - Host plugin context.
 * @returns Whether dsh accepted it.
 */
export async function createSession(ctx: Context): Promise<string | undefined> {
  const controller = sessions(ctx)
  if (controller === undefined) return undefined
  /*
   * 🔴 Return the id rather than a boolean. The old version threw it away, so a phone
   * that had just tapped "new session" could not open what it created — it had to guess
   * from a refreshed list, and a blank session does not always appear in one.
   */
  const created = await attempt(ctx, 'session creation', async () => controller.create({}))
  return created?.sessionId
}

/**
 * Rename a session.
 *
 * @param ctx - Host plugin context.
 * @param sessionId - Session to rename.
 * @param title - New title.
 * @returns Whether dsh accepted it.
 */
export async function renameSession(ctx: Context, sessionId: string, title: string): Promise<boolean> {
  const controller = sessions(ctx)
  if (controller === undefined) return false
  return await attempt(ctx, 'session rename', async () => controller.rename({ sessionId, title })) !== undefined
}

/**
 * Archive a session, removing it from the list.
 *
 * Archive rather than delete: dsh's own verb is `archiveSession`, and a phone tap is the
 * wrong place to make something unrecoverable.
 *
 * @param ctx - Host plugin context.
 * @param sessionId - Session to archive.
 * @returns Whether dsh accepted it.
 */
export async function archiveSession(ctx: Context, sessionId: string): Promise<boolean> {
  // 归档归工作区域管，不在 session 控制器上——0.1.2 拆包时挪过去的
  const controller = workspaces(ctx)
  if (controller === undefined) return false
  return await attempt(ctx, 'session archive', async () => controller.archiveSession({ sessionId })) !== undefined
}
