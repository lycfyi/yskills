// The break animation: a Client the hooks mount above the prompt. It draws every 100 ms on its own
// frame clock and reports each new word ("Breathe in 4s", "Look away 12s") to the hooks, so the
// spinner line can show it. All three breaks share one line: it grows and shrinks with the breath,
// and for eyes and push-ups it shrinks from both ends toward the middle.

import type { ClientSurface } from 'claude-code'

import type { RestKind } from '../types'
import { CYCLES, PUSHUPS, REST, breathBar, centre, restAt } from './pace.ts'
import type { RestPhase } from './pace.ts'
import { TEXT, restWord } from './text.ts'
import type { Lang, Strings } from './text.ts'

type Props =
  | {
      kind?: RestKind
      offsetMs?: number
      // While the model works, the spinner line already shows the word; the caption leaves it out
      isWorking?: boolean
      // The reply arrived during the break
      isAnswered?: boolean
      // The reminder interval; null when the timer is off
      nextMin?: number | null
      lang?: Lang
    }
  | undefined
type State = { tick: number; offsetMs: number; word: string }

const TICK_MS = 100
// In ECAM, cyan is "an action for you"; all three breaks use it
const COLOR = 'cyan'

const whatOf = (kind: RestKind, phase: RestPhase, t: Strings) =>
  kind === 'breath' ? t.caption.round(phase.cycle, CYCLES) : kind === 'eyes' ? t.caption.eyes : t.caption.pushups(PUSHUPS)

const captionOf = (kind: RestKind, phase: RestPhase, p: NonNullable<Props>, t: Strings) => {
  const stop = `/${REST[kind].command}`
  const word = restWord(phase, t)
  if (phase.stage === 'intro') return `${word} · ${t.caption.stop(stop)}`
  if (phase.stage === 'done') return p.nextMin ? t.caption.doneNext(p.nextMin) : t.caption.done

  const parts = [p.isWorking ? undefined : word, whatOf(kind, phase, t)]
  parts.push(!p.isWorking && p.isAnswered ? t.caption.answered(stop) : t.caption.stop(stop))
  return parts.filter(Boolean).join(' · ')
}

export default function Rest(props: Props, surface: ClientSurface<State>) {
  const { Box, Text } = surface.elements
  const kind = props?.kind ?? 'breath'
  const t = TEXT[props?.lang ?? 'en']

  if (surface.state === undefined) {
    // offsetMs is how far into the break it was when mounted; count on from there
    surface.setState({ tick: 0, offsetMs: props?.offsetMs ?? 0, word: '' })
    surface.every(TICK_MS, () => {
      const s = surface.state
      if (s === undefined) return
      const tick = s.tick + 1
      const word = restWord(restAt(kind, s.offsetMs + tick * TICK_MS), t)
      if (word !== s.word) surface.post({ word })
      surface.setState({ tick, offsetMs: s.offsetMs, word })
    })
  }

  const s = surface.state
  const phase = restAt(kind, (s?.offsetMs ?? props?.offsetMs ?? 0) + (s?.tick ?? 0) * TICK_MS)
  const width = surface.columns || 80
  const bar = breathBar(phase.fill, width)

  return (
    <Box flexDirection="column" width={width}>
      <Box flexDirection="row">
        <Text>{bar.indent}</Text>
        <Text color={COLOR} dimColor>
          {bar.trackLeft}
        </Text>
        <Text color={COLOR}>{bar.lit}</Text>
        <Text color={COLOR} dimColor>
          {bar.trackRight}
        </Text>
      </Box>
      <Text color={COLOR} dimColor>
        {centre(captionOf(kind, phase, props ?? {}, t), width)}
      </Text>
    </Box>
  )
}
