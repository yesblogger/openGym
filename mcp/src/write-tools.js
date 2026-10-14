import { z } from 'zod'
import { getState } from './state.js'
import { allExercises, searchExercises } from '../../frontend/src/lib/exercises.js'
import { validMcpDate } from '../../frontend/src/lib/mcp-mutations.js'

const date = () => z.string().refine(validMcpDate, 'valid YYYY-MM-DD required')
const unit = () => z.enum(['kg', 'lb'])
const identifier = () => z.string().min(1).max(128)
const requestId = () => identifier().regex(/^[a-zA-Z0-9_-]+$/)
const row = z.object({
  w: z.number().nonnegative().optional(), r: z.number().int().nonnegative().optional(),
  sec: z.number().nonnegative().optional(), min: z.number().nonnegative().optional(),
  km: z.number().nonnegative().optional(), dist: z.number().nonnegative().optional(), speed: z.number().nonnegative().optional(),
  incline: z.number().min(0).max(40).optional(), side: z.enum(['L', 'R']).optional(),
  done: z.boolean(), rir: z.number().min(0).max(10).optional(), rpe: z.number().min(1).max(10).optional(),
  phase: z.enum(['work', 'warmup']).optional(), warmup: z.boolean().optional(), failure: z.boolean().optional(),
  type: z.enum(['straight', 'dropset', 'restpause']).optional(),
  drops: z.array(z.object({ w: z.number().nonnegative(), r: z.number().int().nonnegative() }).strict()).max(100).optional(),
  clusters: z.array(z.object({ r: z.number().int().nonnegative(), restSec: z.number().min(0).max(600).optional() }).strict()).max(100).optional(),
  at: z.number().nonnegative().optional(), note: z.string().max(2000).optional()
}).strict()
const set = row.partial({ done: true }).extend({ sides: z.object({ L: row, R: row }).strict().optional() }).strict()
const exerciseConfig = z.object({ id: identifier() }).catchall(z.unknown())

export const searchTool = {
  name: 'search_exercises',
  description: 'Find exercise IDs for creating routines or logging workouts. Searches the built-in catalogue and this profile’s custom exercises. Returns metadata, never media URLs.',
  schema: { query: z.string().max(200), limit: z.number().int().min(1).max(100).optional() },
  handler: ({ query, limit = 25 }) => {
    const list = allExercises(getState() || { customEx: [] })
    return { exercises: searchExercises(list, query).slice(0, limit).map(e => ({ id: e.id, name: e.n, equipment: e.eq || null, body_part: e.bp || null, muscle: e.t || null, secondary_muscles: e.s || [], custom: !!e.custom })) }
  }
}

export const WRITE_TOOLS = [
  {
    name: 'log_workout', description: 'Log actual completed workout history, like “Log a past workout”. Preserves confirmed working weights. Reuse request_id when retrying: an existing ID is returned without another workout. Set rows use w/r, sec, or min; sides, drops and clusters use the existing OpenGym formats.',
    schema: { request_id: requestId(), date: date(), started_at: z.string(), duration_minutes: z.number().min(1).max(1440), unit: unit(),
      name: z.string().max(200).optional(), note: z.string().max(2000).optional(), bodyweight: z.number().positive().optional(), routine_ids: z.array(identifier()).max(50).optional(),
      entries: z.array(z.object({ id: identifier(), mode: z.enum(['reps', 'time', 'cardio']).optional(), rid: identifier().optional(),
        noProg: z.boolean().optional(), sg: z.string().optional(), note: z.string().max(2000).optional(), notePin: z.boolean().optional(), sets: z.array(set).min(1).max(200) }).strict()).min(1).max(200) }
  },
  { name: 'add_bodyweight', description: 'Save one weigh-in for a date, replacing that date’s existing value. Converts the explicit input unit to the profile unit.',
    schema: { date: date(), weight: z.number().positive().max(1000), unit: unit() } },
  { name: 'edit_routine', description: 'Create or update a routine. Create requires request_id, changes.name and changes.ex; update requires routine_id. Omitted fields stay unchanged; ex replaces the exercise list. Supply unit whenever ex is supplied. Exercise configurations use OpenGym keys such as sets, reps, weight, restSec and prog.',
    schema: { mode: z.enum(['create', 'update']), request_id: requestId().optional(), routine_id: identifier().optional(), unit: unit().optional(),
      changes: z.object({ name: z.string().min(1).max(200).optional(), emoji: z.string().max(80).optional(), prog: z.enum(['off', 'linear', 'greyskull', 'double', 'triple', 'time']).optional(), excludeFromProgression: z.boolean().optional(), ex: z.array(exerciseConfig).max(200).optional() }).strict() } },
  { name: 'assign_weekday', description: 'Assign an ordered list of saved routines to weekday 0 (Sunday) through 6 (Saturday). An empty list clears the assignment.',
    schema: { weekday: z.number().int().min(0).max(6), routine_ids: z.array(identifier()).max(50) } },
  { name: 'override_day', description: 'Set a date to a saved routine, make it a rest day, or clear the override so the existing queue/weekday rules apply. set requires routine_id.',
    schema: { date: date(), action: z.enum(['set', 'rest', 'clear']), routine_id: identifier().optional() } }
]
