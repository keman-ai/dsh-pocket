/**
 * The pairing key: what makes an approval verifiable.
 *
 * Account login answers "who are you". This key answers "did that phone really send
 * this approval". They are separate questions, and the second one matters because every
 * frame crosses the relay: whoever controls the relay could otherwise mint an approval
 * and have someone else's machine run whatever the agent just asked to run.
 *
 * ⚠️ The key IS handed over the relay (owner's call, 2026-08-27: scanning a code was
 * judged too much friction, and the account is accepted as the gate). So the signature
 * stops other connections from forging an approval — it does not stop the relay itself,
 * which sees the key on its way past.
 *
 * Restoring "not even the relay" needs only the delivery changed back to out-of-band;
 * everything here stays as is. That is why this module survived the change.
 */

import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto'
import { chmodSync, existsSync, mkdirSync, openSync, closeSync, fsyncSync, writeSync, renameSync, readFileSync, unlinkSync } from 'node:fs'
import { dirname, join } from 'node:path'

/** File name inside the profile directory. */
const FILE = 'pocket-pairing-key'

/** Absolute path of the key file. */
function keyPath(profileDir: string): string {
  return join(profileDir, FILE)
}

/**
 * Read this machine's pairing key, creating one on first use.
 *
 * @param profileDir - The profile directory.
 * @returns The key.
 */
export function pairingKey(profileDir: string): Buffer {
  const path = keyPath(profileDir)
  if (existsSync(path)) {
    try {
      const stored = Buffer.from(readFileSync(path, 'utf8').trim(), 'base64url')
      if (stored.length === 32) return stored
    } catch {
      // A corrupt key file means "not paired": regenerating invalidates the phones that
      // held the old one, which is the correct outcome for a key we cannot read.
    }
  }
  const key = randomBytes(32)
  writeKey(profileDir, key)
  return key
}

/**
 * Replace the key, invalidating every phone that holds the old one.
 * @param profileDir - The profile directory.
 * @returns The new key.
 */
export function rotatePairingKey(profileDir: string): Buffer {
  const key = randomBytes(32)
  writeKey(profileDir, key)
  return key
}

/**
 * Forget the key.
 * @param profileDir - The profile directory.
 */
export function clearPairingKey(profileDir: string): void {
  const path = keyPath(profileDir)
  if (existsSync(path)) unlinkSync(path)
}

/**
 * Whether a signature really came from a phone holding this machine's key.
 *
 * @param key - The pairing key.
 * @param requestId - The approval request being answered.
 * @param decision - The answer.
 * @param signature - base64url HMAC from the phone.
 * @returns true when it verifies.
 */
export function verifyApproval(key: Buffer, requestId: string, decision: string, signature: string): boolean {
  const expected = createHmac('sha256', key).update(`${requestId}:${decision}`).digest()
  let given: Buffer
  try {
    given = Buffer.from(signature, 'base64url')
  } catch {
    return false
  }
  /*
   * Length check first: timingSafeEqual throws on a length mismatch rather than
   * returning false, and a wrong-length signature is a plain reject, not an error.
   */
  if (given.length !== expected.length) return false
  return timingSafeEqual(given, expected)
}

/** Atomic write with 0600, same discipline as the credentials file. */
function writeKey(profileDir: string, key: Buffer): void {
  const path = keyPath(profileDir)
  mkdirSync(dirname(path), { recursive: true })
  const temp = `${path}.${process.pid}.tmp`
  const fd = openSync(temp, 'w', 0o600)
  try {
    writeSync(fd, `${key.toString('base64url')}\n`)
    fsyncSync(fd)
  } finally {
    closeSync(fd)
  }
  renameSync(temp, path)
  try {
    chmodSync(path, 0o600)
  } catch {
    // Windows may not support chmod; the file was created 0600 on POSIX already.
  }
}
