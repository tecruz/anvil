/**
 * Version constants.
 *
 * `SCHEMA_VERSION` versions the `--json` output contract. The opencode plugin consumes
 * it, so it is stable from M0: bump it only for breaking changes to the envelopes in
 * `output.ts`, and add a CHANGELOG entry when you do.
 *
 * `VERSION` is the tool version, injected at build time by `scripts/build.mjs`.
 */

export const SCHEMA_VERSION = 1 as const

export type SchemaVersion = typeof SCHEMA_VERSION

declare const __ANVIL_VERSION__: string | undefined

function resolveVersion(): string {
  // esbuild `define`; falls back to package.json range during dev/test.
  const injected = typeof __ANVIL_VERSION__ === 'string' ? __ANVIL_VERSION__ : undefined
  return injected ?? '0.1.0-dev'
}

export const VERSION: string = resolveVersion()
