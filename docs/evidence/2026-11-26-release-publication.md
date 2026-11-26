# 2026-11-26 — first npm publication of @anvil-workflows/cli

Status: **published and independently verified**. Publication was approved by the maintainer
in this session on 2026-11-26 after the `NPM_TOKEN` secret was added to the repository.

## Candidate

| Field | Value |
| --- | --- |
| Version | `0.2.0` |
| Source commit | `fca50f282e412471e88251cea4ebac5dc6b910c3` |
| Git tag | `v0.2.0` |
| Branch | `impl/integrated` |
| Local `npm run check` | 2502 tests, 0 failures; docs and eval gate passed |
| No-publish rehearsal | [run 45857739086](https://github.com/tecruz/anvil/actions/runs/45857739086), success; publish job skipped |
| Release run | [run 45863738945](https://github.com/tecruz/anvil/actions/runs/45863738945), both jobs success |
| npm provenance | [Sigstore log 4130301547](https://search.sigstore.dev/?logIndex=4130301547) |

## Byte verification

The tarball from the no-publish rehearsal artifact was downloaded and hashed before tagging:

```
SHA-256: cc66b2bd22f15c562e1f3443b41c2cd0ae05d8b6f763975015282462ac703a29
```

The registry tarball was downloaded independently after publication:

```
301666 bytes downloaded
SHA-256: cc66b2bd22f15c562e1f3443b41c2cd0ae05d8b6f763975015282462ac703a29   (matches)
SHA-1:   df4404b9853ce65b7b2a394ccf1ca87e91654812                          (matches npm shasum)
integrity: sha512-O0APtqE/kbF3DuV7YDt3t9IQZSCmBUn6dpGjuiEcQS459jihToGJzdnDtHDtyGY3ZCPAT5mrNswx+vUQHhaPmw==
```

The published bytes are the tested bytes. The publish job verified the artifact checksum
and source SHA before calling `npm publish`, and did not rebuild the bundle.

## Install

```bash
npm install -g @anvil-workflows/cli@0.2.0
```

The GitHub source-install channel remains supported and tested.
