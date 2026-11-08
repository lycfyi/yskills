// Pure parts of session-sync: no `$`, so the tests can call them directly.

export type Kind = 'join' | 'decided' | 'overturned' | 'proposed' | 'converged' | 'file' | 'said'

export const DECISION_KINDS: readonly Kind[] = ['decided', 'overturned', 'proposed', 'converged']

export type Entry = {
  at: number
  session: string
  kind: Kind
  place?: string
  topic?: string
  about?: string
  first?: string
  text?: string
  quote?: string
  file?: string
  via?: 'tool' | 'fork'
}

export type Seen = {
  // Per topic: the newest entry from another session already shown here
  cursors: Record<string, number>
  // Same for files another session also edited
  fileCursor: number
  // Topics already listed to a session that has joined none
  listed: string[]
}

export const EMPTY_SEEN: Seen = { cursors: {}, fileCursor: 0, listed: [] }

export const QUOTE_MAX = 120
export const TEXT_MAX = 200
export const SAID_MAX = 300
export const FIRST_MAX = 80
export const LIST_MAX = 10
export const SAID_PER_SESSION = 15

export const clip = (s: string, n: number) => {
  const t = s.replace(/\s+/g, ' ').trim()
  return t.length <= n ? t : `${t.slice(0, n)}…`
}

// A topic's name: what the model wrote, lowercased, spaces to dashes. Chinese stays as it is.
export const slugOf = (raw: string) =>
  raw
    .trim()
    .toLowerCase()
    .replace(/[\s_/\\]+/g, '-')
    .replace(/[^\p{L}\p{N}-]/gu, '')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, 40)

export const parseLog = (text: string): Entry[] => {
  const out: Entry[] = []
  for (const line of text.split('\n')) {
    if (line.trim() === '') continue
    try {
      const e = JSON.parse(line) as Entry
      if (typeof e.at === 'number' && typeof e.session === 'string' && typeof e.kind === 'string') out.push(e)
    } catch {}
  }
  return out
}

export const parseSeen = (text: string | undefined): Seen => {
  if (text === undefined) return { ...EMPTY_SEEN, cursors: {}, listed: [] }
  try {
    const s = JSON.parse(text) as Partial<Seen>
    return {
      cursors: s.cursors && typeof s.cursors === 'object' ? { ...s.cursors } : {},
      fileCursor: typeof s.fileCursor === 'number' ? s.fileCursor : 0,
      listed: Array.isArray(s.listed) ? s.listed.filter(x => typeof x === 'string') : [],
    }
  } catch {
    return { cursors: {}, fileCursor: 0, listed: [] }
  }
}

const pad = (n: number) => String(n).padStart(2, '0')

export const clockOf = (at: number, now: number) => {
  const d = new Date(at)
  const hm = `${pad(d.getHours())}:${pad(d.getMinutes())}`
  const n = new Date(now)
  const sameDay = d.getFullYear() === n.getFullYear() && d.getMonth() === n.getMonth() && d.getDate() === n.getDate()
  return sameDay ? hm : `${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${hm}`
}

export const shortId = (id: string) => id.slice(0, 8)

const KIND_WORD: Record<string, string> = {
  decided: '拍板',
  overturned: '推翻',
  proposed: '提议（还没拍板）',
  converged: '收敛结论',
}

const who = (e: Entry) => `会话 ${shortId(e.session)}${e.place ? `（${e.place}）` : ''}`

export const decisionLine = (e: Entry, now: number) => {
  const quote = e.quote ? `；用户原话：「${e.quote}」` : ''
  return `- ${clockOf(e.at, now)} ${who(e)} ${KIND_WORD[e.kind] ?? e.kind}：${e.text ?? ''}${quote}`
}

export type Topic = {
  topic: string
  about: string
  sessions: Map<string, Entry>
  decisions: Entry[]
  lastAt: number
  firstAt: number
}

// All topics from all logs. A topic exists once a session joins it or records a decision on it.
export const topicsOf = (entries: readonly Entry[]): Map<string, Topic> => {
  const topics = new Map<string, Topic>()
  for (const e of [...entries].sort((a, b) => a.at - b.at)) {
    if (e.topic === undefined) continue
    if (e.kind !== 'join' && !DECISION_KINDS.includes(e.kind)) continue
    let t = topics.get(e.topic)
    if (t === undefined) {
      t = { topic: e.topic, about: e.about ?? '', sessions: new Map(), decisions: [], lastAt: e.at, firstAt: e.at }
      topics.set(e.topic, t)
    }
    if (t.about === '' && e.about) t.about = e.about
    if (!t.sessions.has(e.session)) t.sessions.set(e.session, e)
    if (DECISION_KINDS.includes(e.kind)) t.decisions.push(e)
    t.lastAt = Math.max(t.lastAt, e.at)
  }
  return topics
}

export const joinedBy = (entries: readonly Entry[], session: string) => {
  const out = new Set<string>()
  for (const e of entries) {
    if (e.session === session && e.topic !== undefined && (e.kind === 'join' || DECISION_KINDS.includes(e.kind))) {
      out.add(e.topic)
    }
  }
  return out
}

export const filesOf = (entries: readonly Entry[], session: string) =>
  new Set(entries.filter(e => e.session === session && e.kind === 'file' && e.file).map(e => e.file as string))

export const ASK_TO_COMPARE =
  '以上是同一话题的其他会话在本会话上次看过之后写下的。先对照本会话正在做的事：如果有不一致（数字、做法、范围、或者本会话依据的前提已被推翻），这一轮回复开头先告诉用户哪里不一致、两边的原话和会话号，问他以哪个为准，不要接着按旧的做。如果一致或者无关，不要提这件事。'

export const ASK_TO_JOIN =
  '如果本会话这次的任务属于下面某个话题，调用 mcp__session-sync__topic 跟上它（会拿到别的会话已经定了什么）；都不属于就不用调用，也不要提这件事。'

export type Built = { text?: string; seen: Seen }

// What the next prompt carries: decisions from other sessions on this session's topics since last
// shown, other sessions' edits to the same files, and, while this session has joined no topic, the
// topics it has not been shown yet.
export const buildContext = (
  entries: readonly Entry[],
  me: string,
  seen: Seen,
  now: number,
  fileWindowMs: number,
): Built => {
  const mine = joinedBy(entries, me)
  const topics = topicsOf(entries)
  const next: Seen = { cursors: { ...seen.cursors }, fileCursor: seen.fileCursor, listed: [...seen.listed] }
  const parts: string[] = []

  const fresh: string[] = []
  for (const name of [...mine].sort()) {
    const t = topics.get(name)
    if (t === undefined) continue
    const since = seen.cursors[name] ?? 0
    const news = t.decisions.filter(e => e.session !== me && e.at > since)
    if (news.length > 0) {
      fresh.push(`话题「${name}」${t.about ? `（${t.about}）` : ''}：`, ...news.map(e => decisionLine(e, now)))
      next.cursors[name] = Math.max(since, ...news.map(e => e.at))
    }
  }
  if (fresh.length > 0) parts.push(['[session-sync] 别的会话在同一话题上的新决定：', ...fresh, ASK_TO_COMPARE].join('\n'))

  const myFiles = filesOf(entries, me)
  if (myFiles.size > 0) {
    const touched = entries.filter(
      e =>
        e.kind === 'file' &&
        e.session !== me &&
        e.file !== undefined &&
        myFiles.has(e.file) &&
        e.at > seen.fileCursor &&
        e.at > now - fileWindowMs,
    )
    if (touched.length > 0) {
      const bySession = new Map<string, Entry[]>()
      for (const e of touched) bySession.set(e.session, [...(bySession.get(e.session) ?? []), e])
      const lines = [...bySession.values()].map(
        list =>
          `- ${who(list[0] as Entry)} ${clockOf(Math.max(...list.map(e => e.at)), now)} 也改了：${list
            .map(e => e.file)
            .join('、')}`,
      )
      parts.push(
        [
          '[session-sync] 别的会话也改了本会话改过的文件：',
          ...lines,
          '再动这些文件前先看一眼对方的改动，不要互相覆盖。和本会话的做法冲突时先告诉用户。',
        ].join('\n'),
      )
      next.fileCursor = Math.max(seen.fileCursor, ...touched.map(e => e.at))
    }
  }

  if (mine.size === 0) {
    const unseen = [...topics.values()]
      .filter(t => !seen.listed.includes(t.topic))
      .sort((a, b) => b.lastAt - a.lastAt)
      .slice(0, LIST_MAX)
    if (unseen.length > 0) {
      const lines = unseen.map(t => {
        const last = t.decisions.at(-1)
        const lastLine = last ? `；最近：${clip(last.text ?? '', 60)}` : ''
        return `- ${t.topic}${t.about ? `：${t.about}` : ''}（${t.sessions.size} 个会话${lastLine}）`
      })
      parts.push(['[session-sync] 最近 7 天几个会话在谈的话题：', ...lines, ASK_TO_JOIN].join('\n'))
      next.listed = [...next.listed, ...unseen.map(t => t.topic)]
    }
  }

  return { text: parts.length > 0 ? parts.join('\n\n') : undefined, seen: next }
}

// What a session gets back when it joins a topic: who is on it and everything decided so far.
export const topicReport = (entries: readonly Entry[], name: string, me: string, now: number) => {
  const t = topicsOf(entries).get(name)
  if (t === undefined) return `话题「${name}」：还没有别的会话。`
  const others = [...t.sessions.values()].filter(e => e.session !== me)
  const sessions = others.map(
    e => `- ${who(e)}${e.first ? `，开头：「${e.first}」` : ''}，最近 ${clockOf(lastOf(entries, e.session), now)}`,
  )
  const decisions = t.decisions.map(e => decisionLine(e, now))
  return [
    `话题「${name}」${t.about ? `：${t.about}` : ''}`,
    others.length > 0 ? `也在这个话题上的会话：\n${sessions.join('\n')}` : '还没有别的会话。',
    decisions.length > 0 ? `已经记下的决定（按时间）：\n${decisions.join('\n')}` : '还没有记下决定。',
  ].join('\n\n')
}

const lastOf = (entries: readonly Entry[], session: string) =>
  Math.max(0, ...entries.filter(e => e.session === session).map(e => e.at))

// For a convergence pass: the decisions, plus what the person said in each session on the topic.
export const convergeReport = (entries: readonly Entry[], name: string, me: string, now: number) => {
  const base = topicReport(entries, name, me, now)
  const t = topicsOf(entries).get(name)
  if (t === undefined) return base
  const blocks: string[] = []
  for (const s of t.sessions.keys()) {
    const said = entries
      .filter(e => e.session === s && e.kind === 'said' && e.topic === name)
      .sort((a, b) => a.at - b.at)
      .slice(-SAID_PER_SESSION)
    if (said.length === 0) continue
    const head = t.sessions.get(s) as Entry
    blocks.push(
      [`${who(head)}${s === me ? '（本会话）' : ''}里用户说过：`, ...said.map(e => `- ${clockOf(e.at, now)}「${e.text}」`)].join(
        '\n',
      ),
    )
  }
  return blocks.length > 0 ? `${base}\n\n${blocks.join('\n\n')}` : base
}

// Short replies that usually settle something; the fallback asks the model only after one of these
// or an answered question.
const DECIDES = [
  /^(好|好的|可以|行|就这样|就这么|定了|同意|没问题|按这个|按你说的|照这个|改成|换成|不要|别再|不用|用\s*[A-Da-d1-4]|选\s*[A-Da-d1-4]|[A-Da-d1-4]\s*$)/,
  /(拍板|就按|以后都|以后每次|定下来|推翻|不再|改为|改用|改成|换成|不要用|别用|更合适|就用|以.*为准)/,
  /^(yes|yep|ok|okay|go|lgtm|approve|approved|ship it|do it|sounds good)\b/i,
]

export const looksDecided = (text: string) => DECIDES.some(r => r.test(text.trim()))

export type ForkItem = { topic: string; kind: 'decided' | 'overturned'; text: string; quote?: string }

export const forkAsk = (topics: readonly string[]) =>
  [
    '（这是 session-sync 的后台问题。不要用工具，不要想太久，直接回答。）',
    '用户在最近这一轮有没有拍板、推翻、或者在选择题里选定了某件事？只看他自己说的话和他在选择题里的回答，agent 自己的建议不算。',
    `话题只能从这些里选：${topics.join('、')}。和这些话题都无关的不写。`,
    '只输出一个 JSON 数组，不写别的。每项：{"topic": 话题名, "kind": "decided" 或 "overturned", "text": 一句话写定了什么（≤60 字）, "quote": 他的原话（≤120 字）}。没有就输出 []。',
  ].join('\n')

export const parseForkReply = (reply: string, topics: readonly string[]): ForkItem[] => {
  const start = reply.indexOf('[')
  const end = reply.lastIndexOf(']')
  if (start < 0 || end <= start) return []
  try {
    const raw = JSON.parse(reply.slice(start, end + 1)) as unknown
    if (!Array.isArray(raw)) return []
    const out: ForkItem[] = []
    for (const x of raw) {
      if (typeof x !== 'object' || x === null) continue
      const o = x as Record<string, unknown>
      const topic = typeof o.topic === 'string' ? slugOf(o.topic) : ''
      const kind = o.kind === 'overturned' ? 'overturned' : o.kind === 'decided' ? 'decided' : undefined
      const text = typeof o.text === 'string' ? clip(o.text, TEXT_MAX) : ''
      if (!topics.includes(topic) || kind === undefined || text === '') continue
      out.push({ topic, kind, text, quote: typeof o.quote === 'string' ? clip(o.quote, QUOTE_MAX) : undefined })
    }
    return out.slice(0, 5)
  } catch {
    return []
  }
}

export const GUIDE = [
  '# 跨会话对齐（session-sync）',
  '用户常同时开几个会话谈同一件事。为了让它们互相看到对方定了什么：',
  '- 本会话的任务属于一个已有话题，或者明显会和别的会话撞上（同一个功能、同一份方案），调用 mcp__session-sync__topic 跟上它。话题名用短的中文或英文，例如「全球助推定价」。',
  '- 用户在本会话里拍板、推翻、或者在选择题里选定了一件事，而本会话跟着话题：调用 mcp__session-sync__decision 记一行，写定了什么和他的原话。agent 自己的提议用 kind=proposed。',
  '- 用户发话时，带 [session-sync] 的上下文是别的会话的新决定。照里面的要求对照，有不一致先告诉他。',
  '- 用户说「收敛一下 <话题>」或用 /converge：调用 mcp__session-sync__read 读全部记录，列三组（一致的、不一致的、只在一个会话里谈过的），不一致的每条用选择题问他，最后用 kind=converged 记下结论，再照仓库规则写决策记录或记忆。',
].join('\n')
