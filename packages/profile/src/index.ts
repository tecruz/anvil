/**
 * @anvil/profile -- stack detection producing a ProjectProfile.
 *
 * Signature-based and non-executing: reads files, never runs a build. Safe on a repo you
 * have never seen and cannot modify.
 */

export {
  type BuildProfileOptions,
  type BuildProfileResult,
  buildProfile,
} from './build.ts'
export {
  addCommand,
  addLanguage,
  addModule,
  addRisk,
  addStack,
  addTool,
  type Detector,
  type DetectorContext,
  filesUnder,
  hasAnyFile,
  hasFile,
  hasFileUnder,
  type ProfileDraft,
  priorityOf,
  setFlag,
  setMonorepo,
} from './detector.ts'
export { ecosystemDetectors } from './detectors/ecosystems.ts'
export {
  additionalDetectors,
  elixirDetector,
  frontendDetector,
  phpDetector,
  rubyDetector,
  swiftDetector,
  terraformDetector,
} from './detectors/more.ts'
export { nodeDetector } from './detectors/node.ts'
export { pythonDetector } from './detectors/python.ts'
export {
  addRiskHeuristics,
  type DocumentedCommand,
  detectDocs,
  detectDocumentedCommands,
  detectGenericTooling,
  detectInstructionFiles,
  globToRegExp,
  matchesAny,
  matchesGlob,
} from './general.ts'
export {
  asObject,
  asString,
  asStringArray,
  evidence,
  findLine,
  looseVersion,
  parseJsonc,
  readJson,
  readJsonc,
} from './manifest.ts'
export {
  type CommandEntry,
  type CommandKind,
  type CommandSource,
  type Commands,
  type Docs,
  emptyProfile,
  type InstructionFile,
  type Language,
  type Module,
  type Monorepo,
  type MonorepoTool,
  normalizeRelPath,
  type ProjectProfile,
  type RiskLevel,
  type RiskPath,
  type SchemaVersion,
  type Stack,
  type Tooling,
  toPosix,
  type Vcs,
  type VcsHost,
} from './types.ts'
export {
  extensionOf,
  firstExisting,
  HIDDEN_DIR_ALLOW,
  readText,
  SKIP_DIRS,
  SKIP_TEST_DATA_DIRS,
  walkFiles,
} from './walk.ts'
