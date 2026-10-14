import { applyMcpMutation, mcpMutationTarget } from '../../frontend/src/lib/mcp-mutations.js'

const error = (code, message, extra = {}) => Object.assign(new Error(message), { code, ...extra })
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b)

export function createRemoteClient(env = process.env, fetchImpl = fetch) {
  const remote = !!(env.OPENGYM_URL || env.OPENGYM_TOKEN)
  if (!remote) return null
  if (!env.OPENGYM_URL || !env.OPENGYM_TOKEN) throw error('CONFIG', 'remote mode requires OPENGYM_URL and OPENGYM_TOKEN')
  if (env.OPENGYM_DATA || env.OPENGYM_UID) throw error('CONFIG', 'remote mode cannot use OPENGYM_DATA or OPENGYM_UID')
  let url
  try { url = new URL(env.OPENGYM_URL) } catch { throw error('CONFIG', 'OPENGYM_URL must be a valid HTTPS app URL') }
  const local = ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname)
  if ((url.protocol !== 'https:' && !(local && url.protocol === 'http:')) || url.username || url.password || url.search || url.hash) {
    throw error('CONFIG', 'OPENGYM_URL must use HTTPS (HTTP only for localhost), without credentials, query or fragment')
  }
  const endpoint = url.href.replace(/\/+$/, '') + '/api/mcp/data'
  async function request(method, body) {
    let response
    try {
      response = await fetchImpl(endpoint, { method, redirect: 'error', signal: AbortSignal.timeout(15000),
        headers: { Authorization: `Bearer ${env.OPENGYM_TOKEN}`, Accept: 'application/json', 'Content-Type': 'application/json' },
        ...(body ? { body: JSON.stringify(body) } : {}) })
    } catch { throw error('NETWORK', 'OpenGym request failed or timed out; check the server connection', { ambiguous: method === 'PUT' }) }
    let data
    try { data = await response.json() } catch { throw error('BAD_RESPONSE', 'OpenGym returned an invalid response', { ambiguous: method === 'PUT' }) }
    if (!response.ok) {
      const code = { 401: 'AUTH', 403: 'FORBIDDEN', 404: 'DISABLED', 409: 'CONFLICT', 429: 'RATE_LIMIT' }[response.status] || 'SERVER'
      throw error(code, typeof data.error === 'string' ? data.error.slice(0, 200) : 'OpenGym refused the request', { ambiguous: method === 'PUT' && response.status >= 500 })
    }
    return data
  }
  async function snapshot() {
    const data = await request('GET')
    if (!data || typeof data.user?.id !== 'string' || typeof data.user?.name !== 'string' || !Array.isArray(data.scopes) || !data.scopes.includes('read') || !Number.isInteger(data.rev) || data.rev < 0 || (data.state !== null && (!data.state || typeof data.state !== 'object' || Array.isArray(data.state)))) {
      throw error('BAD_RESPONSE', 'OpenGym returned an invalid profile snapshot')
    }
    return data
  }
  async function mutate(tool, params) {
    let current = await snapshot()
    const baseline = mcpMutationTarget(current.state, tool, params)
    for (let attempt = 0; attempt < 3; attempt++) {
      if (!current.scopes.includes('write')) throw error('FORBIDDEN', 'MCP write access required')
      const mutation = applyMcpMutation(current.state, tool, params)
      if (!mutation.changed) return { ...mutation.result, rev: current.rev }
      if (!same(baseline, mcpMutationTarget(current.state, tool, params))) throw error('CONFLICT', 'another writer changed the targeted fields; read the profile and try again')
      try {
        const saved = await request('PUT', { state: mutation.state, baseRev: current.rev, baseWid: current.state?._wid || null, stamped: true })
        if (!saved?.ok || !Number.isInteger(saved.rev) || typeof saved.wid !== 'string') throw error('BAD_RESPONSE', 'OpenGym did not confirm persistence', { ambiguous: true })
        return { ...mutation.result, rev: saved.rev }
      } catch (e) {
        if (e.code !== 'CONFLICT' && !e.ambiguous) throw e
        // A lost successful response is detected before another PUT, including on the last try.
        current = await snapshot()
        const replay = applyMcpMutation(current.state, tool, params)
        if (!replay.changed) return { ...replay.result, rev: current.rev }
        if (attempt === 2) throw error('CONFLICT', 'write could not be confirmed after three attempts; read the profile before retrying')
      }
    }
  }
  return { snapshot, mutate }
}
