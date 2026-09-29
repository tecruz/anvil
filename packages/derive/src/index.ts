/**
 * @anvil/derive -- the LLM seam.
 *
 * The CLI never calls a model. It gathers verified facts (brief), generates a working
 * baseline (generate), validates whatever comes back (validate), and shows the diff
 * (diff). The model does the prose and the structure only it can see.
 */

export {
  buildBrief,
  computeGaps,
  type Brief,
  type BriefCommand,
  type BriefFileExcerpt,
  type BriefModule,
  type BriefTarget,
  type BuildBriefOptions,
} from './brief.ts'

export {
  bestCommand,
  generateAgentsFile,
  generateReviewCommand,
  generateVerifySkill,
  type GenerateOptions,
  type GeneratedArtifact,
} from './generate.ts'

export {
  SKILL_DESCRIPTION_MAX,
  SKILL_NAME_PATTERN,
  classifyArtifact,
  parseFrontmatter,
  skillDirName,
  validateAll,
  validateArtifact,
  type ArtifactKind,
  type ArtifactValidation,
  type ParsedFrontmatter,
  type ValidateSummary,
} from './validate.ts'

export {
  buildHunks,
  diffFile,
  diffLines,
  renderUnifiedDiff,
  splitLines,
  summarize,
  type DiffHunk,
  type DiffInput,
  type DiffLine,
  type FileDiff,
} from './diff.ts'

export {
  GITIGNORE_SNIPPET,
  applyStaging,
  checkApplyPreconditions,
  clearStaging,
  hashInputs,
  inspectStaging,
  manifestPath,
  readManifest,
  readRepoFile,
  readStaged,
  sha256,
  stagingRoot,
  writeStaging,
  type ApplyPrecondition,
  type StagedFile,
  type StagingManifest,
  type StagingState,
} from './staging.ts'
