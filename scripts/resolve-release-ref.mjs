/**
 * Choose the version a release run claims and whether it is a rehearsal.
 *
 * Run from the repository root; stdout is appended to `$GITHUB_OUTPUT`.
 *
 * Environment:
 *   GITHUB_REF  full ref the run targets (`refs/tags/v1.2.3`, `refs/heads/main`, ...)
 *
 * A `v*` tag is the claim being released, or rehearsed by a dispatch on that tag. Anything
 * else -- a branch dispatch -- has no tag to compare against, so the candidate comes from the
 * workspace manifest and the run is a rehearsal. One decision produces both values, so the
 * version the identity gate compares and the flag that selects the gate cannot disagree.
 */
import { readFileSync } from 'node:fs'

const ref = process.env.GITHUB_REF
if (!ref) throw new Error('GITHUB_REF is required')

const tag = /^refs\/tags\/v(.+)$/.exec(ref)?.[1]
const version = tag ?? JSON.parse(readFileSync('packages/cli/package.json', 'utf8')).version
if (!version) throw new Error('the workspace manifest has no version')

console.log(`version=${version}`)
console.log(`rehearsal=${tag === undefined ? 1 : 0}`)
