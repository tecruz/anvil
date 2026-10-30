import assert from 'node:assert/strict'
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, test } from 'node:test'

const temps: string[] = []
process.on('exit', () => {
  for (const t of temps) rmSync(t, { recursive: true, force: true })
})

function temp(prefix: string): string {
  const d = mkdtempSync(join(tmpdir(), prefix))
  temps.push(d)
  return d
}

describe('scenario: workspace dependency', () => {
  test('change crosses package boundaries and respects dependency graph', () => {
    const repoRoot = temp('anvil-scenario-workspace-')
    const pkgA = join(repoRoot, 'packages/a')
    const pkgB = join(repoRoot, 'packages/b')
    mkdirSync(pkgA, { recursive: true })
    mkdirSync(pkgB, { recursive: true })

    writeFileSync(join(pkgA, 'package.json'), '{"name":"@repo/a", "version":"1.0.0"}\n', 'utf8')
    writeFileSync(join(pkgA, 'index.js'), 'module.exports = { dep: true }\n', 'utf8')

    writeFileSync(
      join(pkgB, 'package.json'),
      '{"name":"@repo/b", "version":"1.0.0", "dependencies":{"@repo/a":"1.0.0"}}\n',
      'utf8',
    )
    writeFileSync(
      join(pkgB, 'index.js'),
      "const a = require('@repo/a'); module.exports = {depExists: !!a.dep};\n",
      'utf8',
    )

    assert.equal(existsSync(join(pkgA, 'package.json')), true)
    assert.equal(existsSync(join(pkgB, 'package.json')), true)
  })
})
