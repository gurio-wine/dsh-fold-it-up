#!/usr/bin/env node
/**
 * Pick a session worth probing: count turns and turn-less injected-context
 * events per session log so a verification target can be chosen from evidence
 * instead of guesswork.
 *
 * Usage: node tools/pick-session.mjs [--sessions <dir>]
 */
import { readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { readSessionEvents } from './session-log.mjs'

const args = {}
for (let index = 2; index < process.argv.length; index += 1) {
  const token = process.argv[index]
  if (!token.startsWith('--')) continue
  args[token.slice(2)] = process.argv[index + 1]
  index += 1
}
const root = args.sessions ?? join(process.env.APPDATA ?? '', 'DeepSeek Harness', 'dsh-home', 'sessions')
const rows = []
for (const bucket of readdirSync(root)) {
  const dir = join(root, bucket)
  if (!statSync(dir).isDirectory()) continue
  for (const session of readdirSync(dir)) {
    const file = join(dir, session, 'session.v3.jsonl.zstd')
    let events
    try {
      events = readSessionEvents(file)
    } catch {
      continue
    }
    let turns = 0
    let contexts = 0
    let turnLess = 0
    let closed = 0
    for (const event of events) {
      if (event.type === 'turn/start') turns += 1
      if (event.type === 'turn/end') closed += 1
      if (event.type === 'user/message' && event.surfaceOp === 'append') {
        const source = event.data?.source ?? {}
        if (source.kind !== 'user') {
          contexts += 1
          if (typeof event.data?.turn !== 'number') turnLess += 1
        }
      }
    }
    rows.push({ bucket, session, events: events.length, turns, closed, contexts, turnLess, file })
  }
}
rows.sort((left, right) => right.turnLess - left.turnLess || right.turns - left.turns)
for (const row of rows.slice(0, 12)) {
  console.log([
    String(row.turnLess).padStart(4),
    'turnless-ctx',
    String(row.contexts).padStart(4),
    'ctx',
    String(row.turns).padStart(3),
    'turns',
    String(row.closed).padStart(3),
    'closed',
    String(row.events).padStart(6),
    'events',
    row.session,
    row.bucket,
  ].join(' '))
}
