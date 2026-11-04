# ADR-0016: Mobile platforms are their own stacks, and Apple's two are two playbooks

- Status: accepted
- Date: 2026-11-01
- Milestone: post-M7
- Extends: [ADR-0015](0015-framework-evidence-is-the-framework.md) — a stack is claimed by its own
  marker; this names the markers the mobile frameworks have.

## Context

Mobile is the shape a server-side audit never sees. A cross-platform app hides the platform
behind a framework: a managed Expo app has no `ios/` or `android/` directory at all, and a Flutter
app keeps neither under version control in any way the walk can rely on. Two concrete failures
came out of extending the cross-technology check to mobile:

- **Nothing was detected.** a Flutter app left no stack, a React Native app was only "node", and
  a .NET MAUI project was only ".NET". The plan for a mobile repository said nothing about mobile.
- **Apple's two ecosystems were one.** `swift.yaml` matched on the `swift` *language* and on the
  file glob `*.xcodeproj` -- a literal string that matched nothing. An Xcode app therefore matched
  the SwiftPM playbook and was offered `swift build` / `swift test`, which cannot run without a
  `Package.swift`. The detector's `hasFile('*.xcodeproj')` had the same defect, so the app was
  matched by the playbook and detected by nothing.

## Decision

**A mobile framework is a stack, detected by its own manifest, and each owns a playbook.**

- A **Flutter** project is the `flutter` dependency in `pubspec.yaml`; the `flutter` stack, and a
  `flutter` playbook with Flutter's own subcommands (`flutter test`, `flutter analyze`).
- A **React Native** project is a `react-native` (or `expo`) dependency in `package.json`. **Expo**
  is a second stack (`expo`), detected from the dependency or `app.json`, because a managed app has
  no native project and the dependency is the only evidence. One playbook covers both, because it
  is one ecosystem and the advice — Metro, the native projects, a dependency bump that must reach
  both platforms — is the same.
- A **.NET MAUI** project is `<UseMaui>` or `Microsoft.Maui` in a csproj; the `maui` stack, and a
  `maui` playbook. Its build and test advice stays with `dotnet`, which already carries
  `dotnet build` / `dotnet test`; the MAUI playbook holds only what is MAUI-specific.
- **Apple's two ecosystems are two playbooks.** `swift.yaml` is scoped to SwiftPM (`Package.swift`)
  and keeps `swift build` / `swift test`; a new `ios` playbook covers `.xcodeproj`/`.xcworkspace`/
  `Podfile` projects, and carries **no verify command**, because `xcodebuild` requires a scheme
  that belongs to the project. The detector emits `swift` for a Package.swift and `xcode` for an
  Xcode project, so a repository that is both reports both.

## Consequences

- `anvil plan` on a mobile repository now names the framework and links its documentation; on an
  Xcode app it links Apple's documentation and no longer suggests a SwiftPM command.
- Four playbooks are added (`flutter`, `react-native`, `maui`, `ios`) and `swift` narrows; the
  registry is 24 playbooks, and the coverage test that pins the id list is updated deliberately.
- Three detectors are added and the detector-count test moves from sixteen to nineteen.
- A `.NET` Android target framework alone is **not** MAUI: the marker is `<UseMaui>` or
  `Microsoft.Maui`, so a plain .NET-Android project is not mislabelled.
- `packages/profile/test/detectors.test.ts` holds the negatives: a React web app is not React
  Native, a plain .NET project is not MAUI, a Dart package with no Flutter dependency is not
  Flutter, and an Xcode project is `xcode` and not `swift`.

## Alternatives rejected

- **One `mobile` playbook for everything.** Flutter, React Native and MAUI share a *shape* and
  nothing else: different languages, toolchains and documentation. A single playbook would hand a
  Flutter developer React Native guidance, which is the noise the one-playbook-per-tool rule
  exists to remove.
- **Keep `swift` covering Xcode and special-case the SwiftPM commands.** The playbook would still
  be claiming two ecosystems, and the special case would live in the plan rather than in the data
  — the opposite of the registry being the single reviewable source.
- **Emit a verify command for an Xcode project anyway (`xcodebuild build`).** It fails with
  "requires a scheme"; a command that cannot run is worse than no command, because an agent will
  run it and report the failure as the change being wrong.
- **Treat Expo as part of React Native with no stack of its own.** A managed Expo app would then be
  detected from a dependency it shares with a bare React Native app, and the one distinguishing
  fact — there is no native project to edit — would be invisible.
