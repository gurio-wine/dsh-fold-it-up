#!/usr/bin/env node
/**
 * Composer driver probe: type one message into the running Web instance through
 * the browser's own input pipeline and report how it is submitted.
 *
 * Usage: node tools/probe-ask.mjs --url <authenticated-url> --text "hi" [--port 9250]
 */
import { spawn } from 'node:child_process'
import { existsSync } from 'node:fs'
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
  args[token.slice(2)] = process.argv[index + 1]
  index += 1
}

const port = Number(args.port ?? 9250)
const dir = await mkdtemp(join(tmpdir(), 'dsh-ask-'))
const edge = spawn(EDGE, [
  '--headless=new', `--remote-debugging-port=${String(port)}`, `--user-data-dir=${dir}`,
  '--no-first-run', '--window-size=1500,1400', 'about:blank',
], { stdio: 'ignore' })

let ws
for (let attempt = 0; attempt < 60; attempt += 1) {
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
await send('Page.navigate', { url: args.url })
await sleep(7000)

const composer = `[...document.querySelectorAll('[role="textbox"]')].find(node => node.offsetParent !== null) ?? null`
const before = await evaluate(`(() => {
  const field = ${composer}
  return field === null ? null : { html: field.innerHTML.slice(0, 80), text: (field.textContent ?? '').slice(0, 40) }
})()`)
console.log('composer before:', JSON.stringify(before))

const focus = await evaluate(`(() => {
  const field = ${composer}
  if (field === null) return null
  field.focus()
  const rect = field.getBoundingClientRect()
  return { x: Math.round(rect.x + 10), y: Math.round(rect.y + rect.height / 2) }
})()`)
if (focus === null) {
  console.error('no composer')
  process.exitCode = 1
} else {
  await send('Input.dispatchMouseEvent', { type: 'mousePressed', x: focus.x, y: focus.y, button: 'left', clickCount: 1 })
  await send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: focus.x, y: focus.y, button: 'left', clickCount: 1 })
  await send('Input.insertText', { text: args.text ?? 'hi' })
  await sleep(700)
  const typed = await evaluate(`(() => {
    const field = ${composer}
    return field === null ? null : { html: field.innerHTML.slice(0, 100), text: (field.textContent ?? '').slice(0, 40) }
  })()`)
  console.log('composer after typing:', JSON.stringify(typed))
  const senders = await evaluate(`[...document.querySelectorAll('button')].map(node => ({
    text: (node.textContent ?? '').trim().slice(0, 20),
    label: node.getAttribute('aria-label'),
    disabled: node.disabled,
    cls: typeof node.className === 'string' ? node.className.slice(0, 30) : '',
  })).filter(node => node.label !== null || node.text === '' || /发送|send/i.test(node.text)).slice(0, 12)`)
  console.log('candidate submit controls:', JSON.stringify(senders, null, 1))
  // Submit: Enter first, then the send control if the composer still holds text.
  for (const type of ['keyDown', 'keyUp']) {
    await send('Input.dispatchKeyEvent', {
      type, key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13, nativeVirtualKeyCode: 13, text: '\r',
    })
  }
  await sleep(2500)
  const after = await evaluate(`(() => {
    const field = ${composer}
    return {
      text: field === null ? null : (field.textContent ?? '').slice(0, 40),
      rows: document.querySelectorAll('[data-chat-flow-kind]').length,
      busy: [...document.querySelectorAll('button')].some(node => /停止|Stop/i.test(node.textContent ?? '')),
      body: (document.body.innerText ?? '').slice(0, 200),
    }
  })()`)
  console.log('after Enter:', JSON.stringify(after, null, 1))
  // Wait for the turn to close: the fold only exists once the Turn has a
  // finalized answer and its seats carry their shipped marks.
  let settled = null
  for (let attempt = 0; attempt < 90; attempt += 1) {
    await sleep(1000)
    settled = await evaluate(`(() => {
      const flow = [...document.querySelectorAll('[data-chat-flow-kind]')]
      for (const seat of flow) {
        const row = seat.querySelector('[data-turn-process]')
        if (row === null) continue
        const turn = Number(row.dataset.turnProcess)
        const scope = flow.filter(node => node.contains(row) || row.contains(node)
          || node.parentElement?.contains(row))
        void scope
        if (turn > 0) return { rows: flow.length, turn }
      }
      return null
    })()`)
    if (settled !== null) break
  }
  console.log('disclosure appeared:', JSON.stringify(settled))
  await sleep(1500)
  const final = await evaluate(`(() => {
    const flow = [...document.querySelectorAll('[data-chat-flow-kind]')]
    const controllers = [...document.querySelectorAll('[data-turn-process]')].map(node => {
      let seat = node
      while (seat !== null && !seat.hasAttribute?.('data-chat-flow-kind')) seat = seat.parentElement
      return {
        turn: node.dataset.turnProcess,
        open: node.hasAttribute('data-open'),
        seatHidden: seat?.hasAttribute('hidden') ?? null,
        label: (node.textContent ?? '').replace(/\\s+/gu, ' ').trim().slice(0, 50),
      }
    })
    return {
      controllers,
      rows: flow.map((element, index) => ({
        index,
        kind: element.dataset.chatFlowKind,
        turn: element.dataset.chatTurn ?? null,
        owner: element.dataset.folditupTurn ?? null,
        member: element.hasAttribute('data-turn-process-member'),
        hidden: element.getAttribute('hidden'),
        foldAnswer: element.dataset.foldItUpAnswer === '1',
        seq: element.dataset.folditupSeq ?? null,
        text: (element.textContent ?? '').replace(/\\s+/gu, ' ').trim().slice(0, 60),
      })),
      logs: (globalThis.__FOLDITUP_LOGS__ ?? []).slice(0, 5),
    }
  })()`)
  console.log(JSON.stringify(final, null, 1))
}

socket.close()
edge.kill()
await sleep(300)
await rm(dir, { recursive: true, force: true }).catch(() => {})
