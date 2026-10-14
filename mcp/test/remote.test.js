import { test, expect, vi } from 'vitest'
import { createRemoteClient } from '../src/remote.js'
import { withRemoteState, getState, getUser } from '../src/state.js'
import { searchTool, WRITE_TOOLS } from '../src/write-tools.js'
import { TOOLS } from '../src/tools.js'

const env = { OPENGYM_URL: 'https://gym.example/prefix', OPENGYM_TOKEN: 'secret-for-test' }
const initial = () => ({ user: { id: 'one', name: 'One' }, scopes: ['read', 'write'], rev: 1,
  state: { unit: 'kg', _rev: 1, _wid: 'initial', workouts: [], routines: [], bodyweight: [], week: {}, dayPlan: {} } })
const reply = (status, body) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } })
const input = { date: '2026-10-01', weight: 80, unit: 'kg' }

test('remote config rejects incomplete, mixed, insecure and credential-bearing URLs', () => {
  expect(createRemoteClient({})).toBe(null)
  for (const e of [{ OPENGYM_URL: env.OPENGYM_URL }, { ...env, OPENGYM_UID: 'other' }, { ...env, OPENGYM_DATA: 'data' },
    { ...env, OPENGYM_URL: 'http://gym.example' }, { ...env, OPENGYM_URL: 'https://name:password@gym.example' }, { ...env, OPENGYM_URL: env.OPENGYM_URL + '?token=x' }]) expect(() => createRemoteClient(e)).toThrow()
})
test('each call reads fresh data, preserves prefix, and refuses redirects', async () => {
  const fetch = vi.fn(async (url, options) => {
    expect(url).toBe('https://gym.example/prefix/api/mcp/data')
    expect(options.redirect).toBe('error')
    expect(options.headers.Authorization).toBe('Bearer secret-for-test')
    return reply(200, initial())
  })
  const client = createRemoteClient(env, fetch)
  await client.snapshot(); await client.snapshot()
  expect(fetch).toHaveBeenCalledTimes(2)
})
test('unrelated web changes are rebased, and PUT always carries revision and write id', async () => {
  let state = initial(), writes = 0
  const client = createRemoteClient(env, async (_, options) => {
    if (options.method === 'GET') return reply(200, state)
    const body = JSON.parse(options.body)
    if (++writes === 1) {
      state = { ...state, rev: 2, state: { ...state.state, _wid: 'web', targetW: 75 } }
      return reply(409, { error: 'conflict' })
    }
    expect(body.baseRev).toBe(2); expect(body.baseWid).toBe('web')
    expect(body.state.targetW).toBe(75)
    return reply(200, { ok: true, rev: 3, wid: 'saved' })
  })
  expect((await client.mutate('add_bodyweight', input)).rev).toBe(3)
  expect(writes).toBe(2)
})
test('concurrent changes to the same field and reset are refused', async () => {
  for (const patch of [{ bodyweight: [{ d: input.date, w: 70, t: 1 }] }, { resetAt: 1 }]) {
    let state = initial(), puts = 0
    const client = createRemoteClient(env, async (_, options) => {
      if (options.method === 'GET') return reply(200, state)
      puts++; state = { ...state, rev: 2, state: { ...state.state, ...patch } }
      return reply(409, { error: 'conflict' })
    })
    await expect(client.mutate('add_bodyweight', input)).rejects.toMatchObject({ code: 'CONFLICT' })
    expect(puts).toBe(1)
  }
})
test('lost successful responses are reconciled without a second write', async () => {
  let state = initial(), puts = 0
  const client = createRemoteClient(env, async (_, options) => {
    if (options.method === 'GET') return reply(200, state)
    puts++; state = { ...state, rev: 2, state: JSON.parse(options.body).state }
    throw new Error('connection closed')
  })
  expect((await client.mutate('add_bodyweight', input)).rev).toBe(2)
  expect(puts).toBe(1)
})
test('conflict retries stop after three writes; read tokens cannot write', async () => {
  let puts = 0
  const client = createRemoteClient(env, async (_, options) => {
    if (options.method === 'GET') return reply(200, initial())
    puts++; return reply(409, { error: 'conflict' })
  })
  await expect(client.mutate('add_bodyweight', input)).rejects.toMatchObject({ code: 'CONFLICT' })
  expect(puts).toBe(3)
  const read = createRemoteClient(env, async () => reply(200, { ...initial(), scopes: ['read'] }))
  await expect(read.mutate('add_bodyweight', input)).rejects.toMatchObject({ code: 'FORBIDDEN' })
})
test('request-scoped snapshots survive concurrent awaits without profile crossover', async () => {
  const a = initial(), b = { ...initial(), user: { id: 'two', name: 'Two' }, state: { unit: 'lb' } }
  const found = await Promise.all([a, b].map(s => withRemoteState(s, async () => {
    await Promise.resolve()
    return [getUser().id, getState().unit]
  })))
  expect(found).toEqual([['one', 'kg'], ['two', 'lb']])
})

test('a signed-in remote profile without a document reads as empty history', () => {
  const snapshot = { ...initial(), state: null, rev: 0 }
  const routines = withRemoteState(snapshot, () => TOOLS.find(t => t.name === 'list_routines').handler({}))
  expect(routines.routines).toEqual([])
  expect(withRemoteState(snapshot, () => getState().unit)).toBe('kg')
})
test('search returns built-in/custom IDs and never custom media', () => {
  const s = initial(); s.state.customEx = [{ id: 'custom', n: 'Unique custom curl', custom: true, bp: 'arms', eq: 'dumbbell', url: 'secret-media' }]
  const result = withRemoteState(s, () => searchTool.handler({ query: 'Unique custom curl' }))
  expect(result.exercises[0].id).toBe('custom')
  expect(JSON.stringify(result)).not.toContain('secret-media')
  expect(WRITE_TOOLS.map(t => t.name)).toEqual(['log_workout', 'add_bodyweight', 'edit_routine', 'assign_weekday', 'override_day'])
})
