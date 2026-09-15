/**
 * Pure decision logic for the whole-turn fold.
 *
 * Shared verbatim by the browser bundle and the Node-side self-check, so it
 * must stay free of DOM, React, and module-system references. The one DOM-shaped
 * helper (`groupSeats`) takes an element but only reads attributes off it, which
 * is why it can be exercised against a stub.
 *
 * WHY THE RENDERED GROUP DECIDES
 *
 * A Turn's rendered rows and the Chat store's view of that same Turn can
 * disagree. When `chat.loadOlder` prepends a page, React commits the new seats
 * in chunks, so the DOM briefly holds rows the current store snapshot does not
 * describe yet. Deciding the hide set from the store and applying it to the DOM
 * therefore hides the wrong rows: measured live, one Turn's process grew from 94
 * to 116 rendered rows right after its own pass, which folded 18 rows and left
 * 102 visible.
 *
 * So the ROW SET and its ORDER come from the seat wrappers themselves, which
 * `ChatNodeSeat` writes one per rendered node (`data-chat-turn`,
 * `data-chat-flow-kind`, `data-chat-anchor-key`), while the store supplies only
 * per-key CONTENT (blocks, step). Membership in the process range is likewise the
 * shipped seat's own mark (`data-turn-process-member`), so the range never has to
 * be re-derived from numbers that can disagree with what is on screen.
 *
 * Two shapes cross this boundary:
 *
 *   Row  — one rendered flow item:
 *          { key, kind, seq, step, turn, member, hasToolCall, textLen }
 *   Fold — one Turn's disclosure:
 *          { turn, answerStep, answerAnchorSeq, open }
 *
 * ONLY A CLOSED TURN FOLDS
 *
 * The shipped fold gates on `turnClosed` (`turn-process-presentation.ts`) as well
 * as on a finalized answer, and the second half of that gate is not enough on
 * its own. `latestAnswer` in `turn-process.ts` only accepts the LAST step's
 * `assistant-step` node once it carries a `finalNode`, but the step that is
 * still streaming IS the last step, so a running turn keeps publishing the
 * PREVIOUS step's finalized answer as its boundary while the live step grows
 * below it: `answerAnchorSeq` points above the row the model is writing right
 * now. Measured live, that made the disclosure appear two seconds into a turn,
 * fold the work, and keep the still-growing reasoning row visible as the
 * "answer" — and the same recomputation dropped it again when the step settled.
 *
 * A turn's close is stated by its own rows: `turn-tail` is published on
 * `turn/end` whatever the reason, and the two failure notices are published with
 * it, so their presence in a rendered group is the DOM's own copy of
 * `turnClosed`. That is the gate this module applies, and it is why the fold
 * appears only once the turn is really over.
 *
 * A FAILED TURN HAS NO ANSWER, AND ITS NOTICE IS THE BOUNDARY
 *
 * Folding used to require an answer row: the process range was hidden only up to
 * the finalized reply the range was published against. A Turn that ends because
 * the provider failed, or because max tokens were hit, publishes neither
 * `answerStep` nor `answerAnchorSeq` — and in the live shape marks no process
 * rows either, because the shipped window gate never opens without an answer. So
 * both paths fell through to `foldable: false` and the whole tangle stayed on
 * screen: the loudest failure was the one case the fold refused to collapse.
 *
 * Deciding those needs only the fact that already gates this module: the Turn is
 * closed. The first closing row in the group is where its process ends, so
 * everything above that row is work and the notice — with anything rendered
 * below it — stays readable, no row stamped as the answer. A closing row that
 * sits ABOVE a prose step keeps the same meaning: prose the Turn never finalized
 * is not its answer, and the notice still bounds the fold. Only a group with no
 * closing row at all falls back to the whole range, which is the interrupted
 * Turn whose work still belongs behind the disclosure.
 *
 * INJECTED CONTEXT BELONGS TO A TURN WITHOUT SAYING SO
 *
 * Every other kind of work the model was fed carries its Turn in the seat's own
 * `data-chat-turn`. Injected context does not: a `context` node's Location is
 * unresolved (its `user/message` event carries no `turn`), so its seat renders
 * `data-chat-turn="null"` and it joins no group at all. Measured live, that is
 * exactly why those rows stayed on screen while the work beside them folded —
 * they were not "excluded", they were never part of any decision.
 *
 * `groupSeats` therefore assigns each turn-less `context` row to the Turn its
 * row precedes, which is the Turn it was injected for: a context row sits above
 * the Turn it opened. A trailing context row with no Turn below it stays with
 * the preceding Turn. That is enough for the hide set, because a row is only
 * ever hidden when it precedes the Turn's answer, and the answer always belongs
 * to the Turn itself.
 *
 * THE ANSWER'S FIRST LINE IS THE POINT
 *
 * A turn that closes after a long answer leaves the view at the bottom of that
 * answer, which is the wrong end to read it from. The decision below turns "a
 * turn just closed" plus four numbers measured off the scroller into one scroll,
 * and it lives here rather than in the browser half for the usual reason: every
 * condition that must leave the reader alone is a truth table, and a truth table
 * that only a browser can exercise is a truth table nobody checks.
 */

/** Chat Node kinds that stay outside the fold's hiding range. */
export const INDEPENDENT_KINDS = new Set([
  'system-prompt',
  'user',
  'steering',
  'turn-process',
  'turn-error',
  'turn-max-tokens',
  'turn-tail',
])

/**
 * The kind of injected-context row this module re-parents onto a Turn.
 *
 * Deliberately narrow: it is the kind whose Location is unresolved, so it has no
 * Turn of its own to be decided with. Every other kind still folds by its own
 * seat's Turn.
 */
export const CONTEXT_KIND = 'context'

/**
 * Kinds that exist only once their Turn has ended.
 *
 * `turn-tail` is published on `turn/end` whatever the reason, and the error and
 * max-token notices are published with it, so a rendered row of one of these
 * kinds is the DOM's own statement that the Turn is closed — the same fact the
 * shipped gate reads as `turnClosed`. A group without one is still running and
 * must not be folded, however finalized its published answer boundary looks.
 */
export const CLOSING_KINDS = new Set(['turn-tail', 'turn-error', 'turn-max-tokens'])

/** The seat attribute carrying one rendered node's owning Turn. */
export const TURN_ATTRIBUTE = 'data-chat-turn'
/** The seat attribute carrying one rendered node's kind. */
export const KIND_ATTRIBUTE = 'data-chat-flow-kind'
/** The seat attribute carrying one rendered node's stable key. */
export const KEY_ATTRIBUTE = 'data-chat-anchor-key'
/**
 * The shipped seat's own membership mark. `ChatNodeSeat` writes it from the
 * shipped projection, which makes it the authoritative answer to "is this
 * rendered row part of the foldable process range" — nothing to re-derive.
 */
export const MEMBER_ATTRIBUTE = 'data-turn-process-member'
/**
 * The disclosure control's own attribute, written by the shipped row and by the
 * built-in fallback alike. It is how a pass reads back whether a Turn is open.
 */
export const ROW_ATTRIBUTE = 'data-turn-process'

/**
 * Whether a Chat Node kind stays outside the fold's hiding range.
 * @param kind - Chat node kind.
 * @returns whether the row is independent of the process disclosure.
 */
export function isIndependentKind(kind) {
  return INDEPENDENT_KINDS.has(kind)
}

/**
 * Whether one rendered row is injected context the fold must re-parent.
 *
 * Membership marks are deliberately not consulted: the shipped seat only marks
 * rows once its own window gate opens, and these rows are the ones that need the
 * fold most while that gate is shut.
 * @param row - plain row descriptor.
 * @returns whether the row is a turn-less injected-context row.
 */
export function isContextRow(row) {
  return row.kind === CONTEXT_KIND && !Number.isSafeInteger(row.turn)
}

/**
 * The Turn number one rendered seat wrapper names, when it names one.
 *
 * The attribute is read defensively because the seat renders `data-chat-turn`
 * from a possibly undefined Turn: React drops an undefined attribute but writes
 * the string "null" for a null one, and either shape must fall through to the
 * re-parenting rule rather than create a fictitious group.
 * @param element - the `data-chat-flow-kind` wrapper.
 * @returns the Turn number, or null when the seat names none.
 */
export function turnOfSeat(element) {
  const raw = element.getAttribute(TURN_ATTRIBUTE)
  if (raw === null) return null
  const turn = Number(raw)
  return Number.isSafeInteger(turn) ? turn : null
}

/**
 * Whether one rendered row is a member of its Turn's process range.
 *
 * Two sources agree here and both are the DOM's own statement: the shipped
 * seat's `data-turn-process-member` mark, and — for injected context, which the
 * seat cannot mark because it belongs to no Turn — this module's own
 * re-parenting by `groupSeats`.
 * @param row - plain row descriptor.
 * @returns whether the fold may hide the row.
 */
export function isProcessMember(row) {
  return (row.member || isContextRow(row)) && !isIndependentKind(row.kind)
}

/**
 * Whether one rendered row is a finalized answer: it carries reply PROSE and
 * closes with prose rather than a tool call.
 *
 * Reasoning is deliberately not reply content, matching the shipped
 * `hasAssistantReplyContent`. Counting it made the step the model was thinking
 * in look like a finished answer, which is what let a live turn fold itself.
 * @param row - plain row descriptor.
 * @returns whether the row could serve as a turn's final answer.
 */
export function isAnswerRow(row) {
  return row.kind === 'assistant-step' && row.hasToolCall !== true && (row.textLen ?? 0) > 0
}

/**
 * Map one rendered seat wrapper to a row descriptor.
 *
 * Content fields start neutral: a row whose node the store cannot resolve keeps
 * `textLen` 0 and `hasToolCall` false, so the answer search can never mistake it
 * for the answer.
 * @param element - the `data-chat-flow-kind` wrapper.
 * @param turn - the Turn whose group this element belongs to.
 * @returns the row descriptor.
 */
export function rowOfSeat(element, turn) {
  return {
    key: element.getAttribute(KEY_ATTRIBUTE) ?? null,
    kind: element.getAttribute(KIND_ATTRIBUTE),
    seq: null,
    step: null,
    turn,
    member: element.hasAttribute(MEMBER_ATTRIBUTE),
    hasToolCall: false,
    textLen: 0,
    // The pass writes through this reference rather than looking the row up by
    // key: keys are unique per Node today, but a lookup that fails silently is
    // exactly how a row stays visible after a successful fold.
    element,
  }
}

/**
 * Collect the rendered rows of every Turn in one flow column, in DOM order.
 *
 * The group key is the seat's own `data-chat-turn`, so the returned groups are
 * exactly the sets a DOM pass walks — including rows the current store snapshot
 * has not described yet. An injected-context row names no Turn, and is appended
 * to the group of the Turn it precedes, which is the Turn it was injected for; a
 * trailing one stays with the Turn above it. Those rows are flushed together
 * with the next Turn-bearing seat, so DOM order survives the re-parenting.
 *
 * Only injected context is re-parented. Any other Turn-less row is left out of
 * every group rather than credited to a Turn that never owned it.
 * @param column - the element holding the flow items.
 * @returns a Map from Turn number to that Turn's rows, in DOM order.
 */
export function groupSeats(column) {
  const groups = new Map()
  /** Injected-context rows still waiting for the Turn below them. */
  let pending = []
  /** The last Turn seen, which adopts trailing context. */
  let previous = null
  const push = (turn, row) => {
    const rows = groups.get(turn)
    if (rows === undefined) groups.set(turn, [row])
    else rows.push(row)
  }
  const flush = (turn, row) => {
    for (const waiting of pending) push(turn, waiting)
    pending = []
    const rows = groups.get(turn)
    if (rows === undefined) groups.set(turn, [row])
    else rows.push(row)
  }
  for (const element of column.querySelectorAll(`[${KIND_ATTRIBUTE}]`)) {
    const turn = turnOfSeat(element)
    if (turn === null) {
      const row = rowOfSeat(element, Number.NaN)
      if (isContextRow(row)) pending.push(row)
      continue
    }
    previous = turn
    flush(turn, rowOfSeat(element, turn))
  }
  if (previous !== null) for (const row of pending) push(previous, row)
  return groups
}

/**
 * The Turn each rendered seat belongs to, read from the DOM alone.
 *
 * The same answer `groupSeats` reaches, shaped for a DOM-side consumer: the fold
 * controller stamps `data-folditup-turn` onto every row it decides, so a reader
 * (a probe, a page-side check) can group rows by the Turn whose disclosure
 * governs them without re-deriving the context re-parenting rule.
 * @param column - the element holding the flow items.
 * @returns a Map from each seat wrapper to its Turn number.
 */
export function effectiveTurns(column) {
  const owners = new Map()
  for (const [turn, rows] of groupSeats(column)) for (const row of rows) owners.set(row.element, turn)
  for (const element of column.querySelectorAll(`[${KIND_ATTRIBUTE}]`)) {
    if (!owners.has(element)) owners.set(element, null)
  }
  return owners
}

/**
 * Attach per-key content from the store to rows read from the DOM.
 *
 * Only content crosses over: the row set and its order stay the DOM's. `textLen`
 * counts reply PROSE only — reasoning is process material even when it is
 * rendered inline in the step that will later answer, so a step that is still
 * thinking carries `textLen` 0 and cannot be mistaken for the answer.
 * @param rows - rows read from the seat wrappers.
 * @param nodeAt - reader for one node key.
 * @returns the same rows, enriched and in the same order.
 */
export function attachNodeData(rows, nodeAt) {
  for (const row of rows) {
    if (row.key === null) continue
    const node = nodeAt(row.key)
    if (node === undefined || node === null) continue
    const data = node.data ?? {}
    const blocks = Array.isArray(data.blocks) ? data.blocks : []
    row.seq = typeof node.anchorSeq === 'number' ? node.anchorSeq : null
    row.step = typeof data.step === 'number' ? data.step : null
    row.hasToolCall = blocks.some(block => (block?.type ?? block?.kind) === 'tool-call')
    row.textLen = blocks
      .filter(block => (block?.type ?? block?.kind) === 'text')
      .reduce((total, block) => total + (block?.text ?? '').trim().length, 0)
  }
  return rows
}

/**
 * Decide one Turn's fold from its rendered group.
 *
 * Two range descriptions exist and either may be the only usable one, so they
 * are tried in order of fidelity:
 *
 *   1. the seat's own `data-turn-process-member` marks — the shipped seat wrote
 *      them from the shipped projection, so the hidden set is exactly the one
 *      the product would have drawn. This is the preferred source because it
 *      cannot disagree with what is on screen.
 *   2. the disclosure row's published sequence range. The marks are absent
 *      whenever the seat declined the fold for its own reasons — a live Turn, or
 *      a window the store had not classified when the seats were committed —
 *      while the projection itself is still published on the control row.
 *
 * Whichever source describes the range, the ORDER and the ROW SET are the
 * rendered group's, which is what keeps a decision applicable to the DOM it is
 * about to be applied to. A group whose rows say it is still running folds
 * nothing at all, whatever range its published projection describes.
 *
 * Which source is tried is decided by the SEAT'S OWN MEMBERSHIP MARKS, never by
 * this module's re-parenting: an injected-context row is adopted into a Turn
 * whose seats never marked it, so one context row in a group is not a statement
 * that the marks describe this range. It joins the hidden set on either path; it
 * never picks the path.
 * @param rows - the Turn's rendered rows, in DOM order, with node data attached.
 * @param fold - the Turn's projection (`answerStep` / `answerAnchorSeq` /
 * `processStartSeq`).
 * @returns `{ answer, hidden, foldable }`; `hidden` holds row objects.
 */
export function foldTurn(rows, fold) {
  if (fold.open === true) return { answer: null, hidden: [], foldable: true }
  // The closure gate, and it comes first: a running Turn keeps publishing the
  // PREVIOUS step's finalized answer while the step it is writing grows below
  // that boundary, so every range comparison below would be made against a
  // boundary that has already moved. Fold nothing until the Turn has ended.
  if (fold.closed !== true) return { answer: null, hidden: [], foldable: false }

  const seatsMarked = rows.filter(row => row.member === true && !isIndependentKind(row.kind))
  const ranged = seatsMarked.length > 0 ? null : projectedRange(rows, fold)
  // The first closing row is where a Turn that produced no answer stops being
  // process: the notice is published on `turn/end`, so nothing that follows it
  // can be work still being done. A group that never closed on camera (the
  // interrupted Turn) has no such row, and there its whole range is work — so
  // the fallback boundary is the end of the group, not the start.
  const closing = rows.findIndex(row => CLOSING_KINDS.has(row.kind))
  const boundary = closing === -1 ? rows.length : closing
  const members = seatsMarked.length > 0 ? rows.filter(isProcessMember) : (ranged ?? [])
  const last = members.length === 0 ? 0 : rows.indexOf(members[members.length - 1])
  const candidate = answerFor(rows, fold) ?? lastProse(rows, last)
  // A reply that renders BELOW the notice is not this Turn's answer: the Turn
  // had already given up before writing it. Keep the notice as the boundary and
  // leave that row readable where it is.
  const answer = candidate !== null && rows.indexOf(candidate) < boundary ? candidate : null
  const stop = answer === null ? boundary : rows.indexOf(answer)
  const hidden = members.filter(row => rows.indexOf(row) < stop)
  // Nothing to put behind the disclosure is nothing to disclose.
  if (hidden.length === 0) return { answer: null, hidden: [], foldable: false }
  return { answer, hidden, foldable: true }
}

/**
 * The rows a published sequence range covers, in rendered order.
 *
 * The range is `[processStartSeq, answerAnchorSeq)` with independent kinds
 * excepted, which is the geometry the shipped fold uses. Re-parented context
 * rows are admitted without a position — their node resolves to no sequence —
 * because the group they were assigned to is the statement that they belong to
 * this Turn's process.
 * @param rows - the Turn's rendered rows, in DOM order.
 * @param fold - the Turn's projection.
 * @returns the rows to hide, or null when no range is published.
 */
function projectedRange(rows, fold) {
  const start = fold.processStartSeq
  if (start === null || start === undefined) return null
  const boundary = fold.answerAnchorSeq ?? Number.POSITIVE_INFINITY
  const hidden = rows.filter(row => !isIndependentKind(row.kind)
    && (isContextRow(row)
      || (row.seq !== null && row.seq >= start && row.seq < boundary)))
  if (hidden.length === 0) return null
  return hidden
}

/**
 * The answer row a projection names, when it is still rendered.
 * @param rows - the Turn's rendered rows, in DOM order.
 * @param fold - the Turn's projection.
 * @returns the answer row, or null.
 */
function answerFor(rows, fold) {
  if (fold.answerStep !== null && fold.answerStep !== undefined) {
    const settled = rows
      .filter(row => row.kind === 'assistant-step' && row.step === fold.answerStep)
      .filter(isAnswerRow)
      .at(-1)
    if (settled !== undefined) return settled
  }
  if (fold.answerAnchorSeq !== null && fold.answerAnchorSeq !== undefined) {
    const settled = rows
      .filter(row => row.seq === fold.answerAnchorSeq)
      .filter(isAnswerRow)
      .at(-1)
    if (settled !== undefined) return settled
  }
  return null
}

/**
 * The last row carrying prose at or below an index, which is the row a reader
 * must still see once the process above it is folded away.
 * @param rows - the Turn's rendered rows, in DOM order.
 * @param from - lowest index to consider.
 * @returns the answer row, or null when the Turn produced no readable reply.
 */
function lastProse(rows, from) {
  const below = rows.slice(Math.max(0, from)).filter(isAnswerRow)
  return below.length === 0 ? null : below[below.length - 1]
}

/**
 * Where one just-closed Turn's question should be scrolled to, or null.
 *
 * The scroll exists because a finished answer is read from its FIRST line, while
 * the transcript is left at its last one. Only a Turn that has just closed
 * qualifies: a Turn that was already closed when the page loaded (a history, a
 * session switch) is not an event, and scrolling on mount would yank the reader
 * away from wherever they were. Everything else here is a reason to leave the
 * scrollbar alone, and each one is a separate way this could be annoying:
 *
 *   - no question row resolved — nothing to aim at;
 *   - `floor <= 0` — the transcript does not scroll at all, which is the short
 *     answer case: the write would be a no-op anyway, and not making it keeps
 *     the "already at the top" state from being re-evaluated forever;
 *   - the question is already on the scrollport's top edge — the view is where
 *     this would put it, so moving it would only be a visible twitch.
 *
 * Only the offset is computed here: HOW the scroll animates belongs to the
 * stylesheet, where `prefers-reduced-motion` can rewrite it without this
 * decision having to know the reader's motion setting.
 * @param change - `{ closed, wasOpen }`: the Turn's closure in the current pass
 *   (`closed: boolean | undefined`) and whether its disclosure was expanded in
 *   the previous one (expanding a Turn is the reader's own gesture, not a
 *   moment to move their view).
 * @param geometry - `{ scrollTop, floor, questionTop }`, all in pixels; the
 *   question's top is measured against the scrollport's own top edge.
 * @returns `{ top }`, or null when the reader must be left alone.
 */
export function autoScrollTarget(change, geometry) {
  if (change?.closed !== true) return null
  if (change.wasOpen === true) return null
  if (geometry === null || geometry === undefined) return null
  const { scrollTop, floor, questionTop } = geometry
  if (![scrollTop, floor, questionTop].every(Number.isFinite)) return null
  if (floor <= 0) return null
  if (Math.abs(questionTop) <= 0.5) return null
  return { top: Math.max(0, scrollTop + questionTop) }
}

/**
 * Fold one whole flow column and apply the result to its rows.
 *
 * One call is one complete pass: the column is read, every Turn is decided, and
 * the DOM is written. Reading and applying together is the point — a page
 * committed into the DOM in the same frame must be decided as it stands, not as
 * the last store snapshot described it.
 *
 * Operations are injected (`ops`) rather than reached for globally, which keeps
 * this module free of a `document` dependency while still letting a test drive a
 * real pass.
 * @param column - the element holding the flow items.
 * @param nodeAt - reader for one node key, giving the store's content.
 * @param ops - `{ stamp, setHidden, setAnswer }`, each taking an element.
 * @returns `{ turns: Map<number, { foldable, closed, open, hidden, answerKey, rows }> }`.
 */
export function foldColumn(column, nodeAt, ops) {
  const turns = new Map()
  const groups = groupSeats(column)
  for (const [turn, seats] of groups) {
    const rows = attachNodeData(seats, nodeAt)
    const control = rows.find(row => row.kind === 'turn-process' && row.key !== null)
    const controlElement = control?.element
    const controlNode = control === undefined ? undefined : nodeAt(control.key)
    // Expansion is read from the ROW's own `data-open`, not from the seat wrapper
    // that carries it: the seat is the indexed element, while the shipped row and
    // the built-in fallback both write the attribute on the row they render
    // inside it. The DOM therefore states the whole input to this pass and no
    // React state is threaded into it.
    const rowElement = controlElement === undefined
      ? undefined
      : controlElement.querySelector(`[${ROW_ATTRIBUTE}]`) ?? controlElement
    const open = rowElement !== undefined && rowElement.hasAttribute('data-open')
    // Closure is read from the group's own rows: `turn-tail` (and the two
    // notices published with it) exists only after `turn/end`, so a group
    // without one is a Turn that is still running and must keep showing its
    // work. This is the same fact the shipped gate reads as `turnClosed`, and
    // it is the one thing the published projection cannot state: a live Turn
    // keeps the PREVIOUS step's answer boundary while it writes the next one.
    const closed = rows.some(row => CLOSING_KINDS.has(row.kind))
    const decision = foldTurn(rows, {
      turn,
      processStartSeq: controlNode?.data?.processStartSeq ?? null,
      answerStep: controlNode?.data?.answerStep ?? null,
      answerAnchorSeq: controlNode?.data?.answerAnchorSeq ?? null,
      open,
      closed,
    })
    const hidden = new Set(decision.hidden)
    const answer = decision.answer
    for (const row of rows) {
      const element = row.element
      if (element === undefined) continue
      ops.setTurn(element, turn)
      ops.stamp(element, row.seq)
      ops.setHidden(element, hidden.has(row))
      ops.setAnswer(element, row === answer)
    }
    turns.set(turn, {
      foldable: decision.foldable,
      // Published so a row (and a probe) can tell "this Turn is still running"
      // from "this Turn has nothing to summarize": the two look identical at the
      // surface — no disclosure either way — while only one of them is stable.
      closed,
      open,
      hidden: hidden.size,
      answerKey: answer === null ? null : answer.key,
      rows: rows.length,
    })
  }
  return { turns, counted: { column: column.querySelectorAll(`[${KIND_ATTRIBUTE}]`).length, groups: groups.size } }
}
