# node-medium

A small-but-not-trivial package used by the eval harness when a scenario needs more than
one file to reason about.

It has no dependencies on purpose: the verifier has to be runnable without a package
install, so that a scenario costs seconds rather than minutes, and so that a failure in
the grading step is never a failure of the network.

## Conventions

- Source in `src/`, one module per concern.
- Tests in `test/`, named `<module>.test.js`, using `node:test` and `node:assert/strict`.
- Run the tests with `npm test`.

## Layout

- `src/stats.js` -- numeric summaries.
- `src/text.js` -- string helpers.
- `src/lists.js` -- list helpers.
