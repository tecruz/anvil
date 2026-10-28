import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { cpSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, test } from 'node:test'
import { fileURLToPath } from 'node:url'

const source = fileURLToPath(new URL('../../', import.meta.url))

describe('medium eval fixture compatibility', () => {
  for (const applySolution of [false, true]) {
    const name = applySolution
      ? 'the median solution preserves the full suite'
      : 'the unchanged fixture passes the full suite'
    test(name, () => {
      const workdir = mkdtempSync(join(tmpdir(), 'anvil-eval-fixtures-'))
      try {
        cpSync(join(source, 'eval/repos/node-medium'), workdir, { recursive: true })
        if (applySolution) {
          cpSync(join(source, 'eval/solutions/medium-code-change.js'), join(workdir, 'src/stats.js'))
        }

        // Use the fixture's complete test discovery, including nested integration tests.
        // Copying in the fake-agent solution must not remove exports used elsewhere.
        const env = { ...process.env }
        // A nested Node test runner otherwise skips its own test discovery.
        delete env.NODE_TEST_CONTEXT
        const result = spawnSync(process.execPath, ['--test'], {
          cwd: workdir,
          env,
          encoding: 'utf8',
          timeout: 30_000,
        })
        assert.equal(result.error, undefined, result.error?.message)
        assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`)
      } finally {
        rmSync(workdir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })
      }
    })
  }
})
