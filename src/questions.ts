/**
 * Answering the agent's questions from a phone.
 *
 * 🔴 Why this matters more than it looks: `ask_user_question` **suspends the tool call
 * until somebody answers**, and plan-mode approval comes through the same seam. Without
 * it a turn that reaches either simply stops, with nothing on the phone saying what it
 * waits for — you find out by walking back to the computer, which is the one thing pocket
 * exists to avoid.
 *
 * This is a waterfall answerer, the same shape as `approvals.ts`, because dsh 0.1.2 made
 * `user-questions/request` a waterfall. (In 0.1.0 it was a single registered provider and
 * joining meant displacing whoever held it; that is no longer the case, and the code that
 * used to subscribe to an api-proxy mux stream is gone with it.)
 *
 * 🔴 Stepping aside is the important half. An answerer that neither answers nor calls
 * `next()` blocks the agent. With nobody watching, waiting for a phone that will never
 * reply would stall a person sitting at the very machine that asked — worse than not
 * having the feature at all.
 */

import type { AskUserQuestionAnswer, AskUserQuestionRequest } from '@deepseek-ai/cordis'
import type { QuestionAsk } from './types.ts'

/** How long a phone has to answer before the question goes back to the local chain. */
const PHONE_TIMEOUT_MS = 120_000

/** What the answerer needs from its host. */
export interface QuestionDeps {
  /** How many phones are currently watching this machine. */
  readonly viewers: () => number
  /** Sends the question to the phones. */
  readonly ask: (ask: QuestionAsk) => void
  /** Tells the phones a question is no longer open. */
  readonly resolved: (rpcId: string) => void
  readonly log: {
    info(message: string, ...args: readonly unknown[]): void
    debug(message: string, ...args: readonly unknown[]): void
  }
}

/** A question waiting for a phone. `undefined` means "nobody answered — hand it back". */
interface Pending {
  readonly settle: (answer: AskUserQuestionAnswer | undefined) => void
  readonly timer: ReturnType<typeof setTimeout>
}

/** Routes the agent's questions to whoever is watching, and answers from their taps. */
export class PhoneQuestions {
  private readonly pending = new Map<string, Pending>()

  private counter = 0

  /** 经过这个答复者的提问总数，含立刻转交的。 */
  seen = 0

  private readonly deps: QuestionDeps

  constructor(deps: QuestionDeps) {
    this.deps = deps
  }

  /**
   * The answerer to register on `user-questions/request`.
   *
   * @param request - The pending question.
   * @param next - Delegates to the rest of the chain.
   * @returns The answer.
   */
  async answer(
    request: AskUserQuestionRequest,
    next: () => Promise<AskUserQuestionAnswer>,
  ): Promise<AskUserQuestionAnswer> {
    this.seen += 1
    if (this.deps.viewers() === 0) return next()

    this.counter += 1
    const id = `q${String(this.counter)}`
    this.deps.ask({
      // The id is ours, not dsh's: this chain hands over an object, not a wire request,
      // so there is nothing to echo. It only has to survive the round trip to the phone.
      rpcId: id,
      sessionId: request.agent?.id ?? '',
      questions: request.questions.map((q) => ({
        id: q.id,
        question: q.question,
        ...(q.detail === undefined ? {} : { detail: q.detail }),
        ...(q.header === undefined ? {} : { header: q.header }),
        ...(q.multiSelect === undefined ? {} : { multiSelect: q.multiSelect }),
        ...(q.options === undefined ? {} : { options: q.options.map((o) => ({ label: o.label, ...(o.description === undefined ? {} : { description: o.description }) })) }),
      })),
    })

    const answer = await new Promise<AskUserQuestionAnswer | undefined>((resolve) => {
      const timer = setTimeout(() => {
        this.pending.delete(id)
        this.deps.resolved(id)
        this.deps.log.debug('[pocket] nobody answered a question in time; handing it back')
        resolve(undefined)
      }, PHONE_TIMEOUT_MS)
      /*
       * Abort matters here: the turn can be cancelled from the computer while a phone is
       * still looking at the card. Without this the answerer would hold the waterfall for
       * the full timeout on a question nobody is waiting for any more.
       */
      request.signal?.addEventListener('abort', () => {
        this.pending.delete(id)
        clearTimeout(timer)
        this.deps.resolved(id)
        resolve(undefined)
      }, { once: true })
      this.pending.set(id, { settle: resolve, timer })
    })

    if (answer === undefined) return next()
    return answer
  }

  /**
   * A phone answered.
   *
   * @param rpcId - The id sent with the question.
   * @param answers - One entry per question.
   */
  resolve(rpcId: string, answers: AskUserQuestionAnswer['answers']): void {
    const waiting = this.pending.get(rpcId)
    // Arriving late is ordinary: the turn may have been cancelled, or the timeout hit.
    if (waiting === undefined) return
    this.pending.delete(rpcId)
    clearTimeout(waiting.timer)
    this.deps.resolved(rpcId)
    waiting.settle({ answers })
  }

  /** Hand every waiting question back to the chain. */
  releaseAll(): void {
    for (const [id, waiting] of this.pending) {
      clearTimeout(waiting.timer)
      this.deps.resolved(id)
      waiting.settle(undefined)
    }
    this.pending.clear()
  }
}
