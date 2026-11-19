/**
 * Verify the packed manifest against the workspace manifest and the tag the run claims.
 *
 * Reads the packed `package/package.json` from stdin, so the caller decides how the artifact
 * is unpacked. Run from the repository root.
 *
 * Environment:
 *   TAG_VERSION  version from the release tag, or the manifest candidate on a branch run
 *   REHEARSAL    `1` when the ref carries no tag to compare against
 */
import { readFileSync } from 'node:fs'

const tagVersion = process.env.TAG_VERSION
const rehearsal = process.env.REHEARSAL === '1'
if (!tagVersion) throw new Error('TAG_VERSION is required')

const packed = JSON.parse(readFileSync(0, 'utf8'))
const manifest = JSON.parse(readFileSync('packages/cli/package.json', 'utf8'))

if (packed.name !== manifest.name) {
  throw new Error(`tarball is ${packed.name}, the workspace manifest is ${manifest.name}`)
}
if (packed.name !== '@anvil-workflows/cli') {
  throw new Error(`this workflow publishes @anvil-workflows/cli, not ${packed.name}`)
}
if (packed.version !== manifest.version) {
  throw new Error(`tarball is ${packed.version}, the workspace manifest is ${manifest.version}`)
}
if (!rehearsal && tagVersion !== manifest.version) {
  throw new Error(`tag is v${tagVersion}, the workspace manifest is ${manifest.version}`)
}

console.log(
  rehearsal
    ? `release identity: ${packed.name}@${packed.version} (rehearsal; no tag)`
    : `release identity: ${packed.name}@${packed.version} from tag v${tagVersion}`,
)
