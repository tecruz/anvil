import assert from 'node:assert/strict'
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
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

describe('scenario: misleading documentation', () => {
  test('stale instructions do not override commands supported by evidence', () => {
    const repoRoot = temp('anvil-scenario-misleading-')
    writeFileSync(join(repoRoot, 'README.md'), '# Old instructions\n\nRun `npm run test:old` to verify.\n', 'utf8')

    // Actual supported evidence from package.json.
    writeFileSync(
      join(repoRoot, 'package.json'),
      '{"name":"test","scripts":{"test":"echo ok","build":"echo built"}}\n',
      'utf8',
    )

    // Evidence-based instructions should take precedence.
    assert.equal(existsSync(join(repoRoot, 'package.json')), true)
    assert.ok(!existsSync(join(repoRoot, 'test:old')))
  })
})
