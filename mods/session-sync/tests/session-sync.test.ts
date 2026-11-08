import { describe, expect, mock, test } from 'claude-code/testing'
import type { On } from 'claude-code'

import {
  type Entry,
  EMPTY_SEEN,
  buildContext,
  convergeReport,
  looksDecided,
  parseForkReply,
  parseSeen,
  slugOf,
  topicReport,
} from '../hooks/lib.ts'

const MIN = 60_000
const HOUR = 60 * MIN
const T0 = Date.UTC(2026, 10, 8, 15, 0, 0)
const A = 'aaaaaaaa-1111-1111-1111-111111111111'
const B = 'bbbbbbbb-2222-2222-2222-222222222222'
const FILE_WINDOW = 6 * HOUR

const join = (session: string, topic: string, at: number, about?: string): Entry => ({
  at,
  session,
  kind: 'join',
  topic,
  about,
  place: session === A ? 'tutti-company-os@main' : 'tutti-company-os@feat/gb',
})
const decided = (session: string, topic: string, at: number, text: string, quote?: string): Entry => ({
  at,
  session,
  kind: 'decided',
  topic,
  text,
  quote,
  place: 'tutti-company-os@feat/gb',
})
const file = (session: string, path: string, at: number): Entry => ({ at, session, kind: 'file', file: path })

describe('what the next prompt carries', () => {
  test('a decision from another session on a shared topic is shown once', () => {
    const entries = [
      join(A, 'gb-pricing', T0),
      join(B, 'gb-pricing', T0 + MIN),
      decided(B, 'gb-pricing', T0 + 2 * MIN, '平台抽 20%，不收 3%', '20%，不要 3%'),
    ]
    const first = buildContext(entries, A, EMPTY_SEEN, T0 + 3 * MIN, FILE_WINDOW)
    expect(first.text).toContain('平台抽 20%，不收 3%')
    expect(first.text).toContain('「20%，不要 3%」')
    expect(first.text).toContain('会话 bbbbbbbb')
    expect(first.text).toContain('先告诉用户哪里不一致')

    const second = buildContext(entries, A, first.seen, T0 + 4 * MIN, FILE_WINDOW)
    expect(second.text).toBeUndefined()
  })

  test("a session's own decisions and other topics' decisions are not shown to it", () => {
    const entries = [
      join(A, 'gb-pricing', T0),
      decided(A, 'gb-pricing', T0 + MIN, '自己定的'),
      join(B, 'cue-x', T0),
      decided(B, 'cue-x', T0 + MIN, '别的话题'),
    ]
    const built = buildContext(entries, A, EMPTY_SEEN, T0 + 2 * MIN, FILE_WINDOW)
    expect(built.text).toBeUndefined()
  })

  test('while a session has joined nothing, the active topics are listed once', () => {
    const entries = [join(B, 'gb-pricing', T0, '全球助推的定价'), decided(B, 'gb-pricing', T0 + MIN, '平台抽 20%')]
    const first = buildContext(entries, A, EMPTY_SEEN, T0 + 2 * MIN, FILE_WINDOW)
    expect(first.text).toContain('gb-pricing：全球助推的定价')
    expect(first.text).toContain('最近：平台抽 20%')
    expect(first.text).toContain('mcp__session-sync__topic')
    expect(buildContext(entries, A, first.seen, T0 + 3 * MIN, FILE_WINDOW).text).toBeUndefined()

    // A topic started later is listed then
    const later = [...entries, join(B, 'cue-x', T0 + 4 * MIN, 'X 上的 Cue')]
    const third = buildContext(later, A, first.seen, T0 + 5 * MIN, FILE_WINDOW)
    expect(third.text).toContain('cue-x')
    expect(third.text).not.toContain('gb-pricing')
  })

  test('another session editing the same file is shown, but not after six hours', () => {
    const path = 'tutti-company-os/docs/sales/GB.md'
    const entries = [file(A, path, T0), file(B, path, T0 + MIN), file(B, 'tutti-company-os/other.md', T0 + MIN)]
    const built = buildContext(entries, A, EMPTY_SEEN, T0 + 2 * MIN, FILE_WINDOW)
    expect(built.text).toContain(path)
    expect(built.text).not.toContain('other.md')
    expect(buildContext(entries, A, built.seen, T0 + 3 * MIN, FILE_WINDOW).text).toBeUndefined()

    const old = buildContext(entries, A, EMPTY_SEEN, T0 + 7 * HOUR, FILE_WINDOW)
    expect(old.text).toBeUndefined()
  })
})

describe('reports', () => {
  test('joining a topic shows who is on it and what was decided', () => {
    const entries = [
      { ...join(B, 'gb-pricing', T0, '全球助推的定价'), first: '看一下 GB 的报价' },
      decided(B, 'gb-pricing', T0 + MIN, '平台抽 20%'),
    ]
    const report = topicReport(entries, 'gb-pricing', A, T0 + 2 * MIN)
    expect(report).toContain('全球助推的定价')
    expect(report).toContain('开头：「看一下 GB 的报价」')
    expect(report).toContain('拍板：平台抽 20%')
    expect(topicReport([], 'none', A, T0)).toContain('还没有别的会话')
  })

  test('the convergence report adds what was said in each session', () => {
    const entries: Entry[] = [
      join(A, 'gb-pricing', T0),
      join(B, 'gb-pricing', T0),
      { at: T0 + MIN, session: A, kind: 'said', topic: 'gb-pricing', text: '还是收 3% 吧' },
      { at: T0 + MIN, session: B, kind: 'said', topic: 'gb-pricing', text: '20%，不要 3%' },
    ]
    const report = convergeReport(entries, 'gb-pricing', A, T0 + 2 * MIN)
    expect(report).toContain('（本会话）里用户说过')
    expect(report).toContain('「还是收 3% 吧」')
    expect(report).toContain('「20%，不要 3%」')
  })
})

describe('small parts', () => {
  test('topic names', () => {
    expect(slugOf('  GB Pricing / v2 ')).toBe('gb-pricing-v2')
    expect(slugOf('全球助推 定价')).toBe('全球助推-定价')
    expect(slugOf('!!!')).toBe('')
  })

  test('short replies that settle something', () => {
    // The last two are real replies of 11-08 that settled the global-boost wording and fee
    for (const yes of ['好', '可以，就这样', '选 B', 'B', '改成 20%', '以后都用飞书', 'ok go', 'LGTM', '我们也改成充值时收平台费', '扣下 不要用类似这种措辞。 就是预留 更加合适']) {
      expect(looksDecided(yes)).toBe(true)
    }
    for (const no of ['这个怎么算的？', '看一下日志', 'what is this', '别的会话在做什么', '对比一下两版']) expect(looksDecided(no)).toBe(false)
  })

  test("the fork's reply keeps known topics and well-formed items only", () => {
    const reply =
      '好的：[{"topic":"gb-pricing","kind":"decided","text":"平台抽 20%","quote":"20%"},{"topic":"unknown","kind":"decided","text":"x"},{"topic":"gb-pricing","kind":"maybe","text":"y"}]'
    expect(parseForkReply(reply, ['gb-pricing'])).toEqual([
      { topic: 'gb-pricing', kind: 'decided', text: '平台抽 20%', quote: '20%' },
    ])
    expect(parseForkReply('没有', ['gb-pricing'])).toEqual([])
    expect(parseForkReply('[not json]', ['gb-pricing'])).toEqual([])
  })

  test('a broken seen file starts over', () => {
    expect(parseSeen('{oops')).toEqual({ cursors: {}, fileCursor: 0, listed: [] })
    expect(parseSeen(undefined)).toEqual({ cursors: {}, fileCursor: 0, listed: [] })
  })
})

// ───────────── through the engine, with a file system in memory ─────────────

const HOME = '/home/u'
const DIR = `${HOME}/.claude/session-sync`

const engine = (on: On, files: Map<string, string>, opts: { isFork?: string; onFork?: () => void } = {}) => {
  const clock = mock.clock(on, { now: T0 })
  mock.env(on, { HOME })
  on('session.start', (_, e) => ({ cwd: e.cwd }))
  on('session.id', () => ({ value: A }))
  on('session.cwd', () => ({ value: '/wt/sc-a' }))
  on('session.repo', () => ({
    value: { root: '/code/tutti-company-os', remote: null, internal: false, name: null },
  }))
  on('process.run', (_, e) => {
    const out = e.argv.includes('--show-toplevel') ? '/wt/sc-a' : 'feat/a'
    return { value: { exitCode: 0, stdout: `${out}\n`, stderr: '', isStdoutTruncated: false, isStderrTruncated: false } }
  })
  on('tool.register', (_, e) => ({ value: { tool: `mcp__session-sync__${e.name}` } }))
  on('command.register', (_, e) => ({ value: { command: e.name } }))
  on('fs.read', (_, e) => {
    const text = files.get(e.path)
    if (text === undefined) throw new Error('missing')
    return { value: text }
  })
  on('fs.write', (_, e) => {
    files.set(e.path, e.text)
    return { value: undefined }
  })
  on('fs.list', (_, e) => {
    const prefix = `${e.path}/`
    const names = [...files.keys()].filter(p => p.startsWith(prefix)).map(p => p.slice(prefix.length))
    return {
      value: names.map(name => ({ name, kind: 'file' as const, size: 1, mtimeMs: T0, isLink: false })),
    }
  })
  on('turn.complete', () => ({ text: '' }))
  on('model.fork', () => {
    opts.onFork?.()
    return {
    value: {
      isAnswered: true as const,
      text: opts.isFork ?? '[]',
      usage: { input_tokens: 1, output_tokens: 1, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 },
    },
    }
  })
  return clock
}

const SAY = { wait: false, origin: { kind: 'composer' } } as const
const START = { cwd: '/wt/sc-a', surface: 'terminal', isInteractive: true } as const
const lines = (...entries: Entry[]) => entries.map(e => `${JSON.stringify(e)}\n`).join('')

describe('in a session', () => {
  test("joining returns the other session's decisions; its later decision rides the next prompt once", async ($, on) => {
    const files = new Map<string, string>()
    files.set(`${DIR}/log/${B}.jsonl`, lines(join(B, 'gb-pricing', T0 - HOUR, '全球助推的定价'), decided(B, 'gb-pricing', T0 - 30 * MIN, '平台抽 20%')))
    const clock = engine(on, files)
    const seen: string[][] = []
    on('prompt.submit', (_, e) => {
      seen.push([...(e.context ?? [])])
      return { text: e.text }
    })

    await $.session.start(START)
    const joined = await $.tool.call({ tool: 'mcp__session-sync__topic', topic: 'GB Pricing' })
    expect(JSON.stringify(joined)).toContain('平台抽 20%')
    expect(files.get(`${DIR}/log/${A}.jsonl`)).toContain('"kind":"join"')

    await clock.advance(MIN)
    await $.prompt.submit({ ...SAY, text: '继续改方案' })
    expect(seen.at(-1)).toEqual([])

    files.set(
      `${DIR}/log/${B}.jsonl`,
      (files.get(`${DIR}/log/${B}.jsonl`) ?? '') + lines(decided(B, 'gb-pricing', T0 + 2 * MIN, '最低 40% 人数才启动')),
    )
    await clock.advance(2 * MIN)
    await $.prompt.submit({ ...SAY, text: '接着写' })
    expect(seen.at(-1)?.join('\n')).toContain('最低 40% 人数才启动')
    expect(seen.at(-1)?.join('\n')).not.toContain('平台抽 20%')

    await clock.advance(MIN)
    await $.prompt.submit({ ...SAY, text: '再改一句' })
    expect(seen.at(-1)).toEqual([])
    // What the person says on a topic is kept for convergence
    expect(files.get(`${DIR}/log/${A}.jsonl`)).toContain('"kind":"said"')
  })

  test('a recorded decision is written with the place it came from', async ($, on) => {
    const files = new Map<string, string>()
    engine(on, files)
    on('prompt.submit', (_, e) => ({ text: e.text }))
    await $.session.start(START)
    await $.prompt.submit({ ...SAY, text: '就这样，20%' })
    const r = await $.tool.call({
      tool: 'mcp__session-sync__decision',
      topic: 'gb-pricing',
      kind: 'decided',
      text: '平台抽 20%',
      quote: '就这样，20%',
    })
    expect(JSON.stringify(r)).toContain('记下了')
    const log = files.get(`${DIR}/log/${A}.jsonl`) ?? ''
    expect(log).toContain('"kind":"join"')
    expect(log).toContain('"place":"tutti-company-os@feat/a"')
    expect(log).toContain('"text":"平台抽 20%"')
  })

  test('an edited file is keyed by repository, the same in every worktree', async ($, on) => {
    const files = new Map<string, string>()
    engine(on, files)
    on('tool.call', { tool: 'Edit' }, () => ({ result: 'ok' }))
    await $.session.start(START)
    await $.tool.call({ tool: 'Edit', file_path: '/wt/sc-a/docs/x.md', old_string: 'a', new_string: 'b' })
    expect(files.get(`${DIR}/log/${A}.jsonl`)).toContain('"file":"tutti-company-os/docs/x.md"')
  })

  test('a settled reply nobody recorded is picked up by a fork of the session', async ($, on) => {
    const files = new Map<string, string>()
    const clock = engine(on, files, {
      isFork: '[{"topic":"gb-pricing","kind":"decided","text":"最低 40% 人数才启动","quote":"选 B"}]',
    })
    on('prompt.submit', (_, e) => ({ text: e.text }))
    await $.session.start(START)
    await $.tool.call({ tool: 'mcp__session-sync__topic', topic: 'gb-pricing' })
    await $.prompt.submit({ ...SAY, text: '选 B' })
    await $.turn.complete({ reason: 'answer', answer: 'ok', durationMs: 1000, isAborted: false, turnId: 't1' })
    await clock.advance(1000)
    const log = files.get(`${DIR}/log/${A}.jsonl`) ?? ''
    expect(log).toContain('"via":"fork"')
    expect(log).toContain('最低 40% 人数才启动')
  })

  test('no fork when the turn recorded its decision or the reply settles nothing', async ($, on) => {
    const files = new Map<string, string>()
    let forks = 0
    const clock = engine(on, files, { onFork: () => (forks += 1) })
    on('prompt.submit', (_, e) => ({ text: e.text }))
    await $.session.start(START)
    await $.tool.call({ tool: 'mcp__session-sync__topic', topic: 'gb-pricing' })
    await $.prompt.submit({ ...SAY, text: '这个怎么算的？' })
    await $.turn.complete({ reason: 'answer', answer: 'ok', durationMs: 1000, isAborted: false, turnId: 't1' })
    await $.prompt.submit({ ...SAY, text: '好，就这样' })
    await $.tool.call({ tool: 'mcp__session-sync__decision', topic: 'gb-pricing', kind: 'decided', text: 'x' })
    await $.turn.complete({ reason: 'answer', answer: 'ok', durationMs: 1000, isAborted: false, turnId: 't2' })
    await clock.advance(1000)
    expect(forks).toBe(0)
  })

  test('a non-interactive session takes no part', async ($, on) => {
    const files = new Map<string, string>()
    files.set(`${DIR}/log/${B}.jsonl`, lines(join(B, 'gb-pricing', T0)))
    engine(on, files)
    const seen: string[][] = []
    on('prompt.submit', (_, e) => {
      seen.push([...(e.context ?? [])])
      return { text: e.text }
    })
    await $.session.start({ ...START, isInteractive: false })
    await $.prompt.submit({ ...SAY, text: 'hi' })
    expect(seen.at(-1)).toEqual([])
    expect(files.has(`${DIR}/log/${A}.jsonl`)).toBe(false)
  })
})
