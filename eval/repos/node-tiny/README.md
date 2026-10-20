# node-tiny

A very small package, used by the eval harness as the repository a scenario is run
against.

It has no dependencies on purpose: the verifier has to be runnable without a package
install, so that a scenario costs seconds rather than minutes, and so that a failure in
the grading step is never a failure of the network.

## Conventions

- Source in `src/`, one module per concern.
- Tests in `test/`, named `<module>.test.js`, using `node:test` and `node:assert/strict`.
- Run the tests with `npm test`.

## Layout

- `src/text.js` -- string helpers.
- `src/slug.js` -- URL slugs.
