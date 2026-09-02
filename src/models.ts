/**
 * Reaching dsh's API from inside dsh.
 *
 * 🔴 This used to POST to `http://127.0.0.1:<port>/api/<method>` — the plugin talking
 * HTTP to its own process. dsh 0.1.2 broke that twice over: the local `/api` channel
 * went behind browser authentication (loopback stopped being sufficient), and every
 * method moved when the single api-proxy was split into per-domain controllers. Both
 * failures were **silent** — each caller turns a missing answer into an empty result, so
 * the phone showed blank panels rather than an error.
 *
 * The fix is not to chase the transport. A host plugin shares an object graph with the
 * harness; the controllers are services one `ctx.get` away, with no wire format, no
 * authentication and no serialization in between. That is what this module does now.
 *
 * Every accessor is optional: a headless profile composes none of these controllers, and
 * a hard `inject` would keep the plugin from loading there at all. Reading a service that
 * was never injected **throws** in cordis rather than returning undefined, so `ctx.get`
 * is the only safe form.
 */

import type {
  Context, ModelCatalogValue, SessionController, SettingsController, WorkspaceController,
} from '@deepseek-ai/cordis'

/** The session domain, or undefined where it is not composed. */
export function sessions(ctx: Context): SessionController | undefined {
  return ctx.get<SessionController>('sessionController')
}

/** The settings domain. */
export function settings(ctx: Context): SettingsController | undefined {
  return ctx.get<SettingsController>('settingsController')
}

/** The workspace domain. */
export function workspaces(ctx: Context): WorkspaceController | undefined {
  return ctx.get<WorkspaceController>('workspaceController')
}

/**
 * Run one controller call, turning a refusal into `undefined`.
 *
 * @param ctx - Host plugin context, for logging.
 * @param what - What was being attempted, for the log.
 * @param run - The call.
 * @returns Its value, or undefined when it failed.
 */
export async function attempt<T>(ctx: Context, what: string, run: () => Promise<T>): Promise<T | undefined> {
  try {
    return await run()
  } catch (error) {
    lastFailure = `${what}: ${error instanceof Error ? error.message : String(error)}`
    ctx.logger.warn('[pocket] %s', lastFailure)
    return undefined
  }
}

/**
 * Why the last controller call failed.
 *
 * 🔴 Kept so the reason can reach the phone. Every reader here turns a failure into an
 * empty result, which on a phone looks like "the feature is just blank" — the single
 * most expensive failure mode in this codebase, and the one that hid an entire broken
 * RPC path for a whole release. The message is for a person; it never carries a path.
 */
let lastFailure: string | undefined

/** The last failure, and clears it. */
export function takeFailure(): string | undefined {
  const failure = lastFailure
  lastFailure = undefined
  return failure
}

/** One model a phone may pick. */
export interface ModelOption {
  readonly provider: string
  readonly model: string
  readonly label: string
}

/**
 * The model picker's contents plus what is selected.
 *
 * 🔴 The field is `models`, not `options`, and `current` is always present — both are
 * fixed by the relay's protocol contract. Renaming the list during the 0.1.2 migration
 * without touching the phone made the picker crash the page the moment it was opened
 * (`models.models.map` on undefined). The contract exists precisely because the two sides
 * share no types; change it there first, or not at all.
 */
export interface Catalog {
  readonly sessionId: string
  readonly models: readonly ModelOption[]
  readonly current: { readonly provider: string, readonly model: string }
}

/**
 * The model catalog.
 *
 * @param ctx - Host plugin context.
 * @param sessionId - Which session the phone is choosing for.
 * @returns The catalog, or undefined when dsh could not answer.
 */
export async function readCatalog(ctx: Context, sessionId: string): Promise<Catalog | undefined> {
  const controller = sessions(ctx)
  if (controller === undefined) return undefined
  const catalog = await attempt(ctx, 'model catalog', async () => controller.modelCatalog())
  if (catalog === undefined) return undefined
  const models = flatten(catalog)
  /*
   * Never leave `current` out. The phone renders the chip from it before anything is
   * picked, so an absent value is a crash rather than an empty state. The deployment
   * default is the truthful answer; the first model is a last resort that at least keeps
   * the picker usable.
   */
  const first = models[0]
  const current = catalog.default ?? (first === undefined
    ? { provider: '', model: '' }
    : { provider: first.provider, model: first.model })
  return { sessionId, models, current }
}

/** Provider groups flattened into one pickable list. */
function flatten(catalog: ModelCatalogValue): ModelOption[] {
  const out: ModelOption[] = []
  for (const provider of catalog.groups ?? []) {
    for (const model of provider.models ?? []) {
      out.push({
        provider: provider.id,
        model: model.id,
        // The provider name is part of the label: two providers routinely offer models
        // with the same name, and on a phone there is no column to tell them apart.
        label: `${provider.name} · ${model.name}`,
      })
    }
  }
  return out
}

/**
 * Switch a session's model.
 *
 * @param ctx - Host plugin context.
 * @param sessionId - Session to change.
 * @param provider - Provider route.
 * @param model - Model id.
 * @returns Whether dsh accepted it.
 */
export async function selectModel(ctx: Context, sessionId: string, provider: string, model: string): Promise<boolean> {
  const controller = sessions(ctx)
  if (controller === undefined) return false
  return await attempt(ctx, 'model selection', async () => controller.selectModel({ sessionId, provider, model })) !== undefined
}
