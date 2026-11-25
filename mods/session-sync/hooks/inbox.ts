// Session inbox: each session has one state, so the person can clear sessions one by one.
//   working  the person sent a message and the agent is on it
//   waiting  the agent answered and stopped: it waits for the person
//   snoozed  the person said /snooze; it comes back as waiting at `until`
//   done     the person said /done; it stays out of the list until a new message reopens it
// Each session writes only inbox/<session>.json. Pure functions here; register.ts does the I/O.

export type State = 'working' | 'waiting' | 'snoozed' | 'done'

export type Box = {
  session: string
  place: string
  title: string
  state: State
  since: number
  until?: number
  last?: string
  note?: string
  pendingDone?: boolean
}

export const KEEP_MS = 7 * 86_400_000
const MIN = 60_000
const HOUR = 60 * MIN
const DAY = 24 * HOUR
export const DEFAULT_SNOOZE_MS = 2 * HOUR
export const LINE_MAX = 90

export const firstLine = (text: string, n = LINE_MAX) => {
  const line =
    text
      .split('\n')
      .map(s => s.replace(/^\s*(#{1,6}\s|>\s?|[-*]\s)/, '').replace(/\*\*|`/g, '').trim())
      .find(s => s !== '') ?? ''
  return line.length > n ? `${line.slice(0, n - 1)}…` : line
}

export const parseBox = (text: string | undefined): Box | undefined => {
  if (text === undefined) return undefined
  try {
    const b = JSON.parse(text) as Box
    return typeof b.session === 'string' && typeof b.state === 'string' ? b : undefined
  } catch {
    return undefined
  }
}

// A snoozed box whose time has passed reads as waiting, in every session's list
export const effective = (b: Box, now: number): Box =>
  b.state === 'snoozed' && (b.until ?? 0) <= now ? { ...b, state: 'waiting', since: b.until ?? b.since, until: undefined } : b

// Local time at hour h, today or (if that has passed) the next day
const nextAt = (now: number, h: number) => {
  const d = new Date(now)
  d.setHours(h, 0, 0, 0)
  if (d.getTime() <= now) d.setDate(d.getDate() + 1)
  return d.getTime()
}

/** `/snooze` argument to the time it ends. `undefined` = not understood. */
export const parseSnooze = (arg: string, now: number): number | undefined => {
  const a = arg.trim().toLowerCase()
  if (a === '') return now + DEFAULT_SNOOZE_MS
  const m = a.match(/^(\d+(?:\.\d+)?)\s*(m|min|分钟?|h|hr|小时|d|天)?$/)
  if (m) {
    const n = Number(m[1])
    const unit = m[2] ?? 'm'
    const ms = /^(h|hr|小时)$/.test(unit) ? n * HOUR : /^(d|天)$/.test(unit) ? n * DAY : n * MIN
    return ms > 0 ? now + ms : undefined
  }
  if (/^(明早|明天|tomorrow|am)$/.test(a)) {
    const d = new Date(now)
    d.setDate(d.getDate() + 1)
    d.setHours(9, 0, 0, 0)
    return d.getTime()
  }
  if (/^(今晚|晚上|tonight)$/.test(a)) return nextAt(now, 21)
  if (/^(下午|afternoon)$/.test(a)) return nextAt(now, 14)
  const hm = a.match(/^(\d{1,2})[:：点](\d{2})?$/)
  if (hm) {
    const d = new Date(now)
    d.setHours(Number(hm[1]), Number(hm[2] ?? 0), 0, 0)
    if (d.getTime() <= now) d.setDate(d.getDate() + 1)
    return d.getTime()
  }
  return undefined
}

export const ago = (ms: number) =>
  ms < HOUR ? `${Math.max(1, Math.round(ms / MIN))} 分钟` : ms < DAY ? `${Math.round(ms / HOUR)} 小时` : `${Math.round(ms / DAY)} 天`

export const clockText = (t: number, now: number) => {
  const d = new Date(t)
  const hhmm = `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`
  const today = new Date(now).toDateString() === d.toDateString()
  const tomorrow = new Date(now + DAY).toDateString() === d.toDateString()
  return today ? `今天 ${hhmm}` : tomorrow ? `明天 ${hhmm}` : `${d.getMonth() + 1}-${d.getDate()} ${hhmm}`
}

/** The text of /inbox. `me` is the session that asked. */
export const inboxReport = (boxes: Box[], now: number, me: string): string => {
  const live = boxes.map(b => effective(b, now))
  const waiting = live.filter(b => b.state === 'waiting').sort((x, y) => x.since - y.since)
  const snoozed = live.filter(b => b.state === 'snoozed').sort((x, y) => (x.until ?? 0) - (y.until ?? 0))
  const working = live.filter(b => b.state === 'working').sort((x, y) => x.since - y.since)
  const doneToday = live.filter(b => b.state === 'done' && new Date(b.since).toDateString() === new Date(now).toDateString())
  const tag = (b: Box) => (b.session === me ? '（本会话）' : '')
  const out: string[] = []
  out.push(`等你（${waiting.length}）`)
  if (waiting.length === 0) out.push('  没有。')
  waiting.forEach((b, i) => {
    out.push(`  ${i + 1}. 等了 ${ago(now - b.since)} · ${b.title}${tag(b)}`)
    out.push(`     ${b.place}`)
    if (b.last) out.push(`     最后一句：${b.last}`)
    if (b.session !== me) out.push(`     claude --resume ${b.session}`)
  })
  if (snoozed.length > 0) {
    out.push('', `稍后提醒（${snoozed.length}）`)
    for (const b of snoozed) out.push(`  · ${clockText(b.until ?? now, now)} · ${b.title}${tag(b)} · ${b.place}`)
  }
  if (working.length > 0) {
    out.push('', `进行中（${working.length}）`)
    for (const b of working) out.push(`  · ${ago(now - b.since)} · ${b.title}${tag(b)} · ${b.place}`)
  }
  out.push('', `今天处理完 ${doneToday.length} 个。在会话里打 /done 标处理完，/snooze 2h 或 /snooze 明早 稍后提醒。`)
  return out.join('\n')
}

export const DONE_ASK =
  '我把这个会话标成「处理完」。用一行中文收尾：结论、PR 号或链接、还剩什么没做。只写这一行，不调用工具。'
