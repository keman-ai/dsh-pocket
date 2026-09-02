import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { PhoneApprovals } from '../src/approvals.ts'
import type { ApprovalRequest } from '@deepseek-ai/cordis'

const silent = { info: () => {}, debug: () => {} }

const request = (signal?: AbortSignal): ApprovalRequest => ({
  agent: { id: 'session_1', status: 'running', followup: () => {}, cancel: () => {} },
  toolName: 'bash',
  callId: 'call_1',
  ...(signal === undefined ? {} : { signal }),
})

describe('PhoneApprovals', () => {
  it('steps aside immediately when nobody is watching', async () => {
    let asked = false
    const approvals = new PhoneApprovals({
      viewers: () => 0,
      ask: () => { asked = true; return true },
      log: silent,
    })

    const outcome = await approvals.answer(request(), async () => 'allowed-once')

    // The point is not the outcome but that the chain continued without a phone
    // round-trip: waiting here would stall someone sitting at this very machine.
    assert.equal(outcome, 'allowed-once')
    assert.equal(asked, false, 'must not send a question when no phone is attached')
  })

  it('steps aside when the question cannot be sent', async () => {
    let delegated = false
    const approvals = new PhoneApprovals({
      viewers: () => 1,
      ask: () => false,
      log: silent,
    })

    await approvals.answer(request(), async () => { delegated = true; return 'rejected' })

    assert.equal(delegated, true)
  })

  it('turns a tap into a one-shot grant', async () => {
    let sentId = ''
    const approvals = new PhoneApprovals({
      viewers: () => 1,
      ask: (req) => { sentId = req.requestId; return true },
      log: silent,
    })

    const pending = approvals.answer(request(), async () => 'unavailable')
    await new Promise((resolve) => setImmediate(resolve))
    approvals.resolve(sentId, 'allow')

    assert.equal(await pending, 'allowed-once')
  })

  it('turns a refusal into a rejection, never a silent pass', async () => {
    let sentId = ''
    const approvals = new PhoneApprovals({
      viewers: () => 1,
      ask: (req) => { sentId = req.requestId; return true },
      log: silent,
    })

    const pending = approvals.answer(request(), async () => 'allowed-once')
    await new Promise((resolve) => setImmediate(resolve))
    approvals.resolve(sentId, 'deny')

    assert.equal(await pending, 'rejected')
  })

  it('hands the decision back when dsh withdraws the question', async () => {
    const controller = new AbortController()
    let delegated = false
    const approvals = new PhoneApprovals({ viewers: () => 1, ask: () => true, log: silent })

    const pending = approvals.answer(request(controller.signal), async () => { delegated = true; return 'cancelled' })
    await new Promise((resolve) => setImmediate(resolve))
    controller.abort()
    await pending

    assert.equal(delegated, true)
  })

  it('discards an answer that arrives after the question is gone', () => {
    const approvals = new PhoneApprovals({ viewers: () => 1, ask: () => true, log: silent })

    // A phone that taps just after a timeout must not throw, and must not affect a
    // later question that happens to reuse the screen.
    assert.doesNotThrow(() => { approvals.resolve('req_never_existed', 'allow') })
  })

  it('sends no tool arguments — the phone pairs them by callId', async () => {
    let sent: { callId?: string, argsSummary: string } | undefined
    const approvals = new PhoneApprovals({
      viewers: () => 1,
      ask: (req) => { sent = req; return true },
      log: silent,
    })

    const pending = approvals.answer(request(), async () => 'unavailable')
    await new Promise((resolve) => setImmediate(resolve))
    approvals.dispose()
    await pending

    assert.equal(sent?.callId, 'call_1')
    assert.equal(sent?.argsSummary, '')
  })
})
