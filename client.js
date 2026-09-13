window.__ModuleLoader__.load({
  id: "dsh-fold-it-up",
  factory: (require) => {
    /* src/logic.js */
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
    const INDEPENDENT_KINDS = new Set([
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
    const CONTEXT_KIND = 'context'

    /**
     * Kinds that exist only once their Turn has ended.
     *
     * `turn-tail` is published on `turn/end` whatever the reason, and the error and
     * max-token notices are published with it, so a rendered row of one of these
     * kinds is the DOM's own statement that the Turn is closed — the same fact the
     * shipped gate reads as `turnClosed`. A group without one is still running and
     * must not be folded, however finalized its published answer boundary looks.
     */
    const CLOSING_KINDS = new Set(['turn-tail', 'turn-error', 'turn-max-tokens'])

    /** The seat attribute carrying one rendered node's owning Turn. */
    const TURN_ATTRIBUTE = 'data-chat-turn'
    /** The seat attribute carrying one rendered node's kind. */
    const KIND_ATTRIBUTE = 'data-chat-flow-kind'
    /** The seat attribute carrying one rendered node's stable key. */
    const KEY_ATTRIBUTE = 'data-chat-anchor-key'
    /**
     * The shipped seat's own membership mark. `ChatNodeSeat` writes it from the
     * shipped projection, which makes it the authoritative answer to "is this
     * rendered row part of the foldable process range" — nothing to re-derive.
     */
    const MEMBER_ATTRIBUTE = 'data-turn-process-member'
    /**
     * The disclosure control's own attribute, written by the shipped row and by the
     * built-in fallback alike. It is how a pass reads back whether a Turn is open.
     */
    const ROW_ATTRIBUTE = 'data-turn-process'

    /**
     * Whether a Chat Node kind stays outside the fold's hiding range.
     * @param kind - Chat node kind.
     * @returns whether the row is independent of the process disclosure.
     */
    function isIndependentKind(kind) {
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
    function isContextRow(row) {
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
    function turnOfSeat(element) {
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
    function isProcessMember(row) {
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
    function isAnswerRow(row) {
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
    function rowOfSeat(element, turn) {
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
    function groupSeats(column) {
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
    function effectiveTurns(column) {
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
    function attachNodeData(rows, nodeAt) {
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
     * @param rows - the Turn's rendered rows, in DOM order, with node data attached.
     * @param fold - the Turn's projection (`answerStep` / `answerAnchorSeq` /
     * `processStartSeq`).
     * @returns `{ answer, hidden, foldable }`; `hidden` holds row objects.
     */
    function foldTurn(rows, fold) {
      if (fold.open === true) return { answer: null, hidden: [], foldable: true }
      // The closure gate, and it comes first: a running Turn keeps publishing the
      // PREVIOUS step's finalized answer while the step it is writing grows below
      // that boundary, so every range comparison below would be made against a
      // boundary that has already moved. Fold nothing until the Turn has ended.
      if (fold.closed !== true) return { answer: null, hidden: [], foldable: false }

      const marked = rows.filter(isProcessMember)
      if (marked.length > 0) {
        const answer = answerFor(rows, fold) ?? lastProse(rows, rows.indexOf(marked[marked.length - 1]))
        if (answer !== null) return { answer, hidden: before(rows, marked, answer), foldable: true }
        // A Turn with marked process but nothing to summarize: fold nothing rather
        // than leave the reader with no way back to the rows.
        return { answer: null, hidden: [], foldable: false }
      }

      const ranged = projectedRange(rows, fold)
      if (ranged === null) return { answer: null, hidden: [], foldable: false }
      const answer = ranged.answer
        ?? lastProse(rows, rows.indexOf(ranged.hidden[ranged.hidden.length - 1]))
      if (answer === null) return { answer: null, hidden: [], foldable: false }
      return { answer, hidden: before(rows, ranged.hidden, answer), foldable: true }
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
     * @returns `{ hidden, answer }`, or null when no range is published.
     */
    function projectedRange(rows, fold) {
      const start = fold.processStartSeq
      if (start === null || start === undefined) return null
      const boundary = fold.answerAnchorSeq ?? Number.POSITIVE_INFINITY
      const hidden = rows.filter(row => !isIndependentKind(row.kind)
        && (isContextRow(row)
          || (row.seq !== null && row.seq >= start && row.seq < boundary)))
      if (hidden.length === 0) return null
      return { hidden, answer: answerFor(rows, fold) }
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
     * The members of a range that precede one row.
     * @param rows - the Turn's rendered rows, in DOM order.
     * @param members - candidate rows to hide.
     * @param answer - the row that must stay readable.
     * @returns the rows to hide.
     */
    function before(rows, members, answer) {
      const boundary = rows.indexOf(answer)
      return members.filter(row => rows.indexOf(row) < boundary)
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
    function autoScrollTarget(change, geometry) {
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
    function foldColumn(column, nodeAt, ops) {
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
    const __module1 = { exports: { INDEPENDENT_KINDS, CONTEXT_KIND, CLOSING_KINDS, TURN_ATTRIBUTE, KIND_ATTRIBUTE, KEY_ATTRIBUTE, MEMBER_ATTRIBUTE, ROW_ATTRIBUTE, isIndependentKind, isContextRow, turnOfSeat, isProcessMember, isAnswerRow, rowOfSeat, groupSeats, effectiveTurns, attachNodeData, foldTurn, autoScrollTarget, foldColumn } }

    /* src/browser.js */
    /**
     * dsh-fold-it-up — browser half (authored ESM; bundled into ../client.js).
     *
     * PROBLEM
     * The shipped Turn-process disclosure only folds when every precondition in
     * `ChatNodeSeat.tsx` holds. The one users actually hit is `historyIncomplete`:
     * while the Chat window still has older history behind the "load earlier"
     * control, `processWindowReady` is false and NO turn folds — not the new one,
     * not the historical ones. The initial window is 50 messages
     * (`PAGE_MESSAGES` in `@deepseek-ai/dsh-api-session-controller`), so a session
     * with more than a couple of exchanges sits in that state permanently.
     *
     * WHAT THIS DOES
     * It shadows the `turn-process` keyed Chat renderer (`priority: -1` wins the
     * cell against the shipped `0`) and owns the disclosure itself:
     *
     *   - the fold condition is "this turn is CLOSED and has process rows", nothing
     *     else — no history-completeness gate, no answer-recognition gate. Closure
     *     is read from the turn's own rows (`turn-tail` is published on `turn/end`
     *     whatever the reason), because the published answer boundary is NOT enough
     *     on its own: a running Turn keeps the previous step's finalized answer
     *     while the step it is writing grows below that boundary, which is what
     *     made an earlier version fold the work and leave live reasoning outside;
     *   - the hidden range is read from the published projection
     *     (`processStartSeq` + `answerAnchorSeq`/`answerStep`), so the geometry
     *     matches the shipped fold row for row, at any history depth, after a
     *     reload, and for turns that ended before this plugin existed;
     *   - rows are hidden by reusing the shipped mechanism on the same wrapper
     *     elements the owner already uses for it — `hidden="until-found"`, which
     *     keeps both the column rhythm ("hidden and empty Seats do not contribute
     *     spacing") and find-on-page working;
     *   - the row itself is the SHIPPED renderer, compiled at runtime from the
     *     source map the page already fetched, so the wording, theme styling and
     *     geometry stay the product's rather than an imitation;
     *   - expansion state lives in this entry's own store, whose default — every
     *     turn collapsed — is what makes a fresh page, a session switch and a
     *     brand-new install all come up folded.
     *
     * Only the rows the shipped fold would have hidden are ever touched. A turn
     * that is still running, an interrupted turn with no answer, and a turn with
     * nothing to hide all render exactly as before.
     */

    const React = require("react")
    const { defineStore } = require("@deepseek-ai/dsh-client-store")
    const { autoScrollTarget: autoScrollTarget$0, foldColumn: foldColumn$1 } = __module1.exports
    /** Package name; also the module-table key this bundle registers under. */
    const PACKAGE = 'dsh-fold-it-up'

    /** The Chat package whose renderer this bundle shadows and reuses. */
    const CHAT_PACKAGE = '@deepseek-ai/dsh-client-ui-chat'

    /** The Chat package's locale namespace, for the shipped row's labels. */
    const CHAT_NS = 'chat'

    /**
     * Locale knob: `localStorage['dsh-fold-it-up.locale'] = 'en' | 'zh'`.
     * Only the built-in fallback row reads it; the shipped row uses `chat` keys.
     */
    const LOCALE_KEY = 'dsh-fold-it-up.locale'

    /**
     * Scroll knob: `localStorage['dsh-fold-it-up.autoScroll'] = 'off'`.
     *
     * On by default: a finished answer is read from its first line, while the
     * transcript is left at its last one.
     */
    const SCROLL_KEY = 'dsh-fold-it-up.autoScroll'

    /** How long after a reader gesture a turn close keeps its hands off the view. */
    const READER_GRACE_MS = 1500

    const STRINGS = {
      zh: {
        thought: '已思考',
        separator: ' · ',
        toolCalls: count => `${String(count)} 次工具调用`,
        messages: count => `${String(count)} 条消息`,
        subagents: count => `${String(count)} 个 subagent`,
      },
      en: {
        thought: 'Thought for a while',
        separator: ' · ',
        toolCalls: count => `${String(count)} tool ${count === 1 ? 'call' : 'calls'}`,
        messages: count => `${String(count)} ${count === 1 ? 'message' : 'messages'}`,
        subagents: count => `${String(count)} subagent${count === 1 ? '' : 's'}`,
      },
    }

    /**
     * Resolve the display strings for the active locale.
     * @returns the string table for the document language or the explicit override.
     */
    function strings() {
      try {
        const override = globalThis.localStorage?.getItem(LOCALE_KEY)
        if (override === 'en') return STRINGS.en
        if (override === 'zh') return STRINGS.zh
      } catch {
        // A blocked storage must not break the renderer.
      }
      return String(globalThis.document?.documentElement?.lang ?? '').toLowerCase().startsWith('en')
        ? STRINGS.en
        : STRINGS.zh
    }

    const css = `
    .dsh-fold-it-up-root {
      box-sizing: border-box;
      display: flex;
      align-items: center;
      width: 100%;
      min-width: 0;
      height: 33px;
      padding: 0 0 8px;
      border: none;
      border-bottom: 0.5px solid var(--dsw-alias-border-l2);
      background: none;
      color: var(--dsw-alias-label-secondary);
      cursor: pointer;
      text-align: left;
    }
    .dsh-fold-it-up-root:not([data-open]) {
      margin-bottom: 8px;
    }
    .dsh-fold-it-up-root:focus-visible {
      outline: 2px solid var(--dsw-alias-label-primary);
      outline-offset: 2px;
      border-radius: 4px;
    }
    .dsh-fold-it-up-label {
      min-width: 0;
      overflow: hidden;
      font-size: var(--dsh-content-font-size, 14px);
      line-height: 24px;
      text-overflow: ellipsis;
      white-space: nowrap;
    }
    .dsh-fold-it-up-count {
      flex: none;
      margin-left: 8px;
      font-size: var(--dsh-content-font-size-secondary, 13px);
      line-height: 20px;
      font-variant-numeric: tabular-nums;
      color: var(--dsw-alias-label-caption);
    }
    .dsh-fold-it-up-chevron {
      flex: none;
      width: 13px;
      height: 13px;
      margin-left: 6px;
      color: var(--dsw-alias-label-tertiary);
      transform: rotate(-90deg);
      transition: transform 100ms ease;
    }
    .dsh-fold-it-up-root[data-open] .dsh-fold-it-up-chevron {
      transform: rotate(0deg);
    }
    /* The same tight seam the shipped fold puts between a closed process and its
       answer: one summary line immediately followed by one reply. */
    .flowItem[data-fold-it-up-answer] {
      --dsh-chat-flow-gap: 8px;
    }
    @media (prefers-reduced-motion: reduce) {
      .dsh-fold-it-up-chevron { transition: none; }
    }
    `

    /**
     * Insert this package's stylesheet once, tagged so the module system's style
     * bookkeeping can attribute it.
     * @returns the created style element.
     */
    function insertStyles() {
      const style = document.createElement('style')
      style.setAttribute('data-plugin', PACKAGE)
      style.setAttribute('data-plugin-css', 'dsh-fold-it-up/browser.css')
      style.textContent = css
      document.head.append(style)
      return style
    }

    /**
     * The disclosure's own store.
     *
     * The shipped chat store cannot be reached from this entry (its handle is owned
     * by the Chat view declaration), and it only records turns the SHIPPED fold
     * considered foldable anyway. This store carries exactly what the disclosure
     * needs, and its default — every turn collapsed — is what makes a reload, a
     * session switch and a plugin install all come up folded.
     * @returns the store handle registered on this entry.
     */
    function createDisclosureStore() {
      return defineStore({
        init: () => ({ turnProcesses: [] }),
        actions: {
          setTurnProcessOpen: (draft, turn, answerStep, open) => {
            const index = draft.turnProcesses.findIndex(entry => entry.turn === turn)
            if (!open) {
              if (index >= 0) draft.turnProcesses.splice(index, 1)
              return
            }
            const next = { turn, answerStep }
            if (index < 0) draft.turnProcesses.push(next)
            else draft.turnProcesses[index] = next
          },
        },
      })
    }

    /**
     * Create the page-scoped disclosure controller.
     *
     * It owns two things a per-row component cannot: one column-wide pass (reading
     * the rendered column is the expensive part, and N rows must not each repeat it)
     * and the published per-turn result every row renders from. The store above is
     * per session; the DOM and its passes belong to the page.
     *
     * Publication is deliberately not a React state write from inside the pass: the
     * pass already runs in a layout effect during commit, so it hands the result to
     * this controller and the controller's subscribers re-render. That keeps one
     * writer for the DOM and one source for what each row shows.
     * @returns the controller shared by every disclosure row through React context.
     */
    function createController() {
      const listeners = new Set()
      /** The last published pass: `{ turns: Map<number, decision> }`. */
      let published = { turns: new Map() }
      /** A live element of the transcript being folded, plus the readers a pass needs. */
      let scope = null
      let observer = null
      let observerColumn = null
      let scheduled = null
      let running = false
      const autoScroll = createAutoScroll()

      const run = (reason) => {
        if (scope === null || running) return
        // Resolve the column from the anchor on EVERY pass. React remounts the
        // transcript when the session or the scroll container is rebuilt, and a
        // column remembered from an earlier mount is detached: folding it would
        // write attributes onto elements nobody can see and leave the live
        // transcript untouched, which is exactly how a whole page stayed unfolded.
        const column = flowColumn(scope.anchor)
        if (column === null) return
        if (observer === null || observerColumn !== column) watch(column)
        autoScroll.watchReader()
        running = true
        try {
          const next = runPass(column, scope.nodeAt)
          // The scroll is decided from the same pass the fold is applied in, so it
          // measures a column that already has its final geometry.
          autoScroll.onPublication(next, column)
          if (samePublication(published, next)) return
          published = next
          for (const listener of [...listeners]) {
            try {
              listener(next)
            } catch (error) {
              console.error('dsh-fold-it-up: a disclosure row failed to update', error)
            }
          }
        } catch (error) {
          console.error(`dsh-fold-it-up: fold pass failed (${reason})`, error)
        } finally {
          running = false
        }
      }

      const schedule = () => {
        scheduled ??= requestAnimationFrame(() => {
          scheduled = null
          run('frame')
        })
      }

      const watch = (column) => {
        observer?.disconnect()
        observer = null
        observerColumn = null
        if (typeof MutationObserver !== 'function') return
        // A committed page is the one change React never tells a disclosure row
        // about: the prepended turns may mount their own rows in a commit that does
        // not re-render this one. Watching the transcript itself is what makes the
        // fold follow the DOM instead of the store.
        observer = new MutationObserver(() => { schedule() })
        observer.observe(column, { childList: true, subtree: true })
        observerColumn = column
      }

      return {
        /** @param listener - publication callback. @returns unsubscribe. */
        subscribe(listener) {
          listeners.add(listener)
          return () => { listeners.delete(listener) }
        },
        /**
         * Point the controller at one live element of the transcript it folds.
         *
         * The caller passes a STABLE anchor — a seat wrapper, which React keeps for
         * as long as the transcript does — because the column is resolved from it on
         * every pass. That makes a remounted transcript self-correcting: the next
         * pass resolves the new column instead of writing to the detached one.
         * @param anchor - a live element inside the transcript.
         * @param nodeAt - reader for one node key.
         */
        bind(anchor, nodeAt) {
          if (scope !== null && scope.anchor === anchor) {
            scope.nodeAt = nodeAt
            return
          }
          scope = { anchor, nodeAt }
          schedule()
        },
        /** The last published pass. */
        get publication() {
          return published
        },
        /**
         * A disclosure toggled.
         *
         * The pass is deliberately deferred to the next frame rather than run here:
         * the expansion lives on the row's own `data-open`, and React has not
         * committed that attribute yet when the click handler returns. Reading it
         * synchronously would re-apply the OLD state and pin the fold shut.
         */
        notify() {
          schedule()
        },
        /** Request one fold pass on the next animation frame. */
        schedule,
        /** Run the pass synchronously (probes and tests use this). */
        flush() {
          run('flush')
        },
      }
    }

    /**
     * Whether two publications describe the same disclosure state.
     * @param left - previous publication.
     * @param right - next publication.
     * @returns whether every turn's fold state is unchanged.
     */
    function samePublication(left, right) {
      if (left.turns.size !== right.turns.size) return false
      for (const [turn, decision] of right.turns) {
        const previous = left.turns.get(turn)
        if (previous === undefined) return false
        if (previous.foldable !== decision.foldable) return false
        if (previous.closed !== decision.closed) return false
        if (previous.open !== decision.open) return false
        if (previous.hidden !== decision.hidden) return false
      }
      return true
    }

    const ControllerContext = React.createContext(null)

    /**
     * The publication a row renders before any pass has run. `useSyncExternalStore`
     * compares snapshots by identity on every render, so this must be one stable
     * object rather than a fresh literal.
     */
    const EMPTY_PUBLICATION = { turns: new Map() }

    /**
     * Own one controller for its subtree and hand it to every disclosure row.
     * @param props.children - the conversation subtree.
     * @param props.controller - the controller instance.
     * @returns the provider element.
     */
    function ControllerProvider({ children, controller }) {
      return React.createElement(ControllerContext.Provider, { value: controller }, children)
    }

    /**
     * The DOM operations one fold pass performs, in the shape `foldColumn$1` expects.
     *
     * Keeping them here is what lets the pass itself live in `logic.js` and be
     * exercised without a browser.
     */
    const PASS_OPS = {
      /**
       * Record the Turn whose disclosure governs the row, for probes and
       * diagnostics. For an injected-context row this is the whole point: the seat
       * names no Turn of its own, so this stamp is the only place the re-parenting
       * decision is legible from the DOM.
       * @param element - the flow item.
       * @param turn - the owning Turn number.
       */
      setTurn(element, turn) {
        element.dataset.folditupTurn = String(turn)
      },
      /**
       * Record the store's sort position on the row, for probes and diagnostics.
       * @param element - the flow item.
       * @param seq - the row's sort position, or null.
       */
      stamp(element, seq) {
        if (seq === null || seq === undefined) delete element.dataset.folditupSeq
        else element.dataset.folditupSeq = String(seq)
      },
      /**
       * Apply or release one row's hidden state.
       *
       * The shipped owner writes the same `hidden` attribute on its own re-renders,
       * so this both applies and releases it and never caches a decision: the desired
       * state is recomputed on every pass, which is what makes the two writers
       * converge instead of fighting.
       * @param element - the flow item.
       * @param hidden - whether the row must be hidden.
       */
      setHidden(element, hidden) {
        if (hidden) {
          if (element.getAttribute('hidden') !== 'until-found') {
            element.setAttribute('hidden', 'until-found')
          }
          return
        }
        if (element.hasAttribute('hidden')) {
          element.hidden = false
          element.removeAttribute('hidden')
        }
      },
      /**
       * Mark the one row that must stay readable, for probes and the seam styling.
       * @param element - the flow item.
       * @param answer - whether this row is the Turn's answer.
       */
      setAnswer(element, answer) {
        if (answer) element.dataset.foldItUpAnswer = '1'
        else delete element.dataset.foldItUpAnswer
      },
    }

    /**
     * Fold one whole column and apply the result to its rows.
     * @param column - the element holding the flow items.
     * @param nodeAt - reader for one node key.
     * @returns the publication `{ turns: Map<number, decision> }`.
     */
    function runPass(column, nodeAt) {
      const { turns, counted } = foldColumn$1(column, nodeAt, PASS_OPS)
      probe({ kind: 'pass', ...counted, turns: turns.size })
      return { turns }
    }

    /**
     * The seat wrapper that holds one rendered element.
     *
     * The seat outlives everything rendered inside it, which is what a controller
     * anchor needs: a disclosure row that folds away renders nothing, so anchoring
     * to the row itself would lose the handle exactly when the fold succeeds.
     * @param element - any element inside a seat, or null.
     * @returns the nearest seat wrapper, or null.
     */
    function seatOf(element) {
      let node = element
      for (let depth = 0; node !== null && depth < 6; depth += 1) {
        if (node.hasAttribute?.('data-chat-flow-kind')) return node
        node = node.parentElement
      }
      return null
    }

    /**
     * Resolve the flow column that holds this row.
     *
     * Each Chat row is wrapped in its own seat element, so the row's own parent
     * holds exactly one flow item; the column is the first ancestor that holds more
     * than one, which is also the element the shipped hiding rules key their column
     * rhythm off.
     * @param element - any element inside the transcript.
     * @returns the flow column, or null before the transcript is mounted.
     */
    function flowColumn(element) {
      let node = element.parentElement
      for (let depth = 0; node !== null && depth < 6; depth += 1) {
        if (node.querySelectorAll('[data-chat-flow-kind]').length > 1) return node
        node = node.parentElement
      }
      return null
    }

    /**
     * One transcript's identity, as stable text.
     *
     * The fold controller resolves its column from the anchor on every pass, and
     * that element can be replaced by a re-render without the conversation changing.
     * A session switch, by contrast, always changes the oldest turn number the
     * window holds, or the first rendered key. Auto-scroll uses this as its "is this
     * the same history" test, because a column ELEMENT is the wrong question to ask:
     * measured live, treating a column identity change as a new history silently ate
     * the close transition about half the time.
     *
     * Only these two marks: anything that grows as the transcript does (a row count,
     * a per-turn tally) would make every pass look like a new history.
     * @param column - the flow column.
     * @returns a signature string, or null when the column has no rows yet.
     */
    function transcriptSignature(column) {
      let lowest = null
      let sample = null
      for (const element of column.querySelectorAll('[data-chat-flow-kind]')) {
        const turn = Number(element.getAttribute('data-chat-turn'))
        if (Number.isSafeInteger(turn)) lowest = lowest === null ? turn : Math.min(lowest, turn)
        if (sample === null) sample = element.getAttribute('data-chat-anchor-key')
      }
      return `${String(lowest)}|${String(sample)}`
    }

    /**
     * The element that actually scrolls the transcript.
     *
     * `ChatView` delegates to an enclosing `[data-conversation-scroll]` when the
     * conversation host provides one, and otherwise owns the scroll itself
     * (`scrollerOf` in the shipped view). Measured live, the host attribute is
     * present, so that branch is the normal path and it is tried first; the walk up
     * from the column is the fallback for a layout without the host.
     * @param column - the flow column.
     * @returns the scroller, or null when nothing scrolls this transcript.
     */
    function scrollPortOf(column) {
      const host = column.closest('[data-conversation-scroll]')
      if (host !== null) return host
      let node = column
      while (node !== null && node !== document.body) {
        const style = getComputedStyle(node)
        if (style.overflowY === 'auto' || style.overflowY === 'scroll') return node
        node = node.parentElement
      }
      return null
    }

    /**
     * The question row of one Turn: the last question at or below this Turn number.
     *
     * The question is a `user` kind, and a turn-less row never matches, so the
     * search can only land on a real question. The "last at or below" shape covers
     * the one case where a Turn carried no question of its own.
     * @param column - the flow column.
     * @param turn - the Turn number.
     * @returns the question seat wrapper, or null.
     */
    function questionSeat(column, turn) {
      let found = null
      for (const element of column.querySelectorAll('[data-chat-flow-kind="user"]')) {
        const owner = Number(element.getAttribute('data-chat-turn'))
        if (!Number.isSafeInteger(owner) || owner > turn) continue
        found = element
      }
      return found
    }

    /**
     * Whether auto-scrolling is switched off for this browser.
     * @returns whether the reader asked for no automatic scrolling.
     */
    function autoScrollDisabled() {
      try {
        return globalThis.localStorage?.getItem(SCROLL_KEY) === 'off'
      } catch {
        // A blocked storage means no opt-out, which is the default state anyway.
        return false
      }
    }

    /**
     * Carry the reader to the top of the question whose answer just finished.
     *
     * The controller calls this once per fold pass with the Turn states before and
     * after that pass, and it decides from those two states plus live geometry. It
     * owns three things a pass cannot: the reader's own gestures (so a turn closing
     * never interrupts someone scrolling back), the one-shot nature of "this Turn
     * just closed", and the transcript's identity — see `transcriptSignature` for
     * why the last one is a signature rather than the live column element.
     * @returns `{ onPublication, watchReader, forget }`.
     */
    function createAutoScroll() {
      /** When the reader last moved the view themselves; 0 = not yet this document. */
      let lastReaderGestureAt = 0
      /** Publication the previous pass produced, for edge detection. */
      let previous = null
      /** Signature of the transcript `previous` describes. */
      let signature = null
      /** Whether the next pass is the first look at this transcript. */
      let baseline = true
      /** The Turn number the last noticed close scrolled for, to keep it one-shot. */
      let scrolledTurn = null
      /** The deferred scroll still owed to a Turn, so a remount can drop it. */
      let pendingFrame = null
      /** Whether the reader listens on the document already. */
      let watching = false

      const noteGesture = () => { lastReaderGestureAt = performance.now() }

      /**
       * Measure the settled transcript and move the view.
       *
       * Everything is read here rather than at detection time: the scroller, the
       * question row and the offset are all properties of the layout as it stands
       * once the fold has been applied, which is exactly one frame after the pass
       * that decided it.
       *
       * The write is INSTANT, and then VERIFIED on the following frame. Both halves
       * are load-bearing:
       *
       *   - animated scrolling loses a race it cannot see. The app follows the flow
       *     tip itself when a turn closes, so two scroll animations would be alive at
       *     once, and measured live the plugin's write was recorded
       *     (`from 1993 to 56`) while the view stayed on the floor — landing in one
       *     run and not in the next. An assignment has no animation to lose;
       *   - the follow-up frame catches the case where the app's own write lands
       *     after ours. It re-measures, and only writes again if the question is
       *     really somewhere else. A reader gesture in the meantime cancels it: the
       *     correction is a repair, never a fight with the person scrolling.
       * @param candidate - `{ turn, before }` for the Turn that closed.
       * @param column - the flow column the pass read.
       * @param verify - whether this call is the follow-up frame.
       */
      const write = (candidate, column, verify = false) => {
        pendingFrame = null
        const scroller = scrollPortOf(column)
        const question = questionSeat(column, candidate.turn)
        if (scroller === null || question === null) {
          if (!verify) {
            probe({ kind: 'scroll', turn: candidate.turn, skipped: scroller === null ? 'no-scroller' : 'no-question' })
          }
          return
        }
        // Read BEFORE writing: a `scrollTop` sampled after the assignment reports the
        // destination, which makes the record of a scroll read `from 56 to 56`.
        const from = Math.round(scroller.scrollTop)
        const port = scroller.getBoundingClientRect()
        const target = autoScrollTarget$0(
          { closed: true, wasOpen: candidate.before?.open === true },
          {
            scrollTop: scroller.scrollTop,
            floor: Math.max(0, scroller.scrollHeight - scroller.clientHeight),
            questionTop: question.getBoundingClientRect().top - port.top,
          },
        )
        if (target === null) {
          // On the verification frame an aligned question is the expected outcome,
          // not a decision worth recording twice.
          if (!verify) probe({ kind: 'scroll', turn: candidate.turn, skipped: 'no-op' })
          return
        }
        if (verify && performance.now() - lastReaderGestureAt < READER_GRACE_MS) {
          probe({ kind: 'scroll', turn: candidate.turn, skipped: 'reader-gesture' })
          return
        }
        // Instant: see above, and it is also why this bundle never has to consult
        // `prefers-reduced-motion` for the correctness of the move.
        scroller.scrollTop = target.top
        probe({
          kind: 'scroll',
          turn: candidate.turn,
          verify,
          from,
          to: Math.round(target.top),
          landed: Math.round(scroller.scrollTop),
        })
        if (!verify && typeof requestAnimationFrame === 'function') {
          pendingFrame = requestAnimationFrame(() => { write(candidate, column, true) })
        }
      }

      return {
        /**
         * React to one published fold state.
         *
         * The controller passes the transcript's signature alongside the states, so
         * this can tell "a new history" from "the same history, re-rendered".
         * @param publication - `{ turns: Map<number, decision> }`.
         * @param column - the flow column this pass read.
         */
        onPublication(publication, column) {
          const turns = publication?.turns ?? new Map()
          const current = column === null || column === undefined ? null : transcriptSignature(column)
          if (current !== null && current !== signature) {
            // A different history: nothing on it is an event the reader just lived
            // through, so the first look is a baseline and the scroll still owed for
            // the old transcript (whose column is on its way out) is dropped.
            if (pendingFrame !== null && typeof cancelAnimationFrame === 'function') {
              cancelAnimationFrame(pendingFrame)
            }
            pendingFrame = null
            signature = current
            baseline = true
          }
          if (baseline) {
            // Nothing before the first pass of a transcript is an event: a session
            // that opens with finished turns (history, a switch) must not scroll.
            baseline = false
            previous = turns
            return
          }
          let candidate = null
          for (const [turn, decision] of turns) {
            const before = previous.get(turn)
            if (decision.closed !== true) continue
            if (before !== undefined && before.closed === true) continue
            candidate = { turn, decision, before }
          }
          previous = turns
          if (candidate === null) return
          probe({ kind: 'scroll', turn: candidate.turn, noticed: true })
          // Noticed is consumed, whatever comes of it: a Turn closes exactly once,
          // so a reader gesture or a disabled setting must not leave the decision
          // armed for the next pass to act on a few hundred milliseconds later.
          if (candidate.turn === scrolledTurn) return
          scrolledTurn = candidate.turn
          if (autoScrollDisabled()) return
          if (performance.now() - lastReaderGestureAt < READER_GRACE_MS) {
            probe({ kind: 'scroll', turn: candidate.turn, skipped: 'reader-gesture' })
            return
          }
          if (column === null) return
          // The scroll is DEFERRED by one frame, and that is not a detail.
          //
          // This call happens inside a React layout effect, in the same frame the
          // fold is applying its own layout change. Measured live, a smooth scroll
          // started in that frame never arrived: the plugin recorded
          // `from 1992 to 56`, and the next sample found the view back at the floor.
          // A scroll animation runs while the browser is still settling the fold's
          // height change, so the delivered position is corrected out from under it.
          // Waiting one frame lets the geometry be final; the target is then
          // measured and written from that final state.
          if (typeof requestAnimationFrame === 'function') {
            pendingFrame = requestAnimationFrame(() => { write(candidate, column) })
            return
          }
          write(candidate, column)
        },
        /**
         * Start noticing the reader's own scroll gestures.
         *
         * `passive` throughout: this observer must never be able to delay the
         * gesture it is watching for.
         */
        watchReader() {
          if (watching) return
          watching = true
          for (const type of ['wheel', 'touchstart', 'pointerdown', 'keydown']) {
            document.addEventListener(type, noteGesture, { passive: true, capture: true })
          }
        },
      }
    }

    /** One element per disclosure, so the row can be anchored without a ref prop. */
    const RowHost = React.memo(function RowHost({ children, anchorRef }) {
      return React.createElement('div', {
        // A callback ref, not a ref object: `ref` as an ordinary prop is a recent
        // React behaviour, and this element must be reachable on every version the
        // page could be running.
        ref: anchorRef,
        'data-fold-it-up-anchor': '',
      }, children)
    })

    /**
     * One turn's disclosure row, and the DOM owner of that turn's hidden range.
     *
     * The row itself is the SHIPPED disclosure renderer, compiled at runtime from
     * the source map the page already downloaded. That keeps the label wording, the
     * theme styling and the geometry identical to the product instead of imitating
     * them; `fallbackRow` takes over if that source is ever unavailable.
     *
     * The owner decides nothing here. Rows are read from the rendered column in the
     * same pass that applies the result, because a Chat store snapshot and the DOM
     * can disagree while a page is being prepended — see `logic.js`.
     * @param props.node - the `turn-process` Chat node.
     * @param props.useChat - chat snapshot selector hook (entry-injected).
     * @param props.useStore - this plugin's own disclosure store (entry-declared).
     * @param props.actions - that store's bound actions.
     * @param props.t - locale seat for the shipped renderer's labels.
     * @returns the disclosure row, or an inert anchor when the turn is not folded.
     */
    function FoldRow({ node, useChat, useStore, actions, t }) {
      const controller = React.useContext(ControllerContext)
      const nodes = useChat(snapshot => snapshot.nodes)
      const storedEntry = useStore(state => (state.turnProcesses ?? [])
        .find(candidate => candidate.turn === node.data.turn))
      // The row renders from the published pass, which is the same decision that
      // wrote the DOM. `useSyncExternalStore` keeps it in step without the pass
      // having to write React state from inside a layout effect.
      const published = React.useSyncExternalStore(
        React.useCallback(
          listener => (controller === null ? () => {} : controller.subscribe(listener)),
          [controller],
        ),
        React.useCallback(
          () => (controller === null ? EMPTY_PUBLICATION : controller.publication),
          [controller],
        ),
      )
      const anchorRef = React.useRef(null)
      const Row = useDisclosureRow()
      const turn = node.data.turn
      const record = published.turns.get(turn) ?? null
      const visible = record !== null && record.foldable
      const open = storedEntry !== undefined

      // Point the controller at the seat this row lives in. The seat outlives the
      // disclosure — a folded row renders its anchor alone — so the controller keeps
      // a live handle on the transcript across every commit and remount, and the
      // pass always reads the column as it stands right now.
      React.useLayoutEffect(() => {
        if (controller === null) return
        const seat = seatOf(anchorRef.current)
        if (seat === null) return
        controller.bind(seat, key => nodes.get(key))
        controller.flush()
      })

      const owner = {
        spec: { turn, processStartSeq: null, answerStep: null, answerAnchorSeq: null, open },
        foldable: true,
        open,
        setOpen: (next) => {
          // `actions` is the framework's binding of the SAME store instance the
          // `useStore` seat reads, so a write here re-renders this row.
          actions.setTurnProcessOpen(turn, null, next)
          controller.notify()
        },
      }

      // The anchor is rendered in BOTH states, so the row can bootstrap: the first
      // pass runs before anything is known about this turn, and the row only appears
      // once that pass says it should. It is also the element the controller anchors
      // to, which is why it cannot be the row itself — a folded row has no row.
      const row = visible
        ? (Row === null
          ? fallbackRow({ node, turnProcess: owner })
          : React.createElement(Row, { node, turnProcess: owner, useStore, useChat, t }))
        : null
      return React.createElement(
        RowHost,
        { anchorRef: (element) => { anchorRef.current = element } },
        row,
      )
    }

    /**
     * The shipped disclosure row, compiled once from the page's own source map.
     *
     * Reusing the product's renderer keeps the label wording (locale keys already
     * registered by the Chat package), the theme tokens and the geometry exact; the
     * compiled module only ever produces this one keyed cell.
     * @returns the shipped renderer, or null when its source is unavailable.
     */
    function useDisclosureRow() {
      const [Row, setRow] = React.useState(() => compiledRow)
      React.useEffect(() => {
        if (compiledRow !== null || compiling) return undefined
        compiling = true
        void compileDisclosureRow().then((component) => {
          if (component !== null) {
            compiledRow = component
            setRow(() => component)
          }
        })
        return undefined
      }, [Row])
      return Row
    }

    /** Cache of the compiled shipped renderer; null until (or unless) it resolves. */
    let compiledRow = null
    /** Whether a compile attempt is already in flight. */
    let compiling = false

    /**
     * Record one lifecycle fact where a page probe can read it.
     *
     * A shadowed renderer is invisible when it declines: the row simply renders
     * nothing, exactly like a turn with no process. This trace is how a human (or
     * `tools/verify-live.mjs`) tells "never mounted" from "mounted and declined".
     * @param event - one structured trace entry.
     */
    function probe(event) {
      const global = globalThis
      const trace = global.__FOLDITUP__ ?? (global.__FOLDITUP__ = { events: [] })
      trace.events.push(event)
      if (trace.events.length > 200) trace.events.shift()
    }

    /** Whether the shipped row compiled. */
    function probeCompiled(ok) {
      probe({ kind: 'row', compiled: ok })
    }

    /**
     * Compile the shipped `TurnProcessNodeView` out of the Chat package's source map.
     *
     * The bundle ships `sourcesContent`, so the component's own source is fetched
     * from the same origin the page already trusts; only the two imports and the CSS
     * module default are rewritten, and the type-only import is dropped.
     * @returns the compiled component, or null when the source or transform fails.
     */
    async function compileDisclosureRow() {
      try {
        const script = [...document.querySelectorAll('script[src]')]
          .map(element => element.getAttribute('src') ?? '')
          .find(src => src.includes(`${CHAT_PACKAGE}/client.js`))
        if (script === undefined) return null
        const url = new URL(script, globalThis.location.href)
        url.pathname += '.map'
        const response = await fetch(url.href)
        if (!response.ok) return null
        const map = await response.json()
        const index = map.sources.findIndex(source => typeof source === 'string'
          && source.endsWith('/TurnProcessNodeView.tsx'))
        if (index < 0 || typeof map.sourcesContent?.[index] !== 'string') return null
        const body = compileRowSource(map.sourcesContent[index])
        if (body === null) return null
        // eslint-disable-next-line no-new-func -- the page's own source, fetched from its own origin
        const factory = new Function(
          'React',
          'IconChevronDownOutline14',
          'css',
          'exports',
          `${body}\nreturn typeof TurnProcessNodeView === 'function' ? TurnProcessNodeView : null`,
        )
        const component = factory(
          React,
          IconChevronDownOutline14,
          ROW_CLASSES,
          {},
        )
        const usable = typeof component === 'function'
        probeCompiled(usable)
        return usable ? component : null
      } catch (error) {
        probeCompiled(false)
        console.warn('dsh-fold-it-up: shipped disclosure row unavailable, using the built-in one', error)
        return null
      }
    }

    /**
     * Rewrite the shipped view's module syntax for direct evaluation.
     * @param source - `TurnProcessNodeView.tsx` source from the source map.
     * @returns the rewritten body, or null when the shape is not the expected one.
     */
    function compileRowSource(source) {
      const body = source
        .replace(/^import \{[^}]*\} from 'react'\n/mu, 'const { memo } = React\n')
        .replace(
          /^import \{ IconChevronDownOutline14 \} from '[^']*ui-primitives'\n/mu,
          '/* icon injected */\n',
        )
        .replace(/^import type [^\n]*\n/mu, '')
        .replace(/^import css from [^\n]*\n/mu, '/* css injected */\n')
      if (!/export const TurnProcessNodeView\b/u.test(body)) return null
      return body.replace(/^export const TurnProcessNodeView\b/mu, 'const TurnProcessNodeView')
    }

    /** Fallback disclosure classes: the shipped stylesheet's own module names. */const ROW_CLASSES = {
      root: 'jUC0fW_root',
      label: 'jUC0fW_label',
      chevron: 'jUC0fW_chevron',
    }

    /**
     * Built-in disclosure row, used only when the shipped source could not be
     * compiled. Markup and class names mirror the shipped view.
     * @param props.node - the `turn-process` Chat node.
     * @param props.turnProcess - disclosure owner state.
     * @returns the row element.
     */
    function fallbackRow({ node, turnProcess }) {
      const strings_ = strings()
      const data = node.data
      const parts = []
      if (data.toolCallCount > 0) parts.push(strings_.toolCalls(data.toolCallCount))
      if (data.messageCount > 0) parts.push(strings_.messages(data.messageCount))
      if (data.subagentCount > 0) parts.push(strings_.subagents(data.subagentCount))
      const label = parts.length === 0 ? strings_.thought : parts.join(' · ')
      const open = turnProcess.open
      return React.createElement(
        'button',
        {
          type: 'button',
          className: ROW_CLASSES.root,
          'data-fold-it-up-row': 'fallback',
          'data-open': open ? '' : undefined,
          'data-turn-process': data.turn,
          'data-turn-process-messages': data.messageCount,
          'data-turn-process-tool-calls': data.toolCallCount,
          'data-turn-process-subagents': data.subagentCount,
          'aria-expanded': open,
          onClick: (event) => {
            event.currentTarget.focus()
            turnProcess.setOpen(!open)
          },
        },
        React.createElement('span', { className: ROW_CLASSES.label }, label),
        React.createElement(
          'svg',
          {
            className: ROW_CLASSES.chevron,
            width: 14,
            height: 14,
            viewBox: '0 0 14 14',
            fill: 'none',
            xmlns: 'http://www.w3.org/2000/svg',
            'aria-hidden': 'true',
          },
          React.createElement('path', {
            d: 'M11.8486 5.5L11.4238 5.92383L8.69727 8.65137C8.44157 8.90706 8.21562 9.13382 8.01172 9.29785C7.79912 9.46883 7.55595 9.61756 7.25 9.66602C7.08435 9.69222 6.91565 9.69222 6.75 9.66602C6.44405 9.61756 6.20088 9.46883 5.98828 9.29785C5.78438 9.13382 5.55843 8.90706 5.30273 8.65137L2.57617 5.92383L2.15137 5.5L3 4.65137L3.42383 5.07617L6.15137 7.80273C6.42595 8.07732 6.59876 8.24849 6.74023 8.3623C6.87291 8.46904 6.92272 8.47813 6.9375 8.48047C6.97895 8.48703 7.02105 8.48703 7.0625 8.48047C7.07728 8.47813 7.12709 8.46904 7.25977 8.3623C7.40124 8.24849 7.57405 8.07732 7.84863 7.80273L10.5762 5.07617L11 4.65137L11.8486 5.5Z',
            fill: 'currentColor',
          }),
        ),
      )
    }

    /**
     * Build the entry-injected faces for one session.
     *
     * The slot's shipped declaration injects only `useTurnData`; `useChat` reaches
     * the shipped Chat view through a service call, so this plugin binds the same
     * observable for its own entry.
     * @param ctx - client root context.
     * @param sessionId - the rendering session.
     * @returns the entry's inject face.
     */
    function chatFace(ctx, sessionId) {
      return {
        hooks: {},
        keyedHooks: {},
        useChat: createSourceHook(() => chatSource(ctx, sessionId)),
      }
    }

    /** Subscribe no-op for a source that never resolved. */
    const NO_SUBSCRIBE = () => () => {}
    /** Ref sentinel: distinguishes "no memo yet" from a memoized `undefined`. */
    const UNSET = Symbol('dsh-fold-it-up.unset')

    /**
     * Bind one observable source to an identity-stable selector hook, mirroring the
     * renderer's own `observableHook`.
     *
     * `useSyncExternalStore` requires a reference-stable snapshot between real
     * changes, so the selected value is memoized on the source snapshot identity
     * and a fresh source object is produced whenever the session binding changes.
     * @param getSource - resolves the observable source for the current binding.
     * @returns a selector hook; an unresolved binding yields `undefined`.
     */
    function createSourceHook(getSource) {
      return function useSelector(selector) {
        // Read the source on every render: React re-reads the snapshot during
        // render, so a swapped binding is picked up without a remount.
        const source = getSource()
        const subscribe = React.useCallback(
          listener => (source === undefined ? NO_SUBSCRIBE() : source.subscribe(listener)),
          [source],
        )
        const read = React.useCallback(
          () => (source === undefined ? undefined : source.getSnapshot()),
          [source],
        )
        const snapshot = React.useSyncExternalStore(subscribe, read)
        const cached = React.useRef(UNSET)
        if (cached.current === UNSET || cached.current.snapshot !== snapshot) {
          cached.current = {
            snapshot,
            value: snapshot === undefined ? undefined : selector(snapshot),
          }
        }
        return cached.current.value
      }
    }

    /**
     * Resolve the session's chat target once per inject face.
     * @param ctx - client root context.
     * @param sessionId - the rendering session.
     * @returns the chat snapshot source, or undefined before the binding exists.
     */
    function chatSource(ctx, sessionId) {
      let binding
      try {
        binding = ctx.uiConversation.binding(sessionId)
      } catch {
        // An unknown session renders no chat target yet; the hook stays absent
        // until the next inject evaluation binds a real one.
        binding = undefined
      }
      const target = binding?.target?.('chat')
      if (target === undefined) return undefined
      return {
        getSnapshot: () => target.getSnapshot(),
        subscribe: listener => target.subscribe(listener),
      }
    }

    /** Required services: the slot seat, the locale seat, and the Chat binding. */
    const inject = ['slots', 'locale', 'uiConversation']

    /** Stable Cordis plugin name. */
    const name = PACKAGE

    /**
     * Mount the disclosure takeover.
     *
     * Cordis resolves a module plugin by reading `apply` off the module namespace,
     * which is why this module exports `apply` directly instead of wrapping it.
     * @param ctx - client root context.
     */
    function apply(ctx) {
      // One controller per plugin mount: expansion state outlives every turn and
      // the per-session Chat view the rows render in.
      const controller = createController()
      ctx.effect(() => {
        const style = insertStyles()
        return () => { style.remove() }
      }, 'dsh-fold-it-up: styles')
      ctx.effect(() => ctx.slots.inject('conversation.chat.node', () => {
        try {
          const dispose = ctx.slots.register(
            {
              name: 'conversation.chat.node',
              key: 'turn-process',
              // Shipped entries sit at priority 0, and the LOWEST priority wins a cell.
              priority: -1,
              // The Chat namespace is already registered by the package that owns
              // the row this entry replaces, so the shipped labels keep working.
              locale: CHAT_NS,
              store: createDisclosureStore,
              inject: sessionId => chatFace(ctx, sessionId),
            },
            props => React.createElement(
              ControllerProvider,
              { controller },
              React.createElement(FoldRow, props),
            ),
          )
          // A registration that never took the cell is indistinguishable from a
          // working one at the surface, so say so where a person can see it.
          const won = (ctx.slots.entriesOfSlot?.('conversation.chat.node') ?? [])
            .some(entry => entry.options?.key === 'turn-process' && entry.options?.priority === -1)
          probe({ kind: 'register', won, entries: ctx.slots.entriesOfSlot?.('conversation.chat.node')?.length ?? -1 })
          if (!won) console.error('dsh-fold-it-up: registration did not win the turn-process cell')
          return dispose
        } catch (error) {
          probe({ kind: 'register', error: error instanceof Error ? error.message : String(error) })
          console.error('dsh-fold-it-up: could not register the turn-process disclosure', error)
          throw error
        }
      }), 'dsh-fold-it-up: turn-process disclosure')
    }
    const __module0 = { exports: { createController, inject, name, apply } }
    return __module0.exports;
  },
});
