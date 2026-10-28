import assert from 'node:assert/strict'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, describe, test } from 'node:test'
import { applyStaging, type StagingManifest, writeStaging } from '@anvil/derive'

const temps: string[] = []
after(() => {
  for (const t of temps) rmSync(t, { recursive: true, force: true })
})

function temp(prefix: string): string {
  const d = mkdtempSync(join(tmpdir(), prefix))
  temps.push(d)
  return d
}

function stageTwoFiles(repoRoot: string): StagingManifest {
  // Two pre-existing files with distinct contents.
  writeFileSync(join(repoRoot, 'a.txt'), 'original-a\n', 'utf8')
  writeFileSync(join(repoRoot, 'b.txt'), 'original-b\n', 'utf8')

  const contents = new Map<string, string>([
    ['a.txt', 'staged-a\n'],
    ['b.txt', 'staged-b\n'],
  ])
  return writeStaging(repoRoot, { inputHash: 'deadbeef', generator: 'test' }, contents)
}

/** Replace a repo file with a directory so its staged write will fail. */
function replaceWithDirectory(repoRoot: string, relPath: string): void {
  rmSync(join(repoRoot, relPath), { recursive: true, force: true })
  mkdirSync(join(repoRoot, relPath), { recursive: true })
}

describe('applyStaging: failure at each mutation boundary', () => {
  test('applies all files when every write succeeds', () => {
    const repoRoot = temp('anvil-apply-ok-')
    const manifest = stageTwoFiles(repoRoot)

    const written = applyStaging(repoRoot, manifest)

    assert.deepEqual(written, ['a.txt', 'b.txt'])
    assert.equal(readFileSync(join(repoRoot, 'a.txt'), 'utf8'), 'staged-a\n')
    assert.equal(readFileSync(join(repoRoot, 'b.txt'), 'utf8'), 'staged-b\n')
  })

  test('rolls back the first file when the second write target is a directory', () => {
    const repoRoot = temp('anvil-apply-rollback-')
    const manifest = stageTwoFiles(repoRoot)

    // Turn b.txt into a directory, so its write fails after a.txt is written.
    replaceWithDirectory(repoRoot, 'b.txt')

    assert.throws(
      () => applyStaging(repoRoot, manifest),
      (err: Error) => err.message.includes('Staging apply failed after writing 1 file(s)'),
    )

    // a.txt must be restored to its pre-apply content.
    assert.equal(readFileSync(join(repoRoot, 'a.txt'), 'utf8'), 'original-a\n')
    // b.txt must still be a directory (the failed write never created a file there).
    assert.ok(existsSync(join(repoRoot, 'b.txt')))
    assert.ok(statSync(join(repoRoot, 'b.txt')).isDirectory())
  })

  test('removes a newly created file on rollback when it did not exist before', () => {
    const repoRoot = temp('anvil-apply-newfile-')
    // Only a.txt pre-exists; b.txt is brand new in the bundle.
    writeFileSync(join(repoRoot, 'a.txt'), 'original-a\n', 'utf8')

    const contents = new Map<string, string>([
      ['a.txt', 'staged-a\n'],
      ['brand-new.txt', 'brand-new content\n'],
    ])
    const manifest = writeStaging(repoRoot, { inputHash: 'deadbeef', generator: 'test' }, contents)

    // Make brand-new.txt's target a directory so its write fails.
    replaceWithDirectory(repoRoot, 'brand-new.txt')

    assert.throws(() => applyStaging(repoRoot, manifest))

    // a.txt restored, brand-new.txt unchanged (it was a directory before apply, not
    // something applyStaging created, so rollback leaves it alone).
    assert.equal(readFileSync(join(repoRoot, 'a.txt'), 'utf8'), 'original-a\n')
    assert.ok(statSync(join(repoRoot, 'brand-new.txt')).isDirectory())
  })

  test('refuses before writing anything when a staged file has disappeared', () => {
    const repoRoot = temp('anvil-apply-missing-')
    writeFileSync(join(repoRoot, 'a.txt'), 'original-a\n', 'utf8')

    const contents = new Map<string, string>([['a.txt', 'staged-a\n']])
    const manifest = writeStaging(repoRoot, { inputHash: 'deadbeef', generator: 'test' }, contents)

    // Delete the staged file before applying.
    rmSync(join(repoRoot, '.anvil', 'staging', 'files', 'a.txt'), { force: true })

    assert.throws(() => applyStaging(repoRoot, manifest))
    // Nothing was written: a.txt still holds its original content.
    assert.equal(readFileSync(join(repoRoot, 'a.txt'), 'utf8'), 'original-a\n')
  })

  test('staging manifest type carries schemaVersion 1', () => {
    const repoRoot = temp('anvil-manifest-schema-')
    const manifest = stageTwoFiles(repoRoot)
    assert.equal(manifest.schemaVersion, 1)
  })
})
