/**
 * Where this machine's relay credentials live, and how they are written.
 *
 * The file sits in the profile directory rather than a global home: a profile is one
 * composition of dsh, and authorising `web` should not silently authorise `headless`
 * on the same machine.
 */

import { chmodSync, existsSync, mkdirSync, openSync, closeSync, fsyncSync, writeSync, renameSync, readFileSync, unlinkSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { DeviceCredentials } from './types.ts'

/** File name inside the profile directory. */
const FILE = 'pocket-credentials.json'

/**
 * Resolve ctx.baseUrl to a local directory. It may be a file:// URL or already a path.
 * @param baseUrl - The config-tree anchor.
 * @returns Absolute profile directory, or undefined when it cannot be resolved.
 */
export function profileDirOf(baseUrl: string | undefined): string | undefined {
  if (baseUrl === undefined || baseUrl === '') return undefined
  try {
    return baseUrl.startsWith('file:') ? fileURLToPath(baseUrl) : baseUrl
  } catch {
    return undefined
  }
}

/**
 * Absolute path of the credentials file for a profile.
 * @param profileDir - The profile directory.
 * @returns Absolute file path.
 */
export function credentialsPath(profileDir: string): string {
  return join(profileDir, FILE)
}

/**
 * Read this machine's credentials.
 * @param profileDir - The profile directory.
 * @returns The stored credentials, or undefined when this machine is not linked yet.
 */
export function readCredentials(profileDir: string): DeviceCredentials | undefined {
  const path = credentialsPath(profileDir)
  if (!existsSync(path)) return undefined
  try {
    const parsed = JSON.parse(readFileSync(path, 'utf8')) as Partial<DeviceCredentials>
    if (typeof parsed.deviceId !== 'string' || typeof parsed.token !== 'string') return undefined
    return {
      deviceId: parsed.deviceId,
      token: parsed.token,
      deviceName: typeof parsed.deviceName === 'string' ? parsed.deviceName : parsed.deviceId,
      authorisedAt: typeof parsed.authorisedAt === 'string' ? parsed.authorisedAt : '',
    }
  } catch {
    // A corrupt file means "not linked": the user re-authorises, which overwrites it.
    // Throwing here would instead take dsh down at boot over a file we can simply replace.
    return undefined
  }
}

/**
 * Write credentials so that a crash mid-write cannot leave a half-file.
 *
 * Write to a sibling temp file, fsync it, then rename over the target: rename is atomic
 * within a directory, so a reader sees either the old file or the new one. Then chmod
 * 0600 — the token authorises a phone to drive this machine's agent, so it must not be
 * world-readable on a shared box.
 *
 * @param profileDir - The profile directory.
 * @param credentials - What to persist.
 */
export function writeCredentials(profileDir: string, credentials: DeviceCredentials): void {
  const path = credentialsPath(profileDir)
  mkdirSync(dirname(path), { recursive: true })
  const temp = `${path}.${process.pid}.tmp`
  const payload = `${JSON.stringify(credentials, null, 2)}\n`
  const fd = openSync(temp, 'w', 0o600)
  try {
    writeSync(fd, payload)
    fsyncSync(fd)
  } finally {
    closeSync(fd)
  }
  renameSync(temp, path)
  try {
    chmodSync(path, 0o600)
  } catch {
    // Windows may not support chmod; the rename already placed the file with 0600 mode
    // on POSIX, and this call only re-asserts it for a pre-existing file.
  }
}

/**
 * Forget this machine's credentials.
 *
 * Unlinking is the whole job: the relay side of the revocation is a separate call, and
 * doing it here as well would tie "stop using the token locally" to a network round trip
 * that can fail.
 *
 * @param profileDir - The profile directory.
 */
export function clearCredentials(profileDir: string): void {
  const path = credentialsPath(profileDir)
  if (!existsSync(path)) return
  unlinkSync(path)
}
