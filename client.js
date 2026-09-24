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
     * closed. The LAST closing row in the group is where its process ends, so
     * everything above that row is work and the notice — with anything rendered
     * below it — stays readable, no row stamped as the answer. A closing row that
     * sits ABOVE a prose step keeps the same meaning: prose the Turn never finalized
     * is not its answer, and the notice still bounds the fold. Only a group with no
     * closing row at all falls back to the whole range, which is the interrupted
     * Turn whose work still belongs behind the disclosure.
     *
     * LAST, NOT FIRST, BECAUSE THE FOOTER CAN LAND MID-TURN
     *
     * The two failure notices are anchored on `turn/end`'s own seq and are therefore
     * always the true end of their Turn. `turn-tail` is not: its anchor is
     * synthesized as "the last message carrying text, +0.1", and a Turn whose model
     * keeps calling tools after a visible message renders that footer in the MIDDLE
     * of its own work. Measured live on turn 10, the rendered order was
     *
     *   user / control / context x3 / assistant-step(903) / turn-tail(903.1)
     *   / tool-call x4 (904-911) / context x2 (916, 917) / turn-error(920)
     *
     * so bounding the fold at the first closing row stopped it at the footer and
     * left four tool calls and two injected-context rows of the same Turn visible —
     * while the Turn still reported itself folded. Taking the last closing row
     * bounds the fold at the notice, which is where the work really ended. Nothing
     * changes for a Turn whose only closing row is that footer: last and first are
     * the same row, and everything below it keeps staying readable.
     *
     * INJECTED CONTEXT BELONGS TO THE TURN IT WAS INJECTED FOR
     *
     * Every other kind of work the model was fed carries its Turn in the seat's own
     * `data-chat-turn` and folds by it. Injected context arrives in two shapes, and
     * both must fold with the Turn they were injected for:
     *
     *   - a Turn-less `context` node — its Location is unresolved (its
     *     `user/message` event carries no `turn`), so its seat renders
     *     `data-chat-turn="null"` and it joins no group at all. Measured live, that
     *     is exactly why those rows stayed on screen while the work beside them
     *     folded — they were not "excluded", they were never part of any decision.
     *
     *   - a Turn-bearing `context` node — measured live on turn 8, the injection
     *     event precedes the control anchor, so the seat names the Turn it was
     *     injected for (`data-chat-turn="8"`) while its store seq (593) sits BELOW
     *     the published `processStartSeq` (595.9). It belongs to the Turn it names
     *     outright, with no re-parenting involved, and still the published sequence
     *     range cannot reach it: the range opens above it.
     *
     * `groupSeats` therefore assigns each Turn-less `context` row to the Turn its
     * row precedes, which is the Turn it was injected for: a context row sits above
     * the Turn it opened. A trailing context row with no Turn below it stays with
     * the preceding Turn. A Turn-bearing context row needs no such rule — it is
     * already in the group whose Turn it names.
     *
     * Joining a group and joining the hide set are two different questions, and for
     * injected context the second one is answered by KIND, never by position:
     * `isContextRow` admits both shapes, so the marks channel hides a context row
     * the seat never marked, and the sequence channel hides one whose seq falls
     * below `processStartSeq`. That is enough for the hide set, because a row is
     * only ever hidden when it precedes the Turn's answer, and the answer always
     * belongs to the Turn itself.
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
     * The kind of injected-context row that folds with the Turn it was injected for.
     *
     * Two shapes of it exist. A `context` row may be Turn-less — its Location is
     * unresolved, so it has no Turn of its own and `groupSeats` re-parents it by
     * position onto the Turn its row precedes — or it may already name the Turn it
     * was injected for, in which case that Turn is its own. Both fold with that
     * Turn, and both are admitted by `isContextRow` rather than by any position.
     *
     * Deliberately narrow: every other kind still folds by its own seat's Turn, and
     * no other kind reaches the hidden set without an owning Turn or a member mark.
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
     * Whether one rendered row is injected context that belongs to a Turn's fold.
     *
     * Two shapes exist, and both are the graph-memory injector's own doing: a
     * context row whose Location is unresolved (no Turn attribute at all), and a
     * context row that NAMES the Turn it was injected for — an injection event that
     * precedes the control anchor lands its seq BELOW `processStartSeq`, so the
     * sequence range can never reach it on its own. For either shape the group it
     * renders in is the statement that it belongs to that Turn's process.
     *
     * Membership marks are deliberately not consulted: the shipped seat only marks
     * rows once its own window gate opens, and these rows are the ones that need the
     * fold most while that gate is shut.
     * @param row - plain row descriptor.
     * @returns whether the row is an injected-context row the fold may hide.
     */
    function isContextRow(row) {
      return row.kind === CONTEXT_KIND
    }

    /**
     * The Turn number one rendered seat wrapper names, when it names one.
     *
     * The attribute is read defensively because the seat renders `data-chat-turn`
     * from a possibly undefined Turn: React drops an undefined attribute but writes
     * the string "null" for a null one, and a seat that names no Turn either way must
     * fall through to the re-parenting rule rather than create a fictitious group.
     * A seat that does name one — injected context included, since the injector's
     * event precedes the control anchor yet still carries the Turn it was injected
     * for — is taken at its word.
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
     * seat does not mark because the window it marks never covered those rows, whose
     * injection precedes the control anchor — this module's own `isContextRow`.
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
     * has not described yet. A Turn-bearing injected-context row joins the group its
     * seat names, exactly like any other row. A Turn-less one names no Turn, and is
     * appended to the group of the Turn it precedes, which is the Turn it was
     * injected for; a trailing one stays with the Turn above it. Those rows are
     * flushed together with the next Turn-bearing seat, so DOM order survives the
     * re-parenting.
     *
     * Only injected context is re-parented. Any other Turn-less row is left out of
     * every group rather than credited to a Turn that never owned it.
     * @param column - the element holding the flow items.
     * @returns a Map from Turn number to that Turn's rows, in DOM order.
     */
    function groupSeats(column) {
      const groups = new Map()
      /** Turn-less injected-context rows still waiting for the Turn below them. */
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
     *
     * Which source is tried is decided by the SEAT'S OWN MEMBERSHIP MARKS, never by
     * an injected-context row: the shipped seat marks neither shape of it — a
     * Turn-less row belongs to no group it could mark, and a Turn-bearing one was
     * injected above the control anchor, outside the window it marks — so one context
     * row in a group is not a statement that the marks describe this range. It joins
     * the hidden set on either path; it never picks the path.
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

      const seatsMarked = rows.filter(row => row.member === true && !isIndependentKind(row.kind))
      const ranged = seatsMarked.length > 0 ? null : projectedRange(rows, fold)
      // The LAST closing row is where the Turn stopped being process. Both notices
      // are anchored on `turn/end`'s own seq, so a notice is always the real end of
      // the Turn — but the footer's anchor is synthesized from "the last message
      // carrying text, +0.1", which lands MID-TURN whenever the model keeps working
      // after a visible message. Measured live on turn 10, the footer sat above four
      // tool calls and two injected-context rows of its own Turn. Taking the first
      // closing row bounded the fold at that footer and left them all on screen;
      // taking the last bounds it at the notice below them, which is where the work
      // actually ended. A group that never closed on camera (the interrupted Turn)
      // has no such row, and there its whole range is work — so the fallback
      // boundary is the end of the group, not the start.
      const closing = rows.findLastIndex(row => CLOSING_KINDS.has(row.kind))
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
     * excepted, which is the geometry the shipped fold uses. Injected context is
     * admitted by KIND, without consulting its position: a Turn-less row resolves to
     * no sequence at all, and a Turn-bearing one was injected above the control
     * anchor, so its seq sits BELOW `processStartSeq` and the range would open above
     * it. The group it renders in is the statement that it belongs to this Turn's
     * process.
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
    const __module1 = { exports: { INDEPENDENT_KINDS, CONTEXT_KIND, CLOSING_KINDS, TURN_ATTRIBUTE, KIND_ATTRIBUTE, KEY_ATTRIBUTE, MEMBER_ATTRIBUTE, ROW_ATTRIBUTE, isIndependentKind, isContextRow, turnOfSeat, isProcessMember, isAnswerRow, rowOfSeat, groupSeats, effectiveTurns, attachNodeData, foldTurn, foldColumn } }

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
     *   - the row itself is the SHIPPED renderer, borrowed from the slot ledger
     *     the product registered it on (`StoredEntry.component`), so the wording,
     *     theme styling and geometry stay the product's rather than an imitation;
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
    const { foldColumn: foldColumn$0 } = __module1.exports
    /** Package name; also the module-table key this bundle registers under. */
    const PACKAGE = 'dsh-fold-it-up'

    /** The Chat package's locale namespace, for the shipped row's labels. */
    const CHAT_NS = 'chat'

    /**
     * Locale knob: `localStorage['dsh-fold-it-up.locale'] = 'en' | 'zh'`.
     * Only the built-in fallback row reads it; the shipped row uses `chat` keys.
     */
    const LOCALE_KEY = 'dsh-fold-it-up.locale'

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
    .dsh-fold-it-up-chevron {
      flex: none;
      width: 16px;
      height: 16px;
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
     * Create one disclosure controller for one session-scoped Chat view.
     *
     * It owns two things a per-row component cannot: one column-wide pass (reading
     * the rendered column is the expensive part, and N rows must not each repeat it)
     * and the published per-turn result every row renders from. The store above is
     * per session; the DOM and its passes belong to that same session's Chat view.
     * Keeping this boundary per session is required because DSH can render the main
     * conversation and a subagent conversation at the same time.
     *
     * Publication is deliberately not a React state write from inside the pass: the
     * pass already runs in a layout effect during commit, so it hands the result to
     * this controller and the controller's subscribers re-render. That keeps one
     * writer for the DOM and one source for what each row shows.
     * @returns the controller shared by disclosure rows in one session.
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
        running = true
        try {
          const next = runPass(column, scope.nodeAt)
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

      const releaseWhenIdle = () => {
        if (listeners.size !== 0) return
        if (scheduled !== null) {
          if (typeof cancelAnimationFrame === 'function') cancelAnimationFrame(scheduled)
          scheduled = null
        }
        observer?.disconnect()
        observer = null
        observerColumn = null
      }

      return {
        /** @param listener - publication callback. @returns unsubscribe. */
        subscribe(listener) {
          listeners.add(listener)
          if (scope !== null && observer === null) schedule()
          return () => {
            listeners.delete(listener)
            releaseWhenIdle()
          }
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
     * The DOM operations one fold pass performs, in the shape `foldColumn$0` expects.
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
      const { turns, counted } = foldColumn$0(column, nodeAt, PASS_OPS)
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
     * The row itself is the SHIPPED disclosure renderer, borrowed from the slot
     * ledger's stored entry — the component the Chat package registered on this
     * very key. That keeps the label wording, the theme styling and the geometry
     * identical to the product instead of imitating them, with its CSS-module
     * classes already bound; `fallbackRow` takes over if that entry is unreachable.
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
     * The shipped disclosure row, borrowed from the slot ledger.
     *
     * The Chat package registers its own `turn-process` component on the same key
     * this entry shadows, and the ledger keeps that component on its stored entry
     * (`StoredEntry.component`). Reading it there reuses the product's renderer —
     * its CSS-module classes already bound — without fetching or compiling
     * anything; `fallbackRow` takes over when the ledger cannot yield it.
     * @returns the shipped renderer, or null when the ledger does not hold it (yet).
     */
    function useDisclosureRow() {
      const [, bump] = React.useState(0)
      const Row = resolveShippedRow()
      React.useEffect(() => {
        // The shipped entry can register after this one, so a null answer is
        // retried briefly rather than freezing the fallback in place. The budget
        // is module state: one shared countdown, not one per row.
        if (Row !== null || rowRetries <= 0) return undefined
        rowRetries -= 1
        const timer = setTimeout(() => { bump(tick => tick + 1) }, 250)
        return () => { clearTimeout(timer) }
      })
      return Row
    }

    /** Cache of the shipped row read off the slot ledger; null until it resolves. */
    let shippedRow = null
    /** Shared retry budget while the shipped entry has not registered yet. */
    let rowRetries = 20
    /** Last row source reported to the probe, so a fallback-to-shipped swap is visible. */
    let rowSource = null
    /** The slot registry this entry registered on, captured at mount. */
    let ledger = null
    /** This entry's own component, so the ledger scan can skip it. */
    let ownRow = null

    /**
     * Resolve the product's own `turn-process` renderer out of the slot ledger.
     *
     * The shipped entry is found by its key and by NOT being this entry's own
     * component — neither a priority value nor a registrant name has to be assumed,
     * which is also what keeps this working when either changes.
     * @returns the shipped component, or null when the ledger does not hold it.
     */
    function resolveShippedRow() {
      if (shippedRow !== null) return shippedRow
      if (ledger === null) return null
      let entries
      try {
        entries = ledger.entriesOfSlot?.('conversation.chat.node') ?? []
      } catch {
        // An unreadable ledger is a fallback, not a crash.
        return null
      }
      for (const entry of entries) {
        const component = entry?.component
        if (component === undefined || component === null || component === ownRow) continue
        if (entry.options?.key !== 'turn-process') continue
        if (typeof component !== 'function' && typeof component !== 'object') continue
        shippedRow = component
        reportRowSource('shipped')
        return component
      }
      return null
    }

    /**
     * Record which renderer the disclosure rows are actually using, per change.
     * @param source - 'shipped' when the product's own row renders, 'fallback' for
     * the built-in one.
     */
    function reportRowSource(source) {
      if (rowSource === source) return
      rowSource = source
      probe({ kind: 'row', source })
    }

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

    /**
     * Built-in disclosure row, used only when the shipped entry could not be
     * borrowed from the slot ledger. Markup mirrors the shipped view; the classes
     * are this package's own, so no product CSS-module hash can go stale on them.
     * @param props.node - the `turn-process` Chat node.
     * @param props.turnProcess - disclosure owner state.
     * @returns the row element.
     */
    function fallbackRow({ node, turnProcess }) {
      reportRowSource('fallback')
      const strings_ = strings()
      const data = node.data
      const parts = []
      if (data.toolCallCount > 0) parts.push(strings_.toolCalls(data.toolCallCount))
      if (data.messageCount > 0) parts.push(strings_.messages(data.messageCount))
      if (data.subagentCount > 0) parts.push(strings_.subagents(data.subagentCount))
      const label = parts.length === 0 ? strings_.thought : parts.join(strings_.separator)
      const open = turnProcess.open
      return React.createElement(
        'button',
        {
          type: 'button',
          className: 'dsh-fold-it-up-root',
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
        React.createElement('span', { className: 'dsh-fold-it-up-label' }, label),
        React.createElement(
          'svg',
          {
            className: 'dsh-fold-it-up-chevron',
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
     * @param controller - controller owned by this session's Chat view.
     * @returns the entry's inject face.
     */
    function chatFace(ctx, sessionId, controller) {
      return {
        hooks: {},
        keyedHooks: {},
        controller,
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

    /** Cache one wrapper for each stable Chat target object. */
    const chatSourceCache = new WeakMap()

    /**
     * Resolve the session's chat target and reuse its source wrapper.
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
      const cached = chatSourceCache.get(target)
      if (cached !== undefined) return cached
      const source = {
        getSnapshot: () => target.getSnapshot(),
        subscribe: listener => target.subscribe(listener),
      }
      chatSourceCache.set(target, source)
      return source
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
      // DSH may render the main conversation and one or more subagent
      // conversations at the same time. Their stores and DOM columns are
      // session-scoped, so their disclosure controllers must be too.
      const controllers = new Map()
      const controllerFor = (sessionId) => {
        let controller = controllers.get(sessionId)
        if (controller === undefined) {
          controller = createController()
          controllers.set(sessionId, controller)
        }
        return controller
      }
      // The ledger this entry registers on is also where the SHIPPED renderer can
      // be read back — see `resolveShippedRow`.
      ledger = ctx.slots
      ctx.effect(() => {
        const style = insertStyles()
        return () => { style.remove() }
      }, 'dsh-fold-it-up: styles')
      ctx.effect(() => ctx.slots.inject('conversation.chat.node', () => {
        try {
          ownRow = (props) => React.createElement(
            ControllerProvider,
            { controller: props.controller },
            React.createElement(FoldRow, props),
          )
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
              inject: sessionId => chatFace(ctx, sessionId, controllerFor(sessionId)),
            },
            ownRow,
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
