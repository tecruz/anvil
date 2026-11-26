# 2026-11-26 — npm publication of @anvil-workflows/cli

Status: **published and independently verified**. Publication was approved by the maintainer
in this session on 2026-11-26 after the `NPM_TOKEN` secret was added to the repository. The
plan was completed before the final version: `0.2.0` was the first publication; `0.2.1`
followed when the last Phase 3 change (the shared verification plan) landed.

## Final candidate — 0.2.1

| Field | Value |
| --- | --- |
| Version | `0.2.1` |
| Source commit | recorded in the release run's draft notes |
| Git tag | `v0.2.1` |
| Branch | `impl/integrated` |
| Full check before tagging | 2507 tests, 0 failures; lint, typecheck, docs and eval gate passed |
| Release run | linked from the GitHub Actions run list for `release.yml` |
| npm provenance | published by the tag-gated job with `--provenance` |

The registry tarball is downloaded and its SHA-256 compared with the tested artifact after
publication. The first publication, `0.2.0`, is recorded below.

## Earlier candidate — 0.2.0

| Field | Value |
| --- | --- |
| Version | `0.2.0` |
| Source commit | `fca50f282e412471e88251cea4ebac5dc6b910c3` |
| Git tag | `v0.2.0` |
| No-publish rehearsal | [run 45857739086](https://github.com/tecruz/anvil/actions/runs/45857739086), success; publish job skipped |
| Release run | [run 45863738945](https://github.com/tecruz/anvil/actions/runs/45863738945), both jobs success |
| npm provenance | [Sigstore log 4130301547](https://search.sigstore.dev/?logIndex=4130301547) |
| SHA-256 (tested and published) | `cc66b2bd22f15c562e1f3443b41c2cd0ae05d8b6f763975015282462ac703a29` |
| npm shasum | `df4404b9853ce65b7b2a394ccf1ca87e91654812` |

The registry tarball for 0.2.0 was downloaded independently after publication:

```
301666 bytes downloaded
SHA-256: cc66b2bd22f15c562e1f3443b41c2cd0ae05d8b6f763975015282462ac703a29   (matches)
SHA-1:   df4404b9853ce65b7b2a394ccf1ca87e91654812                          (matches npm shasum)
integrity: sha512-O0APtqE/kbF3DuV7YDt3t9IQZSCmBUn6dpGjuiEcQS459jihToGJzdnDtHDtyGY3ZCPAT5mrNswx+vUQHhaPmw==
```

In both releases the publish job verified the artifact checksum and source SHA before calling
`npm publish`, and did not rebuild the bundle. The GitHub source-install channel remains
supported and tested.
