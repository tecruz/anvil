import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, relative } from 'node:path'
import { describe, test } from 'node:test'
import { evidenceStore, readVerificationEvidence, verificationEvidencePath } from '../src/commands/crew.ts'
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

  test('recorded verification is read only from the bounded CLI-owned file', () => {
    const root = mkdtempSync(join(tmpdir(), 'anvil-dashboard-verify-'))
    try {
      mkdirSync(join(root, '.git'), { recursive: true })
      const store = evidenceStore(root)
      assert.ok(store)
      assert.deepEqual(readVerificationEvidence(store), [])
      mkdirSync(join(root, '.anvil'), { recursive: true })
      const path = verificationEvidencePath(store)
      writeFileSync(path, 'not json')
      assert.deepEqual(readVerificationEvidence(store), [])
      const record = {
        command: 'npm test',
        revision: 'abcdef1234',
        exitCode: 0,
        timestamp: '2026-11-21T00:00:00.000Z',
      }
      writeFileSync(path, JSON.stringify([record]))
      assert.deepEqual(readVerificationEvidence(store), [record])
      writeFileSync(path, 'x'.repeat(70 * 1024))
      assert.deepEqual(readVerificationEvidence(store), [])
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  test('a FIFO at the evidence path is rejected without blocking the reader', {
    skip: process.platform === 'win32',
  }, () => {
    const root = mkdtempSync(join(tmpdir(), 'anvil-evidence-fifo-'))
    try {
      mkdirSync(join(root, '.git'), { recursive: true })
      mkdirSync(join(root, '.anvil'), { recursive: true })
      const store = evidenceStore(root)
      assert.ok(store)
      execFileSync('mkfifo', [verificationEvidencePath(store)])
      assert.deepEqual(readVerificationEvidence(store), [])
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  test('the evidence store is resolved from Git metadata', () => {
    const mainRoot = mkdtempSync(join(tmpdir(), 'anvil-evidence-main-'))
    const linkedRoot = mkdtempSync(join(tmpdir(), 'anvil-evidence-linked-'))
    try {
      mkdirSync(join(mainRoot, '.git'), { recursive: true })
      const main = evidenceStore(mainRoot)
      assert.equal(main?.root, mainRoot)

      const gitDir = join(linkedRoot, 'admin', 'worktrees', 'claim')
      mkdirSync(gitDir, { recursive: true })
      writeFileSync(join(gitDir, 'commondir'), `${relative(gitDir, join(mainRoot, '.git'))}\n`, 'utf8')
      writeFileSync(join(linkedRoot, '.git'), `gitdir: ${relative(linkedRoot, gitDir)}\n`, 'utf8')
      const linked = evidenceStore(linkedRoot)
      assert.equal(linked?.root, mainRoot)
      assert.equal(linked?.key, main?.key)
    } finally {
      rmSync(mainRoot, { recursive: true, force: true })
      rmSync(linkedRoot, { recursive: true, force: true })
    }
  })
})
