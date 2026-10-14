// Pure mutations used by the local MCP bridge. Persisting and retrying belong to the bridge.
import { allExercises, registerCustom } from './exercises.js'
import { buildCompletedWorkout } from './finish-workout.js'
import { completeBackfill, historyAsOf } from './backfill.js'
import { buildPlannedEntry } from './session-start.js'
import { rebuildPrHistory, MAX_DURATION_MIN } from './workout-date.js'
import { workoutVolume, defaultConfig, modeOf } from './history.js'
import { syncSideAggregate, hasCompletedWork } from './workout-model.js'
import { refillAfter } from './rotation.js'
import { stampChange, stampWorkout } from './sync-merge.js'
import { convertStateUnit, convertBodyWeight } from './units.js'
import { POLICIES } from './progression.js'
import { DEFAULT_GLYPH } from './glyph-default.js'
import { exerciseMuscleSnapshot } from './muscles.js'
import { INCLINE_MAX } from './incline.js'
import { PYRAMID_MAX, MAX_PYRAMID_SETS } from './pyramid.js'

const fail = message => { throw Object.assign(new Error(message), { code: 'INVALID_INPUT' }) }
const object = v => !!v && typeof v === 'object' && !Array.isArray(v)
const number = (v, min = 0, max = 100000) => typeof v === 'number' && Number.isFinite(v) && v >= min && v <= max
const text = (v, max = 2000) => typeof v === 'string' && v.length <= max
const id = v => text(v, 128) && /^[a-zA-Z0-9_-]+$/.test(v)
export const validMcpDate = v => typeof v === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(v) &&
  Number.isFinite(Date.parse(v + 'T12:00:00Z')) && new Date(v + 'T12:00:00Z').toISOString().slice(0, 10) === v
const unitOf = p => { if (!['kg', 'lb'].includes(p.unit)) fail('unit must be kg or lb'); return p.unit }
const keysOnly = (v, keys) => { if (!object(v) || Object.keys(v).some(k => !keys.includes(k))) fail('unsupported fields') }
const own = (S, exerciseId) => allExercises(S).find(e => e.id === exerciseId)
const routine = (S, rid) => (S.routines || []).find(r => r.id === rid)
const references = (S, ids) => {
  if (!Array.isArray(ids) || ids.length > 50 || new Set(ids).size !== ids.length || ids.some(rid => !routine(S, rid))) fail('routine_ids must name distinct saved routines')
}
function validateRow(row, mode, side = false) {
  keysOnly(row, ['w', 'r', 'sec', 'min', 'km', 'dist', 'speed', 'incline', 'side', 'rir', 'rpe', 'done', 'at', 'phase', 'warmup', 'type', 'failure', 'drops', 'clusters', 'sides', 'note'])
  if (row.note != null && !text(row.note)) fail('invalid set note')
  for (const k of ['w', 'r', 'sec', 'min', 'km', 'dist', 'speed', 'rir', 'rpe', 'at']) if (row[k] != null && !number(row[k], 0, k === 'at' ? Number.MAX_SAFE_INTEGER : 100000)) fail(`invalid set ${k}`)
  for (const k of ['done', 'warmup', 'failure']) if (row[k] != null && typeof row[k] !== 'boolean') fail(`invalid set ${k}`)
  if (row.phase != null && !['work', 'warmup'].includes(row.phase)) fail('invalid phase')
  if (row.type != null && !['straight', 'dropset', 'restpause'].includes(row.type)) fail('invalid set type')
  if (row.side != null && (mode !== 'time' || !['L', 'R'].includes(row.side))) fail('invalid timed side')
  if (row.incline != null && (mode !== 'cardio' || !number(row.incline, 0, INCLINE_MAX))) fail('invalid cardio incline')
  if (row.sides != null) {
    if (side || mode === 'cardio') fail('invalid per-side set')
    keysOnly(row.sides, ['L', 'R'])
    validateRow(row.sides.L, mode, true); validateRow(row.sides.R, mode, true)
  } else {
    if (typeof row.done !== 'boolean') fail('every actual set must say whether it was done')
    if (mode === 'reps' && (!Number.isInteger(row.r) || !number(row.r) || !number(row.w))) fail('rep sets require actual r and w')
    if (mode === 'time' && !number(row.sec)) fail('timed sets require actual sec')
    if (mode === 'cardio' && !number(row.min)) fail('cardio sets require actual min')
  }
  if (row.rir != null && !number(row.rir, 0, 10)) fail('rir must be 0–10')
  if (row.rpe != null && !number(row.rpe, 1, 10)) fail('rpe must be 1–10')
  for (const key of ['drops', 'clusters']) if (row[key] != null) {
    if (mode !== 'reps' || !Array.isArray(row[key]) || row[key].length > 100) fail('invalid intensifier')
    for (const extra of row[key]) {
      keysOnly(extra, key === 'drops' ? ['w', 'r'] : ['r', 'restSec'])
      if (!Number.isInteger(extra.r) || !number(extra.r) || (key === 'drops' && !number(extra.w))) fail('invalid intensifier set')
      if (extra.restSec != null && !number(extra.restSec, 0, 600)) fail('invalid rest-pause rest')
    }
  }
}
const CONFIG_KEYS = ['id', 'sg', 'sets', 'setsMax', 'reps', 'repsMin', 'repsMax', 'min', 'speed', 'sec', 'weight', 'mode', 'bodyweight', 'assisted', 'side', 'prog', 'inc', 'deloadFactor', 'note', 'warmupSets', 'warmup', 'warmupRestSec', 'restSec', 'intensifier', 'pyramid', 'pyramidRest', 'pyramidWeight', 'backoff', 'backoffPct', 'restPauseSec', 'repsTotal', 'drops', 'dropPct', 'clusters', 'dbLoad', 'lastToFailure']
function config(S, input) {
  keysOnly(input, CONFIG_KEYS)
  if (!own(S, input.id)) fail('unknown exercise id; use search_exercises')
  for (const k of ['sets', 'setsMax', 'reps', 'repsMin', 'repsMax', 'min', 'speed', 'sec', 'weight', 'inc', 'deloadFactor', 'warmupSets', 'warmupRestSec', 'restSec', 'backoffPct', 'restPauseSec', 'repsTotal', 'drops', 'dropPct', 'clusters']) {
    if (input[k] != null && !number(input[k])) fail(`invalid configuration ${k}`)
  }
  for (const k of ['sets', 'setsMax', 'reps', 'repsMin', 'repsMax', 'warmupSets']) if (input[k] != null && !Number.isInteger(input[k])) fail(`invalid configuration ${k}`)
  if (input.sets != null && !number(input.sets, 1, 200)) fail('sets must be 1–200')
  if (input.mode != null && !['reps', 'time', 'cardio'].includes(input.mode)) fail('invalid exercise mode')
  if (input.prog != null && !POLICIES.includes(input.prog)) fail('invalid progression policy')
  for (const k of ['bodyweight', 'assisted', 'side', 'backoff', 'lastToFailure']) if (input[k] != null && typeof input[k] !== 'boolean') fail(`invalid configuration ${k}`)
  for (const k of ['sg', 'note', 'dbLoad']) if (input[k] != null && !text(input[k])) fail(`invalid configuration ${k}`)
  if (input.dbLoad != null && !['as', 'each', 'total'].includes(input.dbLoad)) fail('invalid dumbbell load meaning')
  if (input.intensifier != null) {
    const i = input.intensifier
    keysOnly(i, ['type', 'count', 'pct', 'totalReps', 'restSec'])
    if (i.type === 'dropset') {
      if (!Number.isInteger(i.count) || !number(i.count, 1, 100) || !number(i.pct, 5, 95)) fail('invalid planned dropset')
    } else if (i.type === 'restpause') {
      if (!Number.isInteger(i.totalReps) || !number(i.totalReps, 1, 1000) || !number(i.restSec, 5, 600)) fail('invalid planned restpause')
    } else fail('invalid intensifier')
  }
  if (input.pyramid != null && (!Array.isArray(input.pyramid) || input.pyramid.length > MAX_PYRAMID_SETS || input.pyramid.some(v => v !== PYRAMID_MAX && (!Number.isInteger(v) || !number(v, 1))))) fail('invalid pyramid')
  for (const k of ['pyramidRest', 'pyramidWeight']) if (input[k] != null && (!Array.isArray(input[k]) || input[k].length > MAX_PYRAMID_SETS || input[k].some(v => !number(v)))) fail(`invalid ${k}`)
  if (input.warmup != null) {
    if (!Array.isArray(input.warmup) || input.warmup.length > 50) fail('invalid warmup')
    input.warmup.forEach(w => { keysOnly(w, ['weight', 'reps']); if (!number(w.weight) || !Number.isInteger(w.reps) || !number(w.reps)) fail('invalid warmup') })
  }
  return { id: input.id, ...defaultConfig(input.id, input.mode), ...structuredClone(input) }
}

// Only targeted fields form the race guard; a concurrent unrelated change can be rebased.
export function mcpMutationTarget(S, tool, p) {
  const common = { unit: S?.unit || 'kg', resetAt: S?.resetAt || 0 }
  if (!S) return { ...common, absent: true }
  if (tool === 'add_bodyweight') return { ...common, value: (S.bodyweight || []).find(b => b.d === p.date) || null }
  if (tool === 'assign_weekday') return { ...common, value: S.week?.[p.weekday] ?? null }
  if (tool === 'override_day') return { ...common, value: S.dayPlan?.[p.date] ?? null }
  if (tool === 'edit_routine') {
    const r = routine(S, p.mode === 'create' ? p.request_id : p.routine_id)
    return { ...common, value: r ? Object.fromEntries(Object.keys(p.changes || {}).map(k => [k, r[k] ?? null])) : null }
  }
  return { ...common, value: (S.workouts || []).find(w => w.id === p.request_id) || null }
}

export function applyMcpMutation(S, tool, p, now = Date.now()) {
  // The API returns null only for a profile with no saved document. Corrupt/unreadable files
  // fail at the API instead; a first MCP write can start the same empty kg profile as the app.
  if (S === null) S = { unit: 'kg', routines: [], workouts: [], bodyweight: [], customEx: [], exWeights: {}, week: {}, dayPlan: {} }
  if (!object(S)) throw Object.assign(new Error('invalid profile state'), { code: 'INVALID_STATE' })
  const next = structuredClone(S)
  let result
  let changed = true
  // Shared helpers inspect the exercise index synchronously. Never retain another profile's customs.
  registerCustom(S.customEx || [])
  try {
    if (tool === 'log_workout') {
      if (!id(p.request_id)) fail('request_id must be a stable filename-safe id')
      const existing = (S.workouts || []).find(w => w.id === p.request_id)
      if (existing) return { state: S, changed: false, result: { workout_id: existing.id, replayed: true } }
      unitOf(p)
      if (!validMcpDate(p.date) || !text(p.started_at) || !/^\d{4}-\d{2}-\d{2}T(?:[01]\d|2[0-3]):[0-5]\d:[0-5]\d(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/.test(p.started_at) || !validMcpDate(p.started_at.slice(0, 10)) || p.started_at.slice(0, 10) !== p.date) fail('date and started_at must name the same valid day with a timezone offset')
      const start = Date.parse(p.started_at)
      if (!number(p.duration_minutes, 1, MAX_DURATION_MIN) || !Number.isFinite(start) || start + p.duration_minutes * 60000 > now) fail('invalid duration or workout ending in the future')
      const ids = p.routine_ids || []
      references(S, ids)
      const past = historyAsOf(S, { d: p.date, start })
      if (!Array.isArray(p.entries) || !p.entries.length || p.entries.length > 200) fail('actual entries required')
      const entries = p.entries.map(e => {
        keysOnly(e, ['id', 'sets', 'mode', 'rid', 'noProg', 'sg', 'note', 'notePin'])
        const ex = own(S, e.id)
        if (!ex) fail('unknown exercise id; use search_exercises')
        if (e.rid && (!ids.includes(e.rid) || !routine(S, e.rid).ex?.some(cfg => cfg.id === e.id))) fail('entry rid must name a referenced routine containing this exercise')
        const source = e.rid ? routine(S, e.rid) : ids.length === 1 ? routine(S, ids[0]) : null
        const slot = source?.ex?.find(cfg => cfg.id === e.id)
        const m = e.mode || modeOf(slot || { id: e.id })
        if (!['reps', 'time', 'cardio'].includes(m)) fail('invalid exercise mode')
        if (!Array.isArray(e.sets) || !e.sets.length || e.sets.length > 200) fail('actual sets required')
        const rawSets = e.sets.map(row => { validateRow(row, m); return syncSideAggregate(structuredClone(row)) })
        const sets = convertStateUnit({ unit: p.unit, workouts: [{ entries: [{ id: e.id, sets: rawSets }] }] }, S.unit || 'kg').workouts[0].entries[0].sets
        for (const k of ['note', 'sg']) if (e[k] != null && !text(e[k])) fail(`invalid entry ${k}`)
        for (const k of ['noProg', 'notePin']) if (e[k] != null && typeof e[k] !== 'boolean') fail(`invalid entry ${k}`)
        const { mode: _, ...kept } = e
        const noProg = e.noProg ?? source?.excludeFromProgression === true
        const planned = slot ? buildPlannedEntry(past, { ...slot, mode: m }, source, { noProg }) : null
        return { ...planned, ...kept, sets, target: { ...(planned?.target || { id: e.id }), mode: m }, ...(source ? { rid: source.id } : {}), ...(noProg ? { noProg: true } : {}) }
      })
      if (!entries.some(e => e.sets.some(hasCompletedWork))) fail('at least one completed set required')
      if (p.name != null && !text(p.name, 200)) fail('invalid workout name')
      if (p.note != null && !text(p.note)) fail('invalid workout note')
      if (p.bodyweight != null && !number(p.bodyweight, 0.1, 1000)) fail('invalid body weight')
      const raw = { id: p.request_id, d: p.date, start, name: p.name || ids.map(rid => routine(S, rid).name).join(' + ') || 'Workout',
        routineIds: ids, entries, bw: p.bodyweight == null ? null : convertBodyWeight(p.bodyweight, p.unit, S.unit || 'kg'), note: p.note || '', backfill: { durationMin: p.duration_minutes } }
      const active = raw
      const w = buildCompletedWorkout(active, { end: start + p.duration_minutes * 60000,
        snapshotFor: e => { const ex = (S.customEx || []).find(ex => ex.id === e.id); return ex ? exerciseMuscleSnapshot(ex) : null } })
      w.vol = workoutVolume(w)
      stampWorkout(w, now)
      next.workouts = rebuildPrHistory(completeBackfill(S.workouts || [], active, w, now), entries.map(e => e.id), w)
      const today = new Date(now)
      refillAfter(next, w, `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, '0')}-${String(today.getDate()).padStart(2, '0')}`, now)
      result = { workout_id: w.id, date: w.d, volume: w.vol, unit: S.unit || 'kg', replayed: false }
    } else if (tool === 'add_bodyweight') {
      unitOf(p)
      if (!validMcpDate(p.date) || !number(p.weight, 0.1, 1000)) fail('valid date and positive weight required')
      const w = convertBodyWeight(p.weight, p.unit, S.unit || 'kg')
      const old = (S.bodyweight || []).find(b => b.d === p.date)
      changed = old?.w !== w
      next.bodyweight = [...(S.bodyweight || []).filter(b => b.d !== p.date), { ...old, d: p.date, w, t: now }].sort((a, b) => a.d.localeCompare(b.d))
      result = { date: p.date, weight: w, unit: S.unit || 'kg', replaced: !!old }
    } else if (tool === 'edit_routine') {
      if (!['create', 'update'].includes(p.mode)) fail('mode must be create or update')
      const rid = p.mode === 'create' ? p.request_id : p.routine_id
      if (p.mode === 'create' && !id(rid)) fail('request_id required for creation')
      const old = routine(S, rid)
      if (p.mode === 'create' && old) return { state: S, changed: false, result: { routine_id: rid, replayed: true } }
      if (p.mode === 'update' && !old) fail('routine not found')
      const c = p.changes
      keysOnly(c, ['name', 'emoji', 'prog', 'excludeFromProgression', 'ex'])
      if (!Object.keys(c).length || (p.mode === 'create' && (!c.name || !Array.isArray(c.ex)))) fail('creation requires name and ex; updates require changes')
      if (c.name != null && (!text(c.name, 200) || !c.name.trim())) fail('routine name required')
      if (c.emoji != null && !text(c.emoji, 80)) fail('invalid routine icon')
      if (c.prog != null && !POLICIES.includes(c.prog)) fail('invalid progression policy')
      if (c.excludeFromProgression != null && typeof c.excludeFromProgression !== 'boolean') fail('invalid progression exclusion')
      let ex
      if (Object.hasOwn(c, 'ex')) {
        unitOf(p)
        if (!Array.isArray(c.ex) || c.ex.length > 200) fail('invalid exercise list')
        ex = convertStateUnit({ unit: p.unit, routines: [{ ex: c.ex.map(e => config(S, e)) }] }, S.unit || 'kg').routines[0].ex
      }
      const updated = { ...(old || { id: rid, emoji: DEFAULT_GLYPH }), ...structuredClone(c), ...(ex ? { ex } : {}) }
      changed = JSON.stringify(old) !== JSON.stringify(updated)
      next.routines = old ? S.routines.map(r => r.id === rid ? updated : r) : [...(S.routines || []), updated]
      result = { routine_id: rid, replayed: false }
    } else if (tool === 'assign_weekday') {
      if (!Number.isInteger(p.weekday) || p.weekday < 0 || p.weekday > 6) fail('weekday must be 0 (Sunday) through 6')
      references(S, p.routine_ids)
      next.week = { ...S.week }
      if (p.routine_ids.length) next.week[p.weekday] = [...p.routine_ids]; else delete next.week[p.weekday]
      changed = JSON.stringify(S.week?.[p.weekday] || []) !== JSON.stringify(p.routine_ids)
      result = { weekday: p.weekday, routine_ids: p.routine_ids }
    } else if (tool === 'override_day') {
      if (!validMcpDate(p.date) || !['set', 'rest', 'clear'].includes(p.action)) fail('valid date and set/rest/clear action required')
      if (p.action === 'set' && !routine(S, p.routine_id)) fail('routine not found')
      next.dayPlan = { ...S.dayPlan }
      if (p.action === 'clear') delete next.dayPlan[p.date]
      else next.dayPlan[p.date] = p.action === 'rest' ? 'rest' : p.routine_id
      changed = S.dayPlan?.[p.date] !== next.dayPlan[p.date]
      result = { date: p.date, action: p.action, routine_id: p.action === 'set' ? p.routine_id : null }
    } else fail('unknown write tool')
    if (!changed) return { state: S, changed: false, result }
    stampChange(S, next, now)
    return { state: next, changed: true, result }
  } finally { registerCustom([]) }
}
