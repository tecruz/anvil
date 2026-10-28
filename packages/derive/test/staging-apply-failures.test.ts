import assert from 'node:assert/strict'
import {
  existsSync,
  linkSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, describe, test } from 'node:test'
import { applyStaging, checkApplyPreconditions, type StagingManifest, validateAll, writeStaging } from '@anvil/derive'

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

/** Simulate an I/O error after the failing write has already changed the target. */
function partiallyFailOnce(failingTarget: string, failure: Error): (target: string, content: string) => void {
  let failed = false
  return (target, content) => {
    if (target === failingTarget && !failed) {
      failed = true
      writeFileSync(target, content.slice(0, 3), 'utf8')
      throw failure
    }
    writeFileSync(target, content, 'utf8')
  }
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
    // The new file must be written successfully before a later target fails.
    writeFileSync(join(repoRoot, 'a.txt'), 'original-a\n', 'utf8')

    const contents = new Map<string, string>([
      ['a.txt', 'staged-a\n'],
      ['brand-new.txt', 'brand-new content\n'],
      ['z.txt', 'staged-z\n'],
    ])
    const manifest = writeStaging(repoRoot, { inputHash: 'deadbeef', generator: 'test' }, contents)

    replaceWithDirectory(repoRoot, 'z.txt')
    assert.equal(existsSync(join(repoRoot, 'brand-new.txt')), false)

    assert.throws(() => applyStaging(repoRoot, manifest), /after writing 2 file\(s\)/)

    assert.equal(readFileSync(join(repoRoot, 'a.txt'), 'utf8'), 'original-a\n')
    assert.equal(existsSync(join(repoRoot, 'brand-new.txt')), false)
    assert.ok(statSync(join(repoRoot, 'z.txt')).isDirectory())
  })

  for (const failingPath of ['a.txt', 'b.txt']) {
    test(`restores a partially written ${failingPath} and allows a safe retry`, () => {
      const repoRoot = temp('anvil-apply-partial-')
      const manifest = stageTwoFiles(repoRoot)
      const failure = Object.assign(new Error('injected partial-write failure'), { code: 'EIO' })

      assert.throws(() => applyStaging(repoRoot, manifest, partiallyFailOnce(join(repoRoot, failingPath), failure)), {
        code: 'INTERNAL',
        cause: failure,
      })

      assert.equal(readFileSync(join(repoRoot, 'a.txt'), 'utf8'), 'original-a\n')
      assert.equal(readFileSync(join(repoRoot, 'b.txt'), 'utf8'), 'original-b\n')
      assert.equal(checkApplyPreconditions(repoRoot, manifest, 'deadbeef').ok, true)
      assert.deepEqual(applyStaging(repoRoot, manifest), ['a.txt', 'b.txt'])
      assert.equal(readFileSync(join(repoRoot, 'a.txt'), 'utf8'), 'staged-a\n')
      assert.equal(readFileSync(join(repoRoot, 'b.txt'), 'utf8'), 'staged-b\n')
    })
  }

  test('removes a newly created target even when its write only partially completes', () => {
    const repoRoot = temp('anvil-apply-partial-new-')
    writeFileSync(join(repoRoot, 'a.txt'), 'original-a\n', 'utf8')
    const contents = new Map([
      ['a.txt', 'staged-a\n'],
      ['brand-new.txt', 'brand-new content\n'],
    ])
    const manifest = writeStaging(repoRoot, { inputHash: 'deadbeef', generator: 'test' }, contents)
    const target = join(repoRoot, 'brand-new.txt')
    const failure = Object.assign(new Error('injected partial-write failure'), { code: 'ENOSPC' })

    assert.throws(() => applyStaging(repoRoot, manifest, partiallyFailOnce(target, failure)), {
      code: 'INTERNAL',
      cause: failure,
    })

    assert.equal(readFileSync(join(repoRoot, 'a.txt'), 'utf8'), 'original-a\n')
    assert.equal(existsSync(target), false)
    assert.equal(checkApplyPreconditions(repoRoot, manifest, 'deadbeef').ok, true)
    assert.deepEqual(applyStaging(repoRoot, manifest), ['a.txt', 'brand-new.txt'])
    assert.equal(readFileSync(target, 'utf8'), 'brand-new content\n')
  })

  for (const linkType of ['hard link', 'directory alias']) {
    test(`restores pre-apply content when two targets share a file through a ${linkType}`, (t) => {
      const repoRoot = temp('anvil-apply-alias-')
      const firstDir = join(repoRoot, 'a')
      const secondDir = join(repoRoot, 'b')
      mkdirSync(firstDir)
      writeFileSync(join(firstDir, 'AGENTS.md'), '# Original human guidance\n', 'utf8')
      try {
        if (linkType === 'hard link') {
          mkdirSync(secondDir)
          linkSync(join(firstDir, 'AGENTS.md'), join(secondDir, 'AGENTS.md'))
        } else {
          symlinkSync(firstDir, secondDir, process.platform === 'win32' ? 'junction' : 'dir')
        }
      } catch (error) {
        t.skip(`links are unavailable here: ${String(error)}`)
        return
      }

      const contents = new Map([
        ['a/AGENTS.md', '# Staged A\n'],
        ['b/AGENTS.md', '# Staged B\n'],
        ['z/AGENTS.md', '# Staged Z\n'],
      ])
      const manifest = writeStaging(repoRoot, { inputHash: 'deadbeef', generator: 'test' }, contents)
      replaceWithDirectory(repoRoot, 'z/AGENTS.md')
      assert.equal(validateAll([...contents].map(([path, content]) => ({ path, content }))).ok, true)
      assert.equal(checkApplyPreconditions(repoRoot, manifest, 'deadbeef').ok, true)

      assert.throws(() => applyStaging(repoRoot, manifest), /after writing 2 file\(s\)/)

      assert.equal(readFileSync(join(firstDir, 'AGENTS.md'), 'utf8'), '# Original human guidance\n')
      assert.equal(readFileSync(join(secondDir, 'AGENTS.md'), 'utf8'), '# Original human guidance\n')
      assert.ok(statSync(join(repoRoot, 'z', 'AGENTS.md')).isDirectory())
      if (linkType === 'directory alias') assert.ok(lstatSync(secondDir).isSymbolicLink())
      else assert.equal(statSync(join(firstDir, 'AGENTS.md')).ino, statSync(join(secondDir, 'AGENTS.md')).ino)
    })
  }

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
