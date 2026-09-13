#!/usr/bin/env node
/**
 * Scroll probe: measure what the transcript's scroller actually does while a
 * turn runs and right after it closes.
 *
 * The planned "scroll the answered question back to the top" behaviour depends
 * on facts that can only be measured, not read:
 *
 *   - which element really scrolls (`ChatView` delegates to an enclosing
 *     `[data-conversation-scroll]` when the conversation host provides one);
 *   - whether the app keeps the view pinned to the bottom by itself, and when
 *     it stops;
 *   - whether a foreign `scrollTop` write survives, and whether the app treats
 *     it as a reader gesture (which is what disarms its own bottom-follow);
 *   - where the turn's own question row sits, and whether the turn is stated on
 *     that row's seat;
 *   - whether `turn-tail` is rendered at all (the fold's closure gate reads it).
 *
 * Usage:
 *   node tools/probe-scroll.mjs --url <authenticated-url> [--text "<prompt>"]
 *                               [--port 9250] [--wait 180]
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
  console.error('usage: node tools/probe-scroll.mjs --url <authenticated-url> [--text "<prompt>"] [--port 9250]')
  process.exit(2)
}
const port = Number(args.port ?? 9250)

const dir = await mkdtemp(join(tmpdir(), 'dsh-scroll-'))
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
 * Page-side helpers, installed once. `scrollerOf` mirrors `ChatView`'s own
 * resolution: the enclosing `[data-conversation-scroll]` owns scrolling when
 * present, otherwise the Chat list is itself the scroller.
 */
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
      tag: el.tagName,
      cls: typeof el.className === 'string' ? el.className.slice(0, 40) : '',
      host: el.hasAttribute('data-conversation-scroll'),
      scrollTop: Math.round(el.scrollTop),
      scrollHeight: el.scrollHeight,
      clientHeight: el.clientHeight,
      floor: Math.max(0, el.scrollHeight - el.clientHeight),
      atBottom: el.scrollHeight - el.scrollTop - el.clientHeight <= 25,
    }
  },
  seats: () => [...document.querySelectorAll('[data-chat-flow-kind]')].map((el, index) => ({
    index,
    kind: el.dataset.chatFlowKind,
    turn: el.dataset.chatTurn ?? null,
    owner: el.dataset.folditupTurn ?? null,
    hidden: el.getAttribute('hidden'),
    answer: el.dataset.foldItUpAnswer === '1',
    top: Math.round(el.getBoundingClientRect().top),
    h: Math.round(el.getBoundingClientRect().height),
    text: (el.innerText ?? '').replace(/\\s+/gu, ' ').trim().slice(0, 50),
  })),
  composerTop: () => {
    const seat = document.querySelector('[data-composer-seat]')
    return seat === null ? null : Math.round(seat.getBoundingClientRect().top)
  },
  toBottom: () => [...document.querySelectorAll('button')]
    .filter(node => node.offsetParent !== null)
    .map(node => ({
      label: node.getAttribute('aria-label'),
      text: (node.textContent ?? '').trim().slice(0, 16),
      cls: typeof node.className === 'string' ? node.className.slice(0, 30) : '',
      top: Math.round(node.getBoundingClientRect().top),
    }))
    .filter(node => node.label !== null),
}
true`

await send('Page.enable')
await send('Runtime.enable')
await send('Page.addScriptToEvaluateOnNewDocument', { source: HELPERS })
await send('Page.navigate', { url: args.url })
await sleep(9000)
await evaluate(HELPERS)

console.log('=== 1. scroller shape before any turn ===')
console.log(JSON.stringify(await evaluate(`({ geo: __P__.geo(), hosts: document.querySelectorAll('[data-conversation-scroll]').length, lists: document.querySelectorAll('[data-chat-flow]').length })`), null, 1))
console.log('--- chrome buttons with aria-label ---')
console.log(JSON.stringify(await evaluate(`__P__.toBottom()`), null, 1))
console.log('--- last 3 seats ---')
console.log(JSON.stringify((await evaluate(`__P__.seats()`)).slice(-3), null, 1))

const composer = `[...document.querySelectorAll('[role="textbox"]')].find(node => node.offsetParent !== null) ?? null`
const found = await evaluate(`(() => { const field = ${composer}; return field === null ? null : true })()`)
if (found !== true) {
  console.error('no composer found on the page')
  process.exitCode = 1
} else {
  const at = await evaluate(`(() => {
    const field = ${composer}
    field.focus()
    const rect = field.getBoundingClientRect()
    return { x: Math.round(rect.x + 10), y: Math.round(rect.y + rect.height / 2) }
  })()`)
  await send('Input.dispatchMouseEvent', { type: 'mousePressed', x: at.x, y: at.y, button: 'left', clickCount: 1 })
  await send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: at.x, y: at.y, button: 'left', clickCount: 1 })
  await send('Input.insertText', { text: args.text ?? 'Reply with exactly: scroll probe OK' })
  await sleep(600)
  for (const type of ['keyDown', 'keyUp']) {
    await send('Input.dispatchKeyEvent', {
      type, key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13, nativeVirtualKeyCode: 13, text: '\r',
    })
  }
  console.log('=== 2. submitted; sampling geometry while the turn runs ===')

  const waitSeconds = Number(args.wait ?? 180)
  const started = Date.now()
  let quiet = 0
  const samples = []
  while ((Date.now() - started) / 1000 < waitSeconds) {
    await sleep(2000)
    const state = await evaluate(`(() => {
      const geo = __P__.geo()
      const seats = __P__.seats()
      const turns = [...new Set(seats.map(s => Number(s.turn)).filter(Number.isFinite))]
      const last = turns.length === 0 ? null : Math.max(...turns)
      const mine = seats.filter(s => Number(s.turn) === last)
      const question = seats.filter(s => s.kind === 'user').at(-1) ?? null
      const scroller = __P__.scroller()
      const qRow = scroller === null ? null : [...scroller.querySelectorAll('[data-chat-flow-kind="user"]')].at(-1) ?? null
      return {
        geo,
        rows: seats.length,
        lastTurn: last,
        tail: mine.some(s => s.kind === 'turn-tail'),
        questionTurn: question === null ? null : question.turn,
        questionTop: question === null ? null : question.top,
        questionText: question === null ? null : question.text,
        questionOffset: qRow === null || scroller === null
          ? null
          : Math.round(qRow.getBoundingClientRect().top - scroller.getBoundingClientRect().top),
        composerTop: __P__.composerTop(),
        busy: [...document.querySelectorAll('button')].some(node => /停止|Stop/i.test(node.textContent ?? '')),
        topButton: __P__.toBottom().length > 0,
      }
    })()`)
    samples.push({ t: Math.round((Date.now() - started) / 1000), ...state })
    console.log(`  t+${String(samples.at(-1).t)}s top=${String(state.geo?.scrollTop)} floor=${String(state.geo?.floor)} atBottom=${String(state.geo?.atBottom)} rows=${String(state.rows)} lastTurn=${String(state.lastTurn)} tail=${String(state.tail)} busy=${String(state.busy)} qTurn=${String(state.questionTurn)} qOff=${String(state.questionOffset)}`)
    if (state.tail && !state.busy) {
      quiet += 1
      if (quiet >= 2) break
    } else quiet = 0
  }

  console.log('=== 3. after close: where does the view sit, and can a foreign write move it? ===')
  const closed = await evaluate(`(() => {
    const seats = __P__.seats()
    const turns = [...new Set(seats.map(s => Number(s.turn)).filter(Number.isFinite))]
    const last = turns.length === 0 ? null : Math.max(...turns)
    const mine = seats.filter(s => Number(s.turn) === last)
    const scroller = __P__.scroller()
    const question = [...(scroller?.querySelectorAll('[data-chat-flow-kind="user"]') ?? [])].at(-1) ?? null
    const rect = question?.getBoundingClientRect() ?? null
    const hostRect = scroller?.getBoundingClientRect() ?? null
    return {
      lastTurn: last,
      tail: mine.some(s => s.kind === 'turn-tail'),
      hidden: seats.filter(s => s.hidden !== null).length,
      controllers: document.querySelectorAll('[data-turn-process]').length,
      geo: __P__.geo(),
      questionTurn: question?.dataset.chatTurn ?? null,
      questionTopInScrollport: rect === null || hostRect === null ? null : Math.round(rect.top - hostRect.top),
      questionHeight: rect === null ? null : Math.round(rect.height),
      composerTop: __P__.composerTop(),
      // The write this feature would make: land the question on the top edge.
      write: scroller === null ? null : (() => {
        const target = scroller.scrollTop + (rect.top - hostRect.top)
        scroller.scrollTop = Math.max(0, target)
        return { requested: Math.round(target), landed: Math.round(scroller.scrollTop), floor: Math.max(0, scroller.scrollHeight - scroller.clientHeight) }
      })(),
    }
  })()`)
  console.log(JSON.stringify(closed, null, 1))
  await sleep(1200)
  const held = await evaluate(`(() => ({
    geo: __P__.geo(),
    gapToFloor: Math.round(__P__.geo().floor - __P__.geo().scrollTop),
    topButton: __P__.toBottom().length > 0,
  }))()`)
  console.log('=== 4. 1.2s after the write (did the app take it back?) ===')
  console.log(JSON.stringify(held, null, 1))
  const write = await evaluate(`(() => ({
    geo: __P__.geo(),
    gapToFloor: Math.round(__P__.geo().floor - __P__.geo().scrollTop),
    topButton: __P__.toBottom().length > 0,
  }))()`)
  console.log('=== 5. and again right away ===')
  console.log(JSON.stringify(write, null, 1))

  if (typeof args.report === 'string') {
    writeFileSync(args.report, `${JSON.stringify({ samples, closed, held, write }, null, 1)}\n`)
  }
}

socket.close()
edge.kill()
await sleep(300)
await rm(dir, { recursive: true, force: true }).catch(() => {})
