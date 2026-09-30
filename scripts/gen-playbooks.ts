/**
 * Compile `registry/playbooks/*.yaml` into `packages/playbooks/src/generated.ts`.
 *
 * Why a generated module rather than reading YAML at runtime: the CLI ships as a single
 * file, so it cannot assume a `registry/` directory sits next to it. Generating also gives
 * a build-time place to fail: an invalid playbook breaks the build instead of quietly
 * disappearing at runtime.
 *
 * Run with `npm run gen:playbooks`. A test asserts the generated file matches the YAML
 * sources, so editing a playbook without regenerating fails CI.
 */

import { mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { type ValidationIssue, validatePlaybook } from '../packages/playbooks/src/schema.ts'
import { parseYamlSubset, YamlError, type YamlValue } from '../packages/playbooks/src/yaml.ts'

const here = dirname(fileURLToPath(import.meta.url))
const repoRoot = resolve(here, '..')
const registryDir = join(repoRoot, 'registry', 'playbooks')
const outFile = join(repoRoot, 'packages', 'playbooks', 'src', 'generated.ts')

/** Recursively convert a parsed YAML value into a JSON-safe literal. */
function toLiteral(value: YamlValue): string {
  return JSON.stringify(value, null, 2)
}

const files = readdirSync(registryDir)
  .filter((f) => /\.ya?ml$/.test(f))
  .sort()

if (files.length === 0) {
  console.error(`No playbooks found in ${registryDir}`)
  process.exit(1)
}

const problems: string[] = []
const entries: Array<{ file: string; id: string }> = []

for (const file of files) {
  const text = readFileSync(join(registryDir, file), 'utf8')
  let parsed: YamlValue
  try {
    parsed = parseYamlSubset(text)
  } catch (err) {
    const msg = err instanceof YamlError ? err.message : String(err)
    problems.push(`${file}: ${msg}`)
    continue
  }
  const { playbook, issues } = validatePlaybook(parsed, file)
  if (playbook === null) {
    const detail = issues.map((i: ValidationIssue) => `  ${i.path}: ${i.message}`).join('\n')
    problems.push(`${file}:\n${detail}`)
    continue
  }
  entries.push({ file, id: playbook.id })
}

if (problems.length > 0) {
  console.error(`Playbook validation failed:\n\n${problems.join('\n\n')}`)
  process.exit(1)
}

const parts: string[] = []
parts.push('// GENERATED FILE -- do not edit. Source: registry/playbooks/*.yaml')
parts.push('// Regenerate with: npm run gen:playbooks')
parts.push('// A test asserts this file matches the YAML sources.')
parts.push('')
parts.push('export const BUILTIN_PLAYBOOK_SOURCE = "registry/playbooks" as const')
parts.push('')
parts.push('export const generatedPlaybookFiles: ReadonlyMap<string, string> = new Map([')
for (const file of files) {
  const text = readFileSync(join(registryDir, file), 'utf8')
  parts.push(`  [${JSON.stringify(file)}, ${toLiteral(text)}],`)
}
parts.push('])')
parts.push('')

mkdirSync(dirname(outFile), { recursive: true })
writeFileSync(outFile, parts.join('\n'), 'utf8')

console.log(`Generated ${outFile}`)
console.log(`  ${entries.length} playbook(s): ${entries.map((e) => `${e.file} -> ${e.id}`).join(', ')}`)
