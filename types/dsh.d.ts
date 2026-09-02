/**
 * The minimal type surface of the harness API — the part this plugin uses, transcribed
 * from the deepseek-harness source. Same approach as dsh-skin-market, for the same reasons.
 *
 * Why vendored instead of depending on @deepseek-ai/*:
 *   1. these modules are external at runtime, injected by the host's module table (see
 *      EXTERNALS in tsdown.config.ts) — the plugin neither bundles nor should bundle them;
 *   2. the @deepseek-ai/dsh-client-* dependency chain on npm is incomplete (dsh-compact is
 *      unpublished), so it cannot be installed;
 *   3. contributors can compile straight after `pnpm i`, with no rc packages to assemble first.
 *
 * The cost is that these declarations can drift from the host. The rule: declare only what
 * is actually used, note the source location at each site, and check here first when the
 * host errors.
 */

declare module '@deepseek-ai/cordis' {
  /** Disposer: what every registration API in cordis returns. */
  export type Disposer = () => void

  /** packages/host/webserver/src/index.ts */
  export interface WebRoute {
    /** 'exact' matches the path exactly; 'prefix' matches p and p/<anything>. */
    kind: 'exact' | 'prefix'
    /** Absolute path, without a trailing slash. */
    path: string
    /** Takes full ownership of the response lifecycle (may stay open, e.g. for SSE). */
    handler: (
      req: import('node:http').IncomingMessage,
      res: import('node:http').ServerResponse,
    ) => void | Promise<void>
  }

  /** packages/host/webserver/src/index.ts — the browser HTTP carrier. */
  export interface WebServer {
    register(route: WebRoute): Disposer
    tapIndex(transform: (html: string) => string): Disposer
    /** The port this process is serving on — pocket calls dsh's own /api over it. */
    readonly port: number
    readonly host: string
  }

  /** cordis's Logger facade is `Record<'error'|'info'|'warn'|'debug', LoggerMethod>`; only what we use is listed. */
  export interface Logger {
    info(message: unknown, ...args: readonly unknown[]): void
    warn(message: unknown, ...args: readonly unknown[]): void
    error(message: unknown, ...args: readonly unknown[]): void
    /** Anything the user need not act on goes here — do not pollute normal logs with warn. */
    debug(message: unknown, ...args: readonly unknown[]): void
  }

  /**
   * One entry in a session's append-only log.
   * packages/core/session/src/types.ts:408 — a discriminated union over `type`.
   *
   * 🔴 Only the types pocket forwards are declared. The real log carries many more
   * (`request/header`, `session/end-seed`, whatever plugins merge in), and
   * the listener does receive them at runtime — they are stopped by the forwarding
   * whitelist in sessions.ts, not by the type. A catch-all member is deliberately absent:
   * it would overlap every literal and stop `switch (event.type)` narrowing `event.data`.
   */
  export type SessionEvent =
    | { type: 'turn/start', seq: number, time: number, data: { turn: number } }
    | { type: 'turn/end', seq: number, time: number, data: { turn: number, reason: { kind?: string } } }
    | { type: 'user/message', seq: number, time: number, data: { content: readonly ContentBlock[], source?: MessageSource } }
    | { type: 'assistant/chunk', seq: number, time: number, data: { chunk: StreamChunk } }
    | { type: 'tool/call', seq: number, time: number, data: { callId: string, name: string, arguments: string } }
    | { type: 'tool/result', seq: number, time: number, data: { message: { content: readonly ContentBlock[] }, error?: { name: string, code: string } } }
    | { type: 'todo/write', seq: number, time: number, data: { todos: readonly TodoItem[] } }

  /**
   * packages/session/session/src/types.ts — the agent's task list.
   *
   * Every `todo/write` carries the **whole** list, not a delta: dsh's own note calls it
   * a "whole-list snapshot, latest write wins on replay". That rule is what lets the
   * phone keep only the newest one and still be correct.
   */
  export interface TodoItem {
    content: string
    status: 'pending' | 'in_progress' | 'completed'
  }

  /** packages/llm/llm/src/types.ts:99 — only the text-carrying blocks matter to pocket. */
  export type ContentBlock =
    | { type: 'text', text: string }
    | { type: string }

  /**
   * Who put a user-role message on the log. Only `kind: 'user'` is something the person
   * actually typed — dsh injects its runtime-context snapshot and the skill catalog as
   * user-role messages too, and the desktop UI folds those away. `form` distinguishes a
   * context snapshot from a live prompt; other members carry more but pocket reads only
   * these two. Every field is optional: an older log, or a plain typed message, carries no
   * `source` at all, which must read as an ordinary user message.
   */
  export interface MessageSource {
    readonly kind?: string
    readonly form?: string
  }

  /**
   * packages/llm/llm/src/types.ts:312 — the stream vocabulary.
   *
   * Only `text-delta` is declared with its payload; the others (reasoning deltas, tool
   * argument deltas, block boundaries, usage, finish) are collapsed into one tagless
   * member, which is enough to check the tag and skip them. Same reason as SessionEvent:
   * a `{ type: string }` member alongside the literal would break narrowing, so it
   * names the tags instead.
   */
  export type StreamChunk =
    | { type: 'text-delta', index: number, text: string }
    | { type: 'block-start' | 'reasoning-delta' | 'tool-call-delta' | 'block-end' | 'usage' | 'finish' }

  /** packages/core/session/src/types.ts:61 */
  export interface SessionHeader {
    readonly id: string
    readonly createdAt: number
    readonly cwd?: string
  }

  /** packages/core/session/src/index.ts:428 */
  export interface Session {
    readonly id: string
    readonly header: SessionHeader
  }

  /** packages/core/session/src/index.ts:796 — the `sessions` service. */
  export interface SessionStore {
    list(): Session[]
    get(id: string): Session | undefined
  }

  /**
   * docs/subsystems/session-query.md — one logical session across live and persisted
   * storage. `ctx.sessions.list()` only sees the live ones, which is why pocket asks
   * the query seam instead: a phone should see the sessions dsh itself lists, not just
   * whatever happens to be loaded in memory since the last restart.
   */
  export interface SessionRecord {
    readonly header: SessionHeader
    /** Whether the id currently exists in ctx.sessions. */
    readonly live: boolean
    readonly persisted: boolean
  }

  /**
   * docs/subsystems/session-projection.md — whole current values of log-derived
   * per-session state. `values.title` is the title dsh's own session list shows.
   */
  export interface SessionProjectionsBlock {
    readonly values: Readonly<Record<string, unknown>>
    readonly asOfSeq: number
  }

  /** The `sessionProjections` registry — live sessions. */
  export interface SessionProjectionRegistry {
    snapshot(session: Session): SessionProjectionsBlock
  }

  /** The `sessionProjectionCache` — cold sessions, zero log loads. */
  export interface SessionProjectionCache {
    cachedSnapshot(header: SessionHeader): SessionProjectionsBlock | undefined
  }

  /** docs/subsystems/session-query.md — the `sessionQuery` service. */
  export interface SessionQueryEngine {
    /** The complete logical corpus, newest-first. */
    listSessions(signal?: AbortSignal): Promise<SessionRecord[]>
  }

  /**
   * One user-role message.
   * packages/llm/llm/src/message.ts:129 — dsh builds these with `createUserMessage()`.
   * Pocket constructs the object itself rather than importing that helper: the host half
   * bundles everything it imports, and `@deepseek-ai/dsh-llm` is neither fully published
   * nor something we should ship a second copy of. The helper only adds a uuid and
   * freezes, so an object literal is equivalent — if dsh ever adds a required field this
   * is where it breaks, which is the standing trade-off of this whole file.
   */
  export interface UserMessage {
    readonly id: string
    readonly role: 'user'
    readonly content: readonly { type: 'text', text: string }[]
    readonly source: { readonly kind: 'user' }
  }

  /** docs/subsystems/core.md:196 — who asked for the cancellation. */
  export type AgentCancelCause =
    | { readonly kind: 'user' }
    | { readonly kind: 'parent' }
    | { readonly kind: 'hook', readonly reason: string }
    | { readonly kind: 'disposed' }

  /** packages/core/agent — only the members pocket drives. docs/subsystems/core.md. */
  export interface Agent {
    readonly id: string
    /** 'idle' when no driver is active; 'running' while one is. */
    readonly status: 'idle' | 'running'
    /** Queue an ordinary follow-up turn and wake the driver. */
    followup(message: UserMessage): void
    /** Clear queued work and abort the active turn. */
    cancel(cause: AgentCancelCause): void
  }

  /** The `agents` service. */
  export interface AgentRegistry {
    get(id: string): Agent | undefined
  }

  /** docs/subsystems/approval.md — closed, fail-closed outcomes. */
  export type ApprovalOutcome = 'allowed-once' | 'rejected' | 'cancelled' | 'unavailable'

  /**
   * docs/subsystems/approval.md — one pending permission question.
   * Deliberately carries no tool arguments: an answerer attaches the prompt to the
   * already-streamed tool call through `callId`.
   */
  export interface ApprovalRequest {
    readonly agent: Agent
    readonly toolName: string
    readonly callId?: string
    readonly reason?: string
    readonly signal?: AbortSignal
  }

  /**
   * packages/host/attachment/src/types.ts — image intake limits, as the deployment
   * resolved them. Pocket pre-checks against these so an oversized photo is refused on
   * this machine with a reason, instead of throwing inside the prompt path.
   */
  export interface ImageAttachmentLimits {
    readonly maxImageBytes: number
    readonly maxImagesPerMessage: number
    readonly maxMessageImageBytes: number
    readonly maxImagePixels: number
    readonly mediaTypes: readonly ImageMediaType[]
  }

  /** The raster formats the version-one attachment path accepts. */
  export type ImageMediaType = 'image/png' | 'image/jpeg' | 'image/webp' | 'image/gif'

  /** A durable, content-addressed image reference. Never a path, never a bearer URL. */
  export interface ImageAttachmentRef {
    readonly attachmentId: string
    readonly mediaType: ImageMediaType
    readonly bytes: number
    readonly width: number
    readonly height: number
    readonly name?: string
  }

  /**
   * `ctx.attachments` — durable binary storage.
   *
   * 🔴 `validateImage` and `saveImage` are two calls on purpose: dsh's own note says
   * "batch callers validate every member before saving any member". Saving as you go
   * would commit the first images of a message whose last image turns out to be
   * invalid, leaving orphans behind a prompt that never happened.
   */
  export interface AttachmentStore {
    readonly imageLimits: ImageAttachmentLimits
    validateImage(input: { data: Uint8Array, mediaType: ImageMediaType, name?: string }): Promise<void>
    saveImage(input: { data: Uint8Array, mediaType: ImageMediaType, name?: string }): Promise<ImageAttachmentRef>
  }


  /** packages/host/user-questions/src/types.ts — one question put to the human. */
  export interface AskUserQuestionItem {
    readonly id: string
    readonly question: string
    /** Supporting detail, kept out of the option labels. */
    readonly detail?: string
    readonly header?: string
    readonly multiSelect?: boolean
    readonly options?: readonly { readonly label: string, readonly description?: string }[]
  }

  /** What the waterfall hands each answerer. */
  export interface AskUserQuestionRequest {
    readonly questions: readonly AskUserQuestionItem[]
    /** Present when an agent tool call is waiting on it. */
    readonly agent?: { readonly id: string }
    readonly signal?: AbortSignal
  }

  /** What an answerer gives back. */
  export interface AskUserQuestionAnswer {
    readonly answers: readonly AskUserQuestionAnswerItem[]
  }

  /** One person's answer to one question. */
  export interface AskUserQuestionAnswerItem {
    readonly id: string
    readonly selected: readonly string[]
    readonly custom?: string
  }

  /**
   * The three API controllers, as dsh 0.1.2 splits them.
   *
   * 🔴 These are **in-process services**, and that is the whole point. Pocket used to
   * reach the same surface by POSTing to its own process over loopback; 0.1.2 put the
   * local `/api` channel behind browser authentication *and* moved every method, so that
   * route broke twice over. A host plugin talking HTTP to itself was always the wrong
   * shape — it is the same object graph, one `ctx.get` away.
   *
   * Only what pocket calls is declared.
   */
  export interface SessionController {
    /** Every visible session row, without waking an agent. */
    list(request: Record<string, never>, signal: AbortSignal): Promise<{ sessions: readonly SessionRow[] }>
    /** Full-text search across sessions. */
    search(request: { query: string }, signal: AbortSignal): Promise<{ sessions: readonly SessionRow[] }>
    /** Start a new session. Returns its id — do not throw that away. */
    create(request: { workspaceId?: string, cwd?: string }): Promise<{ sessionId: string }>
    rename(request: { sessionId: string, title: string }): Promise<unknown>
    modelCatalog(): Promise<ModelCatalogValue>
    selectModel(request: { sessionId: string, provider: string, model: string }): Promise<unknown>
    /**
     * Speak into a session.
     *
     * Two reasons this replaced `agent.followup`: it accepts image parts and promotes
     * the bytes to durable attachments itself, and it resumes a session whose agent is
     * not currently live — without which a phone can only talk to whatever happens to be
     * open on the computer, which after a restart is nothing at all.
     */
    prompt(request: {
      requestId: string
      sessionId: string
      mode: 'queue' | 'steer'
      content: readonly PromptContentPart[]
    }, signal: AbortSignal): Promise<{ accepted: true }>
    cancel(request: { sessionId: string }): unknown
    /**
     * One page of history, walking backwards.
     *
     * 🔴 `throughSeq` is **not** "0 for the newest end" — it is the inclusive log cut
     * that `follow()`'s opening frame hands out. Passing 0 asks for everything up to
     * sequence zero, which is nothing, and the phone shows an empty conversation.
     */
    page(request: { address: SessionAddress, throughSeq: number, beforeSeq?: number, maxMessages?: number }, signal: AbortSignal): Promise<SessionPageValue>
    /** The opening window plus everything appended after it. Pocket only wants the opening frame. */
    follow(request: { address: SessionAddress, maxMessages?: number }, signal: AbortSignal): AsyncIterable<SessionFollowFrame>
    /** Resolve or **resume** a session's agent. */
    resolveAgent(sessionId: string): Promise<unknown>
  }

  /** What a prompt may carry. The image bytes are base64; the host stores them. */
  export type PromptContentPart =
    | { readonly type: 'text', readonly text: string }
    | { readonly type: 'image', readonly mediaType: ImageMediaType, readonly data: string, readonly name?: string }

  /** One row of the session list. */
  export interface SessionRow {
    readonly sessionId: string
    readonly title?: string
    readonly updatedAt?: string
    readonly running?: boolean
    readonly cwd?: string
  }

  /** How a session is addressed. The `kind` tag is required. */
  export interface SessionAddress {
    readonly kind: 'session'
    readonly sessionId: string
  }

  /** One page of history, newest-last. */
  export interface SessionPageValue {
    readonly records: readonly SessionHistoryRecord[]
    readonly hasMore: boolean
  }

  /** The opening frame of a follow stream: the first page, plus the cut to page back from. */
  export interface SessionFollowFrame {
    readonly type: string
    readonly cursor?: number
    readonly records?: readonly SessionHistoryRecord[]
    readonly hasMore?: boolean
  }

  /**
   * One row of a history page.
   *
   * 🔴 Two shapes, not one. Providers stream token-sized deltas, so a log would hold
   * hundreds of near-identical lines; dsh packs each run into a single `chunkrow/*` row
   * (its own note measures ~56× on a real session). A reader that only understands
   * `{type:'event'}` silently drops every assistant reply in the page.
   */
  export type SessionHistoryRecord =
    | { readonly type: 'event', readonly event: SessionEvent }
    | { readonly type: 'chunks', readonly event: ChunkRowEvent }

  /**
   * A packed run, as it appears inside a `chunks` record.
   *
   * ⚠️ Two levels, and both carry a `type`. The record's is `'chunks'`; the kind
   * (`chunkrow/text-chunks` and friends) is on this inner object, along with `seq` and
   * `time`. Flattening the two loses every assistant reply — the reader matches nothing
   * and skips the row.
   */
  export interface ChunkRowEvent {
    readonly type: string
    readonly seq: number
    readonly time: number
    readonly data?: { readonly texts?: readonly string[], readonly args?: readonly string[] }
  }

  /**
   * Provider groups as the model picker shows them.
   *
   * ⚠️ The list is `groups`, not `providers` — a guess at that name cost one live probe.
   * `default` is the current selection, which is what puts a tick next to a row.
   */
  export interface ModelCatalogValue {
    readonly default?: { readonly provider: string, readonly model: string }
    readonly groups: readonly {
      readonly id: string
      readonly name: string
      readonly models: readonly { readonly id: string, readonly name: string }[]
    }[]
  }

  export interface SettingsController {
    describe(): SettingsDescribeValue
    update(ns: string, patch: Record<string, unknown>, expectedRevision: number | undefined): Promise<unknown>
  }

  /** dsh's settings tree as the controller reports it. */
  export interface SettingsDescribeValue {
    readonly writable?: boolean
    readonly namespaces?: readonly {
      readonly ns?: string
      readonly revision?: number
      readonly secrets?: readonly string[]
      readonly value?: Readonly<Record<string, unknown>>
      readonly schema?: { readonly uid?: number, readonly refs?: Readonly<Record<string, SchemaNode>> }
    }[]
  }

  /** One node of a settings schema graph. */
  export interface SchemaNode {
    readonly type: string
    readonly value?: unknown
    readonly list?: readonly number[]
    readonly dict?: Readonly<Record<string, number>>
  }

  export interface WorkspaceController {
    archiveSession(request: { sessionId: string }): Promise<unknown>
    /** The workspace tree. The first frame is the whole baseline. */
    follow(signal: AbortSignal): AsyncIterable<WorkspaceFollowFrame>
  }

  export interface WorkspaceFollowFrame {
    readonly type: string
    readonly value?: { readonly workspaces?: readonly WorkspaceView[] }
  }

  export interface WorkspaceView {
    readonly workspaceId: string
    readonly title: string
    readonly sessionIds: readonly string[]
  }


  /** The context a plugin's apply receives (only the members this plugin uses). */
  export interface Context {
    /** The browser HTTP carrier; await it with ctx.inject(['webServer'], …). */
    webServer: WebServer
    /** The in-memory session store; await it with ctx.inject(['sessions'], …). */
    sessions: SessionStore
    /** The live agent registry; await it with ctx.inject(['agents'], …). */
    agents: AgentRegistry
    /** The session query seam. Optional: read it with ctx.get('sessionQuery'). */
    sessionQuery?: SessionQueryEngine
    /** dsh 0.1.2's API controllers. Optional: a headless profile composes none of them. */
    sessionController?: SessionController
    settingsController?: SettingsController
    workspaceController?: WorkspaceController
    logger: Logger
    /**
     * The config-tree anchor — the directory holding cordis.yml, i.e. the profile directory.
     * See packages/client/modules/src/index.ts:209.
     */
    baseUrl?: string
    /** Register a resource needing cleanup; returns its disposer. */
    effect(setup: () => Disposer, label?: string): Disposer
    /** Run the callback once the services are ready. */
    inject(services: readonly string[], callback: (ctx: Context) => void): void
    /** Read a service that may not exist. */
    get<T = unknown>(name: string): T | undefined
    /**
     * The post-commit append feed: fires after each event is committed to a
     * session's log. docs/subsystems/session.md — 'session/event'.
     */
    on(event: 'session/event', listener: (session: Session, event: SessionEvent) => void): Disposer
    /**
     * The user-question answerer chain — a waterfall, exactly like approvals.
     *
     * 🔴 This replaced a single-provider registration in dsh 0.1.2, and the change is
     * what makes the feature possible at all: pocket can now join the chain instead of
     * having to displace whoever owns it. `ask_user_question` and plan-mode approval both
     * come through here, and both **suspend the tool call** until somebody answers, so an
     * answerer that neither answers nor calls `next()` stalls the agent.
     */
    on(
      event: 'user-questions/request',
      listener: (
        request: AskUserQuestionRequest,
        next: () => Promise<AskUserQuestionAnswer>,
      ) => Promise<AskUserQuestionAnswer>,
      prepend?: boolean,
    ): Disposer
    /**
     * The approval answerer chain. docs/subsystems/approval.md — a waterfall: return an
     * outcome to claim the decision, or call `next()` to delegate to the rest of the
     * chain. Not calling `next()` short-circuits it.
     */
    on(
      event: 'approval/request',
      listener: (req: ApprovalRequest, next: () => Promise<ApprovalOutcome>) => Promise<ApprovalOutcome>,
      prepend?: boolean,
    ): Disposer
    /** Subscribe to any other event; returns the unsubscribe function. */
    on(event: string, listener: (...args: never[]) => void): Disposer
  }
}

declare module '@deepseek-ai/dsh-client-runtime/client' {
  import type { Context, Disposer } from '@deepseek-ai/cordis'
  import type { ComponentType } from 'react'

  /** A slots.register entry (only the fields this plugin uses). */
  export interface SlotRegistration {
    /** Target slot name. */
    name: string
    /** Entry id for a list-kind slot. */
    id?: string
    /** Ordering within a slot; lower comes first. */
    order?: number
    /** Display text, localised by the registrant. */
    label?: () => string
    /** The locale namespace this entry's copy belongs to. */
    locale?: string
    /** Domain factory: its return value is injected into the component as props. */
    inject?: () => unknown
    /** Child slots declared by this entry. */
    children?: Record<string, { kind: 'list' | 'keyed' | 'single' | 'chain'; scope: 'root' | 'session' }>
  }

  /** The browser-side slot registry. */
  export interface SlotsService {
    /** Registers following the slot's late or repeated declaration, with no import of the slot's owner. */
    inject(name: string, factory: () => Disposer): void
    register(registration: SlotRegistration, component: ComponentType<never>): Disposer
    entries(name: string): readonly { options: SlotRegistration }[]
    getVersion(name: string): number
    subscribe(name: string, listener: () => void): Disposer
  }

  /** Locale service. */
  export interface LocaleService {
    register(namespace: string, dictionaries: Record<string, Record<string, string>>): Disposer
    bind(namespace: string): (key: string, params?: Record<string, string | number>) => string
    subscribe(listener: () => void): Disposer
    getSnapshot(): { revision: number }
  }

  /** Browser plugin context. */
  export interface ClientContext extends Context {
    slots: SlotsService
    locale: LocaleService
  }
}

declare module '@deepseek-ai/dsh-client-ui-settings/client' {
  // Type-only, purely to bring the settings shell's slot declarations (settings.section etc.) into the compilation surface.
}

declare module '@deepseek-ai/dsh-client-locale/client' {
  // As above: brings in the ctx.locale Context merge.
}
