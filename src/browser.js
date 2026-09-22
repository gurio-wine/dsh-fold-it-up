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

import * as React from 'react'
import { defineStore } from '@deepseek-ai/dsh-client-store'
import { autoScrollTarget, foldColumn } from './logic.js'

/** Package name; also the module-table key this bundle registers under. */
const PACKAGE = 'dsh-fold-it-up'

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
export function createController() {
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
 * The DOM operations one fold pass performs, in the shape `foldColumn` expects.
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
  const { turns, counted } = foldColumn(column, nodeAt, PASS_OPS)
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
    const target = autoScrollTarget(
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
export const inject = ['slots', 'locale', 'uiConversation']

/** Stable Cordis plugin name. */
export const name = PACKAGE

/**
 * Mount the disclosure takeover.
 *
 * Cordis resolves a module plugin by reading `apply` off the module namespace,
 * which is why this module exports `apply` directly instead of wrapping it.
 * @param ctx - client root context.
 */
export function apply(ctx) {
  // One controller per plugin mount: expansion state outlives every turn and
  // the per-session Chat view the rows render in.
  const controller = createController()
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
        { controller },
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
          inject: sessionId => chatFace(ctx, sessionId),
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
