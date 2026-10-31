// Timing as plain numbers: estimates, the breathing rhythm, break scheduling and the breathing bar.
// No words here; text.ts turns these into strings in the chosen language.

import type { Plan, RestKind } from '../types'

export const SECOND = 1000
export const MINUTE = 60 * SECOND

export const wholeMinutes = (ms: number) => Math.max(1, Math.round(ms / MINUTE))

// With no step done, trust the model's estimate; the more steps are done, the more the actual pace counts.
export const estimateFinish = (p: Plan, now: number): number | undefined => {
  if (p.done >= p.total) return now

  const byGuess = p.guessAt !== undefined && p.guessMs !== undefined ? p.guessAt + p.guessMs : undefined
  if (p.done === 0) return byGuess

  const byPace = now + ((now - p.startedAt) / p.done) * (p.total - p.done)
  if (byGuess === undefined) return Math.round(byPace)

  const weight = p.done / p.total
  return Math.round(weight * byPace + (1 - weight) * Math.max(byGuess, now))
}

// Up to eight steps are drawn as cells, which the eye counts at a glance; more are written as numbers.
const MAX_STEP_CELLS = 8

export const describeSteps = (done: number, total: number) =>
  total <= MAX_STEP_CELLS ? '▰'.repeat(done) + '▱'.repeat(total - done) : `${done}/${total}`

// A clock time is added only when this much or more is left; short work shows minutes alone.
const CLOCK_FROM_MS = 10 * MINUTE

// What the task row says about time, after the ECAM "dark cockpit": quiet while all is well.
// - estimate: once, at the start, so you can decide to wait or step away (with a clock time for long work)
// - quiet: on time, so only the step cells
// - late: over the estimate, so it says by how much
export type Eta =
  | { kind: 'quiet' }
  | { kind: 'late'; minutes: number }
  | { kind: 'estimate'; minutes: number; finishAt?: number }

export const etaOf = (p: Plan, now: number): Eta => {
  if (p.finishAt === undefined) return { kind: 'quiet' }

  const left = p.finishAt - now
  if (left < -MINUTE / 2) return { kind: 'late', minutes: wholeMinutes(-left) }
  if (p.done > 0 || left < MINUTE) return { kind: 'quiet' }

  return { kind: 'estimate', minutes: wholeMinutes(left), finishAt: left >= CLOCK_FROM_MS ? p.finishAt : undefined }
}

export const isLate = (p: Plan, now: number) => etaOf(p, now).kind === 'late'

// How far off the model's estimate was: actual / estimate, held to 0.2–5.
export const ratioOf = (actualMs: number, guessMs: number) => Math.min(5, Math.max(0.2, actualMs / guessMs))

// Scale the next estimate by the median of past ratios; fewer than 3 ratios leave it as is.
export const factorOf = (ratios: readonly number[]) => {
  if (ratios.length < 3) return 1
  const sorted = [...ratios].sort((a, b) => a - b)
  const mid = Math.floor(sorted.length / 2)
  const median = sorted.length % 2 === 1 ? sorted[mid] ?? 1 : ((sorted[mid - 1] ?? 1) + (sorted[mid] ?? 1)) / 2
  return Math.min(4, Math.max(0.5, median))
}

export const isDue = (now: number, lastAt: number | undefined, intervalMin: number) =>
  lastAt === undefined || now - lastAt >= intervalMin * MINUTE

// Resonant breathing: in 5.5 s, out 5.5 s, about 5.5 breaths a minute. Five breaths, just under a minute.
// A 1.5 s lead-in to find the line, and a 2.5 s "done" at the end so the line does not vanish abruptly.
export const INTRO_MS = 1500
export const INHALE_MS = 5500
export const EXHALE_MS = 5500
export const OUTRO_MS = 2500
export const CYCLE_MS = INHALE_MS + EXHALE_MS
export const CYCLES = 5
export const PRACTICE_MS = CYCLE_MS * CYCLES
// How long the breathing band stays on screen in all
export const BREATH_MS = INTRO_MS + PRACTICE_MS + OUTRO_MS

export type RestStep = 'intro' | 'inhale' | 'exhale' | 'look' | 'pushups' | 'done'

export type RestPhase = {
  stage: 'intro' | 'active' | 'done'
  step: RestStep
  // Whole seconds left in this step
  seconds: number
  // How long the line is, 0–1: how full the lungs are while breathing, time left in a countdown
  fill: number
  cycle: number
}

const smooth = (x: number) => (1 - Math.cos(Math.PI * Math.min(1, Math.max(0, x)))) / 2

export const breathAt = (ms: number): RestPhase => {
  if (ms < INTRO_MS) return { stage: 'intro', step: 'intro', seconds: 0, fill: 0, cycle: 1 }
  if (ms >= INTRO_MS + PRACTICE_MS) return { stage: 'done', step: 'done', seconds: 0, fill: 0, cycle: CYCLES }

  const t = ms - INTRO_MS
  const cycle = Math.floor(t / CYCLE_MS) + 1
  const inCycle = t % CYCLE_MS

  if (inCycle < INHALE_MS) {
    const seconds = Math.ceil((INHALE_MS - inCycle) / SECOND)
    return { stage: 'active', step: 'inhale', seconds, fill: smooth(inCycle / INHALE_MS), cycle }
  }

  const out = inCycle - INHALE_MS
  const seconds = Math.ceil((EXHALE_MS - out) / SECOND)
  return { stage: 'active', step: 'exhale', seconds, fill: 1 - smooth(out / EXHALE_MS), cycle }
}

// The other two breaks: eyes by the 20-20-20 rule (every 20 minutes, look 20 ft / 6 m away for 20 seconds),
// and 10 push-ups. Both are a line shrinking from both ends toward the middle, then the same 2.5 s "done".
export const EYES_HOLD_MS = 20 * SECOND
export const PUSHUPS_HOLD_MS = 60 * SECOND
export const PUSHUPS = 10

export const REST = {
  breath: { command: 'breathe', defaultMin: 30, ms: BREATH_MS },
  eyes: { command: 'eyes', defaultMin: 20, ms: EYES_HOLD_MS + OUTRO_MS },
  pushups: { command: 'pushups', defaultMin: 60, ms: PUSHUPS_HOLD_MS + OUTRO_MS },
} as const satisfies Record<RestKind, { command: string; defaultMin: number; ms: number }>

export const REST_KINDS = Object.keys(REST) as RestKind[]

const countdownAt = (ms: number, holdMs: number, step: 'look' | 'pushups'): RestPhase => {
  if (ms >= holdMs) return { stage: 'done', step: 'done', seconds: 0, fill: 0, cycle: 1 }
  const t = Math.max(0, ms)
  return { stage: 'active', step, seconds: Math.ceil((holdMs - t) / SECOND), fill: 1 - t / holdMs, cycle: 1 }
}

export const restAt = (kind: RestKind, ms: number): RestPhase => {
  if (kind === 'eyes') return countdownAt(ms, EYES_HOLD_MS, 'look')
  if (kind === 'pushups') return countdownAt(ms, PUSHUPS_HOLD_MS, 'pushups')
  return breathAt(ms)
}

// At least this long between two breaks, so reminders never come back to back.
export const REST_GAP_MS = 5 * MINUTE

// Which break now: none if any break ended less than 5 minutes ago; otherwise, among those due,
// the most overdue relative to its own interval. One never done counts as just due.
export const pickDue = (
  now: number,
  kinds: readonly { kind: RestKind; isOn: boolean; intervalMin: number; lastAt: number | undefined }[],
): RestKind | undefined => {
  const lasts = kinds.map(k => k.lastAt).filter((t): t is number => t !== undefined)
  if (lasts.length > 0 && now - Math.max(...lasts) < REST_GAP_MS) return undefined

  let best: { kind: RestKind; overdue: number } | undefined
  for (const k of kinds) {
    if (!k.isOn || !isDue(now, k.lastAt, k.intervalMin)) continue
    const overdue = k.lastAt === undefined ? 1 : (now - k.lastAt) / (k.intervalMin * MINUTE)
    if (best === undefined || overdue > best.overdue) best = { kind: k.kind, overdue }
  }
  return best?.kind
}

// CJK characters take two cells.
export const cells = (text: string) => {
  let n = 0
  for (const ch of text) n += (ch.codePointAt(0) ?? 0) >= 0x2e80 ? 2 : 1
  return n
}

export const centre = (text: string, columns: number) =>
  ' '.repeat(Math.max(0, Math.floor((columns - cells(text)) / 2))) + text

// The breathing line: a dim track of fixed width, its lit part growing from the middle outward.
// Lengths move by half cells (╺ ╸ at the ends), so it moves smoothly; the track never changes width,
// so the centre stays still.
export type BreathBar = { indent: string; trackLeft: string; lit: string; trackRight: string }

export const breathBar = (fill: number, columns: number): BreathBar => {
  const half = Math.floor(Math.max(10, Math.min(48, columns - 4)) / 2)
  const halves = Math.round(Math.min(1, Math.max(0, fill)) * half * 2)
  const full = Math.floor(halves / 2)
  const isOdd = halves % 2 === 1
  const dark = half - full - (isOdd ? 1 : 0)

  return {
    indent: ' '.repeat(Math.max(0, Math.floor((columns - half * 2) / 2))),
    trackLeft: '─'.repeat(dark),
    lit: (isOdd ? '╺' : '') + '━'.repeat(full * 2) + (isOdd ? '╸' : ''),
    trackRight: '─'.repeat(dark),
  }
}
