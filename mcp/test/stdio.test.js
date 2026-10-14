// A real API and a real spawned MCP process; fixtures only, never a deployed profile.
import { test, expect } from 'vitest'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import crypto from 'node:crypto'
import { spawn } from 'node:child_process'
import { once } from 'node:events'
import { fileURLToPath } from 'node:url'
import { boundPort } from '../../api/test/helpers.mjs'

const root = fileURLToPath(new URL('../../', import.meta.url))
test('all 15 tools work over real stdio/HTTP, and read-only tokens expose ten', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gym-mcp-stdio-'))
  const secret = crypto.randomBytes(32).toString('hex')
  fs.writeFileSync(path.join(dir, 'secret'), secret)
  fs.writeFileSync(path.join(dir, 'db.json'), JSON.stringify({ users: [{ id: 'fixture', name: 'Fixture' }], creds: [], subs: [], invites: [] }))
  // A new profile has no state file; its first routine creation must initialize it safely.
  const api = spawn(process.execPath, ['server.js'], { cwd: path.join(root, 'api'), stdio: ['ignore', 'pipe', 'pipe'],
    env: { ...process.env, DATA_DIR: dir, PORT: '0', MCP_ENABLED: '1', ORIGIN: 'http://localhost:8080', RP_ID: 'localhost' } })
  let log = ''; api.stdout.on('data', d => log += d); api.stderr.on('data', d => log += d)
  const clients = []
  try {
    const url = `http://127.0.0.1:${await boundPort(api, () => log)}`
    const payload = `fixture:${Date.now() + 86400000}:0`
    const headers = { Cookie: `gymsid=${payload}.${crypto.createHmac('sha256', secret).update(payload).digest('base64url')}`, 'Content-Type': 'application/json' }
    const connect = async access => {
      const res = await fetch(url + '/api/account/mcp-tokens', { method: 'POST', headers, body: JSON.stringify({ name: 'Fixture', access }) })
      const token = await res.json()
      const env = { ...process.env, OPENGYM_URL: url, OPENGYM_TOKEN: token.token }
      delete env.OPENGYM_UID; delete env.OPENGYM_DATA
      const transport = new StdioClientTransport({ command: process.execPath, args: [path.join(root, 'mcp/src/index.js')], cwd: root, env, stderr: 'pipe' })
      const client = new Client({ name: 'fixture', version: '1' })
      clients.push(client)
      await client.connect(transport)
      return { client, token }
    }
    const { client } = await connect('write')
    const listed = await client.listTools()
    expect(listed.tools).toHaveLength(15)
    expect(listed.tools.find(t => t.name === 'log_workout').annotations.readOnlyHint).toBe(false)
    expect(listed.tools.find(t => t.name === 'list_routines').annotations.readOnlyHint).toBe(true)
    const call = async (name, args = {}) => {
      const result = await client.callTool({ name, arguments: args })
      expect(result.isError, `${name}: ${JSON.stringify(result.content)}`).not.toBe(true)
      return JSON.parse(result.content[0].text)
    }
    const day = new Date(Date.now() - 86400000).toISOString().slice(0, 10)
    await call('search_exercises', { query: 'leg press' })
    await call('edit_routine', { mode: 'create', request_id: 'e2e-routine', unit: 'kg', changes: { name: 'Fixture day', ex: [{ id: '0739', sets: 3, reps: 8, weight: 60 }] } })
    await call('edit_routine', { mode: 'update', routine_id: 'e2e-routine', changes: { name: 'Updated fixture' } })
    await call('assign_weekday', { weekday: new Date(day + 'T12:00:00').getDay(), routine_ids: ['e2e-routine'] })
    await call('override_day', { date: day, action: 'set', routine_id: 'e2e-routine' })
    await call('log_workout', { request_id: 'e2e-workout', date: day, started_at: day + 'T08:00:00Z', duration_minutes: 30,
      unit: 'kg', routine_ids: ['e2e-routine'], entries: [{ id: '0739', sets: [{ w: 60, r: 8, done: true }] }] })
    await call('add_bodyweight', { date: day, weight: 80, unit: 'kg' })
    for (const [name, args] of [['list_routines', {}], ['get_routine', { routine_id: 'e2e-routine' }],
      ['preview_session', { routine_id: 'e2e-routine', date: day }], ['get_week_plan', {}], ['list_workouts', {}],
      ['get_workout', { workout_id: 'e2e-workout' }], ['get_bodyweight', {}], ['estimate_1rm', {}], ['muscle_balance', { period: 'all' }]]) await call(name, args)
    const persisted = JSON.parse(fs.readFileSync(path.join(dir, 'state-fixture.json'), 'utf8'))
    expect(persisted.workouts).toHaveLength(1)
    expect(persisted.bodyweight[0].w).toBe(80)
    const readonly = await connect('read')
    expect((await readonly.client.listTools()).tools).toHaveLength(10)
    await fetch(url + '/api/account/mcp-tokens?id=' + readonly.token.id, { method: 'DELETE', headers })
    expect((await readonly.client.callTool({ name: 'list_routines', arguments: {} })).isError).toBe(true)
  } finally {
    await Promise.all(clients.map(c => c.close()))
    if (api.exitCode === null) { const stopped = once(api, 'exit'); api.kill(); await stopped }
    fs.rmSync(dir, { recursive: true, force: true })
  }
}, 30000)
