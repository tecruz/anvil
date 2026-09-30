/**
 * The ProjectProfile contract.
 *
 * This is a *detected facts* document. It records what is verifiably in the repo, with
 * evidence for every claim, and never guesses. A downstream consumer (the rules engine,
 * the brief builder, the opencode plugin) should be able to point at the file and line
 * behind any field and have it hold up.
 *
 * Two rules shape the design:
 *
 *  1. **Every command is labeled.** `documented` (written down in a doc or a task
 *     runner), `detected` (found in a build file's script/goal definition),
 *     `inferred` (derived from ecosystem convention). `inferred` is not a command anyone
 *     has run. `ship` refuses to execute it without `--probe`.
 *  2. **Nothing is a string soup.** Languages, modules and stacks are arrays so a
 *     consumer never has to parse a delimiter out of prose.
 */

export type SchemaVersion = 1

export type CommandKind = 'install' | 'build' | 'test' | 'testFast' | 'lint' | 'format' | 'typecheck' | 'run'

/** How much we trust a command, and where it came from. */
export type CommandSource = 'documented' | 'detected' | 'inferred'

export interface CommandEntry {
  /** The command, as it would be typed in a shell. */
  cmd: string
  source: CommandSource
  /** `file:line` for detected/documented commands. Absent for inferred. */
  evidence?: string
}

export type Commands = Partial<Record<CommandKind, CommandEntry[]>>

export interface Language {
  id: string
  /** File count, by the detector's own extension map. */
  files: number
  primary: boolean
}

export type MonorepoTool =
  | 'npm'
  | 'pnpm'
  | 'yarn'
  | 'bun'
  | 'nx'
  | 'turbo'
  | 'gradle'
  | 'maven'
  | 'go-work'
  | 'uv'
  | 'cargo-workspace'
  | 'sln'

export interface Monorepo {
  tool: MonorepoTool
  evidence: string
  /** Workspace package names, when the tool enumerates them. */
  members: string[]
}

export interface Module {
  /** Stable identifier: the workspace package name, else the path. */
  id: string
  /** Repo-relative POSIX path. Always forward slashes, for cross-platform stability. */
  path: string
  kind: 'package' | 'project' | 'crate' | 'service'
  /** Workspace-internal dependency ids. */
  deps: string[]
}

export type VcsHost = 'github' | 'gitlab' | 'bitbucket' | 'azure' | null

export interface Vcs {
  host: VcsHost
  remote: string | null
  defaultBranch: string | null
  /** Path reported by `git rev-parse --show-toplevel`, normalized. */
  root: string
}

export type RiskLevel = 'high' | 'medium'

export interface RiskPath {
  /** Repo-relative POSIX glob. */
  glob: string
  level: RiskLevel
  reason: string
  /** Which heuristic produced it, for explainability. */
  origin: 'heuristic' | 'playbook'
}

export interface Tooling {
  ci: string[]
  lint: string[]
  formatter: string[]
  typecheck: string[]
  test: string[]
  container: boolean
  /** Infrastructure-as-code paths found. */
  iac: string[]
  /** Pre-commit / pre-push hook frameworks found, by name. */
  hooks: string[]
}

export interface Docs {
  readme: string | null
  contributing: string | null
  security: string | null
  license: string | null
  architecture: string | null
  adr: string | null
  codeowners: string | null
  prTemplate: string | null
  issueTemplate: string | null
}

/** A detected stack entry. The id maps to a playbook in M2a. */
export interface Stack {
  id: string
  version: string | null
  evidence: string[]
}

export interface ProjectProfile {
  schemaVersion: SchemaVersion
  /** Absolute, normalized repo root. */
  root: string
  vcs: Vcs
  monorepo: Monorepo | null
  languages: Language[]
  modules: Module[]
  stacks: Stack[]
  commands: Commands
  tooling: Tooling
  docs: Docs
  risk: RiskPath[]
  /**
   * Instruction files the agent would actually load, in precedence order. Found by
   * probe, not by assumption -- opencode reads AGENTS.md, then CLAUDE.md, then the
   * global file, and only the first match per category wins.
   */
  instructions: InstructionFile[]
  /**
   * Files an AI-readiness rule might care about, as repo-relative POSIX paths. Kept
   * separate from `docs` so a rule can distinguish "documented" from "declared".
   */
  files: string[]
  /**
   * Directory holding the project, when it is not the repository root. `''` otherwise.
   *
   * A crate under `engine/`, a service under `services/api/`. This exists because the
   * commands in a profile are written the way each ecosystem writes them -- `cargo test`,
   * `npm run test` -- and those run *from the project directory*, not from wherever the
   * agent happens to be. Without this field a consumer would have to infer the working
   * directory from an evidence path, and would then be the one guessing.
   */
  projectDir: string
}

export interface InstructionFile {
  /** Repo-relative POSIX path, or an absolute path for the global fallback. */
  path: string
  /** Which loader category this file satisfies. */
  category: 'agents' | 'claude' | 'copilot' | 'cursor' | 'global'
  bytes: number
}

/** An empty-but-valid profile, used as the merge base by detectors. */
export function emptyProfile(root: string, vcs: Vcs): ProjectProfile {
  return {
    schemaVersion: 1,
    root,
    vcs,
    monorepo: null,
    languages: [],
    modules: [],
    stacks: [],
    commands: {},
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
    docs: {
      readme: null,
      contributing: null,
      security: null,
      license: null,
      architecture: null,
      adr: null,
      codeowners: null,
      prTemplate: null,
      issueTemplate: null,
    },
    risk: [],
    instructions: [],
    files: [],
    projectDir: '',
  }
}

/** Normalize a native path to a repo-relative POSIX path. */
export function toPosix(p: string): string {
  return p.replace(/\\/g, '/')
}

/** Strip a leading `./` or `/` so relative paths are directly comparable. */
export function normalizeRelPath(p: string): string {
  return toPosix(p).replace(/^\.\//, '').replace(/^\/+/, '')
}
