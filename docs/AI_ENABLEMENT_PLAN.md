# Plan: broader AI enablement

Status: **In progress. The first slice of workstreams 1 and 2 is implemented; the rest is
still proposed.**
Prepared: 2026-11-04.

## Implemented so far: `anvil ready`

The first vertical slice of the goal below ships as `anvil ready` (see
[USAGE.md](USAGE.md#checking-readiness-anvil-ready)). It reports, for one repository, each
need as `verified`, `blocked` or `unknown`, and never guesses between them:

- **Declared capabilities** (workstream 1) — `anvil.config.json` gained a `project` section
  with `commands` (kind, command, working directory) and `tools` (id, binary, reason,
  required, install). Declarations are combined with the detected profile; a declaration
  that overlaps a detected command is kept alongside it and warned about, and a declared
  command is `unknown`, because declaring is not observing. Declarations are also threaded
  into `anvil init` and `anvil brief`, so the AGENTS.md and verify skill an agent reads carry
  the same commands, with the declared working directory preserved.
- **Environment readiness** (workstream 2) — `anvil ready --check` opts in to probing the
  environment. A bare tool name that resolves outside the repository is tested with a
  bounded, tool-specific command (`go version`, `xcodebuild -version`, else `--version`) run
  against the exact path that was checked, so a `PATH` change cannot redirect it. A declared
  tool version range is compared with the reported version: outside the range is
  `incompatible` and blocks, and a version that cannot be read stays `unknown`. A Windows
  shim runs through an interpreter anvil resolves to an absolute path and pins, and refuses
  one it cannot resolve or that lives inside the repository. A path-shaped tool (`. ./gradlew`),
  a bare name that resolves *inside* the repository (a `node_modules/.bin` shim), or a
  repository-local symlink whose target is elsewhere, is only checked for existence and
  runnability and is **never executed** — even when the repository is reached through a
  directory alias — so a committed config cannot turn the report into code execution. The
  tools checked are the ones the project's effective commands need — a declared command
  overrides a detected one, which overrides an inference, so an overridden or inferred runner
  is non-blocking, and only the first declared command of a kind is required — plus playbook
  suggestions, which are optional. Working directories are honoured: a relative executable is
  resolved from the directory its command runs in, and an absolute one is used as given.
  Without `--check` nothing is spawned.
- **Approved setup actions** (workstream 3, first slice) — a blocked report carries
  `actions`, each with `requiresApproval: true`. The only install command printed is one the
  owner declared; otherwise the action has no command, because anvil will not guess a
  package manager. Nothing in the report is run, and a path tool is never executed.

Still proposed: automatic install/configure with verification, company-context sources,
service readiness, and real-agent evaluation evidence.

## Goal

Preserve Anvil's original purpose: make existing software projects ready for
AI-assisted engineering, across technologies and company environments.

The practical milestone is:

> Given an unfamiliar repository, Anvil explains what an AI needs, checks what is
> available, proposes approved setup actions, and reports what is verified, blocked
> or unknown.

This means improving project onboarding, not promising that an agent can complete
every task without requirements, access, suitable hardware or working tools.
Readiness must be scoped to a declared workflow and environment, rather than treated
as proof that the entire project is correct.

## Existing foundation

Anvil already profiles repositories, audits readiness, derives project-specific
agent context, recommends resources, and supports verified ticket workflows. Custom
playbooks and staged, reviewable context generation provide starting points for this
plan; they are not a complete environment setup or resource integration system.

Keep the separation described in [ARCHITECTURE.md](ARCHITECTURE.md): Anvil gathers
facts deterministically; the AI agent reasons and performs the work. Reuse the
evaluation infrastructure covered by [IMPROVEMENT_PLAN.md](IMPROVEMENT_PLAN.md),
rather than rebuilding it. This proposal complements that plan and does not replace
its remaining work.

## 1. Broader technology support

**Outcome:** unsupported automatic detection does not prevent a project owner from
describing how to work in the repository.

### Proposed work

- Extend the validated project configuration with explicit capability declarations:
  build, run and verification commands; working directories; module boundaries;
  required tools and versions; documentation references; and risk areas.
- Combine those declarations with detected facts and custom playbooks, with explicit
  precedence and visible conflicts.
- Preserve provenance: distinguish detected facts, owner-declared requirements,
  inferred suggestions and observed execution results.
- Keep configuration strict. Version changed contracts where necessary and reject
  unknown keys rather than silently ignoring mistakes.

### Acceptance

- [x] A fixture using an unrecognized technology can supply usable project context
  through explicit declarations without adding a built-in detector.
- [x] Commands retain their working directory and source of authority.
- [x] Declaring a command does not imply it has run successfully or authorize its
  execution.
- [x] Incomplete detection and conflicting declarations remain visible.

## 2. Environment readiness and setup

**Outcome:** distinguish repository readiness from whether this machine can actually
build, run and verify the project.

### Proposed work

- Add a separate, opt-in environment check for required runtimes, SDKs, versions,
  databases, containers and services.
- Check required configuration variable presence without exposing secret values.
- Support approved probes of documented startup and verification commands, with
  bounded execution and recorded outcomes.
- Reuse existing setup mechanisms such as package managers, Docker Compose and dev
  containers instead of creating a new environment manager.
- Propose setup actions for review before execution. Keep ordinary repository
  profiling non-executing.

### Acceptance

- [ ] Missing tools, incompatible versions and unavailable services are reported
  separately from source-code or test failures. _Partial: missing, unrunnable and
  version-incompatible tools are reported; services are not yet checked._
- [x] Environment checks and setup never run implicitly during repository profiling.
- [x] Secret values are not copied into generated context or diagnostic output.
- [ ] Restricted credentials, missing corporate access and unavailable hardware
  produce explicit blockers, not an invented successful setup.

## 3. Turn recommendations into approved integrations

**Outcome:** help complete supported integrations instead of only linking to them.

### Proposed work

Use a reviewable lifecycle:

```text
Discover -> inspect -> approve -> install/configure -> verify
```

- Start with a bounded set of supported resource types and integration mechanisms.
- Show provenance, pinned versions or immutable references, requested permissions,
  proposed commands and file changes before approval.
- Preserve existing user configuration and refuse silent overwrites.
- Verify the installed integration and report partial or failed outcomes honestly.
- Treat installation and startup as execution of potentially untrusted code; use
  isolation where available and state the actual safety boundary.

### Acceptance

- [ ] Discovering a resource never authorizes installing or executing it.
- [ ] Approval applies to the reviewed resource and actions, not arbitrary future
  discovery results.
- [ ] Existing configuration is preserved or changed through a reviewable diff.
- [ ] A failed installation or verification is not reported as a completed integration.

## 4. Company and business context

**Outcome:** give agents relevant organizational knowledge without pretending it can
be inferred entirely from source code.

### Proposed work

- Accept explicitly approved references to engineering standards, architecture
  decisions, requirements, acceptance criteria and security policies.
- Include approved-tool, environment and data-handling restrictions where relevant.
- Detect missing or stale references and surface contradictory requirements.
- Provide bounded, task-relevant context rather than loading every document into
  every agent session.
- Keep policy authority explicit; retrieved or external material must not silently
  override project restrictions.

### Acceptance

- [ ] Context retains its source and scope, and missing references are reported.
- [ ] Undocumented business expectations remain questions, not generated facts.
- [ ] Sensitive context is not uploaded merely because a reference exists.
- [ ] Source code is treated as evidence of implementation, not automatically as the
  definition of correct product behavior.

## 5. Evidence that Anvil helps

**Outcome:** demonstrate practical benefit with real agents and independent checks.

### Proposed work

- Reuse the existing benchmark harness for paired comparisons with and without
  Anvil, using real agents on controlled, representative projects.
- Expand coverage across technologies, monorepos, misleading documentation,
  incomplete environments and unfamiliar build systems.
- Measure environment setup success, verification-command selection, task outcomes,
  constraint compliance and, where available, time and cost.
- Use repeated runs and independent acceptance checks. Retain implementation,
  environment and scenario provenance so results have a clear scope.
- Keep real-model runs explicitly authorized and budgeted; do not introduce normal
  CLI telemetry or upload company repositories for benchmarking.

### Acceptance

- [ ] Real-agent results are clearly separated from synthetic harness checks.
- [ ] Reports distinguish measured improvement, regression and insufficient evidence.
- [ ] Unknown measurements remain unknown, and failures are not rerun selectively
  until a favorable comparison appears.
- [ ] Claims of effectiveness identify the tested technologies and conditions rather
  than implying universal coverage.

As of this plan's preparation, the latest committed summary in
[eval-results/latest.json](../eval-results/latest.json) uses `fake-agent`. It checks
evaluation machinery; it is not evidence of real-AI effectiveness across technologies.

## Delivery order

1. Explicit project capabilities and unsupported-technology fallbacks.
2. Environment diagnostics and approved company-context sources.
3. Controlled setup and resource integration actions.
4. Broader measured coverage, with real-agent evaluations throughout the preceding
   work rather than only after implementation.

Deliver small, independently verifiable changes. Concrete configuration schemas,
CLI surfaces and integration adapters still require design and review; this document
does not describe those proposed features as available commands.

## QA follow-on

Strengthen the shared AI-onboarding foundation before expanding QA. The intended QA
scope includes access to source code and should reuse the same project facts,
environment checks, policies and evidence structures.

A later QA workflow should support requirements analysis, risk-based test planning,
defect reproduction, regression tests and evidence-backed findings. It must also
work without an existing E2E framework and allow report-only outcomes with no code
change. A passing test suite is evidence about tested behavior, not proof of overall
product correctness.

## Boundaries

- Keep the product CLI model-free and repository detection local and non-executing.
- Do not silently install discovered tools, grant access, obtain credentials or
  perform production changes.
- Do not treat approvals as an operating-system sandbox or promise that every
  environment can be provisioned automatically.
- Keep blocked, unknown, declared and verified states distinct.
- Saving this proposal does not authorize setup actions, paid evaluations,
  publishing or changes to company systems.
