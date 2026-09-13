#!/usr/bin/env node
/**
 * Reconstruct every Turn of one DSH session log and report whether the shipped
 * Turn-process disclosure is eligible to fold it.
 *
 * This mirrors the client projection in
 * packages/client/ui-chat/src/client/conversation-nodes/turn-process.ts plus the
 * `processWindowReady` gate in ChatNodeSeat.tsx. It exists to answer one
 * question with evidence: which finished Turns the GUI leaves unfolded, and why.
 *
 * Usage: node tools/analyze-turns.mjs <session.v3.jsonl.zstd>
 */
import { readSessionEvents } from './session-log.mjs'

const file = process.argv[2]
if (file === undefined) {
  console.error('usage: node tools/analyze-turns.mjs <session.v3.jsonl.zstd>')
  process.exit(2)
}

const events = readSessionEvents(file)

const SUBAGENT = name => name === 'subagent' || name.startsWith('subagent_')

function blocksOf(data) {
  return data?.message?.content ?? []
}

function replyBlocks(blocks) {
  return blocks.filter(block => {
    const kind = block.type ?? block.kind
    if (kind === 'tool-call') return false
    if (kind === 'text' || kind === 'reasoning') return (block.text ?? '').trim() !== ''
    return true
  })
}

/** @type {Map<number, any>} */
const turns = new Map()

function turnOf(event) {
  const turn = event.data?.turn
  if (typeof turn !== 'number') return undefined
  let state = turns.get(turn)
  if (state === undefined) {
    state = {
      turn,
      steps: [],
      toolCalls: 0,
      subagents: 0,
      messages: 0,
      assistantMessages: 0,
      controlAnchorSeq: undefined,
      closed: false,
      maxTokens: false,
      interrupted: false,
      error: false,
    }
    turns.set(turn, state)
  }
  return state
}

for (const event of events) {
  if (event.type === 'turn/start') {
    const state = turnOf(event)
    if (state !== undefined) state.startSeq = event.seq
    continue
  }
  const state = turnOf(event)
  if (state === undefined) continue
  switch (event.type) {
    case 'turn/end': {
      state.closed = true
      const kind = event.data?.reason?.kind
      if (kind === 'max-tokens') state.maxTokens = true
      else if (kind !== undefined && kind !== 'stop') state.interrupted = true
      break
    }
    case 'step/start': {
      state.steps.push({ step: event.data.step, closed: false, assistant: [], toolCalls: 0 })
      break
    }
    case 'step/end': {
      const last = state.steps.at(-1)
      if (last !== undefined && last.step === event.data.step) last.closed = true
      break
    }
    case 'assistant/message': {
      const blocks = blocksOf(event.data)
      const reply = replyBlocks(blocks)
      const hasToolCall = blocks.some(block => (block.type ?? block.kind) === 'tool-call')
      const step = state.steps.find(candidate => candidate.step === event.data.step)
      if (step !== undefined) {
        step.assistant.push({ seq: event.seq, reply: reply.length, hasToolCall, surfaceOp: event.surfaceOp })
      }
      state.assistantMessages += 1
      if (reply.length > 0) {
        state.messages += 1
        state.controlAnchorSeq = Math.min(state.controlAnchorSeq ?? Infinity, event.seq)
      }
      break
    }
    case 'tool/call': {
      const step = state.steps.find(candidate => candidate.step === event.data.step)
      if (step !== undefined) step.toolCalls += 1
      const subagent = SUBAGENT(String(event.data.name ?? ''))
      state.toolCalls += subagent ? 0 : 1
      state.subagents += subagent ? 1 : 0
      if (state.controlAnchorSeq === undefined) state.controlAnchorSeq = event.seq
      break
    }
    case 'tool/result': {
      if (state.controlAnchorSeq === undefined) state.controlAnchorSeq = event.seq
      break
    }
    case 'turn/error': {
      state.error = true
      break
    }
    default:
      break
  }
}

function latestAnswer(state) {
  const latest = state.steps.at(-1)
  if (latest === undefined) return null
  const candidates = latest.assistant.filter(entry => entry.surfaceOp === 'append')
  const last = candidates.at(-1)
  if (last === undefined) return null
  if (last.reply === 0) return null
  if (last.hasToolCall) return null
  return last
}

let foldable = 0
let unfolded = 0
const rows = []
for (const state of [...turns.values()].sort((a, b) => a.turn - b.turn)) {
  const answer = latestAnswer(state)
  const lastStepClosed = state.steps.at(-1)?.closed === true
  const answerStep = answer === null ? null : state.steps.at(-1).step
  // Hideable rows: everything from processStartSeq up to the answer anchor.
  const hideable = state.steps.flatMap(step => step.assistant.map(entry => entry.seq))
    .filter(seq => answer === null || seq < answer.seq).length + state.toolCalls + state.subagents
  const eligible = state.closed
    && state.controlAnchorSeq !== undefined
    && answer !== null
    && lastStepClosed
    && hideable > 0
  if (eligible) foldable += 1
  else if (hideable > 0) unfolded += 1
  rows.push({
    turn: state.turn,
    steps: state.steps.length,
    msgs: state.messages,
    tools: state.toolCalls,
    subs: state.subagents,
    closed: state.closed,
    lastStepClosed,
    answerStep,
    hideable,
    eligible,
    note: [
      state.closed ? '' : 'turn-still-open',
      state.controlAnchorSeq === undefined ? 'no-process-evidence' : '',
      answer === null ? 'NO-FINAL-ANSWER' : '',
      lastStepClosed ? '' : 'last-step-still-open',
      hideable === 0 ? 'nothing-to-hide' : '',
    ].filter(Boolean).join(','),
  })
}

const width = Math.max(4, ...rows.map(row => String(row.turn).length))
console.log(`turns: ${String(rows.length)}  foldable: ${String(foldable)}  left-unfolded: ${String(unfolded)}`)
console.log('')
console.log(`${'turn'.padStart(width)} steps msgs tools subs closed lastStep answer hideable fold? note`)
for (const row of rows) {
  console.log([
    String(row.turn).padStart(width),
    String(row.steps).padStart(5),
    String(row.msgs).padStart(4),
    String(row.tools).padStart(5),
    String(row.subs).padStart(4),
    String(row.closed).padStart(6),
    String(row.lastStepClosed).padStart(8),
    String(row.answerStep ?? '-').padStart(6),
    String(row.hideable).padStart(8),
    String(row.eligible).padStart(5),
    row.note,
  ].join(' '))
}
