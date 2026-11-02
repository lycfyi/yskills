import { describe, expect, mock, test } from 'claude-code/testing'
import type { Engine } from 'claude-code/testing'
import type { On, SessionCompacted, SessionCompactInput, SessionMessage } from 'claude-code'

import type { Plan } from '../types'
import {
  BREATH_MS,
  INTRO_MS,
  PRACTICE_MS,
  REST,
  breathAt,
  breathBar,
  estimateFinish,
  factorOf,
  ratioOf,
  pickDue,
  restAt,
} from '../hooks/pace.ts'
import {
  TEXT,
  contextCells,
  describeDue,
  describeEta,
  fitRows,
  formatDoneEntry,
  isClosable,
  isWhatsNext,
  isWhatsNextName,
  langOf,
  nextTone,
  parseCommandSetting,
  parseRecap,
  pickWhatsNext,
  restWord,
} from '../hooks/text.ts'

const TOOL = 'mcp__hud__progress'
const MIN = 60_000
const T0 = Date.UTC(2026, 9, 2, 6, 0, 0)
const en = TEXT.en
const zh = TEXT.zh
const CJK = /[\u3000-\u9fff\uff00-\uffef]/

const SPINNER = {
  plugin: 'hud',
  component: 'Spinner',
  props: { word: 'Sauteing', message: null, suffix: '…', mode: 'tool-use' },
} as const

const BAND = {
  plugin: 'hud',
  component: 'AbovePrompt',
  props: {
    hasSurvey: false,
    isWorking: true,
    maxRows: 10,
    bodyColumns: 80,
    scroll: { offset: 0, bodyRows: 10 },
    view: {},
  },
} as const
const IDLE = { ...BAND, props: { ...BAND.props, isWorking: false } }

// Eyes and push-ups were done 10 minutes ago: not due, and not inside the 5-minute gap either,
// so tests about breathing are not disturbed by them.
const RECENT = { eyesLastAt: T0 - 10 * MIN, pushupsLastAt: T0 - 10 * MIN }
const AUTO_OFF = { autoNextSettings: { isOn: false } }
// Timed breaks on; everything else at its default (English, no done note)
const ENV = { HUD_RESTS: 'on' }
const ZH = { ...ENV, HUD_LANG: 'zh' }
const START = { cwd: '/r', surface: 'terminal', isInteractive: true } as const
const DONE = { reason: 'answer', answer: 'ok', durationMs: 1000, isAborted: false, turnId: 't1' } as const
const USAGE = { input_tokens: 1, output_tokens: 1, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 }

const ran = (stdout: string, exitCode = 0) => ({
  value: { exitCode, stdout, stderr: '', isStdoutTruncated: false, isStderrTruncated: false },
})

type Run = (argv: readonly string[], init?: { timeoutMs?: number }) => ReturnType<typeof ran>

// The engine below the plugin: sessions and turns answer as usual, the spinner line is one text.
// The default cwd is no git repo, so no repo row; tests about repos pass cwd and run.
const engine = (
  on: On,
  store: Record<string, unknown> = {},
  repo: { cwd?: string; run?: Run } = {},
  env: Record<string, string> = ENV,
) => {
  const clock = mock.clock(on, { now: T0 })
  mock.env(on, { HOME: '/home/u', ...env })
  mock.store(on, { ...RECENT, ...store })
  on('session.start', (_, e) => ({ cwd: e.cwd }))
  on('session.cwd', () => ({ value: repo.cwd ?? '/r' }))
  on('process.run', (_, e) => (repo.run ? repo.run(e.argv, e.init) : ran('', 128)))
  on('session.surfaces', () => ({ value: ['terminal'] }))
  on('tool.register', (_, e) => ({ value: { tool: `mcp__hud__${e.name}` } }))
  on('command.register', (_, e) => ({ value: { command: e.name } }))
  on('turn.start', (_, e) => ({ turnId: e.turnId }))
  on('turn.complete', () => ({ text: '' }))
  on('ui.render', { component: 'Spinner' }, ($, e) => {
    const { Text } = $.ui.resolve(e)
    return <Text>{`${e.props.word}${e.props.suffix}`}</Text>
  })
  on('ui.render', { component: 'AbovePrompt' }, ($, e) => {
    const { Box } = $.ui.resolve(e)
    return <Box />
  })
  return clock
}

const command = (args: string, name = 'breathe') =>
  ({
    command: name,
    args,
    origin: { kind: 'composer' },
    presentation: { isFullscreen: true, columns: 120 },
  }) as const

const plan = (p: Partial<Plan>): Plan => ({ startedAt: T0, total: 4, done: 0, ...p })

// Every string the English table holds, functions called with sample arguments
const texts = (value: unknown): string[] => {
  if (typeof value === 'string') return [value]
  if (value instanceof RegExp) return [value.source]
  if (typeof value === 'function') return [String((value as (...args: unknown[]) => unknown)(1, 2, 3))]
  if (typeof value === 'object' && value !== null) return Object.values(value).flatMap(texts)
  return []
}

const keysOf = (value: unknown): string[] =>
  typeof value === 'object' && value !== null && !(value instanceof RegExp) && !Array.isArray(value)
    ? Object.entries(value).flatMap(([key, inner]) => [key, ...keysOf(inner).map(k => `${key}.${k}`)])
    : []

describe('language', () => {
  test('English unless HUD_LANG starts with zh', () => {
    expect(langOf(undefined)).toBe('en')
    expect(langOf('')).toBe('en')
    expect(langOf('en')).toBe('en')
    expect(langOf('zh')).toBe('zh')
    expect(langOf('zh-CN')).toBe('zh')
    expect(langOf('ZH_tw')).toBe('zh')
  })

  test('both tables have the same entries, and the English one holds no Chinese', () => {
    expect(keysOf(zh).sort()).toEqual(keysOf(en).sort())
    const english = texts(en)
    expect(english.length).toBeGreaterThan(50)
    expect(english.filter(text => CJK.test(text))).toEqual([])
    expect(texts(zh).some(text => CJK.test(text))).toBe(true)
  })
})

describe('estimates', () => {
  test('with no step done, the estimate is the model’s', () => {
    const p = plan({ guessAt: T0, guessMs: 10 * MIN })
    expect(estimateFinish(p, T0)).toBe(T0 + 10 * MIN)
  })

  test('halfway, the pace counts a quarter; near the end, most', () => {
    // 2 of 4 steps in 4 minutes: by pace T0+8, by the estimate T0+10; a quarter and three quarters is T0+9.5
    const p = plan({ done: 2, guessAt: T0, guessMs: 10 * MIN })
    expect(estimateFinish(p, T0 + 4 * MIN)).toBe(T0 + 9.5 * MIN)
    // 3 of 4 in 6 minutes: by pace T0+8; 9/16 of that and 7/16 of T0+10 is T0+8.875
    expect(estimateFinish({ ...p, done: 3 }, T0 + 6 * MIN)).toBe(T0 + 8.875 * MIN)
  })

  test('with no minutes given, the pace alone', () => {
    expect(estimateFinish(plan({ done: 1 }), T0 + 2 * MIN)).toBe(T0 + 8 * MIN)
  })

  test('when late, it says by how much', () => {
    const p = plan({ done: 3, finishAt: T0 + 5 * MIN })
    expect(describeEta(p, T0 + 7 * MIN, en)).toBe('▰▰▰▱ · 2 min over')
    expect(describeEta(p, T0 + 7 * MIN, zh)).toBe('▰▰▰▱ · 超时 2 分钟')
    expect(describeEta(p, T0 + 4.5 * MIN, en)).toBe('▰▰▰▱')
  })

  test('one estimate at the start, then only the cells while on time', () => {
    expect(describeEta(plan({ finishAt: T0 + 6 * MIN }), T0, en)).toBe('▱▱▱▱ · est 6 min')
    expect(describeEta(plan({ finishAt: T0 + 6 * MIN }), T0, zh)).toBe('▱▱▱▱ · 预估 6 分钟')
    expect(describeEta(plan({ finishAt: T0 + 20 * MIN }), T0, en)).toMatch(/^▱▱▱▱ · est 20 min · \d\d:\d\d$/)
    expect(describeEta(plan({ done: 1, finishAt: T0 + 6 * MIN }), T0, en)).toBe('▰▱▱▱')
    expect(describeEta(plan({ done: 2, total: 9 }), T0, en)).toBe('2/9')
  })

  test('fewer than 3 past ratios change nothing; then the median counts', () => {
    expect(factorOf([3, 3])).toBe(1)
    expect(factorOf([1, 2, 5])).toBe(2)
    expect(factorOf([0.2, 0.25, 0.3])).toBe(0.25)
    expect(factorOf([0.05, 0.05, 0.05])).toBe(0.1)
    expect(ratioOf(1 * MIN, 20 * MIN)).toBe(0.05)
    expect(ratioOf(1 * MIN, 100 * MIN)).toBe(0.05)
  })
})

describe('breathing rhythm', () => {
  test('a lead-in, in 5.5 s and out 5.5 s five times, then done', () => {
    expect(breathAt(0)).toMatchObject({ stage: 'intro', step: 'intro', fill: 0 })
    expect(breathAt(INTRO_MS)).toMatchObject({ step: 'inhale', seconds: 6, fill: 0, cycle: 1 })
    expect(breathAt(INTRO_MS + 5500)).toMatchObject({ step: 'exhale', seconds: 6, fill: 1, cycle: 1 })
    expect(breathAt(INTRO_MS + 11_000).cycle).toBe(2)
    expect(breathAt(INTRO_MS + PRACTICE_MS)).toMatchObject({ stage: 'done', step: 'done' })
  })

  test('the words, in English and in Chinese', () => {
    expect(restWord(breathAt(0), en)).toBe('Breathe with the line')
    expect(restWord(breathAt(INTRO_MS), en)).toBe('Breathe in 6s')
    expect(restWord(breathAt(INTRO_MS + 5500), en)).toBe('Breathe out 6s')
    expect(restWord(breathAt(INTRO_MS), zh)).toBe('吸气 6 秒')
    expect(restWord(breathAt(INTRO_MS + PRACTICE_MS), zh)).toBe('做完了')
  })

  test('the line keeps its width and centre, and moves by half cells', () => {
    const widths = new Set<number>()
    const starts = new Set<number>()
    for (let i = 0; i <= 40; i++) {
      const b = breathBar(i / 40, 80)
      widths.add(b.trackLeft.length + b.lit.length + b.trackRight.length)
      starts.add(b.indent.length)
      expect(b.trackLeft.length).toBe(b.trackRight.length)
    }
    expect([...widths]).toEqual([48])
    expect([...starts]).toEqual([16])
    expect(breathBar(0, 80).lit).toBe('')
    expect(breathBar(1, 80).lit).toBe('━'.repeat(48))
    expect(breathBar(1 / 48, 80).lit).toBe('╺╸')
  })
})

describe('which break comes next', () => {
  const k = (kind: 'breath' | 'eyes' | 'pushups', lastAt: number | undefined, intervalMin = 30, isOn = true) => ({
    kind,
    lastAt,
    intervalMin,
    isOn,
  })

  test('none within 5 minutes of any break', () => {
    expect(pickDue(T0, [k('breath', T0 - 60 * MIN), k('eyes', T0 - 3 * MIN, 20)])).toBeUndefined()
  })

  test('of those due, the most overdue for its own interval', () => {
    // breathing is 40/30 = 1.33 intervals late, eyes 30/20 = 1.5
    expect(pickDue(T0, [k('breath', T0 - 40 * MIN), k('eyes', T0 - 30 * MIN, 20)])).toBe('eyes')
    expect(pickDue(T0, [k('breath', T0 - 40 * MIN), k('eyes', T0 - 30 * MIN, 20, false)])).toBe('breath')
  })

  test('eyes and push-ups count down from full to empty', () => {
    expect(restAt('eyes', 0)).toMatchObject({ stage: 'active', step: 'look', seconds: 20, fill: 1 })
    expect(restWord(restAt('eyes', 0), en)).toBe('Look away 20s')
    expect(restWord(restAt('eyes', 0), zh)).toBe('看远处 20 秒')
    expect(restAt('pushups', 30_000)).toMatchObject({ step: 'pushups', seconds: 30, fill: 0.5 })
    expect(restWord(restAt('pushups', 30_000), zh)).toBe('俯卧撑 30 秒')
    expect(restAt('eyes', 20_000).stage).toBe('done')
  })
})

describe('progress and breaks', () => {
  test('progress: the spinner shows the step; the task row shows the steps and the estimate', async ($, on) => {
    engine(on)
    await $.session.start(START)
    await $.turn.start({ text: 'change it', turnId: 't1' })

    const r = await $.tool.call({ tool: TOOL, done: 0, total: 4, minutes: 10, step: 'read code' })
    expect(JSON.stringify(r)).toContain('Noted 0/4.')

    const spinner = await $.ui.mount({ ...SPINNER, surface: 'terminal' })
    expect(await spinner.find({ type: 'Text', text: 'read code…' })).toBeDefined()
    await spinner.unmount()

    for (const surface of ['terminal', 'desktop'] as const) {
      const band = await $.ui.mount({ ...BAND, surface })
      expect(await band.find({ type: 'Text', text: 'task    ' })).toBeDefined()
      expect(await band.find({ type: 'Text', text: /^read code ▱▱▱▱ · est 10 min · \d\d:\d\d$/ })).toBeDefined()
      await band.unmount()
    }
  })

  test('HUD_LANG=zh: the task row and the tool answer are in Chinese', async ($, on) => {
    engine(on, {}, {}, ZH)
    await $.session.start(START)
    await $.turn.start({ text: '改一下', turnId: 't1' })

    const r = await $.tool.call({ tool: TOOL, done: 0, total: 4, minutes: 10, step: '读代码' })
    expect(JSON.stringify(r)).toContain('已记下 0/4。')

    const band = await $.ui.mount({ ...BAND, surface: 'terminal' })
    expect(await band.find({ type: 'Text', text: /^读代码 ▱▱▱▱ · 预估 10 分钟 · \d\d:\d\d$/ })).toBeDefined()
    await band.unmount()
  })

  // What session.start registers: the progress tool and five commands, in the chosen language
  const registered = async ($: Engine, on: On, env: Record<string, string>) => {
    const tools: { description: string; inputSchema: unknown }[] = []
    const commands: { name: string; description: string; argumentHint?: string }[] = []
    mock.clock(on, { now: T0 })
    mock.env(on, { HOME: '/home/u', ...env })
    mock.store(on, RECENT)
    on('session.start', (_, e) => ({ cwd: e.cwd }))
    on('session.cwd', () => ({ value: '/r' }))
    on('process.run', () => ran('', 128))
    on('tool.register', (_, e) => {
      tools.push(e)
      return { value: { tool: `mcp__hud__${e.name}` } }
    })
    on('command.register', (_, e) => {
      commands.push(e)
      return { value: { command: e.name } }
    })
    await $.session.start(START)
    const words = [
      tools[0]?.description ?? '',
      JSON.stringify(tools[0]?.inputSchema),
      ...commands.map(c => c.description + (c.argumentHint ?? '')),
    ]
    return { tools, commands, words }
  }

  test('the tool and the commands are registered in English by default', async ($, on) => {
    const { tools, commands, words } = await registered($, on, {})
    expect(commands.map(c => c.name)).toEqual(['breathe', 'eyes', 'pushups', 'autonext', 'donelog'])
    expect(tools[0]?.description).toContain("Report this turn's progress")
    expect(JSON.stringify(tools[0]?.inputSchema)).toContain('Steps finished so far')
    expect(words.filter(w => CJK.test(w))).toEqual([])
  })

  test('HUD_LANG=zh: the tool and the commands are registered in Chinese', async ($, on) => {
    const { tools, commands } = await registered($, on, { HUD_LANG: 'zh' })
    expect(commands.map(c => c.name)).toEqual(['breathe', 'eyes', 'pushups', 'autonext', 'donelog'])
    expect(tools[0]?.description).toContain('向操作者报告')
    expect(commands.every(c => CJK.test(c.description))).toBe(true)
  })

  test('only a turn with every step done is learned from', async ($, on) => {
    // Two past ratios: not enough yet, so estimates are taken as given
    const clock = engine(on, { ratios: [0.25, 0.25] })
    await $.session.start(START)
    const shows = async (text: RegExp) => {
      const band = await $.ui.mount({ ...BAND, surface: 'terminal' })
      const found = await band.find({ type: 'Text', text })
      await band.unmount()
      return found !== undefined
    }

    // Stopped at 1 of 3: not learned from, so the next estimate is still taken as given
    await $.turn.start({ text: 'change it', turnId: 't1' })
    await $.tool.call({ tool: TOOL, done: 0, total: 3, minutes: 20 })
    await clock.advance(MIN)
    await $.tool.call({ tool: TOOL, done: 1, total: 3 })
    await $.turn.complete(DONE)

    await $.turn.start({ text: 'go on', turnId: 't2' })
    await $.tool.call({ tool: TOOL, done: 0, total: 3, minutes: 20 })
    expect(await shows(/▱▱▱ · est 20 min/)).toBe(true)
    // This one finishes: a third ratio, and the median 0.25 now scales estimates to a quarter
    await clock.advance(MIN)
    await $.tool.call({ tool: TOOL, done: 3, total: 3 })
    await $.turn.complete({ ...DONE, turnId: 't2' })

    await $.turn.start({ text: 'and more', turnId: 't3' })
    await $.tool.call({ tool: TOOL, done: 0, total: 3, minutes: 20 })
    expect(await shows(/▱▱▱ · est 5 min/)).toBe(true)
  })

  test('a past habit of estimating half the time doubles the next estimate', async ($, on) => {
    engine(on, { ratios: [2, 2, 2] })
    await $.session.start(START)
    await $.turn.start({ text: 'change it', turnId: 't1' })

    await $.tool.call({ tool: TOOL, done: 0, total: 3, minutes: 5 })

    const band = await $.ui.mount({ ...BAND, surface: 'terminal' })
    expect(await band.find({ type: 'Text', text: /▱▱▱ · est 10 min/ })).toBeDefined()
    await band.unmount()
  })

  test('when the turn ends, progress clears: the spinner word is back and the task row goes', async ($, on) => {
    engine(on)
    await $.session.start(START)
    await $.turn.start({ text: 'change it', turnId: 't1' })
    await $.tool.call({ tool: TOOL, done: 0, total: 2, minutes: 3 })
    await $.turn.complete(DONE)

    const ui = await $.ui.mount({ ...SPINNER, surface: 'terminal' })
    expect(await ui.find({ type: 'Text', text: 'Sauteing…' })).toBeDefined()
    await ui.unmount()

    const band = await $.ui.mount({ ...BAND, surface: 'terminal' })
    expect(await band.find({ type: 'Text', text: 'task    ' })).toBeUndefined()
    await band.unmount()
  })

  test('with the progress tool in the request, the system prompt ends with how to report progress', async ($, on) => {
    on('prompt.compose', () => ({ sections: [{ id: 'intro', text: '…', scope: 'shared' }] }))

    const request = {
      model: 'claude-opus-5-5',
      promptModel: 'claude-opus-5-5',
      surfaces: ['terminal'],
      outputStyle: null,
      traits: [],
    } as const

    const withTool = await $.prompt.compose({ ...request, tools: ['Bash', TOOL] })
    expect(withTool.sections.at(-1)).toMatchObject({ id: 'hud:progress', scope: 'session' })
    expect(withTool.sections.at(-1)?.text).toContain('err on the long side')
    expect(CJK.test(withTool.sections.at(-1)?.text ?? '')).toBe(false)

    const without = await $.prompt.compose({ ...request, tools: ['Bash'] })
    expect(without.sections.map(s => s.id)).toEqual(['intro'])
  })

  test('HUD_LANG=zh: the system prompt section is in Chinese', async ($, on) => {
    mock.env(on, { HUD_LANG: 'zh' })
    on('prompt.compose', () => ({ sections: [] }))
    const composed = await $.prompt.compose({
      model: 'claude-opus-5-5',
      promptModel: 'claude-opus-5-5',
      surfaces: ['terminal'],
      outputStyle: null,
      traits: [],
      tools: [TOOL],
    })
    expect(composed.sections.at(-1)?.text).toContain('宁可估长')
  })

  test('bad arguments are refused with how to fill them', async ($, on) => {
    engine(on)
    await $.session.start(START)

    const result = await $.tool.call({ tool: TOOL, done: 'a', total: 0 })
    expect(result.deny).toContain('total')
    expect(result.deny).toContain('integer')
  })

  test('after 20 seconds of waiting, with breathing due, the breathing line starts above the prompt', async ($, on) => {
    const clock = engine(on, { lastBreathAt: T0 - 31 * MIN })
    await $.session.start(START)
    await $.turn.start({ text: 'change it', turnId: 't1' })

    await clock.advance(10_000)
    const early = await $.ui.mount({ ...BAND, surface: 'terminal' })
    expect(await early.find({ type: 'Client' })).toBeUndefined()
    await early.unmount()

    await clock.advance(10_000)
    const band = await $.ui.mount({ ...BAND, surface: 'terminal' })
    const client = await band.find({ type: 'Client' })
    expect(client).toBeDefined()
    // At first, time to find the line
    expect(await band.find({ type: 'Text', text: /Breathe with the line · \/breathe to stop/, in: client?.key })).toBeDefined()

    // The word the animation reports shows on the spinner line
    await band.post({ word: 'Breathe out 3s' })
    const spinner = await $.ui.mount({ ...SPINNER, surface: 'terminal' })
    expect(await spinner.find({ type: 'Text', text: 'Breathe out 3s…' })).toBeDefined()
    await spinner.unmount()
    await band.unmount()

    // It closes by itself after a minute
    await clock.advance(BREATH_MS)
    const after = await $.ui.mount({ ...BAND, surface: 'terminal' })
    expect(await after.find({ type: 'Client' })).toBeUndefined()
    await after.unmount()
  })

  test('HUD_LANG=zh: the breathing line speaks Chinese', async ($, on) => {
    const clock = engine(on, { lastBreathAt: T0 - 31 * MIN }, {}, ZH)
    await $.session.start(START)
    await $.turn.start({ text: '改一下', turnId: 't1' })
    await clock.advance(20_000)

    const band = await $.ui.mount({ ...BAND, surface: 'terminal' })
    const client = await band.find({ type: 'Client' })
    expect(await band.find({ type: 'Text', text: /跟着线呼吸 · \/breathe 停止/, in: client?.key })).toBeDefined()
    await band.unmount()

    expect((await $.command.run(command('off', 'eyes'))).text).toContain('定时护眼提醒：关')
  })

  test('the reply arrives mid-breath: it goes on, and the caption says you can stop', async ($, on) => {
    const clock = engine(on)
    await $.session.start(START)
    await $.command.run(command(''))
    await $.turn.start({ text: 'change it', turnId: 't1' })
    await $.turn.complete(DONE)
    await clock.advance(10_000)

    const band = await $.ui.mount({ ...IDLE, surface: 'terminal' })
    const client = await band.find({ type: 'Client' })
    expect(client).toBeDefined()
    expect(
      await band.find({ type: 'Text', text: /Breathe (in|out) \d+s · Round \d\/5 · Reply is in, \/breathe to stop/, in: client?.key }),
    ).toBeDefined()
    await band.unmount()
  })

  test('eyes due: a 20-second countdown above the prompt that closes by itself', async ($, on) => {
    const clock = engine(on, { lastBreathAt: T0 - 10 * MIN, eyesLastAt: T0 - 21 * MIN })
    await $.session.start(START)
    await $.turn.start({ text: 'change it', turnId: 't1' })
    await clock.advance(20_000)

    const band = await $.ui.mount({ ...BAND, surface: 'terminal' })
    const client = await band.find({ type: 'Client' })
    expect(
      await band.find({ type: 'Text', text: /Look at something 20 ft \(6 m\) away, eyes off the screen · \/eyes to stop/, in: client?.key }),
    ).toBeDefined()
    await band.unmount()

    await clock.advance(REST.eyes.ms + 10_000)
    const after = await $.ui.mount({ ...BAND, surface: 'terminal' })
    expect(await after.find({ type: 'Client' })).toBeUndefined()
    await after.unmount()
  })

  test('/pushups starts now; /breathe during push-ups switches to breathing', async ($, on) => {
    engine(on)
    await $.session.start(START)

    expect((await $.command.run(command('', 'pushups'))).text).toContain('push-ups')
    const band = await $.ui.mount({ ...IDLE, surface: 'terminal' })
    const client = await band.find({ type: 'Client' })
    expect(await band.find({ type: 'Text', text: /Push-ups \d+s · Stand up and do 10 push-ups/, in: client?.key })).toBeDefined()
    await band.unmount()

    expect((await $.command.run(command(''))).text).toContain('breathing')
    const switched = await $.ui.mount({ ...BAND, surface: 'terminal' })
    const breathing = await switched.find({ type: 'Client' })
    expect(await switched.find({ type: 'Text', text: /Breathe with the line/, in: breathing?.key })).toBeDefined()
    await switched.unmount()

    expect((await $.command.run(command('off', 'eyes'))).text).toContain('Eye-break reminder: off')
  })

  test('without HUD_RESTS=on, nothing starts on its own', async ($, on) => {
    const clock = engine(on, { lastBreathAt: T0 - 31 * MIN }, {}, {})
    await $.session.start(START)
    await $.turn.start({ text: 'change it', turnId: 't1' })
    await clock.advance(25_000)
    const band = await $.ui.mount({ ...BAND, surface: 'terminal' })
    expect(await band.find({ type: 'Client' })).toBeUndefined()
    await band.unmount()
  })

  test('not due yet: no interruption', async ($, on) => {
    const clock = engine(on, { lastBreathAt: T0 - 10 * MIN })
    await $.session.start(START)
    await $.turn.start({ text: 'change it', turnId: 't1' })
    await clock.advance(60_000)

    const band = await $.ui.mount({ ...BAND, surface: 'terminal' })
    expect(await band.find({ type: 'Client' })).toBeUndefined()
    await band.unmount()
  })

  test('/breathe off stops the timer; /breathe still starts and stops by hand', async ($, on) => {
    const clock = engine(on)
    await $.session.start(START)

    const off = await $.command.run(command('off'))
    expect(off.text).toContain('Breathing reminder: off')

    await $.turn.start({ text: 'change it', turnId: 't1' })
    await clock.advance(30_000)
    const quiet = await $.ui.mount({ ...BAND, surface: 'terminal' })
    expect(await quiet.find({ type: 'Client' })).toBeUndefined()
    await quiet.unmount()

    const start = await $.command.run(command(''))
    expect(start.text).toContain('One minute of breathing')
    const band = await $.ui.mount({ ...BAND, surface: 'terminal' })
    expect(await band.find({ type: 'Client' })).toBeDefined()
    await band.unmount()

    const stop = await $.command.run(command(''))
    expect(stop.text).toBe('Breathing stopped.')

    const help = await $.command.run(command('sometimes'))
    expect(help.text).toContain('remind every 45 minutes')
  })
})

const TRANSCRIPT: SessionMessage[] = [
  { role: 'user', text: '<system-reminder>noise</system-reminder>rewrite the bookkeeping section', toolUses: [] },
  {
    role: 'assistant',
    text: 'ok',
    toolUses: [{ tool_use_id: 't1', tool: 'Edit', input: { file_path: '/repo/SKILL.md' } }],
  },
  { role: 'user', text: '<system-reminder>only a reminder</system-reminder>', toolUses: [] },
]

const ANSWERED = { result: {}, text: 'ok' } as never

const COMPACTED: SessionCompacted = {
  messages: [{ role: 'user', text: 'summary', toolUses: [] }],
  tokensBefore: 180_000,
  tokensAfter: 30_000,
}

describe('context and repos', () => {
  test('compaction: your own instructions first, the keep list after', async ($, on) => {
    mock.clock(on)
    let seen: SessionCompactInput | undefined
    on('session.compact', (_, e) => {
      seen = e
      return COMPACTED
    })

    const result = await $.session.compact({ trigger: 'manual', instructions: 'keep only the deploy plan', messages: TRANSCRIPT })

    expect(result.skip).toBeUndefined()
    expect(seen?.instructions?.startsWith('keep only the deploy plan')).toBe(true)
    expect(seen?.instructions).toContain('Authorization')
    expect(seen?.instructions).toContain('"open"')
  })

  test('HUD_LANG=zh: the keep list is in Chinese', async ($, on) => {
    mock.env(on, { HUD_LANG: 'zh' })
    let seen: SessionCompactInput | undefined
    on('session.compact', (_, e) => {
      seen = e
      return { messages: COMPACTED.messages }
    })

    await $.session.compact({ trigger: 'precompute', messages: TRANSCRIPT })

    expect(seen?.instructions).toContain('授权范围')
    expect(seen?.instructions).toContain('待定')
  })

  test('a precomputed summary gets the keep list too, but no note is saved', async ($, on) => {
    let seen: SessionCompactInput | undefined
    let writes = 0
    on('fs.write', () => {
      writes += 1
      return { value: undefined }
    })
    on('session.compact', (_, e) => {
      seen = e
      return { messages: COMPACTED.messages }
    })

    await $.session.compact({ trigger: 'precompute', messages: TRANSCRIPT })

    expect(seen?.instructions).toContain('Authorization')
    expect(writes).toBe(0)
  })

  test('a subagent’s own compaction is left alone', async ($, on) => {
    let seen: SessionCompactInput | undefined
    on('session.compact', (_, e) => {
      seen = e
      return COMPACTED
    })

    await $.session.compact({ trigger: 'auto', agentId: 'a1', messages: TRANSCRIPT })

    expect(seen?.instructions).toBeUndefined()
  })

  test('before a real compaction, your messages and the changed files are saved as a note', async ($, on) => {
    mock.clock(on, { now: Date.UTC(2026, 9, 1, 14, 2, 0) })
    mock.env(on, { ...ENV, HOME: '/home/u' })
    on('session.id', () => ({ value: 'sid-1' }))
    on('session.cwd', () => ({ value: '/repo' }))
    let written: { path: string; text: string } | undefined
    on('fs.write', (_, e) => {
      written = e
      return { value: undefined }
    })
    on('session.compact', () => COMPACTED)

    await $.session.compact({ trigger: 'auto', messages: TRANSCRIPT })

    expect(written?.path).toMatch(/^\/home\/u\/\.claude\/hud\/notes\/sid-1\/\d{8}-\d{6}\.md$/)
    expect(written?.text).toContain('# Before compaction')
    expect(written?.text).toContain('rewrite the bookkeeping section')
    expect(written?.text).not.toContain('noise')
    expect(written?.text).toContain('Your messages (1,')
    expect(written?.text).toContain('- /repo/SKILL.md')
  })

  test('the context reading is drawn above the prompt', async ($, on) => {
    mock.clock(on)
    on('session.measure', (_, e) => ({ changed: e.changed }))
    on('session.compact', () => COMPACTED)
    on('ui.render', { component: 'AbovePrompt' }, ($, e) => {
      const { Box } = $.ui.resolve(e)
      return <Box />
    })

    await $.session.measure({
      context: { tokens: 150_000, window: 200_000, percent: 75 },
      rateLimits: [{ kind: 'five_hour', percentUsed: 34 }],
      cost: { usd: 1.5 },
      changed: ['context', 'rateLimits', 'cost'],
    })
    await $.session.compact({ trigger: 'auto', messages: TRANSCRIPT })

    for (const surface of ['terminal', 'desktop'] as const) {
      const ui = await $.ui.mount({ ...BAND, surface })
      expect(await ui.find({ type: 'Text', text: 'context ' })).toBeDefined()
      expect(await ui.find({ type: 'Text', text: /75%/ })).toBeDefined()
      expect(await ui.find({ type: 'Text', text: /150k\/200k/ })).toBeDefined()
      expect(await ui.find({ type: 'Text', text: /5h 34%/ })).toBeDefined()
      expect(await ui.find({ type: 'Text', text: /compacted \d\d:\d\d 180k→30k/ })).toBeDefined()
      await ui.unmount()
    }
  })

  test('changed files are recorded by real path; the repo row counts whose changes they are', async ($, on) => {
    on('fs.stat', (_, e) => ({
      value: { kind: 'file', size: 1, mtimeMs: 0, isLink: false, realPath: e.path.replace('/link/', '/real/') },
    }))
    on('tool.call', () => ANSWERED)
    engine(
      on,
      {},
      {
        cwd: '/real/repo',
        run: argv =>
          argv[1] === 'rev-parse'
            ? ran('/real/repo\n/real/repo/.git\n/real/repo/.git\n')
            : ran('## main...origin/main [ahead 1, behind 3]\n M a.md\n?? new/b.md\n R  old.ts -> other.ts\n'),
      },
    )

    await $.tool.call({ tool: 'Edit', file_path: '/link/repo/a.md', old_string: 'x', new_string: 'y' })
    await $.tool.call({ tool: 'Write', file_path: '/link/repo/new/b.md', content: 'z' })
    await $.session.start({ cwd: '/real/repo', surface: 'terminal', isInteractive: true })

    for (const surface of ['terminal', 'desktop'] as const) {
      const ui = await $.ui.mount({ ...BAND, surface })
      expect(await ui.find({ type: 'Text', text: 'repo main ↑1↓3 · others 1 · mine 2' })).toBeDefined()
      expect(await ui.find({ type: 'Text', text: /context/ })).toBeUndefined()
      await ui.unmount()
    }
  })

  test('a worktree is marked, and a clean tree says so, in either language', async ($, on) => {
    const run: Run = argv =>
      argv[1] === 'rev-parse' ? ran('/wt/x\n/main/my-app/.git/worktrees/x\n/main/my-app/.git\n') : ran('## feat/y...origin/feat/y\n')
    engine(on, {}, { cwd: '/wt/x', run })

    await $.session.start({ cwd: '/wt/x', surface: 'terminal', isInteractive: true })

    const ui = await $.ui.mount({ ...BAND, surface: 'terminal' })
    expect(await ui.find({ type: 'Text', text: 'my-app feat/y (worktree) · clean' })).toBeDefined()
    await ui.unmount()
  })

  test('HUD_LANG=zh: the repo row in Chinese', async ($, on) => {
    const run: Run = argv => (argv[1] === 'rev-parse' ? ran('/r\n/r/.git\n/r/.git\n') : ran('## main\n'))
    engine(on, {}, { cwd: '/r', run }, ZH)

    await $.session.start(START)

    const ui = await $.ui.mount({ ...BAND, surface: 'terminal' })
    expect(await ui.find({ type: 'Text', text: 'r main · 干净' })).toBeDefined()
    await ui.unmount()
  })
})

describe('HUD rows', () => {
  test('the breaks row lists the soonest first and says when one is due', () => {
    const list = [
      { kind: 'eyes', leftMin: 0 },
      { kind: 'breath', leftMin: 12 },
    ] as const
    expect(describeDue(list, en)).toBe('eyes due · breathe 12m')
    expect(describeDue(list, zh)).toBe('护眼 到点 · 呼吸 12m')
  })

  test('context cells match /context: ⛁ full, ⛀ part, ⛶ empty', () => {
    expect(contextCells(0)).toEqual({ used: '', free: '⛶ ⛶ ⛶ ⛶ ⛶ ⛶ ⛶ ⛶ ⛶ ⛶' })
    expect(contextCells(11)).toEqual({ used: '⛁', free: '⛶ ⛶ ⛶ ⛶ ⛶ ⛶ ⛶ ⛶ ⛶' })
    expect(contextCells(15)).toEqual({ used: '⛁ ⛀', free: '⛶ ⛶ ⛶ ⛶ ⛶ ⛶ ⛶ ⛶' })
    expect(contextCells(18)).toEqual({ used: '⛁ ⛁', free: '⛶ ⛶ ⛶ ⛶ ⛶ ⛶ ⛶ ⛶' })
    expect(contextCells(100)).toEqual({ used: '⛁ ⛁ ⛁ ⛁ ⛁ ⛁ ⛁ ⛁ ⛁ ⛁', free: '' })
  })

  test('short of rows, breaks go first, then repo and task; context stays; the order holds', () => {
    const all = new Set(['context', 'repo', 'task', 'next'] as const)
    expect(fitRows(all, 10)).toEqual(['context', 'repo', 'task', 'next'])
    expect(fitRows(all, 3)).toEqual(['context', 'repo', 'task'])
    expect(fitRows(all, 2)).toEqual(['context', 'task'])
    expect(fitRows(all, 1)).toEqual(['context'])
    // The animation takes two rows and comes before task
    expect(fitRows(new Set(['context', 'repo', 'task', 'rest'] as const), 3)).toEqual(['context', 'rest'])
  })

  test('the breaks row: enabled breaks only, and the animation while one runs', async ($, on) => {
    // Breathing every 30 min, done 10 min ago; eyes every 20 and push-ups every 60, both 10 min ago
    engine(on, { lastBreathAt: T0 - 10 * MIN })
    await $.session.start(START)

    const band = await $.ui.mount({ ...IDLE, surface: 'terminal' })
    expect(await band.find({ type: 'Text', text: 'breaks  ' })).toBeDefined()
    expect(await band.find({ type: 'Text', text: 'eyes 10m · breathe 20m · push-ups 50m' })).toBeDefined()
    await band.unmount()

    await $.command.run(command('off', 'eyes'))
    const off = await $.ui.mount({ ...IDLE, surface: 'terminal' })
    expect(await off.find({ type: 'Text', text: 'breathe 20m · push-ups 50m' })).toBeDefined()
    await off.unmount()

    await $.command.run(command('', 'pushups'))
    const resting = await $.ui.mount({ ...IDLE, surface: 'terminal' })
    expect(await resting.find({ type: 'Client' })).toBeDefined()
    expect(await resting.find({ type: 'Text', text: 'breaks  ' })).toBeUndefined()
    await resting.unmount()
  })

  test('HUD_LANG=zh: the breaks row in Chinese', async ($, on) => {
    engine(on, { lastBreathAt: T0 - 10 * MIN }, {}, ZH)
    await $.session.start(START)

    const band = await $.ui.mount({ ...IDLE, surface: 'terminal' })
    expect(await band.find({ type: 'Text', text: 'next    ' })).toBeDefined()
    expect(await band.find({ type: 'Text', text: '护眼 10m · 呼吸 20m · 俯卧撑 50m' })).toBeDefined()
    await band.unmount()
  })
})

describe('the recap after you have been away', () => {
  const REPLY = 'Goal: add a return recap to the HUD\nLast: tests written, not run yet\nNext: run plugin test'

  test('20 minutes after the last turn, goal / last / next appear; a new turn clears them', async ($, on) => {
    const clock = engine(on, AUTO_OFF)
    const asks: string[] = []
    on('model.fork', (_, e) => {
      asks.push(e.prompt)
      return { value: { isAnswered: true, text: REPLY, usage: USAGE } }
    })
    await $.session.start(START)
    await $.turn.start({ text: 'change it', turnId: 't1' })
    await $.turn.complete(DONE)

    await clock.advance(19 * MIN)
    const early = await $.ui.mount({ ...IDLE, surface: 'terminal' })
    expect(await early.find({ type: 'Text', text: 'recap   ' })).toBeUndefined()
    await early.unmount()
    expect(asks).toHaveLength(0)

    await clock.advance(MIN)
    const band = await $.ui.mount({ ...IDLE, surface: 'terminal' })
    expect(await band.find({ type: 'Text', text: 'recap   ' })).toBeDefined()
    expect(await band.find({ type: 'Text', text: 'Goal: add a return recap to the HUD' })).toBeDefined()
    expect((await band.find({ type: 'Text', text: ' Next ' }))?.props).toMatchObject({ inverse: true, bold: true })
    expect((await band.find({ type: 'Text', text: ' run plugin test' }))?.props).toMatchObject({ bold: true, color: 'cyan' })
    await band.unmount()

    // Asked once, however long you stay away
    await clock.advance(30 * MIN)
    expect(asks).toHaveLength(1)
    expect(asks[0]).toContain('Next:')
    expect(asks[0]).toContain('Safe to close')
    expect(CJK.test(asks[0] ?? '')).toBe(false)

    await $.turn.start({ text: 'go on', turnId: 't2' })
    const back = await $.ui.mount({ ...BAND, surface: 'terminal' })
    expect(await back.find({ type: 'Text', text: 'recap   ' })).toBeUndefined()
    await back.unmount()
  })

  test('HUD_LANG=zh: the recap is asked for and drawn in Chinese', async ($, on) => {
    const clock = engine(on, AUTO_OFF, {}, ZH)
    const asks: string[] = []
    on('model.fork', (_, e) => {
      asks.push(e.prompt)
      return { value: { isAnswered: true, text: '在做：给 HUD 加回来时的提示\n停在：测试写完了，还没跑\n下一步：跑 plugin test', usage: USAGE } }
    })
    await $.session.start(START)
    await $.turn.start({ text: '改一下', turnId: 't1' })
    await $.turn.complete(DONE)
    await clock.advance(20 * MIN)

    expect(asks[0]).toContain('下一步')
    expect(asks[0]).toContain('可以关')
    const band = await $.ui.mount({ ...IDLE, surface: 'terminal' })
    expect(await band.find({ type: 'Text', text: '在做：给 HUD 加回来时的提示' })).toBeDefined()
    expect((await band.find({ type: 'Text', text: ' 下一步 ' }))?.props).toMatchObject({ inverse: true, bold: true })
    expect((await band.find({ type: 'Text', text: ' 跑 plugin test' }))?.props).toMatchObject({ bold: true, color: 'cyan' })
    await band.unmount()
  })

  test('no turn yet, no recap', async ($, on) => {
    const clock = engine(on, AUTO_OFF)
    let asked = 0
    on('model.fork', () => {
      asked += 1
      return { value: { isAnswered: false, reason: 'nothing-to-fork' } }
    })
    await $.session.start(START)
    await clock.advance(40 * MIN)
    expect(asked).toBe(0)
  })

  test('a -p session: no recap, even with auto whats-next off', async ($, on) => {
    const clock = engine(on, AUTO_OFF)
    let asked = 0
    on('model.fork', () => {
      asked += 1
      return { value: { isAnswered: true, text: REPLY, usage: USAGE } }
    })
    await $.session.start({ cwd: '/r', surface: null, isInteractive: false })
    await $.turn.start({ text: 'change it', turnId: 't1' })
    await $.turn.complete(DONE)
    await clock.advance(40 * MIN)
    expect(asked).toBe(0)
  })

  test('replies off the format are still read; markdown is dropped', () => {
    expect(parseRecap('- **Goal**: A\n- **Last**: B\n- **Next**: C\nmore words', en)).toEqual(['Goal: A', 'Last: B', 'Next: C'])
    expect(parseRecap('- **在做**：A\n- **停在**：B\n- **下一步**：C\n多余的话', zh)).toEqual(['在做：A', '停在：B', '下一步：C'])
    expect(parseRecap('one\n\ntwo\nthree\nfour', en)).toEqual(['one', 'two', 'three'])
  })

  test('only a next step of "Safe to close" can be closed; any other next step is not done', () => {
    expect(isClosable('Next: Safe to close', en)).toBe(true)
    expect(isClosable('Next: safe to close.', en)).toBe(true)
    expect(isClosable('Next: commit, then safe to close', en)).toBe(false)
    expect(isClosable('Last: safe to close', en)).toBe(false)
    expect(isClosable('下一步：可以关', zh)).toBe(true)
    expect(isClosable('下一步：提交到 dotfiles', zh)).toBe(false)
    expect(isClosable('停在：可以关', zh)).toBe(false)
  })

  test('the next step’s color: green to close, yellow to keep open, cyan otherwise', () => {
    expect(nextTone('Next: Safe to close', en)).toBe('green')
    expect(nextTone("Next: Don't close: the deploy is still running", en)).toBe('yellow')
    expect(nextTone('Next: run plugin test', en)).toBe('cyan')
    expect(nextTone('下一步：可以关', zh)).toBe('green')
    expect(nextTone('下一步：别关，等明早回读首跑', zh)).toBe('yellow')
    expect(nextTone('下一步：跑 plugin test', zh)).toBe('cyan')
  })

  test('the recap stays before the breaks and the repo', () => {
    const wanted = new Set(['context', 'repo', 'recap', 'next'] as const)
    expect(fitRows(wanted, 4, 3)).toEqual(['context', 'recap'])
    expect(fitRows(wanted, 6, 3)).toEqual(['context', 'repo', 'recap', 'next'])
  })
})

describe('whats-next after you step away', () => {
  const RECAP = 'Goal: rework auto whats-next\nLast: code changed\nNext: run plugin test'

  // The prompt box, the commands available, and what the HUD ran
  const box = (
    on: On,
    options: { draft?: string; agents?: { status: string }[]; commands?: string[] } = {},
  ) => {
    const sent: string[] = []
    const asks: string[] = []
    const logs: { text: string; to: string }[] = []
    on('model.fork', (_, e) => {
      asks.push(e.prompt)
      return { value: { isAnswered: true, text: RECAP, usage: USAGE } }
    })
    on('agent.list', () =>
      ({
        value: (options.agents ?? []).map((a, i) => ({ id: `a${i}`, description: 'look', type: 'Explore', status: a.status })),
      }) as never,
    )
    on('command.list', () => ({
      value: (options.commands ?? ['whats-next']).map(name => ({ name, description: '', source: 'user' as const })),
    }))
    on('prompt.read', () => ({ value: { text: options.draft ?? '', cursor: (options.draft ?? '').length } }))
    on('prompt.submit', (_, e) => ({ text: e.text, origin: e.origin }))
    on('command.run', (_, e) => {
      if (e.origin.kind === 'plugin') sent.push(`/${e.command}${e.args ? ` ${e.args}` : ''}`)
      return { text: '' }
    })
    on('ui.log', (_, e) => {
      logs.push(e)
      return { value: undefined }
    })
    return { sent, asks, logs }
  }

  test('10 minutes after the last turn, /whats-next runs once, however long you stay away', async ($, on) => {
    const clock = engine(on)
    const { sent } = box(on)
    await $.session.start(START)
    await $.turn.start({ text: 'change it', turnId: 't1' })
    await $.turn.complete(DONE)

    await clock.advance(9 * MIN + 50_000)
    expect(sent).toEqual([])
    await clock.advance(10_000)
    expect(sent).toEqual(['/whats-next'])
    await clock.advance(30 * MIN)
    expect(sent).toEqual(['/whats-next'])
  })

  test('installed through a plugin, /yskills:whats-next runs', async ($, on) => {
    const clock = engine(on)
    const { sent } = box(on, { commands: ['compact', 'yskills:whats-next', 'yskills:stale-check'] })
    await $.session.start(START)
    await $.turn.start({ text: 'change it', turnId: 't1' })
    await $.turn.complete(DONE)
    await clock.advance(10 * MIN + 10_000)
    expect(sent).toEqual(['/yskills:whats-next'])
  })

  test('with both installed, the plain /whats-next wins', async ($, on) => {
    const clock = engine(on)
    const { sent } = box(on, { commands: ['yskills:whats-next', 'whats-next'] })
    await $.session.start(START)
    await $.turn.start({ text: 'change it', turnId: 't1' })
    await $.turn.complete(DONE)
    await clock.advance(10 * MIN + 10_000)
    expect(sent).toEqual(['/whats-next'])
  })

  test('HUD_WHATS_NEXT_COMMAND picks the command, arguments included', async ($, on) => {
    const clock = engine(on, {}, {}, { ...ENV, HUD_WHATS_NEXT_COMMAND: '/my-next --short' })
    const { sent } = box(on, { commands: ['whats-next'] })
    await $.session.start(START)
    await $.turn.start({ text: 'change it', turnId: 't1' })
    await $.turn.complete(DONE)
    await clock.advance(10 * MIN + 10_000)
    expect(sent).toEqual(['/my-next --short'])

    const state = await $.command.run(command('', 'autonext'))
    expect(state.text).toContain('/my-next --short runs')
  })

  test('no whats-next installed: nothing runs, the recap still shows, and nothing is logged to the transcript', async ($, on) => {
    const clock = engine(on)
    const { sent, asks, logs } = box(on, { commands: ['compact', 'yskills:stale-check'] })
    await $.session.start(START)
    await $.turn.start({ text: 'change it', turnId: 't1' })
    await $.turn.complete(DONE)
    await clock.advance(10 * MIN + 10_000)
    expect(sent).toEqual([])

    const band = await $.ui.mount({ ...IDLE, surface: 'terminal' })
    expect(await band.find({ type: 'Text', text: 'Goal: rework auto whats-next' })).toBeDefined()
    await band.unmount()

    await clock.advance(60 * MIN)
    expect(sent).toEqual([])
    expect(asks).toHaveLength(1)
    // One quiet line in the debug log for the whole absence; nothing in the transcript
    expect(logs.filter(l => l.to !== 'debug')).toEqual([])
    expect(logs.filter(l => l.text.includes('no whats-next'))).toHaveLength(1)

    const state = await $.command.run(command('', 'autonext'))
    expect(state.text).toContain('no whats-next command was found')
  })

  test('the recap is written first; it stays through the automatic turn and goes when you type', async ($, on) => {
    const clock = engine(on)
    const { sent } = box(on)
    await $.session.start(START)
    await $.turn.start({ text: 'change it', turnId: 't1' })
    await $.turn.complete(DONE)
    await clock.advance(10 * MIN + 10_000)
    expect(sent).toEqual(['/whats-next'])

    // The automatic turn: the recap is there while the questions are open
    await $.turn.start({ text: '/whats-next', turnId: 't2' })
    const asking = await $.ui.mount({ ...BAND, surface: 'terminal' })
    expect(await asking.find({ type: 'Text', text: 'Goal: rework auto whats-next' })).toBeDefined()
    await asking.unmount()
    await $.turn.complete({ ...DONE, turnId: 't2' })
    const after = await $.ui.mount({ ...IDLE, surface: 'terminal' })
    expect((await after.find({ type: 'Text', text: ' run plugin test' }))?.props).toMatchObject({ bold: true })
    await after.unmount()

    // You type and start a turn: it goes
    await $.prompt.submit({ text: 'go on', origin: { kind: 'composer' }, wait: false })
    await $.turn.start({ text: 'go on', turnId: 't3' })
    const back = await $.ui.mount({ ...BAND, surface: 'terminal' })
    expect(await back.find({ type: 'Text', text: 'recap   ' })).toBeUndefined()
    await back.unmount()
  })

  test('an answered question followed by work clears the recap; "leave it" or a look before asking keeps it', async ($, on) => {
    const clock = engine(on)
    const { sent } = box(on)
    on('tool.call', () => ({ result: 'ok' }))
    const hasRecap = async () => {
      const band = await $.ui.mount({ ...IDLE, surface: 'terminal' })
      const found = (await band.find({ type: 'Text', text: 'recap   ' })) !== undefined
      await band.unmount()
      return found
    }
    await $.session.start(START)
    await $.turn.start({ text: 'change it', turnId: 't1' })
    await $.turn.complete(DONE)
    await clock.advance(10 * MIN + 10_000)
    expect(sent).toEqual(['/whats-next'])

    // The automatic turn: a look at git, then the questions; you pick "leave it"
    await $.turn.start({ text: '/whats-next', turnId: 't2' })
    await $.tool.call({ tool: 'Bash', command: 'git status' })
    expect(await hasRecap()).toBe(true)
    await $.tool.call({ tool: 'AskUserQuestion', questions: [] })
    await $.turn.complete({ ...DONE, turnId: 't2' })
    expect(await hasRecap()).toBe(true)

    // Another pick, this time one that starts work: the next tool call clears it
    await $.turn.start({ text: '/whats-next', turnId: 't3' })
    await $.tool.call({ tool: 'AskUserQuestion', questions: [] })
    expect(await hasRecap()).toBe(true)
    await $.tool.call({ tool: 'Bash', command: 'git status' })
    expect(await hasRecap()).toBe(false)
    await $.turn.complete({ ...DONE, turnId: 't3' })
    expect(await hasRecap()).toBe(false)
  })

  test('questions closed unanswered: the next tool call keeps the recap', async ($, on) => {
    const clock = engine(on)
    box(on)
    on('tool.call', (_, e) => (e.tool === 'AskUserQuestion' ? { result: '', isError: true } : { result: 'ok' }))
    await $.session.start(START)
    await $.turn.start({ text: 'change it', turnId: 't1' })
    await $.turn.complete(DONE)
    await clock.advance(10 * MIN + 10_000)
    await $.turn.start({ text: '/whats-next', turnId: 't2' })
    await $.tool.call({ tool: 'AskUserQuestion', questions: [] })
    await $.tool.call({ tool: 'Bash', command: 'git status' })
    await $.turn.complete({ ...DONE, turnId: 't2' })
    const band = await $.ui.mount({ ...IDLE, surface: 'terminal' })
    expect(await band.find({ type: 'Text', text: 'recap   ' })).toBeDefined()
    await band.unmount()
  })

  test('a half-typed prompt: nothing runs', async ($, on) => {
    const clock = engine(on)
    const { sent } = box(on, { draft: 'half a thought' })
    await $.session.start(START)
    await $.turn.start({ text: 'change it', turnId: 't1' })
    await $.turn.complete(DONE)
    await clock.advance(20 * MIN)
    expect(sent).toEqual([])
  })

  test('a -p session: nothing runs', async ($, on) => {
    const clock = engine(on)
    const { sent } = box(on)
    await $.session.start({ cwd: '/r', surface: null, isInteractive: false })
    await $.turn.start({ text: 'change it', turnId: 't1' })
    await $.turn.complete(DONE)
    await clock.advance(20 * MIN)
    expect(sent).toEqual([])
  })

  test('no turn yet: nothing runs', async ($, on) => {
    const clock = engine(on)
    const { sent } = box(on)
    await $.session.start(START)
    await clock.advance(20 * MIN)
    expect(sent).toEqual([])
  })

  test('/autonext off stops it; /autonext 5 waits 5 minutes', async ($, on) => {
    const clock = engine(on)
    const { sent } = box(on)
    await $.session.start(START)
    const off = await $.command.run(command('off', 'autonext'))
    expect(off.text).toContain('Auto whats-next: off')
    await $.turn.start({ text: 'change it', turnId: 't1' })
    await $.turn.complete(DONE)
    await clock.advance(20 * MIN)
    expect(sent).toEqual([])

    await $.command.run(command('on', 'autonext'))
    const five = await $.command.run(command('5', 'autonext'))
    expect(five.text).toContain('After 5 minutes away the recap shows, then /whats-next runs')
    await $.turn.start({ text: 'again', turnId: 't2' })
    await $.turn.complete({ ...DONE, turnId: 't2' })
    await clock.advance(4 * MIN)
    expect(sent).toEqual([])
    await clock.advance(MIN + 10_000)
    expect(sent).toEqual(['/whats-next'])
  })

  test('HUD_LANG=zh: /autonext answers in Chinese', async ($, on) => {
    engine(on, {}, {}, ZH)
    box(on)
    await $.session.start(START)
    const five = await $.command.run(command('5', 'autonext'))
    expect(five.text).toContain('离开 5 分钟')
    expect(five.text).toContain('/whats-next')
  })

  test('after one run, whatever you picked, it waits until you type something else', async ($, on) => {
    const clock = engine(on)
    const { sent } = box(on)
    on('tool.call', () => ({ result: 'ok' }))
    await $.session.start(START)
    await $.turn.start({ text: 'change it', turnId: 't1' })
    await $.turn.complete(DONE)
    await clock.advance(10 * MIN + 10_000)
    expect(sent).toHaveLength(1)

    // The automatic turn: the questions, you pick "leave it", the turn ends
    await $.turn.start({ text: '/whats-next', turnId: 't2' })
    await $.tool.call({ tool: 'AskUserQuestion', questions: [] })
    await $.turn.complete({ ...DONE, turnId: 't2' })
    await clock.advance(20 * MIN)
    expect(sent).toHaveLength(1)

    // You type: armed again
    await $.prompt.submit({ text: 'go on', origin: { kind: 'composer' }, wait: false })
    await $.turn.start({ text: 'go on', turnId: 't3' })
    await $.turn.complete({ ...DONE, turnId: 't3' })
    await clock.advance(10 * MIN + 10_000)
    expect(sent).toHaveLength(2)

    // This time the pick starts work: a Bash call after it; leaving afterwards does not run it again
    await $.turn.start({ text: '/whats-next', turnId: 't4' })
    await $.tool.call({ tool: 'AskUserQuestion', questions: [] })
    await $.tool.call({ tool: 'Bash', command: 'git status' })
    await $.turn.complete({ ...DONE, turnId: 't4' })
    await clock.advance(20 * MIN)
    expect(sent).toHaveLength(2)
  })

  test('a typed /whats-next and the model calling the whats-next skill both count as shown', async ($, on) => {
    const clock = engine(on)
    const { sent } = box(on)
    on('tool.call', () => ({ result: 'ok' }))
    await $.session.start(START)

    await $.prompt.submit({ text: '/whats-next', origin: { kind: 'composer' }, wait: false })
    await $.turn.start({ text: '/whats-next', turnId: 't1' })
    await $.turn.complete(DONE)
    await clock.advance(20 * MIN)
    expect(sent).toEqual([])

    await $.prompt.submit({ text: 'back again', origin: { kind: 'composer' }, wait: false })
    await $.turn.start({ text: 'back again', turnId: 't2' })
    await $.tool.call({ tool: 'Skill', skill: 'whats-next' })
    await $.turn.complete({ ...DONE, turnId: 't2' })
    await clock.advance(20 * MIN)
    expect(sent).toEqual([])
  })

  test('after a typed /whats-next and a picked option, the recap still shows when you step away; whats-next does not run again', async ($, on) => {
    const clock = engine(on)
    const { sent, asks } = box(on)
    on('tool.call', () => ({ result: 'ok' }))
    await $.session.start(START)

    // You type /whats-next and pick an option; the work it starts ends in the same turn
    await $.prompt.submit({ text: '/whats-next', origin: { kind: 'composer' }, wait: false })
    await $.turn.start({ text: '/whats-next', turnId: 't1' })
    await $.tool.call({ tool: 'AskUserQuestion', questions: [] })
    await $.tool.call({ tool: 'Bash', command: 'git commit' })
    await $.turn.complete(DONE)

    await clock.advance(10 * MIN + 10_000)
    const band = await $.ui.mount({ ...IDLE, surface: 'terminal' })
    expect(await band.find({ type: 'Text', text: 'Goal: rework auto whats-next' })).toBeDefined()
    await band.unmount()

    // Once per absence, and whats-next is not run for you
    await clock.advance(30 * MIN)
    expect(asks).toHaveLength(1)
    expect(sent).toEqual([])
  })

  test('the plugin names count as shown too: a typed /yskills:whats-next and the Skill tool with yskills:whats-next', async ($, on) => {
    const clock = engine(on)
    const { sent } = box(on, { commands: ['yskills:whats-next'] })
    on('tool.call', () => ({ result: 'ok' }))
    await $.session.start(START)

    await $.prompt.submit({ text: '/yskills:whats-next main', origin: { kind: 'composer' }, wait: false })
    await $.turn.start({ text: '/yskills:whats-next main', turnId: 't1' })
    await $.turn.complete(DONE)
    await clock.advance(20 * MIN)
    expect(sent).toEqual([])

    await $.prompt.submit({ text: 'back again', origin: { kind: 'composer' }, wait: false })
    await $.turn.start({ text: 'back again', turnId: 't2' })
    await $.tool.call({ tool: 'Skill', skill: 'yskills:whats-next' })
    await $.turn.complete({ ...DONE, turnId: 't2' })
    await clock.advance(20 * MIN)
    expect(sent).toEqual([])
  })

  test('names: whats-next under either name, or the configured command', () => {
    expect(isWhatsNext('/whats-next')).toBe(true)
    expect(isWhatsNext('  /yskills:whats-next main')).toBe(true)
    expect(isWhatsNext('/whats-nextish')).toBe(false)
    expect(isWhatsNext('whats-next')).toBe(false)
    expect(isWhatsNext('/my-next', 'my-next')).toBe(true)
    expect(isWhatsNextName('yskills:whats-next')).toBe(true)
    expect(isWhatsNextName('/whats-next')).toBe(true)
    expect(isWhatsNextName('stale-check')).toBe(false)
    expect(pickWhatsNext(['a', 'yskills:whats-next'])).toBe('yskills:whats-next')
    expect(pickWhatsNext(['yskills:whats-next', 'whats-next'])).toBe('whats-next')
    expect(pickWhatsNext(['a', 'b'])).toBeUndefined()
    expect(parseCommandSetting('/my-next --short')).toEqual({ command: 'my-next', args: '--short' })
    expect(parseCommandSetting(' ')).toBeUndefined()
  })

  test('this turn has not ended: nothing runs', async ($, on) => {
    const clock = engine(on)
    const { sent } = box(on)
    await $.session.start(START)
    await $.turn.start({ text: 'change it', turnId: 't1' })
    await $.turn.complete(DONE)
    await $.turn.start({ text: 'again', turnId: 't2' })
    await clock.advance(20 * MIN)
    expect(sent).toEqual([])
  })

  test('a background task still running: nothing runs until it reports back and 10 minutes pass; later notices do not repeat it', async ($, on) => {
    const clock = engine(on)
    const { sent } = box(on)
    on('tool.call', () => ({ result: 'started' }))
    await $.session.start(START)
    await $.turn.start({ text: 'deploy', turnId: 't1' })
    await $.tool.call({ tool: 'Monitor', description: 'deploy', timeout_ms: 600_000, command: 'sleep 600' })
    await $.turn.complete(DONE)
    await clock.advance(20 * MIN)
    expect(sent).toEqual([])

    await $.prompt.submit({ text: '<task-notification>', origin: { kind: 'task-notification' }, wait: false })
    await $.turn.start({ text: '<task-notification>', turnId: 't2' })
    await $.turn.complete({ ...DONE, turnId: 't2' })
    await clock.advance(10 * MIN + 10_000)
    expect(sent).toEqual(['/whats-next'])

    // Still away, another notice: it has run once already, so not again; the recap stays
    await $.prompt.submit({ text: '<task-notification>', origin: { kind: 'task-notification' }, wait: false })
    await $.turn.start({ text: '<task-notification>', turnId: 't3' })
    await $.turn.complete({ ...DONE, turnId: 't3' })
    await clock.advance(20 * MIN)
    expect(sent).toEqual(['/whats-next'])
    const band = await $.ui.mount({ ...IDLE, surface: 'terminal' })
    expect(await band.find({ type: 'Text', text: 'recap   ' })).toBeDefined()
    await band.unmount()
  })

  test('a subagent still running: nothing runs', async ($, on) => {
    const clock = engine(on)
    const { sent } = box(on, { agents: [{ status: 'running' }] })
    await $.session.start(START)
    await $.turn.start({ text: 'change it', turnId: 't1' })
    await $.turn.complete(DONE)
    await clock.advance(20 * MIN)
    expect(sent).toEqual([])
  })
})

describe('done note', () => {
  const CLOSABLE = 'Goal: fix the estimate\nLast: three PRs shipped and checked\nNext: Safe to close'
  const DONE_TEXT = 'Done: capped the payout (#312); new label (#689)\nStatus: deployed and verified\nLeft open: none'

  // The recap and the done note are two forks, told apart by their prompt; records what was written and run
  // `other` answers any other fork it knows, such as the HUD_DONE_EXTRA_ASK one
  const wire = (on: On, recapText: string, other?: (prompt: string) => string | undefined) => {
    const seen = { asks: [] as string[], writes: [] as { path: string; text: string }[] }
    on('model.fork', (_, e) => {
      seen.asks.push(e.prompt)
      const answer = other?.(e.prompt)
      if (answer !== undefined) return { value: { isAnswered: true, text: answer, usage: USAGE } }
      const isDone = e.prompt === en.doneAsk || e.prompt === zh.doneAsk
      const text = isDone ? (e.prompt === zh.doneAsk ? '做完了：修了估算（#312）\n状态：已上线并验证过\n留着的：无' : DONE_TEXT) : recapText
      return { value: { isAnswered: true, text, usage: USAGE } }
    })
    on('session.id', () => ({ value: 'sid-9' }))
    on('fs.write', (_, e) => {
      seen.writes.push(e)
      return { value: undefined }
    })
    return seen
  }
  // git answers "not a repo"; every other command is recorded
  const runner = (runs: string[][]): Run => argv => {
    if (argv[0] === 'git') return ran('', 128)
    runs.push([...argv])
    return ran('')
  }

  test('a note: a heading of time, repo and goal, then three lines; no "Done" line, no note', () => {
    const at = Date.UTC(2026, 9, 20, 4, 20, 0)
    const text = `- **${DONE_TEXT.split('\n')[0]}**\n${DONE_TEXT.split('\n').slice(1).join('\n')}\nmore words`
    expect(formatDoneEntry({ at, repo: 'my-app', goal: 'Goal: fix the estimate', text }, en)).toMatch(
      /^## \d{4}-\d\d-\d\d \d\d:\d\d · my-app · fix the estimate\n\n- Done: capped the payout \(#312\); new label \(#689\)\n- Status: deployed and verified\n- Left open: none\n$/,
    )
    expect(formatDoneEntry({ at, repo: 'r', goal: '', text: 'Status: not done' }, en)).toBeNull()
    expect(formatDoneEntry({ at, repo: 'r', goal: '', text: DONE_TEXT }, en)).toContain(' · r · (no goal given)')
    expect(formatDoneEntry({ at, repo: 'r', goal: '在做：修估算', text: '做完了：A\n状态：B\n留着的：无' }, zh)).toMatch(
      /^## .+ · r · 修估算\n\n- 做完了：A\n- 状态：B\n- 留着的：无\n$/,
    )
  })

  test('off by default: a closable recap writes no note and runs nothing', async ($, on) => {
    const runs: string[][] = []
    const clock = engine(on, AUTO_OFF, { run: runner(runs) })
    const seen = wire(on, CLOSABLE)
    await $.session.start(START)
    await $.turn.start({ text: 'change it', turnId: 't1' })
    await $.turn.complete(DONE)
    await clock.advance(25 * MIN)
    expect(seen.asks).toHaveLength(1)
    expect(seen.writes).toHaveLength(0)
    expect(runs).toHaveLength(0)

    const state = await $.command.run(command('', 'donelog'))
    expect(state.text).toContain('Done note when the session can be closed: off.')
  })

  test('HUD_DONE_LOG=on: one note per absence, in ~/.claude/hud/done-log/', async ($, on) => {
    const runs: string[][] = []
    const clock = engine(on, AUTO_OFF, { run: runner(runs) }, { ...ENV, HUD_DONE_LOG: 'on' })
    const seen = wire(on, CLOSABLE)
    await $.session.start(START)
    await $.turn.start({ text: 'change it', turnId: 't1' })
    await $.turn.complete(DONE)
    await clock.advance(20 * MIN + 10_000)

    // One recap, one done note
    expect(seen.asks).toHaveLength(2)
    expect(seen.asks[1]).toBe(en.doneAsk)
    expect(seen.writes).toHaveLength(1)
    expect(seen.writes[0]?.path).toMatch(/^\/home\/u\/\.claude\/hud\/done-log\/sid-9-\d{8}-\d{6}\.md$/)
    expect(seen.writes[0]?.text).toContain(' · r · fix the estimate')
    expect(seen.writes[0]?.text).toContain('- Done: capped the payout (#312)')
    // No HUD_DONE_CMD: nothing else runs
    expect(runs).toHaveLength(0)

    await clock.advance(30 * MIN)
    expect(seen.asks).toHaveLength(2)
    expect(seen.writes).toHaveLength(1)
  })

  test('HUD_DONE_CMD runs once, with the note path as its one argument and no shell', async ($, on) => {
    const runs: string[][] = []
    const env = { ...ENV, HOME: '/home/my user', HUD_DONE_LOG: 'on', HUD_DONE_CMD: '~/bin/post-note' }
    const clock = engine(on, AUTO_OFF, { run: runner(runs) }, env)
    const seen = wire(on, CLOSABLE)
    await $.session.start(START)
    await $.turn.start({ text: 'change it', turnId: 't1' })
    await $.turn.complete(DONE)
    await clock.advance(20 * MIN + 10_000)

    expect(runs).toEqual([['/home/my user/bin/post-note', seen.writes[0]?.path ?? '?']])
    expect(seen.writes[0]?.path.startsWith('/home/my user/.claude/hud/done-log/sid-9-')).toBe(true)

    await clock.advance(30 * MIN)
    expect(runs).toHaveLength(1)

    const state = await $.command.run(command('', 'donelog'))
    expect(state.text).toContain('After each note: /home/my user/bin/post-note <note path>')
  })

  test('HUD_RECAP_RULES: the text of the file is added after the built-in recap ask', async ($, on) => {
    const clock = engine(on, AUTO_OFF, {}, { ...ENV, HUD_RECAP_RULES: '~/my rules.md' })
    const reads: string[] = []
    on('fs.read', (_, e) => {
      reads.push(e.path)
      return { value: '\nNext: if someone else asked for the change, ask whether to tell them.\n' }
    })
    const seen = wire(on, 'Goal: A\nLast: B\nNext: run plugin test')
    await $.session.start(START)
    await $.turn.start({ text: 'change it', turnId: 't1' })
    await $.turn.complete(DONE)
    await clock.advance(25 * MIN)
    expect(reads).toEqual(['/home/u/my rules.md'])
    expect(seen.asks).toEqual([`${en.recapAsk}\nNext: if someone else asked for the change, ask whether to tell them.`])
  })

  test('HUD_DONE_EXTRA_ASK: one more fork after the note, its reply passed as the second argument', async ($, on) => {
    const EXTRA = 'List what changed outside git, one JSON line each.'
    const runs: string[][] = []
    const limits: (number | undefined)[] = []
    const run: Run = (argv, init) => {
      if (argv[0] === 'git') return ran('', 128)
      runs.push([...argv])
      limits.push(init?.timeoutMs)
      return ran('')
    }
    const env = { ...ENV, HUD_DONE_LOG: 'on', HUD_DONE_CMD: 'post-note', HUD_DONE_EXTRA_ASK: '/k/extra.md', HUD_DONE_CMD_TIMEOUT: '600' }
    const clock = engine(on, AUTO_OFF, { run }, env)
    on('fs.read', () => ({ value: EXTRA }))
    let n = 0
    const seen = wire(on, CLOSABLE, prompt => (prompt.startsWith(EXTRA) ? `{"what": "flag ${++n}"}` : undefined))
    await $.session.start(START)
    await $.turn.start({ text: 'change it', turnId: 't1' })
    await $.turn.complete(DONE)
    await clock.advance(20 * MIN + 10_000)

    // Recap, done note, extra ask
    expect(seen.asks.slice(-3)).toEqual([en.recapAsk, en.doneAsk, EXTRA])
    const note = seen.writes[0]?.path ?? '?'
    const extra = note.replace(/\.md$/, '.extra.md')
    expect(seen.writes[1]).toEqual({ path: extra, text: '{"what": "flag 1"}\n' })
    expect(runs).toEqual([['post-note', note, extra]])
    expect(limits).toEqual([600_000])

    // Next absence: the first reply is named as already handed on
    await $.turn.start({ text: 'one more', turnId: 't2' })
    await $.turn.complete({ ...DONE, turnId: 't2' })
    await clock.advance(20 * MIN + 10_000)
    expect(seen.asks.at(-1)).toBe(`${EXTRA}\n\n${en.extraSeen(['{"what": "flag 1"}'])}`)
    expect(runs).toHaveLength(2)
  })

  test('a failing HUD_DONE_CMD: the extra reply is asked again next time; a bad timeout means 60 s', async ($, on) => {
    const EXTRA = 'Extra ask'
    const limits: (number | undefined)[] = []
    const run: Run = (argv, init) => {
      if (argv[0] === 'git') return ran('', 128)
      limits.push(init?.timeoutMs)
      return ran('', 1)
    }
    const env = { ...ENV, HUD_DONE_LOG: 'on', HUD_DONE_CMD: 'post-note', HUD_DONE_EXTRA_ASK: '/k/extra.md', HUD_DONE_CMD_TIMEOUT: '5000' }
    const clock = engine(on, AUTO_OFF, { run }, env)
    on('fs.read', () => ({ value: EXTRA }))
    const seen = wire(on, CLOSABLE, prompt => (prompt.startsWith(EXTRA) ? 'row' : undefined))
    await $.session.start(START)
    for (const turnId of ['t1', 't2']) {
      await $.turn.start({ text: 'change it', turnId })
      await $.turn.complete({ ...DONE, turnId })
      await clock.advance(20 * MIN + 10_000)
    }
    expect(seen.asks.filter(ask => ask.startsWith(EXTRA))).toEqual([EXTRA, EXTRA])
    expect(limits).toEqual([60_000, 60_000])
  })

  test('a next step other than "Safe to close": no note', async ($, on) => {
    const runs: string[][] = []
    const clock = engine(on, AUTO_OFF, { run: runner(runs) }, { ...ENV, HUD_DONE_LOG: 'on', HUD_DONE_CMD: 'post-note' })
    const seen = wire(on, 'Goal: A\nLast: B\nNext: run plugin test')
    await $.session.start(START)
    await $.turn.start({ text: 'change it', turnId: 't1' })
    await $.turn.complete(DONE)
    await clock.advance(25 * MIN)
    expect(seen.asks).toHaveLength(1)
    expect(seen.writes).toHaveLength(0)
    expect(runs).toHaveLength(0)
  })

  test('/donelog off wins over HUD_DONE_LOG=on', async ($, on) => {
    const runs: string[][] = []
    const clock = engine(on, AUTO_OFF, { run: runner(runs) }, { ...ENV, HUD_DONE_LOG: 'on' })
    const seen = wire(on, CLOSABLE)
    await $.session.start(START)
    const off = await $.command.run(command('off', 'donelog'))
    expect(off.text).toContain(': off.')
    await $.turn.start({ text: 'change it', turnId: 't1' })
    await $.turn.complete(DONE)
    await clock.advance(25 * MIN)
    expect(seen.asks).toHaveLength(1)
    expect(seen.writes).toHaveLength(0)
  })

  test('/donelog on turns it on without HUD_DONE_LOG', async ($, on) => {
    const clock = engine(on, AUTO_OFF)
    const seen = wire(on, CLOSABLE)
    await $.session.start(START)
    const state = await $.command.run(command('on', 'donelog'))
    expect(state.text).toContain('Done note when the session can be closed: on.')
    await $.turn.start({ text: 'change it', turnId: 't1' })
    await $.turn.complete(DONE)
    await clock.advance(25 * MIN)
    expect(seen.asks).toHaveLength(2)
    expect(seen.writes).toHaveLength(1)
  })

  test('HUD_LANG=zh: the note is asked for and written in Chinese', async ($, on) => {
    const clock = engine(on, AUTO_OFF, {}, { ...ZH, HUD_DONE_LOG: 'on' })
    const seen = wire(on, '在做：修估算\n停在：三个 PR 上线并验过\n下一步：可以关')
    await $.session.start(START)
    await $.turn.start({ text: '改一下', turnId: 't1' })
    await $.turn.complete(DONE)
    await clock.advance(20 * MIN + 10_000)

    expect(seen.asks[1]).toBe(zh.doneAsk)
    expect(seen.writes[0]?.text).toMatch(/^## .+ · r · 修估算\n\n- 做完了：修了估算（#312）\n- 状态：已上线并验证过\n- 留着的：无\n$/)
  })
})
