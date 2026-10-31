// A heads-up display above the prompt, top to bottom:
//   context  fill · cost · limits · last compaction
//   repo     branch · whose changes
//   task     this step ▰▰▱▱▱ · est N min          only while the model reports progress
//   recap    Goal / Last / Next                    after you have been away; gone once you type
//   breaks   eyes 3m · breathe 12m · push-ups 41m  a two-line animation while a break runs
// When rows run short, breaks go first, then repo, task and the animation; recap and context stay longest.
//
// Off the HUD: compaction keeps decisions and authorizations, and your messages are saved before it;
// a progress tool for the model; timed breaks while you wait; whats-next after you step away;
// an optional done note when a session can be closed.
//
// Every use of `$` lives in this file: `$` cannot be passed to functions in other files.
// Pure helpers are in text.ts (words, parsing) and pace.ts (timing).

import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register, SessionCompactInput } from 'claude-code'

import type { Compaction, Due, Plan, Reading, RepoStatus, RestKind } from '../types'
import { MINUTE, REST, REST_KINDS, estimateFinish, factorOf, isLate, pickDue, ratioOf } from './pace.ts'
import {
  ALARM,
  AUTO_COMMAND,
  AUTO_NEXT_MIN,
  AWAY_MIN,
  DONE_COMMAND,
  TEXT,
  TOOL,
  WARN,
  WHATS_NEXT,
  basename,
  clip,
  contextCells,
  contextColor,
  describeDue,
  describeExtras,
  describeRepo,
  describeTask,
  dirname,
  fitRows,
  formatDoneEntry,
  isClosable,
  isGoalLine,
  isNextLine,
  isSameDue,
  isWhatsNext,
  isWhatsNextName,
  langOf,
  nextContent,
  nextTone,
  parseCommandSetting,
  parseRecap,
  parseStatus,
  pickWhatsNext,
  schemaOf,
  stamp,
  stripReminders,
} from './text.ts'
import type { Lang, Row, Strings } from './text.ts'

const reading = atom({ plugin: 'hud', key: 'reading' } as const, null)
const lastCompaction = atom({ plugin: 'hud', key: 'lastCompaction' } as const, null)
const editedFiles = atom({ plugin: 'hud', key: 'editedFiles' } as const, [])
const repos = atom({ plugin: 'hud', key: 'repos' } as const, null)
const plan = atom({ plugin: 'hud', key: 'plan' } as const, null)
const tick = atom({ plugin: 'hud', key: 'tick' } as const, 0)
const turnStartedAt = atom({ plugin: 'hud', key: 'turnStartedAt' } as const, null)
const rest = atom({ plugin: 'hud', key: 'rest' } as const, null)
const restWord = atom({ plugin: 'hud', key: 'restWord' } as const, null)
const due = atom({ plugin: 'hud', key: 'due' } as const, null)
const lastActiveAt = atom({ plugin: 'hud', key: 'lastActiveAt' } as const, null)
const recap = atom({ plugin: 'hud', key: 'recap' } as const, null)
const backgroundTasks = atom({ plugin: 'hud', key: 'backgroundTasks' } as const, [])
const autoNext = atom({ plugin: 'hud', key: 'autoNext' } as const, { forAt: null, isArmed: true })
const doneLoggedFor = atom({ plugin: 'hud', key: 'doneLoggedFor' } as const, null)

const MAX_REPOS = 3
const LABEL = 8
const TICK_MS = 10_000
const BACKGROUND_STALE_MS = 2 * 60 * MINUTE
// These tools, started in the background from the main conversation, report back with a notification
const BACKGROUND_TOOLS = ['Bash', 'Agent', 'Monitor', 'Workflow']
// The tool whats-next asks its questions with
const ASK_TOOL = 'AskUserQuestion'
// A turn must have run this long before a break starts: only then are you waiting
const WAIT_BEFORE_REST_MS = 20_000
const MAX_RATIOS = 20
const DONE_CMD_TIMEOUT_MS = 60_000

// HUD_LANG=zh for Chinese; English otherwise.
const langFor = async ($: EngineInterface): Promise<Lang> => langOf(await $.env.get('HUD_LANG').catch(() => undefined))

const textFor = async ($: EngineInterface): Promise<Strings> => TEXT[await langFor($)]

// Failures go to the debug log only (claude --debug), never into the transcript.
const debug = ($: EngineInterface, text: string) => $.ui.log(text, { to: 'debug' })

// ───────────── context and repos ─────────────

// Before compaction, save your messages and the files changed to a markdown note, in case the summary drops something.
const saveNote = async ($: EngineInterface, e: SessionCompactInput, t: Strings) => {
  const home = await $.env.get('HOME')
  if (home === undefined) return undefined

  const now = await $.clock.now()
  const sessionId = await $.session.id()
  const cwd = await $.session.cwd()

  const prompts = e.messages
    .filter(m => m.role === 'user')
    .map(m => stripReminders(m.text))
    .filter(text => text !== '')

  const files = [
    ...new Set(
      e.messages.flatMap(m =>
        m.toolUses
          .filter(u => ['Edit', 'Write', 'NotebookEdit'].includes(u.tool))
          .map(u => u.input.file_path ?? u.input.notebook_path)
          .filter((p): p is string => typeof p === 'string'),
      ),
    ),
  ]

  const lines = [
    t.noteTitle(new Date(now).toISOString()),
    '',
    `session \`${sessionId}\` · trigger \`${e.trigger}\` · \`${cwd}\``,
    '',
    t.notePrompts(prompts.length),
    '',
    ...prompts.flatMap((text, i) => [`### ${i + 1}`, '', clip(text, 4000, t), '']),
    t.noteFiles(files.length),
    '',
    ...(files.length === 0 ? [t.noteNone] : files.map(f => `- ${f}`)),
    '',
  ]

  const path = `${home}/.claude/hud/notes/${sessionId}/${stamp(now)}.md`
  await $.fs.write(path, lines.join('\n'))

  return path
}

// Record files this session changed by their real path, so a symlinked checkout and its target count as one.
const track = async ($: EngineInterface, path: string) => {
  const stat = await $.fs.stat(path, { resolve: true }).catch(() => undefined)
  const real = stat?.realPath ?? path
  await update($, editedFiles, files => (files.includes(real) ? files : [...files, real]))
}

type RepoInfo = { root: string; name: string; isWorktree: boolean }

const git = ($: EngineInterface, cwd: string, args: string[]) =>
  $.process.run(['git', ...args], { cwd, timeoutMs: 5000 }).catch(() => undefined)

const repoOf = async ($: EngineInterface, dir: string): Promise<RepoInfo | undefined> => {
  const run = await git($, dir, ['rev-parse', '--path-format=absolute', '--show-toplevel', '--git-dir', '--git-common-dir'])
  if (run === undefined || run.exitCode !== 0) return undefined

  const [root, gitDir, commonDir] = run.stdout.trim().split('\n')
  if (!root || !gitDir || !commonDir) return undefined

  return { root, name: basename(dirname(commonDir)), isWorktree: gitDir !== commonDir }
}

const statusOf = async ($: EngineInterface, repo: RepoInfo, mine: readonly string[]): Promise<RepoStatus | undefined> => {
  const run = await git($, repo.root, ['status', '--porcelain=v1', '-b', '--untracked-files=all'])
  if (run === undefined || run.exitCode !== 0) return undefined

  const status = parseStatus(run.stdout)
  const dirty = status.paths.map(p => `${repo.root}/${p}`)
  const mineCount = dirty.filter(p => mine.includes(p)).length

  return {
    name: repo.name,
    root: repo.root,
    branch: status.branch,
    isWorktree: repo.isWorktree,
    ahead: status.ahead,
    behind: status.behind,
    others: dirty.length - mineCount,
    mine: mineCount,
  }
}

// The repo the session started in, plus the repos of files this session changed; three at most.
const refreshRepos = async ($: EngineInterface, cache: Map<string, RepoInfo | undefined>) => {
  const mine = await read($, editedFiles)
  const dirs = [await $.session.cwd(), ...new Set(mine.map(dirname))]

  const found: RepoInfo[] = []
  for (const dir of dirs) {
    if (!cache.has(dir)) cache.set(dir, await repoOf($, dir))
    const repo = cache.get(dir)
    if (repo && !found.some(r => r.root === repo.root)) found.push(repo)
    if (found.length >= MAX_REPOS) break
  }

  const statuses = await Promise.all(found.map(repo => statusOf($, repo, mine)))
  const next = statuses.filter((s): s is RepoStatus => s !== undefined)
  await update($, repos, () => next)
}

// ───────────── progress and breaks ─────────────

type Settings = { isOn: boolean; intervalMin: number }

// Settings and the time of the last break live in $.store, shared by all sessions:
// a break taken in any window counts. The breathing key is plain "settings" for compatibility.
const KEYS: Record<RestKind, { settings: string; lastAt: string }> = {
  breath: { settings: 'settings', lastAt: 'lastBreathAt' },
  eyes: { settings: 'eyesSettings', lastAt: 'eyesLastAt' },
  pushups: { settings: 'pushupsSettings', lastAt: 'pushupsLastAt' },
}

const readSettings = (kind: RestKind, saved: unknown, isOnByDefault: boolean): Settings => {
  const s = (typeof saved === 'object' && saved !== null ? saved : {}) as Partial<Settings>
  return {
    isOn: typeof s.isOn === 'boolean' ? s.isOn : isOnByDefault,
    intervalMin: typeof s.intervalMin === 'number' && s.intervalMin >= 5 ? s.intervalMin : REST[kind].defaultMin,
  }
}

const settingsOf = async ($: EngineInterface, kind: RestKind) =>
  readSettings(
    kind,
    await $.store.get(KEYS[kind].settings).catch(() => undefined),
    // Timed breaks are off unless HUD_RESTS=on; a stored /breathe on or off wins
    (await $.env.get('HUD_RESTS').catch(() => undefined)) === 'on',
  )

const lastAtOf = async ($: EngineInterface, kind: RestKind) => {
  const saved = await $.store.get(KEYS[kind].lastAt).catch(() => undefined)
  return typeof saved === 'number' ? saved : undefined
}

const ratiosOf = async ($: EngineInterface) => {
  const saved = await $.store.get('ratios').catch(() => undefined)
  return Array.isArray(saved) ? saved.filter((r): r is number => typeof r === 'number') : []
}

// The breaks row: minutes until each enabled break, soonest first. Written only when a number changes.
const refreshDue = async ($: EngineInterface) => {
  const now = await $.clock.now()
  const list: Due[] = []
  for (const kind of REST_KINDS) {
    const settings = await settingsOf($, kind)
    if (!settings.isOn) continue
    const last = await lastAtOf($, kind)
    const left = last === undefined ? 0 : Math.max(0, last + settings.intervalMin * MINUTE - now)
    list.push({ kind, leftMin: Math.ceil(left / MINUTE) })
  }
  list.sort((a, b) => a.leftMin - b.leftMin)
  if (!isSameDue(await read($, due), list)) await update($, due, () => list)
}

const stopRest = async ($: EngineInterface, startedAt?: number) => {
  const current = await read($, rest)
  if (current === null || (startedAt !== undefined && current.startedAt !== startedAt)) return
  await update($, rest, () => null)
  await update($, restWord, () => null)
}

const startRest = async ($: EngineInterface, kind: RestKind) => {
  const now = await $.clock.now()
  const settings = await settingsOf($, kind)
  const nextMin = settings.isOn ? settings.intervalMin : null
  await update($, restWord, () => null)
  await update($, rest, () => ({ kind, startedAt: now, endsAt: now + REST[kind].ms, isAnswered: false, nextMin }))
  await $.store.set(KEYS[kind].lastAt, now).catch(() => undefined)
  await refreshDue($)
  $.clock.after(REST[kind].ms, () => void stopRest($, now).catch(() => undefined))
}

// ───────────── the recap after you have been away ─────────────

// The main conversation has been idle: fork the session's own conversation once and ask for goal, last
// step and next step. The fork reads the session's prompt cache while it is warm; once per absence.
const makeRecap = async ($: EngineInterface, forAt: number) => {
  const t = await textFor($)
  await update($, recap, () => ({ forAt, isReady: false, lines: [] }))
  const reply = await $.model.fork({ prompt: t.recapAsk })
  const lines = reply.isAnswered ? parseRecap(reply.text, t) : []
  // You came back and started a new turn while it was being written: drop it
  const current = await read($, recap)
  if (current?.forAt !== forAt) return
  await update($, recap, () => (lines.length === 0 ? null : { forAt, isReady: true, lines }))
  if (!reply.isAnswered) debug($, `recap not written: ${reply.reason}`)
  // The next step says the session can be closed: write a done note if they are on. Not awaited.
  if (lines.length > 0) void logDone($, forAt, lines, t).catch(err => debug($, `done note failed: ${err}`))
}

const checkAway = async ($: EngineInterface, now: number) => {
  // With auto whats-next on, checkAutoNext writes the recap first; no second one here
  if ((await autoSettingsOf($)).isOn) return
  if ((await read($, turnStartedAt)) !== null) return
  const last = await read($, lastActiveAt)
  if (last === null || now - last < AWAY_MIN * MINUTE) return
  if ((await read($, recap))?.forAt === last) return
  await makeRecap($, last)
}

// ───────────── done note ─────────────

type DoneSettings = { isOn: boolean }

// Off unless HUD_DONE_LOG=on; a stored /donelog on or off wins. Shared by all sessions.
const doneSettingsOf = async ($: EngineInterface): Promise<DoneSettings> => {
  const saved = await $.store.get('doneLogSettings').catch(() => undefined)
  const s = (typeof saved === 'object' && saved !== null ? saved : {}) as { isOn?: unknown }
  return {
    isOn: typeof s.isOn === 'boolean' ? s.isOn : (await $.env.get('HUD_DONE_LOG').catch(() => undefined)) === 'on',
  }
}

// HUD_DONE_CMD names one executable (a path, ~/ allowed, or a name on PATH). It is never run through a shell.
const doneCommandOf = async ($: EngineInterface) => {
  const raw = ((await $.env.get('HUD_DONE_CMD').catch(() => undefined)) ?? '').trim()
  if (raw === '') return undefined
  if (!raw.startsWith('~/')) return raw
  const home = await $.env.get('HOME').catch(() => undefined)
  return home === undefined ? raw : `${home}${raw.slice(1)}`
}

// The recap says the session can be closed: fork once to ask what got done, write the note to
// ~/.claude/hud/done-log/, then run HUD_DONE_CMD with the note's path as its one argument.
// At most one note per absence.
const logDone = async ($: EngineInterface, forAt: number, lines: string[], t: Strings) => {
  const next = lines.find(line => isNextLine(line, t))
  if (next === undefined || !isClosable(next, t)) return
  // Interactive sessions only: in `claude -p` nobody sits at the prompt
  if (!(await $.session.surfaces()).includes('terminal')) return
  if (!(await doneSettingsOf($)).isOn) return
  if ((await read($, doneLoggedFor)) === forAt) return
  const home = await $.env.get('HOME')
  if (home === undefined) return
  await update($, doneLoggedFor, () => forAt)

  const reply = await $.model.fork({ prompt: t.doneAsk })
  if (!reply.isAnswered) {
    debug($, `done note not written: ${reply.reason}`)
    return
  }
  const cwd = await $.session.cwd()
  const repo = (await repoOf($, cwd))?.name ?? basename(cwd)
  const goal = lines.find(line => isGoalLine(line, t)) ?? ''
  const entry = formatDoneEntry({ at: forAt, repo, goal, text: reply.text }, t)
  if (entry === null) {
    debug($, 'done note not written: the reply did not follow the format')
    return
  }

  const sessionId = await $.session.id()
  const path = `${home}/.claude/hud/done-log/${sessionId}-${stamp(forAt)}.md`
  await $.fs.write(path, entry)

  const command = await doneCommandOf($)
  if (command === undefined) return
  // The path is its own argument; nothing is put into a shell string
  const run = await $.process.run([command, path], { timeoutMs: DONE_CMD_TIMEOUT_MS }).catch(err => {
    debug($, `HUD_DONE_CMD did not run: ${err}`)
    return undefined
  })
  if (run !== undefined && run.exitCode !== 0) {
    debug($, `HUD_DONE_CMD exited with ${run.exitCode}: ${run.stderr.slice(0, 200)}`)
  }
}

const describeDoneLog = async ($: EngineInterface, t: Strings) =>
  t.doneState((await doneSettingsOf($)).isOn, await doneCommandOf($))

// ───────────── whats-next after you step away ─────────────

type AutoSettings = { isOn: boolean; minutes: number }

// The switch and the minutes live in $.store, shared by all sessions
const autoSettingsOf = async ($: EngineInterface): Promise<AutoSettings> => {
  const saved = await $.store.get('autoNextSettings').catch(() => undefined)
  const s = (typeof saved === 'object' && saved !== null ? saved : {}) as Partial<AutoSettings>
  return {
    isOn: typeof s.isOn === 'boolean' ? s.isOn : true,
    minutes: typeof s.minutes === 'number' && s.minutes >= 1 && s.minutes <= 60 ? s.minutes : AUTO_NEXT_MIN,
  }
}

type Target = { command: string; args: string }

// HUD_WHATS_NEXT_COMMAND, when set, names the command to run (with or without the slash, arguments allowed)
const customWhatsNext = async ($: EngineInterface) =>
  parseCommandSetting(await $.env.get('HUD_WHATS_NEXT_COMMAND').catch(() => undefined))

// What to run: HUD_WHATS_NEXT_COMMAND if set; else /whats-next if it is installed as a plain skill or
// command; else a plugin's /<plugin>:whats-next (such as /yskills:whats-next); else nothing.
const whatsNextOf = async ($: EngineInterface): Promise<Target | undefined> => {
  const custom = await customWhatsNext($)
  if (custom !== undefined) return custom
  const list = await $.command.list().catch(() => undefined)
  // The list could not be read: try the plain name; an unknown command is refused quietly
  if (list === undefined) return { command: WHATS_NEXT, args: '' }
  const found = pickWhatsNext(list.map(c => c.name))
  return found === undefined ? undefined : { command: found, args: '' }
}

// Work still running in the background: a background task that has not reported back, or a subagent
const isBusyInBackground = async ($: EngineInterface, now: number) => {
  // A task killed without a notification stops counting after 2 hours
  const tasks = (await read($, backgroundTasks)).filter(at => now - at < BACKGROUND_STALE_MS)
  if (tasks.length > 0) return true
  const agents = await $.agent.list().catch(() => [])
  return agents.some(a => a.status === 'pending' || a.status === 'running' || a.status === 'waiting')
}

// The main conversation has been idle for N minutes with an empty prompt: write the recap, then run
// whats-next as if you had typed it. While its questions are open the turn has not ended, so no second
// run stacks up; after one run it waits until you type something yourself (see isArmed).
const checkAutoNext = async ($: EngineInterface, now: number) => {
  // Still working: this turn has not ended, or something runs in the background
  if ((await read($, turnStartedAt)) !== null) return
  const last = await read($, lastActiveAt)
  const settings = await autoSettingsOf($)
  if (!settings.isOn || last === null || now - last < settings.minutes * MINUTE) return
  const state = await read($, autoNext)
  if (!state.isArmed || state.forAt === last) return
  if (await isBusyInBackground($, now)) return
  // A half-typed prompt: leave it alone
  if ((await $.prompt.read()).text.trim() !== '') return
  const target = await whatsNextOf($)
  // No whats-next to run: the recap alone, and nothing more this absence
  await update($, autoNext, () => ({ forAt: last, isArmed: target === undefined }))
  // The recap first, so it is still above the prompt after the questions close
  if ((await read($, recap))?.forAt !== last) await makeRecap($, last).catch(() => undefined)
  if (target === undefined) {
    debug($, 'no whats-next command found; showing the recap only')
    return
  }
  // You came back while the recap was being written: do not run; your typing re-arms it
  if ((await read($, turnStartedAt)) !== null) return
  if ((await $.prompt.read()).text.trim() !== '') return
  void $.command
    .run({ command: target.command, args: target.args })
    .catch(err => debug($, `/${target.command} did not run: ${err}`))
}

const describeAutoNext = async ($: EngineInterface, t: Strings) => {
  const settings = await autoSettingsOf($)
  const target = await whatsNextOf($)
  const shown = target === undefined ? undefined : [target.command, target.args].filter(Boolean).join(' ')
  return t.autoState(settings.isOn, settings.minutes, shown)
}

// Every 10 seconds: move the task row's time and the breaks row; end a break that is over; and if this
// turn has been running long enough, see whether a break is due.
const onTick = async ($: EngineInterface) => {
  const now = await $.clock.now()
  if ((await read($, plan)) !== null) await update($, tick, n => n + 1)
  await refreshDue($)

  const current = await read($, rest)
  if (current !== null) {
    if (now >= current.endsAt) await stopRest($)
    return
  }

  const started = await read($, turnStartedAt)
  if (started === null || now - started < WAIT_BEFORE_REST_MS) return

  const kinds = await Promise.all(
    REST_KINDS.map(async kind => ({ kind, ...(await settingsOf($, kind)), lastAt: await lastAtOf($, kind) })),
  )
  const kind = pickDue(now, kinds)
  if (kind === undefined) return

  // The animation draws only in a terminal
  if (!(await $.session.surfaces()).includes('terminal')) return

  await startRest($, kind)
}

// After a turn that answered normally, record how far off the estimate was; later estimates use the median.
const calibrate = async ($: EngineInterface, p: Plan) => {
  if (p.guessAt === undefined || p.rawGuessMs === undefined || p.rawGuessMs < 30_000 || p.done === 0) return
  const actual = (await $.clock.now()) - p.guessAt
  const ratios = [...(await ratiosOf($)), ratioOf(actual, p.rawGuessMs)].slice(-MAX_RATIOS)
  await $.store.set('ratios', ratios).catch(() => undefined)
}

const describeSettings = async ($: EngineInterface, kind: RestKind, t: Strings) => {
  const settings = await settingsOf($, kind)
  const name = t.restName[kind]
  if (!settings.isOn) return t.restOff(name)
  const last = await lastAtOf($, kind)
  const left = last === undefined ? 0 : Math.max(0, last + settings.intervalMin * MINUTE - (await $.clock.now()))
  return t.restOn(name, settings.intervalMin, left === 0 ? 0 : Math.ceil(left / MINUTE))
}

const helpOf = (kind: RestKind, t: Strings) => t.restHelp(`/${REST[kind].command}`.padEnd(9))

const KIND_OF_COMMAND = Object.fromEntries(REST_KINDS.map(k => [REST[k].command, k])) as Record<string, RestKind>

// ───────────── hooks ─────────────

export const register: Register = on => {
  // Starts over on a hot reload; that is fine.
  let wasAlarmed = false
  // Sessions from -p and the SDK have nobody at the prompt: nothing runs on its own there
  let isInteractive = false
  const repoCache = new Map<string, RepoInfo | undefined>()

  on('session.start', async ($, e, next) => {
    const started = await next(e)
    isInteractive = e.isInteractive
    await refreshRepos($, repoCache)
    const t = await textFor($)

    await $.tool
      .register({ name: 'progress', description: t.toolDescription, inputSchema: schemaOf(t) })
      .catch(err => debug($, `progress tool not registered: ${err}`))
    for (const kind of REST_KINDS) {
      await $.command
        .register({
          name: REST[kind].command,
          description: t.restDescription[kind],
          argumentHint: t.restArgHint,
          immediate: true,
        })
        .catch(err => debug($, `/${REST[kind].command} not registered: ${err}`))
    }
    if (isInteractive) {
      await $.command
        .register({ name: AUTO_COMMAND, description: t.autoDescription, argumentHint: t.autoArgHint, immediate: true })
        .catch(err => debug($, `/${AUTO_COMMAND} not registered: ${err}`))
      await $.command
        .register({ name: DONE_COMMAND, description: t.doneDescription, argumentHint: t.doneArgHint, immediate: true })
        .catch(err => debug($, `/${DONE_COMMAND} not registered: ${err}`))
    }
    await refreshDue($)
    $.clock.every(TICK_MS, () => {
      void onTick($).catch(() => undefined)
      // The recap and whats-next are for someone coming back to the prompt; -p and SDK sessions have nobody
      if (isInteractive) {
        void $.clock
          .now()
          .then(now => Promise.all([checkAway($, now), checkAutoNext($, now)]))
          .catch(() => undefined)
      }
    })
    return started
  })

  on('session.measure', async ($, e, next) => {
    const limit = (kind: string) => e.rateLimits.find(r => r.kind === kind)?.percentUsed
    const now: Reading = {
      percent: e.context.percent,
      tokens: e.context.tokens,
      window: e.context.window,
      usd: e.cost?.usd,
      fiveHour: limit('five_hour'),
      sevenDay: limit('seven_day'),
    }
    await update($, reading, () => now)

    const isAlarmed = (now.percent ?? 0) >= ALARM
    if (isAlarmed && !wasAlarmed) $.ui.toast((await textFor($)).contextToast(now.percent ?? ALARM))
    wasAlarmed = isAlarmed

    return next(e)
  })

  on('tool.call', { tool: 'Edit' }, async ($, e, next) => {
    const result = await next(e)
    if (result.deny === undefined && result.isError !== true) await track($, e.file_path)
    return result
  })

  on('tool.call', { tool: 'Write' }, async ($, e, next) => {
    const result = await next(e)
    if (result.deny === undefined && result.isError !== true) await track($, e.file_path)
    return result
  })

  on('tool.call', { tool: 'NotebookEdit' }, async ($, e, next) => {
    const result = await next(e)
    if (result.deny === undefined && result.isError !== true) await track($, e.notebook_path)
    return result
  })

  on('session.compact', async ($, e, next) => {
    // A subagent's own compaction is left alone; only the main conversation's
    if (e.agentId !== undefined) return next(e)

    const t = await textFor($)
    const instructions = [e.instructions, t.keep].filter(Boolean).join('\n\n')

    // precompute only prepares a summary; the real compaction comes later, and the note is saved then
    const isReal = e.trigger !== 'precompute'
    const notePath = isReal ? await saveNote($, e, t).catch(() => undefined) : undefined

    const result = await next({ ...e, instructions })

    if (isReal && result.skip === undefined) {
      const done: Compaction = {
        at: await $.clock.now(),
        trigger: e.trigger,
        before: result.tokensBefore,
        after: result.tokensAfter,
        notePath,
      }
      await update($, lastCompaction, () => done)
      $.ui.toast(notePath ? t.compactedToast(notePath) : t.compactedNoNote)
    }

    return result
  })

  // List the progress tool in front of the model directly, so it needs no ToolSearch.
  on('tool.describe', { tool: TOOL }, async ($, e, next) => ({ ...(await next(e)), isDeferred: false }))

  on('prompt.compose', async ($, e, next) => {
    const composed = await next(e)
    if (!e.tools.includes(TOOL)) return composed
    const t = await textFor($)
    return {
      sections: [...composed.sections, { id: 'hud:progress', text: t.guide, scope: 'session' as const }],
    }
  })

  on('tool.call', { tool: TOOL }, async ($, e) => {
    const t = await textFor($)
    if (e.agentId !== undefined) return { result: t.toolSubagent }

    const total = Math.round(Number(e.total))
    const done = Math.round(Number(e.done))
    if (!Number.isFinite(total) || !Number.isFinite(done) || total < 1 || done < 0) {
      return { deny: t.toolDeny }
    }

    const minutes = typeof e.minutes === 'number' && e.minutes > 0 ? e.minutes : undefined
    const step = typeof e.step === 'string' && e.step.trim() !== '' ? e.step.trim().slice(0, 30) : undefined
    const now = await $.clock.now()
    const before = await read($, plan)
    const factor = factorOf(await ratiosOf($))

    const rawGuessMs = minutes !== undefined ? minutes * MINUTE : before?.rawGuessMs
    const next: Plan = {
      startedAt: (await read($, turnStartedAt)) ?? before?.startedAt ?? now,
      total: Math.max(total, done),
      done,
      step,
      guessAt: minutes !== undefined ? now : before?.guessAt,
      rawGuessMs,
      guessMs: rawGuessMs === undefined ? undefined : Math.round(rawGuessMs * factor),
    }
    next.finishAt = estimateFinish(next, now)
    await update($, plan, () => next)

    return { result: t.toolNoted(next.done, next.total) }
  })

  // You typed something else yourself: auto whats-next is armed again and the recap goes.
  // A background task's notification, a plugin's own prompt, and whats-next itself do not re-arm it:
  // once whats-next has been shown, it is not shown again until you type.
  on('prompt.submit', async ($, e, next) => {
    // A background task reported back: strike the oldest
    if (e.origin?.kind === 'task-notification') {
      await update($, backgroundTasks, list => list.slice(1)).catch(() => undefined)
    }
    // No origin counts as your own typing
    const kind = e.origin?.kind
    const isHuman = kind === undefined || kind === 'composer' || kind === 'bridge'
    try {
      const custom = (await customWhatsNext($))?.command
      const isNext = isWhatsNextName(e.command?.name, custom) || isWhatsNext(e.text, custom)
      if (isNext) await update($, autoNext, s => ({ ...s, isArmed: false }))
      else if (isHuman) await update($, autoNext, s => ({ ...s, isArmed: true }))
      if (isHuman) await update($, recap, () => null)
    } catch {}
    return next(e)
  })

  // Count background tasks. A whats-next the model calls itself (through the Skill tool) counts as shown.
  on('tool.call', async ($, e, next) => {
    const result = await next(e)
    if (e.agentId !== undefined) return result
    // Every tool call passes here: a failure must never get in the tool's way
    try {
      if (result.deny === undefined && result.isError !== true) {
        const input = e as { run_in_background?: unknown }
        const isBackground = e.tool === 'Monitor' || e.tool === 'Workflow' || input.run_in_background === true
        if (BACKGROUND_TOOLS.includes(e.tool) && isBackground) {
          const now = await $.clock.now()
          await update($, backgroundTasks, list => [...list, now])
        }
        if (e.tool === 'TaskStop') await update($, backgroundTasks, list => list.slice(1))
      }
      if (e.tool === 'Skill') {
        const skill = (e as { skill?: unknown }).skill
        const custom = (await customWhatsNext($))?.command
        if (typeof skill === 'string' && isWhatsNextName(skill, custom)) {
          await update($, autoNext, s => ({ ...s, isArmed: false }))
        }
      }
      // You answered whats-next's question and the model went on to call another tool, so work has
      // started: the recap describes the moment before your answer and goes. Picking an option that starts
      // no work, or closing the questions unanswered, keeps it.
      const r = await read($, recap)
      if (r?.isReady) {
        const isAsk = e.tool === ASK_TOOL
        if (isAsk && result.deny === undefined && result.isError !== true) {
          await update($, recap, cur => (cur === null ? cur : { ...cur, isAnswered: true }))
        } else if (!isAsk && r.isAnswered) {
          await update($, recap, () => null)
        }
      }
    } catch {}
    return result
  })

  on('turn.start', async ($, e, next) => {
    const now = await $.clock.now()
    await update($, plan, () => null)
    await update($, turnStartedAt, () => now)
    // With auto whats-next on, the recap stays until you type (see prompt.submit): the automatic turn and
    // a notification's turn leave it in place
    if (!(await autoSettingsOf($)).isOn) await update($, recap, () => null)
    if (isWhatsNext(e.text, (await customWhatsNext($))?.command)) {
      await update($, autoNext, s => ({ ...s, isArmed: false }))
    }
    await update($, rest, r => (r === null || !r.isAnswered ? r : { ...r, isAnswered: false }))
    return next(e)
  })

  on('turn.complete', async ($, e, next) => {
    const result = await next(e)
    if (e.agentId !== undefined) return result

    await refreshRepos($, repoCache)
    const p = await read($, plan)
    if (p !== null && e.reason === 'answer') await calibrate($, p)
    await update($, plan, () => null)
    await update($, turnStartedAt, () => null)
    const endedAt = await $.clock.now()
    await update($, lastActiveAt, () => endedAt)
    // The reply arrived during a break: the break does not stop; the caption says you can stop it
    if (e.reason === 'answer') await update($, rest, r => (r === null ? r : { ...r, isAnswered: true }))
    return result
  })

  on('command.run', async ($, e, next) => {
    if (e.command === DONE_COMMAND) {
      const t = await textFor($)
      const arg = e.args.trim().toLowerCase()
      if (arg === 'off' || arg === 'on') {
        await $.store.set('doneLogSettings', { isOn: arg === 'on' })
      }
      return { text: await describeDoneLog($, t) }
    }
    if (e.command === AUTO_COMMAND) {
      const t = await textFor($)
      const arg = e.args.trim().toLowerCase()
      const settings = await autoSettingsOf($)
      const minutes = Number(arg)
      if (arg === 'off' || arg === 'on') {
        await $.store.set('autoNextSettings', { ...settings, isOn: arg === 'on' })
      } else if (Number.isInteger(minutes) && minutes >= 1 && minutes <= 60) {
        await $.store.set('autoNextSettings', { ...settings, minutes })
      }
      return { text: await describeAutoNext($, t) }
    }

    const kind = KIND_OF_COMMAND[e.command]
    if (kind === undefined) return next(e)
    const t = await textFor($)
    const arg = e.args.trim().toLowerCase()

    if (arg === '') {
      const current = await read($, rest)
      if (current?.kind === kind) {
        await stopRest($)
        return { text: t.restStopped[kind] }
      }
      // Another break is running: switch to this one
      await startRest($, kind)
      return { text: t.restStarted[kind] }
    }

    if (arg === 'off' || arg === 'on') {
      await $.store.set(KEYS[kind].settings, { ...(await settingsOf($, kind)), isOn: arg === 'on' })
      await refreshDue($)
      return { text: await describeSettings($, kind, t) }
    }

    const minutes = Number(arg)
    if (Number.isInteger(minutes) && minutes >= 5 && minutes <= 240) {
      await $.store.set(KEYS[kind].settings, { ...(await settingsOf($, kind)), intervalMin: minutes })
      await refreshDue($)
      return { text: await describeSettings($, kind, t) }
    }

    return { text: `${await describeSettings($, kind, t)}\n\n${helpOf(kind, t)}` }
  })

  on('ui.message', async ($, e, next) => {
    const data = e.data as { word?: unknown } | null
    const word = data?.word
    if (typeof word === 'string' && (await read($, rest)) !== null) await update($, restWord, () => word)
    return next(e)
  })

  // The spinner line changes only its word: during a break "Breathe in 4s", otherwise the step the
  // model reported. Steps and time are on the HUD's task row.
  on('ui.render', { component: 'Spinner' }, async ($, e, next) => {
    const word = (await read($, restWord)) ?? (await read($, plan))?.step
    if (word === undefined) return next(e)
    return next({ ...e, props: { ...e.props, word } })
  })

  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    if (e.props.hasSurvey) return next(e)

    const now = await read($, reading)
    const repoList = (await read($, repos)) ?? []
    const p = await read($, plan)
    await read($, tick)
    const current = await read($, rest)
    const dueList = (await read($, due)) ?? []
    const compaction = await read($, lastCompaction)
    const back = await read($, recap)
    const recapRows = back === null ? 0 : back.isReady ? back.lines.length : 1

    const wanted = new Set<Row>()
    if (now !== null) wanted.add('context')
    if (repoList.length > 0) wanted.add('repo')
    if (p !== null) wanted.add('task')
    if (current !== null && e.surface === 'terminal') wanted.add('rest')
    else if (dueList.length > 0) wanted.add('next')
    if (recapRows > 0) wanted.add('recap')

    const rows = fitRows(wanted, e.props.maxRows, recapRows)
    if (rows.length === 0) return next(e)

    const lang = await langFor($)
    const t = TEXT[lang]
    const clock = await $.clock.now()
    const { Box, Text } = $.ui.resolve(e)
    const label = (text: string) => <Text dimColor>{text.padEnd(LABEL)}</Text>

    const draw = (row: Row) => {
      if (row === 'context' && now !== null) {
        const percent = now.percent ?? 0
        const color = contextColor(percent)
        const extras = describeExtras(now, compaction, t)
        const cells = contextCells(percent)
        return (
          <Box key="context">
            {label(t.label.context)}
            <Text color={color}>{cells.used}</Text>
            <Text dimColor>
              {cells.used && cells.free ? ' ' : ''}
              {cells.free}
            </Text>
            <Text color={color} bold={percent >= WARN}>
              {' '}
              {now.percent === undefined ? '—' : `${percent}%`}
            </Text>
            <Text dimColor wrap="truncate-end">
              {extras.length > 0 ? ` · ${extras.join(' · ')}` : ''}
            </Text>
          </Box>
        )
      }
      if (row === 'repo') {
        return (
          <Box key="repo">
            {label(t.label.repo)}
            <Text dimColor wrap="truncate-end">
              {repoList.map(r => describeRepo(r, t)).join('  │  ')}
            </Text>
          </Box>
        )
      }
      if (row === 'task' && p !== null) {
        // ECAM: amber (yellow in a terminal) when late; otherwise nothing lights up
        return (
          <Box key="task">
            {label(t.label.task)}
            <Text color={isLate(p, clock) ? 'yellow' : undefined} wrap="truncate-end">
              {describeTask(p, clock, t)}
            </Text>
          </Box>
        )
      }
      // The break animation draws only in a terminal
      if (row === 'rest' && current !== null && e.surface === 'terminal') {
        const { Client } = $.ui.resolve(e)
        return (
          <Client
            key={`${current.kind}:${current.startedAt}`}
            module="./rest.tsx"
            width={e.props.bodyColumns}
            height={2}
            props={{
              kind: current.kind,
              offsetMs: clock - current.startedAt,
              isWorking: e.props.isWorking,
              isAnswered: current.isAnswered,
              nextMin: current.nextMin,
              lang,
            }}
          />
        )
      }
      if (row === 'recap' && back !== null) {
        const lines = back.isReady ? back.lines : [t.recapWaiting]
        return (
          <Box key="recap" flexDirection="column">
            {lines.map((line, i) => {
              // The next step: a reverse-video label and bold text, seen at a glance
              if (back.isReady && isNextLine(line, t)) {
                const tone = nextTone(line, t)
                return (
                  <Box key={String(i)}>
                    {label(i === 0 ? t.label.recap : '')}
                    <Text color={tone} inverse bold>
                      {t.nextLabel}
                    </Text>
                    <Text color={tone} bold wrap="truncate-end">
                      {' ' + nextContent(line, t)}
                    </Text>
                  </Box>
                )
              }
              return (
                <Box key={String(i)}>
                  {label(i === 0 ? t.label.recap : '')}
                  {/* ECAM: cyan is "an action for you" */}
                  <Text color={back.isReady ? 'cyan' : undefined} dimColor={!back.isReady} wrap="truncate-end">
                    {line}
                  </Text>
                </Box>
              )
            })}
          </Box>
        )
      }
      if (row === 'next') {
        return (
          <Box key="next">
            {label(t.label.due)}
            <Text dimColor wrap="truncate-end">
              {describeDue(dueList, t)}
            </Text>
          </Box>
        )
      }
      return null
    }

    return (
      <Box flexDirection="column">
        {rows.map(draw)}
        {await next(e)}
      </Box>
    )
  })
}
