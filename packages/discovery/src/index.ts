/**
 * @anvil/discovery -- what the ecosystem has published that this registry has not.
 *
 * The playbook registry is curated and correct about what it knows. It is also, by
 * construction, blind to anything published since a human last edited it, and there is a
 * concrete example that motivated this package: Google's Android team ships an official
 * `android` CLI and an agent-skills repository, and `android.yaml` listed neither, because
 * there was nowhere in the format to record "look here and find out".
 *
 * Three rules shape everything here, and each one exists because of a way the obvious
 * implementation is wrong:
 *
 *   1. **The seeds are curated; the answers are fetched.** Which orgs speak for a
 *      technology is a fact a human can review and is stable for years. Which repos they
 *      published last month is not. Putting the answers in YAML would make the registry
 *      rot at the speed of GitHub while carrying the authority of a reviewed file.
 *
 *   2. **Nothing discovered here writes to `registry/playbooks/`.** `discover --propose`
 *      prints YAML for a human to read and merge. A tool that edits curated data turns a
 *      reviewable file into a cache with a git history, and the first bad fetch becomes
 *      permanent content in a document that claims to be hand-maintained.
 *
 *   3. **A source that cannot be reached says so and contributes nothing.** `gh` missing,
 *      no token, a rate limit, a timeout -- each is a partial result with a warning, never
 *      a silently smaller list that reads like a complete one. "I don't know" is an answer,
 *      and it is the answer this package gives when the network does not cooperate.
 *
 * Network I/O is behind injected seams throughout, for the reason `check.ts` already
 * documents: a test that reads whatever the developer's network happens to return is not a
 * test. The live suite is separate and gated on `ANVIL_LIVE=1`.
 */

export type { DiscoverSeeds } from '@anvil/playbooks'
export {
  CACHE_DIR_NAME,
  type CacheFile,
  type CacheRead,
  type CacheStatus,
  cachePathFor,
  DEFAULT_TTL_DAYS,
  discoveryCacheDir,
  isEntry,
  loadCache,
  saveCache,
  usableEntries,
} from './cache.ts'
export {
  type DiscoverOptions,
  type DiscoveryEntry,
  type DiscoveryReport,
  type DiscoverySource,
  discover,
  discoverAll,
  type GhRun,
  isAgentTooling,
  isOfficialOrg,
  liveConfidence,
  type PlaybookDiscovery,
  queriesFor,
  type SearchResult,
  type SourceNote,
  searchGitHub,
  sectionFor,
} from './github.ts'
export {
  type LocalScanOptions,
  type LocalSkill,
  scanLocalSkills,
  skillMatchesSeeds,
  skillSearchRoots,
} from './localScan.ts'
export { DEFAULT_MCP_REGISTRY, fetchMcpServers, type McpEntry, type McpOptions, parseServers } from './mcpRegistry.ts'
export { citedUrls, type ProposalBlock, proposePlaybookYaml, rankForProposal } from './propose.ts'
export { type RefreshResult, refreshLive } from './refresh.ts'
export {
  dedupeEntries,
  discoverLocal,
  matchTerms,
  type RunOptions,
  type RunResult,
  runDiscovery,
} from './run.ts'
export { defaultTimeoutMs, type FetchImpl, type HttpResult, requestJson } from './transport.ts'
