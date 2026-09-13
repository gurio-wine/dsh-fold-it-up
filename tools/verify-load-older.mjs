#!/usr/bin/env node
/**
 * Acceptance check for the rows the `chat.loadOlder` control brings in.
 *
 * This is the case that survives a naive implementation: the prepended page
 * commits into the DOM in chunks, so for a moment the transcript renders rows
 * the current Chat store snapshot does not describe. Deciding the fold from that
 * snapshot and applying it to the DOM unhides the rows it does not know about —
 * measured live, a Turn whose process grew from 94 to 116 rendered rows right
 * after its own pass left 102 of them visible.
 *
 * Each round reloads the page, clicks `chat.loadOlder` once, waits for the
 * prepend to commit, and then asserts two things about the transcript that
 * resulted:
 *
 *   - no Turn renders process rows while owning a disclosure control (the
 *     failure above), and no Turn renders a process with no control at all;
 *   - every folded Turn shows exactly one assistant row, so "nothing folded"
 *     cannot pass by producing an empty transcript.
 *
 * Usage:
 *   node tools/verify-load-older.mjs --url <url> --session <id>
 *                                    [--port 9227] [--rounds 3] [--trace]
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
if (typeof args.url !== 'string' || typeof args.session !== 'string') {
  console.error('usage: node tools/verify-load-older.mjs --url <url> --session <id> [--port 9227] [--rounds 3]')
  process.exit(2)
}
const debugPort = Number(args.port ?? 9227)
const rounds = Number(args.rounds ?? 3)

async function connect(url) {
  const socket = new WebSocket(url)
  const pending = new Map()
  let nextId = 1
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
    socket.addEventListener('error', () => reject(new Error('debugger socket failed')), { once: true })
  })
  return {
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
  throw new Error(`no DevTools endpoint on ${String(port)}`)
}

const STATE = String.raw`(() => {
  const columns = [...document.querySelectorAll('[data-chat-flow]')]
  const column = columns[0]
  if (column === undefined) return { error: 'no [data-chat-flow] column' }
  const flow = [...column.querySelectorAll('[data-chat-flow-kind]')]
  const independent = new Set(['system-prompt', 'user', 'steering', 'turn-error', 'turn-max-tokens', 'turn-tail'])
  // The Turn that governs each row: its own seat's, or the one the pass
  // attributed an injected-context row to. Context rows carry no Turn of their
  // own, so grouping by the seat attribute alone would drop them from every
  // measurement — which is how they stayed invisible to this check before.
  const ownerOf = element => element.dataset.folditupTurn === undefined
    ? (Number.isFinite(Number(element.dataset.chatTurn)) ? Number(element.dataset.chatTurn) : null)
    : Number(element.dataset.folditupTurn)
  const controllers = new Set()
  for (const marker of column.querySelectorAll('[data-turn-process]')) {
    let node = marker
    while (node !== null && !node.hasAttribute?.('data-chat-flow-kind')) {
      node = node.parentElement
    }
    if (node !== null) controllers.add(Number(node.dataset.chatTurn))
  }
  const turns = [...new Set(flow.map(ownerOf))].filter(Number.isFinite)
  return {
    flow: flow.length,
    // Every transcript column the page holds, so a stale or duplicated column
    // shows up as its own row instead of hiding behind the first one.
    columns: columns.map(node => {
      const items = [...node.querySelectorAll('[data-chat-flow-kind]')]
      return {
        total: items.length,
        stamped: items.filter(element => element.dataset.folditupSeq !== undefined).length,
        turns: [...new Set(items.map(ownerOf))].filter(Number.isFinite),
        connected: node.isConnected,
        classes: typeof node.className === 'string' ? node.className.slice(0, 28) : '',
      }
    }),
    older: (() => {
      const button = [...document.querySelectorAll('button')]
        .find(candidate => /加载更早|Load earlier/i.test(candidate.textContent ?? ''))
      return button === undefined ? null : { disabled: button.disabled }
    })(),
    turns: turns.map((turn) => {
      const mine = flow.filter(element => ownerOf(element) === turn)
      const assistants = mine.filter(element => element.dataset.chatFlowKind === 'assistant-step')
      const contexts = mine.filter(element => element.dataset.chatFlowKind === 'context')
      const visibleProcess = mine.filter(element => !element.hasAttribute('hidden')
        && !independent.has(element.dataset.chatFlowKind)
        && element.dataset.chatFlowKind !== 'turn-process'
        && element.dataset.foldItUpAnswer !== '1')
      return {
        turn,
        rows: mine.length,
        hasController: controllers.has(turn),
        members: mine.filter(element => element.dataset.turnProcessMember !== undefined).length,
        kinds: [...new Set(mine.map(element => element.dataset.chatFlowKind))].join(','),
        contexts: contexts.length,
        visibleContexts: contexts.filter(element => !element.hasAttribute('hidden')).length,
        hidden: mine.filter(element => element.hasAttribute('hidden')).length,
        stamped: mine.filter(element => element.dataset.folditupSeq !== undefined).length,
        answers: mine.filter(element => element.dataset.foldItUpAnswer === '1').length,
        visibleAssistants: assistants.filter(element => !element.hasAttribute('hidden')).length,
        visibleProcess: visibleProcess.length,
        sample: visibleProcess.slice(0, 3).map(element => element.dataset.chatFlowKind + '#' + String(element.dataset.folditupSeq ?? '?')),
      }
    }),
  }
})()`

/** Turns that are closed, own a control, and still show process rows. */
function stuck(state) {
  return (state.turns ?? []).filter(turn => turn.rows > 2 && turn.hasController
    && turn.visibleProcess > 0)
}

/**
 * Turns that render a process but no disclosure row at all.
 *
 * A missing control is the other way this can fail silently: the rows stay
 * visible AND there is no way to fold them by hand.
 */
function uncontrolled(state) {
  return (state.turns ?? []).filter(turn => turn.rows > 2 && !turn.hasController)
}

const main = async () => {
  const userDataDir = await mkdtemp(join(tmpdir(), 'dsh-folditup-assert-'))
  const edge = spawn(EDGE_CANDIDATES.find(candidate => existsSync(candidate)), [
    '--headless=new',
    `--remote-debugging-port=${String(debugPort)}`,
    `--user-data-dir=${userDataDir}`,
    '--no-first-run', '--no-default-browser-check', '--disable-extensions',
    '--window-size=1400,1000', 'about:blank',
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
        throw new Error(`page error: ${result.exceptionDetails.text ?? ''}`)
      }
      return result.result.value
    }
    await send('Page.enable')
    await send('Runtime.enable')
    await send('Page.addScriptToEvaluateOnNewDocument', {
      source: `(() => {
        const log = []
        globalThis.__FOLDITUP_LOGS__ = log
        for (const level of ['error', 'warn']) {
          const original = console[level].bind(console)
          console[level] = (...list) => { try { log.push(level + ': ' + list.map(String).join(' ')) } catch {} ; original(...list) }
        }
        addEventListener('error', event => log.push('window: ' + event.message))
        addEventListener('unhandledrejection', event => log.push('rejection: ' + String(event.reason)))
        // Mount census: how many times the disclosure component body ran, and how
        // many times a fold pass ran. Both zero means the row never mounted.
        globalThis.__FOLDITUP_CENSUS__ = { mounts: 0, passes: 0, binds: 0 }
      })()`,
    })
    await send('Page.addScriptToEvaluateOnNewDocument', {
      source: `try { localStorage.setItem('dsh.sessions.current', ${JSON.stringify(JSON.stringify({ sessionId: args.session }))}) } catch {}`,
    })
    await send('Page.navigate', { url: args.url })
    await sleep(2500)
    await evaluate(`localStorage.setItem('dsh.sessions.current', ${JSON.stringify(JSON.stringify({ sessionId: args.session }))})`)
    await send('Page.reload')
    await sleep(3000)
    for (let attempt = 0; attempt < 40; attempt += 1) {
      if (await evaluate(`document.querySelectorAll('[data-chat-flow-kind]').length`) > 0) break
      await sleep(500)
    }
    await sleep(1500)

    const report = { rounds: [], failures: [] }
    for (let round = 1; round <= rounds; round += 1) {
      const before = await evaluate(STATE)
      const clicked = await evaluate(`(() => {
        const button = [...document.querySelectorAll('button')]
          .find(candidate => /加载更早|Load earlier/i.test(candidate.textContent ?? ''))
        if (button === undefined || button.disabled) return false
        button.scrollIntoView({ block: 'center' })
        button.click()
        return true
      })()`)
      if (!clicked) {
        report.rounds.push({ round, skipped: 'no load-earlier control' })
        break
      }
      const start = await evaluate(`document.querySelectorAll('[data-chat-flow-kind]').length`)
      for (let attempt = 0; attempt < 60; attempt += 1) {
        await sleep(300)
        if (await evaluate(`document.querySelectorAll('[data-chat-flow-kind]').length`) > start) break
      }
      await sleep(2000)
      const after = await evaluate(STATE)
      await sleep(2500)
      const settled = await evaluate(STATE)
      const entry = {
        round,
        before: { flow: before.flow, turns: before.turns },
        after: { flow: after.flow, stuck: stuck(after), turns: after.turns },
        settled: { flow: settled.flow, stuck: stuck(settled), uncontrolled: uncontrolled(settled), turns: settled.turns },
      }
      report.rounds.push(entry)
      if (round === 1 && args.trace === true) {
        report.trace = await evaluate(`(globalThis.__FOLDITUP__?.events ?? []).slice(-24)`)
      }
      for (const turn of entry.settled.stuck) {
        report.failures.push(`round ${String(round)}: turn ${String(turn.turn)} leaves ${String(turn.visibleProcess)} process row(s) visible (${turn.sample.join(', ')}); hidden ${String(turn.hidden)}/${String(turn.rows)}`)
      }
      for (const turn of entry.settled.uncontrolled) {
        report.failures.push(`round ${String(round)}: turn ${String(turn.turn)} rendered ${String(turn.rows)} rows with no disclosure control`)
      }
      // The positive invariant, so an empty DOM cannot pass by producing nothing
      // to complain about: a folded turn shows exactly one assistant row, and no
      // injected-context row of a folded turn is left on screen.
      for (const turn of (settled.turns ?? []).filter(item => item.rows > 2 && item.hasController)) {
        if (turn.visibleAssistants > 1) {
          report.failures.push(`round ${String(round)}: turn ${String(turn.turn)} shows ${String(turn.visibleAssistants)} assistant rows, expected the answer alone`)
        }
        if (turn.hidden > 0 && turn.visibleContexts > 0) {
          report.failures.push(`round ${String(round)}: turn ${String(turn.turn)} leaves ${String(turn.visibleContexts)}/${String(turn.contexts)} injected-context row(s) visible while folded`)
        }
      }
      // Next round starts from a clean page so each measurement is independent.
      await send('Page.reload')
      await sleep(3000)
      for (let attempt = 0; attempt < 40; attempt += 1) {
        if (await evaluate(`document.querySelectorAll('[data-chat-flow-kind]').length`) > 0) break
        await sleep(500)
      }
      await sleep(1500)
    }
    report.console = (await evaluate('globalThis.__FOLDITUP_LOGS__ ?? []')).slice(0, 8)
    console.log(JSON.stringify(report, null, 2))
    if (typeof args.report === 'string') {
      const { writeFileSync } = await import('node:fs')
      writeFileSync(args.report, `${JSON.stringify(report, null, 2)}\n`)
    }
    console.log('')
    console.log(`${String(report.failures.length)} failure(s)`)
    if (report.failures.length > 0) process.exitCode = 1
  } finally {
    client?.close()
    edge.kill()
    await sleep(500)
    await rm(userDataDir, { recursive: true, force: true }).catch(() => {})
  }
}

await main()
