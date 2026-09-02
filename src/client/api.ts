/**
 * Same-origin calls to the host half's routes.
 *
 * Relative URLs on purpose: the page is served by the same dsh web server, so this is
 * the loopback origin the host half also fences its write routes to.
 */

import type { PocketStatus } from '../types.ts'

/** Kept in step with API_PREFIX in the host half. */
const PREFIX = '/pocket/api'

/** What the settings page can ask the host to do. */
export interface PocketApi {
  status(): Promise<PocketStatus>
  /** Start an authorisation; resolves with the URL to open. */
  link(): Promise<string>
  unlink(): Promise<PocketStatus>
  /** Replace the signing key; phones pick up the new one on reconnect. */
  rotatePairing(): Promise<void>
}

/** Raised when a route answers with a non-2xx status. */
class ApiFailure extends Error {}

async function call<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(path, { ...init, credentials: 'same-origin' })
  if (!response.ok) {
    throw new ApiFailure(`HTTP ${String(response.status)}`)
  }
  return await response.json() as T
}

/**
 * Build the API client.
 * @returns The client.
 */
export function createApi(): PocketApi {
  return {
    status: () => call<PocketStatus>(`${PREFIX}/status`),
    link: async () => {
      const started = await call<{ authUrl: string }>(`${PREFIX}/link`, { method: 'POST' })
      return started.authUrl
    },
    unlink: () => call<PocketStatus>(`${PREFIX}/unlink`, { method: 'POST' }),
    rotatePairing: async () => { await call(`${PREFIX}/pairing/rotate`, { method: 'POST' }) },
  }
}
