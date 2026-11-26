# 2026-11-25 — nested-stale-verification pilot results

Status: **executed; insufficient evidence**. The predeclared direction rule was not met.
No result was promoted into `eval-results/latest.json`, and nothing was published.

## Authorization and scope

The maintainer approved this run on 2026-11-25. The originally proposed model,
`opencode/deepseek-v4.1-flash-free`, returned `provider.free-limit` (HTTP 429, roughly 5.8
hours to reset) at the availability probe. `opencode/hy4-flash-free` answered `cost: 0` in the
same isolated, free-only configuration, and the maintainer approved re-scoping the `small`
role to it. Scenario, seed, repetitions, order, spend rule and decision rule are unchanged.

| Field | Value |
| --- | --- |
| Run id | `a93dbde0-4a08-4bcc-af1d-540851352dc2` |
| Source commit | `459130d9d0b1ca3ef68fa833008cde481d8ea908` |
| Implementation digest | `6c7b4b7c413c9e7de0dec0723ef226cd99874db047956a20f15c002caef9a1b1` |
| Harness digest | `1a167b4ef67b269dd3cd45217eb5faa039b0813c254b0aa4a6fec59325e76edd` |
| Bundle digest | `e0933dd464e3a542f3d52631221aa1bd3c5632931575ca1cb2980ac46e24f40d` |
| Scenario hash | `94d0ce2e080f8f3b7539d8b0e106cb7325f1428a296d569c50e8aa7f39c72b46` |
| Source hash | `272d720daee732958fef0768e107eb57daf77b6d2eb4b15ec7dbf69b08933a6d` |
| Model | `opencode/hy4-flash-free` (small), `cost: 0` |
| Node | `v24.13.0` |
| Seed / order | `nested-stale-verification-v1` / `alternate` |
| Repetitions | 5 pairs (10 invocations) |
| Completion | `partial` (subset run by design) |
| Run record SHA-256 | `17a88bd5e907ff8e5a4915a873d60635d6f7e19c566622d13707671088a8a07f` |

The run record, the sanitized free-only `opencode-config.json`, and the checksum are retained
under `eval-results/pilots/a93dbde0-4a08-4bcc-af1d-540851352dc2/`. The hermetic gate passed
before the run (`npm run eval:check`) and `latest.json` is unchanged by it.

## Results

| Pair | bare | anvil | Result |
| --- | ---: | ---: | --- |
| 0 | fail, not observed | **pass, observed** | anvil only |
| 1 | pass, observed | pass, observed | both |
| 2 | fail, not observed | **pass, observed** | anvil only |
| 3 | fail, not observed | fail, not observed | neither |
| 4 | pass, observed | pass, observed | both |

- Complete pairs: 5. Run errors: 0. Incomplete pairs: 0.
- Task success: both 2, anvil only 2, bare only 0, neither 1.
- Every successful run has a broker attestation of `node verify.js` from `packages/sub` with
  exit code 0. The two failed bare runs and the one failed anvil run have `not-observed`
  attestations: no execution was captured.
- Successful-pair time: bare 83s, anvil 100s (n=2). Anvil was slower in the pairs where both
  variants succeeded.
- Cost and tokens: `null`. The gateway reported `cost: 0` for a probe call, but the harness
  did not receive a ledger price, so no product-level cost claim is made.

**Verdict: insufficient evidence.** The predeclared rule needs at least five usable pairs,
at least three one-sided successes for the winning variant, and a margin of two. Anvil won two
pairs outright and lost none, but two is below the required three. The direction rule was not
met, so no effectiveness claim follows from this run.

## Interpretation

- The harness worked: all ten invocations completed, zero run errors, and `latest.json` was
  untouched.
- Anvil won two pairs where the bare agent never executed the supported check under broker
  observation, and lost none. That is a directional signal, not a verdict.
- Where both variants succeeded, anvil took longer on average (100s vs 83s). There is no
  time advantage to claim here.
- One pair failed in both arms. The retained record does not identify why; do not attribute
  it to either the task contract or the product.
- This run cannot distinguish which generated artifact caused any difference. It measures the
  whole `anvil init` bundle against a bare checkout, as declared.

Per the pilot document, failed or timed-out keys were not rerun and no pairs were added to
reach a favorable result. A further run would need a fresh predeclared decision, not a retry
of this one.

## Consequence for the launch claim

The capability and conformance claim in
[2026-11-25-launch-claim.md](2026-11-25-launch-claim.md) stands. This pilot does **not** add
an effectiveness claim. The honest launch statement remains: anvil derives evidence-linked
context and names the correct verify command without a model; no controlled run has yet shown
that an agent using it completes these tasks faster or more reliably.
