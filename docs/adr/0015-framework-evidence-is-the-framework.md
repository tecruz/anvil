# ADR-0015: A framework is matched by its own evidence, not its build system

- Status: accepted
- Date: 2026-11-01
- Milestone: post-M7
- Amends: [ADR-0008](0008-live-discovery-keeps-registry-curated.md) — the same "ask about the
  technology, do not assume it from a neighbour" reasoning, applied to matching instead of seeds.

## Context

`android.yaml` matched a repository on `deps: ['android', 'gradle']` together with a bare
`**/build.gradle.kts`. `gradle` and `.kts` are every Gradle project that has ever been written,
so the specificity the playbook's priority and Compose guidance imply was never earned. Two real
repositories showed it:

- **Spring Petclinic**, a Gradle Java build, was matched as an Android project and offered
  Compose recomposition guidance. There is no `AndroidManifest.xml`, no Android Gradle Plugin and
  no `androidx` anywhere in it.
- **A Kotlin Multiplatform module** targeting JVM and iOS, with no Android target, was matched the
  same way — the `kotlin` language and the Gradle build were read as Android.

The playbook carried `importPrefixes: ['androidx.compose', 'androidx.', 'com.android.']` and they
were inert: no detector reads source imports, so the only live signals were the file glob and the
deps list. Nothing in the profile emitted an `android` stack at all, so `deps: [android]` matched
nothing and the match had to come from `gradle`.

## Decision

**A stack is claimed by evidence of that stack, never by a shared build system or language.**

1. A new `androidDetector` emits the `android` stack only for genuine Android evidence: the
   Android Gradle Plugin id (`com.android.application`, `com.android.library`, and the rest) in any
   Gradle build file, an `AndroidManifest.xml` at any depth, an `android { }` block, or an
   `android.*` property in `gradle.properties`.
2. `android.yaml` matches on `deps: ['android']` and `files: ['**/AndroidManifest.xml']`. The
   `gradle` dep and the bare `**/build.gradle.kts` glob are gone.
3. Kotlin Multiplatform gets its own detector and stack (`kotlin-multiplatform`), detected from the
   `multiplatform` plugin or the iOS targets. A KMP module with an Android target is *both*
   stacks, because it genuinely is both, and the plan should say so rather than pick one.

The same rule applies to every framework the detectors add from here: a repo is a framework when
the framework's own marker is present, and detection is allowed to be *silent* on a repository
that merely uses the same tools.

## Consequences

- A Gradle Java build, and a Kotlin/JVM build, no longer match `android`; Spring Petclinic and KMP
  modules get JVM guidance and nothing about Compose. A KMP module gains the
  `kotlin-multiplatform` stack so it is not left unidentified.
- `anvil plan` on a real Android project is unchanged: an AGP plugin id or a manifest is present
  in every Android repository, so the detector fires exactly as the old glob did.
- The detector count rises from fourteen to sixteen; the golden test that pins the count is
  updated deliberately, not loosened.
- `packages/profile/test/detectors.test.ts` and the mobile cross-technology check
  (`packages/derive/test/mobile-technologies.test.ts`) hold the negative cases: a plain JVM
  project, a Kotlin/JVM project, a KMP module without an Android target, and the word "android"
  in prose must all stay unmatched.

## Alternatives rejected

- **Keep matching on `gradle` and rely on playbook priority to rank `jvm` below `android`.** This
  is what produced the defect: priority orders two matches that both exist, and the problem is the
  one that should not exist. A JVM-only repository would still be shown Compose guidance, just
  ranked under the JVM guidance it also should not need.
- **Match `android` only on `AndroidManifest.xml`.** The manifest is a strong signal and is kept,
  but it is not the only one, and the glob matcher treats `**/` as a single worth of depth — a
  manifest at `app/src/main/` would already be missed by the file glob alone. The plugin id in the
  build files is depth-independent and is the more reliable of the two.
- **Use `importPrefixes` to read `androidx` imports.** There is no source-import scanner, and
  building one to decide a playbook match would trade a cheap, reviewable signature for a
  language-specific parser that has to cover every source layout. The build file and the manifest
  answer the same question without reading the code.
- **Give Kotlin Multiplatform only an exclusion from `android`.** That leaves a real, growing
  technology with no stack and therefore no guidance at all, which is the failure the registry
  coverage test exists to prevent. It gets its own stack instead.
