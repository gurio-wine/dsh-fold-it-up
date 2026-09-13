#!/usr/bin/env node
/**
 * Route probe: how does the running Web app address one session?
 *
 * The verifiers want to open a KNOWN session (a long answer already in the log)
 * instead of paying for a fresh task each run. Whether that is a path, a query,
 * or a click on the sidebar is a property of the app shell, so this dumps the
 * evidence rather than guessing: the startup URL, the document's own location
 * after the shell brings a session up, and every same-origin link and
 * session-shaped attribute/id in the document.
 *
 * Usage: node tools/probe-routes.mjs --url <authenticated-url> [--port 9279] [--click]
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
  const next = process.argv[index + 1]
  if (next === undefined || next.startsWith('--')) args[token.slice(2)] = true
  else {
    args[token.slice(2)] = next
    index += 1
  }
}
if (typeof args.url !== 'string') {
  console.error('usage: node tools/probe-routes.mjs --url <authenticated-url> [--click]')
  process.exit(2)
}
const port = Number(args.port ?? 9279)

const dir = await mkdtemp(join(tmpdir(), 'dsh-routes-'))
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

/** Requests the shell makes, so an unguessable route shows up as a URL. */
const seen = []
const requests = []
await send('Network.enable')
await send('Page.enable')
await send('Runtime.enable')

// A session the app never puts in its URL is still reachable: the shell keeps
// its active session in `localStorage['dsh.sessions.current']` and opens it on
// boot, which is how every probe opens a KNOWN conversation.
if (typeof args.session === 'string') {
  await send('Page.addScriptToEvaluateOnNewDocument', {
    source: `try { localStorage.setItem('dsh.sessions.current', ${JSON.stringify(JSON.stringify({ sessionId: `session-${args.session}` }))}) } catch {}`,
  })
}

await send('Page.navigate', { url: args.url })
await sleep(10000)

const shape = await evaluate(`(() => {
  const keys = []
  try {
    for (let index = 0; index < localStorage.length; index += 1) {
      const key = localStorage.key(index)
      const value = localStorage.getItem(key) ?? ''
      keys.push({ key, value: value.slice(0, 120) })
    }
  } catch (error) { keys.push({ key: 'error', value: String(error) }) }
  const links = [...document.querySelectorAll('a[href]')].map(node => node.getAttribute('href'))
  const ids = [...document.querySelectorAll('[data-session-id],[data-session],[id*="session"]')]
    .slice(0, 8)
    .map(node => ({ tag: node.tagName, id: node.id, attrs: [...node.attributes].map(a => a.name + '=' + a.value).slice(0, 5) }))
  const classes = [...new Set([...document.querySelectorAll('[class*="session"],[class*="Session"]')]
    .flatMap(node => [...node.classList].filter(name => /session/i.test(name))))].slice(0, 10)
  return {
    href: location.href,
    hash: location.hash,
    storage: keys,
    dataAttrs: [...document.querySelectorAll('*')]
      .flatMap(node => [...node.attributes].map(a => a.name))
      .filter(name => /session/i.test(name))
      .slice(0, 10),
    links: [...new Set(links)].slice(0, 10),
    ids,
    classes,
    rows: document.querySelectorAll('[data-chat-flow-kind]').length,
  }
})()`)
console.log('=== document shape ===')
console.log(JSON.stringify(shape, null, 1))

const sidebar = await evaluate(`(() => {
  const rows = [...document.querySelectorAll('*')]
    .filter(node => typeof node.className === 'string' && /sessionRow|_session/i.test(node.className) && node.offsetParent !== null)
  return rows.slice(0, 12).map(node => ({
    tag: node.tagName,
    cls: node.className.slice(0, 40),
    text: (node.innerText ?? '').replace(/\\s+/gu, ' ').trim().slice(0, 40),
    // Row text is the only handle a probe has on a session the app never puts in
    // the URL, so whatever is clickable inside it is recorded here.
    controls: [...node.querySelectorAll('[role="button"],button')]
      .map(child => (child.getAttribute('aria-label') ?? String(child.className)).slice(0, 30)),
  }))
})()`)
console.log('=== session rows in the sidebar ===')
console.log(JSON.stringify(sidebar, null, 1))

if (args.click === true) {
  const clicked = await evaluate(`(() => {
    const candidate = [...document.querySelectorAll('button,a,li,div')]
      .filter(node => node.offsetParent !== null && /会话|session/i.test(node.textContent ?? ''))
      .map(node => ({ node, text: (node.textContent ?? '').replace(/\\s+/gu, ' ').trim().slice(0, 40) }))
      .filter(entry => entry.text.length > 0)
      .sort((left, right) => left.text.length - right.text.length)[0]
    if (candidate === undefined) return null
    candidate.node.click()
    return candidate.text
  })()`)
  console.log('=== clicked ===')
  console.log(JSON.stringify(clicked))
  await sleep(4000)
  const after = await evaluate(`({ href: location.href, hash: location.hash, rows: document.querySelectorAll('[data-chat-flow-kind]').length })`)
  console.log(JSON.stringify(after, null, 1))
}

socket.close()
edge.kill()
await sleep(300)
await rm(dir, { recursive: true, force: true }).catch(() => {})
void seen
void requests
