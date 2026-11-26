# 2026-11-25 — the claim that can be made at first publication

Status: **substantiated**. Deterministic, no model calls, no spend, no publication.
This document states the narrowest claim the existing evidence supports, and names what
would be needed to claim more.

## Claim

> anvil turns a repository into verified, evidence-linked agent context without calling a
> model. Against four ground-truth cards fixed in advance, its offline output named the
> correct verify command with a file-and-line citation in three of four cases, and in the
> fourth reported `blocked` rather than inventing a command. Applied to its own repository
> it scores 100 (A), and the installed binary is a single dependency-free file that passes
> CI on Windows, macOS and Linux.

This is a **capability and conformance claim**. It is not a claim that an agent using anvil
completes tasks faster or more accurately. That claim is not yet supported; see Limits.

## Method

- CLI: `@anvil-workflows/cli@0.1.0` from source `459130d9d0b1ca3ef68fa833008cde481d8ea908`,
  invoked as `node packages/cli/dist/cli.js brief --json --offline --profile <repo>`.
- Runtime: Node `v24.13.0`, OpenCode CLI `v2.3.2`. **No agent was invoked and no model was
  called**; `--offline` disables discovery fetches, so no network guidance was mixed in.
- Three repositories were cloned at the exact commits pinned in `pilot-ground-truth-2026-11-20.md`
  (on `main`). The fourth is the checked-in fixture. Cards were written before any run and
  were not edited after results were seen.
- Commands judged against the card's expected verify command. A command counts as matched
  only if anvil names the same command and cites the file and line it came from.

## Results

| Card | Class | Expected verify command | Anvil's offline result | Verdict |
| --- | --- | --- | --- | --- |
| `nbim-position-increases` @ `2ba28cc5` | harnessed Python | `python -m pytest tests -q` | `python -m pytest tests -q`, evidence `AGENTS.md:5` | **match** |
| `node-medium` fixture | conventional, no agent setup | `npm test` | `npm test`, evidence `README.md:14` (also detects `npm run test` from `package.json:7`) | **match** |
| `CountryTracker` @ `2c6728f4` | harnessed Android | `./gradlew koverXmlReport koverHtmlReport --no-daemon` (CI); `./gradlew testDebugUnitTest` documented | `./gradlew testDebugUnitTest`, evidence `README.md:140`; detects `./gradlew test` with no evidence | **partial** — matches the documented command, not CI's coverage command |
| `Books` @ `939566ef` | genuinely blocked | No local command; blocker is `GEMINI_API_KEY` and `SUMMARY_API_KEY` in a workflow | `ready` status `blocked`, but the reason given is "no agent instruction file"; `brief` reports zero commands and no CI detected | **honest but incomplete** — refuses to invent a command, does not name the real blocker |

Sanity check on the tool's own repository: `doctor --json` reports score `100`, grade `A`,
with 100 in all four layers at commit `459130d`. The historical progression from `53 (D)`
to `92 (A)` is recorded in [IMPLEMENTATION_PLAN.md](../../IMPLEMENTATION_PLAN.md#dogfooding-measured).

## What this does not establish

- No real agent was run here. Skill-guidance and first-contribution pilots either tied or
  fell below the predeclared five-pair threshold; the strongest directional result was
  `nbim` at 88s with anvil versus 124s bare across **three** pairs, explicitly reported as
  insufficient evidence in `2026-11-21-first-contribution-pilot.md` (on `main`).
- The blocked card is a real gap. anvil reports `blocked` for `Books`, but for the wrong
  reason: it does not surface secrets or workflow destinations from a nested directory
  without a declared `anvil.config.json`. Do not claim it diagnoses real blockers on
  arbitrary repositories.
- Cross-platform CI and the hermetic gate prove the binary works and the harness is sound,
  not that the product changes outcomes.

## Fastest way to strengthen the claim

The [nested-stale-verification pilot](../VERIFICATION_PILOT.md) is staged and its selection
was verified with `--dry-run`: one scenario, one `$0` model (`opencode/hy4-flash-free` after
the documented re-scope), five counterbalanced pairs, ten agent runs, 50-minute agent bound.
Its offline broker tests
cover the correct command, the correct directory, the retired command, a wrong directory, a
report without execution, and a modified protected file.

Verified on this branch, 2026-11-25:
`node --test --test-reporter=spec scripts/test/eval-nested-verification.test.ts` —
**4 tests, 4 passed, 0 failed** (~405s), including "generated guidance names the supported
command and its working directory" and "a broker fault is a run error, not a scored task
failure". The harness is ready; a directional win in the authorized run would support the
first real effectiveness claim.

The maintainer approved this exact run on 2026-11-25. Preflight followed the pilot
document: `eval:check` passed, the isolated free-only config and XDG directories were
staged, and the model was listed in the catalog. The availability probe with
`opencode/deepseek-v4.1-flash-free` returned `provider.free-limit` (HTTP 429,
`retryAfterMs: 20753000`, about 5.8 hours): "Free usage limit reached." The pilot document
requires stopping when zero-cost availability cannot be established. **No agent invocation
was made and no result was promoted.**

A second probe with `opencode/hy4-flash-free` under the same isolated config succeeded and
reported `cost: 0`. The maintainer approved re-scoping the run to that model on 2026-11-25.
`small` in `eval/models.json` now names `opencode/hy4-flash-free` (the harness accepts roles,
not explicit model ids); this changes the harness digest relative to the original proposal.
Scenario, seed, repetitions, order, model spend and decision rule are unchanged.

The run completed with five clean pairs: anvil won two outright, bare won none, two pairs
succeeded in both arms, and one failed in both. The predeclared rule requires at least three
one-sided wins, so the verdict is **insufficient evidence**; where both succeeded, anvil was
slower (100s vs 83s). See
[the pilot results](2026-11-25-nested-verification-pilot.md). No effectiveness claim is added.

A [predeclared powered rerun](2026-11-25-powered-pilot-results.md) with ten pairs and a new
seed then completed with both 4, anvil only 2, bare only 2, neither 2, and zero run errors.
Two pairs went each way, so the unchanged threshold was again not met. Its predeclared stop
rule forbids designing a third run from these numbers. **The launch claim remains the
capability and conformance claim; there is no effectiveness claim.**
