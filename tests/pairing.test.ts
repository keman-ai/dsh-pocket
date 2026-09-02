import assert from 'node:assert/strict'
import { createHmac, randomBytes } from 'node:crypto'
import { mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, it } from 'node:test'
import { clearPairingKey, pairingKey, pairingUrl, rotatePairingKey, verifyApproval } from '../src/pairing.ts'

const withDir = (run: (dir: string) => void): void => {
  const dir = mkdtempSync(join(tmpdir(), 'pocket-pairing-'))
  try {
    run(dir)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}

const sign = (key: Buffer, requestId: string, decision: string): string =>
  createHmac('sha256', key).update(`${requestId}:${decision}`).digest('base64url')

describe('pairing key', () => {
  it('creates one on first use and keeps it', () => {
    withDir((dir) => {
      const first = pairingKey(dir)
      const second = pairingKey(dir)

      assert.equal(first.length, 32)
      assert.deepEqual(first, second)
    })
  })

  it('stores it 0600 — the key authorises command execution', () => {
    withDir((dir) => {
      pairingKey(dir)

      const mode = statSync(join(dir, 'pocket-pairing-key')).mode & 0o777
      assert.equal(mode, 0o600)
    })
  })

  it('accepts a signature from a phone holding the key', () => {
    withDir((dir) => {
      const key = pairingKey(dir)

      assert.equal(verifyApproval(key, 'req_1', 'allow', sign(key, 'req_1', 'allow')), true)
    })
  })

  it('rejects a signature made with another key', () => {
    withDir((dir) => {
      const key = pairingKey(dir)
      const attacker = randomBytes(32)

      // This is the whole point: a relay that can read and replay frames still cannot
      // mint an approval, because it never sees this key.
      assert.equal(verifyApproval(key, 'req_1', 'allow', sign(attacker, 'req_1', 'allow')), false)
    })
  })

  it('will not let a refusal be replayed as an approval', () => {
    withDir((dir) => {
      const key = pairingKey(dir)

      // The decision is inside the signed material, so flipping it invalidates the
      // signature — a captured "deny" cannot be turned into "allow" in flight.
      const denied = sign(key, 'req_1', 'deny')
      assert.equal(verifyApproval(key, 'req_1', 'allow', denied), false)
    })
  })

  it('will not let one request\'s answer be reused for another', () => {
    withDir((dir) => {
      const key = pairingKey(dir)

      const forFirst = sign(key, 'req_1', 'allow')
      assert.equal(verifyApproval(key, 'req_2', 'allow', forFirst), false)
    })
  })

  it('rejects malformed signatures instead of throwing', () => {
    withDir((dir) => {
      const key = pairingKey(dir)

      // timingSafeEqual throws on a length mismatch, so a short signature must be
      // rejected before it reaches there.
      assert.equal(verifyApproval(key, 'req_1', 'allow', 'nonsense'), false)
      assert.equal(verifyApproval(key, 'req_1', 'allow', ''), false)
    })
  })

  it('invalidates paired phones when rotated', () => {
    withDir((dir) => {
      const old = pairingKey(dir)
      const signed = sign(old, 'req_1', 'allow')

      const rotated = rotatePairingKey(dir)

      assert.notDeepEqual(rotated, old)
      assert.equal(verifyApproval(rotated, 'req_1', 'allow', signed), false)
    })
  })

  it('puts the key in the fragment, never the query', () => {
    withDir((dir) => {
      const key = pairingKey(dir)

      const url = pairingUrl('https://dsh-pocket.a2hmarket.ai', 'device_1', key)

      // A fragment is not sent to the server. In the query it would reach CloudFront,
      // the gateway, and every access log along the way.
      const [beforeHash, fragment] = url.split('#')
      assert.equal(beforeHash?.includes(key.toString('base64url')), false)
      assert.equal(fragment?.includes(key.toString('base64url')), true)
    })
  })

  it('forgets the key on unlink', () => {
    withDir((dir) => {
      pairingKey(dir)
      clearPairingKey(dir)

      assert.throws(() => readFileSync(join(dir, 'pocket-pairing-key')))
    })
  })
})
