/**
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
