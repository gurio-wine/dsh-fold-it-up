#!/usr/bin/env node
/**
 * Assemble the two files the DeepSeek Harness client module system loads.
 *
 * The bundle protocol is a single classic script that registers one factory:
 *
 *     window.__ModuleLoader__.load({ id: '<package>', factory: require => exports })
 *
 * There is no build step in this repository and no bundler on the target
 * machine, so the transform below is deliberately literal: it inlines the
 * package's own relative ESM sources as CommonJS-style locals and leaves the
 * platform specifiers (`react`) as `require` calls answered by the boot module
 * table. Nothing else is generated, and the output is checked in so installing
 * the plugin never needs a toolchain.
 *
 * Usage: node tools/build.mjs [--check]
 */
import { readFileSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const check = process.argv.includes('--check')

/** Platform specifiers answered by the boot module table (see client/web/seed.ts). */
const PLATFORM_MODULES = new Set([
  'react',
  'react/jsx-runtime',
  'react-dom',
  'react-dom/client',
  '@deepseek-ai/cordis',
  '@deepseek-ai/dsh-client-store',
  '@deepseek-ai/dsh-client-ui-slots',
  '@deepseek-ai/dsh-client-ui-primitives',
  '@deepseek-ai/dsh-client-ui-dockkit',
])

/**
 * Turn one authored ESM module into a CommonJS-style fragment.
 *
 * Supports exactly the four forms this package writes: `import * as X from
 * 'spec'`, `import { a, b as c } from './rel.js'`, `export const/function`, and
 * `export { a, b }`.
 * @param source - authored module text.
 * @param file - its path, for diagnostics.
 * @returns `{ body, exports, imports, externals }`.
 */
function transform(source, file) {
  const imports = []
  const externals = []
  const names = []
  let body = source

  body = body.replace(
    /^import\s+\*\s+as\s+([A-Za-z_$][\w$]*)\s+from\s+'([^']+)'\n/gm,
    (_match, local, spec) => {
      if (PLATFORM_MODULES.has(spec)) {
        externals.push(spec)
        return `const ${local} = require(${JSON.stringify(spec)})\n`
      }
      throw new Error(`${file}: only platform modules may be value-imported, got '${spec}'`)
    },
  )
  body = body.replace(
    /^import\s*\{([^}]+)\}\s*from\s*'([^']+)'\n/gm,
    (_match, clause, spec) => {
      const bindings = clause.split(',').map(part => part.trim()).filter(Boolean).map(part => {
        const [imported, local = imported] = part.split(/\s+as\s+/u).map(piece => piece.trim())
        return { imported, local }
      })
      if (!spec.startsWith('.')) {
        // A platform module arrives whole through the module table's require.
        if (!PLATFORM_MODULES.has(spec)) {
          throw new Error(`${file}: named import from '${spec}' is neither relative nor a platform module`)
        }
        externals.push(spec)
        const names = bindings
          .map(binding => (binding.imported === binding.local
            ? binding.local
            : `${binding.imported}: ${binding.local}`))
          .join(', ')
        return `const { ${names} } = require(${JSON.stringify(spec)})\n`
      }
      // The bundler replaces this marker with a destructuring of the dependency
      // module's exports once it knows that module's handle.
      imports.push({ spec, bindings })
      return `/*@import ${spec}*/`
    },
  )
  body = body.replace(
    /^export\s+(const|let|function)\s+([A-Za-z_$][\w$]*)/gm,
    (_match, kind, name) => {
      names.push(name)
      return `${kind} ${name}`
    },
  )
  body = body.replace(/^export\s*\{([^}]+)\}\s*$/gm, (_match, clause) => {
    for (const part of clause.split(',').map(piece => piece.trim()).filter(Boolean)) {
      names.push(part.split(/\s+as\s+/u).at(-1).trim())
    }
    return ''
  })
  if (/^export\b/m.test(body)) {
    throw new Error(`${file}: unsupported export form left after transform`)
  }
  return { body, named: [...new Set(names)], imports, externals: [...new Set(externals)] }
}

/**
 * Inline the package's own modules, depth first, into one CommonJS factory body.
 * @param entry - entry file path.
 * @returns `{ code, entryHandle, externals }`.
 */
function bundle(entry) {
  const seen = new Map()
  const order = []
  const externals = new Set()

  const load = (file) => {
    const path = resolve(file)
    if (seen.has(path)) return seen.get(path)
    const source = readFileSync(path, 'utf8')
    const result = transform(source, path)
    const record = { path, ...result, handle: `__module${String(seen.size)}` }
    seen.set(path, record)
    for (const dependency of result.imports) {
      if (!dependency.spec.startsWith('.')) continue
      dependency.target = load(join(dirname(path), dependency.spec))
    }
    for (const spec of result.externals) externals.add(spec)
    // Post-order: a module's own body runs after the modules it imports.
    order.push(record)
    return record
  }

  const entryRecord = load(entry)
  const chunks = []
  let bindingSeed = 0
  for (const record of order) {
    const relative = record.path.slice(root.length + 1).replace(/\\/gu, '/')
    let body = record.body
    // Every module lands in ONE factory scope, so an imported name that repeats
    // a declaration of the importing module would redeclare it. Each imported
    // binding therefore gets a unique local, and the module body is rewritten to
    // use it. Nothing here writes a property shorthand, so a whole-word replace
    // cannot corrupt a member name.
    for (const dependency of record.imports) {
      const handle = dependency.target.handle
      const bindings = dependency.bindings.map((binding) => {
        const local = `${binding.local}$${String(bindingSeed++)}`
        const pattern = new RegExp(
          `(?<![.\\w$])${binding.local.replace(/[$]/gu, '\\$&')}(?![\\w$])`,
          'gu',
        )
        body = body.replace(pattern, local)
        return `${binding.imported}: ${local}`
      }).join(', ')
      body = body.replace(`/*@import ${dependency.spec}*/`, `const { ${bindings} } = ${handle}.exports`)
    }
    chunks.push([
      `/* ${relative} */`,
      body.trimEnd(),
      `const ${record.handle} = { exports: { ${record.named.join(', ')} } }`,
    ].join('\n'))
  }
  return {
    code: chunks.join('\n\n'),
    entryHandle: entryRecord.handle,
    externals: [...externals],
  }
}

/**
 * Wrap the inlined modules in the module-loader registration.
 * @param packageName - module-table key.
 * @param body - inlined module text.
 * @param entryHandle - local holding the entry module's exports.
 * @returns the served bundle text.
 */
function registration(packageName, body, entryHandle) {
  const indented = body.split('\n').map(line => (line === '' ? '' : `    ${line}`)).join('\n')
  return `window.__ModuleLoader__.load({
  id: ${JSON.stringify(packageName)},
  factory: (require) => {
${indented}
    return ${entryHandle}.exports;
  },
});
`
}

const clientBundle = bundle(join(root, 'src/browser.js'))
const clientText = registration('dsh-fold-it-up', clientBundle.code, clientBundle.entryHandle)

const hostText = `/**
 * dsh-fold-it-up — node half.
 *
 * The whole feature is browser-side: this package takes over one keyed Chat
 * renderer inside the Web UI, and the profile patch row below is what mounts the
 * package. This half exists because a profile bundle row must resolve to a
 * package entry point, so it declares the plugin identity and nothing else — no
 * services, no prompt text, no host state.
 * @module dsh-fold-it-up
 */

/** Stable Cordis plugin name. */
export const name = 'dsh-fold-it-up'

/** No host services are required; the browser half owns the surface. */
export const inject = []

/** The host half is deliberately inert. */
export function apply() {}
`

const patchText = `# dsh-fold-it-up bundle patch: one host row inside the profile roster.
# The row is what makes the package resolvable to the Web client-modules scan,
# which is what serves and boots the browser half declared by package.json's
# \`dsh.client\`.
- insert:
    - id: dsh-fold-it-up
      name: dsh-fold-it-up
      config: {}
`

const outputs = [
  ['client.js', clientText],
  ['index.js', hostText],
  ['cordis.patch.yml', patchText],
]

let failed = false
for (const [name, text] of outputs) {
  const path = join(root, name)
  let existing
  try {
    existing = readFileSync(path, 'utf8')
  } catch {
    existing = undefined
  }
  if (existing === text) continue
  if (check) {
    failed = true
    console.error(`build: ${name} is stale — run \`node tools/build.mjs\``)
    continue
  }
  writeFileSync(path, text)
  console.log(`build: wrote ${name} (${String(Buffer.byteLength(text))} bytes)`)
}
if (check && failed) process.exit(1)
if (!check) {
  const externals = clientBundle.externals.join(', ') || '(none)'
  console.log(`build: client externals: ${externals}`)
}
