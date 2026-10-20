# Security policy

## Reporting a vulnerability

Report it privately, through GitHub's private vulnerability reporting for this repository:

<https://github.com/tecruz/anvil/security/advisories/new>

That opens a private advisory: only you and the maintainer can read it, and nothing is
published until the maintainer opens a draft. Please do not describe a vulnerability in a
public issue.

If that page is unavailable, private reporting is switched off for this repository. Open
an issue titled `security report` containing nothing but that sentence: it leaks no
detail, and the maintainer answers with a private channel.

Include, as far as you can:

- what anvil does, and the version or commit you tested
- the repository and command that triggered it
- the actual impact: what is read or written, and where
- a reproduction, ideally the smallest one

## What to expect

- an acknowledgement within a few working days
- an assessment once the report has been reproduced, with an estimate if a fix is needed
- credit in the fix's commit message unless you would rather not be named

## Threat model

Worth knowing before reporting, because it is where judgement is needed:

**In scope.** anvil runs commands, reads ticket text and repository content, and writes
files. The interesting cases are the ones where untrusted input crosses a boundary:

- a malicious repository, playbook or ticket body influencing what anvil executes or writes
- path traversal from ticket ids, playbook paths or staging manifests
- the `gh` transport building a command line from ticket-controlled text
- the Windows `.cmd` shim path, which refuses rather than escapes unsafe arguments

**Out of scope.** Running anvil in a repository you do not trust *as yourself* -- anvil
executes that repository's own verify commands, which is inherent to what it does, and is
why the plan treats "you do not own these repos" as the design constraint rather than an
edge case. Also out of scope: vulnerabilities in `gh`, `git`, or a package manager anvil
invokes.
