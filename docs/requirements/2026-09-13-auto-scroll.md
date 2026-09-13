# Auto-scroll to the question when a turn's answer finishes

## Requirement

After a turn's answer finishes, the view must move so that the question the user
asked sits at the top of the transcript's scrollport — the reader wants to start
reading the answer from its first line, and a long answer leaves the view pinned
to its bottom.

Scope chosen by the user: **every turn**, not only long answers. A short answer
needs no special case: there is nothing to scroll, so nothing happens.

Measured baseline (real DOM, long answer, `tools/probe-scroll.mjs`):

| | |
|---|---|
| scroller | `div.QFBU2W_scrollBody` with `data-conversation-scroll` — the element `ChatView` resolves for itself |
| at turn close | `scrollTop = 1993 = floor`, question row at **-1937px** inside the scrollport |
| one write | `scrollTop = 56`, question at **0px**; still 56 after 1.2s; a second write is a no-op |

## Trigger

The fold already computes, per pass, whether each turn is closed (`turn-tail`
present in the rendered group). Auto-scroll reuses that fact: a turn that was
**not closed** in the previous publication and **is closed** in the current one
triggers exactly one scroll. No second source of truth about turn state.

## Decision (pure)

`autoScrollTarget(change, geometry)` in `src/logic.js`:

| Condition | Result |
|---|---|
| no turn changed to closed | do not scroll |
| the disclosure was expanded in the previous pass | do not scroll |
| turn closed but no question row resolved | do not scroll |
| `floor <= 0` (nothing to scroll) | do not scroll |
| question top within `0.5px` of the scrollport top | do not scroll |
| otherwise | `{ top: scrollTop + questionTop }` |

## Guards

- **No overflow** → short answers produce no movement at all (verified).
- **Already aligned** → natural idempotence; a repeat trigger is a no-op.
- **Reader gesture within 1.5s** (`wheel` / `touchstart` / `pointerdown` /
  `keydown`) → scrolling back through history is never interrupted by a turn
  finishing. Checked again on the verification frame.
- **Baseline per transcript** → a page that opens with turns already closed
  (history, reload, session switch) never scrolls.
- **Session identity is a signature, not the column element.** The fold
  controller re-resolves its column every pass and that element is replaced by an
  ordinary re-render. Treating "different column" as "different history" reset the
  baseline and ate the close transition — measured: 2 of 6 live runs recorded no
  detection at all. The signature is `lowest turn number | first rendered key`,
  which a session switch always changes and a re-render never does.
- **One frame later, and measured from the settled layout.** The write is
  deferred past the commit that applies the fold, then verified once on the next
  frame (write again only if the question is really elsewhere).
- **Instant, not animated.** An animated scroll loses a race it cannot see: the
  app follows the flow tip itself when a turn closes. Measured live, the plugin's
  smooth write was recorded (`from 1993 to 56`) while the view stayed on the
  floor, landing in one run and not the next. An assignment has no animation to
  lose, so `prefers-reduced-motion` needs no special handling either.

## Opt-out

`localStorage['dsh-fold-it-up.autoScroll'] = 'off'`, mirroring the existing
`dsh-fold-it-up.locale` knob. Default is on.

## Verification

- `tools/logic.test.mjs` — the decision matrix (6 cases), including the short
  answer, the already-aligned question, an expanded turn, and broken geometry.
- `tools/verify-autoscroll.mjs` — the arithmetic on a real scroller:
  `--mode instant|smooth|inline-smooth`, sampling the position every 150ms and
  asserting the landing survives 1.2s and that a repeat is a no-op.
- `tools/verify-autoscroll-live.mjs` — the feature, end to end, through the
  browser's own composer, observation only. It asserts that the run PROVES
  something (overflow happened, the view really was at the floor, the question
  really was off screen), then that the question lands at the top edge, that
  exactly one write happened (plus at most one repair), and — with `--reload` —
  that a reloaded transcript comes back folded with **zero** recorded scrolls,
  proven to have reloaded via the document's own birth stamp.

Measured (web profile, long answer):

```
at close        top=1993 floor=1993 questionTop=-1937
after close     top=56   floor=1993 questionTop=0     (6 samples, unchanged)
plugin trace    {"kind":"scroll","turn":1,"verify":false,"from":1993,"to":56,"landed":56}
after reload    rows=8 controllers=1 hidden=3 scrollEvents=0
short answer    write lands at 0 — a no-op
```
