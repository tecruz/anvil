/**
 * @anvil/profile -- stack detection producing a ProjectProfile.
 *
 * Signature-based and non-executing: reads files, never runs a build. Safe on a repo you
 * have never seen and cannot modify.
 */

export {
  emptyProfile,
  normalizeRelPath,
  toPosix,
  type SchemaVersion,
  type CommandEntry,
  type CommandKind,
  type CommandSource,
  type Commands,
  type Docs,
  type InstructionFile,
  type Language,
  type Module,
  type Monorepo,
  type MonorepoTool,
  type ProjectProfile,
  type RiskLevel,
  type RiskPath,
  type Stack,
  type Tooling,
  type Vcs,
  type VcsHost,
} from './types.ts'

export {
  buildProfile,
  type BuildProfileOptions,
  type BuildProfileResult,
} from './build.ts'

export {
  addCommand,
  addLanguage,
  addModule,
  addRisk,
  addStack,
  addTool,
  filesUnder,
  hasAnyFile,
  hasFile,
  hasFileUnder,
  priorityOf,
  setFlag,
  setMonorepo,
  type Detector,
  type DetectorContext,
  type ProfileDraft,
} from './detector.ts'

export { ecosystemDetectors } from './detectors/ecosystems.ts'
export { nodeDetector } from './detectors/node.ts'
export { pythonDetector } from './detectors/python.ts'

export {
  addRiskHeuristics,
  detectDocs,
  detectDocumentedCommands,
  detectGenericTooling,
  detectInstructionFiles,
  globToRegExp,
  matchesAny,
  matchesGlob,
  type DocumentedCommand,
} from './general.ts'

export { extensionOf, firstExisting, readText, walkFiles, HIDDEN_DIR_ALLOW, SKIP_DIRS } from './walk.ts'
export { asString, asStringArray, asObject, evidence, findLine, parseJsonc, readJson, readJsonc, looseVersion } from './manifest.ts'
