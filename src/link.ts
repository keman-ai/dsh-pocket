/**
 * Linking this machine to an A2H Market account.
 *
 * The account site's authorisation page has a frozen URL contract —
 * `account.a2hmarket.ai/authcode?code=<code>` — and it does not take a redirect_uri:
 * after the person confirms, the page writes the grant server-side and shows them the
 * token. So this is a device flow, not a loopback callback: we open the page with a code
 * we generated, then poll the public read endpoint until the grant appears.
 *
 * (An earlier draft used a 127.0.0.1 callback, copied from the a2hmarket CLI skill. That
 * skill points at the v2 front-end's own authcode page, which is retired — the account
 * site never accepted a redirect_uri. Poll is the shape that actually exists.)
 *
 * Two round trips, because they answer different questions:
 *   1. poll for the personal access token — "who is this human"
 *   2. register that token with the relay for a device id — "which machine is this"
 *
 * Keeping them apart means the account site needs no knowledge of pocket, and the relay
 * never sees the authorisation code.
 */

import { randomUUID } from 'node:crypto'
import { hostname } from 'node:os'
import type { DeviceCredentials } from './types.ts'

/** How long to wait for the person to confirm before giving up. */
const AUTHORISE_TIMEOUT_MS = 5 * 60 * 1000

/** Gap between polls. Short enough to feel instant, long enough not to hammer. */
const POLL_EVERY_MS = 3_000

/** Endpoints this flow talks to. */
export interface LinkEndpoints {
  /** Account site origin, serving the `/authcode` approval page. */
  readonly accountOrigin: string
  /** findu-user origin, serving the code-for-token exchange. */
  readonly userOrigin: string
  /** Relay origin, serving device registration. */
  readonly relayOrigin: string
}

/** What the settings page needs to send the user to the approval page. */
export interface LinkStart {
  readonly authUrl: string
}

/** Raised when linking fails for a reason worth showing the user. */
export class LinkFailure extends Error {}

/** Device secrets carry this prefix; an access token does not. */
const SECRET_PREFIX = 'pks_'

/**
 * Whether stored credentials still hold an access token rather than a device secret.
 *
 * Machines linked before device secrets existed have a PAT on disk. That is exactly the
 * credential needed to obtain a device secret, so they can upgrade themselves instead of
 * asking the person to authorise again — and the sooner they do, the sooner that PAT
 * stops sitting in a file the agent can read.
 *
 * @param credentials - What is on disk.
 * @returns true when a migration is due.
 */
export function needsSecretUpgrade(credentials: DeviceCredentials): boolean {
  return !credentials.token.startsWith(SECRET_PREFIX)
}

/**
 * Trade a stored access token for a device secret, keeping the same device.
 *
 * @param endpoints - Where the relay is.
 * @param credentials - Existing credentials holding an access token.
 * @returns Credentials holding a device secret.
 */
export async function upgradeToDeviceSecret(
  endpoints: LinkEndpoints,
  credentials: DeviceCredentials,
): Promise<DeviceCredentials> {
  // Same device name, so the relay reuses this machine's existing record rather than
  // registering a second one.
  return registerDevice(endpoints.relayOrigin, credentials.token, credentials.deviceName)
}

/** How a link attempt ended. */
export type LinkOutcome =
  | { readonly ok: true, readonly credentials: DeviceCredentials }
  | { readonly ok: false, readonly detail: string }

/**
 * One in-flight authorisation per dsh process.
 *
 * A single slot rather than a map: two browser tabs authorising the same machine has no
 * meaning, and a second start should supersede the first rather than leave both live.
 * Memory-only — an unfinished authorisation does not survive a restart, and should not.
 */
let pending: { code: string, abort: AbortController } | undefined

/**
 * Begin an authorisation and poll until it completes.
 *
 * @param endpoints - Where to send the browser and where to poll.
 * @param onDone - Called once with the outcome. Never called if the attempt is superseded.
 * @returns The URL to open in the browser.
 */
export function beginLink(endpoints: LinkEndpoints, onDone: (outcome: LinkOutcome) => void): LinkStart {
  cancelLink()
  const code = `POCKET-${randomUUID().replace(/-/g, '').slice(0, 16)}`
  const abort = new AbortController()
  pending = { code, abort }

  void poll(endpoints, code, abort.signal)
    .then(async (token) => {
      const credentials = await registerDevice(endpoints.relayOrigin, token)
      if (!abort.signal.aborted) onDone({ ok: true, credentials })
    })
    .catch((error: unknown) => {
      if (abort.signal.aborted) return
      onDone({ ok: false, detail: error instanceof LinkFailure ? error.message : 'the authorisation could not be completed' })
    })
    .finally(() => {
      if (pending?.code === code) pending = undefined
    })

  return { authUrl: `${endpoints.accountOrigin}/authcode?code=${encodeURIComponent(code)}` }
}

/** Whether an authorisation is waiting for the person to confirm. */
export function isLinking(): boolean {
  return pending !== undefined
}

/** Abandon any in-flight authorisation. */
export function cancelLink(): void {
  pending?.abort.abort()
  pending = undefined
}

/** Shape of findu-user's envelope. Only the field consumed is listed. */
interface TokenEnvelope {
  readonly data?: { readonly patToken?: string } | null
}

/**
 * Poll the public read endpoint until the grant appears.
 *
 * @param endpoints - Where to poll.
 * @param code - The code shown to the account site.
 * @param signal - Aborted when the attempt is superseded or cancelled.
 * @returns The personal access token.
 */
async function poll(endpoints: LinkEndpoints, code: string, signal: AbortSignal): Promise<string> {
  const url = `${endpoints.userOrigin}/api/v1/public/user/agent/auth?code=${encodeURIComponent(code)}`
  const deadline = Date.now() + AUTHORISE_TIMEOUT_MS

  while (Date.now() < deadline) {
    if (signal.aborted) throw new LinkFailure('cancelled')
    const token = await readGrant(url, signal)
    if (token !== undefined) return token
    await new Promise((resolve) => setTimeout(resolve, POLL_EVERY_MS))
  }
  throw new LinkFailure('the authorisation timed out; start again from Settings')
}

/**
 * One poll.
 * @param url - The public read endpoint.
 * @param signal - Abort signal.
 * @returns The token, or undefined while the person has not confirmed yet.
 */
async function readGrant(url: string, signal: AbortSignal): Promise<string | undefined> {
  let response: Response
  try {
    response = await fetch(url, { signal })
  } catch {
    // A transient network failure mid-authorisation is not a reason to give up on the
    // whole attempt — the person may still be typing an OTP. Keep polling.
    return undefined
  }
  if (!response.ok) return undefined
  /*
   * 🔴 HTTP 200 is not success: ApiResponse returns 200 for business failures too, and
   * "not confirmed yet" is exactly that shape — a 200 with no token.
   */
  const body = await response.json().catch(() => ({})) as TokenEnvelope
  const token = body.data?.patToken
  return typeof token === 'string' && token !== '' ? token : undefined
}

/** Shape of the relay's registration response. */
interface RegisterEnvelope {
  readonly data?: { readonly deviceId?: string, readonly deviceSecret?: string } | null
}

/**
 * Register this machine with the relay and obtain its own credential.
 *
 * 🔴 The access token is used for exactly this call and then dropped. What gets stored
 * is the device secret the relay issues here — see DeviceCredentials for why.
 *
 * @param relayOrigin - Relay origin.
 * @param token - The personal access token just obtained; not retained.
 * @returns Credentials for this machine.
 */
async function registerDevice(relayOrigin: string, token: string, name?: string): Promise<DeviceCredentials> {
  const deviceName = name ?? hostname()
  const response = await fetch(`${relayOrigin}/api/v1/pocket/devices`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
    body: JSON.stringify({ deviceName }),
  })
  if (!response.ok) {
    throw new LinkFailure(`the relay refused to register this machine (HTTP ${String(response.status)})`)
  }
  const body = await response.json() as RegisterEnvelope
  const deviceId = body.data?.deviceId
  const deviceSecret = body.data?.deviceSecret
  if (typeof deviceId !== 'string' || deviceId === '') {
    throw new LinkFailure('the relay returned no device id')
  }
  if (typeof deviceSecret !== 'string' || deviceSecret === '') {
    throw new LinkFailure('the relay issued no device secret; it may be running an older build')
  }
  // The PAT goes no further than this function.
  return { deviceId, token: deviceSecret, deviceName, authorisedAt: new Date().toISOString() }
}
