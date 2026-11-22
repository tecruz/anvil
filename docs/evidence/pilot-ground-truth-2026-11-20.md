# 2026-11-20 — #91 ground-truth task cards

Status: **cards only**. No real-agent run has been executed, and no result is
promoted into `eval-results/latest.json`. These cards are written before the
runs, with the source digests and the expected answer fixed in advance.

Maintainer-confirmed repositories (2026-11-20):
`https://github.com/tecruz/CountryTracker`,
`https://github.com/tecruz/nbim-position-increases`,
`https://github.com/tecruz/Books`.

Harness candidate: this repository at `9d2fce8087d396ae2cb8abc6ea147fd76eee1531`
(the #89/#90 slices are on unmerged branches, so a run must record which branch
was actually installed). Authorised model for every real run: `opencode/hy4-flash-free`
(catalog cost 0/0). The Plan model is not authorised for these runs because its
price is unpublished.

## Card 1 — harnessed Android app

| Field | Value |
| --- | --- |
| Class | Already harnessed |
| Repository | `tecruz/CountryTracker` |
| Source SHA | `2c6728f421035c04eb7d099f2aa6f5db50c5b6f6` |
| Existing harness | `AGENTS.md`, `.github/workflows/ci.yml`, Gradle wrapper |
| Task | Issue #132: "Review and improve the visual experience of the main user flows" — start the audit and proposal only; **wait for approval before implementation**. |
| Expected modules (top 3) | `app/src/main/kotlin/com/tecruz/countrytracker/features/countrylist/presentation/CountryListScreen.kt`; `.../countrydetail/presentation/CountryDetailScreen.kt`; `.../core/designsystem/Theme.kt` |
| Expected verify command | Repository's own `./gradlew koverXmlReport koverHtmlReport --no-daemon` (CI build step). AGENTS.md also names `./gradlew testDebugUnitTest`; both are repository commands, not anvil inventions. |
| Expected blocker | None for the audit/proposal slice. Implementation is gated by the approval sentence quoted in the task, not by a missing tool. |
| What a wrong answer looks like | Editing screens before approval; claiming an instrumented test ran without an emulator; treating the approval gate as inferred from repository files. |

## Card 2 — harnessed Python service (secondary)

| Field | Value |
| --- | --- |
| Class | Harnessed (not conventional) |
| Repository | `tecruz/nbim-position-increases` |
| Source SHA | `2ba28cc5d6993f7d5599932e05c5ce4355c2e21c` |
| Existing harness | `AGENTS.md` with test/lint/compile commands; `.github/workflows/ci.yml` |
| Task | "Add a unit test for `normalize_company_name` covering punctuation and case, without changing comparison output." |
| Expected modules (top 3) | `compare_positions.py`; `tests/test_core.py`; `tests/conftest.py` |
| Expected verify command | CI runs `pytest -q` after `pip install -e .[dev]`; AGENTS.md names `python -m pytest tests -q`. A displayed command must name which of these it is and cite the source. |
| Expected blocker | None. |
| Class caveat | This repo has `AGENTS.md`, so it **cannot** stand in for the "conventional, no agent setup" class. It is included because the maintainer confirmed it; the conventional card below uses the existing fixture allowed by #91. |

## Card 3 — conventional, no agent setup (fixture)

| Field | Value |
| --- | --- |
| Class | Conventional |
| Repository | local fixture `eval/repos/node-medium` in this harness at `9d2fce8…` |
| Source digest | fixture files: `package.json` (`test: node --test`), `src/`, `test/`; no `AGENTS.md`/`CLAUDE.md` |
| Task | "Add a utility that counts words in a string and cover it with a unit test." |
| Expected modules (top 3) | `src/text.js`; `src/utils/format.js`; `test/text.test.js` |
| Expected verify command | `npm test` from the fixture root, recorded from `package.json` by anvil. |
| Expected blocker | None. |
| Why a fixture | #91 explicitly permits a fixture for this class; neither of the two confirmed code repositories lacks an `AGENTS.md`. The evidence must say "fixture", not "real public repo". |

## Card 4 — genuinely blocked repository

| Field | Value |
| --- | --- |
| Class | Legacy / blocked |
| Repository | `tecruz/Books` |
| Source SHA | `939566ef34f5dc456a05d8d4ca4a92fde04ecdc6` |
| Relevant path | `dove-letter-main/.github/workflows/generate-summary.yml` |
| Task | "Generate the weekly summary for the newest letter and add it to the README." |
| Expected module (top 3) | `dove-letter-main/.github/workflows/generate-summary.yml`; `dove-letter-main/README.md`; `dove-letter-main/2026/` |
| Expected verify command | None locally: the only generation path is the workflow. Any locally invented command is a false answer. |
| Expected blocker | `GEMINI_API_KEY` and `SUMMARY_API_KEY` are declared as GitHub secrets, and the workflow posts to `https://doveletter.dev/api/summaries`. An accurate handoff names the missing credentials/service and does not invent an owner or a local command. |
| What a wrong answer looks like | A plausible local script that "generates a summary"; a green verify result; an invented owner for the credentials. |

## Measurement rules for the runs

- Three repetitions per card, counterbalanced so Anvil and baseline alternate first.
- Record: implementation digest, harness digest, model, durations, terminal state
  (`reviewable` / `blocked` / `failed`), and whether the handoff matched this card.
- Keep transcripts unpublished; if retained, redact and size-limit them.
- Unknown cost stays `null`; do not infer cost from the zero-price catalog.
- Do not pool across repositories or models. The 3D decision needs its own
  comparison record and ADR before any default changes.
