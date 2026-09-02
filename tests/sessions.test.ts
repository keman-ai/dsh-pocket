import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { SessionProjector, type ProjectedEvent } from '../src/sessions.ts'
import type { Session, SessionEvent } from '@deepseek-ai/cordis'

const session = { id: 'session_1', header: { id: 'session_1', createdAt: 1_700_000_000_000 } } as Session
const record = { header: { id: 'session_1', createdAt: 1_700_000_000_000, cwd: '/Users/me/work/my-project' }, live: true, persisted: true }

let seq = 0
const event = (type: string, data: unknown): SessionEvent =>
  ({ type, seq: ++seq, time: 1_700_000_000_000, data } as unknown as SessionEvent)

const textDelta = (text: string): SessionEvent =>
  event('assistant/chunk', { chunk: { type: 'text-delta', index: 0, text } })

const collect = (): { sink: (p: ProjectedEvent) => void, out: ProjectedEvent[] } => {
  const out: ProjectedEvent[] = []
  return { sink: (p) => out.push(p), out }
}

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))

describe('SessionProjector', () => {
  it('drops event types a phone has no use for', () => {
    const { sink, out } = collect()
    const projector = new SessionProjector(sink)

    projector.accept(session, event('request/header', { header: {} }))
    projector.accept(session, event('session/end-seed', {}))

    assert.deepEqual(out, [])
    projector.dispose()
  })

  it('coalesces token deltas into one frame', async () => {
    const { sink, out } = collect()
    const projector = new SessionProjector(sink)

    projector.accept(session, textDelta('你'))
    projector.accept(session, textDelta('好'))
    projector.accept(session, textDelta('吗'))

    // Nothing goes out per token — that is the whole point on a mobile connection.
    assert.equal(out.length, 0)

    await sleep(300)
    assert.equal(out.length, 1)
    assert.equal(out[0]?.event.payload['text'], '你好吗')
    projector.dispose()
  })

  it('flushes buffered text before the turn is declared over', () => {
    const { sink, out } = collect()
    const projector = new SessionProjector(sink)

    projector.accept(session, textDelta('最后一句'))
    projector.accept(session, event('turn/end', { turn: 1, reason: { kind: 'stop' } }))

    // Order matters: text buffered from this turn must not arrive after "turn ended".
    assert.equal(out[0]?.event.kind, 'assistant/chunk')
    assert.equal(out[0]?.event.payload['text'], '最后一句')
    assert.equal(out[1]?.event.kind, 'turn/end')
    projector.dispose()
  })

  it('forwards reasoning on its own stream', async () => {
    const { sink, out } = collect()
    const projector = new SessionProjector(sink)

    projector.accept(session, event('assistant/chunk', { chunk: { type: 'reasoning-delta', index: 0, text: '让我想想' } }))
    await sleep(300)

    assert.equal(out.length, 1)
    assert.equal(out[0]?.event.kind, 'assistant/reasoning')
    assert.equal(out[0]?.event.payload['text'], '让我想想')
    projector.dispose()
  })

  it('keeps reasoning out of the answer buffer', async () => {
    const { sink, out } = collect()
    const projector = new SessionProjector(sink)

    // 两路交错到达：合进一个缓冲就会把思考插进回答中间。
    projector.accept(session, event('assistant/chunk', { chunk: { type: 'reasoning-delta', index: 0, text: '嗯…' } }))
    projector.accept(session, textDelta('今天是'))
    projector.accept(session, event('assistant/chunk', { chunk: { type: 'reasoning-delta', index: 0, text: '对了' } }))
    projector.accept(session, textDelta('8 月 27 日'))
    await sleep(300)

    const answer = out.filter((p) => p.event.kind === 'assistant/chunk')
    const reasoning = out.filter((p) => p.event.kind === 'assistant/reasoning')
    assert.equal(answer.length, 1)
    assert.equal(answer[0]?.event.payload['text'], '今天是8 月 27 日')
    assert.equal(reasoning.length, 1)
    assert.equal(reasoning[0]?.event.payload['text'], '嗯…对了')
    projector.dispose()
  })

  it('titles a session from its first message and keeps it', () => {
    const { sink } = collect()
    const projector = new SessionProjector(sink)

    projector.accept(session, event('user/message', { content: [{ type: 'text', text: '帮我看看这个 bug' }] }))
    projector.accept(session, event('user/message', { content: [{ type: 'text', text: '再改一下' }] }))

    assert.equal(projector.summaries([record])[0]?.title, '帮我看看这个 bug')
    projector.dispose()
  })

  it('tracks whether a turn is running', () => {
    const { sink } = collect()
    const projector = new SessionProjector(sink)

    projector.accept(session, event('turn/start', { turn: 1 }))
    assert.equal(projector.summaries([record])[0]?.running, true)

    projector.accept(session, event('turn/end', { turn: 1, reason: { kind: 'stop' } }))
    assert.equal(projector.summaries([record])[0]?.running, false)
    projector.dispose()
  })

  it('names an unseen session by its working directory', () => {
    const projector = new SessionProjector(() => {})

    // A session from before the plugin loaded still belongs in the list — it just has no
    // observed title, so the folder names it rather than showing a blank row.
    const summaries = projector.summaries([record])

    assert.equal(summaries.length, 1)
    assert.equal(summaries[0]?.title, 'my-project')
    assert.equal(summaries[0]?.running, false)
    projector.dispose()
  })
})
