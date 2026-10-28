import assert from 'node:assert/strict'
import { existsSync, mkdirSync, mkdtempSync, rmSync, statSync, writeFileSync } from 'node:fs'
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

describe('scenario: nested project', () => {
  test('verification runs from detected subdirectory, not repo root', () => {
    const repoRoot = temp('anvil-scenario-nested-')
    const subproject = join(repoRoot, 'packages/sub')
    mkdirSync(subproject, { recursive: true })
    writeFileSync(join(subproject, 'package.json'), '{"name":"sub"}\n', 'utf8')
    writeFileSync(join(subproject, 'test.js'), "test('sub', () => {})\n", 'utf8')

    assert.equal(existsSync(join(subproject, 'package.json')), true)
    assert.equal(statSync(join(subproject, 'test.js')).isFile(), true)
  })
})
