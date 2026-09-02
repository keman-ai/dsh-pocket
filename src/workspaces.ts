/**
 * Which workspace each session belongs to.
 *
 * dsh groups sessions by workspace in its own sidebar, and a phone showing a flat list of
 * fifty conversations is a worse version of the same data. The grouping is dsh's, not
 * ours — we just read it.
 *
 * The registry stores the relation the other way round (a workspace owns a list of
 * session ids), so this inverts it once per listing rather than scanning per session.
 */

import type { Context } from '@deepseek-ai/cordis'
import { workspaces } from './models.ts'

/**
 * How long to wait for the baseline frame.
 *
 * 🔴 The workspace domain has no `list()` in dsh 0.1.2 — only `follow()`, a stream whose
 * **first** frame is the whole baseline. So this opens the stream, takes that one frame
 * and closes it. Without the timeout a controller that never speaks would leave the
 * session list waiting forever, and the phone would show nothing at all rather than an
 * ungrouped list.
 */
const BASELINE_TIMEOUT_MS = 5_000

/**
 * Build a session id → workspace title map.
 *
 * @param ctx - Host plugin context.
 * @returns The map; empty when dsh has no workspaces or could not answer.
 */
export async function workspaceOfSession(ctx: Context): Promise<Map<string, string>> {
  const map = new Map<string, string>()
  const controller = workspaces(ctx)
  if (controller === undefined) return map

  const abort = new AbortController()
  const timer = setTimeout(() => { abort.abort() }, BASELINE_TIMEOUT_MS)
  try {
    for await (const frame of controller.follow(abort.signal)) {
      if (frame.type !== 'baseline') continue
      for (const item of frame.value?.workspaces ?? []) {
        if (item.title === '') continue
        for (const sessionId of item.sessionIds) map.set(sessionId, item.title)
      }
      // One frame is all we came for; grouping does not need to stay live.
      break
    }
  } catch {
    // Timed out or the stream failed. An ungrouped list is a worse list, not a broken one.
  } finally {
    clearTimeout(timer)
    abort.abort()
  }
  return map
}
