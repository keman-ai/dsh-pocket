/**
 * dsh's own settings, made available to a phone.
 *
 * 🔴 Why this is allowed at all: the harness pins `settings.*` to loopback because
 * `trustedHosts` is a DNS-rebinding fence and not authentication — the upstream comment
 * says so, and adds "until a real authentication layer exists". The link here is not a
 * remote browser talking to dsh; it is phone → relay → **this plugin, on loopback** →
 * dsh. The authentication the harness was waiting for is the one in front of that chain:
 * account, device ownership, and a signed action.
 *
 * 🔴 What is deliberately NOT exposed, and why each one:
 *
 *   · `permission` — its `defaultPreset` can be set to `danger-full-access`, which turns
 *     approvals off. A phone that can do that could disarm the very check that makes
 *     remote control safe, and it would be one tap behind a stolen account.
 *   · `llm-*` and anything whose `secrets` list is non-empty — API keys. A phone has no
 *     business reading or writing those, and the blast radius of leaking one is somebody
 *     else's bill.
 *   · `shell` — it decides what runs commands on that machine.
 *
 * The rest are preferences: language, theme, what Enter does while busy, the default
 * model. Getting those wrong costs an annoyance, not an incident.
 */

import type { Context, SchemaNode } from '@deepseek-ai/cordis'
import { attempt, settings as settingsController } from './models.ts'

/** Namespaces a phone may see and change. Everything else stays on the machine. */
const ALLOWED = new Set(['locale', 'ui-theme', 'ui-conversation', 'agent-default-model', 'agent-loop'])

/** Human labels — the harness ships schema, not copy. */
const LABELS: Record<string, string> = {
  'locale': '语言',
  'ui-theme': '外观',
  'ui-conversation': '忙碌时按回车',
  'agent-default-model': '默认模型',
  'agent-loop': 'Agent 循环',
}

const FIELD_LABELS: Record<string, string> = {
  preference: '偏好',
  busyEnter: '行为',
  provider: '提供方',
  model: '模型',
  maxParallelToolCalls: '并行工具调用上限',
}

/**
 * Fields whose dsh schema is an open string but which are, in practice, a choice from a
 * small known set — so a phone should offer a picker, not a text box where a typo becomes
 * an invalid value. Keyed `${ns}.${key}`.
 *
 * `locale.preference` is the case that forced this: its schema is
 * `z.string().pattern(...)` because the language catalog is extensible (language-pack
 * plugins add ids), so no options ride the schema. But the shipped set is zh/en, and a
 * phone typing a BCP-47 tag by hand is absurd. When a deployment installs a language pack
 * this list will lag it — an annoyance, not a hazard, since an unlisted id is still
 * reachable from the desktop.
 */
const ENUM_OVERRIDES: Record<string, readonly string[]> = {
  'locale.preference': ['zh', 'en'],
}

/** One editable field, already flattened for a phone to render. */
export interface SettingField {
  readonly key: string
  readonly label: string
  readonly kind: 'enum' | 'number' | 'string'
  readonly value: string | number | null
  /** Present for enums. */
  readonly options?: readonly string[]
}

/** One namespace as a phone sees it. */
export interface SettingGroup {
  readonly ns: string
  readonly label: string
  readonly revision: number
  readonly fields: readonly SettingField[]
}

/**
 * Flatten one namespace's schema graph into fields a phone can render.
 *
 * Only three shapes are handled — an enum (a union of consts), a number, and a string.
 * Anything else is skipped rather than guessed at: rendering a control that writes the
 * wrong shape back is worse than not offering it.
 */
function fieldsOf(
  ns: string,
  refs: Readonly<Record<string, SchemaNode>>,
  rootUid: number,
  value: Readonly<Record<string, unknown>>,
  secrets: readonly string[],
): SettingField[] {
  const root = refs[String(rootUid)]
  if (root?.type !== 'object' || root.dict === undefined) return []

  const fields: SettingField[] = []
  for (const [key, ref] of Object.entries(root.dict)) {
    if (secrets.includes(key)) continue
    const node = refs[String(ref)]
    if (node === undefined) continue
    const current = value[key]
    const label = FIELD_LABELS[key] ?? key

    // A curated pick-list wins over the schema shape: some fields are open strings in the
    // schema but a fixed choice in practice (see ENUM_OVERRIDES).
    const override = ENUM_OVERRIDES[`${ns}.${key}`]
    if (override !== undefined) {
      fields.push({ key, label, kind: 'enum', value: current === undefined ? null : String(current), options: override })
      continue
    }

    if (node.type === 'union' && node.list !== undefined) {
      const options = node.list
        .map((id) => refs[String(id)])
        .filter((n): n is SchemaNode => n?.type === 'const')
        .map((n) => String(n.value))
      if (options.length > 0) {
        fields.push({ key, label, kind: 'enum', value: current === undefined ? null : String(current), options })
      }
      continue
    }
    if (node.type === 'number') {
      fields.push({ key, label, kind: 'number', value: typeof current === 'number' ? current : null })
      continue
    }
    if (node.type === 'string') {
      fields.push({ key, label, kind: 'string', value: current === undefined ? null : String(current) })
    }
  }
  return fields
}

/**
 * The settings a phone may show.
 *
 * @param ctx - Host plugin context.
 * @returns Groups in the allow-list, or an empty list when dsh could not answer.
 */
export async function readSettings(ctx: Context): Promise<SettingGroup[]> {
  const controller = settingsController(ctx)
  if (controller === undefined) return []
  // describe() 是同步的（这版控制器直接返回值，不是 Promise），但包一层保持失败处理一致
  const value = await attempt(ctx, 'settings describe', async () => controller.describe())
  if (value === undefined) return []

  const groups: SettingGroup[] = []
  for (const namespace of value.namespaces ?? []) {
    const ns = namespace.ns
    if (ns === undefined || !ALLOWED.has(ns)) continue
    // A namespace that declares any secret is skipped whole: partial exposure of a
    // credential-bearing group is an easy way to leak one by accident later.
    if ((namespace.secrets ?? []).length > 0) continue

    const refs = namespace.schema?.refs
    const uid = namespace.schema?.uid
    if (refs === undefined || uid === undefined) continue

    const fields = fieldsOf(ns, refs, uid, namespace.value ?? {}, namespace.secrets ?? [])
    if (fields.length === 0) continue
    groups.push({ ns, label: LABELS[ns] ?? ns, revision: namespace.revision ?? 0, fields })
  }
  return groups
}

/**
 * Change one setting.
 *
 * @param ctx - Host plugin context.
 * @param ns - Namespace, which must be in the allow-list.
 * @param patch - Fields to change.
 * @returns Whether dsh accepted it.
 */
export async function updateSetting(
  ctx: Context,
  ns: string,
  patch: Readonly<Record<string, unknown>>,
): Promise<boolean> {
  /*
   * Re-check the allow-list here, not only when listing. The list is what a phone was
   * shown; this is what it may actually write — and a frame can name any namespace.
   */
  if (!ALLOWED.has(ns)) {
    ctx.logger.warn('[pocket] refused a settings write outside the allow-list: %s', ns)
    return false
  }
  const controller = settingsController(ctx)
  if (controller === undefined) return false
  /*
   * `expectedRevision: undefined` 表示不做乐观并发检查。手机拿到的 revision 可能已经旧了
   * （电脑上刚改过），而这里改的都是偏好项，最后写入者胜是可接受的；传一个陈旧的 revision
   * 只会让手机上的修改莫名其妙地失败。
   */
  return await attempt(ctx, 'settings update', async () => controller.update(ns, patch as Record<string, unknown>, undefined)) !== undefined
}
