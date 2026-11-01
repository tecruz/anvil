/**
 * The profile builder: run every detector, then fold in the language-agnostic facts.
 *
 * Detector order is by `priority`, so a more specific ecosystem (JVM over Node) gets to
 * claim shared state first. Every detector is independent and additive; a detector that
 * throws is skipped and reported rather than failing the whole profile, because a partial
 * profile is far more useful than none.
 */

import { addCommand, addLanguage, type Detector, type DetectorContext, type ProfileDraft } from './detector.ts'
import { ecosystemDetectors } from './detectors/ecosystems.ts'
import { additionalDetectors } from './detectors/more.ts'
import {
  addRiskHeuristics,
  detectDocs,
  detectDocumentedCommands,
  detectGenericTooling,
  detectInstructionFiles,
} from './general.ts'
import type { CommandKind } from './types.ts'
import { emptyProfile, type ProjectProfile, type Vcs } from './types.ts'
import { DEFAULT_MAX_FILES, extensionOf, makeResolver, projectDirOf, walkFiles } from './walk.ts'

/** Extension → language. The set that matters for agent context, not an exhaustive map. */
const EXTENSION_LANGUAGES: ReadonlyArray<[ext: string, lang: string]> = [
  ['.ts', 'typescript'],
  ['.tsx', 'typescript'],
  ['.mts', 'typescript'],
  ['.cts', 'typescript'],
  ['.js', 'javascript'],
  ['.jsx', 'javascript'],
  ['.mjs', 'javascript'],
  ['.cjs', 'javascript'],
  ['.py', 'python'],
  ['.go', 'go'],
  ['.rs', 'rust'],
  ['.java', 'java'],
  ['.kt', 'kotlin'],
  ['.kts', 'kotlin'],
  ['.cs', 'csharp'],
  ['.fs', 'fsharp'],
  ['.rb', 'ruby'],
  ['.php', 'php'],
  ['.swift', 'swift'],
  ['.dart', 'dart'],
  ['.scala', 'scala'],
  ['.c', 'c'],
  ['.h', 'c'],
  ['.cc', 'cpp'],
  ['.cpp', 'cpp'],
  ['.hpp', 'cpp'],
  ['.ex', 'elixir'],
  ['.exs', 'elixir'],
  ['.sh', 'shell'],
  ['.ps1', 'powershell'],
  ['.psm1', 'powershell'],
  ['.psd1', 'powershell'],
  ['.sql', 'sql'],
  ['.vue', 'vue'],
  ['.svelte', 'svelte'],
  ['.tf', 'terraform'],
  ['.yaml', 'yaml'],
  ['.yml', 'yaml'],
  ['.json', 'json'],
  ['.md', 'markdown'],
]

/** Extensions counted toward the language profile. Data/config formats are excluded. */
const COUNTED = new Set(
  EXTENSION_LANGUAGES.map(([ext]) => ext).filter(
    (ext) => !['.yaml', '.yml', '.json', '.md', '.sql', '.tf'].includes(ext),
  ),
)

const MAX_MANIFEST_BYTES = 4 * 1024 * 1024

export interface BuildProfileOptions {
  /** Extra detectors, appended after the built-ins. */
  extraDetectors?: readonly Detector[]
  /**
   * Extra directory names to skip, on top of the build-output and test-data defaults.
   * The escape hatch for a project whose sources sit somewhere the defaults skip.
   */
  skipDirs?: ReadonlySet<string>
  /**
   * Directory names to walk *anyway*, overriding the skip lists. For a project that
   * genuinely keeps source in a directory the defaults treat as output.
   */
  followDirs?: ReadonlySet<string>
  /** Hard cap on walked files. Defaults to `DEFAULT_MAX_FILES`. */
  maxFiles?: number
}

export interface BuildProfileResult {
  profile: ProjectProfile
  /** Detectors that threw, with the reason. Surfaced so a partial profile is not silent. */
  failedDetectors: Array<{ id: string; error: string }>
  /** True when the walk hit its file cap, meaning the profile may be incomplete. */
  truncated: boolean
}

export function buildProfile(root: string, vcs: Vcs, options: BuildProfileOptions = {}): BuildProfileResult {
  const fileLimit = options.maxFiles ?? DEFAULT_MAX_FILES
  const { files, truncated } = walkFiles(root, {
    ...(options.skipDirs === undefined ? {} : { extraSkipDirs: options.skipDirs }),
    ...(options.followDirs === undefined ? {} : { followDirs: options.followDirs }),
    maxFiles: fileLimit,
  })
  const fileSet = new Set(files)

  // A project that does not live at the repository root is resolved once, here, and handed
  // to every detector as `ctx.resolve`. Computing it in one place is what keeps detection
  // and evidence in agreement: a claim about `engine/Cargo.toml:12` is made by the same
  // rule that decided the stack is rust, so the two cannot drift apart.
  const projectDir = projectDirOf(fileSet)
  const resolve = makeResolver(fileSet, projectDir)

  const ctx: DetectorContext = {
    root,
    files: fileSet,
    maxFileBytes: MAX_MANIFEST_BYTES,
    resolve,
  }

  const draft: ProfileDraft = {
    root,
    languages: [],
    stacks: [],
    modules: [],
    monorepo: null,
    tooling: {
      ci: [],
      lint: [],
      formatter: [],
      typecheck: [],
      test: [],
      container: false,
      iac: [],
      hooks: [],
    },
    risk: [],
    commands: {},
    files: fileSet,
  }

  const detectors = [...ecosystemDetectors, ...additionalDetectors, ...(options.extraDetectors ?? [])]
    .slice()
    .sort((a, b) => a.priority - b.priority)

  const failedDetectors: BuildProfileResult['failedDetectors'] = []
  for (const detector of detectors) {
    try {
      if (!detector.matches(ctx)) continue
      detector.detect(ctx, draft)
    } catch (err) {
      failedDetectors.push({
        id: detector.id,
        error: err instanceof Error ? err.message : String(err),
      })
    }
  }

  // Language counts come from the walk, not the detectors, so a language present in the
  // repo is still reported when no manifest was found to claim it.
  applyLanguageCounts(draft, files)

  detectGenericTooling(draft, root, fileSet, resolve)
  addRiskHeuristics(draft, fileSet)

  // Prose commands outrank script-name heuristics. This is the documented > detected
  // ordering, applied at the one place where both sources exist.
  for (const doc of detectDocumentedCommands(root, fileSet)) {
    addCommand(draft, doc.kind as CommandKind, {
      cmd: doc.cmd,
      source: 'documented',
      evidence: doc.evidence,
    })
  }

  const profile: ProjectProfile = {
    ...emptyProfile(root, vcs),
    monorepo: draft.monorepo,
    languages: draft.languages.sort((a, b) => b.files - a.files),
    modules: draft.modules,
    stacks: draft.stacks,
    commands: draft.commands,
    tooling: draft.tooling,
    risk: draft.risk,
    instructions: detectInstructionFiles(root, fileSet),
    docs: detectDocs(root),
    files,
    projectDir,
    diagnostics: {
      truncated,
      fileLimit,
      failedDetectors: failedDetectors.map((d) => ({ ...d })),
    },
  }

  // Detectors ask for `Cargo.toml` and were answered about `engine/Cargo.toml`; the paths
  // they recorded as evidence still say the former. One pass fixes every claim in the
  // profile, which is the only place that can -- an evidence string is a plain string, and
  // correcting it at each construction site would mean one omission per detector per call.
  //
  // A no-op when the project is at the root, because `resolve` is then the identity.
  resolveProfileEvidence(profile, resolve)

  return { profile, failedDetectors, truncated }
}

/**
 * Rewrite evidence paths that resolve to a different file than they name.
 *
 * Only rewrites when the bare name does *not* exist at the root and the resolved one does,
 * so evidence that is already correct -- including paths that legitimately point at the
 * root, like `README.md` or `.github/workflows/ci.yml`, in a repository whose project is in
 * a subdirectory -- is left exactly as it is. Anything unresolved keeps its original
 * string: an evidence path that names a file which is not there is a weaker claim than one
 * that names the wrong file, and neither may be invented.
 */
function resolveProfileEvidence(profile: ProjectProfile, resolve: (rel: string) => string): void {
  const fix = (entry: string): string => {
    const colon = entry.lastIndexOf(':')
    const hasLine = colon > 0 && /^\d+$/.test(entry.slice(colon + 1))
    const path = hasLine ? entry.slice(0, colon) : entry
    const resolved = resolve(path)
    if (resolved === path) return entry
    return hasLine ? `${resolved}:${entry.slice(colon + 1)}` : resolved
  }
  for (const stack of profile.stacks) {
    stack.evidence = stack.evidence.map(fix)
  }
  for (const entries of Object.values(profile.commands)) {
    for (const entry of entries) {
      if (entry.evidence !== undefined) entry.evidence = fix(entry.evidence)
    }
  }
  if (profile.monorepo !== null) {
    profile.monorepo.evidence = fix(profile.monorepo.evidence)
  }
}

function applyLanguageCounts(draft: ProfileDraft, files: readonly string[]): void {
  const counts = new Map<string, number>()
  for (const f of files) {
    const ext = extensionOf(f)
    if (ext === null || !COUNTED.has(ext)) continue
    const lang = EXTENSION_LANGUAGES.find(([e]) => e === ext)?.[1]
    if (lang === undefined) continue
    counts.set(lang, (counts.get(lang) ?? 0) + 1)
  }
  const sorted = [...counts.entries()].sort((a, b) => b[1] - a[1])
  const top = sorted[0]?.[0] ?? null
  for (const [lang, count] of sorted) {
    addLanguage(draft, { id: lang, files: count, primary: lang === top })
  }
}
