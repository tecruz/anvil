import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, test } from 'node:test'
import { actionArgv } from '@anvil/dashboard'
import { stagedView } from '../src/commands/dashboard.ts'

/** A staged manifest whose staged file has disappeared must not look like a deletion. */
describe('the dashboard staging view', () => {
  test('a missing staged file stays an error instead of becoming an empty diff', () => {
    const root = mkdtempSync(join(tmpdir(), 'anvil-dashboard-'))
    try {
      const staging = join(root, '.anvil', 'staging')
      mkdirSync(join(staging, 'files'), { recursive: true })
      writeFileSync(
        join(staging, 'manifest.json'),
        JSON.stringify({
          schemaVersion: 1,
          inputHash: 'test-hash',
          createdAt: '2026-11-17T00:00:00.000Z',
          generator: 'test',
          files: [
            {
              path: 'AGENTS.md',
              stagedPath: 'files/AGENTS.md',
              sha256: 'abc123',
              bytes: 1,
              repoSha256: null,
            },
          ],
        }),
      )
      writeFileSync(join(root, 'AGENTS.md'), 'existing instructions\n')

      const view = stagedView(root)
      assert.equal(view.exists, true)
      const file = view.files[0]
      assert.equal(file?.path, 'AGENTS.md')
      assert.equal(file?.diff, '')
      assert.match(file?.error ?? '', /could not be read/)
      assert.equal(view.summary.files, 0)
      assert.equal(view.summary.removed, 0)
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })
})

describe('the dashboard ship action through the real CLI', () => {
  test('a ship for a claim that does not exist is refused by the CLI, not by the page', () => {
    const root = mkdtempSync(join(tmpdir(), 'anvil-dashboard-ship-'))
    try {
      spawnSync('git', ['init', '--initial-branch=main'], { cwd: root, stdio: 'pipe' })
      const argv = actionArgv('ship', 'no-such-claim')
      assert.deepEqual(argv, ['ship', 'no-such-claim', '--probe'])
      const entry = join(import.meta.dirname, '..', 'src', 'main.ts')
      const result = spawnSync(process.execPath, [entry, ...argv, '--json'], { cwd: root, encoding: 'utf8' })
      assert.notEqual(result.status, 0, result.stdout + result.stderr)
      const envelope = JSON.parse(result.stdout.trim()) as { ok: boolean; error?: { message?: string } }
      assert.equal(envelope.ok, false)
      assert.match(envelope.error?.message ?? '', /No claim|no-such-claim/i)
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })
})
