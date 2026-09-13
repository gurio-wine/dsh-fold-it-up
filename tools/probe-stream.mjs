#!/usr/bin/env node
/**
 * Streaming probe: drive ONE real turn through the browser's own composer and
 * record what the fold does to the DOM while that turn is still running.
 *
 * The static checks (`verify-live`, `verify-load-older`) only ever look at
 * FINISHED turns, which is why a fold that appears mid-turn and disappears when
 * the next step starts is invisible to them. This probe samples the rendered
 * flow every 60 ms from before the message is sent until well after the turn
 * closes, so the sequence is on record instead of inferred:
 *
 *   - `hidden`      rows the fold is hiding right now
 *   - `controllers` per-turn disclosure rows the plugin is rendering
 *   - `assistantVisible`  assistant rows still readable
 *
 * Any sample with `controllers > 0 && hidden > 0` taken BEFORE the turn closed
 * is the reported defect: the process was folded while the model was still
 * working.
 *
 * Usage:
 *   node tools/probe-stream.mjs --url <authenticated-url> --text "<prompt>"
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

const args = {}
for (let index = 2; index < process.argv.length; index += 1) {
  const token = process.argv[index]
  if (!token.startsWith('--')) continue
  const next = process.argv[index + 1]
  if (next === undefined || next.startsWith('--')) args[token.slice(2)] = true
  else {
    args[token.slice(2)] = next
    index += 1
  }
}
if (typeof args.url !== 'string') {
  console.error('usage: node tools/probe-stream.mjs --url <authenticated-url> --text "<prompt>" [--port 9250]')
  process.exit(2)
}

const port = Number(args.port ?? 9250)
const dir = await mkdtemp(join(tmpdir(), 'dsh-stream-'))
const edge = spawn(EDGE, [
  '--headless=new', `--remote-debugging-port=${String(port)}`, `--user-data-dir=${dir}`,
  '--no-first-run', '--window-size=1500,1400', 'about:blank',
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

await send('Page.enable')
await send('Runtime.enable')

/** Page-side sampler: one snapshot per tick, appended to a bounded ring. */
const SAMPLER = `(() => {
  const samples = []
  globalThis.__FOLDITUP_STREAM__ = samples
  const snap = () => {
    const flow = [...document.querySelectorAll('[data-chat-flow-kind]')]
    const byKind = {}
    for (const node of flow) {
      const kind = node.dataset.chatFlowKind
      byKind[kind] = (byKind[kind] ?? 0) + 1
    }
    const turns = [...new Set(flow.map(node => Number(node.dataset.chatTurn)).filter(Number.isFinite))]
    const last = turns.length === 0 ? null : Math.max(...turns)
    const mine = flow.filter(node => Number(node.dataset.chatTurn) === last
      || Number(node.dataset.folditupTurn) === last)
    return {
      t: Math.round(performance.now()),
      rows: flow.length,
      byKind,
      lastTurn: last,
      hidden: flow.filter(node => node.hasAttribute('hidden')).length,
      // Rows the PLUGIN decided to hide are hidden by an attribute; the shipped
      // seat only ever sets it once its own window gate opens, so this counter
      // is the plugin's decision and not the product's.
      hiddenLast: mine.filter(node => node.hasAttribute('hidden')).length,
      controllers: turns.reduce((total, turn) => total + (document.querySelector('[data-turn-process="' + String(turn) + '"]') === null ? 0 : 1), 0),
      liveControllers: [...document.querySelectorAll('[data-turn-process]')].map(node => Number(node.dataset.turnProcess)),
      assistantLast: mine.filter(node => node.dataset.chatFlowKind === 'assistant-step')
        .map(node => ({
          hidden: node.hasAttribute('hidden'),
          answer: node.dataset.foldItUpAnswer === '1',
          text: (node.innerText ?? '').replace(/\\s+/gu, ' ').trim().slice(0, 70),
        })),
      tail: mine.some(node => node.dataset.chatFlowKind === 'turn-tail'),
    }
  }
  const tick = () => {
    try { samples.push(snap()) } catch (error) { samples.push({ error: String(error) }) }
    if (samples.length > 4000) samples.splice(0, 1000)
    globalThis.__FOLDITUP_STREAM_TIMER__ = setTimeout(tick, 60)
  }
  tick()
  return true
})()`

await send('Page.addScriptToEvaluateOnNewDocument', { source: SAMPLER })
await send('Page.navigate', { url: args.url })
await sleep(9000)

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
  await send('Input.insertText', { text: args.text ?? 'hi' })
  await sleep(600)
  for (const type of ['keyDown', 'keyUp']) {
    await send('Input.dispatchKeyEvent', {
      type, key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13, nativeVirtualKeyCode: 13, text: '\r',
    })
  }
  console.log('submitted; sampling…')

  const waitSeconds = Number(args.wait ?? 180)
  const started = Date.now()
  let lastRows = -1
  let quiet = 0
  while ((Date.now() - started) / 1000 < waitSeconds) {
    await sleep(2000)
    const state = await evaluate(`(() => {
      const flow = [...document.querySelectorAll('[data-chat-flow-kind]')]
      const turns = [...new Set(flow.map(node => Number(node.dataset.chatTurn)).filter(Number.isFinite))]
      const last = turns.length === 0 ? null : Math.max(...turns)
      const mine = flow.filter(node => Number(node.dataset.chatTurn) === last)
      return {
        rows: flow.length,
        tail: mine.some(node => node.dataset.chatFlowKind === 'turn-tail'),
        busy: [...document.querySelectorAll('button')].some(node => /停止|Stop/i.test(node.textContent ?? '')),
        controllers: [...document.querySelectorAll('[data-turn-process]')].length,
        hidden: flow.filter(node => node.hasAttribute('hidden')).length,
        assistants: mine.filter(node => node.dataset.chatFlowKind === 'assistant-step').map(node => ({
          hidden: node.hasAttribute('hidden'),
          visibleChars: (node.innerText ?? '').trim().length,
        })),
      }
    })()`)
    console.log(`  t+${String(Math.round((Date.now() - started) / 1000))}s rows=${String(state.rows)} tail=${String(state.tail)} busy=${String(state.busy)} controllers=${String(state.controllers)} hidden=${String(state.hidden)} assistants=${JSON.stringify(state.assistants)}`)
    if (state.tail && !state.busy) {
      quiet += 1
      if (quiet >= 2) break
    } else quiet = 0
    lastRows = state.rows
    void lastRows
  }
  await sleep(2500)
}

const stream = await evaluate(`(() => {
  clearTimeout(globalThis.__FOLDITUP_STREAM_TIMER__)
  return globalThis.__FOLDITUP_STREAM__ ?? []
})()`)

// Collapse the sample ring into the runs that matter: which frames had rows
// hidden, which had a controller, and whether the turn had closed.
const runs = []
for (const sample of stream) {
  if (sample === undefined || sample.error !== undefined) continue
  const key = `${String(sample.tail)}|${String(sample.controllers)}|${String(sample.hiddenLast)}|${String(sample.byKind['assistant-step'] ?? 0)}`
  const previous = runs.at(-1)
  if (previous !== undefined && previous.key === key) {
    previous.until = sample.t
    previous.samples += 1
    continue
  }
  runs.push({
    key,
    tail: sample.tail,
    controllers: sample.controllers,
    hiddenLast: sample.hiddenLast,
    assistantRows: sample.byKind['assistant-step'] ?? 0,
    rows: sample.rows,
    from: sample.t,
    until: sample.t,
    samples: 1,
    assistants: sample.assistantLast,
    liveControllers: sample.liveControllers,
  })
}

const report = {
  samples: stream.length,
  runs,
  // The defect, stated as a predicate over the timeline: a controller exists and
  // hides rows while the newest turn has not published its tail yet.
  premature: runs.filter(run => run.tail === false && run.controllers > 0 && run.hiddenLast > 0),
}

// Two assertions, and both are needed: the first is the reported defect, the
// second keeps it from passing vacuously on a run that never folded at all.
const failures = []
const closedRun = runs.filter(run => run.tail === true && run.controllers > 0 && run.hiddenLast > 0)
if (report.premature.length > 0) {
  failures.push(`${String(report.premature.length)} segment(s) folded while the turn was still running`)
}
if (closedRun.length === 0) {
  failures.push('the turn never folded after closing — the run proves nothing about the fix')
}
report.failures = failures

const out = `${JSON.stringify(report, null, 1)}\n`
if (typeof args.report === 'string') writeFileSync(args.report, out)
console.log(out)
for (const failure of failures) console.error(`FAIL ${failure}`)
if (failures.length === 0) console.log('OK — nothing folded before the turn closed')
else process.exitCode = 1

socket.close()
edge.kill()
await sleep(300)
await rm(dir, { recursive: true, force: true }).catch(() => {})
