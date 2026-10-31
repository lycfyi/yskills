// Every word the HUD shows or sends, in one table per language, plus the pure functions that format
// rows and parse git output and model replies. No `$` here, so tests call it directly.
// English by default; HUD_LANG=zh switches to Chinese.

import type { Compaction, Due, Plan, Reading, RepoStatus } from '../types'
import { describeSteps, etaOf } from './pace.ts'
import type { RestPhase } from './pace.ts'

export const TOOL = 'mcp__hud__progress'

export const WARN = 70
export const ALARM = 85
export const BAR_CELLS = 10

export type Lang = 'en' | 'zh'

// zh, zh-CN, zh_TW ... pick Chinese; anything else, or nothing, is English.
export const langOf = (value: string | undefined): Lang =>
  (value ?? '').trim().toLowerCase().startsWith('zh') ? 'zh' : 'en'

// ───────────── the tables ─────────────

const en = {
  // Row labels, padded to one column
  label: { context: 'context', repo: 'repo', task: 'task', recap: 'recap', due: 'breaks' },

  // repo and context rows
  clean: 'clean',
  changes: (others: number, mine: number) => `others ${others} · mine ${mine}`,
  compacted: (clock: string) => `compacted ${clock}`,

  // task row
  estimate: (minutes: number) => `est ${minutes} min`,
  late: (minutes: number) => `${minutes} min over`,

  // breaks row
  short: { breath: 'breathe', eyes: 'eyes', pushups: 'push-ups' },
  due: 'due',

  // Recap: the three line keys, the reverse-video label of the next step, and the patterns that color it
  recap: { goal: 'Goal', last: 'Last', next: 'Next' },
  recapMax: 120,
  recapWaiting: 'Recapping what this session was doing…',
  nextLabel: ' Next ',
  closable: /^safe to close\b/i,
  keepOpen: /^(don['’]t|do not) close\b/i,
  recapAsk: [
    'The user stepped away. When they come back, they read three lines above the prompt to recall what this session is doing, then decide what to do next.',
    'Based only on the conversation above, write the three lines below in English, each under 80 characters. No heading, no markdown, no tool calls, nothing else.',
    'Goal: what this session is for',
    'Last: the last thing finished, or what it is stuck on',
    'Next: the one thing to do next; if the user must decide something, say exactly what. Uncommitted or undeployed changes and questions waiting for the user all count as next steps. If something still running needs this session open, start with "Don\'t close:". Only when the work is done, verified and nothing is left, write just "Safe to close".',
  ].join('\n'),

  // Done note
  doneKey: { done: 'Done', status: 'Status', open: 'Left open' },
  noGoal: '(no goal given)',
  doneAsk: [
    "This session is done; write one entry for the user's done log.",
    'Based only on the conversation above, write the three lines below in English, with only facts the conversation shows (tool results, commits, PRs, deploys, checks). No heading, no markdown, no tool calls, nothing else.',
    'Done: two to five items, separated by semicolons: what shipped, PR numbers, what was decided, which documents were written.',
    'Status: deployed and verified / merged but not deployed / docs only, nothing to deploy; say which is true, and if it was verified, how.',
    'Left open: what was not done, what is waiting, what to check later; "none" if nothing.',
    'Use the names the user sees, not internal field names, table names or terms you made up. Each line under 160 characters.',
  ].join('\n'),

  // Compaction: added after the compaction instructions, then the notes file and the toasts
  keep: [
    'Also keep the four lists below separate, written as lists, not folded into the narrative:',
    '1. Decisions the user clearly made or approved in this session: what was decided, where it applies, and roughly when. Mark anything only raised and not confirmed as "open"; do not write it as decided.',
    '2. Authorization: which write actions the user approved (production data, deploys, publishing, sending messages, and so on) and how far; also what was clearly not approved or must be asked again.',
    '3. The task in progress: goal, how far it got, the next step, what it is stuck on.',
    '4. Files created or changed in this session, with full paths.',
  ].join('\n'),
  noteTitle: (iso: string) => `# Before compaction ${iso}`,
  notePrompts: (count: number) => `## Your messages (${count}, oldest first)`,
  noteFiles: (count: number) => `## Files changed (${count})`,
  noteNone: '(none)',
  clipped: (length: number) => `… (cut; ${length} characters in all)`,
  contextToast: (percent: number) => `Context at ${percent}%: auto-compact is near`,
  compactedToast: (path: string) => `Compacted. Your messages are saved in ${path}`,
  compactedNoNote: 'Compacted (the notes were not saved)',

  // The progress tool: its description, input, system-prompt section and answers
  toolDescription:
    "Report this turn's progress to the user; the display shows how long is left. Call it once when multi-step work starts (done=0, with total and minutes), then once after each step.",
  schema: {
    done: 'Steps finished so far',
    total: 'Planned number of steps; change it when the plan changes',
    minutes: 'Minutes from now until all steps are done. Required at the start; give it again if the estimate turns out clearly wrong',
    step: 'The step you are on now, in a few words',
  },
  guide: [
    '## Report progress to the user',
    'While you work, the user needs to know how long it will take, to decide whether to wait or do something else first.',
    `- Work you expect to take over 1 minute or more than 2 steps: before you start, call ${TOOL} with done=0, total=the planned steps, minutes=your estimate from now until done (err on the long side).`,
    '- After each step, call it again: done plus 1, step = the next step in a few words.',
    '- If the plan changes, change total; if the estimate turns out clearly wrong, give minutes again.',
    '- Do not call it for turns that only answer a question or take one or two tool calls.',
    '- The tool only feeds the display; do not mention it in your reply.',
  ].join('\n'),
  toolSubagent: "Subagents' progress is not shown; no need to call this.",
  toolDeny: 'done must be an integer ≥ 0 and total an integer ≥ 1.',
  toolNoted: (done: number, total: number) => `Noted ${done}/${total}.`,

  // The break animation: the word on the spinner line, and the caption under the line
  restWord: {
    intro: 'Breathe with the line',
    inhale: (seconds: number) => `Breathe in ${seconds}s`,
    exhale: (seconds: number) => `Breathe out ${seconds}s`,
    look: (seconds: number) => `Look away ${seconds}s`,
    pushups: (seconds: number) => `Push-ups ${seconds}s`,
    done: 'Done',
  },
  caption: {
    round: (cycle: number, of: number) => `Round ${cycle}/${of}`,
    eyes: 'Look at something 20 ft (6 m) away, eyes off the screen',
    pushups: (count: number) => `Stand up and do ${count} push-ups`,
    stop: (command: string) => `${command} to stop`,
    answered: (command: string) => `Reply is in, ${command} to stop`,
    done: 'Done ✓',
    doneNext: (minutes: number) => `Done ✓ · next in about ${minutes} min`,
  },

  // /breathe, /eyes, /pushups
  restName: { breath: 'Breathing reminder', eyes: 'Eye-break reminder', pushups: 'Push-up reminder' },
  restOff: (name: string) => `${name}: off.`,
  restOn: (name: string, every: number, leftMin: number) =>
    `${name}: on, every ${every} min; ${
      leftMin === 0 ? 'starts the next time you wait more than 20 seconds' : `next in about ${leftMin} min, while you wait`
    }.`,
  restStopped: { breath: 'Breathing stopped.', eyes: 'Eye break stopped.', pushups: 'Push-ups stopped.' },
  restStarted: {
    breath: 'One minute of breathing: watch the line above the prompt. Breathe in as it grows, out as it shrinks.',
    eyes: 'Eye break, 20 seconds: look at something 20 ft (6 m) away, eyes off the screen. Done when the line runs out.',
    pushups: 'Stand up and do 10 push-ups. The line runs out in 1 minute and closes by itself.',
  },
  restDescription: {
    breath: 'One minute of breathing; reminder on/off and interval (hud)',
    eyes: '20-second eye break; reminder on/off and interval (hud)',
    pushups: '10 push-ups; reminder on/off and interval (hud)',
  },
  restArgHint: '[off | on | <minutes>]',
  // `command` comes padded to 9 columns
  restHelp: (command: string) =>
    [
      `${command}          start one now; type it again while it runs to stop`,
      `${command} off | on turn the timed reminder off or on`,
      `${command} 45       remind every 45 minutes (5–240)`,
      '',
      'Reminders start only after the model has worked for 20 seconds, one at a time, at least 5 minutes apart.',
    ].join('\n'),

  // /autonext
  autoDescription: 'Run whats-next after you step away: on/off and minutes (hud)',
  autoArgHint: '[off | on | <minutes>]',
  autoState: (isOn: boolean, minutes: number, command: string | undefined) =>
    [
      !isOn
        ? 'Auto whats-next: off. The recap shows after 20 minutes away.'
        : command === undefined
          ? `Auto whats-next: on, but no whats-next command was found, so after ${minutes} minutes away only the recap shows. Set HUD_WHATS_NEXT_COMMAND to pick one.`
          : `Auto whats-next: on. After ${minutes} minutes away the recap shows, then /${command} runs.`,
      '',
      '/autonext off | on turn it off or on',
      '/autonext 5        run after 5 minutes away (1–60)',
      '',
      'It runs once per absence: after that it waits until you type something yourself, whatever you picked or if you pressed Esc.',
    ].join('\n'),

  // /donelog
  doneDescription: 'Write a done note when a session can be closed: on/off (hud)',
  doneArgHint: '[off | on]',
  doneState: (isOn: boolean, command: string | undefined) =>
    [
      `Done note when the session can be closed: ${isOn ? 'on' : 'off'}.`,
      'Notes go to ~/.claude/hud/done-log/',
      command === undefined
        ? 'Set HUD_DONE_CMD to run a command with each note path.'
        : `After each note: ${command} <note path>`,
      '',
      '/donelog off | on turn it off or on',
    ].join('\n'),
}

export type Strings = typeof en

const zh: Strings = {
  label: { context: 'context', repo: 'repo', task: 'task', recap: 'recap', due: 'next' },

  clean: '干净',
  changes: (others, mine) => `别人的改动 ${others} · 我的 ${mine}`,
  compacted: clock => `上次压缩 ${clock}`,

  estimate: minutes => `预估 ${minutes} 分钟`,
  late: minutes => `超时 ${minutes} 分钟`,

  short: { breath: '呼吸', eyes: '护眼', pushups: '俯卧撑' },
  due: '到点',

  recap: { goal: '在做', last: '停在', next: '下一步' },
  recapMax: 80,
  recapWaiting: '整理中：离开前在做什么、下一步…',
  nextLabel: ' 下一步 ',
  closable: /可以关/,
  keepOpen: /别关/,
  recapAsk: [
    '操作者离开了一阵。回来时，操作者先看提示符上方的三行，快速想起这个 session 在干什么，再决定下一步。',
    '只根据上面的对话，用中文写下面三行。每行不超过 40 个字。不写标题，不用 markdown，不调用工具，不写别的。',
    '在做：这个 session 的目标',
    '停在：最后做完了什么，或者卡在什么上',
    '下一步：最该做的一件事；如果要操作者拍板，写清楚要操作者决定什么。没提交或没上线的改动、等操作者回答的问题，都算下一步。任务做完、验证过、没有待办，只写「可以关」。',
  ].join('\n'),

  doneKey: { done: '做完了', status: '状态', open: '留着的' },
  noGoal: '（没写目标）',
  doneAsk: [
    '这个 session 做完了，要在操作者的收尾记录里记一条。',
    '只根据上面的对话，用中文写下面三行，只写对话里有证据的事实（工具结果、提交、PR、部署、核对）。不写标题，不用 markdown，不调用工具，不写别的。',
    '做完了：两到五件，用分号隔开。写上线了什么、PR 号、拍板了什么、写了哪份文档。',
    '状态：已上线并验证过 / 合并了还没部署 / 改的是文档不需要部署，照实写；验证过就写怎么验的。',
    '留着的：没做的、要等的、以后要看的；没有就写「无」。',
    '不写内部字段名、表名、agent 自己造的词；要提就用操作者在界面上看到的名字。每行不超过 160 个字。',
  ].join('\n'),

  keep: [
    '另外务必单独保留下面四类，写成清单，不要并进叙述里：',
    '1. 用户在本 session 明确拍板或认可的决定：决定了什么、适用范围、大致时间。只是提过、还没确认的，标成「待定」，不要写成已决定。',
    '2. 授权范围：用户批准过哪些写操作（生产库、部署、发布、发消息等），批到什么程度；明确没批或说了要再问的，也写上。',
    '3. 正在做的任务：目标、做到哪一步、下一步、卡在什么上。',
    '4. 本 session 新建或改过的文件，写完整路径。',
  ].join('\n'),
  noteTitle: iso => `# 压缩前备忘 ${iso}`,
  notePrompts: count => `## 用户原话（${count} 条，按时间）`,
  noteFiles: count => `## 改过的文件（${count}）`,
  noteNone: '（无）',
  clipped: length => `…（截断，原文 ${length} 字）`,
  contextToast: percent => `context 已到 ${percent}%，快要自动压缩了`,
  compactedToast: path => `已压缩，原话备忘：${path}`,
  compactedNoNote: '已压缩（备忘没存下来）',

  toolDescription:
    '向操作者报告这一轮工作的进度，界面据此显示还要多久。多步工作开始时调用一次（done=0，给 total 和 minutes），之后每做完一步调用一次。',
  schema: {
    done: '已经做完的步数',
    total: '计划的总步数；计划变了就改',
    minutes: '从现在到全部做完还要几分钟。开始时必给；明显估错了再给一次',
    step: '接下来在做的这一步，十个字以内',
  },
  guide: [
    '## 给操作者报进度',
    '操作者等你干活时，需要知道还要多久，好决定是等着还是先去做别的。',
    `- 预计超过 1 分钟、或者超过 2 步的工作：动手前调用 ${TOOL}，done=0，total=计划的步数，minutes=你估计从现在到做完要几分钟（宁可估长）。`,
    '- 每做完一步调用一次：done 加 1，step 写接下来那一步（十个字以内）。',
    '- 计划变了就改 total；明显估错了就重新给 minutes。',
    '- 只回答问题、一两次工具调用就能做完的回合，不要调用。',
    '- 这个工具只给界面用，回复里不用提它。',
  ].join('\n'),
  toolSubagent: '子 agent 的进度不显示，不用调用。',
  toolDeny: 'done 要是 ≥0 的整数，total 要是 ≥1 的整数。',
  toolNoted: (done, total) => `已记下 ${done}/${total}。`,

  restWord: {
    intro: '跟着线呼吸',
    inhale: seconds => `吸气 ${seconds} 秒`,
    exhale: seconds => `呼气 ${seconds} 秒`,
    look: seconds => `看远处 ${seconds} 秒`,
    pushups: seconds => `俯卧撑 ${seconds} 秒`,
    done: '做完了',
  },
  caption: {
    round: (cycle, of) => `第 ${cycle}/${of} 次`,
    eyes: '看 6 米外的东西，眼睛离开屏幕',
    pushups: count => `起身做 ${count} 个俯卧撑`,
    stop: command => `${command} 停止`,
    answered: command => `回答到了，${command} 可停止`,
    done: '做完了 ✓',
    doneNext: minutes => `做完了 ✓ · 下次约 ${minutes} 分钟后`,
  },

  restName: { breath: '呼吸练习', eyes: '护眼提醒', pushups: '俯卧撑提醒' },
  restOff: name => `定时${name}：关。`,
  restOn: (name, every, leftMin) =>
    `定时${name}：开，每 ${every} 分钟一次；${leftMin === 0 ? '下一次等待超过 20 秒时开始' : `约 ${leftMin} 分钟后，在等待时开始`}。`,
  restStopped: { breath: '呼吸练习停了。', eyes: '护眼停了。', pushups: '俯卧撑停了。' },
  restStarted: {
    breath: '开始一分钟呼吸练习：看提示符上方那条线，线变长时吸气，变短时呼气。',
    eyes: '护眼 20 秒：看 6 米外的东西，眼睛离开屏幕。线缩完就好。',
    pushups: '起身做 10 个俯卧撑。线缩完（1 分钟）自己收起。',
  },
  restDescription: {
    breath: '一分钟呼吸练习；定时提醒的开关和间隔（hud）',
    eyes: '护眼 20 秒，看远处；定时提醒的开关和间隔（hud）',
    pushups: '起身做 10 个俯卧撑；定时提醒的开关和间隔（hud）',
  },
  restArgHint: '[off | on | <分钟>]',
  restHelp: command =>
    [
      `${command}          现在做一次；正在做时输入它就停止`,
      `${command} off | on 关闭或打开定时提醒`,
      `${command} 45       把间隔改成 45 分钟（5–240）`,
      '',
      '几种提醒只在模型干活超过 20 秒时出现，一次一种，两次之间至少隔 5 分钟。',
    ].join('\n'),

  autoDescription: '离开几分钟后自动跑 /whats-next 的开关和分钟数（hud）',
  autoArgHint: '[off | on | <分钟>]',
  autoState: (isOn, minutes, command) =>
    [
      !isOn
        ? '离开后自动跑 /whats-next：关。离开 20 分钟时，提示符上方给 recap 三行。'
        : command === undefined
          ? `离开 ${minutes} 分钟先在提示符上方写 recap 三行：开。没找到 whats-next 命令，不自动跑；可以用 HUD_WHATS_NEXT_COMMAND 指定。`
          : `离开 ${minutes} 分钟先在提示符上方写 recap 三行，再自动跑 /${command}：开。`,
      '',
      '/autonext off | on 关闭或打开',
      '/autonext 5        改成离开 5 分钟（1–60）',
      '',
      '自动跑完、你点了「先放着」或按了 Esc，就不再跑，等你下次自己打字。',
    ].join('\n'),

  doneDescription: '做完可以关时记一条收尾的开关（hud）',
  doneArgHint: '[off | on]',
  doneState: (isOn, command) =>
    [
      `做完可以关时记一条收尾：${isOn ? '开' : '关'}。`,
      '收尾记在 ~/.claude/hud/done-log/',
      command === undefined ? '设了 HUD_DONE_CMD，记完会带上收尾文件的路径跑它。' : `记完跑：${command} <收尾文件路径>`,
      '',
      '/donelog off | on 关闭或打开',
    ].join('\n'),
}

export const TEXT: Record<Lang, Strings> = { en, zh }

export const schemaOf = (t: Strings) => ({
  type: 'object',
  properties: {
    done: { type: 'integer', minimum: 0, description: t.schema.done },
    total: { type: 'integer', minimum: 1, description: t.schema.total },
    minutes: { type: 'number', exclusiveMinimum: 0, description: t.schema.minutes },
    step: { type: 'string', description: t.schema.step },
  },
  required: ['done', 'total'],
})

// ───────────── small helpers ─────────────

export const k = (n: number) => `${Math.round(n / 1000)}k`

export const pad = (n: number) => String(n).padStart(2, '0')

export const clockTime = (ms: number) => {
  const d = new Date(ms)
  return `${pad(d.getHours())}:${pad(d.getMinutes())}`
}

// Local time, for the done note's heading
export const dateTime = (ms: number) => {
  const d = new Date(ms)
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${clockTime(ms)}`
}

export const stamp = (ms: number) => {
  const d = new Date(ms)
  return `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}-${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}`
}

export const dirname = (path: string) => path.slice(0, Math.max(path.lastIndexOf('/'), 1))

export const basename = (path: string) => path.slice(path.lastIndexOf('/') + 1)

export const stripReminders = (text: string) => text.replace(/<system-reminder>[\s\S]*?<\/system-reminder>/g, '').trim()

export const clip = (text: string, max: number, t: Strings) =>
  text.length > max ? `${text.slice(0, max)}\n${t.clipped(text.length)}` : text

// ───────────── rows ─────────────

const unquote = (path: string) => (path.startsWith('"') ? path.slice(1, -1) : path)

export const parseStatus = (stdout: string) => {
  const [head = '', ...entries] = stdout.split('\n').filter(line => line !== '')
  const branch =
    head.match(/^## No commits yet on (.+)$/)?.[1] ?? head.match(/^## (.+?)(?:\.\.\.\S+)?(?: \[.*\])?$/)?.[1] ?? '?'
  const paths = entries.map(line => {
    const path = line.slice(3)
    const arrow = path.indexOf(' -> ')
    return unquote(arrow === -1 ? path : path.slice(arrow + 4))
  })

  return {
    branch,
    ahead: Number(head.match(/ahead (\d+)/)?.[1] ?? 0),
    behind: Number(head.match(/behind (\d+)/)?.[1] ?? 0),
    paths,
  }
}

export const describeRepo = (r: RepoStatus, t: Strings) => {
  const drift = [r.ahead > 0 ? `↑${r.ahead}` : '', r.behind > 0 ? `↓${r.behind}` : ''].join('')
  const where = [r.name, r.branch, r.isWorktree ? '(worktree)' : '', drift].filter(Boolean).join(' ')
  const changes = r.others === 0 && r.mine === 0 ? t.clean : t.changes(r.others, r.mine)
  return `${where} · ${changes}`
}

export const describeExtras = (now: Reading, compaction: Compaction | null, t: Strings) =>
  [
    now.tokens !== undefined ? `${k(now.tokens)}/${k(now.window)}` : undefined,
    now.usd !== undefined ? `$${now.usd.toFixed(2)}` : undefined,
    now.fiveHour !== undefined ? `5h ${now.fiveHour}%` : undefined,
    now.sevenDay !== undefined ? `7d ${now.sevenDay}%` : undefined,
    compaction
      ? `${t.compacted(clockTime(compaction.at))}${
          compaction.before !== undefined && compaction.after !== undefined
            ? ` ${k(compaction.before)}→${k(compaction.after)}`
            : ''
        }`
      : undefined,
  ].filter(Boolean)

// The same glyphs as /context (⛁ full, ⛀ part, ⛶ empty), a space apart, so they never read as the
// task row's ▰▱ step cells. A remainder of three quarters or more rounds up; under a quarter is dropped.
export const contextCells = (percent: number) => {
  const exact = Math.max(0, Math.min(100, percent)) / (100 / BAR_CELLS)
  let full = Math.floor(exact)
  const rest = exact - full
  if (rest >= 0.75) full += 1
  const partial = rest >= 0.25 && rest < 0.75 ? 1 : 0
  return {
    used: [...Array(full).fill('⛁'), ...Array(partial).fill('⛀')].join(' '),
    free: Array(BAR_CELLS - full - partial).fill('⛶').join(' '),
  }
}

export const contextColor = (percent: number) => (percent >= ALARM ? 'red' : percent >= WARN ? 'yellow' : 'green')

export const describeEta = (p: Plan, now: number, t: Strings) => {
  const head = describeSteps(p.done, p.total)
  const eta = etaOf(p, now)
  if (eta.kind === 'late') return `${head} · ${t.late(eta.minutes)}`
  if (eta.kind === 'quiet') return head
  return `${head} · ${t.estimate(eta.minutes)}${eta.finishAt !== undefined ? ` · ${clockTime(eta.finishAt)}` : ''}`
}

export const describeTask = (p: Plan, now: number, t: Strings) => [p.step, describeEta(p, now, t)].filter(Boolean).join(' ')

export const describeDue = (list: readonly Due[], t: Strings) =>
  list.map(d => `${t.short[d.kind]} ${d.leftMin === 0 ? t.due : `${d.leftMin}m`}`).join(' · ')

export const isSameDue = (a: readonly Due[] | null, b: readonly Due[]) =>
  a !== null && a.length === b.length && a.every((d, i) => d.kind === b[i]?.kind && d.leftMin === b[i]?.leftMin)

// The words of a break phase: "Breathe in 4s", "Look away 12s"
export const restWord = (phase: RestPhase, t: Strings) => {
  switch (phase.step) {
    case 'intro':
      return t.restWord.intro
    case 'inhale':
      return t.restWord.inhale(phase.seconds)
    case 'exhale':
      return t.restWord.exhale(phase.seconds)
    case 'look':
      return t.restWord.look(phase.seconds)
    case 'pushups':
      return t.restWord.pushups(phase.seconds)
    case 'done':
      return t.restWord.done
  }
}

// The HUD's rows. When rows run short, KEEP_FIRST says which stay; ORDER says how they are drawn.
export type Row = 'context' | 'repo' | 'task' | 'rest' | 'recap' | 'next'

const ORDER: readonly Row[] = ['context', 'repo', 'task', 'rest', 'recap', 'next']
const KEEP_FIRST: readonly Row[] = ['context', 'recap', 'rest', 'task', 'repo', 'next']
const HEIGHT: Record<Row, number> = { context: 1, repo: 1, task: 1, rest: 2, recap: 3, next: 1 }

// The recap's height follows its content: one line while it is being written, up to three after
export const fitRows = (wanted: ReadonlySet<Row>, maxRows: number, recapRows = HEIGHT.recap): Row[] => {
  const height = (row: Row) => (row === 'recap' ? recapRows : HEIGHT[row])
  const kept = new Set<Row>()
  let used = 0
  for (const row of KEEP_FIRST) {
    if (!wanted.has(row) || used + height(row) > maxRows) continue
    kept.add(row)
    used += height(row)
  }
  return ORDER.filter(row => kept.has(row))
}

// ───────────── away: recap and whats-next ─────────────

// Away this long (with auto whats-next off), the recap appears above the prompt
export const AWAY_MIN = 20

// Away this long, the HUD writes the recap and then runs whats-next, so both are waiting when you return
export const AUTO_NEXT_MIN = 10
export const AUTO_COMMAND = 'autonext'
export const DONE_COMMAND = 'donelog'

// A plain skill is /whats-next; through a plugin it is /<plugin>:whats-next (for example /yskills:whats-next).
export const WHATS_NEXT = 'whats-next'

const bare = (name: string) => name.trim().replace(/^\//, '')

// A command or skill name that is whats-next under either name, or the command set in HUD_WHATS_NEXT_COMMAND
export const isWhatsNextName = (name: string | undefined, custom?: string) => {
  const n = bare(name ?? '')
  if (n === '') return false
  return n === WHATS_NEXT || n.endsWith(`:${WHATS_NEXT}`) || (custom !== undefined && custom !== '' && n === bare(custom))
}

// A typed line that runs whats-next: "/whats-next", "/yskills:whats-next main"
export const isWhatsNext = (text: string | undefined, custom?: string) => {
  const head = (text ?? '').trim().split(/\s+/)[0] ?? ''
  return head.startsWith('/') && isWhatsNextName(head, custom)
}

// Of the commands available, the one to run: the plain /whats-next first, else a plugin's
export const pickWhatsNext = (names: readonly string[]) =>
  names.includes(WHATS_NEXT) ? WHATS_NEXT : names.find(name => name.endsWith(`:${WHATS_NEXT}`))

// HUD_WHATS_NEXT_COMMAND: "/my-next --short" → { command: "my-next", args: "--short" }
export const parseCommandSetting = (value: string | undefined) => {
  const [head = '', ...rest] = (value ?? '').trim().split(/\s+/)
  const command = bare(head)
  return command === '' ? undefined : { command, args: rest.join(' ') }
}

const cleanLine = (line: string) =>
  line
    .replace(/^[\s*#>\-•]+/, '')
    .replace(/\*\*/g, '')
    .trim()

const startsWithKey = (line: string, key: string) => line.toLowerCase().startsWith(key.toLowerCase())

// The text after "Next:" or "下一步："
export const afterKey = (line: string, key: string) =>
  startsWithKey(line, key) ? line.slice(key.length).replace(/^\s*[:：]\s*/, '').trim() : line.trim()

// Picks the three keyed lines; if the model ignored the format, the first three non-empty lines
export const parseRecap = (text: string, t: Strings): string[] => {
  const lines = text
    .split('\n')
    .map(cleanLine)
    .filter(line => line !== '')
  const keyed = [t.recap.goal, t.recap.last, t.recap.next]
    .map(key => lines.find(line => startsWithKey(line, key)))
    .filter((line): line is string => line !== undefined)
  return (keyed.length > 0 ? keyed : lines.slice(0, 3)).map(line => line.slice(0, t.recapMax))
}

export const isGoalLine = (line: string, t: Strings) => startsWithKey(line, t.recap.goal)

export const isNextLine = (line: string, t: Strings) => startsWithKey(line, t.recap.next)

export const nextContent = (line: string, t: Strings) => afterKey(line, t.recap.next)

// The next step says the session can be closed: nothing is left to do
export const isClosable = (line: string, t: Strings) => isNextLine(line, t) && t.closable.test(nextContent(line, t))

// The next step's color, after ECAM: green is "fine to close", amber (yellow in a terminal) is
// "don't close", and cyan, the rest, is "action for you".
export const nextTone = (line: string, t: Strings): 'green' | 'yellow' | 'cyan' =>
  isClosable(line, t) ? 'green' : t.keepOpen.test(nextContent(line, t)) ? 'yellow' : 'cyan'

// ───────────── done note ─────────────

// One note: a heading of time · repo · goal, then the three lines. No "Done" line, no note.
export const formatDoneEntry = (
  input: { at: number; repo: string; goal: string; text: string },
  t: Strings,
): string | null => {
  const lines = input.text
    .split('\n')
    .map(cleanLine)
    .filter(line => line !== '')
  const keyed = [t.doneKey.done, t.doneKey.status, t.doneKey.open]
    .map(key => lines.find(line => startsWithKey(line, key)))
    .filter((line): line is string => line !== undefined)
  if (!keyed.some(line => startsWithKey(line, t.doneKey.done))) return null
  const goal = afterKey(input.goal, t.recap.goal) || t.noGoal
  return [`## ${dateTime(input.at)} · ${input.repo} · ${goal}`, '', ...keyed.map(line => `- ${line.slice(0, 240)}`), ''].join(
    '\n',
  )
}
