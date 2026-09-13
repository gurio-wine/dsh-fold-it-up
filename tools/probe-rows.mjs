#!/usr/bin/env node
/**
 * DOM discovery probe: print every rendered Chat flow row of one session with
 * the attributes the fold logic reads, grouped by Turn.
 *
 * Usage: node tools/probe-rows.mjs --url <authenticated-url> --session <id> [--port 9231] [--report file]
 */
import { spawn } from 'node:child_process'
import { existsSync } from 'node:fs'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { setTimeout as sleep } from 'node:timers/promises'

const EDGE_CANDIDATES = [
  'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
  'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
]

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
  console.error('usage: node tools/probe-rows.mjs --url <authenticated-url> --session <id>')
  process.exit(2)
}
const debugPort = Number(args.port ?? 9231)

async function connect(url) {
  const socket = new WebSocket(url)
  const pending = new Map()
  const events = []
  let nextId = 1
  socket.addEventListener('message', (event) => {
    const message = JSON.parse(event.data)
    if (message.id === undefined) {
      events.push(message)
      return
    }
    const entry = pending.get(message.id)
    if (entry === undefined) return
    pending.delete(message.id)
    if (message.error !== undefined) entry.reject(new Error(JSON.stringify(message.error)))
    else entry.resolve(message.result)
  })
  await new Promise((resolve, reject) => {
    socket.addEventListener('open', resolve, { once: true })
    socket.addEventListener('error', () => reject(new Error('debugger socket failed')), { once: true })
  })
  return {
    events,
    close: () => socket.close(),
    send(method, params = {}, sessionId) {
      const id = nextId++
      const message = { id, method, params }
      if (sessionId !== undefined) message.sessionId = sessionId
      socket.send(JSON.stringify(message))
      return new Promise((resolve, reject) => pending.set(id, { resolve, reject }))
    },
  }
}

async function debuggerUrl(port) {
  for (let attempt = 0; attempt < 60; attempt += 1) {
    try {
      const response = await fetch(`http://127.0.0.1:${String(port)}/json/version`)
      const body = await response.json()
      if (typeof body.webSocketDebuggerUrl === 'string') return body.webSocketDebuggerUrl
    } catch {
      // not up yet
    }
    await sleep(250)
  }
  throw new Error(`no DevTools endpoint on port ${String(port)}`)
}

const main = async () => {
  const userDataDir = await mkdtemp(join(tmpdir(), 'dsh-probe-rows-'))
  const edge = spawn(EDGE_CANDIDATES.find(candidate => existsSync(candidate)), [
    '--headless=new',
    `--remote-debugging-port=${String(debugPort)}`,
    `--user-data-dir=${userDataDir}`,
    '--no-first-run', '--no-default-browser-check', '--disable-extensions',
    '--window-size=1400,1400', 'about:blank',
  ], { stdio: 'ignore' })
  let client
  try {
    client = await connect(await debuggerUrl(debugPort))
    const { targetId } = await client.send('Target.createTarget', { url: 'about:blank' })
    const { sessionId } = await client.send('Target.attachToTarget', { targetId, flatten: true })
    const send = (method, params) => client.send(method, params, sessionId)
    const evaluate = async (expression) => {
      const result = await send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true })
      if (result.exceptionDetails !== undefined) {
        throw new Error(`page error: ${result.exceptionDetails.text ?? ''} ${JSON.stringify(result.exceptionDetails.exception?.description ?? '')}`)
      }
      return result.result.value
    }
    await send('Page.enable')
    await send('Runtime.enable')
    await send('Page.addScriptToEvaluateOnNewDocument', {
      source: `try { localStorage.setItem('dsh.sessions.current', ${JSON.stringify(JSON.stringify({ sessionId: args.session ?? '' }))}) } catch {}`,
    })
    await send('Page.navigate', { url: args.url })
    await sleep(4000)
    if (typeof args.session === 'string') {
      await send('Page.reload')
      await sleep(4000)
    }
    // Open a session by a substring of its sidebar row when asked. The app has
    // no page-reachable session router, so the row is the only handle a probe
    // has on a session other than the current one.
    if (typeof args.open === 'string') {
      if (args.list === true) {
        console.log(JSON.stringify(await evaluate(`[...document.querySelectorAll('[role="treeitem"]')].map(node => ({
          text: (node.textContent ?? '').trim().slice(0, 70),
          expanded: node.getAttribute('aria-expanded'),
        }))`), null, 1))
      }
      const opened = await evaluate(`(() => {
        const target = [...document.querySelectorAll('[role="treeitem"]')]
          .find(node => (node.textContent ?? '').includes(${JSON.stringify(args.open)}))
        if (target === undefined) {
          return { ok: false, rows: [...document.querySelectorAll('[role="treeitem"]')].map(node => (node.textContent ?? '').trim().slice(0, 40)) }
        }
        target.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, view: window }))
        return { ok: true }
      })()`)
      if (opened.ok !== true) {
        console.error('session row not found:', JSON.stringify(opened))
        process.exitCode = 1
        return
      }
      await sleep(5000)
    }
    // Drive one real turn in this instance. A session the app itself created is
    // the only kind a probe can rely on being reachable, and a completed turn is
    // the only state in which the fold is observable at all.
    if (typeof args.ask === 'string') {
      const composer = `(() => {
        const candidates = [...document.querySelectorAll('textarea, [contenteditable="true"], input[type="text"]')]
        return candidates.find(node => node.offsetParent !== null) ?? null
      })()`
      const started = await evaluate(`(() => {
        const button = [...document.querySelectorAll('button')].find(node => /新会话|New session/i.test(node.textContent ?? ''))
        if (button === undefined) return false
        button.click()
        return true
      })()`)
      if (!started) {
        console.error('no new-session control')
        process.exitCode = 1
        return
      }
      await sleep(2500)
      // Type through the browser's own input pipeline, not a synthetic event:
      // the composer is a `contenteditable` div owned by a rich editor, and a
      // dispatched `input` event alone leaves it empty.
      const focus = await evaluate(`(() => {
        const field = ${composer}
        if (field === null) return null
        field.focus()
        const rect = field.getBoundingClientRect()
        return { x: Math.round(rect.x + 8), y: Math.round(rect.y + rect.height / 2) }
      })()`)
      if (focus === null) {
        console.error('no composer field')
        process.exitCode = 1
        return
      }
      await send('Input.dispatchMouseEvent', { type: 'mousePressed', x: focus.x, y: focus.y, button: 'left', clickCount: 1 })
      await send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: focus.x, y: focus.y, button: 'left', clickCount: 1 })
      await send('Input.insertText', { text: args.ask })
      await sleep(500)
      for (const type of ['keyDown', 'keyUp']) {
        await send('Input.dispatchKeyEvent', {
          type,
          key: 'Enter',
          code: 'Enter',
          windowsVirtualKeyCode: 13,
          nativeVirtualKeyCode: 13,
          text: '\r',
        })
      }
      // Wait for the turn to run and close: the fold only exists once it has.
      let closed = false
      for (let attempt = 0; attempt < 120; attempt += 1) {
        await sleep(1000)
        const state = await evaluate(`(() => {
          const flow = [...document.querySelectorAll('[data-chat-flow-kind]')]
          return {
            rows: flow.length,
            assistants: flow.filter(node => node.dataset.chatFlowKind === 'assistant-step').length,
            controllers: document.querySelectorAll('[data-turn-process]').length,
            busy: [...document.querySelectorAll('button')].some(node => /停止|Stop/i.test(node.textContent ?? '')),
          }
        })()`)
        if (state.rows > 0 && state.controllers > 0 && !state.busy) {
          closed = true
          break
        }
      }
      console.log(JSON.stringify({ asked: args.ask, closed }))
      await sleep(1500)
    }
    // Wait for rows.
    for (let attempt = 0; attempt < 30; attempt += 1) {
      const count = await evaluate(`document.querySelectorAll('[data-chat-flow-kind]').length`)
      if (count > 0) break
      await sleep(500)
    }
    if (args.scroll === true) {
      const scroller = `(() => {
        let node = document.querySelector('[data-chat-flow-kind]')?.parentElement
        while (node !== null && node !== document.body) {
          const style = getComputedStyle(node)
          if (style.overflowY === 'auto' || style.overflowY === 'scroll') return node
          node = node.parentElement
        }
        return null
      })()`
      for (let round = 0; round < 12; round += 1) {
        const more = await evaluate(`(() => {
          const scroller = ${scroller}
          if (scroller === null) return false
          const button = [...document.querySelectorAll('button')].find(node => /load|earlier|更早/i.test(node.textContent ?? ''))
          scroller.scrollTop = 0
          if (button === undefined) return false
          button.click()
          return true
        })()`)
        await sleep(1200)
        if (more !== true) break
      }
    }
    const report = await evaluate(`(() => {
      const flow = [...document.querySelectorAll('[data-chat-flow-kind]')]
      return {
        total: flow.length,
        rows: flow.map((element, index) => ({
          index,
          kind: element.dataset.chatFlowKind,
          turn: element.dataset.chatTurn ?? null,
          key: element.dataset.chatAnchorKey ?? null,
          member: element.hasAttribute('data-turn-process-member'),
          processHidden: element.hasAttribute('data-turn-process-hidden'),
          answerMark: element.dataset.turnProcessAnswer === '1',
          hidden: element.getAttribute('hidden'),
          foldAnswer: element.dataset.foldItUpAnswer === '1',
          seq: element.dataset.folditupSeq ?? null,
          text: (element.textContent ?? '').replace(/\\s+/gu, ' ').trim().slice(0, 70),
        })),
        controllers: [...document.querySelectorAll('[data-turn-process]')].map(node => {
          let seat = node
          while (seat !== null && !seat.hasAttribute?.('data-chat-flow-kind')) seat = seat.parentElement
          return {
            turn: node.dataset.turnProcess ?? null,
            seatKind: seat?.dataset?.chatFlowKind ?? null,
            seatTurn: seat?.dataset?.chatTurn ?? null,
            hidden: seat?.hasAttribute('hidden') ?? null,
            text: (node.textContent ?? '').replace(/\\s+/gu, ' ').trim().slice(0, 60),
          }
        }),
        trace: (globalThis.__FOLDITUP__?.events ?? []).slice(-8),
        logs: (globalThis.__FOLDITUP_LOGS__ ?? []).slice(0, 5),
      }
    })()`)
    console.log(JSON.stringify(report, null, 1))
    if (typeof args.report === 'string') {
      const { writeFileSync } = await import('node:fs')
      writeFileSync(args.report, `${JSON.stringify(report, null, 2)}\n`)
    }
  } catch (error) {
    console.error('probe failed:', error)
    process.exitCode = 1
  } finally {
    client?.close()
    edge.kill()
    await sleep(400)
    await rm(userDataDir, { recursive: true, force: true }).catch(() => {})
  }
}

await main()
