import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, test } from 'node:test'
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
