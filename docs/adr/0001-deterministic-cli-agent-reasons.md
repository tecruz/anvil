# ADR-0001: The CLI is deterministic, the agent reasons

- Status: accepted
- Date: 2026-09-29
- Milestone: M2b

## Context

`anvil` produces artefacts that an AI agent will read and act on: `AGENTS.md`, agent
definitions, commands, skills. The question is where judgement lives.

The tempting shape is a single component that inspects a repository and writes the
instructions directly, letting a model decide what to include. That is faster to build and
it fails in a specific way: the same repo produces different instructions on different runs,
and nobody can say why a given instruction is there. When an agent then misbehaves, the
instructions are the thing you would inspect first, and they have no audit trail.

The opposite failure is a tool that only emits templates with no repository-specific content.
That is reproducible and worthless.

## Decision

**Split by whether the answer requires judgement.**

Anything computable from the repository is computed by the CLI, deterministically, with
evidence attached. `anvil profile` detects stacks, commands, modules and risk paths; `anvil
brief` turns those into a verified fact sheet. Both are pure functions of the input tree,
and every claim carries the `file:line` behind it.

The model is used only for the step that genuinely needs it: reading the brief and
composing prose from verified facts. It never decides what is true.

`anvil init` enforces the boundary mechanically. It stages artefacts under
`.anvil/staging/`, renders a diff, and stops. Nothing is written into a checked-out
repository without `--apply`.

## Consequences

- The same repo always produces the same profile, brief and plan, so a readiness score is a
  reviewable artefact rather than a sample.
- Every fact in a generated instruction traces to a file. `anvil doctor` can check a claim
  without re-running a model.
- Instructions are reviewable as a diff before they exist, which is what makes it reasonable
  to let a tool write them at all.
- The brief has to be good. If it is thin, the model has nothing verified to compose from,
  and quality drops. This is the constraint that drove M2b and the 12 detectors.
- Staging costs a step. `anvil init` twice is the intended flow, and the validator rejecting
  a bad bundle is the safety net that makes the second step worth taking.

## Alternatives rejected

- **One model-in-the-loop component that writes instructions directly**: non-reproducible
  output with no evidence trail, and impossible to review before it lands.
- **Templates only, no repository analysis**: reproducible and useless, because the
  repository-specific part is the entire value.
- **Streaming model output straight into the repository**: no diff, no dry run, no
  validation, and an undo problem on a file people edit by hand.
