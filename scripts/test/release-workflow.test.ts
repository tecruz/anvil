/**
 * Guard the release workflow's no-publish rehearsal path.
 *
 * `.github/workflows/**` is high-risk: a stray edit can publish bytes from a manual run, and
 * a release cannot be undone. These assertions read the source text rather than a parsed
 * document -- the repository declares no YAML dependency -- and check the guards in the
 * context of the step or job they belong to, so a guard elsewhere in the file cannot satisfy
 * them.
 */

import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { describe, test } from 'node:test'
import { fileURLToPath } from 'node:url'
import { gzipSync } from 'node:zlib'

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../..')
const workflow = readFileSync(join(repoRoot, '.github', 'workflows', 'release.yml'), 'utf8')

/** One `- name:` step, from its marker to the next step, so a guard must be in that step. */
function step(name: string): string {
  const marker = `- name: ${name}`
  const start = workflow.indexOf(marker)
  assert.notEqual(start, -1, `the release workflow has no step named ${name}`)
  const next = workflow.indexOf('\n      - name:', start + marker.length)
  return workflow.slice(start, next === -1 ? workflow.length : next)
}

/** One top-level job, so token permissions in one job cannot satisfy a guard on another. */
function job(name: string): string {
  const jobs = [...workflow.matchAll(/^ {2}([a-z][a-z-]*):$/gm)]
  const index = jobs.findIndex((match) => match[1] === name)
  assert.notEqual(index, -1, `the release workflow has no job named ${name}`)
  const found = jobs[index]
  assert.ok(found !== undefined)
  const end = jobs[index + 1]?.index ?? workflow.length
  return workflow.slice(found.index, end)
}

/** Build a minimal gzipped tar containing one package/package.json entry. */
function tarballWithSummary(pkg: { name: string; version: string; description?: string }): Buffer {
  const body = Buffer.from(JSON.stringify(pkg))
  const header = Buffer.alloc(512)
  header.write('package/package.json', 0, 100, 'utf8')
  header.write('0000644\0', 100, 8)
  header.write('0000000\0', 108, 8)
  header.write('0000000\0', 116, 8)
  header.write(`${body.length.toString(8).padStart(11, '0')}\0`, 124, 12)
  header.write('00000000000\0', 136, 12)
  header.fill(0x20, 148, 156)
  header.write('0', 156, 1)
  header.write('ustar\0', 257, 6)
  header.write('00', 263, 2)
  const sum = [...header].reduce((total, byte) => total + byte, 0)
  header.write(`${sum.toString(8).padStart(6, '0')}\0 `, 148, 8)
  const padded = Buffer.alloc(Math.ceil(body.length / 512) * 512)
  body.copy(padded)
  return gzipSync(Buffer.concat([header, padded, Buffer.alloc(1024)]))
}

describe('release workflow rehearsal', () => {
  test('both a version tag and a manual dispatch trigger the workflow', () => {
    assert.ok(workflow.includes('workflow_dispatch:'), 'a manual rehearsal must be possible')
    assert.ok(workflow.includes("tags: ['v*']"), 'a tag must still trigger a real release')
  })

  test('only the tag-gated publish job can reach npm and OIDC', () => {
    const publish = job('publish')
    assert.match(
      publish,
      /if: \$\{\{ github\.event_name == 'push' && startsWith\(github\.ref, 'refs\/tags\/v'\) \}\}/,
      'publication requires a real version tag',
    )
    assert.match(publish, /needs: release/, 'publication depends on the tested artifact')
    assert.match(publish, /id-token: write/, 'only the publish job gets OIDC')
    assert.match(publish, /secrets\.NPM_TOKEN/)
    assert.match(publish, /run: npm publish/)

    const prepare = job('release')
    assert.doesNotMatch(prepare, /^\s+run: npm publish/m, 'preparation never publishes')
    assert.doesNotMatch(prepare, /secrets\.NPM_TOKEN/, 'preparation never sees the token')
    assert.doesNotMatch(prepare, /id-token: write/, 'preparation never gets OIDC')
    assert.match(prepare, /contents: read/)

    const beforeJobs = workflow.slice(0, workflow.indexOf('\njobs:'))
    assert.doesNotMatch(beforeJobs, /id-token: write/, 'OIDC is not granted at workflow scope')
  })

  test('publication consumes the artifact that was tested, without rebuilding', () => {
    const upload = step('retain the tested tarball, checksum and draft release notes')
    const download = step('recover the tested artifact')
    assert.match(upload, /actions\/upload-artifact@[0-9a-f]{40}/)
    assert.match(download, /actions\/download-artifact@[0-9a-f]{40}/)
    assert.match(download, /path: dist/)
    assert.match(download, /artifact-ids: \$\{\{ needs\.release\.outputs\.artifact_id \}\}/)
    assert.match(download, /merge-multiple: true/, 'one artifact ID must be extracted directly into dist')
    const publish = job('publish')
    assert.match(publish, /node scripts\/verify-release-artifact\.mjs/)
    assert.doesNotMatch(publish, /npm ci|npm run check|npm pack/, 'the publish job must not rebuild')
  })

  test('a publish-only retry cannot look for an artifact under a new run attempt', () => {
    const prepare = job('release')
    for (const output of ['artifact_id', 'checksum', 'source_sha']) {
      assert.match(prepare, new RegExp(`^ {6}${output}:`, 'm'), `preparation must export ${output}`)
    }
    assert.match(prepare, /artifact_id: \$\{\{ steps\.upload_evidence\.outputs\['artifact-id'\] \}\}/)
    const publish = job('publish')
    assert.doesNotMatch(publish, /github\.run_attempt/, 'attempt is not part of artifact identity')
    assert.match(publish, /EXPECTED_CHECKSUM: \$\{\{ needs\.release\.outputs\.checksum \}\}/)
    assert.match(publish, /SOURCE_SHA: \$\{\{ needs\.release\.outputs\.source_sha \}\}/)
    const verify = step('verify the artifact before publication')
    assert.match(verify, /node scripts\/verify-release-artifact\.mjs/)
    assert.match(verify, /EXPECTED_CHECKSUM: \$\{\{ needs\.release\.outputs\.checksum \}\}/)
  })

  test('the artifact verifier accepts intact bytes and rejects changes', () => {
    const workspace = mkdtempSync(join(tmpdir(), 'anvil-release-verify-'))
    const artifactDir = join(workspace, 'dist')
    mkdirSync(artifactDir)
    try {
      const tarball = join(artifactDir, 'anvil-workflows-cli-0.1.0.tgz')
      const bytes = tarballWithSummary({ name: '@anvil-workflows/cli', version: '0.1.0' })
      writeFileSync(tarball, bytes)
      const checksum = createHash('sha256').update(bytes).digest('hex')
      writeFileSync(join(artifactDir, 'SHA256SUMS'), `${checksum}  anvil-workflows-cli-0.1.0.tgz\n`)
      writeFileSync(join(artifactDir, 'RELEASE_NOTES.md'), 'Source commit: `source-sha`\n')

      const env = {
        ...process.env,
        ARTIFACT_DIR: artifactDir,
        EXPECTED_CHECKSUM: checksum,
        SOURCE_SHA: 'source-sha',
        TAG_VERSION: 'v0.1.0',
        GITHUB_SHA: 'source-sha',
      }
      const run = (): { status: number | null; output: string } => {
        const result = spawnSync(process.execPath, [join(repoRoot, 'scripts', 'verify-release-artifact.mjs')], {
          cwd: repoRoot,
          env,
          encoding: 'utf8',
        })
        return { status: result.status, output: `${result.stdout ?? ''}\n${result.stderr ?? ''}` }
      }
      const nested = join(artifactDir, 'release-evidence-1')
      mkdirSync(nested)
      cpSync(tarball, join(nested, 'anvil-workflows-cli-0.1.0.tgz'))
      rmSync(tarball)
      assert.notEqual(run().status, 0, 'a tarball nested under the artifact name must not pass')
      cpSync(join(nested, 'anvil-workflows-cli-0.1.0.tgz'), tarball)
      const intact = run()
      assert.equal(intact.status, 0, `the intact artifact must pass: ${intact.output}`)

      writeFileSync(tarball, tarballWithSummary({ name: '@anvil-workflows/cli', version: '0.1.1' }))
      const changed = run()
      assert.notEqual(changed.status, 0, 'modified bytes must fail')
      assert.match(changed.output, /checksum/i)

      // Restore intact bytes first, so only the sidecar can explain a failure here.
      const sidecar = join(artifactDir, 'SHA256SUMS')
      const line = `${checksum}  anvil-workflows-cli-0.1.0.tgz\n`
      writeFileSync(tarball, bytes)
      writeFileSync(sidecar, `${checksum}  other.tgz\n`)
      const misnamed = run()
      assert.notEqual(misnamed.status, 0, 'a sidecar naming another file must fail')
      assert.match(misnamed.output, /names a different tarball/)

      writeFileSync(sidecar, `${line}${'0'.repeat(64)}  other.tgz\n`)
      const extra = run()
      assert.notEqual(extra.status, 0, 'an extra sidecar entry must fail')
      assert.match(extra.output, /exactly one entry/)

      // Matching a forged sidecar to tampered bytes is not enough: preparation's checksum is
      // the authority. This archive is valid and keeps the name and version, so only the
      // checksum recorded during preparation can reject it.
      const tampered = tarballWithSummary({
        name: '@anvil-workflows/cli',
        version: '0.1.0',
        description: 'tampered bytes',
      })
      writeFileSync(tarball, tampered)
      writeFileSync(sidecar, `${createHash('sha256').update(tampered).digest('hex')}  anvil-workflows-cli-0.1.0.tgz\n`)
      const forged = run()
      assert.notEqual(forged.status, 0, 'changed bytes with a matching sidecar must fail')
      assert.match(forged.output, /recorded by preparation/)

      writeFileSync(tarball, bytes)
      writeFileSync(sidecar, line)
      writeFileSync(join(artifactDir, 'RELEASE_NOTES.md'), 'Source commit: `other-sha`\n')
      const wrongSource = run()
      assert.notEqual(wrongSource.status, 0, 'a mismatched source commit must fail')
      assert.match(wrongSource.output, /source commit does not match/)

      writeFileSync(join(artifactDir, 'RELEASE_NOTES.md'), 'Source commit: `source-sha`extra\n')
      const appended = run()
      assert.notEqual(appended.status, 0, 'a source line with extra text must fail')
      assert.match(appended.output, /source commit does not match/)

      writeFileSync(join(artifactDir, 'RELEASE_NOTES.md'), 'Source commit: `source-sha`\n')
      env.GITHUB_SHA = 'other-sha'
      const wrongCommit = run()
      assert.notEqual(wrongCommit.status, 0, 'a preparation commit other than the checked-out one must fail')
      assert.match(wrongCommit.output, /does not match the tag commit/)
      env.GITHUB_SHA = 'source-sha'
    } finally {
      rmSync(workspace, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })
    }
  })

  test('a branch dispatch takes its version from the manifest, a tag dispatch from the ref', () => {
    const provenance = step('record checksum and provenance')
    assert.match(provenance, /node scripts\/resolve-release-ref\.mjs/, 'the ref decides the version')
    assert.doesNotMatch(provenance, /GITHUB_EVENT_NAME/, 'a dispatch on a tag still has a tag')
    const identity = step('verify the release identity')
    assert.match(identity, /node scripts\/verify-release-identity\.mjs/, 'the gate lives where the test runs it')
    assert.doesNotMatch(identity, /startsWith\(github\.ref/, 'the identity step cannot re-derive the tag check')
    assert.match(identity, /REHEARSAL: \$\{\{ steps\.provenance\.outputs\.rehearsal \}\}/)
  })

  test('the ref resolver and identity gate agree on what a tag claims', () => {
    const manifest = JSON.parse(readFileSync(join(repoRoot, 'packages/cli/package.json'), 'utf8')) as {
      name: string
      version: string
    }
    const resolve = (ref: string): { version: string; rehearsal: string } => {
      const result = spawnSync(process.execPath, [join(repoRoot, 'scripts', 'resolve-release-ref.mjs')], {
        cwd: repoRoot,
        env: { ...process.env, GITHUB_REF: ref },
        encoding: 'utf8',
      })
      assert.equal(result.status, 0, `resolving ${ref} failed: ${result.stderr}`)
      const pairs = (result.stdout ?? '')
        .trim()
        .split('\n')
        .map((line) => line.split('='))
      return Object.fromEntries(pairs) as { version: string; rehearsal: string }
    }
    const identity = (
      packed: unknown,
      tagVersion: string,
      rehearsal: string,
    ): { status: number | null; output: string } => {
      const result = spawnSync(process.execPath, [join(repoRoot, 'scripts', 'verify-release-identity.mjs')], {
        cwd: repoRoot,
        env: { ...process.env, TAG_VERSION: tagVersion, REHEARSAL: rehearsal },
        input: JSON.stringify(packed),
        encoding: 'utf8',
      })
      return { status: result.status, output: `${result.stdout ?? ''}\n${result.stderr ?? ''}` }
    }
    const packed = { name: manifest.name, version: manifest.version }

    const branch = resolve('refs/heads/main')
    assert.deepEqual(branch, { version: manifest.version, rehearsal: '1' }, 'a branch has no tag to claim')
    assert.equal(identity(packed, branch.version, branch.rehearsal).status, 0)

    const matching = resolve(`refs/tags/v${manifest.version}`)
    assert.deepEqual(matching, { version: manifest.version, rehearsal: '0' }, 'a release tag is not a rehearsal')
    assert.equal(identity(packed, matching.version, matching.rehearsal).status, 0)

    // The tag arm must take its version from the ref: the gate has to reject the mismatch,
    // which it cannot do if the resolver handed it the manifest version instead.
    const mismatched = resolve('refs/tags/v9.9.9')
    assert.deepEqual(mismatched, { version: '9.9.9', rehearsal: '0' })
    const rejected = identity(packed, mismatched.version, mismatched.rehearsal)
    assert.notEqual(rejected.status, 0, 'a tag that disagrees with the manifest must fail')
    assert.match(rejected.output, /tag is v9\.9\.9/)
  })

  test('both jobs are bounded and cannot cancel an in-flight release', () => {
    assert.match(
      workflow,
      /^concurrency:\n {2}group: release-\$\{\{ github\.event_name \}\}-\$\{\{ github\.ref \}\}\n {2}cancel-in-progress: false$/m,
    )
    assert.match(job('release'), /^\s{4}timeout-minutes: 30$/m)
    assert.match(job('publish'), /^\s{4}timeout-minutes: 15$/m)
    const checkouts =
      workflow.match(
        /- uses: actions\/checkout@[0-9a-f]{40}[^\n]*\n\s+with:\n(?:\s*#[^\n]*\n)*\s+persist-credentials: false/g,
      ) ?? []
    assert.equal(checkouts.length, 2, 'both checkouts drop the persisted token')
  })

  test('step outputs reach the shell through env, not string interpolation', () => {
    const scriptOf = (text: string): string => {
      const marker = text.indexOf('run: |')
      return marker === -1 ? text.slice(text.indexOf('run:')) : text.slice(marker)
    }
    const identity = step('verify the release identity')
    assert.match(identity, /TARBALL: \$\{\{ steps\.provenance\.outputs\.tarball \}\}/)
    assert.doesNotMatch(scriptOf(identity), /\$\{\{/, 'the identity script must not interpolate expressions')
    const smoke = step('smoke-test the installed tarball')
    assert.match(smoke, /TARBALL: \$\{\{ steps\.provenance\.outputs\.tarball \}\}/)
    assert.doesNotMatch(scriptOf(smoke), /\$\{\{/, 'the smoke-test script must not interpolate expressions')
  })

  test('the publish job installs nothing and restores no cache', () => {
    const publish = job('publish')
    assert.match(publish, /registry-url: 'https:\/\/registry\.npmjs\.org'/)
    assert.doesNotMatch(publish, /^\s+cache: npm$/m, 'a job that installs nothing must not save a cache entry')
  })

  test('rehearsal evidence is named apart from a real release', () => {
    assert.match(step('retain the tested tarball, checksum and draft release notes'), /'rehearsal-'/)
    const publish = job('publish')
    assert.doesNotMatch(publish, /rehearsal-/, 'publication never consumes rehearsal evidence')
  })

  test('the job summary claims retention only after the upload succeeds', () => {
    const upload = workflow.indexOf('- name: retain the tested tarball, checksum and draft release notes')
    const summary = workflow.indexOf('- name: retain the release evidence in the job summary')
    assert.ok(upload !== -1 && summary > upload, 'the success summary comes after the upload')
    assert.match(step('retain the release evidence in the job summary'), /Evidence retained/)
  })

  test('least-privilege permissions and SHA-pinned actions are unchanged', () => {
    const pins = [...workflow.matchAll(/uses: ([^\s]+)/g)].map((match) => match[1])
    assert.ok(pins.length > 0, 'expected at least one action')
    for (const pin of pins) assert.match(pin ?? '', /@[0-9a-f]{40}$/)
  })
})
