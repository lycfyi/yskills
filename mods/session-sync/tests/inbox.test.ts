import { describe, expect, test } from 'claude-code/testing'

import { type Box, effective, firstLine, inboxReport, parseSnooze } from '../hooks/inbox.ts'

const MIN = 60_000
const HOUR = 60 * MIN
const NOW = new Date(2026, 10, 24, 22, 30, 0).getTime() // local 22:30

const box = (session: string, state: Box['state'], since: number, extra: Partial<Box> = {}): Box => ({
  session,
  place: 'acme-web@main',
  title: `话题 ${session}`,
  state,
  since,
  ...extra,
})

describe('parseSnooze', () => {
  test('durations', async () => {
    expect(parseSnooze('', NOW)).toBe(NOW + 2 * HOUR)
    expect(parseSnooze('30m', NOW)).toBe(NOW + 30 * MIN)
    expect(parseSnooze('2h', NOW)).toBe(NOW + 2 * HOUR)
    expect(parseSnooze('1d', NOW)).toBe(NOW + 24 * HOUR)
    expect(parseSnooze('45', NOW)).toBe(NOW + 45 * MIN)
  })
  test('times of day', async () => {
    expect(parseSnooze('明早', NOW)).toBe(new Date(2026, 10, 25, 9, 0, 0).getTime())
    expect(parseSnooze('今晚', NOW)).toBe(new Date(2026, 10, 25, 21, 0, 0).getTime())
    expect(parseSnooze('23:15', NOW)).toBe(new Date(2026, 10, 24, 23, 15, 0).getTime())
    expect(parseSnooze('9点', NOW)).toBe(new Date(2026, 10, 25, 9, 0, 0).getTime())
  })
  test('not understood', async () => {
    expect(parseSnooze('下周', NOW)).toBe(undefined)
    expect(parseSnooze('0m', NOW)).toBe(undefined)
  })
})

describe('inbox', () => {
  test('a snooze that ended reads as waiting', async () => {
    const b = box('a', 'snoozed', NOW - 3 * HOUR, { until: NOW - HOUR })
    expect(effective(b, NOW).state).toBe('waiting')
    expect(effective(box('b', 'snoozed', NOW, { until: NOW + HOUR }), NOW).state).toBe('snoozed')
  })

  test('oldest waiting first, done left out', async () => {
    const text = inboxReport(
      [
        box('new', 'waiting', NOW - 10 * MIN, { last: '结论：已上线' }),
        box('old', 'waiting', NOW - 5 * HOUR),
        box('fin', 'done', NOW - MIN),
        box('zz', 'snoozed', NOW, { until: NOW + HOUR }),
        box('run', 'working', NOW - 2 * MIN),
      ],
      NOW,
      'run',
    )
    expect(text.indexOf('话题 old') < text.indexOf('话题 new')).toBe(true)
    expect(text.includes('等你（2）')).toBe(true)
    expect(text.includes('话题 fin')).toBe(false)
    expect(text.includes('稍后提醒（1）')).toBe(true)
    expect(text.includes('话题 run（本会话）')).toBe(true)
    expect(text.includes('今天处理完 1 个')).toBe(true)
    expect(text.includes('claude --resume old')).toBe(true)
  })

  test('first line drops markdown and empty lines', async () => {
    expect(firstLine('\n\n**结论：** 已合并 #12\n细节')).toBe('结论： 已合并 #12')
  })
})
