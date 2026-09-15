#!/usr/bin/env node
/**
 * Live acceptance check for dsh-fold-it-up against a running DSH Web instance.
 *
 * It drives a private headless Edge over the Chrome DevTools Protocol, loads a
 * real session, and reads the REAL DOM — the layer where the previous versions
 * of this feature were believed to work while the shipped fold was still in
 * charge. The decisive assertion is therefore not "the bundle arrived" but
 * "every finished turn's process rows carry the hidden attribute while the
 * answer row does not".
 *
 * Usage:
 *   node tools/verify-live.mjs --url <authenticated-url> [--port 9223]
 *                              [--session <id>] [--expect builtin|plugin]
 *
 * `--expect builtin` runs the same assertions inverted, which is how the
 * baseline (no plugin) is measured.
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

/** Parse `--flag value` pairs. */
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
  console.error('usage: node tools/verify-live.mjs --url <authenticated-url> [--port 9223] [--session <id>] [--expect builtin|plugin]')
  process.exit(2)
}
const debugPort = Number(args.port ?? 9223)
const expect = args.expect ?? 'plugin'

/** @returns the first installed Edge executable. */
function edgePath() {
  const found = EDGE_CANDIDATES.find(candidate => existsSync(candidate))
  if (found === undefined) throw new Error('Microsoft Edge not found')
  return found
}

/**
 * Open one WebSocket and return a minimal CDP client.
 * @param url - `ws://` debugger URL.
 * @returns `{ send, close, events }`.
 */
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
    if (message.error !== undefined) entry.reject(new Error(`${JSON.stringify(message.error)}`))
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
      // Page/Runtime domains live behind an attached target session; browser
      // domains (Target.*) are answered without one.
      if (sessionId !== undefined) message.sessionId = sessionId
      socket.send(JSON.stringify(message))
      return new Promise((resolve, reject) => pending.set(id, { resolve, reject }))
    },
  }
}

/**
 * Poll the DevTools endpoint until Edge is listening.
 * @param port - debugging port.
 * @returns the browser WebSocket URL.
 */
async function debuggerUrl(port) {
  for (let attempt = 0; attempt < 60; attempt += 1) {
    try {
      const response = await fetch(`http://127.0.0.1:${String(port)}/json/version`)
      const body = await response.json()
      if (typeof body.webSocketDebuggerUrl === 'string') return body.webSocketDebuggerUrl
    } catch {
      // Not listening yet.
    }
    await sleep(250)
  }
  throw new Error(`no DevTools endpoint on port ${String(port)}`)
}

/** Collected page-side helpers, injected as one expression. */
const PAGE_HELPERS = `
const rowsOf = () => [...document.querySelectorAll('[data-chat-flow-kind]')].map(element => ({
  kind: element.dataset.chatFlowKind,
  turn: Number(element.dataset.chatTurn),
  // The Turn whose disclosure governs the row. Injected context names none of
  // its own, so this stamp — written by the pass — is how a probe groups rows
  // the way the fold does.
  owner: element.dataset.folditupTurn === undefined ? null : Number(element.dataset.folditupTurn),
  member: element.hasAttribute('data-turn-process-member'),
  seq: element.dataset.folditupSeq ?? null,
  hidden: element.hasAttribute('hidden'),
  hiddenUntilFound: element.getAttribute('hidden') === 'until-found',
  answer: element.dataset.foldItUpAnswer === '1',
  label: (element.textContent ?? '').trim().slice(0, 40),
}))

/** The row that owns each turn's disclosure, whichever owner rendered it. */
const controllersOf = () => {
  const found = new Map()
  for (const marker of document.querySelectorAll('[data-turn-process]')) {
    const turn = Number(marker.dataset.turnProcess)
    if (!Number.isFinite(turn) || found.has(turn)) continue
    let node = marker
    while (node !== null && !node.hasAttribute?.('data-chat-flow-kind')) node = node.parentElement
    if (node !== null) found.set(turn, node)
  }
  return found
}
`

const main = async () => {
  const userDataDir = await mkdtemp(join(tmpdir(), 'dsh-folditup-edge-'))
  const edge = spawn(edgePath(), [
    '--headless=new',
    `--remote-debugging-port=${String(debugPort)}`,
    `--user-data-dir=${userDataDir}`,
    '--no-first-run',
    '--no-default-browser-check',
    '--disable-extensions',
    '--disable-features=msEdgeSidebarV2',
    '--window-size=1400,1000',
    'about:blank',
  ], { stdio: 'ignore' })

  let client
  try {
    client = await connect(await debuggerUrl(debugPort))
    const { targetId } = await client.send('Target.createTarget', { url: 'about:blank' })
    const { sessionId } = await client.send('Target.attachToTarget', { targetId, flatten: true })
    const send = (method, params) => client.send(method, params, sessionId)
    const evaluate = async (expression) => {
      const result = await send('Runtime.evaluate', {
        expression,
        awaitPromise: true,
        returnByValue: true,
      })
      if (result.exceptionDetails !== undefined) {
        throw new Error(`page error: ${result.exceptionDetails.text ?? ''} ${JSON.stringify(result.exceptionDetails.exception?.description ?? '')}`)
      }
      return result.result.value
    }

    await send('Page.enable')
    await send('Runtime.enable')
    // Capture everything from the first byte: a slot entry that crashes on its
    // first render reports through a boundary before a late listener attaches.
    await send('Page.addScriptToEvaluateOnNewDocument', {
      source: `(() => {
        const log = []
        globalThis.__FOLDITUP_LOGS__ = log
        const record = (level, args) => {
          try { log.push(level + ': ' + args.map(value => {
            if (value instanceof Error) return value.stack ?? value.message
            if (typeof value === 'string') return value
            try { return JSON.stringify(value) } catch { return String(value) }
          }).join(' ')) } catch {}
        }
        for (const level of ['error', 'warn']) {
          const original = console[level].bind(console)
          console[level] = (...args) => { record(level, args); original(...args) }
        }
        addEventListener('error', event => record('window', [event.message]))
        addEventListener('unhandledrejection', event => record('rejection', [event.reason]))
      })()`,
    })
    // Point the page at the session under test before the app boots.
    await send('Page.addScriptToEvaluateOnNewDocument', {
      source: `try { localStorage.setItem('dsh.sessions.current', ${JSON.stringify(JSON.stringify({ sessionId: args.session ?? '' }))}) } catch {}`,
    })
    await send('Page.navigate', { url: args.url })
    await sleep(2500)

    // The root URL carries the process token and redirects into the app; the
    // landed URL is what the boot graph was served for.
    const landed = await evaluate('location.href')
    if (typeof args.session === 'string') {
      await evaluate(`localStorage.setItem('dsh.sessions.current', ${JSON.stringify(JSON.stringify({ sessionId: args.session }))})`)
      await send('Page.reload')
      await sleep(2500)
    }

    // Discovery mode: print what the page actually rendered, then stop. Used to
    // learn the DOM vocabulary of a new DSH build instead of guessing at it.
    if (args.dump === true) {
      const dump = await evaluate(`(() => {
        const counts = {}
        for (const element of document.querySelectorAll('*')) {
          for (const attribute of element.attributes) {
            if (!attribute.name.startsWith('data-')) continue
            counts[attribute.name] = (counts[attribute.name] ?? 0) + 1
          }
        }
        return {
          title: document.title,
          rootChildren: document.getElementById('root')?.children.length ?? -1,
          bootPage: document.querySelector('[data-dsh-boot]')?.textContent?.slice(0, 200) ?? null,
          dataAttributes: counts,
          bodyText: (document.body.innerText ?? '').slice(0, 1200),
        }
      })()`)
      console.log(JSON.stringify(dump, null, 2))
      return
    }

    // Discovery mode: print the workspace/session sidebar rows and stop.
    if (args.list === true) {
      const listed = await evaluate(`(() => {
        const rows = []
        const walk = (node, depth) => {
          if (depth > 18) return
          if (node.nodeType === 1) {
            const text = (node.textContent ?? '').trim()
            const clickable = node.tagName === 'BUTTON' || node.getAttribute('role') !== null
              || node.onclick !== null || node.tabIndex >= 0
            if (text !== '' && text.length < 120 && clickable) {
              rows.push({
                depth,
                tag: node.tagName,
                role: node.getAttribute('role'),
                cls: typeof node.className === 'string' ? node.className.slice(0, 50) : '',
                text: text.slice(0, 60),
              })
            }
          }
          for (const child of node.childNodes ?? []) walk(child, depth + 1)
        }
        walk(document.body, 0)
        return rows.slice(0, 200)
      })()`)
      console.log(JSON.stringify({ landed, listed }, null, 2))
      return
    }

    // Open a session by its sidebar row text: expand the workspace tree, click
    // the matching session row, and wait for the transcript to materialize.
    if (typeof args.open === 'string') {
      const opened = await evaluate(`(() => {
        const byText = needle => [...document.querySelectorAll('[role="treeitem"]')]
          .find(node => (node.textContent ?? '').includes(needle))
        const target = byText(${JSON.stringify(args.open)})
        if (target === undefined) return { ok: false, reason: 'row not found', rows: [...document.querySelectorAll('[role="treeitem"]')].map(node => (node.textContent ?? '').trim().slice(0, 40)) }
        target.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, view: window }))
        return { ok: true }
      })()`)
      if (opened.ok !== true) {
        console.error(JSON.stringify(opened, null, 2))
        process.exitCode = 1
        return
      }
      await sleep(3000)
    }

    const boot = await evaluate(`(() => {
      const graph = window.__DSH_BOOT__
      if (graph === undefined) return { error: 'no __DSH_BOOT__' }
      return {
        entries: (graph.entries ?? []).map(entry => entry.id),
        batches: (graph.batches ?? []).length,
      }
    })()`)
    // Wait for the chat flow to materialize.
    let rows = []
    for (let attempt = 0; attempt < 40; attempt += 1) {
      rows = await evaluate(`(() => { ${PAGE_HELPERS}; return rowsOf() })()`)
      if (rows.some(row => row.kind === 'assistant-step')) break
      await sleep(500)
    }

    const inspected = await evaluate(`(() => {
      ${PAGE_HELPERS}
      const rows = rowsOf()
      const controllers = controllersOf()
      const turns = [...new Set(rows.map(row => row.turn))].filter(Number.isFinite)
      return {
        rows,
        turns: turns.map(turn => {
          // Rows the pass attributes to this Turn: its own seats plus the
          // injected-context rows it adopted.
          const mine = rows.filter(row => row.turn === turn || row.owner === turn)
          const controller = controllers.get(turn)
          const hidden = mine.filter(row => row.hidden)
          const assistants = mine.filter(row => row.kind === 'assistant-step')
          const independent = new Set(['system-prompt', 'user', 'steering', 'turn-error', 'turn-max-tokens', 'turn-tail'])
          const kept = new Set(['turn-process'])
          // A Turn that ended without an answer publishes no answer anchor, so
          // its first closing row is the fold boundary instead: rows below it
          // are the notice's own tail, not work the fold left unfolded. -1 means
          // the group has no closing row at all (still running).
          const firstClosing = mine.findIndex(row => row.kind === 'turn-error'
            || row.kind === 'turn-max-tokens'
            || row.kind === 'turn-tail')
          return {
            turn,
            rows: mine.length,
            contexts: mine.filter(row => row.kind === 'context').length,
            contextLeaks: mine.filter(row => row.kind === 'context' && !row.hidden).length,
            controllers: controller === undefined ? 0 : 1,
            label: controller === undefined ? '' : (controller.textContent ?? '').trim().slice(0, 60),
            controllerHidden: controller === undefined ? null : controller.hasAttribute('hidden'),
            hidden: hidden.length,
            hiddenUntilFound: hidden.filter(row => row.hiddenUntilFound).length,
            hiddenKinds: [...new Set(hidden.map(row => row.kind))],
            // How many rows the fold actually took away — the toggle check needs
            // it to tell "nothing came back" from "there was nothing to hide".
            foldedRows: hidden.length,
            answers: mine.filter(row => row.answer).length,
            assistants: assistants.length,
            visibleAssistant: assistants.filter(row => !row.hidden).length,
            leaks: mine
              .filter((row, index) => (firstClosing === -1 || index < firstClosing)
                && !row.hidden && !independent.has(row.kind) && !kept.has(row.kind) && row.answer !== true)
              .map(row => \`\${row.kind}#\${String(row.seq)}\`),
            firstClosing,
            errors: mine.filter(row => row.kind === 'turn-error' || row.kind === 'turn-max-tokens').length,
          }
        }),
      }
    })()`)

    const consoleErrors = [
      ...(await evaluate('globalThis.__FOLDITUP_LOGS__ ?? []')),
      ...client.events
        .filter(event => event.method === 'Runtime.exceptionThrown')
        .map(event => event.params.exceptionDetails?.exception?.description
          ?? event.params.exceptionDetails?.text
          ?? 'exception'),
      ...client.events
        .filter(event => event.method === 'Runtime.consoleAPICalled')
        .filter(event => event.params.type === 'error' || event.params.type === 'warning')
        .map(event => `${String(event.params.type)}: ${event.params.args
          .map(argument => argument.value ?? argument.description ?? '').join(' ')}`),
    ]

    const finalState = await evaluate(`(() => {
      ${PAGE_HELPERS}
      const rows = rowsOf()
      const flow = [...document.querySelectorAll('[data-chat-flow-kind]')]
      return {
        traceLength: (globalThis.__FOLDITUP__?.events ?? []).length,
        lastTrace: (globalThis.__FOLDITUP__?.events ?? []).slice(-3),
        hiddenNow: flow.filter(node => node.hasAttribute('hidden')).length,
        markNow: flow.filter(node => node.dataset.foldItUpAnswer === '1').length,
        controllersNow: (() => {
          ${PAGE_HELPERS}
          return controllersOf().size
        })(),
        firstRowKinds: flow.slice(0, 8).map(node => ({
          kind: node.dataset.chatFlowKind,
          key: node.dataset.chatAnchorKey,
          turn: node.dataset.chatTurn,
          hidden: node.hasAttribute('hidden'),
        })),
        rows,
      }
    })()`)

    const foldable = inspected.turns.filter(turn => turn.rows > 2)
    const failures = []
    const isPlugin = expect === 'plugin'
    for (const turn of foldable) {
      if (isPlugin) {
        if (turn.controllers === 0) failures.push(`turn ${String(turn.turn)}: no fold controller rendered`)
        if (turn.hidden === 0) failures.push(`turn ${String(turn.turn)}: nothing folded`)
        if (turn.hiddenUntilFound !== turn.hidden) {
          failures.push(`turn ${String(turn.turn)}: hidden rows do not use hidden="until-found"`)
        }
        // Which rows a Turn must keep readable is the fold's own decision, so
        // the assertions split on its marking rather than on the notice kinds:
        // a Turn that marked an answer keeps exactly that one row, while an
        // answerless fold — a Turn that ended on an error, on max tokens, or
        // interrupted without ever finalizing prose — marks nothing and keeps
        // nothing. (An error-ended Turn whose last finalized step was prose
        // still marks that answer, which is why the notice kinds alone cannot
        // pick the branch; an unmarked visible process row fails the leak check
        // either way.)
        if (turn.answers > 1) {
          failures.push(`turn ${String(turn.turn)}: ${String(turn.answers)} answer rows marked`)
        }
        if (turn.answers === 1 && turn.visibleAssistant !== 1) {
          failures.push(`turn ${String(turn.turn)}: ${String(turn.visibleAssistant)} assistant rows visible, expected the answer alone`)
        }
        // Either owner may render the row, but it IS the control: a hidden one
        // would strand the turn with no way back.
        if (turn.controllerHidden === true) {
          failures.push(`turn ${String(turn.turn)}: the fold controller hid itself`)
        }
        // Injected context the Turn adopted must fold with the work. This is the
        // assertion the previous version could not make: `context` was listed as
        // independent there, so the leak check was blind to exactly this row.
        if (turn.hidden > 0 && turn.contextLeaks > 0) {
          failures.push(`turn ${String(turn.turn)}: ${String(turn.contextLeaks)} injected-context row(s) left visible while folded`)
        }
        if (turn.leaks.length > 0) {
          failures.push(`turn ${String(turn.turn)}: unfolded process rows left visible: ${turn.leaks.join(', ')}`)
        }
      } else {
        if (turn.hidden > 0) {
          failures.push(`turn ${String(turn.turn)}: baseline hides ${String(turn.hidden)} row(s)`)
        }
      }
    }

    // Interaction check: expanding a folded turn must reveal its process, and
    // collapsing it again must hide the same rows. This is the half a static DOM
    // read cannot prove.
    let toggleReport = null
    if (args.toggle === true) {
      const target = inspected.turns.find(turn => turn.hidden > 0)
      if (target === undefined) {
        failures.push('toggle: no folded turn to expand')
      } else {
        // A trusted click: React ignores neither synthetic events nor
        // untrusted ones, but only a real input dispatch exercises hit-testing
        // and the browser's own click path.
        const box = await evaluate(`(async () => {
          ${PAGE_HELPERS}
          const controller = controllersOf().get(${String(target.turn)})
          if (controller === undefined) return null
          const button = controller.querySelector('[data-turn-process]') ?? controller
          // A transcript is a scroller: an off-screen row cannot be clicked, so
          // bring the control into the viewport before measuring it.
          button.scrollIntoView({ block: 'center' })
          await new Promise(resolve => requestAnimationFrame(() => { requestAnimationFrame(resolve) }))
          const rect = button.getBoundingClientRect()
          const x = rect.x + rect.width / 2
          const y = rect.y + rect.height / 2
          const hit = document.elementFromPoint(x, y)
          return {
            x,
            y,
            tag: button.tagName,
            hitTag: hit?.tagName ?? null,
            hitClass: typeof hit?.className === 'string' ? hit.className.slice(0, 40) : null,
            hitOwnsButton: hit === button || (hit !== null && button.contains(hit)),
          }
        })()`)
        const clickAt = async () => {
          // A DOM click after an explicit scroll: coordinates from an off-screen
          // or zero-size rect are unreliable, while React's delegated listener
          // sees a bubbling click from a visible target either way.
          return evaluate(`(() => {
            ${PAGE_HELPERS}
            const controller = controllersOf().get(${String(target.turn)})
            if (controller === undefined) return false
            const button = controller.querySelector('[data-turn-process]') ?? controller
            button.scrollIntoView({ block: 'center' })
            button.click()
            return true
          })()`)
        }
        const clickProbe = await evaluate(`(() => {
          ${PAGE_HELPERS}
          const controller = controllersOf().get(${String(target.turn)})
          if (controller === undefined) return { ok: false, reason: 'no controller' }
          const button = controller.querySelector('[data-turn-process]') ?? controller
          const root = document.getElementById('root')
          const seen = []
          const grab = event => { seen.push('click:' + (event.target?.tagName ?? '?')) }
          root?.addEventListener('click', grab)
          button.click()
          root?.removeEventListener('click', grab)
          let node = button
          const chain = []
          while (node !== null && node !== root?.parentElement && chain.length < 20) {
            chain.push(node.tagName + '.' + (typeof node.className === 'string' ? node.className.slice(0, 24) : ''))
            node = node.parentElement
          }
          return {
            ok: true,
            rootSeen: seen,
            ariaExpanded: button.getAttribute('aria-expanded'),
            chain,
            scroller: (() => {
              let cursor = button.parentElement
              while (cursor !== null) {
                const style = getComputedStyle(cursor)
                if (style.overflowY === 'auto' || style.overflowY === 'scroll') return cursor.className.slice(0, 30)
                cursor = cursor.parentElement
              }
              return null
            })(),
          }
        })()`)
        await sleep(700)
        const measure = `(() => {
          ${PAGE_HELPERS}
          const rows = rowsOf().filter(row => row.turn === ${String(target.turn)} || row.owner === ${String(target.turn)})
          return {
            hidden: rows.filter(row => row.hidden).length,
            visibleRows: rows.filter(row => !row.hidden).length,
            visibleAssistant: rows.filter(row => row.kind === 'assistant-step' && !row.hidden).length,
            visibleContext: rows.filter(row => row.kind === 'context' && !row.hidden).length,
            contexts: rows.filter(row => row.kind === 'context').length,
          }
        })()`
        const expanded = await evaluate(measure)
        if (box !== null) {
          await clickAt()
          await sleep(700)
        }
        const collapsed = await evaluate(measure)
        toggleReport = { turn: target.turn, folded: target.hidden, box, clickProbe, expanded, collapsed }
        // A turn can be a single reasoning block and a reply — no tool rows at
        // all — so "the process came back" is measured on everything the fold
        // hid, including nothing but injected context.
        if (expanded.hidden !== 0) {
          failures.push(`toggle: expanding turn ${String(target.turn)} left ${String(expanded.hidden)} row(s) hidden`)
        }
        // "The process came back" is measured on rows, not on assistant or
        // context counts: a Turn that ended on a tool call folds nothing but
        // tool rows, and an error-ended Turn's assistant rows are gone from
        // the DOM entirely, so neither count can prove the reveal.
        if (expanded.visibleRows !== target.rows) {
          failures.push(`toggle: expanding turn ${String(target.turn)} revealed ${String(expanded.visibleRows)}/${String(target.rows)} row(s)`)
        }
        // The half a folded-only assertion cannot see: expanding must give the
        // injected context back, or the fold would have deleted it.
        if (expanded.contexts > 0 && expanded.visibleContext !== expanded.contexts) {
          failures.push(`toggle: expanding turn ${String(target.turn)} revealed ${String(expanded.visibleContext)}/${String(expanded.contexts)} injected-context row(s)`)
        }
        if (expanded.contexts > 0 && collapsed.visibleContext !== 0) {
          failures.push(`toggle: folding turn ${String(target.turn)} left ${String(collapsed.visibleContext)} injected-context row(s) visible`)
        }
        if (collapsed.hidden !== target.hidden) {
          failures.push(`toggle: collapsing turn ${String(target.turn)} hid ${String(collapsed.hidden)} row(s), expected ${String(target.hidden)}`)
        }
        // An answerless fold has no answer to come back to, so 0 is expected
        // there; a Turn that marked one must show exactly it.
        if (target.answers === 1 && collapsed.visibleAssistant !== 1) {
          failures.push(`toggle: collapsing turn ${String(target.turn)} left ${String(collapsed.visibleAssistant)} assistant rows visible`)
        }
      }
    }

    const report = {
      landed,
      session: args.session ?? null,
      bootEntry: (boot.entries ?? []).includes('dsh-fold-it-up'),
      bootEntries: boot.entries?.length ?? 0,
      pluginTrace: await evaluate('globalThis.__FOLDITUP__ ?? null'),
      finalState,
      toggleReport,
      turns: inspected.turns,
      consoleErrors: consoleErrors.slice(0, 10),
      failures,
    }
    console.log(JSON.stringify(report, null, 2))
    if (typeof args.report === 'string') {
      // Machine-readable copy: the console transcript is filtered and wrapped by
      // some shells, so an asserted report is always also written to a file.
      const { writeFileSync } = await import('node:fs')
      writeFileSync(args.report, `${JSON.stringify(report, null, 2)}\n`)
    }
    console.log('')
    console.log(`${String(foldable.length)} turn(s) inspected; ${String(failures.length)} failure(s)`)
    if (failures.length > 0) {
      for (const failure of failures) console.error(`FAIL ${failure}`)
      process.exitCode = 1
    } else {
      console.log(`OK — ${isPlugin ? 'plugin' : 'baseline'} expectations hold`)
    }
  } finally {
    client?.close()
    edge.kill()
    await sleep(500)
    await rm(userDataDir, { recursive: true, force: true }).catch(() => {})
  }
}

await main()
