/**
 * Client half: registers pocket as a page in Settings.
 *
 * It uses settings.section rather than squeezing into settings.plugins.tab — linking a
 * machine to an account is its own thing, not a sub-page of plugin management.
 */

// Type-only, purely to bring the settings shell's slot declaration (settings.section)
// and the ctx.locale merge into the compilation surface. Cross-plugin collaboration goes
// through services; never a value import (the client bundle purity gate blocks it).
import type {} from '@deepseek-ai/dsh-client-ui-settings/client'
import type {} from '@deepseek-ai/dsh-client-locale/client'
import type { ClientContext } from '@deepseek-ai/dsh-client-runtime/client'
import type { ComponentType } from 'react'
import { createApi } from './api.ts'
import { PocketSection, type PocketInjected } from './PocketSection.tsx'
import { en, zh } from './locales.ts'

export type { PocketInjected } from './PocketSection.tsx'
export type { PocketApi } from './api.ts'

/** The locale namespace this plugin owns. */
export const NS = 'settings.pocket'

/** Plugin version, shown in the page footer. Bump it together with package.json. */
const VERSION = '0.1.0'

/** Browser-side services required. */
export const inject = ['slots', 'locale']

/**
 * Mount the pocket page.
 * @param ctx - Browser plugin context.
 */
export function apply(ctx: ClientContext): void {
  ctx.effect(() => ctx.locale.register(NS, { zh, en }), 'pocket: dictionaries')

  const t = ctx.locale.bind(NS)
  const api = createApi()
  const injected = (): PocketInjected => ({ api, t, version: VERSION })

  // slots.inject follows the slot's late declaration and re-declaration, so the settings
  // shell need not be imported.
  ctx.slots.inject('settings.section', () => ctx.slots.register({
    name: 'settings.section',
    id: 'pocket',
    order: 45,
    label: () => t('nav'),
    locale: NS,
    inject: injected,
  }, PocketSection as ComponentType<never>))
}
