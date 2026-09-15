#!/usr/bin/env node
/**
 * Unit tests for the fold decision logic.
 *
 * The decision is rendered-group driven: rows and their order come from the seat
 * wrappers, membership in the process range comes from the seat's own mark, and
 * the store contributes only per-key content. These tests therefore build the
 * same shapes `ChatNodeSeat` writes and assert on what a pass would hide.
 *
 * Run: node --test tools/logic.test.mjs
 */
import assert from 'node:assert/strict'
import { test } from 'node:test'
import {
  KIND_ATTRIBUTE, MEMBER_ATTRIBUTE, attachNodeData, autoScrollTarget, effectiveTurns, foldColumn,
  foldTurn, groupSeats, isAnswerRow, isContextRow, isIndependentKind, isProcessMember,
} from '../src/logic.js'

/**
 * A stand-in for one seat wrapper: only attribute reads are used by the logic.
 * @param attributes - `{ key, kind, turn, member }`; a null `turn` mirrors the
 *   seat of a row whose Location is unresolved (injected context), which React
 *   renders as the literal string "null".
 * @returns an object exposing `getAttribute` / `hasAttribute`.
 */
function seat({ key, kind, turn = null, member = false }) {
  return {
    getAttribute(name) {
      if (name === 'data-chat-anchor-key') return key
      if (name === KIND_ATTRIBUTE) return kind
      if (name === 'data-chat-turn') return turn === null ? null : String(turn)
      return null
    },
    hasAttribute(name) {
      return name === MEMBER_ATTRIBUTE && member
    },
  }
}

/**
 * A stand-in for the flow column.
 * @param seats - the seat stubs in DOM order.
 * @returns an object exposing `querySelectorAll`.
 */
function column(seats) {
  return { querySelectorAll: () => seats }
}

/**
 * Mutable DOM elements for a whole pass: real attribute state plus `dataset`.
 *
 * A `turn-process` seat also gets the row element the product renders INSIDE it,
 * because that inner element is the one carrying `data-open` — the seat wrapper
 * never has it.
 * @param descriptions - `{ key, kind, turn, member, open }`, in DOM order.
 * @returns `{ column, elements, rows }`, where `rows[i]` is seat `i`'s row.
 */
function dom(descriptions) {
  /** One element backed by a live attribute map. */
  const elementWith = (attributes) => ({
    dataset: {},
    getAttribute: name => (attributes.has(name) ? attributes.get(name) : null),
    setAttribute(name, value) { attributes.set(name, value) },
    removeAttribute(name) { attributes.delete(name) },
    hasAttribute: name => attributes.has(name),
    querySelector: () => null,
    _attributes: attributes,
  })
  const elements = descriptions.map(({ key, kind, turn, member = false, open = false }) => {
    const attributes = new Map()
    if (key !== null && key !== undefined) attributes.set('data-chat-anchor-key', key)
    attributes.set(KIND_ATTRIBUTE, kind)
    if (turn !== null && turn !== undefined) attributes.set('data-chat-turn', String(turn))
    if (member) attributes.set(MEMBER_ATTRIBUTE, '')
    const element = elementWith(attributes)
    if (kind !== 'turn-process') return element
    const rowAttributes = new Map([['data-turn-process', String(turn)], [KIND_ATTRIBUTE, kind]])
    if (open) rowAttributes.set('data-open', '')
    const row = elementWith(rowAttributes)
    element.querySelector = selector => (selector === '[data-turn-process]' ? row : null)
    return element
  })
  return {
    column: { querySelectorAll: () => elements },
    elements,
    rows: elements.map(element => element.querySelector('[data-turn-process]')),
  }
}

/** The pass operations, mirroring what the browser half supplies. */
const OPS = {
  setTurn(element, turn) {
    element.dataset.folditupTurn = String(turn)
  },
  stamp(element, seq) {
    if (seq === null || seq === undefined) delete element.dataset.folditupSeq
    else element.dataset.folditupSeq = String(seq)
  },
  setHidden(element, hidden) {
    if (hidden) {
      if (element.getAttribute('hidden') !== 'until-found') element.setAttribute('hidden', 'until-found')
      return
    }
    if (element.hasAttribute('hidden')) element.removeAttribute('hidden')
  },
  setAnswer(element, answer) {
    if (answer) element.dataset.foldItUpAnswer = '1'
    else delete element.dataset.foldItUpAnswer
  },
}

/**
 * Build one store node.
 * @param options - `{ seq, step, blocks, turn }`.
 * @returns the node shape `attachNodeData` reads.
 */
function node({ seq = null, step = null, blocks = [], turn = 1 } = {}) {
  return { anchorSeq: seq, location: { kind: 'turn', turn: { turn } }, data: { step, blocks } }
}

/** Text blocks carrying `length` characters. */
function prose(length) {
  return [{ type: 'text', text: 'x'.repeat(length) }]
}

/** A reply that also called a tool: process, never an answer. */
function withTool(length = 5) {
  return [{ type: 'text', text: 'x'.repeat(length) }, { type: 'tool-call', name: 'read' }]
}

/**
 * The projection of a Turn that has ENDED, which is the only state in which a
 * fold may exist at all.
 * @param fields - the projection fields under test.
 * @returns the fold descriptor `foldTurn` expects.
 */
function ended(fields = {}) {
  return { answerStep: null, answerAnchorSeq: null, open: false, closed: true, ...fields }
}

/**
 * The projection of a Turn that is STILL RUNNING.
 *
 * The published boundary is real — it is the previous step's finalized answer —
 * which is exactly why the closure flag and not the boundary has to decide.
 * @param fields - the projection fields under test.
 * @returns the fold descriptor `foldTurn` expects for a live Turn.
 */
function running(fields = {}) {
  return { answerStep: null, answerAnchorSeq: null, open: false, closed: false, ...fields }
}

/**
 * Build a finished turn's seats plus the node map that describes them.
 *
 * Shape mirrors a real transcript: the opening human message stays above the
 * control, every process row is marked, and the closing prose reply is the last
 * assistant row and carries no member mark.
 * @returns `{ seats, nodes }` in DOM order.
 */
function finishedTurn() {
  const seats = [
    seat({ key: 'user', kind: 'user', turn: 1 }),
    seat({ key: 'control', kind: 'turn-process', turn: 1 }),
    seat({ key: 'a1', kind: 'assistant-step', turn: 1, member: true }),
    seat({ key: 't1', kind: 'tool-call', turn: 1, member: true }),
    seat({ key: 'a2', kind: 'assistant-step', turn: 1, member: true }),
    seat({ key: 't2', kind: 'tool-call', turn: 1, member: true }),
    seat({ key: 'answer', kind: 'assistant-step', turn: 1 }),
    seat({ key: 'tail', kind: 'turn-tail', turn: 1, member: true }),
  ]
  const nodes = new Map([
    ['user', node({ seq: 100, blocks: prose(6) })],
    ['control', node({ seq: 100.9 })],
    ['a1', node({ seq: 101, step: 1, blocks: withTool() })],
    ['t1', node({ seq: 102, step: 1 })],
    ['a2', node({ seq: 103, step: 2, blocks: withTool() })],
    ['t2', node({ seq: 104, step: 2 })],
    ['answer', node({ seq: 105, step: 3, blocks: prose(240) })],
    ['tail', node({ seq: 106 })],
  ])
  return { seats, nodes }
}

/** Read one turn's rows the way a pass does. */
function rowsOf(seats, nodes) {
  const groups = groupSeats(column(seats))
  const turns = [...groups.keys()]
  return turns.map(turn => attachNodeData(groups.get(turn), key => nodes.get(key)))
}

test('isAnswerRow requires prose and no tool call', () => {
  assert.equal(isAnswerRow({ kind: 'assistant-step', hasToolCall: false, textLen: 10 }), true)
  assert.equal(isAnswerRow({ kind: 'assistant-step', hasToolCall: false, textLen: 0 }), false)
  assert.equal(isAnswerRow({ kind: 'assistant-step', hasToolCall: true, textLen: 10 }), false)
  assert.equal(isAnswerRow({ kind: 'tool-call', hasToolCall: false, textLen: 10 }), false)
})

test('injected context is not an independent kind', () => {
  // Regression: `context` used to be listed here, which is what left every
  // injected-context row on screen while the work beside it folded.
  assert.equal(isIndependentKind('context'), false)
  assert.equal(isIndependentKind('turn-tail'), true)
  assert.equal(isIndependentKind('assistant-step'), false)
})

test('context rows are recognized by kind, with or without a Turn', () => {
  assert.equal(isContextRow({ kind: 'context', turn: Number.NaN }), true)
  assert.equal(isContextRow({ kind: 'context', turn: 3 }), true)
  assert.equal(isContextRow({ kind: 'user', turn: Number.NaN }), false)
  assert.equal(isProcessMember({ kind: 'assistant-step', member: true }), true)
  assert.equal(isProcessMember({ kind: 'assistant-step', member: false }), false)
  // A context row is a member of the Turn it belongs to, without any seat mark.
  assert.equal(isProcessMember({ kind: 'context', turn: Number.NaN, member: false }), true)
  assert.equal(isProcessMember({ kind: 'turn-tail', turn: 4, member: true }), false)
})

test('groupSeats groups by the seat turn, in DOM order', () => {
  const groups = groupSeats(column([
    seat({ key: 'a', kind: 'user', turn: 7 }),
    seat({ key: 'b', kind: 'tool-call', turn: 7, member: true }),
    seat({ key: 'c', kind: 'user', turn: 8 }),
  ]))
  assert.deepEqual([...groups.keys()], [7, 8])
  assert.deepEqual(groups.get(7).map(row => row.key), ['a', 'b'])
  assert.equal(groups.get(7)[1].member, true)
  assert.equal(groups.get(8)[0].member, false)
})

test('groupSeats ignores a seat with no Turn of its own', () => {
  const groups = groupSeats(column([seat({ key: 'a', kind: 'user', turn: Number.NaN })]))
  assert.equal(groups.size, 0)
})

test('groupSeats assigns injected context to the Turn it precedes', () => {
  // Measured live: the context rows rendered ABOVE the turn they were injected
  // for, and the preview window is scrolled so that only the later ones are in
  // the DOM at all. Both survivors must join the Turn below them.
  const groups = groupSeats(column([
    seat({ key: 'ctx-skill', kind: 'context' }),
    seat({ key: 'control', kind: 'turn-process', turn: 3 }),
    seat({ key: 'a1', kind: 'assistant-step', turn: 3, member: true }),
    seat({ key: 'answer', kind: 'assistant-step', turn: 3 }),
  ]))
  assert.deepEqual([...groups.keys()], [3])
  assert.deepEqual(groups.get(3).map(row => row.key), ['ctx-skill', 'control', 'a1', 'answer'])
})

test('groupSeats keeps a trailing context row with the Turn above it', () => {
  const groups = groupSeats(column([
    seat({ key: 'control', kind: 'turn-process', turn: 1 }),
    seat({ key: 'answer', kind: 'assistant-step', turn: 1 }),
    seat({ key: 'ctx-after', kind: 'context' }),
  ]))
  assert.deepEqual(groups.get(1).map(row => row.key), ['control', 'answer', 'ctx-after'])
})

test('groupSeats does not invent a group for rows before the first Turn', () => {
  // An empty `NaN` group is the honest answer: a caller that finds it can leave
  // those rows alone, and `foldColumn` never writes to them.
  const groups = groupSeats(column([
    seat({ key: 'ctx-skill', kind: 'context' }),
    seat({ key: 'a1', kind: 'assistant-step', turn: 1, member: true }),
  ]))
  assert.deepEqual([...groups.keys()], [1])
  assert.deepEqual(groups.get(1).map(row => row.key), ['ctx-skill', 'a1'])
})

test('a context row inside the process range folds with it', () => {
  const seats = [
    seat({ key: 'ctx-a', kind: 'context' }),
    seat({ key: 'ctx-b', kind: 'context' }),
    seat({ key: 'control', kind: 'turn-process', turn: 3 }),
    seat({ key: 'a1', kind: 'assistant-step', turn: 3, member: true }),
    seat({ key: 'answer', kind: 'assistant-step', turn: 3 }),
  ]
  const nodes = new Map([
    ['control', node({ seq: 10, turn: 3 })],
    ['a1', node({ seq: 12, step: 1, blocks: withTool(), turn: 3 })],
    ['answer', node({ seq: 14, step: 2, blocks: prose(40), turn: 3 })],
  ])
  const rows = rowsOf(seats, nodes)[0]
  const { hidden, answer, foldable } = foldTurn(rows, ended({ answerStep: 2, answerAnchorSeq: 14 }))
  assert.equal(foldable, true)
  assert.equal(answer.key, 'answer')
  // The context rows carry no store position at all — the group assignment is
  // the only statement that they belong to this Turn.
  assert.deepEqual(hidden.map(row => row.key), ['ctx-a', 'ctx-b', 'a1'])
})

test('a context row below the answer stays readable', () => {
  const seats = [
    seat({ key: 'control', kind: 'turn-process', turn: 3 }),
    seat({ key: 'a1', kind: 'assistant-step', turn: 3, member: true }),
    seat({ key: 'answer', kind: 'assistant-step', turn: 3 }),
    seat({ key: 'ctx-after', kind: 'context' }),
  ]
  const nodes = new Map([
    ['control', node({ seq: 10, turn: 3 })],
    ['a1', node({ seq: 12, step: 1, blocks: withTool(), turn: 3 })],
    ['answer', node({ seq: 14, step: 2, blocks: prose(40), turn: 3 })],
  ])
  const rows = rowsOf(seats, nodes)[0]
  const { hidden } = foldTurn(rows, ended({ answerStep: 2, answerAnchorSeq: 14 }))
  assert.deepEqual(hidden.map(row => row.key), ['a1'])
})

test('effectiveTurns reports the Turn that governs each seat', () => {
  const ctx = seat({ key: 'ctx', kind: 'context' })
  const control = seat({ key: 'control', kind: 'turn-process', turn: 3 })
  const loose = seat({ key: 'loose', kind: 'user', turn: Number.NaN })
  const owners = effectiveTurns(column([ctx, control, loose]))
  assert.equal(owners.get(ctx), 3)
  assert.equal(owners.get(control), 3)
  // A row no Turn adopts is reported as unattributed rather than silently
  // credited to whichever group happens to be last.
  assert.equal(owners.get(loose), null)
})

test('a whole pass folds injected context without store positions', () => {  // End-to-end shape of the live defect: context rows first (no Turn, no node),
  // then the Turn's control, process and answer.
  const { column: flow, elements } = dom([
    { key: 'ctx-a', kind: 'context', turn: null },
    { key: 'ctx-b', kind: 'context', turn: null },
    { key: 'control', kind: 'turn-process', turn: 3 },
    { key: 'p0', kind: 'tool-call', turn: 3, member: true },
    { key: 'answer', kind: 'assistant-step', turn: 3 },
    { key: 'tail', kind: 'turn-tail', turn: 3, member: true },
  ])
  const nodes = new Map([
    ['control', node({ seq: 10, turn: 3 })],
    ['answer', node({ seq: 20, step: 2, blocks: prose(60), turn: 3 })],
  ])
  const published = foldColumn(flow, key => nodes.get(key), OPS)
  assert.equal(published.turns.get(3).foldable, true)
  assert.deepEqual(
    elements.map(element => element.getAttribute('hidden')),
    ['until-found', 'until-found', null, 'until-found', null, null],
  )
  assert.equal(elements[4].dataset.foldItUpAnswer, '1')
})

test('an expanded turn releases its injected context too', () => {
  const { column: flow, elements } = dom([
    { key: 'ctx-a', kind: 'context', turn: null },
    { key: 'control', kind: 'turn-process', turn: 3, open: true },
    { key: 'p0', kind: 'tool-call', turn: 3, member: true },
    { key: 'answer', kind: 'assistant-step', turn: 3 },
  ])
  const nodes = new Map([
    ['control', node({ seq: 10, turn: 3 })],
    ['answer', node({ seq: 20, step: 2, blocks: prose(60), turn: 3 })],
  ])
  foldColumn(flow, key => nodes.get(key), OPS)
  assert.deepEqual(elements.map(element => element.getAttribute('hidden')), [null, null, null, null])
})

test('attachNodeData reads content but leaves order and ids alone', () => {
  const rows = [
    { key: 'a1', kind: 'assistant-step', seq: null, step: null, turn: 1, member: true, hasToolCall: false, textLen: 0 },
    { key: 'missing', kind: 'tool-call', seq: null, step: null, turn: 1, member: true, hasToolCall: false, textLen: 0 },
  ]
  const nodes = new Map([['a1', node({ seq: 7, step: 4, blocks: [...prose(3), { type: 'tool-call', name: 'x' }] })]])
  attachNodeData(rows, key => nodes.get(key))
  assert.deepEqual(rows.map(row => row.key), ['a1', 'missing'])
  assert.equal(rows[0].seq, 7)
  assert.equal(rows[0].step, 4)
  assert.equal(rows[0].hasToolCall, true)
  assert.equal(rows[0].textLen, 3)
  // An unresolved node must never look like an answer.
  assert.equal(rows[1].textLen, 0)
  assert.equal(rows[1].hasToolCall, false)
})

test('reasoning is process material, never reply content', () => {
  // Regression: reasoning used to be counted into `textLen`, so the step the
  // model was thinking in passed `isAnswerRow` and the whole Turn folded itself
  // around a row that was still being written — the reported defect. The
  // shipped `hasAssistantReplyContent` ignores reasoning for the same reason.
  const rows = [{
    key: 'live', kind: 'assistant-step', seq: null, step: 1, turn: 1, member: false,
    hasToolCall: false, textLen: 0,
  }]
  const nodes = new Map([['live', node({ seq: 4, step: 1, blocks: [{ type: 'reasoning', text: 'x'.repeat(400) }] })]])
  attachNodeData(rows, key => nodes.get(key))
  assert.equal(rows[0].textLen, 0, 'reasoning must not count as reply prose')
  assert.equal(isAnswerRow(rows[0]), false)

  // A step that thinks AND answers inline still answers, by its prose.
  const mixed = [{ ...rows[0], key: 'mixed' }]
  attachNodeData(mixed, () => node({
    seq: 5,
    step: 1,
    blocks: [{ type: 'reasoning', text: 'x'.repeat(400) }, ...prose(12)],
  }))
  assert.equal(mixed[0].textLen, 12)
  assert.equal(isAnswerRow(mixed[0]), true)
})

test('a running turn folds nothing, however finalized its boundary looks', () => {
  // The reported defect, reduced to the store shape that causes it: while step 2
  // streams, the published projection still names step 1's finalized answer, so
  // `marked` is non-empty, `answerFor` resolves, and every range comparison
  // succeeds — against a boundary the live step is already below.
  const seats = [
    seat({ key: 'user', kind: 'user', turn: 1 }),
    seat({ key: 'control', kind: 'turn-process', turn: 1 }),
    seat({ key: 'p1', kind: 'tool-call', turn: 1, member: true }),
    seat({ key: 'a1', kind: 'assistant-step', turn: 1, member: true }),
    seat({ key: 'live', kind: 'assistant-step', turn: 1, member: true }),
  ]
  const nodes = new Map([
    ['user', node({ seq: 1, blocks: prose(3) })],
    ['control', node({ seq: 1.9, turn: 1 })],
    ['p1', node({ seq: 2, turn: 1 })],
    ['a1', node({ seq: 3, step: 1, blocks: prose(20), turn: 1 })],
    // Step 2 has published nothing yet: it is thinking.
    ['live', node({ seq: 4, step: 2, blocks: [{ type: 'reasoning', text: 'x'.repeat(300) }], turn: 1 })],
  ])
  const rows = rowsOf(seats, nodes)[0]
  const live = foldTurn(rows, running({ answerStep: 1, answerAnchorSeq: 3 }))
  assert.equal(live.foldable, false)
  assert.deepEqual(live.hidden, [])
  assert.equal(live.answer, null)

  // The very same transcript, once the Turn has closed: now it folds, and the
  // answer is the finalized step rather than the reasoning above it.
  const settled = foldTurn(rows, ended({ answerStep: 1, answerAnchorSeq: 3 }))
  assert.equal(settled.foldable, true)
  assert.equal(settled.answer.key, 'a1')
  assert.deepEqual(settled.hidden.map(row => row.key), ['p1'])
})

test('a pass reads closure from the rows, not from the store', () => {
  // `turn-tail` is published on `turn/end` whatever the reason, so its presence
  // in a rendered group IS the shipped `turnClosed` — the gate that keeps a
  // running Turn unfolded. The same transcript without it must not fold.
  const description = [
    { key: 'user', kind: 'user', turn: 2 },
    { key: 'control', kind: 'turn-process', turn: 2 },
    { key: 'p0', kind: 'tool-call', turn: 2, member: true },
    { key: 'answer', kind: 'assistant-step', turn: 2 },
  ]
  const nodes = new Map([
    ['control', node({ seq: 1, turn: 2 })],
    ['p0', node({ seq: 2, turn: 2 })],
    ['answer', node({ seq: 3, step: 1, blocks: prose(40), turn: 2 })],
  ])
  // A finalized answer boundary is published in BOTH cases — the store node
  // carries `answerStep`/`answerAnchorSeq` either way — so only the rows can
  // tell a running Turn from a finished one.

  const live = dom(description)
  const livePublication = foldColumn(live.column, key => nodes.get(key), OPS)
  assert.equal(livePublication.turns.get(2).closed, false)
  assert.equal(livePublication.turns.get(2).foldable, false)
  assert.deepEqual(live.elements.map(element => element.getAttribute('hidden')), [null, null, null, null])
  assert.equal(live.elements[3].dataset.foldItUpAnswer, undefined)

  const closed = dom([...description, { key: 'tail', kind: 'turn-tail', turn: 2, member: true }])
  const closedPublication = foldColumn(closed.column, key => nodes.get(key), OPS)
  assert.equal(closedPublication.turns.get(2).closed, true)
  assert.equal(closedPublication.turns.get(2).foldable, true)
  assert.deepEqual(
    closed.elements.map(element => element.getAttribute('hidden')),
    [null, null, 'until-found', null, null],
  )
  assert.equal(closed.elements[3].dataset.foldItUpAnswer, '1')
})

test('either closing notice ends the Turn as surely as the footer does', () => {
  for (const kind of ['turn-tail', 'turn-error', 'turn-max-tokens']) {
    const { column: flow, elements } = dom([
      { key: 'control', kind: 'turn-process', turn: 3 },
      { key: 'p0', kind: 'tool-call', turn: 3, member: true },
      { key: 'note', kind, turn: 3, member: true },
      { key: 'answer', kind: 'assistant-step', turn: 3 },
    ])
    const nodes = new Map([
      ['control', node({ seq: 1, turn: 3 })],
      ['p0', node({ seq: 2, turn: 3 })],
      ['answer', node({ seq: 3, step: 1, blocks: prose(30), turn: 3 })],
    ])
    const published = foldColumn(flow, key => nodes.get(key), OPS)
    assert.equal(published.turns.get(3).closed, true, `${kind} must close the Turn`)
    assert.equal(published.turns.get(3).foldable, true, `${kind} must allow the fold`)
    assert.equal(elements[1].getAttribute('hidden'), 'until-found')
    // The notice itself is an independent kind: it stays readable.
    assert.equal(elements[2].getAttribute('hidden'), null)
  }
})

test('a finished turn hides its process and keeps the answer readable', () => {
  const { seats, nodes } = finishedTurn()
  const rows = rowsOf(seats, nodes)[0]
  const { hidden, answer, foldable } = foldTurn(rows, ended({ answerStep: 3, answerAnchorSeq: 105 }))
  assert.equal(foldable, true)
  assert.equal(answer.key, 'answer')
  assert.deepEqual(hidden.map(row => row.key), ['a1', 't1', 'a2', 't2'])
  const kept = rows.filter(row => !hidden.includes(row)).map(row => row.kind)
  assert.deepEqual(kept, ['user', 'turn-process', 'assistant-step', 'turn-tail'])
})

test('an expanded turn hides nothing', () => {
  const { seats, nodes } = finishedTurn()
  const rows = rowsOf(seats, nodes)[0]
  const { hidden } = foldTurn(rows, ended({ answerStep: 3, answerAnchorSeq: 105, open: true }))
  assert.deepEqual(hidden, [])
})

test('the answer is found without the shipped projection', () => {
  const { seats, nodes } = finishedTurn()
  const rows = rowsOf(seats, nodes)[0]
  // Both projection fields absent: the last prose reply below the process wins.
  const { hidden, answer } = foldTurn(rows, ended())
  assert.equal(answer.key, 'answer')
  assert.deepEqual(hidden.map(row => row.key), ['a1', 't1', 'a2', 't2'])
})

test('a turn the seat has not marked folds nothing', () => {
  // This is the running-turn shape: no membership marks yet, so the growing
  // edge of a live turn is never touched.
  const seats = [
    seat({ key: 'user', kind: 'user', turn: 1 }),
    seat({ key: 'control', kind: 'turn-process', turn: 1 }),
    seat({ key: 'a1', kind: 'assistant-step', turn: 1 }),
  ]
  const nodes = new Map([
    ['user', node({ seq: 1, blocks: prose(3) })],
    ['control', node({ seq: 1.9 })],
    ['a1', node({ seq: 2, step: 1, blocks: withTool() })],
  ])
  const rows = rowsOf(seats, nodes)[0]
  const { hidden, foldable } = foldTurn(rows, ended())
  assert.deepEqual(hidden, [])
  assert.equal(foldable, false)
})

test('an interrupted turn folds its process even though no row answers it', () => {
  // An interrupted turn: process marks exist, and nothing summarizes them —
  // the provider failed, or the stop landed on a tool call, so the projection
  // names no answer at all. New semantics: the Turn is still OVER, so its work
  // belongs behind the disclosure instead of staying on screen. The marks name
  // the range to hide, and with no answer to keep readable the whole marked
  // range folds — no row is stamped as the answer.
  const seats = [
    seat({ key: 'user', kind: 'user', turn: 1 }),
    seat({ key: 'control', kind: 'turn-process', turn: 1 }),
    seat({ key: 'a1', kind: 'assistant-step', turn: 1, member: true }),
    seat({ key: 't1', kind: 'tool-call', turn: 1, member: true }),
  ]
  const nodes = new Map([
    ['user', node({ seq: 1, blocks: prose(3) })],
    ['control', node({ seq: 1.9 })],
    ['a1', node({ seq: 2, step: 1, blocks: withTool() })],
    ['t1', node({ seq: 3, step: 1 })],
  ])
  const rows = rowsOf(seats, nodes)[0]
  const { hidden, answer, foldable } = foldTurn(rows, ended())
  assert.equal(foldable, true)
  assert.equal(answer, null)
  assert.deepEqual(hidden.map(row => row.key), ['a1', 't1'])
})

test('independent kinds inside the range are never hidden', () => {
  // `context` is deliberately NOT in this list any more: it folds with the Turn
  // it precedes, which is the whole point of the re-parenting above.
  const seats = [
    seat({ key: 'control', kind: 'turn-process', turn: 1 }),
    seat({ key: 'a1', kind: 'assistant-step', turn: 1, member: true }),
    seat({ key: 'err', kind: 'turn-error', turn: 1, member: true }),
    seat({ key: 'answer', kind: 'assistant-step', turn: 1 }),
  ]
  const nodes = new Map([
    ['control', node({ seq: 1 })],
    ['a1', node({ seq: 3, step: 1, blocks: withTool() })],
    ['err', node({ seq: 4 })],
    ['answer', node({ seq: 5, step: 2, blocks: prose(20) })],
  ])
  const rows = rowsOf(seats, nodes)[0]
  const { hidden } = foldTurn(rows, ended({ answerStep: 2, answerAnchorSeq: 5 }))
  assert.deepEqual(hidden.map(row => row.key), ['a1'])
})

test('the disclosure control never hides itself', () => {
  const seats = [
    seat({ key: 'control', kind: 'turn-process', turn: 1, member: true }),
    seat({ key: 'a1', kind: 'assistant-step', turn: 1, member: true }),
    seat({ key: 'answer', kind: 'assistant-step', turn: 1 }),
  ]
  const nodes = new Map([
    ['control', node({ seq: 1 })],
    ['a1', node({ seq: 2, step: 1, blocks: withTool() })],
    ['answer', node({ seq: 3, step: 2, blocks: prose(20) })],
  ])
  const rows = rowsOf(seats, nodes)[0]
  const { hidden } = foldTurn(rows, ended({ answerStep: 2, answerAnchorSeq: 3 }))
  assert.equal(hidden.some(row => row.kind === 'turn-process'), false)
})

test('rows of two turns fold independently', () => {
  const seats = [
    seat({ key: 'c1', kind: 'turn-process', turn: 1 }),
    seat({ key: 'p1', kind: 'tool-call', turn: 1, member: true }),
    seat({ key: 'ans1', kind: 'assistant-step', turn: 1 }),
    seat({ key: 'u2', kind: 'user', turn: 2 }),
    seat({ key: 'c2', kind: 'turn-process', turn: 2 }),
    seat({ key: 'p2', kind: 'tool-call', turn: 2, member: true }),
    seat({ key: 'ans2', kind: 'assistant-step', turn: 2 }),
  ]
  const nodes = new Map([
    ['c1', node({ seq: 1, turn: 1 })],
    ['p1', node({ seq: 2, turn: 1 })],
    ['ans1', node({ seq: 3, step: 1, blocks: prose(30), turn: 1 })],
    ['u2', node({ seq: 4, turn: 2 })],
    ['c2', node({ seq: 4.9, turn: 2 })],
    ['p2', node({ seq: 5, turn: 2, blocks: withTool() })],
    ['ans2', node({ seq: 6, step: 1, blocks: prose(30), turn: 2 })],
  ])
  const groups = rowsOf(seats, nodes)
  assert.equal(groups.length, 2)
  const first = foldTurn(groups[0], ended({ answerStep: 1, answerAnchorSeq: 3 }))
  const second = foldTurn(groups[1], ended({ answerStep: 1, answerAnchorSeq: 6 }))
  assert.deepEqual(first.hidden.map(row => row.key), ['p1'])
  assert.deepEqual(second.hidden.map(row => row.key), ['p2'])
})

test('a turn whose process arrives after the store snapshot still folds', () => {
  // The exact shape measured live: the DOM holds 116 rendered rows while the
  // store snapshot still describes 94. Content resolution is per key, so the
  // rows the store does not know keep neutral content and the range still folds.
  const seats = [
    seat({ key: 'control', kind: 'turn-process', turn: 9 }),
    ...Array.from({ length: 6 }, (_unused, index) => seat({
      key: `p${String(index)}`,
      kind: index % 2 === 0 ? 'tool-call' : 'assistant-step',
      turn: 9,
      member: true,
    })),
    seat({ key: 'answer', kind: 'assistant-step', turn: 9 }),
  ]
  const nodes = new Map([
    ['control', node({ seq: 1, turn: 9 })],
    // Only the first two process rows are described by this snapshot.
    ['p0', node({ seq: 2, turn: 9 })],
    ['p1', node({ seq: 3, step: 1, blocks: withTool(), turn: 9 })],
    ['answer', node({ seq: 9, step: 4, blocks: prose(120), turn: 9 })],
  ])
  const rows = rowsOf(seats, nodes)[0]
  assert.equal(rows.length, 8)
  const { hidden, answer, foldable } = foldTurn(rows, ended({ answerStep: 4, answerAnchorSeq: 9 }))
  assert.equal(foldable, true)
  assert.equal(answer.key, 'answer')
  assert.equal(hidden.length, 6)
})

test('a whole pass folds rows the store snapshot does not describe', () => {
  // The live failure, reduced: the column renders process rows the snapshot has
  // no node for. The pass must decide from the column, so those rows fold too —
  // deciding from the snapshot is what left 102 rows visible after a prepend.
  const { column: flow, elements } = dom([
    { key: 'user', kind: 'user', turn: 4 },
    { key: 'control', kind: 'turn-process', turn: 4 },
    { key: 'p0', kind: 'tool-call', turn: 4, member: true },
    { key: 'p1', kind: 'assistant-step', turn: 4, member: true },
    { key: 'p2', kind: 'tool-call', turn: 4, member: true },
    { key: 'answer', kind: 'assistant-step', turn: 4 },
    { key: 'tail', kind: 'turn-tail', turn: 4, member: true },
  ])
  // The snapshot knows the control and the answer only.
  const nodes = new Map([
    ['control', node({ seq: 1, turn: 4 })],
    ['answer', node({ seq: 9, step: 4, blocks: prose(90), turn: 4 })],
  ])
  const published = foldColumn(flow, key => nodes.get(key), OPS)
  assert.deepEqual([...published.turns.keys()], [4])
  assert.equal(published.turns.get(4).foldable, true)
  assert.deepEqual(
    elements.map(element => element.getAttribute('hidden')),
    [null, null, 'until-found', 'until-found', 'until-found', null, null],
  )
  assert.equal(elements[5].dataset.foldItUpAnswer, '1')
  assert.equal(elements[2].dataset.folditupSeq, undefined, 'an unresolved row is stamped with nothing')
})

test('a pass leaves an unmarked running turn alone', () => {
  const { column: flow, elements } = dom([
    { key: 'user', kind: 'user', turn: 5 },
    { key: 'control', kind: 'turn-process', turn: 5 },
    { key: 'p0', kind: 'tool-call', turn: 5 },
  ])
  const nodes = new Map([
    ['control', node({ seq: 1, turn: 5 })],
    ['p0', node({ seq: 2, turn: 5 })],
  ])
  const published = foldColumn(flow, key => nodes.get(key), OPS)
  assert.equal(published.turns.get(5).foldable, false)
  assert.deepEqual(elements.map(element => element.getAttribute('hidden')), [null, null, null])
})

test('a pass releases the fold when the control reports itself open', () => {
  const description = [
    { key: 'control', kind: 'turn-process', turn: 6 },
    { key: 'p0', kind: 'tool-call', turn: 6, member: true },
    { key: 'a0', kind: 'assistant-step', turn: 6, member: true },
    { key: 'answer', kind: 'assistant-step', turn: 6 },
    { key: 'tail', kind: 'turn-tail', turn: 6, member: true },
  ]
  const nodes = new Map([
    ['control', node({ seq: 1, turn: 6 })],
    ['p0', node({ seq: 2, turn: 6 })],
    ['a0', node({ seq: 3, step: 1, blocks: withTool(), turn: 6 })],
    ['answer', node({ seq: 4, step: 2, blocks: prose(40), turn: 6 })],
  ])
  const closed = dom(description)
  foldColumn(closed.column, key => nodes.get(key), OPS)
  assert.deepEqual(
    closed.elements.map(element => element.getAttribute('hidden')),
    [null, 'until-found', 'until-found', null, null],
  )

  // The same transcript, with the row reporting itself expanded.
  const opened = dom(description.map(entry => (entry.kind === 'turn-process' ? { ...entry, open: true } : entry)))
  const published = foldColumn(opened.column, key => nodes.get(key), OPS)
  assert.equal(published.turns.get(6).open, true)
  assert.deepEqual(
    opened.elements.map(element => element.getAttribute('hidden')),
    [null, null, null, null, null],
  )
})

test('expansion is read from the row inside the seat, not the seat itself', () => {
  // Regression: the seat wrapper never carries `data-open`; the shipped row and
  // the fallback both write it on the element they render inside the seat.
  // Reading the seat made every toggle a no-op and pinned the fold shut.
  const { column: flow, rows } = dom([
    { key: 'control', kind: 'turn-process', turn: 8, open: true },
    { key: 'p0', kind: 'tool-call', turn: 8, member: true },
    { key: 'answer', kind: 'assistant-step', turn: 8 },
  ])
  assert.equal(rows[0].hasAttribute('data-open'), true)
  const nodes = new Map([
    ['control', node({ seq: 1, turn: 8 })],
    ['p0', node({ seq: 2, turn: 8 })],
    ['answer', node({ seq: 3, step: 1, blocks: prose(20), turn: 8 })],
  ])
  const published = foldColumn(flow, key => nodes.get(key), OPS)
  assert.equal(published.turns.get(8).open, true)
  assert.equal(published.turns.get(8).hidden, 0)
})

// --- auto-scroll: where a just-closed Turn's question belongs ---------------

/** A scrollport whose question sits `questionTop` px below its own top edge. */
function geometry({ scrollTop = 1200, floor = 2000, questionTop = -900 } = {}) {
  return { scrollTop, floor, questionTop }
}

test('a closing turn scrolls its question back to the scrollport top', () => {
  // The measured live case: pinned to the floor, question 1937px above it.
  const target = autoScrollTarget({ closed: true }, geometry({ scrollTop: 1993, floor: 1993, questionTop: -1937 }))
  assert.deepEqual(target, { top: 56 })
})

test('a question already on the top edge is left alone', () => {
  // Idempotence: this is why a second pass cannot twitch the view.
  assert.equal(autoScrollTarget({ closed: true }, geometry({ questionTop: 0 })), null)
  assert.equal(autoScrollTarget({ closed: true }, geometry({ questionTop: 0.4 })), null)
})

test('a transcript with nothing to scroll is left alone', () => {
  // The short-answer case: the write would be a no-op, so it is never made.
  assert.equal(autoScrollTarget({ closed: true }, geometry({ floor: 0, scrollTop: 0, questionTop: 56 })), null)
})

test('only a turn that just closed scrolls', () => {
  // A running turn, and a turn already closed in the previous pass (history,
  // session switch, or simply a later pass over the same closed turn).
  assert.equal(autoScrollTarget({ closed: false }, geometry()), null)
  assert.equal(autoScrollTarget({ closed: undefined }, geometry()), null)
})

test('expanding a turn never moves the reader', () => {
  // The disclosure was open in the previous pass: the reader is looking at the
  // work on purpose.
  assert.equal(autoScrollTarget({ closed: true, wasOpen: true }, geometry()), null)
})

test('a scroll target is never negative and never survives broken geometry', () => {
  assert.deepEqual(autoScrollTarget({ closed: true }, geometry({ scrollTop: 0, questionTop: -900 })), { top: 0 })
  assert.equal(autoScrollTarget({ closed: true }, geometry({ scrollTop: Number.NaN })), null)
  assert.equal(autoScrollTarget({ closed: true }, null), null)
})

// --- an error-ended Turn folds with the notice as its boundary ---------------
//
// A Turn that ends because the provider failed (or because max tokens were hit)
// publishes no answer: the official projection leaves `answerStep` and
// `answerAnchorSeq` null, and the seat marks no `data-turn-process-member`
// either. The old decision therefore had nothing to resolve — `lastProse` only
// looks downward from the last in-range row and an error Turn's last row is a
// tool call or a pure-reasoning step — so the Turn stayed wide open and its
// whole process was dumped on the reader.
//
// The notice row IS the boundary: `turn-error` / `turn-max-tokens` / `turn-tail`
// exist only after the Turn has ended, and everything they announce must stay
// readable. So when no answer row exists, a closing row in the group is the
// boundary, whether the rows carry member marks or only the published sequence
// range, and no row is stamped as the answer. Which one is the LAST one — see
// the mid-turn footer section below for why the first is not enough.

/**
 * The control row's store node for these shapes: a real Turn publishes
 * `processStartSeq` on it and leaves both answer fields null.
 * @param seq - the control's anchor sequence.
 * @param turn - the Turn number.
 * @param processStartSeq - the published start of the process range.
 * @returns the node shape `attachNodeData` reads.
 */
function controlNode(seq, turn, processStartSeq) {
  return {
    anchorSeq: seq,
    location: { kind: 'turn', turn: { turn } },
    data: { processStartSeq, answerStep: null, answerAnchorSeq: null },
  }
}

test('an error-ended turn folds its process and keeps the notice readable', () => {
  // Z1: prose+tool call work, then a step that only reasoned, then the error.
  const seats = [
    seat({ key: 'user', kind: 'user', turn: 7 }),
    seat({ key: 'control', kind: 'turn-process', turn: 7 }),
    seat({ key: 's1', kind: 'assistant-step', turn: 7, member: true }),
    seat({ key: 't1', kind: 'tool-call', turn: 7, member: true }),
    seat({ key: 's2', kind: 'assistant-step', turn: 7, member: true }),
    seat({ key: 'err', kind: 'turn-error', turn: 7 }),
    seat({ key: 'tail', kind: 'turn-tail', turn: 7 }),
  ]
  const nodes = new Map([
    ['user', node({ seq: 4, blocks: prose(3), turn: 7 })],
    ['control', controlNode(4.9, 7, 4.9)],
    ['s1', node({ seq: 5, step: 1, blocks: withTool(), turn: 7 })],
    ['t1', node({ seq: 6, step: 1, turn: 7 })],
    ['s2', node({ seq: 7, step: 2, blocks: [{ type: 'reasoning', text: 'x'.repeat(300) }], turn: 7 })],
  ])
  const rows = rowsOf(seats, nodes)[0]
  const { answer, hidden, foldable } = foldTurn(rows, ended({ processStartSeq: 4.9 }))
  assert.equal(foldable, true)
  assert.equal(answer, null)
  assert.deepEqual(hidden.map(row => row.key), ['s1', 't1', 's2'])

  // The same group through a whole pass: no row is stamped as the answer, and
  // the notice rows below the boundary stay visible.
  const view = dom(seats.map(entry => ({
    key: entry.getAttribute('data-chat-anchor-key'),
    kind: entry.getAttribute(KIND_ATTRIBUTE),
    turn: Number(entry.getAttribute('data-chat-turn')),
    member: entry.hasAttribute(MEMBER_ATTRIBUTE),
  })))
  const published = foldColumn(view.column, key => nodes.get(key), OPS)
  assert.equal(published.turns.get(7).foldable, true)
  assert.equal(published.turns.get(7).answerKey, null)
  assert.deepEqual(
    view.elements.map(element => element.getAttribute('hidden')),
    [null, null, 'until-found', 'until-found', 'until-found', null, null],
  )
})

test('a trailing context row does not hijack an error-ended turn', () => {
  // Z5: the same group with a turn-less context row appended. `groupSeats` adopts
  // it into this Turn, so it is a process member — but a mark anywhere in the
  // group must not divert the decision away from the notice boundary.
  const seats = [
    seat({ key: 'user', kind: 'user', turn: 7 }),
    seat({ key: 'control', kind: 'turn-process', turn: 7 }),
    seat({ key: 's1', kind: 'assistant-step', turn: 7, member: true }),
    seat({ key: 't1', kind: 'tool-call', turn: 7, member: true }),
    seat({ key: 's2', kind: 'assistant-step', turn: 7, member: true }),
    seat({ key: 'err', kind: 'turn-error', turn: 7 }),
    seat({ key: 'tail', kind: 'turn-tail', turn: 7 }),
    seat({ key: 'ctx', kind: 'context' }),
  ]
  const nodes = new Map([
    ['control', controlNode(4.9, 7, 4.9)],
    ['s1', node({ seq: 5, step: 1, blocks: withTool(), turn: 7 })],
    ['t1', node({ seq: 6, step: 1, turn: 7 })],
    ['s2', node({ seq: 7, step: 2, blocks: [{ type: 'reasoning', text: 'x'.repeat(300) }], turn: 7 })],
  ])
  const rows = rowsOf(seats, nodes)[0]
  const { answer, hidden, foldable } = foldTurn(rows, ended({ processStartSeq: 4.9 }))
  assert.equal(foldable, true)
  assert.equal(answer, null)
  // The context row is below the notice: it stays readable.
  assert.deepEqual(hidden.map(row => row.key), ['s1', 't1', 's2'])
})

test('leading injected context folds with the error-ended turn it precedes', () => {
  // Q2: two context rows injected for this Turn, then the Turn itself. They are
  // above the notice, so they are part of the process that folds.
  const seats = [
    seat({ key: 'ctx-a', kind: 'context' }),
    seat({ key: 'ctx-b', kind: 'context' }),
    seat({ key: 'user', kind: 'user', turn: 7 }),
    seat({ key: 'control', kind: 'turn-process', turn: 7 }),
    seat({ key: 's1', kind: 'assistant-step', turn: 7, member: true }),
    seat({ key: 'err', kind: 'turn-error', turn: 7 }),
    seat({ key: 'tail', kind: 'turn-tail', turn: 7 }),
  ]
  const nodes = new Map([
    ['user', node({ seq: 4, blocks: prose(3), turn: 7 })],
    ['control', controlNode(4.9, 7, 4.9)],
    ['s1', node({ seq: 5, step: 1, blocks: withTool(), turn: 7 })],
  ])
  const rows = rowsOf(seats, nodes)[0]
  const { answer, hidden, foldable } = foldTurn(rows, ended({ processStartSeq: 4.9 }))
  assert.equal(foldable, true)
  assert.equal(answer, null)
  assert.deepEqual(hidden.map(row => row.key), ['ctx-a', 'ctx-b', 's1'])
  const kept = rows.filter(row => !hidden.includes(row)).map(row => row.key)
  assert.deepEqual(kept, ['user', 'control', 'err', 'tail'])
})

test('an unmarked error turn with injected context folds its work too', () => {
  // The live shape of the defect: the shipped window gate never opens without
  // a published answer, so a real error Turn carries NO seat marks at all — and
  // the session has context injected above it. A context row must not become
  // the whole marked range: the range still comes from the published sequence,
  // the context rows join it, and the notice bounds everything.
  const seats = [
    seat({ key: 'ctx-a', kind: 'context' }),
    seat({ key: 'ctx-b', kind: 'context' }),
    seat({ key: 'user', kind: 'user', turn: 7 }),
    seat({ key: 'control', kind: 'turn-process', turn: 7 }),
    seat({ key: 's1', kind: 'assistant-step', turn: 7 }),
    seat({ key: 't1', kind: 'tool-call', turn: 7 }),
    seat({ key: 's2', kind: 'assistant-step', turn: 7 }),
    seat({ key: 'err', kind: 'turn-error', turn: 7 }),
    seat({ key: 'tail', kind: 'turn-tail', turn: 7 }),
  ]
  const nodes = new Map([
    ['user', node({ seq: 4, blocks: prose(3), turn: 7 })],
    ['control', controlNode(4.9, 7, 4.9)],
    ['s1', node({ seq: 5, step: 1, blocks: withTool(), turn: 7 })],
    ['t1', node({ seq: 6, step: 1, turn: 7 })],
    ['s2', node({ seq: 7, step: 2, blocks: [{ type: 'reasoning', text: 'x'.repeat(300) }], turn: 7 })],
  ])
  const rows = rowsOf(seats, nodes)[0]
  const { answer, hidden, foldable } = foldTurn(rows, ended({ processStartSeq: 4.9 }))
  assert.equal(foldable, true)
  assert.equal(answer, null)
  assert.deepEqual(hidden.map(row => row.key), ['ctx-a', 'ctx-b', 's1', 't1', 's2'])
})

test('a max-tokens notice is as good a boundary as an error notice', () => {
  const seats = [
    seat({ key: 'user', kind: 'user', turn: 7 }),
    seat({ key: 'control', kind: 'turn-process', turn: 7 }),
    seat({ key: 's1', kind: 'assistant-step', turn: 7, member: true }),
    seat({ key: 't1', kind: 'tool-call', turn: 7, member: true }),
    seat({ key: 's2', kind: 'assistant-step', turn: 7, member: true }),
    seat({ key: 'note', kind: 'turn-max-tokens', turn: 7 }),
    seat({ key: 'tail', kind: 'turn-tail', turn: 7 }),
  ]
  const nodes = new Map([
    ['control', controlNode(4.9, 7, 4.9)],
    ['s1', node({ seq: 5, step: 1, blocks: withTool(), turn: 7 })],
    ['t1', node({ seq: 6, step: 1, turn: 7 })],
    ['s2', node({ seq: 7, step: 2, blocks: [{ type: 'reasoning', text: 'x'.repeat(300) }], turn: 7 })],
  ])
  const rows = rowsOf(seats, nodes)[0]
  const { answer, hidden, foldable } = foldTurn(rows, ended({ processStartSeq: 4.9 }))
  assert.equal(foldable, true)
  assert.equal(answer, null)
  assert.deepEqual(hidden.map(row => row.key), ['s1', 't1', 's2'])
})

test('the closing gate is not relaxed when the turn has no notice yet', () => {
  // The same Z1 shape WITHOUT a closing row: the group is still running, so the
  // absence of an answer must not become a reason to fold anything.
  const { column: flow, elements } = dom([
    { key: 'user', kind: 'user', turn: 7 },
    { key: 'control', kind: 'turn-process', turn: 7 },
    { key: 's1', kind: 'assistant-step', turn: 7, member: true },
    { key: 't1', kind: 'tool-call', turn: 7, member: true },
    { key: 's2', kind: 'assistant-step', turn: 7, member: true },
  ])
  const nodes = new Map([
    ['control', controlNode(4.9, 7, 4.9)],
    ['s1', node({ seq: 5, step: 1, blocks: withTool(), turn: 7 })],
    ['t1', node({ seq: 6, step: 1, turn: 7 })],
    ['s2', node({ seq: 7, step: 2, blocks: [{ type: 'reasoning', text: 'x'.repeat(300) }], turn: 7 })],
  ])
  const published = foldColumn(flow, key => nodes.get(key), OPS)
  assert.equal(published.turns.get(7).closed, false)
  assert.equal(published.turns.get(7).foldable, false)
  assert.deepEqual(elements.map(element => element.getAttribute('hidden')), [null, null, null, null, null])
})

test('a real answer still wins over the closing boundary', () => {
  // The notice boundary is a fallback, not a new default: when a step really
  // answered, that row is the answer and the process above it is what folds.
  const seats = [
    seat({ key: 'user', kind: 'user', turn: 7 }),
    seat({ key: 'control', kind: 'turn-process', turn: 7 }),
    seat({ key: 's1', kind: 'assistant-step', turn: 7, member: true }),
    seat({ key: 't1', kind: 'tool-call', turn: 7, member: true }),
    seat({ key: 's2', kind: 'assistant-step', turn: 7, member: true }),
    seat({ key: 'err', kind: 'turn-error', turn: 7 }),
    seat({ key: 'tail', kind: 'turn-tail', turn: 7 }),
  ]
  const nodes = new Map([
    ['control', controlNode(4.9, 7, 4.9)],
    ['s1', node({ seq: 5, step: 1, blocks: withTool(), turn: 7 })],
    ['t1', node({ seq: 6, step: 1, turn: 7 })],
    ['s2', node({ seq: 7, step: 2, blocks: prose(40), turn: 7 })],
  ])
  const rows = rowsOf(seats, nodes)[0]
  const { answer, hidden, foldable } = foldTurn(rows, ended({ answerStep: 2, answerAnchorSeq: 7, processStartSeq: 4.9 }))
  assert.equal(foldable, true)
  assert.equal(answer.key, 's2')
  assert.deepEqual(hidden.map(row => row.key), ['s1', 't1'])
})

test('a whole pass hides only the process above an error notice', () => {
  // The end-to-end shape a reader sees: the notice arrives, the answer row under
  // it (if any) is NOT the Turn's answer, and only the work above the notice is
  // behind the disclosure.
  const { column: flow, elements } = dom([
    { key: 'user', kind: 'user', turn: 3 },
    { key: 'control', kind: 'turn-process', turn: 3 },
    { key: 'p0', kind: 'assistant-step', turn: 3 },
    { key: 'note', kind: 'turn-error', turn: 3 },
    { key: 'answer', kind: 'assistant-step', turn: 3 },
  ])
  const nodes = new Map([
    ['control', controlNode(1, 3, 1)],
    ['p0', node({ seq: 2, step: 1, blocks: withTool(), turn: 3 })],
    ['answer', node({ seq: 3, step: 2, blocks: prose(30), turn: 3 })],
  ])
  const published = foldColumn(flow, key => nodes.get(key), OPS)
  assert.equal(published.turns.get(3).foldable, true)
  assert.deepEqual(
    elements.map(element => element.getAttribute('hidden')),
    [null, null, 'until-found', null, null],
  )
  assert.equal(elements[3].getAttribute('hidden'), null, 'the notice stays readable')
  assert.equal(elements[4].dataset.foldItUpAnswer, undefined, 'below the notice is not the answer')
})

test('context injected with its own Turn seat folds with the process too', () => {
  // Measured live (turn 8 of the fold-it-up session): graph-memory's injection
  // lands a context seat that NAMES the Turn it was injected for
  // (data-chat-turn="8"), and its store seq (593) sits BELOW the published
  // processStartSeq (595.9) because the injection event precedes the control
  // anchor. Neither of the fold's two channels would hide it: the turn-less
  // re-parenting rule needs no Turn, and the sequence range needs seq >= start.
  // A context row that carries the group's own Turn is part of that Turn's
  // process exactly like a turn-less one, and must fold with it.
  const seats = [
    seat({ key: 'user', kind: 'user', turn: 8 }),
    seat({ key: 'control', kind: 'turn-process', turn: 8 }),
    seat({ key: 'ctx-owned', kind: 'context', turn: 8 }),
    seat({ key: 's1', kind: 'assistant-step', turn: 8 }),
    seat({ key: 'err', kind: 'turn-error', turn: 8 }),
    seat({ key: 'tail', kind: 'turn-tail', turn: 8 }),
  ]
  const nodes = new Map([
    ['user', node({ seq: 590, blocks: prose(3), turn: 8 })],
    ['control', controlNode(595.9, 8, 595.9)],
    // The injection's own seq sits below processStartSeq, as measured.
    ['ctx-owned', node({ seq: 593, turn: 8 })],
    ['s1', node({ seq: 596, step: 1, blocks: withTool(), turn: 8 })],
  ])
  const rows = rowsOf(seats, nodes)[0]
  const { answer, hidden, foldable } = foldTurn(rows, ended({ processStartSeq: 595.9 }))
  assert.equal(foldable, true)
  assert.equal(answer, null)
  assert.deepEqual(hidden.map(row => row.key), ['ctx-owned', 's1'])

  // The answer-bearing variant through a whole pass: the context row still
  // folds, and the answer below it stays readable.
  const { column: flow, elements } = dom([
    { key: 'user', kind: 'user', turn: 8 },
    { key: 'control', kind: 'turn-process', turn: 8 },
    { key: 'ctx-owned', kind: 'context', turn: 8 },
    { key: 'answer', kind: 'assistant-step', turn: 8 },
    { key: 'tail', kind: 'turn-tail', turn: 8 },
  ])
  const answerNodes = new Map([
    ['control', controlNode(595.9, 8, 595.9)],
    ['ctx-owned', node({ seq: 593, turn: 8 })],
    ['answer', node({ seq: 596, step: 1, blocks: prose(40), turn: 8 })],
  ])
  const published = foldColumn(flow, key => answerNodes.get(key), OPS)
  assert.equal(published.turns.get(8).foldable, true)
  assert.deepEqual(
    elements.map(element => element.getAttribute('hidden')),
    [null, null, 'until-found', null, null],
  )
})

test('a member-marked turn still folds its injected context above it', () => {
  // The marks channel has the same hole, measured on the same session: a turn
  // whose rows are member-marked folds ONLY the marked rows, so a context seat
  // graph-memory injected with that very Turn — a row the shipped seat never
  // marks, because it is not part of the window it marked — stays on screen
  // while the work around it folds. The injection precedes the control anchor,
  // so the seq check would not save the fallback either; the row must join the
  // hidden set on BOTH channels.
  const seats = [
    seat({ key: 'user', kind: 'user', turn: 9 }),
    seat({ key: 'control', kind: 'turn-process', turn: 9 }),
    seat({ key: 'ctx-owned', kind: 'context', turn: 9 }),
    seat({ key: 's1', kind: 'assistant-step', turn: 9, member: true }),
    seat({ key: 't1', kind: 'tool-call', turn: 9, member: true }),
    seat({ key: 'answer', kind: 'assistant-step', turn: 9 }),
    seat({ key: 'tail', kind: 'turn-tail', turn: 9, member: true }),
  ]
  const nodes = new Map([
    ['user', node({ seq: 590, blocks: prose(3) })],
    ['control', node({ seq: 595.9 })],
    // Below the published processStartSeq, as measured live.
    ['ctx-owned', node({ seq: 593, turn: 9 })],
    ['s1', node({ seq: 596, step: 1, blocks: withTool() })],
    ['t1', node({ seq: 597, step: 1 })],
    ['answer', node({ seq: 598, step: 2, blocks: prose(240) })],
    ['tail', node({ seq: 599 })],
  ])
  const rows = rowsOf(seats, nodes)[0]
  const { answer, hidden, foldable } = foldTurn(rows, ended())
  assert.equal(foldable, true)
  assert.equal(answer.key, 'answer')
  assert.deepEqual(hidden.map(row => row.key), ['ctx-owned', 's1', 't1'])
})

// --- the LAST closing row is the boundary, not the first ---------------------
//
// Measured live on turn 10 of the fold-it-up session. The footer (`turn-tail`) is
// anchored at "the last message carrying text, +0.1", and a Turn can reach that
// anchor MID-TURN: the rendered order was
//
//   user / control / context x3 / assistant-step(903) / turn-tail(903.1)
//   / tool-call x4 (904-911) / context x2 (916, 917) / turn-error(920)
//
// Taking the FIRST closing row as the boundary put it on the footer, above four
// tool calls and two injected-context rows that are still this Turn's work, and
// the pass reported `foldable: true` while leaving six of the ten rows that
// belong behind the disclosure on screen — the reported defect.
//
// The two notices are anchored on `turn/end`'s own seq, so they are the real end
// of the Turn; the footer is the only closing kind that can sit mid-Turn. Taking
// the LAST closing row therefore bounds the fold where the Turn actually ended,
// and everything below that row keeps the old behaviour and stays readable.

test('a mid-turn footer does not stop the fold short of the real notice', () => {
  const seats = [
    seat({ key: 'user', kind: 'user', turn: 10 }),
    seat({ key: 'control', kind: 'turn-process', turn: 10 }),
    seat({ key: 'ctx-898', kind: 'context', turn: 10 }),
    seat({ key: 'ctx-900', kind: 'context', turn: 10 }),
    seat({ key: 'ctx-901', kind: 'context', turn: 10 }),
    seat({ key: 'step-903', kind: 'assistant-step', turn: 10 }),
    seat({ key: 'tail-903.1', kind: 'turn-tail', turn: 10 }),
    seat({ key: 'tc-904', kind: 'tool-call', turn: 10 }),
    seat({ key: 'tc-907', kind: 'tool-call', turn: 10 }),
    seat({ key: 'tc-909', kind: 'tool-call', turn: 10 }),
    seat({ key: 'tc-911', kind: 'tool-call', turn: 10 }),
    seat({ key: 'ctx-916', kind: 'context', turn: 10 }),
    seat({ key: 'ctx-917', kind: 'context', turn: 10 }),
    seat({ key: 'err-920', kind: 'turn-error', turn: 10 }),
  ]
  // No seat mark anywhere: this is the live shape, where the shipped window gate
  // never opened (the Turn published no answer), so only the sequence range on the
  // control row describes the work.
  const nodes = new Map([
    ['user', node({ seq: 899, blocks: prose(5), turn: 10 })],
    ['control', controlNode(902.9, 10, 902.9)],
    ['step-903', node({ seq: 903, step: 1, blocks: withTool(), turn: 10 })],
    ['tc-904', node({ seq: 904, step: 1, turn: 10 })],
    ['tc-907', node({ seq: 907, step: 1, turn: 10 })],
    ['tc-909', node({ seq: 909, step: 1, turn: 10 })],
    ['tc-911', node({ seq: 911, step: 1, turn: 10 })],
  ])
  const rows = rowsOf(seats, nodes)[0]
  const { answer, hidden, foldable } = foldTurn(rows, ended({ processStartSeq: 902.9 }))
  assert.equal(foldable, true)
  assert.equal(answer, null)
  assert.deepEqual(hidden.map(row => row.key), [
    'ctx-898', 'ctx-900', 'ctx-901', 'step-903',
    'tc-904', 'tc-907', 'tc-909', 'tc-911', 'ctx-916', 'ctx-917',
  ])
  const kept = rows.filter(row => !hidden.includes(row)).map(row => row.key)
  assert.deepEqual(kept, ['user', 'control', 'tail-903.1', 'err-920'])
})

test('the notice stays the boundary when a context row trails it', () => {
  // The other half of the same rule: the boundary is the LAST closing row, not
  // the end of the group. A context row injected after the notice is not part of
  // the work being summarized — it arrived once the Turn was already over — and
  // the row the notice belongs to must stay readable where it is.
  const seats = [
    seat({ key: 'user', kind: 'user', turn: 10 }),
    seat({ key: 'control', kind: 'turn-process', turn: 10 }),
    seat({ key: 'step-903', kind: 'assistant-step', turn: 10 }),
    seat({ key: 'tail-903.1', kind: 'turn-tail', turn: 10 }),
    seat({ key: 'tc-904', kind: 'tool-call', turn: 10 }),
    seat({ key: 'err-920', kind: 'turn-error', turn: 10 }),
    seat({ key: 'ctx-921', kind: 'context' }),
  ]
  const nodes = new Map([
    ['user', node({ seq: 899, blocks: prose(5), turn: 10 })],
    ['control', controlNode(902.9, 10, 902.9)],
    ['step-903', node({ seq: 903, step: 1, blocks: withTool(), turn: 10 })],
    ['tc-904', node({ seq: 904, step: 1, turn: 10 })],
  ])
  const rows = rowsOf(seats, nodes)[0]
  const { answer, hidden, foldable } = foldTurn(rows, ended({ processStartSeq: 902.9 }))
  assert.equal(foldable, true)
  assert.equal(answer, null)
  assert.deepEqual(hidden.map(row => row.key), ['step-903', 'tc-904'])
  const kept = rows.filter(row => !hidden.includes(row)).map(row => row.key)
  assert.deepEqual(kept, ['user', 'control', 'tail-903.1', 'err-920', 'ctx-921'])
})
