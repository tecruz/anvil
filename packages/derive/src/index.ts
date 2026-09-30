/**
 * @anvil/derive -- the LLM seam.
 *
 * The CLI never calls a model. It gathers verified facts (brief), generates a working
 * baseline (generate), validates whatever comes back (validate), and shows the diff
 * (diff). The model does the prose and the structure only it can see.
 */

export {
  type Brief,
  type BriefCommand,
  type BriefFileExcerpt,
  type BriefModule,
  type BriefTarget,
  type BuildBriefOptions,
  buildBrief,
  computeGaps,
} from './brief.ts'
export {
  buildHunks,
  type DiffHunk,
  type DiffInput,
  type DiffLine,
  diffFile,
  diffLines,
  type FileDiff,
  renderUnifiedDiff,
  splitLines,
  summarize,
} from './diff.ts'
export {
  bestCommand,
  type GeneratedArtifact,
  type GenerateOptions,
  generateAgentsFile,
  generateReviewCommand,
  generateVerifySkill,
} from './generate.ts'
export {
  type ApplyPrecondition,
  applyStaging,
  checkApplyPreconditions,
  clearStaging,
  GITIGNORE_SNIPPET,
  hashInputs,
  inspectStaging,
  manifestPath,
  readManifest,
  readRepoFile,
  readStaged,
  type StagedFile,
  type StagingManifest,
  type StagingState,
  sha256,
  stagingRoot,
  writeStaging,
} from './staging.ts'
export {
  type ArtifactKind,
  type ArtifactValidation,
  classifyArtifact,
  type ParsedFrontmatter,
  parseFrontmatter,
  SKILL_DESCRIPTION_MAX,
  SKILL_NAME_PATTERN,
  skillDirName,
  type ValidateSummary,
  validateAll,
  validateArtifact,
} from './validate.ts'
