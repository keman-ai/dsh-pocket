import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { runAction } from '../src/actions.ts'
import type { Agent, Context, UserMessage } from '@deepseek-ai/cordis'

interface Recorded {
  readonly followups: UserMessage[]
  readonly cancels: unknown[]
}

const contextWith = (agent: Agent | undefined): { ctx: Context, recorded: Recorded } => {
  const recorded: Recorded = { followups: [], cancels: [] }
  const ctx = {
    agents: { get: () => agent },
    logger: { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} },
  } as unknown as Context
  return { ctx, recorded }
}

const agentWith = (status: 'idle' | 'running', recorded: Recorded): Agent => ({
  id: 'session_1',
  status,
  followup: (message) => { recorded.followups.push(message) },
  cancel: (cause) => { recorded.cancels.push(cause) },
})

describe('runAction', () => {
  it('sends a message as an ordinary follow-up turn', () => {
    const recorded: Recorded = { followups: [], cancels: [] }
    const { ctx } = contextWith(agentWith('idle', recorded))

    const outcome = runAction(ctx, { t: 'session.send', sessionId: 'session_1', text: '继续' }, () => {})

    assert.equal(outcome, 'done')
    assert.equal(recorded.followups.length, 1)
    const message = recorded.followups[0]
    assert.equal(message?.role, 'user')
    assert.equal(message?.content[0]?.text, '继续')
    // The source must say a human spoke — marking it `plugin` would tell the model a
    // program did.
    assert.equal(message?.source.kind, 'user')
  })

  it('refuses to send into a session that is gone', () => {
    const { ctx } = contextWith(undefined)

    const outcome = runAction(ctx, { t: 'session.send', sessionId: 'session_gone', text: 'hi' }, () => {})

    assert.equal(outcome, 'no-such-session')
  })

  it('ignores an empty message rather than waking the agent', () => {
    const recorded: Recorded = { followups: [], cancels: [] }
    const { ctx } = contextWith(agentWith('idle', recorded))

    const outcome = runAction(ctx, { t: 'session.send', sessionId: 'session_1', text: '   ' }, () => {})

    assert.equal(outcome, 'ignored')
    assert.equal(recorded.followups.length, 0)
  })

  it('stops a running turn as a user cancellation', () => {
    const recorded: Recorded = { followups: [], cancels: [] }
    const { ctx } = contextWith(agentWith('running', recorded))

    const outcome = runAction(ctx, { t: 'turn.stop', sessionId: 'session_1' }, () => {})

    assert.equal(outcome, 'done')
    assert.deepEqual(recorded.cancels, [{ kind: 'user' }])
  })

  it('does not cancel an agent that is already idle', () => {
    const recorded: Recorded = { followups: [], cancels: [] }
    const { ctx } = contextWith(agentWith('idle', recorded))

    // cancel() on an idle agent is documented as a no-op, but calling it anyway would
    // arm nothing and log noise for every stale tap on a phone.
    const outcome = runAction(ctx, { t: 'turn.stop', sessionId: 'session_1' }, () => {})

    assert.equal(outcome, 'ignored')
    assert.equal(recorded.cancels.length, 0)
  })

  it('renames the device locally', () => {
    const { ctx } = contextWith(undefined)
    let renamed = ''

    const outcome = runAction(ctx, { t: 'device.rename', name: '书房台式机' }, (name) => { renamed = name })

    assert.equal(outcome, 'done')
    assert.equal(renamed, '书房台式机')
  })
})
