// @vitest-environment happy-dom
import React, { act } from 'react'
import { createRoot } from 'react-dom/client'
import { afterEach, test, expect, vi } from 'vitest'
import { McpTokensSheet } from './McpTokens.jsx'

globalThis.IS_REACT_ACT_ENVIRONMENT = true
const mocks = vi.hoisted(() => ({ api: vi.fn(), copy: vi.fn(async () => true), toast: vi.fn() }))
vi.mock('../lib/api.js', () => ({ api: (...args) => mocks.api(...args) }))
vi.mock('../lib/clipboard.js', () => ({ copyText: (...args) => mocks.copy(...args) }))
vi.mock('../store/useUI.js', () => ({ useUI: { getState: () => ({ toast: mocks.toast }) } }))
let root, host
const settle = () => act(() => new Promise(resolve => setTimeout(resolve, 0)))
const click = async label => { await act(async () => [...host.querySelectorAll('button')].find(b => b.textContent === label).click()); await settle() }
afterEach(() => { if (root) act(() => root.unmount()); host?.remove(); vi.clearAllMocks() })

test('owner creates scoped token, sees it once, copies it, and revokes it', async () => {
  let tokens = []
  const token = { id: 'test-id', token: 'test-secret', name: 'Codex Desktop', scopes: ['read', 'write'], expires: Date.now() + 86400000 }
  mocks.api.mockImplementation(async (path, options) => {
    if (options?.method === 'POST') { expect(JSON.parse(options.body)).toEqual({ name: 'Codex Desktop', access: 'write' }); tokens = [token]; return token }
    if (options?.method === 'DELETE') { expect(path).toBe('/api/account/mcp-tokens?id=test-id'); tokens = []; return { ok: true } }
    return { tokens }
  })
  host = document.createElement('div'); document.body.appendChild(host); root = createRoot(host)
  act(() => root.render(<McpTokensSheet close={() => {}} />)); await settle()
  await click('Read and write'); await click('Create token')
  expect(host.querySelector('[aria-label="Access token"]').value).toBe('test-secret')
  await click('Copy token'); expect(mocks.copy).toHaveBeenCalledWith('test-secret')
  await click('Done'); expect(host.querySelector('[aria-label="Access token"]')).toBeNull()
  await click('Revoke'); expect(host.textContent).toContain('No active MCP tokens.')
})
test('API errors remain visible without issuing or storing a secret', async () => {
  mocks.api.mockRejectedValue(new Error('not signed in'))
  host = document.createElement('div'); document.body.appendChild(host); root = createRoot(host)
  act(() => root.render(<McpTokensSheet close={() => {}} />)); await settle()
  expect(host.querySelector('[role="alert"]').textContent).toBe('not signed in')
  expect(host.querySelector('[aria-label="Access token"]')).toBeNull()
})
