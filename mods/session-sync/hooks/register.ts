import type { EngineInterface, Register } from 'claude-code'

import {
  DECISION_KINDS,
  type Entry,
  FIRST_MAX,
  GUIDE,
  type Kind,
  QUOTE_MAX,
  SAID_MAX,
  type Seen,
  TEXT_MAX,
  buildContext,
  clip,
  convergeReport,
  forkAsk,
  joinedBy,
  looksDecided,
  parseForkReply,
  parseLog,
  parseSeen,
  slugOf,
  topicReport,
} from './lib.ts'

// Everything lives under ~/.claude/session-sync. Each session writes only its own files, so two
// sessions never write the same file:
//   log/<session>.jsonl   what this session joined, decided, edited, and (once on a topic) said
//   seen/<session>.json   how far this session has been shown the others' entries
const PLUGIN = 'session-sync'
const TOOL = {
  topic: `mcp__${PLUGIN}__topic`,
  decision: `mcp__${PLUGIN}__decision`,
  read: `mcp__${PLUGIN}__read`,
} as const
const COMMAND = 'converge'
const ACTIVE_MS = 7 * 86_400_000
const FILE_WINDOW_MS = 6 * 3_600_000

type Me = { id: string; dir: string; place: string; top: string | undefined; repoRoot: string | undefined }

type Turn = { human: string; decided: boolean; asked: boolean }

const debug = ($: EngineInterface, text: string) => $.ui.log(`session-sync: ${text}`, { to: 'debug' })

const run = async ($: EngineInterface, argv: string[]) => {
  try {
    const r = await $.process.run(argv, { timeoutMs: 5000 })
    return r.exitCode === 0 ? r.stdout.trim() : undefined
  } catch {
    return undefined
  }
}

// A registered tool's arguments arrive on the event itself, as the HUD's progress tool reads them
const input = (e: unknown) => e as Record<string, unknown>

const baseName = (p: string) => p.replace(/\/+$/, '').split('/').at(-1) ?? p

// This session's own state. Starts over on a reload; session.start reads the log back.
const S: {
  isOn: boolean
  me: Me | undefined
  myLog: string
  first: string | undefined
  turn: Turn | undefined
  myFiles: Set<string>
} = { isOn: false, me: undefined, myLog: '', first: undefined, turn: undefined, myFiles: new Set() }

const logPath = (m: Me, id = m.id) => `${m.dir}/log/${id}.jsonl`
const seenPath = (m: Me) => `${m.dir}/seen/${m.id}.json`

async function append($: EngineInterface, m: Me, entry: Omit<Entry, 'at' | 'session' | 'place'>) {
  const full: Entry = { at: await $.clock.now(), session: m.id, place: m.place, ...entry }
  S.myLog += `${JSON.stringify(full)}\n`
  await $.fs.write(logPath(m), S.myLog)
  return full
}

async function readAll($: EngineInterface, m: Me): Promise<Entry[]> {
  const now = await $.clock.now()
  const files = await $.fs.list(`${m.dir}/log`).catch(() => [])
  const out: Entry[] = []
  for (const f of files) {
    if (f.kind !== 'file' || !f.name.endsWith('.jsonl') || f.mtimeMs < now - ACTIVE_MS) continue
    const text = f.name === `${m.id}.jsonl` ? S.myLog : await $.fs.read(`${m.dir}/log/${f.name}`).catch(() => '')
    if (typeof text === 'string') out.push(...parseLog(text))
  }
  return out
}

async function readSeen($: EngineInterface, m: Me): Promise<Seen> {
  const text = await $.fs.read(seenPath(m)).catch(() => undefined)
  return parseSeen(typeof text === 'string' ? text : undefined)
}

// A file's name the same in every worktree of a repository: the repository's main root, then the
// path inside the working tree
const keyOf = (m: Me, path: string) => {
  if (m.top !== undefined && m.repoRoot !== undefined && path.startsWith(`${m.top}/`)) {
    return `${baseName(m.repoRoot)}/${path.slice(m.top.length + 1)}`
  }
  return path
}

async function join($: EngineInterface, m: Me, topic: string, about?: string) {
  const entries = await readAll($, m)
  if (!joinedBy(entries, m.id).has(topic)) {
    await append($, m, {
      kind: 'join',
      topic,
      about: about ? clip(about, TEXT_MAX) : undefined,
      first: S.first ? clip(S.first, FIRST_MAX) : undefined,
    })
  }
  // Joining shows everything so far, so nothing older needs showing again at the next prompt
  const now = await $.clock.now()
  const seen = await readSeen($, m)
  seen.cursors[topic] = now
  await $.fs.write(seenPath(m), JSON.stringify(seen))
  return topicReport(await readAll($, m), topic, m.id, now)
}

async function fallback($: EngineInterface, m: Me) {
  const topics = [...joinedBy(await readAll($, m), m.id)]
  if (topics.length === 0) return
  const reply = await $.model.fork({ prompt: forkAsk(topics) })
  if (!reply.isAnswered) {
    debug($, `fallback fork not answered: ${reply.reason}`)
    return
  }
  for (const item of parseForkReply(reply.text, topics)) {
    await append($, m, { kind: item.kind, topic: item.topic, text: item.text, quote: item.quote, via: 'fork' })
  }
}

// Files this session edits, so another session on the same files hears of it. Never in a tool's way.
async function track($: EngineInterface, path: string) {
  const m = S.me
  if (m === undefined) return
  try {
    const key = keyOf(m, path)
    if (S.myFiles.has(key)) return
    S.myFiles.add(key)
    await append($, m, { kind: 'file', file: key })
  } catch {}
}

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    const started = await next(e)
    S.isOn = e.isInteractive
    if (!S.isOn) return started
    try {
      const home = await $.env.get('HOME')
      const id = await $.session.id()
      const cwd = await $.session.cwd()
      const repo = await $.session.repo().catch(() => null)
      const top = await run($, ['git', '-C', cwd, 'rev-parse', '--show-toplevel'])
      const branch = await run($, ['git', '-C', cwd, 'rev-parse', '--abbrev-ref', 'HEAD'])
      const name = repo?.root ? baseName(repo.root) : baseName(top ?? cwd)
      S.me = {
        id,
        dir: `${home}/.claude/session-sync`,
        place: branch ? `${name}@${branch}` : name,
        top,
        repoRoot: repo?.root,
      }
      // After a reload or a resume: carry on from what this session already wrote
      const own = await $.fs.read(logPath(S.me)).catch(() => '')
      S.myLog = typeof own === 'string' ? own : ''
      for (const x of parseLog(S.myLog)) if (x.kind === 'file' && x.file) S.myFiles.add(x.file)

      await $.tool.register({
        name: 'topic',
        description:
          '跟上一个跨会话话题。本会话的任务属于一个已有话题，或者会和别的会话谈同一件事时调用。返回已经在这个话题上的会话和它们记下的决定。',
        inputSchema: {
          type: 'object',
          properties: {
            topic: { type: 'string', description: '话题名，短的中文或英文；已有话题照列表里的名字写' },
            about: { type: 'string', description: '新话题时写一句话说明它是什么' },
          },
          required: ['topic'],
        },
      })
      await $.tool.register({
        name: 'decision',
        description:
          '在一个话题上记一行：用户拍板（decided）、推翻（overturned）、agent 的提议（proposed）、或收敛后的结论（converged）。别的会话下次发话时会看到。',
        inputSchema: {
          type: 'object',
          properties: {
            topic: { type: 'string' },
            kind: { type: 'string', enum: ['decided', 'overturned', 'proposed', 'converged'] },
            text: { type: 'string', description: '一句话写定了什么，带数字和范围' },
            quote: { type: 'string', description: '用户的原话，照抄，可截断' },
          },
          required: ['topic', 'kind', 'text'],
        },
      })
      await $.tool.register({
        name: 'read',
        description: '读一个话题的全部记录：各会话记下的决定，和用户在每个会话里说过的话。收敛时用。',
        inputSchema: { type: 'object', properties: { topic: { type: 'string' } }, required: ['topic'] },
      })
      await $.command.register({
        name: COMMAND,
        description: '收敛一个话题：列出几个会话里一致的、不一致的和只谈过一边的，逐条问你',
        argumentHint: '<话题>',
      })
    } catch (err) {
      S.me = undefined
      debug($, `not started: ${err}`)
    }
    return started
  })

  for (const tool of Object.values(TOOL)) {
    on('tool.describe', { tool }, async ($, e, next) => ({ ...(await next(e)), isDeferred: false }))
  }

  on('prompt.compose', async ($, e, next) => {
    const composed = await next(e)
    if (!S.isOn || S.me === undefined || !e.tools.includes(TOOL.topic)) return composed
    return { sections: [...composed.sections, { id: 'session-sync:guide', text: GUIDE, scope: 'session' as const }] }
  })

  on('prompt.submit', async ($, e, next) => {
    const m = S.me
    if (!S.isOn || m === undefined || e.command !== undefined || e.isMeta) return next(e)
    const kind = e.origin?.kind
    const isHuman = kind === undefined || kind === 'composer' || kind === 'bridge'
    if (!isHuman) return next(e)
    try {
      if (S.first === undefined) S.first = e.text
      S.turn = { human: e.text, decided: false, asked: false }
      const entries = await readAll($, m)
      const mine = joinedBy(entries, m.id)
      for (const topic of mine) await append($, m, { kind: 'said', topic, text: clip(e.text, SAID_MAX) })
      const seen = await readSeen($, m)
      const built = buildContext(entries, m.id, seen, await $.clock.now(), FILE_WINDOW_MS)
      if (JSON.stringify(built.seen) !== JSON.stringify(seen)) await $.fs.write(seenPath(m), JSON.stringify(built.seen))
      if (built.text !== undefined) return next({ ...e, context: [...(e.context ?? []), built.text] })
    } catch (err) {
      debug($, `prompt not checked: ${err}`)
    }
    return next(e)
  })

  on('tool.call', { tool: TOOL.topic }, async ($, e) => {
    const m = S.me
    if (m === undefined) return { result: 'session-sync 没有在本会话启动。' }
    if (e.agentId !== undefined) return { result: '子 agent 不跟话题；由主会话调用。' }
    const topic = slugOf(String(input(e).topic ?? ''))
    if (topic === '') return { deny: '话题名不能为空。' }
    const about = typeof input(e).about === 'string' ? (input(e).about as string) : undefined
    return { result: await join($, m, topic, about) }
  })

  on('tool.call', { tool: TOOL.decision }, async ($, e) => {
    const m = S.me
    if (m === undefined) return { result: 'session-sync 没有在本会话启动。' }
    if (e.agentId !== undefined) return { result: '子 agent 不记决定；由主会话调用。' }
    const topic = slugOf(String(input(e).topic ?? ''))
    const kind = String(input(e).kind ?? '') as Kind
    const text = typeof input(e).text === 'string' ? clip(input(e).text as string, TEXT_MAX) : ''
    if (topic === '' || !DECISION_KINDS.includes(kind) || text === '') {
      return { deny: '要写 topic、kind（decided / overturned / proposed / converged）和 text。' }
    }
    if (!joinedBy(await readAll($, m), m.id).has(topic)) await join($, m, topic)
    const quote = typeof input(e).quote === 'string' ? clip(input(e).quote as string, QUOTE_MAX) : undefined
    await append($, m, { kind, topic, text, quote, via: 'tool' })
    if (S.turn !== undefined && kind !== 'proposed') S.turn.decided = true
    return { result: `记下了。跟「${topic}」的其他会话下次发话时会看到。` }
  })

  on('tool.call', { tool: TOOL.read }, async ($, e) => {
    const m = S.me
    if (m === undefined) return { result: 'session-sync 没有在本会话启动。' }
    const topic = slugOf(String(input(e).topic ?? ''))
    if (topic === '') return { deny: '话题名不能为空。' }
    return { result: convergeReport(await readAll($, m), topic, m.id, await $.clock.now()) }
  })

  // Files this session edits, so another session on the same files hears of it
  on('tool.call', { tool: 'Edit' }, async ($, e, next) => {
    const result = await next(e)
    if (e.agentId === undefined && result.deny === undefined && result.isError !== true) await track($, e.file_path)
    return result
  })

  on('tool.call', { tool: 'Write' }, async ($, e, next) => {
    const result = await next(e)
    if (e.agentId === undefined && result.deny === undefined && result.isError !== true) await track($, e.file_path)
    return result
  })

  on('tool.call', { tool: 'NotebookEdit' }, async ($, e, next) => {
    const result = await next(e)
    if (e.agentId === undefined && result.deny === undefined && result.isError !== true) await track($, e.notebook_path)
    return result
  })

  on('tool.call', { tool: 'AskUserQuestion' }, async ($, e, next) => {
    const result = await next(e)
    if (e.agentId === undefined && S.turn !== undefined && result.deny === undefined && result.isError !== true) {
      S.turn.asked = true
    }
    return result
  })

  // The person seemed to settle something this turn and nothing was recorded: ask a fork of this
  // session once, over its warm cache, and record what it finds. Only for sessions on a topic.
  on('turn.complete', async ($, e, next) => {
    const result = await next(e)
    const m = S.me
    const t = S.turn
    if (m === undefined || e.agentId !== undefined || t === undefined) return result
    S.turn = undefined
    if (e.reason !== 'answer' || t.decided || !(t.asked || looksDecided(t.human))) return result
    $.clock.after(0, () => {
      void fallback($, m).catch(err => debug($, `fallback failed: ${err}`))
    })
    return result
  })

  on('command.run', { command: COMMAND }, async ($, e) => {
    const topic = e.args.trim()
    const text = topic
      ? `收敛一下话题「${topic}」。`
      : '收敛一下本会话跟着的话题（只有一个就用它；有几个先问我收哪个）。'
    await $.prompt.submit({ text, asUser: true })
    return { text: '已交给本会话收敛。' }
  })
}
