/**
 * The Settings page: link state, one action, and a plain statement of what the phone
 * cannot do.
 *
 * Styling is inline rather than a CSS module: this page is a handful of rows, and a
 * build-time stylesheet would cost more machinery than it saves. It reads dsh's own CSS
 * variables so it follows the active skin instead of pinning its own colours.
 */

import { useCallback, useEffect, useState } from 'react'
import type { CSSProperties } from 'react'
import type { PocketStatus } from '../types.ts'
import type { PocketApi } from './api.ts'

/** What the host half hands this component. */
export interface PocketInjected {
  readonly api: PocketApi
  readonly t: (key: string, params?: Record<string, string | number>) => string
  readonly version: string
}

const card: CSSProperties = {
  border: '1px solid var(--dsh-border, #dee3ea)',
  borderRadius: 'var(--dsh-radius-md, 8px)',
  padding: '18px 20px',
  marginBottom: 14,
  background: 'var(--dsh-surface, transparent)',
}

const label: CSSProperties = {
  fontSize: 12,
  letterSpacing: '0.06em',
  textTransform: 'uppercase',
  opacity: 0.6,
  marginBottom: 6,
}

const button: CSSProperties = {
  font: 'inherit',
  padding: '8px 16px',
  borderRadius: 'var(--dsh-radius-sm, 6px)',
  border: '1px solid var(--dsh-border, #dee3ea)',
  background: 'var(--dsh-accent, #4D6BFE)',
  color: '#fff',
  cursor: 'pointer',
}

const secondaryButton: CSSProperties = {
  ...button,
  background: 'transparent',
  color: 'inherit',
}

/**
 * Render the pocket settings page.
 * @param props - Injected host services and translator.
 * @returns The page.
 */
export function PocketSection(props: PocketInjected): JSX.Element {
  const { api, t, version } = props
  const [status, setStatus] = useState<PocketStatus | undefined>(undefined)
  const [busy, setBusy] = useState(false)
  const [failure, setFailure] = useState<string | undefined>(undefined)

  const refresh = useCallback(() => {
    api.status().then(setStatus).catch((error: unknown) => {
      setFailure(error instanceof Error ? error.message : String(error))
    })
  }, [api])

  useEffect(refresh, [refresh])

  /*
   * 授权期间才轮询：人在另一个标签页里点确认，这边没有别的办法知道他点完了。
   * 平时不轮询——一个常驻的定时器为一件一辈子只做一次的事守着，不值得。
   */
  useEffect(() => {
    if (status?.linking !== true) return undefined
    const timer = setInterval(refresh, 2000)
    return () => { clearInterval(timer) }
  }, [status?.linking, refresh])

  const onLink = useCallback(() => {
    setBusy(true)
    setFailure(undefined)
    api.link().then((authUrl) => {
      /*
       * The approval happens in a normal browser tab, not inside dsh: the account site
       * sets its own session cookies, and a tab the person can see is also how they
       * notice they are being asked to log in.
       */
      window.open(authUrl, '_blank', 'noopener,noreferrer')
      // 立刻刷一次，把状态切到 linking，轮询就接上了。
      refresh()
    }).catch((error: unknown) => {
      setFailure(error instanceof Error ? error.message : String(error))
    }).finally(() => { setBusy(false) })
  }, [api, refresh])

  const onUnlink = useCallback(() => {
    setBusy(true)
    api.unlink().then(setStatus).catch((error: unknown) => {
      setFailure(error instanceof Error ? error.message : String(error))
    }).finally(() => { setBusy(false) })
  }, [api])

  const connectionText = (state: PocketStatus): string => {
    if (state.connection === 'online') return t('stateOnline', { viewers: state.viewers })
    if (state.connection === 'connecting') return t('stateConnecting')
    return t('stateOffline')
  }

  return (
    <div>
      <h2 style={{ fontSize: 18, margin: '0 0 6px' }}>{t('title')}</h2>
      <p style={{ margin: '0 0 18px', maxWidth: '60ch', opacity: 0.8, lineHeight: 1.7 }}>{t('intro')}</p>

      {status?.enabled === false && (
        <div style={card}>
          <div style={label}>{t('disabledTitle')}</div>
          <p style={{ margin: 0, lineHeight: 1.7 }}>{t('disabledBody')}</p>
        </div>
      )}

      <div style={card}>
        <div style={label}>{status?.linked === true ? t('stateLinked', { name: status.deviceName ?? '' }) : t('stateUnlinked')}</div>
        <p style={{ margin: '0 0 14px', opacity: 0.75 }}>{status === undefined ? '…' : connectionText(status)}</p>
        {status?.linked === true
          ? <button type="button" style={secondaryButton} disabled={busy} onClick={onUnlink}>{t('unlink')}</button>
          : (
            <>
              <button type="button" style={button} disabled={busy || status?.linking === true} onClick={onLink}>
                {status?.linking === true ? t('waiting') : t('link')}
              </button>
              <p style={{ margin: '10px 0 0', fontSize: 13, opacity: 0.65, lineHeight: 1.65 }}>
                {status?.linking === true ? t('waitingHint') : t('linkHint')}
              </p>
            </>
          )}
      </div>

      {failure !== undefined && (
        <p style={{ color: 'var(--dsh-danger, #B93B2E)' }}>{t('failed', { detail: failure })}</p>
      )}

      <p style={{ fontSize: 12, opacity: 0.5, marginTop: 20 }}>dsh-pocket {version}</p>
    </div>
  )
}
