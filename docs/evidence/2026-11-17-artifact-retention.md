# Retained artifacts after an intentional CI failure — 2026-11-17

## What was dispatched

After PR #70 merged as `5968521e960d62c3ba59890e389d922e6cbc8e18`, a maintainer-approved
dispatch of the `Eval benchmark` workflow ran the hermetic failure rehearsal on `main`:

- Run: [44056529412](https://github.com/tecruz/anvil/actions/runs/44056529412)
- Event: `workflow_dispatch`, input `rehearse_failure: true`
- Head commit: `5968521e960d62c3ba59890e389d922e6cbc8e18`
- Conclusion: `failure` (the deliberate step)
- Real-model job: skipped, so no provider credentials were used and no model was called

## What the job did

| Step | Outcome |
| --- | --- |
| discard checked-out evidence | success |
| run the hermetic matrix (`--fake-agent`) | success |
| confirm the healthy gate passes | success |
| tamper with hermetic evidence and write the rehearsal record | success |
| assert the gate rejects the tampered evidence | success |
| validate required rehearsal artifacts | success |
| fail the rehearsal on purpose | **failure (intended)** |
| upload rehearsal artifacts (`if: always()`) | success |
| publish rehearsal summary (`if: always()`) | success |

The summary step recorded `HEALTHY_GATE: success`, `TAMPER: success`,
`GATE_ASSERTION: success`, `VALIDATE_ARTIFACTS: success`,
`INTENTIONAL_FAILURE: failure`, `UPLOAD: success`, and printed
"The rehearsal failed on purpose as designed, and the bounded artifacts were retained."

## Retained artifact

The failed run retained one artifact, confirmed through the Actions API after the job ended:

- Name: `eval-failure-rehearsal-44056529412-attempt1`
- Id: `14316476225`
- Size: 9,117 bytes
- Created: `2026-11-17T09:33:14Z`
- Expires: `2026-12-17T09:33:13Z` (30 days, not expired)

Downloaded contents (12 files):

| File | Bytes | SHA-256 |
| --- | --- | --- |
| `failure-rehearsal.json` | 438 | `080c4e3fe291811a22b95c90be190b69da8658c809ddc2d7575f97dfd8889a18` |
| `gate-rejection.log` | 318 | `fc76dbfba6f2e2f68251d1518c54830375d4eb5e189b69b808de6b0673dcd345` |
| `run.json` | 8,731 | `ee38c3dc6e921ba567fa4cb5ddff921b2398eb1f941384971e240d71d15c3cb4` |
| `runs/18869353-1a7b-40e2-9abd-cf6aee8a40b5.json` | 8,731 | `ee38c3dc6e921ba567fa4cb5ddff921b2398eb1f941384971e240d71d15c3cb4` |
| `checkpoints/18869353-1a7b-40e2-9abd-cf6aee8a40b5/medium-code-change--anvil--fake-agent--0.json` | 708 | `9d96132f08ce7d9e0efb32c5a8497ff10d42e68d920ee19d2182677674293d28` |
| `checkpoints/18869353-1a7b-40e2-9abd-cf6aee8a40b5/medium-code-change--bare--fake-agent--0.json` | 707 | `198b65261477eecc059b6bd8bc7ce163d37f52b6e3095d9ad2eb9f36933f3506` |
| `checkpoints/18869353-1a7b-40e2-9abd-cf6aee8a40b5/medium-verify-only--anvil--fake-agent--0.json` | 705 | `53d527d03e26a21ab115a7330dada4b487e6e2bcced2656f4666da4bf6e357d6` |
| `checkpoints/18869353-1a7b-40e2-9abd-cf6aee8a40b5/medium-verify-only--bare--fake-agent--0.json` | 704 | `8fc1a3d8f833fe245c629998792531cebd37f9d15ebf1842deb106848343c6b2` |
| `checkpoints/18869353-1a7b-40e2-9abd-cf6aee8a40b5/tiny-code-change--anvil--fake-agent--0.json` | 706 | `cecebf13fa4257bb22d22cba22f2eaede6057847590a77f4fb17883c1e098ec5` |
| `checkpoints/18869353-1a7b-40e2-9abd-cf6aee8a40b5/tiny-code-change--bare--fake-agent--0.json` | 705 | `32613cac1f4ed04e82884fab130f35d38279262606353e4e6e9b43b3ab3546cf` |
| `checkpoints/18869353-1a7b-40e2-9abd-cf6aee8a40b5/tiny-verify-only--anvil--fake-agent--0.json` | 703 | `b0d28d496ad7d1845c8e634d8a51b0251d3008f0f94f817c849c852b660d5938` |
| `checkpoints/18869353-1a7b-40e2-9abd-cf6aee8a40b5/tiny-verify-only--bare--fake-agent--0.json` | 702 | `fca6bb105badc2d47f8a6296c2834cd69864edb2aabee22d44641b98253b7b55` |

`run.json` and the run archive are byte-identical (same size and hash).

## Verification after download

`failure-rehearsal.json` names this run and commit, and records the tampering:

```json
{
  "evidence": "hermetic-failure-rehearsal",
  "githubRunId": "44056529412",
  "runId": "18869353-1a7b-40e2-9abd-cf6aee8a40b5",
  "sourceCommit": "5968521e960d62c3ba59890e389d922e6cbc8e18",
  "tampered": "tiny-code-change/bare: verified=false, first verifyExitCode=1",
  "expectedGate": "reject"
}
```

`gate-rejection.log` shows the expected rejection, including the specific diagnostic:

```text
eval gate failed:
  - tiny-code-change/bare/fake-agent/0: summary verified=false but run record verified=true
  - tiny-code-change/bare/fake-agent/0: summary verifyExitCodes disagree with run record
  - tiny-code-change: a run did not pass the visible verifier
```

The downloaded artifact was copied into an otherwise empty scratch `eval-results/` directory
and re-checked with the merged validator:

```text
node scripts/eval-rehearsal.ts validate-artifacts
Validated 3 files, the run archive and 8 checkpoints.
```

That validator checks the rehearsal record's run id and source commit, the run archive's
identity, every declared run key against the results, each checkpoint's schema version,
scenario, variant, model and repetition, and that no unexpected checkpoint is present.

## What this does and does not show

- It shows that a job that fails after a deliberate `exit 1` still uploads the allowlisted
  evidence, that the artifact remains downloadable while the run is failed, and that the
  downloaded copy passes the same structural checks the job ran before failing.
- It records the 30-day expiry from artifact metadata; the expiry itself was not waited out.
- It does not show real-agent behavior, product effectiveness, power-loss durability, or
  that a crash outside the rehearsal's own sequence would retain anything.
- `latest.json` was tampered only inside the ephemeral runner checkout. It is not in the
  artifact and was never committed.

## Reproduction

```bash
gh workflow run eval.yml --ref main -f rehearse_failure=true
gh run watch <run-id> --exit-status
gh api repos/tecruz/anvil/actions/runs/<run-id>/artifacts \
  --jq '.artifacts[] | {id,name,size_in_bytes,expired,expires_at}'
gh run download <run-id> -D <dir>
```
