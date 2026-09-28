/**
 * The profile builder: run every detector, then fold in the language-agnostic facts.
 *
 * Detector order is by `priority`, so a more specific ecosystem (JVM over Node) gets to
 * claim shared state first. Every detector is independent and additive; a detector that
 * throws is skipped and reported rather than failing the whole profile, because a partial
 * profile is far more useful than none.
 */

import { emptyProfile, type ProjectProfile, type Vcs } from './types.ts'
import { addLanguage, type Detector, type DetectorContext, type ProfileDraft } from './detector.ts'
import { ecosystemDetectors } from './detectors/ecosystems.ts'
import {
  addRiskHeuristics,
  detectDocs,
  detectDocumentedCommands,
  detectGenericTooling,
  detectInstructionFiles,
} from './general.ts'
import { extensionOf, walkFiles } from './walk.ts'
import { addCommand } from './detector.ts'
import type { CommandKind } from './types.ts'

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
const COUNTED = new Set(EXTENSION_LANGUAGES.map(([ext]) => ext).filter((ext) => !['.yaml', '.yml', '.json', '.md', '.sql', '.tf'].includes(ext)))

const MAX_MANIFEST_BYTES = 4 * 1024 * 1024

export interface BuildProfileOptions {
  /** Extra detectors, appended after the built-ins. */
  extraDetectors?: readonly Detector[]
}

export interface BuildProfileResult {
  profile: ProjectProfile
  /** Detectors that threw, with the reason. Surfaced so a partial profile is not silent. */
  failedDetectors: Array<{ id: string; error: string }>
  /** True when the walk hit its file cap, meaning the profile may be incomplete. */
  truncated: boolean
}

export function buildProfile(root: string, vcs: Vcs, options: BuildProfileOptions = {}): BuildProfileResult {
  const { files, truncated } = walkFiles(root)
  const fileSet = new Set(files)

  const ctx: DetectorContext = { root, files: fileSet, maxFileBytes: MAX_MANIFEST_BYTES }

  const draft: ProfileDraft = {
    root,
    languages: [],
    stacks: [],
    modules: [],
    monorepo: null,
    tooling: { ci: [], lint: [], formatter: [], typecheck: [], test: [], container: false, iac: [], hooks: [] },
    risk: [],
    commands: {},
    files: fileSet,
  }

  const detectors = [...ecosystemDetectors, ...(options.extraDetectors ?? [])]
    .slice()
    .sort((a, b) => a.priority - b.priority)

  const failedDetectors: BuildProfileResult['failedDetectors'] = []
  for (const detector of detectors) {
    try {
      if (!detector.matches(ctx)) continue
      detector.detect(ctx, draft)
    } catch (err) {
      failedDetectors.push({ id: detector.id, error: err instanceof Error ? err.message : String(err) })
    }
  }

  // Language counts come from the walk, not the detectors, so a language present in the
  // repo is still reported when no manifest was found to claim it.
  applyLanguageCounts(draft, files)

  detectGenericTooling(draft, root, fileSet)
  addRiskHeuristics(draft, fileSet)

  // Prose commands outrank script-name heuristics. This is the documented > detected
  // ordering, applied at the one place where both sources exist.
  for (const doc of detectDocumentedCommands(root, fileSet)) {
    addCommand(draft, doc.kind as CommandKind, { cmd: doc.cmd, source: 'documented', evidence: doc.evidence })
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
  }

  return { profile, failedDetectors, truncated }
}

function applyLanguageCounts(draft: ProfileDraft, files: readonly string[]): void {  const counts = new Map<string, number>()
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
