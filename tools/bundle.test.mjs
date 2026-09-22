#!/usr/bin/env node
/**
 * Integration test for the generated artifacts.
 *
 * It loads `client.js` exactly the way the browser module system does — through
 * a `window.__ModuleLoader__.load` stub — and then drives the plugin with a
 * fake Cordis context, a fake slot registry and a fake React, so the parts that
 * only exist at bundle time (registration shape, priority, declared store,
 * injected `useChat`) are asserted without a browser.
 *
 * Run: node --test tools/bundle.test.mjs
 */
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { test } from 'node:test'
import { fileURLToPath, pathToFileURL } from 'node:url'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')

/**
 * Fake React: enough of the surface the bundle touches, with hooks that call
 * through to the test body so a component can be invoked as a plain function.
 * @param state - mutable hook state shared across one render.
 * @returns the React stand-in.
 */
function fakeReact(state) {
  const hooks = []
  let index = 0
  const useSlot = (initial) => {
    const slot = index++
    if (hooks[slot] === undefined) hooks[slot] = { value: initial }
    return [hooks[slot].value, (next) => {
      hooks[slot].value = typeof next === 'function' ? next(hooks[slot].value) : next
    }]
  }
  state.reset = () => { index = 0 }
  return {
    createElement: (type, props, ...children) => ({ type, props: props ?? {}, children }),
    // `memo` is identity here: the bundle only uses it for render identity, and
    // the tests never exercise reconciliation.
    memo: component => component,
    createContext: (value) => ({ value, Provider: 'Provider' }),
    useContext: context => context.value,
    useRef: (initial) => {
      const slot = index++
      hooks[slot] ??= { value: { current: initial } }
      return hooks[slot].value
    },
    useState: useSlot,
    useMemo: (factory) => factory(),
    useCallback: fn => fn,
    useEffect: (effect) => { state.effects.push(effect) },
    useLayoutEffect: (effect) => { state.layouts.push(effect) },
    useSyncExternalStore: (_subscribe, getSnapshot) => getSnapshot(),
    Fragment: 'Fragment',
  }
}

/**
 * Minimal document stand-in: the bundle's only DOM use at apply time is
 * inserting its stylesheet.
 * @returns the created style elements, in order.
 */
function fakeDocument() {
  const created = []
  globalThis.document = {
    head: { append: element => created.push(element) },
    documentElement: { lang: 'zh-CN' },
    createElement: () => ({
      attributes: {},
      setAttribute(name, value) { this.attributes[name] = value },
      remove() {},
      textContent: '',
    }),
  }
  return created
}

/**
 * The platform answers the bundle's `require` expects.
 * @param react - the React stand-in.
 * @returns a require implementation for the boot module table.
 */
function platformRequire(react) {
  return (spec) => {
    if (spec === 'react') return react
    // The real defineStore is a factory; the bundle stores its handle, so an
    // identity function keeps the contract under test.
    if (spec === '@deepseek-ai/dsh-client-store') return { defineStore: handle => handle }
    throw new Error(`unexpected require(${spec})`)
  }
}

/**
 * Load the browser bundle and capture its registration.
 * @returns `{ registration, react, styles }`.
 */
function loadBundle() {
  const registrations = []
  globalThis.window = {
    __ModuleLoader__: { load: registration => registrations.push(registration) },
  }
  const react = fakeReact({ effects: [], layouts: [] })
  const styles = fakeDocument()
  const source = readFileSync(join(root, 'client.js'), 'utf8')
  new Function('require', 'window', `${source}\nreturn undefined;`)(platformRequire(react), globalThis.window)
  assert.equal(registrations.length, 1, 'the bundle must register exactly one factory')
  return { registration: registrations[0], react, styles }
}

/**
 * Materialize the bundle's exports.
 * @param bundle - result of {@link loadBundle}.
 * @returns the module exports.
 */
function loadExports(bundle) {
  return bundle.registration.factory(platformRequire(bundle.react))
}

test('the bundle registers under the package name the boot graph uses', () => {
  const bundle = loadBundle()
  assert.equal(bundle.registration.id, 'dsh-fold-it-up')
  assert.equal(typeof bundle.registration.factory, 'function')
  const exports = loadExports(bundle)
  // Cordis reads `apply` off the module namespace itself, so the entry must not
  // wrap it in another object.
  assert.equal(typeof exports.apply, 'function')
  assert.deepEqual(exports.inject, ['slots', 'locale', 'uiConversation'])
  assert.equal(exports.name, 'dsh-fold-it-up')
})

test('the plugin claims the turn-process cell at a shadowing priority', () => {
  const bundle = loadBundle()
  const exports = loadExports(bundle)
  const registered = []
  const injections = []
  const ctx = {
    effect: (body) => { body() },
    slots: {
      inject: (key, callback) => { injections.push(key); callback() },
      register: (options, component) => { registered.push({ options, component }) },
    },
    uiConversation: { binding: () => ({ target: () => ({ getSnapshot: () => ({}), subscribe: () => () => {} }) }) },
  }
  exports.apply(ctx)
  assert.deepEqual(injections, ['conversation.chat.node'])
  assert.equal(registered.length, 1)
  const { options } = registered[0]
  assert.equal(options.name, 'conversation.chat.node')
  assert.equal(options.key, 'turn-process')
  assert.equal(options.priority, -1, 'a higher number than 0 loses the cell')
  assert.equal(options.locale, 'chat', "the shipped row's labels come from the Chat namespace")
  assert.equal(typeof options.store, 'function', 'the disclosure declares its own store handle')
  assert.equal(typeof options.inject, 'function')
})

test('the declared store starts collapsed and toggles per turn', () => {
  const bundle = loadBundle()
  const exports = loadExports(bundle)
  const captured = []
  const ctx = {
    effect: (body) => { body() },
    slots: { inject: (_key, callback) => callback(), register: (options) => { captured.push(options) } },
    uiConversation: { binding: () => ({ target: () => ({ getSnapshot: () => ({}), subscribe: () => () => {} }) }) },
  }
  exports.apply(ctx)
  const handle = captured[0].store()
  const draft = handle.init()
  assert.deepEqual(draft, { turnProcesses: [] }, 'a fresh session folds every turn')
  handle.actions.setTurnProcessOpen(draft, 7, 3, true)
  assert.deepEqual(draft.turnProcesses, [{ turn: 7, answerStep: 3 }])
  handle.actions.setTurnProcessOpen(draft, 7, 3, true)
  assert.deepEqual(draft.turnProcesses, [{ turn: 7, answerStep: 3 }], 're-opening replaces the entry')
  handle.actions.setTurnProcessOpen(draft, 7, 3, false)
  assert.deepEqual(draft.turnProcesses, [], 'closing removes the entry, so the fold returns')
})

test('the inject face hands the component a working useChat selector', () => {
  const bundle = loadBundle()
  const exports = loadExports(bundle)
  const snapshot = { order: ['a'], timeline: { turnOrder: [1], turns: new Map() } }
  let bound = null
  const ctx = {
    effect: (body) => { body() },
    slots: { inject: (_key, callback) => callback(), register: () => {} },
    uiConversation: {
      binding: (sessionId) => {
        bound = sessionId
        return { target: () => ({ getSnapshot: () => snapshot, subscribe: () => () => {} }) }
      },
    },
  }
  exports.apply(ctx)
  // Re-run the registration path the way the slot machinery would.
  const captured = []
  ctx.slots.register = (options) => { captured.push(options) }
  exports.apply(ctx)
  const face = captured[0].inject('session-1')
  assert.deepEqual(face.hooks, {})
  assert.deepEqual(face.keyedHooks, {})
  // The binding resolves on the first selector call — the component's render.
  assert.equal(face.useChat(state => state.order), snapshot.order)
  assert.equal(bound, 'session-1')
})

test('the generated patch inserts exactly one host row', () => {
  const patch = readFileSync(join(root, 'cordis.patch.yml'), 'utf8')
  assert.match(patch, /- id: dsh-fold-it-up/)
  assert.match(patch, /name: dsh-fold-it-up/)
  assert.equal((patch.match(/- id:/gu) ?? []).length, 1)
})

test('the manifest declares both halves', () => {
  const manifest = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'))
  assert.equal(manifest.name, 'dsh-fold-it-up')
  assert.equal(manifest.dsh.bundle.patch, './cordis.patch.yml')
  assert.equal(manifest.dsh.client.platform, 'web')
  assert.equal(manifest.exports['./client'], './client.js')
  assert.equal(manifest.main, './index.js')
})

test('the node half is inert and resolvable', async () => {
  const host = await import(pathToFileURL(join(root, 'index.js')).href)
  assert.equal(host.name, 'dsh-fold-it-up')
  assert.deepEqual(host.inject, [])
  assert.equal(typeof host.apply, 'function')
  assert.equal(host.apply(), undefined)
})

test('the retired source-map compile path is gone and the built-in row is self-styled', () => {
  const source = readFileSync(join(root, 'client.js'), 'utf8')
  // The built-in row must carry the package's OWN classes: a product
  // CSS-module hash in here is exactly how it went stale once already.
  assert.match(source, /dsh-fold-it-up-root/u, 'the built-in row carries the package stylesheet')
  assert.match(source, /dsh-fold-it-up-chevron/u, 'the built-in chevron carries the package stylesheet')
  assert.doesNotMatch(source, /jUC0fW/u, 'no product CSS-module hash may survive in the bundle')
  // The runtime compile path (fetch the map, rewrite imports, evaluate the
  // TSX) is retired: the slot ledger yields the shipped renderer instead.
  assert.doesNotMatch(source, /compileDisclosureRow|compileRowSource|ROW_CLASSES/u)
  assert.doesNotMatch(source, /sourcesContent|sourceMappingURL/u)
  assert.doesNotMatch(source, /new Function/u)
})
