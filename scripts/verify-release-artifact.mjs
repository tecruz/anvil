/**
 * Verify the artifact recovered for publication. Run from the repository root.
 *
 * This is shared by the release workflow and its hermetic test so the test exercises the
 * exact logic publication relies on, including the artifact downloader's directory layout.
 *
 * Environment:
 *   ARTIFACT_DIR       directory holding the retained tarball and its sidecars
 *   EXPECTED_CHECKSUM  SHA-256 preparation recorded for the tarball
 *   SOURCE_SHA         commit preparation built from
 *   TAG_VERSION        version from the release tag
 */
import { createHash } from 'node:crypto'
import { readdirSync, readFileSync } from 'node:fs'
import { basename, join, relative, resolve } from 'node:path'
import { gunzipSync } from 'node:zlib'

const artifactDir = process.env.ARTIFACT_DIR
const expectedChecksum = process.env.EXPECTED_CHECKSUM
const sourceSha = process.env.SOURCE_SHA
const tagVersion = process.env.TAG_VERSION
if (!artifactDir || !expectedChecksum || !sourceSha || !tagVersion) {
  throw new Error('ARTIFACT_DIR, EXPECTED_CHECKSUM, SOURCE_SHA and TAG_VERSION are required')
}

const cwd = process.cwd()
const dir = resolve(cwd, artifactDir)
const tarballs = readdirSync(dir, { withFileTypes: true })
  .filter((entry) => entry.isFile() && entry.name.endsWith('.tgz'))
  .map((entry) => join(dir, entry.name))
if (tarballs.length !== 1) {
  throw new Error(`expected one tarball at the top level of the retained evidence, found ${tarballs.length}`)
}
const tarball = tarballs[0]
const checksums = readFileSync(join(dir, 'SHA256SUMS'), 'utf8')
const lines = checksums.split(/\r?\n/).filter((line) => line.trim() !== '')
if (lines.length !== 1) {
  throw new Error(`SHA256SUMS must contain exactly one entry, found ${lines.length}`)
}
const entry = /^([0-9a-f]{64}) {2}(.+)$/i.exec(lines[0] ?? '')
if (entry === null) throw new Error('SHA256SUMS has an invalid entry')
if (entry[2] !== basename(tarball)) throw new Error('SHA256SUMS names a different tarball')
const expectedBySidecar = (entry[1] ?? '').toLowerCase()
const bytes = readFileSync(tarball)
const actual = createHash('sha256').update(bytes).digest('hex')
if (actual !== expectedBySidecar || actual !== expectedChecksum.toLowerCase()) {
  throw new Error('the tarball does not match the checksum recorded by preparation')
}

function field(header, start, length) {
  return header
    .subarray(start, start + length)
    .toString('utf8')
    .replace(/\0.*$/, '')
    .trim()
}

/** Read package/package.json from the gzipped tar without a platform tar binary. */
function packedManifest(archive) {
  const tar = gunzipSync(archive)
  let offset = 0
  let paxPath = null
  while (offset + 512 <= tar.length) {
    const header = tar.subarray(offset, offset + 512)
    const sizeText = field(header, 124, 12)
    const size = sizeText === '' ? 0 : Number.parseInt(sizeText, 8)
    if (!Number.isFinite(size) || size < 0) throw new Error('invalid tar entry size')
    const content = tar.subarray(offset + 512, offset + 512 + size)
    const type = field(header, 156, 1)
    if (type === 'x' || type === 'g') {
      const match = /\bpath=([^\n]+)/.exec(content.toString('utf8'))
      if (match !== null) paxPath = match[1]
    } else {
      const path = paxPath ?? field(header, 0, 100)
      if (path === 'package/package.json') return JSON.parse(content.toString('utf8'))
      paxPath = null
    }
    offset += 512 + Math.ceil(size / 512) * 512
  }
  throw new Error('the tarball has no package/package.json')
}

const packed = packedManifest(bytes)
if (packed.name !== '@anvil-workflows/cli') throw new Error(`refusing to publish ${packed.name}`)
const tag = tagVersion.startsWith('v') ? tagVersion.slice(1) : tagVersion
if (packed.version !== tag) throw new Error(`tarball is ${packed.version}, tag is v${tag}`)

const notes = readFileSync(join(dir, 'RELEASE_NOTES.md'), 'utf8')
if (!notes.includes(`Source commit: \`${sourceSha}\``)) throw new Error('retained source commit does not match')

console.log(`verified ${packed.name}@${packed.version} (${actual.slice(0, 12)}) in ${relative(cwd, tarball)}`)
