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

describe('scenario: cross-file regression', () => {
  test('local fix fails hidden integration test unless related code is updated', () => {
    const repoRoot = temp('anvil-scenario-crossfile-')
    mkdirSync(join(repoRoot, 'src'), { recursive: true })
    mkdirSync(join(repoRoot, 'test'), { recursive: true })

    // A helper function used by two modules.
    writeFileSync(
      join(repoRoot, 'src/format.js'),
      'function format(val) { return val.trim() }\nmodule.exports = format;\n',
      'utf8',
    )

    // A consumer that relies on the current behavior.
    writeFileSync(
      join(repoRoot, 'src/consumer.js'),
      "const format = require('./format');\nfunction render(val) { return format(val); }\nmodule.exports = render;\n",
      'utf8',
    )

    // A visible unit test that passes with either implementation.
    writeFileSync(
      join(repoRoot, 'test/unit.test.js'),
      "const render = require('../src/consumer.js');\ntest('renders', () => { expect(render(' x ')).toBe('x'); });\n",
      'utf8',
    )

    // A hidden integration test that asserts behavior the refactor broke.
    writeFileSync(
      join(repoRoot, 'test/hidden-integration.test.js'),
      "const format = require('../src/format.js');\ntest('preserves whitespace', () => { expect(format('  ')).toBe('  '); });\n",
      'utf8',
    )

    assert.equal(existsSync(join(repoRoot, 'src/format.js')), true)
    assert.equal(existsSync(join(repoRoot, 'test/hidden-integration.test.js')), true)
  })
})
