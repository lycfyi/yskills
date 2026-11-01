// Context fill, as session.measure reports it.
export type Reading = {
  percent?: number
  tokens?: number
  window: number
  usd?: number
  fiveHour?: number
  sevenDay?: number
}

export type Compaction = {
  at: number
  trigger: string
  before?: number
  after?: number
  notePath?: string
}

export type RepoStatus = {
  name: string
  root: string
  branch: string
  isWorktree: boolean
  ahead: number
  behind: number
  // Dirty files this session did not touch, and files it did
  others: number
  mine: number
}

// Progress of the current turn, as the model reports it through the progress tool.
export type Plan = {
  // When the turn started; the actual pace is measured from here
  startedAt: number
  total: number
  done: number
  step?: string
  // The latest estimate: when it was given, the model's own figure (ms), and the calibrated one
  guessAt?: number
  rawGuessMs?: number
  guessMs?: number
  // When the work should be done
  finishAt?: number
}

export type RestKind = 'breath' | 'eyes' | 'pushups'

// A break in progress: breathing, eyes or push-ups
export type Rest = {
  kind: RestKind
  startedAt: number
  // Includes the lead-in and the closing hold
  endsAt: number
  // The reply arrived during the break; cleared when the next turn starts
  isAnswered: boolean
  // The reminder interval when the break started, for "next in about N min"; null when the timer is off
  nextMin: number | null
}

// One entry of the breaks row: minutes until a break is due
export type Due = { kind: RestKind; leftMin: number }

// The lines shown after you have been away: goal, last step, next step
export type Recap = {
  // The turn end it was written for; a newer turn makes it stale
  forAt: number
  isReady: boolean
  lines: string[]
  // You answered a question (AskUserQuestion); a later tool call means work started, so the recap goes
  isAnswered?: boolean
}

// The whats-next the HUD runs after you step away
export type AutoNext = {
  // The turn end it already ran for; at most once per absence
  forAt: number | null
  // false: whats-next has run and you have not typed anything since, so it does not run again
  isArmed: boolean
}

declare module 'claude-code' {
  interface PluginState {
    hud: {
      reading: Reading | null
      lastCompaction: Compaction | null
      editedFiles: string[]
      repos: RepoStatus[] | null
      plan: Plan | null
      // Bumped every 10 seconds so the task row's time moves
      tick: number
      turnStartedAt: number | null
      rest: Rest | null
      // The word the break animation reports ("Breathe in 4s"), shown on the spinner line
      restWord: string | null
      due: Due[] | null
      // When the main conversation's last turn ended; the time away counts from here
      lastActiveAt: number | null
      recap: Recap | null
      autoNext: AutoNext
      // Background tasks started from the main conversation that have not reported back
      // (background commands, background agents, Monitor, Workflow), by start time
      backgroundTasks: number[]
      // The turn end a done note was already written for; at most one note per absence
      doneLoggedFor: number | null
      // Replies to HUD_DONE_EXTRA_ASK already handed on in this session, oldest first
      doneExtraSeen: string[]
    }
  }
}
