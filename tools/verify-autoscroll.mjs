#!/usr/bin/env node
/**
 * Scroller regression check: does the view really sit at the bottom after a LOW
 * answer, and what exactly has to be written to bring the question back to the
 * top of the scrollport?
 *
 * Design constraints settled here per run:
 *   - short answer  → no vertical overflow → scrolling must be a no-op;
 *   - low answer    → the view ends pinned to the floor, the question's top is
 *                     far above the scrollport, and one `scrollTop` write lands
 *                     a computed offset;
 *   - placed answer → the SAME write must stay landed (retry once, report the
 *                     drift) once the page is running normally.
 *
 * Only the first two runs can also open a fresh task, which is charged to the
 * signed-in account; `--session <id>` reuses one instead.
 *
 * Usage:
 *   node tools/verify-autoscroll.mjs --url <authenticated-url> [--port 9265]
 *                                    [--text "<prompt>"] [--session <id>] [--wait 300] [--report <path>]
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
  console.error('usage: node tools/verify-autoscroll.mjs --url <authenticated-url> [--text "<prompt>"] [--session <id>]')
  process.exit(2)
}
const port = Number(args.port ?? 9265)

const dir = await mkdtemp(join(tmpdir(), 'dsh-autoscroll-'))
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

/** Page-side readers, installed once per document. */
const HELPERS = `
globalThis.__P__ = {
  list: () => document.querySelector('[data-chat-flow]'),
  scroller: () => {
    const list = globalThis.__P__.list()
    if (list === null) return null
    const host = list.closest('[data-conversation-scroll]')
    if (host !== null) return host
    let node = list
    while (node !== null && node !== document.body) {
      const style = getComputedStyle(node)
      if (style.overflowY === 'auto' || style.overflowY === 'scroll') return node
      node = node.parentElement
    }
    return null
  },
  geo: () => {
    const el = globalThis.__P__.scroller()
    if (el === null) return null
    return {
      scrollTop: Math.round(el.scrollTop),
      scrollHeight: el.scrollHeight,
      clientHeight: el.clientHeight,
      floor: Math.max(0, el.scrollHeight - el.clientHeight),
      gapToFloor: Math.round(Math.max(0, el.scrollHeight - el.clientHeight) - el.scrollTop),
    }
  },
  question: () => {
    const scroller = globalThis.__P__.scroller()
    if (scroller === null) return null
    const rows = [...scroller.querySelectorAll('[data-chat-flow-kind="user"]')]
    const row = rows.at(-1) ?? null
    if (row === null) return null
    const rect = row.getBoundingClientRect()
    const box = scroller.getBoundingClientRect()
    return {
      count: rows.length,
      turn: row.dataset.chatTurn ?? null,
      topInScrollport: Math.round(rect.top - box.top),
      height: Math.round(rect.height),
      // The write this feature would make, expressed against the LIVE layout.
      target: Math.round(scroller.scrollTop + (rect.top - box.top)),
      text: (row.innerText ?? '').replace(/\\s+/gu, ' ').trim().slice(0, 40),
    }
  },
  tailOf: (turn) => [...document.querySelectorAll('[data-chat-flow-kind]')]
    .filter(row => Number(row.dataset.chatTurn) === turn)
    .some(row => row.dataset.chatFlowKind === 'turn-tail'),
  toBottomButton: () => {
    const scroller = globalThis.__P__.scroller()
    if (scroller === null) return null
    for (const node of scroller.querySelectorAll('button')) {
      const label = node.getAttribute('aria-label') ?? ''
      if (/bottom|底部|回到底部/i.test(label)) {
        return { label, top: Math.round(node.getBoundingClientRect().top) }
      }
    }
    return null
  },
}
true`

/**
 * The session's own page, keeping the startup URL's query intact.
 * @param url - the authenticated startup URL.
 * @param session - session id, or undefined for the current one.
 * @returns the URL to open.
 */
function pageUrl(url, session) {
  if (session === undefined) return url
  const parsed = new URL(url)
  const base = `${parsed.origin}/session/${String(session)}`
  return `${base}${parsed.search}`
}

await send('Page.enable')
await send('Runtime.enable')
await send('Page.addScriptToEvaluateOnNewDocument', { source: HELPERS })
const target = pageUrl(args.url, typeof args.session === 'string' ? args.session : undefined)
await send('Page.navigate', { url: target })
await sleep(9000)
await evaluate(HELPERS)
console.log(`page: ${await evaluate('location.href')}`)

/** Submit one prompt through the browser's own composer, if asked to. */
async function ask(text) {
  const composer = `[...document.querySelectorAll('[role="textbox"]')].find(node => node.offsetParent !== null) ?? null`
  const at = await evaluate(`(() => {
    const field = ${composer}
    if (field === null) return null
    field.focus()
    const rect = field.getBoundingClientRect()
    return { x: Math.round(rect.x + 10), y: Math.round(rect.y + rect.height / 2) }
  })()`)
  if (at === null) throw new Error('no composer')
  await send('Input.dispatchMouseEvent', { type: 'mousePressed', x: at.x, y: at.y, button: 'left', clickCount: 1 })
  await send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: at.x, y: at.y, button: 'left', clickCount: 1 })
  await send('Input.insertText', { text })
  await sleep(600)
  for (const type of ['keyDown', 'keyUp']) {
    await send('Input.dispatchKeyEvent', {
      type, key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13, nativeVirtualKeyCode: 13, text: '\r',
    })
  }
}

const report = { steps: [] }
const note = (step, data) => {
  report.steps.push({ step, at: new Date().toISOString(), ...data })
  console.log(`--- ${step}`)
  console.log(JSON.stringify(data, null, 1))
}

if (typeof args.text === 'string') {
  await ask(args.text)
  console.log('submitted; waiting for the turn to close…')
  const waitSeconds = Number(args.wait ?? 300)
  const started = Date.now()
  let closed = false
  while ((Date.now() - started) / 1000 < waitSeconds) {
    await sleep(3000)
    const state = await evaluate(`(() => {
      const rows = [...document.querySelectorAll('[data-chat-flow-kind]')]
      const turns = [...new Set(rows.map(row => Number(row.dataset.chatTurn)).filter(Number.isFinite))]
      const turn = turns.length === 0 ? null : Math.max(...turns)
      return {
        rows: rows.length,
        turn,
        tail: turn === null ? false : __P__.tailOf(turn),
        busy: [...document.querySelectorAll('button')].some(node => /停止|Stop/i.test(node.textContent ?? '')),
        geo: __P__.geo(),
      }
    })()`)
    console.log(`  t+${String(Math.round((Date.now() - started) / 1000))}s rows=${String(state.rows)} turn=${String(state.turn)} tail=${String(state.tail)} busy=${String(state.busy)} floor=${String(state.geo?.floor)} top=${String(state.geo?.scrollTop)}`)
    if (state.tail && !state.busy) {
      closed = true
      break
    }
  }
  if (!closed) console.log('WARNING: the turn did not close within the wait window')
  await sleep(2500)
  // Straight after the fold: where did the view end up, on its own?
  note('after close, untouched', await evaluate(`(() => ({
    geo: __P__.geo(),
    question: __P__.question(),
    toBottom: __P__.toBottomButton(),
  }))()`))
}

/**
 * How the write is made. `instant` assigns `scrollTop`; `smooth` uses
 * `scrollTo` under the stylesheet's `scroll-behavior: smooth`; `inline-smooth`
 * keeps the CSS rule off and asks for the animation on the call itself — the
 * three ways this can be spelled, so the shipped one can be the measured one.
 */
const MODE = typeof args.mode === 'string' ? args.mode : 'instant'

// The write, on whatever session is loaded: land the last question on the
// scrollport's top edge, then read the geometry back at once and again after the
// app has had a frame and a mutation to disagree with it.
const attempt = await evaluate(`(() => {
  const mode = ${JSON.stringify(MODE)}
  const scroller = __P__.scroller()
  const question = __P__.question()
  if (scroller === null || question === null) return { error: 'no scroller or question' }
  const box = scroller.getBoundingClientRect()
  const row = [...scroller.querySelectorAll('[data-chat-flow-kind="user"]')].at(-1)
  const before = { ...__P__.geo(), questionTopInScrollport: question.topInScrollport }
  const target = scroller.scrollTop + (row.getBoundingClientRect().top - box.top)
  if (mode === 'smooth' || mode === 'inline-smooth') {
    if (mode === 'smooth') scroller.setAttribute('data-fold-it-up-scroller', '')
    scroller.scrollTo({ top: Math.max(0, target), behavior: mode === 'smooth' ? undefined : 'smooth' })
  } else scroller.scrollTop = Math.max(0, target)
  return {
    mode,
    before,
    requested: Math.round(target),
    landed: Math.round(scroller.scrollTop),
    questionTopAfterWrite: Math.round(row.getBoundingClientRect().top - scroller.getBoundingClientRect().top),
    floor: Math.max(0, scroller.scrollHeight - scroller.clientHeight),
  }
})()`)
note('the write', attempt)

// Sample the animation itself: a smooth scroll passes through intermediate
// positions, so "did it land" has to be asked over frames, not once.
const trace = []
for (let round = 0; round < 14; round += 1) {
  await sleep(150)
  trace.push(await evaluate(`(() => ({
    top: Math.round(__P__.scroller().scrollTop),
    questionTop: __P__.question()?.topInScrollport ?? null,
  }))()`))
}
note('animation trace (150ms apart)', { mode: MODE, positions: trace.map(point => point.top), questionTop: trace.map(point => point.questionTop) })

await sleep(1200)
const held = await evaluate(`(() => ({
  geo: __P__.geo(),
  questionTop: __P__.question()?.topInScrollport ?? null,
  toBottom: __P__.toBottomButton(),
  hidden: document.querySelectorAll('[data-chat-flow-kind][hidden]').length,
}))()`)
note('1.2s after the write', held)

const second = await evaluate(`(() => {
  const scroller = __P__.scroller()
  const row = [...scroller.querySelectorAll('[data-chat-flow-kind="user"]')].at(-1)
  const box = scroller.getBoundingClientRect()
  const before = Math.round(scroller.scrollTop)
  scroller.scrollTop = Math.max(0, before + (row.getBoundingClientRect().top - box.top))
  return {
    before,
    after: Math.round(scroller.scrollTop),
    questionTop: Math.round(row.getBoundingClientRect().top - scroller.getBoundingClientRect().top),
  }
})()`)
note('second write (already aligned: must be a no-op)', second)

// The failures this probe is meant to catch, stated as predicates.
const failures = []
const short = attempt?.before?.floor === 0
const finalTop = trace.at(-1)?.top ?? null
const finalQuestionTop = trace.at(-1)?.questionTop ?? null
if (short && attempt?.landed !== 0) failures.push('a transcript with no overflow was scrolled anyway')
if (!short && typeof attempt?.requested === 'number' && attempt.landed !== attempt.requested
  && MODE !== 'smooth' && MODE !== 'inline-smooth') {
  // An animated scroll is not expected to have arrived synchronously.
  failures.push(`the write did not land: requested ${String(attempt.requested)}, landed ${String(attempt.landed)}`)
}
if (!short && Math.abs(finalQuestionTop ?? 999) > 4) {
  failures.push(`${MODE}: the animation did not land — question top is ${String(finalQuestionTop)}px, positions ${JSON.stringify(trace.map(point => point.top))}`)
}
if (!short && Math.abs(held?.questionTop ?? 999) > 4) {
  failures.push(`the app took the view back after the write: question top is ${String(held?.questionTop)}px`)
}
if (!short && Math.abs(second?.questionTop ?? 999) > 4) {
  failures.push(`a second align left the question at ${String(second?.questionTop)}px`)
}
report.failures = failures
report.overflow = !short
report.mode = MODE

const out = `${JSON.stringify(report, null, 1)}\n`
if (typeof args.report === 'string') writeFileSync(args.report, out)
console.log(out)
for (const failure of failures) console.error(`FAIL ${failure}`)
if (failures.length === 0) {
  console.log(short
    ? 'OK — no overflow: scrolling is correctly a no-op here'
    : `OK — ${MODE}: the question lands on the top edge and stays there`)
} else process.exitCode = 1

socket.close()
edge.kill()
await sleep(300)
await rm(dir, { recursive: true, force: true }).catch(() => {})
