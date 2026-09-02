import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { runAction, speak } from '../src/actions.ts'
import type { Context } from '@deepseek-ai/cordis'

interface Recorded {
  readonly prompts: unknown[]
  readonly cancels: unknown[]
}

/** A stand-in session controller that records what it was asked to do. */
const controllerWith = (
  recorded: Recorded,
  opts: { cancelThrows?: boolean, promptReturns?: unknown } = {},
): unknown => ({
  cancel: (arg: unknown) => {
    if (opts.cancelThrows === true) throw new Error('nothing running')
    recorded.cancels.push(arg)
  },
  prompt: async (req: unknown): Promise<unknown> => {
    recorded.prompts.push(req)
    return opts.promptReturns === undefined ? { accepted: true } : opts.promptReturns
  },
})

/** A context exposing a session controller (or none) via ctx.get, like the host does. */
const contextWith = (controller: unknown): Context => ({
  get: (name: string) => (name === 'sessionController' ? controller : undefined),
  logger: { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} },
} as unknown as Context)

describe('runAction', () => {
  it('leaves session.send to the async speak path', () => {
    const recorded: Recorded = { prompts: [], cancels: [] }
    const ctx = contextWith(controllerWith(recorded))

    // runAction does not send; speak() does. It only reports the frame as handled.
    const outcome = runAction(ctx, { t: 'session.send', sessionId: 'session_1', text: '继续' }, () => {})

    assert.equal(outcome, 'ignored')
    assert.equal(recorded.prompts.length, 0)
  })

  it('stops a running turn through the session controller', () => {
    const recorded: Recorded = { prompts: [], cancels: [] }
    const ctx = contextWith(controllerWith(recorded))

    const outcome = runAction(ctx, { t: 'turn.stop', sessionId: 'session_1' }, () => {})

    assert.equal(outcome, 'done')
    assert.deepEqual(recorded.cancels, [{ sessionId: 'session_1' }])
  })

  it('treats a failed cancel as an ordinary no-op', () => {
    const recorded: Recorded = { prompts: [], cancels: [] }
    const ctx = contextWith(controllerWith(recorded, { cancelThrows: true }))

    // Nothing was running, or the session is gone — both are ordinary, not errors.
    const outcome = runAction(ctx, { t: 'turn.stop', sessionId: 'session_1' }, () => {})

    assert.equal(outcome, 'ignored')
  })

  it('ignores turn.stop when the machine has no session controller', () => {
    const ctx = contextWith(undefined)

    const outcome = runAction(ctx, { t: 'turn.stop', sessionId: 'session_1' }, () => {})

    assert.equal(outcome, 'ignored')
  })

  it('renames the device locally', () => {
    const ctx = contextWith(undefined)
    let renamed = ''

    const outcome = runAction(ctx, { t: 'device.rename', name: '书房台式机' }, (name) => { renamed = name })

    assert.equal(outcome, 'done')
    assert.equal(renamed, '书房台式机')
  })
})

describe('speak', () => {
  it('sends the message as a queued prompt', async () => {
    const recorded: Recorded = { prompts: [], cancels: [] }
    const ctx = contextWith(controllerWith(recorded))

    const error = await speak(ctx, 'session_1', '继续')

    assert.equal(error, undefined)
    assert.equal(recorded.prompts.length, 1)
    const req = recorded.prompts[0] as { sessionId: string, mode: string, content: { type: string, text?: string }[] }
    assert.equal(req.sessionId, 'session_1')
    // queue, not steer: a phone message follows the current turn, it does not cut into it.
    assert.equal(req.mode, 'queue')
    assert.equal(req.content[0]?.type, 'text')
    assert.equal(req.content[0]?.text, '继续')
  })

  it('does nothing for an empty message with no photo', async () => {
    const recorded: Recorded = { prompts: [], cancels: [] }
    const ctx = contextWith(controllerWith(recorded))

    const error = await speak(ctx, 'session_1', '   ')

    assert.equal(error, undefined)
    assert.equal(recorded.prompts.length, 0)
  })

  it('reports when the machine has no session controller', async () => {
    const ctx = contextWith(undefined)

    const error = await speak(ctx, 'session_1', 'hi')

    assert.notEqual(error, undefined)
  })
})
