import { describe, test, expect } from 'vitest'
import { applyMcpMutation, mcpMutationTarget, validMcpDate } from './mcp-mutations.js'
import { EXDB } from './exercises.js'
import { modeOf, workoutVolume } from './history.js'
import { effectiveRoutineIds } from './history.js'

const ex = EXDB.find(e => modeOf({ id: e.id }) === 'reps')
const now = Date.parse('2026-10-14T12:00:00Z')
const fresh = () => ({ unit: 'kg', customEx: [], routines: [{ id: 'r1', name: 'Day', ex: [{ id: ex.id, sets: 3, reps: 8, weight: 60 }] }],
  workouts: [], exWeights: { [ex.id]: { w: 100, d: '2026-10-14' } }, bodyweight: [], week: {}, dayPlan: {} })
const log = overrides => ({ request_id: 'w1', date: '2026-10-01', started_at: '2026-10-01T18:00:00+05:30', duration_minutes: 60,
  unit: 'kg', routine_ids: ['r1'], entries: [{ id: ex.id, sets: [{ w: 60, r: 8, done: true }] }], ...overrides })

describe('MCP pure mutations', () => {
  test('historical logging derives volume and PRs, preserves confirmed weights, and replays', () => {
    const s = fresh(), before = structuredClone(s)
    const out = applyMcpMutation(s, 'log_workout', log(), now)
    expect(s).toEqual(before)
    expect(out.state.exWeights).toEqual(s.exWeights)
    const w = out.state.workouts[0]
    expect(w.vol).toBe(workoutVolume(w))
    expect(w.prs).toContain(ex.id)
    expect(w.end - w.start).toBe(3600000)
    expect(applyMcpMutation(out.state, 'log_workout', log(), now).changed).toBe(false)
  })
  test('backfills are chronological and revoke later false PR badges', () => {
    const s = fresh()
    s.workouts = [{ id: 'later', d: '2026-10-10', start: 100, prs: [ex.id], entries: [{ id: ex.id, sets: [{ w: 40, r: 8, done: true }] }] }]
    const out = applyMcpMutation(s, 'log_workout', log(), now)
    expect(out.state.workouts.map(w => w.id)).toEqual(['w1', 'later'])
    expect(out.state.workouts[1].prs).toEqual([])
  })
  test('weigh-ins replace one date, convert units and skip identical values', () => {
    const first = applyMcpMutation(fresh(), 'add_bodyweight', { date: '2026-10-01', weight: 176.4, unit: 'lb' }, now)
    expect(first.state.bodyweight[0].w).toBe(80)
    const second = applyMcpMutation(first.state, 'add_bodyweight', { date: '2026-10-01', weight: 81, unit: 'kg' }, now + 1)
    expect(second.state.bodyweight).toHaveLength(1)
    expect(second.result.replaced).toBe(true)
    expect(applyMcpMutation(second.state, 'add_bodyweight', { date: '2026-10-01', weight: 81, unit: 'kg' }, now).changed).toBe(false)
  })
  test('logging converts actual loads while retaining the profile-unit prescription', () => {
    const out = applyMcpMutation(fresh(), 'log_workout', log({ unit: 'lb', entries: [{ id: ex.id, sets: [{ w: 132.3, r: 8, done: true }] }] }), now)
    const entry = out.state.workouts[0].entries[0]
    expect(entry.sets[0].w).toBe(60)
    expect(entry.target.weight).toBe(60)
    expect(entry.target.reps).toBe(8)
    expect(entry.planned.weight).toBe(60)
  })
  test('create/update routines preserve omitted fields and convert exercise loads', () => {
    const p = { mode: 'create', request_id: 'r2', unit: 'lb', changes: { name: 'New', ex: [{ id: ex.id, weight: 132.3 }] } }
    const created = applyMcpMutation(fresh(), 'edit_routine', p, now)
    expect(created.state.routines[1].ex[0].weight).toBe(60)
    expect(applyMcpMutation(created.state, 'edit_routine', p, now).changed).toBe(false)
    const edited = applyMcpMutation(created.state, 'edit_routine', { mode: 'update', routine_id: 'r2', changes: { name: 'Renamed' } }, now)
    expect(edited.state.routines[1].ex).toEqual(created.state.routines[1].ex)
  })
  test('weekday ordering and rest/set/clear overrides reuse schedule precedence', () => {
    let s = applyMcpMutation(fresh(), 'assign_weekday', { weekday: 4, routine_ids: ['r1'] }, now).state
    expect(effectiveRoutineIds(s, '2026-10-01')).toEqual(['r1'])
    s = applyMcpMutation(s, 'override_day', { date: '2026-10-01', action: 'rest' }, now).state
    expect(effectiveRoutineIds(s, '2026-10-01')).toEqual([])
    s = applyMcpMutation(s, 'override_day', { date: '2026-10-01', action: 'clear' }, now).state
    expect(effectiveRoutineIds(s, '2026-10-01')).toEqual(['r1'])
    expect(applyMcpMutation(s, 'assign_weekday', { weekday: 4, routine_ids: [] }, now).state.week[4]).toBeUndefined()
  })
  test('per-side, drop and rest-pause rows retain actual work', () => {
    const sets = [{ sides: { L: { w: 20, r: 8, done: true, type: 'dropset', drops: [{ w: 15, r: 4 }] }, R: { w: 20, r: 7, done: false } } },
      { w: 25, r: 8, done: true, type: 'restpause', clusters: [{ r: 3 }] }]
    const out = applyMcpMutation(fresh(), 'log_workout', log({ entries: [{ id: ex.id, sets }] }), now)
    expect(out.state.workouts[0].entries[0].sets[0].r).toBe(15)
    expect(out.state.workouts[0].entries[0].sets[0].sides.L.drops[0].w).toBe(15)
  })
  test('custom muscle snapshots survive logging and malformed input is refused', () => {
    const s = fresh(); s.customEx = [{ id: 'custom', n: 'Custom lift', bp: 'chest', muscleWeights: { chest: 1 } }]
    const out = applyMcpMutation(s, 'log_workout', log({ entries: [{ id: 'custom', sets: [{ w: 10, r: 8, done: true }] }] }), now)
    expect(out.state.workouts[0].entries[0].muscleSnapshot.n).toBe('Custom lift')
    expect(validMcpDate('2026-02-30')).toBe(false)
    for (const patch of [{ unit: undefined }, { date: '2026-02-30' }, { started_at: '2026-10-01T18:00:00' }, { entries: [{ id: 'missing', sets: [] }] }, { duration_minutes: 1500 }]) expect(() => applyMcpMutation(s, 'log_workout', log(patch), now)).toThrow()
    expect(() => applyMcpMutation([], 'add_bodyweight', {})).toThrow(/invalid profile state/)
  })
  test('a missing document starts an empty profile on its first write', () => {
    const out = applyMcpMutation(null, 'add_bodyweight', { date: '2026-10-01', weight: 176.4, unit: 'lb' }, now)
    expect(out.state.unit).toBe('kg')
    expect(out.state.bodyweight).toEqual([{ d: '2026-10-01', w: 80, t: now }])
    expect(out.state.workouts).toEqual([])
    expect(out.state.routines).toEqual([])
    expect(out.changed).toBe(true)
  })
  test('timed holds and cardio preserve their actual units and derive completion fields', () => {
    const out = applyMcpMutation(fresh(), 'log_workout', log({ routine_ids: [], entries: [
      { id: ex.id, mode: 'time', sets: [{ sec: 45, w: 10, side: 'L', done: true }] },
      { id: ex.id, mode: 'cardio', sets: [{ min: 20, speed: 8, incline: 12, done: true }] }
    ] }), now)
    const w = out.state.workouts[0]
    expect(w.entries[0].target.mode).toBe('time')
    expect(w.entries[0].sets[0].sec).toBe(45)
    expect(w.entries[0].sets[0].side).toBe('L')
    expect(w.entries[1].target.mode).toBe('cardio')
    expect(w.entries[1].sets[0].min).toBe(20)
    expect(w.entries[1].sets[0].speed).toBe(8)
    expect(w.entries[1].sets[0].incline).toBe(12)
    expect(w.vol).toBe(workoutVolume(w))
  })
  test('routine configurations retain pyramid Max, rest, failure and intensifier formats', () => {
    const configs = [
      { id: ex.id, pyramid: [12, 8, 'max'], pyramidWeight: [30, 35, 40], pyramidRest: [60, 90, 120], warmupRestSec: 30, dbLoad: 'each' },
      { id: ex.id, lastToFailure: true, backoff: true, intensifier: { type: 'dropset', count: 2, pct: 20 } },
      { id: ex.id, intensifier: { type: 'restpause', totalReps: 25, restSec: 15 } }
    ]
    const out = applyMcpMutation(fresh(), 'edit_routine', { mode: 'create', request_id: 'formats', unit: 'kg', changes: { name: 'Formats', ex: configs } }, now)
    configs.forEach((cfg, i) => expect(out.state.routines[1].ex[i]).toMatchObject(cfg))
  })
  test('logging a referenced timed routine uses its saved mode when the entry omits it', () => {
    const s = fresh(); s.routines[0].ex[0] = { id: ex.id, mode: 'time', sets: 2, sec: 45 }
    const out = applyMcpMutation(s, 'log_workout', log({ entries: [{ id: ex.id, sets: [{ sec: 50, done: true }] }] }), now)
    expect(out.state.workouts[0].entries[0].target.mode).toBe('time')
    expect(out.state.workouts[0].entries[0].sets[0].sec).toBe(50)
  })
  test('race guards exclude unrelated settings but include targeted fields and resets', () => {
    const s = fresh(), p = { mode: 'update', routine_id: 'r1', changes: { name: 'New' } }
    expect(mcpMutationTarget(s, 'edit_routine', p)).toEqual(mcpMutationTarget({ ...s, targetW: 80 }, 'edit_routine', p))
    expect(mcpMutationTarget(s, 'edit_routine', p)).not.toEqual(mcpMutationTarget({ ...s, resetAt: 1 }, 'edit_routine', p))
  })
})
