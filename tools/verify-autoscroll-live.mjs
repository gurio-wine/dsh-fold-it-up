#!/usr/bin/env node
/**
 * Live acceptance check for the auto-scroll: with the plugin installed, does a
 * finished long answer LEAVE the view at its first line by itself?
 *
 * The probe before this one (`verify-autoscroll.mjs`) measures the scroller and
 * the arithmetic of one write. This one measures the FEATURE: it opens a real
 * session, asks a question that produces a long answer through the browser's own
 * composer, and then reads where the view ended up once the turn closed — no
 * writes of its own, only observation.
 *
 * Three assertions, and the third is what keeps the first two honest:
 *
 *   1. the transcript really overflows and really ended pinned at the floor
 *      before the plugin acted (otherwise there is nothing to scroll and the
 *      check proves nothing);
 *   2. once the turn closed, the view lands with the question on the scrollport's
 *      top edge — the feature happening;
 *   3. the plugin's own trace records exactly one scroll for that turn, and a
 *      session that opens with turns already closed records none.
 *
 * Usage:
 *   node tools/verify-autoscroll-live.mjs --url <authenticated-url> [--port 9267]
 *                                         [--text "<prompt>"] [--wait 420]
 *                                         [--session <id>] [--reload] [--report <path>]
 *
 * `--reload` adds the opposite direction on the SAME transcript: after the check
 * above, the page is reloaded, and since no turn closes on a freshly loaded page
 * the plugin must record zero scrolls — the fold comes back, the view stays put.
 *
 * Cost note: without `--session` this asks ONE question in a fresh task, which
 * is charged to the signed-in account.
 */
import { spawn } from 'node:child_process'
import { existsSync, writeFileSync } from 'node:fs'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { setTimeout as sleep } from 'node:timers/promises'

const EDGE = [
  'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
  'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
].find(candidate => existsSync(candidate))

/** Parse `--flag value` pairs, treating a bare flag as `true`. */
function parseArgs(argv) {
  const args = {}
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index]
    if (!token.startsWith('--')) continue
    const next = argv[index + 1]
    if (next === undefined || next.startsWith('--')) args[token.slice(2)] = true
    else {
      args[token.slice(2)] = next
      index += 1
    }
  }
  return args
}

const args = parseArgs(process.argv.slice(2))
if (typeof args.url !== 'string') {
  console.error('usage: node tools/verify-autoscroll-live.mjs --url <authenticated-url> [--text "<prompt>"]')
  process.exit(2)
}
const prompt = typeof args.text === 'string'
  ? args.text
  : '请用中文逐条写出 80 条不同的简短建议，每条一行，编号 1 到 80，每条不超过 20 个字，主题是整理书桌。不要用表格，不要分段标题，只输出编号列表。'
const port = Number(args.port ?? 9267)

const dir = await mkdtemp(join(tmpdir(), 'dsh-autoscroll-live-'))
const edge = spawn(EDGE, [
  '--headless=new', `--remote-debugging-port=${String(port)}`, `--user-data-dir=${dir}`,
  '--no-first-run', '--window-size=1500,1000', 'about:blank',
], { stdio: 'ignore' })

let ws
for (let attempt = 0; attempt < 80; attempt += 1) {
  try {
    const response = await fetch(`http://127.0.0.1:${String(port)}/json/version`)
    const body = await response.json()
    if (body.webSocketDebuggerUrl) { ws = body.webSocketDebuggerUrl; break }
  } catch { /* not up */ }
  await sleep(250)
}
const socket = new WebSocket(ws)
const pending = new Map()
let id = 1
socket.addEventListener('message', (event) => {
  const message = JSON.parse(event.data)
  if (message.id === undefined) return
  const entry = pending.get(message.id)
  if (entry === undefined) return
  pending.delete(message.id)
  if (message.error !== undefined) entry.reject(new Error(JSON.stringify(message.error)))
  else entry.resolve(message.result)
})
await new Promise((resolve, reject) => {
  socket.addEventListener('open', resolve, { once: true })
  socket.addEventListener('error', reject, { once: true })
})
const raw = (method, params = {}, sessionId) => {
  const requestId = id++
  const message = { id: requestId, method, params }
  if (sessionId !== undefined) message.sessionId = sessionId
  socket.send(JSON.stringify(message))
  return new Promise((resolve, reject) => pending.set(requestId, { resolve, reject }))
}
const { targetId } = await raw('Target.createTarget', { url: 'about:blank' })
const { sessionId } = await raw('Target.attachToTarget', { targetId, flatten: true })
const send = (method, params) => raw(method, params, sessionId)
const evaluate = async (expression) => {
  const result = await send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true })
  if (result.exceptionDetails !== undefined) throw new Error(JSON.stringify(result.exceptionDetails))
  return result.result.value
}

/**
 * Page-side state reader. The scroller is resolved the way the shipped view
 * resolves it, and the question is the last `user` seat on the page.
 */
const STATE = `(() => {
  const list = document.querySelector('[data-chat-flow]')
  const scroller = list === null
    ? null
    : (list.closest('[data-conversation-scroll]') ?? (() => {
      let node = list
      while (node !== null && node !== document.body) {
        const style = getComputedStyle(node)
        if (style.overflowY === 'auto' || style.overflowY === 'scroll') return node
        node = node.parentElement
      }
      return null
    })())
  const rows = [...document.querySelectorAll('[data-chat-flow-kind]')]
  const turns = [...new Set(rows.map(row => Number(row.dataset.chatTurn)).filter(Number.isFinite))]
  const turn = turns.length === 0 ? null : Math.max(...turns)
  const seat = scroller === null ? null : [...scroller.querySelectorAll('[data-chat-flow-kind="user"]')].at(-1) ?? null
  const box = scroller?.getBoundingClientRect() ?? null
  const rect = seat?.getBoundingClientRect() ?? null
  return {
    rows: rows.length,
    turn,
    // A reload is only real if the document is new: the page's own birth stamp
    // cannot be imitated by a restored scroll position.
    born: Math.round(performance.timeOrigin),
    tail: turn !== null && rows.some(row => Number(row.dataset.chatTurn) === turn && row.dataset.chatFlowKind === 'turn-tail'),
    busy: [...document.querySelectorAll('button')].some(node => /停止|Stop/i.test(node.textContent ?? '')),
    scroller: scroller === null ? null : {
      scrollTop: Math.round(scroller.scrollTop),
      floor: Math.round(Math.max(0, scroller.scrollHeight - scroller.clientHeight)),
      questionTop: rect === null || box === null ? null : Math.round(rect.top - box.top),
    },
    scrollEvents: (globalThis.__FOLDITUP__?.events ?? []).filter(event => event.kind === 'scroll'),
    // Every lifecycle record the plugin keeps, so a run that never scrolled can
    // say WHERE it stopped instead of only that nothing happened.
    trace: (globalThis.__FOLDITUP__?.events ?? []).slice(-14),
    registered: (globalThis.__FOLDITUP__?.events ?? []).some(event => event.kind === 'register' && event.won === true),
  }
})()`

await send('Page.enable')
await send('Runtime.enable')
await send('Page.navigate', { url: args.url })
await sleep(9000)

const report = { prompt, samples: [] }
const failure = []
const before = await evaluate(STATE)
report.before = before
console.log(`loaded: rows=${String(before.rows)} registered=${String(before.registered)}`)
if (before.registered !== true) failure.push('the plugin did not win the turn-process cell on this page')

if (typeof args.session !== 'string' && args.history !== true) {
  const composer = `[...document.querySelectorAll('[role="textbox"]')].find(node => node.offsetParent !== null) ?? null`
  const at = await evaluate(`(() => {
    const field = ${composer}
    if (field === null) return null
    field.focus()
    const rect = field.getBoundingClientRect()
    return { x: Math.round(rect.x + 10), y: Math.round(rect.y + rect.height / 2) }
  })()`)
  if (at === null) {
    failure.push('no composer on the page')
  } else {
    await send('Input.dispatchMouseEvent', { type: 'mousePressed', x: at.x, y: at.y, button: 'left', clickCount: 1 })
    await send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: at.x, y: at.y, button: 'left', clickCount: 1 })
    await send('Input.insertText', { text: prompt })
    await sleep(600)
    for (const type of ['keyDown', 'keyUp']) {
      await send('Input.dispatchKeyEvent', {
        type, key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13, nativeVirtualKeyCode: 13, text: '\r',
      })
    }
    console.log('submitted; waiting for the turn to close…')
  }
}

// Watch the whole life of the turn: the geometry at the moment it closes, and
// the geometry a moment later, when only the plugin can have moved it. On a
// `--history` page no turn will ever close, so the watch has a short beat only.
const waitSeconds = args.history === true ? 8 : Number(args.wait ?? 420)
/** How many post-close samples to take, and how long to wait between them. */
const settleMs = Number(args.settle ?? 500)
const started = Date.now()
let closing = null
while ((Date.now() - started) / 1000 < waitSeconds) {
  await sleep(settleMs)
  const state = await evaluate(STATE)
  const at = Math.round((Date.now() - started) / 1000)
  if (state.tail && !state.busy && closing === null) {
    closing = { at, state }
    console.log(`  t+${String(at)}s CLOSED  top=${String(state.scroller?.scrollTop)} floor=${String(state.scroller?.floor)} questionTop=${String(state.scroller?.questionTop)}`)
    continue
  }
  if (closing !== null) {
    report.samples.push({ at, ...state.scroller, scrollEvents: state.scrollEvents.length })
    console.log(`  t+${String(at)}s after  top=${String(state.scroller?.scrollTop)} floor=${String(state.scroller?.floor)} questionTop=${String(state.scroller?.questionTop)} scrollEvents=${String(state.scrollEvents.length)}`)
    if (at - closing.at >= 6) break
    continue
  }
  if (at % 15 === 0) console.log(`  t+${String(at)}s running rows=${String(state.rows)} top=${String(state.scroller?.scrollTop)} floor=${String(state.scroller?.floor)}`)
}
report.atClose = closing
report.after = await evaluate(STATE)
console.log('--- plugin trace (last records) ---')
for (const event of report.after.trace ?? []) console.log('   ' + JSON.stringify(event))

// A page that opens on turns that were ALREADY closed is the other half of the
// behaviour: nothing there is an event, so nothing may move on its own. The app
// has no URL for a session, so the honest way to reach that state is a reload of
// the transcript this run just finished: the same rows come back, but no turn
// closes after the load, so the recorded scroll count must stay zero.
if (args.history === true || args.reload === true) {
  const bornBefore = report.after?.born ?? null
  if (args.reload === true) {
    // Back to the cover: the app does not reopen a session by itself on boot,
    // so the check below drives the sidebar to get back into this one.
    await send('Page.reload', { ignoreCache: false })
    console.log('reloaded; returning to the finished conversation through the sidebar…')
    await sleep(9000)
    const opened = await evaluate(`(() => {
      const row = [...document.querySelectorAll('*')]
        .filter(node => typeof node.className === 'string' && /sessionRow|_session/i.test(node.className))
        .find(node => node.offsetParent !== null && (node.innerText ?? '').includes(${JSON.stringify(prompt.slice(0, 12))}))
      if (row === undefined) return null
      const rect = row.getBoundingClientRect()
      return { x: Math.round(rect.x + rect.width / 2), y: Math.round(rect.y + Math.min(18, rect.height / 2)) }
    })()`)
    if (opened === null) {
      // Measured: the shell restores the conversation it had open by itself, so
      // a missing row is not a failure — the state check below still has to see
      // a transcript, and that is what decides.
      console.log('  (no sidebar row found: relying on the shell restoring the conversation)')
    } else {
      // A real click: React does not listen for `.click()` on every row shape,
      // and this is how the app is actually used.
      await send('Input.dispatchMouseEvent', { type: 'mousePressed', x: opened.x, y: opened.y, button: 'left', clickCount: 1 })
      await send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: opened.x, y: opened.y, button: 'left', clickCount: 1 })
      await sleep(7000)
    }
    for (let round = 0; round < 10; round += 1) {
      await sleep(1000)
      const state = await evaluate(STATE)
      const fold = await evaluate(`({
        controllers: document.querySelectorAll('[data-turn-process]').length,
        hidden: document.querySelectorAll('[data-chat-flow-kind][hidden]').length,
      })`)
      if (round === 0 || round === 9 || state.scrollEvents.length > 0) {
        console.log(`  t+${String(round + 1)}s rows=${String(state.rows)} top=${String(state.scroller?.scrollTop)} floor=${String(state.scroller?.floor)} scrollEvents=${String(state.scrollEvents.length)} controllers=${String(fold.controllers)} hidden=${String(fold.hidden)}`)
      }
      if (state.scrollEvents.length > 0) break
    }
  }
  const settled = await evaluate(STATE)
  const folded = await evaluate(`({
    controllers: document.querySelectorAll('[data-turn-process]').length,
    hidden: document.querySelectorAll('[data-chat-flow-kind][hidden]').length,
  })`)
  const moved = settled.scrollEvents ?? []
  if (args.reload === true && settled.born === bornBefore) {
    // Without this the check silently degrades into "the page I was already on
    // happens to be quiet", which is how a never-reloaded page passes a reload
    // assertion.
    failure.push(`the page did not reload (same document, born ${String(settled.born)})`)
  }
  if (settled.rows === 0) failure.push('the page has no transcript rows: nothing to check')
  if (folded.controllers === 0) failure.push('the reopened conversation came up unfolded: no disclosure row')
  if (moved.length !== 0) {
    failure.push(`a page of already-closed turns scrolled by itself: ${JSON.stringify(moved)}`)
  }
  report.history = {
    rows: settled.rows,
    born: settled.born,
    reloaded: args.reload === true && settled.born !== bornBefore,
    controllers: folded.controllers,
    hidden: folded.hidden,
    scrollTop: settled.scroller?.scrollTop ?? null,
    floor: settled.scroller?.floor ?? null,
    questionTop: settled.scroller?.questionTop ?? null,
    scrollEvents: moved.length,
  }
  const out = `${JSON.stringify(report, null, 1)}\n`
  if (typeof args.report === 'string') writeFileSync(args.report, out)
  console.log(JSON.stringify(report.history, null, 1))
  for (const item of failure) console.error(`FAIL ${item}`)
  console.log(failure.length === 0
    ? 'OK — a transcript of already-closed turns comes up folded and is left where it was'
    : 'FAILED')
  socket.close()
  edge.kill()
  await sleep(300)
  await rm(dir, { recursive: true, force: true }).catch(() => {})
  process.exit(failure.length === 0 ? 0 : 1)
}

// The last sample is the verdict: the feature is "the view is where the question
// is", not "a scroll happened at some point".
const last = report.samples.at(-1) ?? null
const finalState = report.after
const overflows = (closing?.state.scroller?.floor ?? 0) > 0
if (closing === null) failure.push('the turn never closed within the wait window')
if (!overflows) failure.push('the answer did not overflow the transcript: nothing to scroll, check proves nothing')
if (report.samples.length === 0) failure.push('no samples after the close')
if (closing !== null && Math.abs(closing.state.scroller?.questionTop ?? 0) < 200) {
  failure.push(`the question was already on screen at close (${String(closing.state.scroller.questionTop)}px): nothing to bring back`)
}
if (last !== null && Math.abs(last.questionTop ?? 999) > 4) {
  failure.push(`after the close the question sits at ${String(last.questionTop)}px, not the top edge`)
}
// "Moved away from the floor" is about the FLOOR, not about the last sampled
// position: an animated scroll is caught mid-flight by the first sample, and
// comparing against that sample is how this check reported a failure on a run
// whose final position was exactly right.
const floor = finalState?.scroller?.floor ?? 0
if ((finalState?.scroller?.scrollTop ?? 0) >= floor) {
  failure.push(`the view stayed on the floor (top ${String(finalState?.scroller?.scrollTop)} of ${String(floor)})`)
}
const scrolled = finalState?.scrollEvents ?? []
const writes = scrolled.filter(event => event.verify !== true)
const repairs = scrolled.filter(event => event.verify === true)
if (writes.length !== 1) {
  failure.push(`expected exactly one scroll write for the turn, saw ${String(writes.length)}: ${JSON.stringify(scrolled)}`)
}
if (repairs.length > 1) {
  failure.push(`the view needed ${String(repairs.length)} repairs: the app is fighting the scroll`)
}
report.writes = writes
report.repairs = repairs
report.failures = failure

const out = `${JSON.stringify(report, null, 1)}\n`
if (typeof args.report === 'string') writeFileSync(args.report, out)
console.log(out)
for (const item of failure) console.error(`FAIL ${item}`)
if (failure.length === 0) console.log('OK — a finished answer leaves the view on its first line')
else process.exitCode = 1

socket.close()
edge.kill()
await sleep(300)
await rm(dir, { recursive: true, force: true }).catch(() => {})
