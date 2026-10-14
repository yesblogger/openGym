import { useEffect, useState } from 'react'
import { api } from '../lib/api.js'
import { copyText } from '../lib/clipboard.js'
import { t, dateLocale } from '../lib/i18n.js'
import { useUI } from '../store/useUI.js'
import { Row, TextField, Segmented, Button } from './ui.jsx'

export function McpTokensSheet({ close }) {
  const [tokens, setTokens] = useState(null)
  const [name, setName] = useState('Codex Desktop')
  const [access, setAccess] = useState('read')
  const [issued, setIssued] = useState(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const load = () => api('/api/account/mcp-tokens').then(r => setTokens(r.tokens)).catch(e => setError(e.message))
  useEffect(() => { load() }, [])
  const create = async () => {
    setBusy(true); setError('')
    try {
      const token = await api('/api/account/mcp-tokens', { method: 'POST', body: JSON.stringify({ name, access }) })
      setIssued(token)
      await load()
    } catch (e) { setError(e.message) }
    finally { setBusy(false) }
  }
  const revoke = async id => {
    setBusy(true); setError('')
    try {
      await api('/api/account/mcp-tokens?id=' + encodeURIComponent(id), { method: 'DELETE' })
      if (issued?.id === id) setIssued(null)
      await load()
    } catch (e) { setError(e.message) }
    finally { setBusy(false) }
  }
  return <>
    <h3>{t('MCP access tokens')}</h3>
    <p className="muted small">{t('Connect an AI client to this profile. Tokens expire after 90 days. Revoking a token ends its access immediately.')}</p>
    {issued ? <>
      <p>{t('Copy this token now. It will not be shown again.')}</p>
      <TextField aria-label={t('Access token')} readOnly value={issued.token} autoComplete="off" />
      <div className="row" style={{ gap: 8, marginTop: 12 }}>
        <Button onClick={async () => { if (await copyText(issued.token)) useUI.getState().toast(t('Copied')); else setError(t('Could not copy the token.')) }}>{t('Copy token')}</Button>
        <Button onClick={() => setIssued(null)}>{t('Done')}</Button>
      </div>
    </> : <>
      <label className="small" htmlFor="mcp-token-name">{t('Token name')}</label>
      <TextField id="mcp-token-name" value={name} onChange={e => setName(e.target.value)} maxLength={80} disabled={busy} />
      <div style={{ margin: '12px 0' }}><Segmented value={access} onChange={setAccess} options={[
        { value: 'read', label: t('Read only') }, { value: 'write', label: t('Read and write') }
      ]} /></div>
      <Button disabled={busy || !name.trim()} onClick={create}>{t('Create token')}</Button>
    </>}
    {error && <p role="alert" className="small" style={{ color: 'var(--red)' }}>{error}</p>}
    {tokens === null && !error && <p className="muted small">{t('Loading…')}</p>}
    {tokens?.length === 0 && <p className="muted small">{t('No active MCP tokens.')}</p>}
    {tokens?.map(token => <div key={token.id} className="row between" style={{ gap: 12, marginTop: 16 }}>
      <div className="grow"><div className="tt">{token.name}</div><div className="muted small">
        {token.scopes.includes('write') ? t('Read and write') : t('Read only')} · {t('Expires {0}', new Date(token.expires).toLocaleDateString(dateLocale()))}
      </div></div>
      <Button disabled={busy} onClick={() => revoke(token.id)}>{t('Revoke')}</Button>
    </div>)}
    <Button onClick={close} style={{ marginTop: 20 }}>{t('Close')}</Button>
  </>
}

export default function McpTokensRow() {
  return <Row icon="key" iconTint="var(--blue)" title={t('MCP access tokens')} subtitle={t('Connect Codex or another AI client to this profile.')} accessory="chevron"
    onClick={() => useUI.getState().openSheet(close => <McpTokensSheet close={close} />)} />
}
