/**
 * Projecting dsh's session log into what a phone needs.
 *
 * Two jobs, both about *reduction*:
 *   1. only a handful of event kinds cross the wire — the log carries far more (request
 *      headers, route metadata, seed boundaries), none of which mean anything on a phone;
 *   2. `assistant/chunk` arrives per token. Forwarding each one would put a WebSocket
 *      frame on a mobile connection every few milliseconds, so text deltas are coalesced
 *      into one frame per window.
 */

import type { Session, SessionEvent, SessionRecord, ContentBlock, MessageSource } from '@deepseek-ai/cordis'
import type { PocketSessionEvent, SessionSummary } from './types.ts'

/** How long text deltas accumulate before one frame goes out. */
const COALESCE_MS = 200

/** Longest title derived from a first message. */
const TITLE_LIMIT = 48

/** Longest tool-argument summary put on the wire. Truncated here; the relay never truncates. */
const ARGS_LIMIT = 2000

/** Event kinds a phone is allowed to see. */
const FORWARDED = new Set([
  'turn/start', 'turn/end', 'user/message', 'assistant/chunk', 'tool/call', 'tool/result',
  'todo/write',
])

/** 两路文本各自缓冲：正式回答和思考过程不能并进同一段。 */
type TextStream = 'assistant/chunk' | 'assistant/reasoning'

/** What this module hands back to the relay client. */
export interface ProjectedEvent {
  readonly sessionId: string
  readonly event: PocketSessionEvent
}

/** Live facts about one session, kept only in memory. */
interface SessionState {
  title: string
  lastActiveAt: number
  running: boolean
}

/**
 * Whether a user-role message is context dsh injected rather than something the person
 * typed, and if so what to call the folded block on the phone.
 *
 * 🔴 Every user-role log entry arrives as `role: 'user'` — the runtime-context snapshot and
 * the skill catalog included. Forwarding them as plain user bubbles is what buried the
 * actual prompt under two screens of policy text and a skill list (the phone showed all
 * three as equal messages). The desktop UI folds them away by `source.kind`; this does the
 * same classification so the phone can too. The returned `note` is a stable token, not a
 * label — the phone owns the wording, because this package ships in English and the phone
 * is Chinese.
 *
 * @param source - The message's source, absent on older logs and plain typed messages.
 * @returns undefined for a real user message; otherwise the phone-facing context tag.
 */
function contextTag(source: MessageSource | undefined): { role: 'context', note: string } | undefined {
  const kind = source?.kind
  if (kind === undefined || kind === 'user') return undefined
  if (kind === 'skill-catalog') return { role: 'context', note: 'skills' }
  if (source?.form === 'snapshot') return { role: 'context', note: 'runtime' }
  return { role: 'context', note: 'context' }
}

/** Joins the text of a message's content blocks; non-text blocks are ignored. */
function textOf(content: readonly ContentBlock[] | undefined): string {
  if (content === undefined) return ''
  return content
    .filter((block): block is { type: 'text', text: string } => block.type === 'text')
    .map((block) => block.text)
    .join('')
}

/**
 * What a tool result should say on a phone.
 *
 * 🔴 A failed call carries its reason in `error`, not in the message content — which is
 * often empty for a failure. Reading only the content gave the phone a bare "失败" with
 * nothing after it, and a person looking at that cannot tell a bad argument from a
 * crashed command (2026-09-01: a model kept passing `todos` as a string, and the screen
 * said only "失败" three times in a row).
 */
function resultSummary(event: { data: { message: { content: readonly ContentBlock[] }, error?: { name: string, code: string } } }): string {
  const text = textOf(event.data.message.content)
  const failure = event.data.error
  if (failure === undefined) return clip(text, ARGS_LIMIT)
  const reason = [failure.name, failure.code].filter((part) => part !== '' && part !== undefined).join(' · ')
  return clip(text === '' ? reason : `${reason}：${text}`, ARGS_LIMIT)
}

/** Names a session by its working directory's last segment, when nothing better is known. */
function folderOf(cwd: string | undefined): string {
  if (cwd === undefined || cwd === '') return ''
  const parts = cwd.split('/').filter((part) => part !== '')
  return parts[parts.length - 1] ?? ''
}

/** Cuts a string to a limit without leaving a dangling surrogate pair. */
function clip(text: string, limit: number): string {
  if (text.length <= limit) return text
  return `${Array.from(text).slice(0, limit).join('')}…`
}

/**
 * Project a batch of already-recorded events, for history.
 *
 * Deliberately separate from the live path and free of its machinery: no timers, no
 * mutation of live session state. History is a finished thing — coalescing it means
 * joining adjacent deltas right here, and a running turn's `running` flag must not be
 * disturbed by reading its past.
 *
 * What it shares with the live path is the projection itself, so the same conversation
 * renders the same way whether it arrived seconds ago or last week.
 *
 * @param events - Raw log events, oldest first.
 * @returns Phone-shaped events, oldest first.
 */
export function projectHistory(events: readonly SessionEvent[]): PocketSessionEvent[] {
  const out: PocketSessionEvent[] = []

  const push = (kind: PocketSessionEvent['kind'], at: number, payload: Record<string, unknown>): void => {
    const last = out[out.length - 1]
    // Join adjacent text of the same stream, the batch equivalent of the live window.
    if ((kind === 'assistant/chunk' || kind === 'assistant/reasoning') && last?.kind === kind) {
      out[out.length - 1] = {
        ...last,
        payload: { text: String(last.payload['text'] ?? '') + String(payload['text'] ?? '') },
      }
      return
    }
    out.push({ kind, at: new Date(at).toISOString(), payload })
  }

  for (const event of events) {
    switch (event.type) {
      case 'user/message':
        push('user/message', event.time, {
          text: textOf(event.data.content),
          ...(contextTag(event.data.source) ?? {}),
        })
        break
      case 'assistant/chunk': {
        const chunk = event.data.chunk
        if (chunk.type === 'text-delta') {
          push('assistant/chunk', event.time, { text: chunk.text })
        } else if (chunk.type === 'reasoning-delta') {
          push('assistant/reasoning', event.time, { text: (chunk as { text?: string }).text ?? '' })
        }
        break
      }
      case 'tool/call':
        push('tool/call', event.time, { tool: event.data.name, argsSummary: clip(event.data.arguments, ARGS_LIMIT) })
        break
      case 'tool/result':
        push('tool/result', event.time, {
          tool: '',
          ok: event.data.error === undefined,
          summary: resultSummary(event),
        })
        break
      case 'todo/write':
        /*
         * Every write carries the whole list, so replaying all of them would send the
         * same task list a dozen times and only the last one could ever be right.
         * Drop the earlier snapshot and keep this one — that is dsh's own last-wins
         * rule, applied where it saves the most bytes.
         */
        for (let i = out.length - 1; i >= 0; i -= 1) {
          if (out[i]?.kind === 'todo/write') {
            out.splice(i, 1)
            break
          }
        }
        push('todo/write', event.time, { todos: event.data.todos })
        break
      default:
        // turn boundaries carry no text; they matter live (the stop button) but add
        // nothing to a transcript being scrolled back through.
        break
    }
  }
  return out
}

/**
 * Turns the session log into phone-shaped events and keeps the session index.
 *
 * One instance per plugin load. It holds no history: an event is projected, handed to
 * the sink, and forgotten. A phone that connects late sees what happens next, not what
 * it missed — replaying history would mean holding session content in memory, which is
 * exactly what this design refuses to do.
 */
export class SessionProjector {
  private readonly states = new Map<string, SessionState>()

  /**
   * Pending text per session and stream, flushed by the timers below.
   *
   * Keyed by session **and** stream: reasoning and the answer interleave within one
   * turn, and merging them into one buffer would splice the model's thinking into the
   * middle of its reply.
   */
  private readonly pendingText = new Map<string, string>()

  private readonly timers = new Map<string, ReturnType<typeof setTimeout>>()

  /**
   * @param emit - Where projected events go. Called with one event at a time.
   */
  private readonly emit: (projected: ProjectedEvent) => void

  constructor(emit: (projected: ProjectedEvent) => void) {
    this.emit = emit
  }

  /**
   * Feed one log event.
   * @param session - The session whose log grew.
   * @param event - The appended event, exactly as recorded.
   */
  accept(session: Session, event: SessionEvent): void {
    const sessionId = session.id
    const state = this.stateOf(sessionId)
    state.lastActiveAt = event.time

    if (!FORWARDED.has(event.type)) return

    switch (event.type) {
      case 'turn/start':
        state.running = true
        this.flushText(sessionId)
        this.send(sessionId, event, 'turn/start', {})
        return
      case 'turn/end':
        state.running = false
        // Flush before the boundary: text buffered from this turn must not surface
        // after the phone has been told the turn ended.
        this.flushText(sessionId)
        this.send(sessionId, event, 'turn/end', { reason: event.data.reason.kind ?? 'unknown' })
        return
      case 'user/message': {
        const text = textOf(event.data.content)
        const context = contextTag(event.data.source)
        // Only what the person typed names the session. Injected runtime context and the
        // skill catalog are user-role too, and titling from them would call the session
        // "Current runtime context." whenever they happened to land first.
        if (state.title === '' && context === undefined) {
          state.title = clip(text.trim().replace(/\s+/g, ' '), TITLE_LIMIT)
        }
        this.send(sessionId, event, 'user/message', { text, ...(context ?? {}) })
        return
      }
      case 'assistant/chunk': {
        const chunk = event.data.chunk
        /*
         * Both text streams cross the wire. Reasoning was dropped in the first version
         * on the theory that a phone screen is the wrong place for it; watching it in
         * practice proved the opposite — without it there is no sign of life between
         * "sent" and the answer landing, and the person cannot tell thinking from stuck.
         */
        if (chunk.type === 'text-delta') {
          this.appendText(sessionId, 'assistant/chunk', chunk.text)
        } else if (chunk.type === 'reasoning-delta') {
          this.appendText(sessionId, 'assistant/reasoning', (chunk as { text?: string }).text ?? '')
        }
        return
      }
      case 'tool/call':
        this.flushText(sessionId)
        this.send(sessionId, event, 'tool/call', {
          tool: event.data.name,
          argsSummary: clip(event.data.arguments, ARGS_LIMIT),
        })
        return
      case 'tool/result':
        this.send(sessionId, event, 'tool/result', {
          tool: '',
          ok: event.data.error === undefined,
          summary: resultSummary(event),
        })
        return
      case 'todo/write':
        /*
         * The task list is the one thing that answers "how far along is it" without
         * reading the transcript, which is what someone glancing at a phone actually
         * wants. Flush first: the list is a checkpoint, and text buffered before it
         * belongs above it.
         */
        this.flushText(sessionId)
        this.send(sessionId, event, 'todo/write', { todos: event.data.todos })
        return
      default:
        return
    }
  }

  /**
   * The current session list.
   *
   * Takes the whole logical corpus, not just live sessions: a phone should see what dsh
   * itself lists. Sessions this projector has never seen an event for — anything from
   * before the last restart — still belong there, they just have no observed title yet,
   * so their working directory names them.
   *
   * @param records - Records from ctx.sessionQuery.listSessions(), already newest-first.
   * @param titleOf - dsh's own title for a session, when it has one.
   * @returns Summaries in the order given.
   */
  summaries(
    records: readonly SessionRecord[],
    titleOf: (record: SessionRecord) => string | undefined = () => undefined,
    workspaceOf: (sessionId: string) => string | undefined = () => undefined,
  ): SessionSummary[] {
    /*
     * Title precedence: what dsh itself shows > what this projector observed > the
     * working directory. The folder is the last resort and a poor one — every session
     * started in the same tree gets the same name — so it only shows when dsh has no
     * title either.
     *
     * The order records arrive in is kept: listSessions() is documented newest-first,
     * and re-sorting here by a timestamp we only half-know would be worse.
     */
    return records.map((record) => {
      const state = this.states.get(record.header.id)
      const title = titleOf(record) ?? state?.title
      const workspace = workspaceOf(record.header.id)
      return {
        sessionId: record.header.id,
        title: title !== undefined && title !== '' ? title : folderOf(record.header.cwd),
        lastActiveAt: new Date(state?.lastActiveAt ?? record.header.createdAt).toISOString(),
        running: state?.running ?? false,
        ...(workspace === undefined ? {} : { workspace }),
      }
    })
  }

  /** Drop every timer. Called when the plugin unloads. */
  dispose(): void {
    for (const timer of this.timers.values()) clearTimeout(timer)
    this.timers.clear()
    this.pendingText.clear()
    this.states.clear()
  }

  private stateOf(sessionId: string): SessionState {
    const existing = this.states.get(sessionId)
    if (existing !== undefined) return existing
    const created: SessionState = { title: '', lastActiveAt: Date.now(), running: false }
    this.states.set(sessionId, created)
    return created
  }

  private appendText(sessionId: string, stream: TextStream, text: string): void {
    if (text === '') return
    const key = `${sessionId}\u0000${stream}`
    this.pendingText.set(key, (this.pendingText.get(key) ?? '') + text)
    if (this.timers.has(key)) return
    const timer = setTimeout(() => { this.flushOne(key, sessionId, stream) }, COALESCE_MS)
    // The timer must not keep the process alive: dsh exiting while a few characters sit
    // in the buffer is correct, holding the event loop open for them is not.
    timer.unref?.()
    this.timers.set(key, timer)
  }

  /** Flush both streams of one session, answer first so ordering stays readable. */
  private flushText(sessionId: string): void {
    this.flushOne(`${sessionId}\u0000assistant/reasoning`, sessionId, 'assistant/reasoning')
    this.flushOne(`${sessionId}\u0000assistant/chunk`, sessionId, 'assistant/chunk')
  }

  private flushOne(key: string, sessionId: string, stream: TextStream): void {
    const timer = this.timers.get(key)
    if (timer !== undefined) {
      clearTimeout(timer)
      this.timers.delete(key)
    }
    const text = this.pendingText.get(key)
    if (text === undefined || text === '') return
    this.pendingText.delete(key)
    this.emit({
      sessionId,
      event: { kind: stream, at: new Date().toISOString(), payload: { text } },
    })
  }

  private send(sessionId: string, event: SessionEvent, kind: PocketSessionEvent['kind'], payload: Record<string, unknown>): void {
    this.emit({
      sessionId,
      event: { kind, at: new Date(event.time).toISOString(), payload },
    })
  }
}
