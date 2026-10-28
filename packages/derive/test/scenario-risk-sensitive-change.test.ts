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

describe('scenario: risk-sensitive change', () => {
  test('task preserves unrelated files and satisfies concrete safety assertions', () => {
    const repoRoot = temp('anvil-scenario-risk-')
    mkdirSync(join(repoRoot, 'src'), { recursive: true })
    mkdirSync(join(repoRoot, 'docs'), { recursive: true })

    // The target file for modification.
    writeFileSync(join(repoRoot, 'src/index.js'), 'export const main = () => "original";\n', 'utf8')

    // Unrelated files that must not be touched.
    writeFileSync(join(repoRoot, 'docs/README.md'), '# Project docs\nDo not edit.\n', 'utf8')
    writeFileSync(join(repoRoot, 'LICENSE'), 'MIT License\n', 'utf8')

    // A safety assertion document.
    writeFileSync(
      join(repoRoot, 'SAFETY.md'),
      '# Safety assertions\n- README.md unmodified\n- LICENSE unmodified\n- src/index.js updated\n',
      'utf8',
    )

    assert.equal(existsSync(join(repoRoot, 'src/index.js')), true)
    assert.equal(existsSync(join(repoRoot, 'docs/README.md')), true)
    assert.equal(existsSync(join(repoRoot, 'LICENSE')), true)
    assert.equal(existsSync(join(repoRoot, 'SAFETY.md')), true)
  })
})
