/**
 * Answering approval requests from a phone.
 *
 * dsh asks its answerer chain whether a tool call may proceed. Pocket joins that chain
 * as one answerer: when someone is watching from a phone it forwards the question and
 * waits for their tap; otherwise it steps aside immediately.
 *
 * 🔴 Stepping aside is the important half. The chain is a waterfall — an answerer that
 * neither answers nor calls `next()` blocks the agent. With nobody watching, waiting for
 * a phone that will never reply would stall a person sitting at the very machine that
 * asked, which is worse than not having the feature at all.
 */

import type { ApprovalOutcome, ApprovalRequest } from '@deepseek-ai/cordis'
import type { ApprovalRequest as WireApprovalRequest } from './types.ts'

/** How long a phone has to answer before the question goes back to the local chain. */
const PHONE_TIMEOUT_MS = 90_000

/** What the answerer needs from its host. */
export interface ApprovalDeps {
  /** How many phones are currently watching this machine. */
  readonly viewers: () => number
  /** Sends the question to the phones. Returns false when it could not be sent. */
  readonly ask: (request: WireApprovalRequest) => boolean
  readonly log: {
    info(message: string, ...args: readonly unknown[]): void
    debug(message: string, ...args: readonly unknown[]): void
  }
}

/** A question waiting for a phone. `undefined` means "nobody answered — hand it back". */
interface Pending {
  readonly settle: (outcome: 'allow' | 'deny' | undefined) => void
  readonly timer: ReturnType<typeof setTimeout>
}

/**
 * Routes approval questions to whoever is watching, and answers from their taps.
 */
export class PhoneApprovals {
  private readonly pending = new Map<string, Pending>()

  private counter = 0

  private readonly deps: ApprovalDeps

  constructor(deps: ApprovalDeps) {
    this.deps = deps
  }

  /**
   * The answerer to register on `approval/request`.
   *
   * @param req - The pending decision.
   * @param next - Delegates to the rest of the chain.
   * @returns The outcome.
   */
  async answer(req: ApprovalRequest, next: () => Promise<ApprovalOutcome>): Promise<ApprovalOutcome> {
    if (this.deps.viewers() === 0) return next()

    const requestId = `req_${String(++this.counter)}_${crypto.randomUUID().slice(0, 8)}`
    const expiresAt = new Date(Date.now() + PHONE_TIMEOUT_MS).toISOString()
    const sent = this.deps.ask({
      sessionId: req.agent.id,
      requestId,
      tool: req.toolName,
      // Arguments are not repeated here: the phone already received this tool call as a
      // session event and pairs the two by callId.
      argsSummary: '',
      expiresAt,
      ...(req.callId === undefined ? {} : { callId: req.callId }),
      ...(req.reason === undefined ? {} : { reason: req.reason }),
    })
    if (!sent) return next()

    const decision = await this.waitForPhone(requestId, req.signal)
    if (decision === undefined) {
      // Timed out, or dsh withdrew the question. Either way the local chain decides;
      // a late tap from the phone is discarded by `resolve` finding no pending entry.
      this.deps.log.debug('[pocket] no answer from a phone for %s, handing back to dsh', req.toolName)
      return next()
    }
    this.deps.log.info('[pocket] %s was %s from a phone', req.toolName, decision === 'allow' ? 'allowed' : 'refused')
    // 'allowed-once' grants only this action — there is no "always allow" from a phone,
    // deliberately: a standing grant is a bigger decision than a tap on a small screen.
    return decision === 'allow' ? 'allowed-once' : 'rejected'
  }

  /**
   * Apply an answer that came back from a phone.
   *
   * @param requestId - The id from the question.
   * @param decision - What the person tapped.
   */
  resolve(requestId: string, decision: 'allow' | 'deny'): void {
    const waiting = this.pending.get(requestId)
    if (waiting === undefined) {
      // Normal, not an error: the question already timed out or was withdrawn.
      this.deps.log.debug('[pocket] a late approval answer was discarded')
      return
    }
    waiting.settle(decision)
  }

  /**
   * Abandon every pending question. Called when the plugin unloads.
   *
   * 🔴 Each one is settled, not just dropped. An answerer's promise that never resolves
   * holds the approval waterfall open forever, so unloading pocket mid-question would
   * freeze the agent that asked — the exact failure this whole module is written to
   * avoid. Settling with no decision hands each question back to the local chain.
   */
  dispose(): void {
    for (const waiting of [...this.pending.values()]) {
      clearTimeout(waiting.timer)
      waiting.settle(undefined)
    }
    this.pending.clear()
  }

  private waitForPhone(requestId: string, signal: AbortSignal | undefined): Promise<'allow' | 'deny' | undefined> {
    return new Promise((resolve) => {
      const finish = (value: 'allow' | 'deny' | undefined): void => {
        const waiting = this.pending.get(requestId)
        if (waiting !== undefined) {
          clearTimeout(waiting.timer)
          this.pending.delete(requestId)
        }
        signal?.removeEventListener('abort', onAbort)
        resolve(value)
      }
      const onAbort = (): void => { finish(undefined) }
      const timer = setTimeout(() => { finish(undefined) }, PHONE_TIMEOUT_MS)
      timer.unref?.()
      this.pending.set(requestId, { settle: finish, timer })
      signal?.addEventListener('abort', onAbort, { once: true })
    })
  }
}
