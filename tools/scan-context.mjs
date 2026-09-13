#!/usr/bin/env node
/**
 * Evidence scan: do injected-context rows sit INSIDE a finished Turn's process
 * range?
 *
 * `ChatNodeSeat` marks a row as process membership when
 * `processStartSeq <= anchorSeq < answerAnchorSeq` AND its kind is not in the
 * shipped `TURN_PROCESS_INDEPENDENT_KINDS`. `processStartSeq` is the Turn's own
 * `turn/start` seq, so everything the model was fed inside that Turn — including
 * plugin-injected context — falls in the range. This mirrors that arithmetic
 * straight off the log to say how many such rows exist and whether the shipped
 * geometry hides them.
 *
 * Usage: node tools/scan-context.mjs <session.v3.jsonl.zstd> [...more]
 */
import { readSessionEvents } from './session-log.mjs'

const SHIPPED_INDEPENDENT = new Set([
  'system-prompt', 'user', 'steering', 'turn-process',
  'turn-error', 'turn-max-tokens', 'turn-tail',
])

const files = process.argv.slice(2)
if (files.length === 0) {
  console.error('usage: node tools/scan-context.mjs <session.v3.jsonl.zstd> [...]')
  process.exit(2)
}

for (const file of files) {
  const events = readSessionEvents(file)
  /** Turn state: start seq, last answer anchor, injected rows. */
  const turns = new Map()
  /** Context-ish `user/message` events, in log order. */
  const injected = []
  for (const event of events) {
    if (event.type === 'user/message' && event.surfaceOp !== 'remove') {
      const source = event.data?.source ?? {}
      if (source.kind !== 'user') {
        injected.push({
          seq: event.seq,
          turn: typeof event.data?.turn === 'number' ? event.data.turn : undefined,
          kind: source.kind,
          plugin: source.plugin ?? null,
          form: source.form ?? null,
          text: JSON.stringify(event.data?.content ?? '').slice(0, 60),
        })
      }
    }
    const turn = event.data?.turn
    if (typeof turn !== 'number') continue
    let state = turns.get(turn)
    if (state === undefined) {
      state = { turn, startSeq: undefined, answerSeq: null, answerStep: null, lastStep: null, closed: false, rows: [] }
      turns.set(turn, state)
    }
    if (event.type === 'turn/start') state.startSeq = event.seq
    if (event.type === 'turn/end') state.closed = true
    if (event.type === 'assistant/message' && event.surfaceOp === 'append') {
      state.answerSeq = event.seq
      state.answerStep = event.data?.step ?? null
    }
  }
  const key = file.split(/[\\/]/u).slice(-3, -2)[0] ?? file
  console.log(`\n== ${key}`)
  console.log(`   events ${String(events.length)}  injected-context events ${String(injected.length)}`)
  for (const entry of injected) {
    const state = entry.turn === undefined ? undefined : turns.get(entry.turn)
    const inRange = state !== undefined
      && state.startSeq !== undefined
      && state.answerSeq !== null
      && entry.seq >= state.startSeq
      && entry.seq < state.answerSeq
    console.log(`   seq ${String(entry.seq).padStart(9)} turn ${String(entry.turn ?? '-').padStart(4)} kind ${entry.kind}${entry.plugin === null ? '' : `:${entry.plugin}`}`
      + ` range[${String(state?.startSeq ?? '-')},${String(state?.answerSeq ?? '-')})`
      + ` INSIDE=${String(inRange)} shippedHides=${String(inRange && !SHIPPED_INDEPENDENT.has('context'))}`
      + `  ${entry.text}`)
  }
}
