/**
 * Wire types for the pocket protocol.
 *
 * 🔴 The source of truth is the relay's protocol contract, not this file. The relay is
 * Java and shares no types with us, so that contract is the only thing keeping the two
 * implementations aligned: change it first, then both sides. A field added here alone
 * fails silently — the relay simply drops it.
 */

/** Protocol version this build speaks. Sent in `device/hello`; the relay refuses a mismatch. */
export const PROTOCOL_VERSION = '0.1.0'

/** One session as the phone lists it. */
export interface SessionSummary {
  readonly sessionId: string
  /** May be empty while dsh has not generated a title yet. */
  readonly title: string
  /** ISO 8601. */
  readonly lastActiveAt: string
  /** Whether a turn is currently running. */
  readonly running: boolean
  /** Title of the workspace this session belongs to; absent means ungrouped. */
  readonly workspace?: string
}

/** Session event kinds forwarded to the phone. Everything else is dropped at the source. */
export type SessionEventKind =
  | 'user/message'
  | 'assistant/chunk'
  | 'assistant/reasoning'
  | 'tool/call'
  | 'tool/result'
  | 'turn/start'
  | 'turn/end'
  | 'todo/write'

/** A session event projected for the phone. */
export interface PocketSessionEvent {
  readonly kind: SessionEventKind
  /** ISO 8601. */
  readonly at: string
  readonly payload: Readonly<Record<string, unknown>>
}

/** A tool call waiting for the user's decision. */
export interface ApprovalRequest {
  readonly sessionId: string
  readonly requestId: string
  readonly tool: string
  /**
   * Links to the `tool/call` event already sent to the phone, which carries the
   * arguments. They are not repeated here — a second copy is a copy that can drift, and
   * dsh's own ApprovalRequest omits them for the same reason.
   */
  readonly callId?: string
  /** The asker's explanation of why it is asking, when it gave one. */
  readonly reason?: string
  /** Kept for phones that have no matching tool/call to pair with; usually empty. */
  readonly argsSummary: string
  /** ISO 8601. A decision arriving after this is discarded. */
  readonly expiresAt: string
}

/** One question the agent put to the human, forwarded to the phone. */
export interface QuestionAsk {
  readonly sessionId: string
  /**
   * Our own id for this question.
   *
   * dsh 0.1.2 hands the answerer an object on a waterfall, not a wire request, so there
   * is no host id to echo. This one only has to survive the round trip to the phone and
   * back.
   */
  readonly rpcId: string
  readonly questions: readonly {
    readonly id: string
    readonly question: string
    /** 补充说明，不进选项标签。 */
    readonly detail?: string
    readonly header?: string
    readonly multiSelect?: boolean
    readonly options?: readonly { readonly label: string, readonly description?: string }[]
  }[]
}

/** One image on its way from a phone to the agent. */
export interface OutgoingImage {
  /** base64 without the `data:` prefix. */
  readonly data: string
  /** `image/jpeg`, `image/png`, `image/webp` or `image/gif`. */
  readonly mediaType: string
  readonly name?: string
}

/** What the phone may ask this device to do. Nothing outside this union is honoured. */
export type PocketAction =
  | { readonly t: 'session.open', readonly sessionId: string }
  | {
    readonly t: 'session.send'
    readonly sessionId: string
    readonly text: string
    /** Photos taken on the phone. Absent for an ordinary text message. */
    readonly images?: readonly OutgoingImage[]
  }
  | {
    readonly t: 'approval.respond'
    readonly requestId: string
    readonly decision: 'allow' | 'deny'
    /** base64url HMAC over `requestId:decision` with the pairing key. Unsigned answers are dropped. */
    readonly sig?: string
  }
  | { readonly t: 'turn.stop', readonly sessionId: string }
  | { readonly t: 'device.rename', readonly name: string }
  | { readonly t: 'session.list' }
  | { readonly t: 'session.create' }
  | { readonly t: 'session.more', readonly sessionId: string, readonly beforeSeq: number }
  | { readonly t: 'pair.request' }
  | { readonly t: 'settings.list' }
  | { readonly t: 'settings.set', readonly ns: string, readonly patch: Readonly<Record<string, unknown>> }
  | { readonly t: 'session.rename', readonly sessionId: string, readonly title: string }
  | { readonly t: 'session.archive', readonly sessionId: string }
  | { readonly t: 'model.list', readonly sessionId: string }
  | { readonly t: 'model.select', readonly sessionId: string, readonly provider: string, readonly model: string }
  | {
    /**
     * An answer to `ask_user_question` — plan approval included, since plan mode asks
     * through the same seam.
     *
     * 🔴 Deliberately **not** signed, unlike `approval.respond`. The signature on an
     * approval exists because an approval bypasses the human gate on executing a tool
     * the agent already proposed. An answer here does not: whatever the agent decides to
     * do next still meets that gate, which is signed. And a relay that wanted to steer
     * this machine already has the far blunter `session.send`, which carries arbitrary
     * instructions and is likewise unsigned. Signing the weaker vector while the
     * stronger one stays open would buy nothing.
     */
    readonly t: 'question.respond'
    readonly rpcId: string
    readonly answers: readonly {
      readonly id: string
      readonly selected: readonly string[]
      readonly custom?: string
    }[]
  }

/**
 * Credentials this machine holds after the user authorised it.
 *
 * 🔴 What is stored here is a device secret, NOT the account's personal access token.
 * The PAT is used once, during authorisation, and dropped — it never reaches disk.
 *
 * The reason is that a plugin and the agent share one trust domain: same process, same
 * user. Anything the plugin can read, a prompt-injected agent can read too, and dsh
 * cannot prevent that — the fs policy has no vetoable read, and the fs tool reads inside
 * the process where the sandbox does not reach. So the goal is not to hide the
 * credential better; it is to make the credential worth less. A leaked device secret
 * impersonates this machine's pocket channel and nothing else: no posting, no ordering,
 * no touching the A2H account, and no approving commands — that needs the pairing key,
 * which lives on the phone.
 */
export interface DeviceCredentials {
  /** `device_<ulid>`, issued by the relay on first authorisation. */
  readonly deviceId: string
  /** Device-scoped secret. Never logged, never sent anywhere but the relay. */
  readonly token: string
  /** Display name, editable by the user. */
  readonly deviceName: string
  /** ISO 8601, when this machine was authorised. */
  readonly authorisedAt: string
}

/** What the settings page shows. Deliberately carries no token and no session content. */
export interface PocketStatus {
  /** Whether the plugin is switched on at all. */
  readonly enabled: boolean
  /** Whether this machine has been authorised. */
  readonly linked: boolean
  /** Whether an authorisation is open in a browser right now, waiting to be confirmed. */
  readonly linking: boolean
  /** Present once linked. */
  readonly deviceName?: string
  /** Present once linked. */
  readonly deviceId?: string
  /** Live relay connection state. */
  readonly connection: 'offline' | 'connecting' | 'online'
  /** How many phones are currently attached to this device. */
  readonly viewers: number
  /** Present when the last connection attempt failed; a reason for humans, no secrets. */
  readonly lastError?: string
  /**
   * Approval answers dropped for failing their signature check, since this process
   * started.
   *
   * Not a debug counter: a non-zero value means something sent this machine an approval
   * it could not have signed — a stale phone that needs to scan again, or someone trying
   * it on. Either way the person running dsh should be able to see it.
   */
  readonly droppedApprovals: number
  /**
   * agent 提问经过本插件的次数（含转交给电脑的）。
   *
   * 不是调试计数：提问是**阻塞**的，agent 会停在那里等人回答。这个数一直是 0，而电脑上
   * 明明弹了提问，就说明瀑布没派发到这里——那是手机端「一轮莫名卡住」的根因，不该靠猜。
   */
  readonly questionsSeen: number
}
