/**
 * C and C++.
 *
 * The build system is the marker, not the source extensions. Almost every repository that
 * touches native code has a few `.c`/`.cpp` files somewhere -- a vendored dependency, a native
 * addon -- and those are the C/C++ *language* without being a C/C++ project. A `CMakeLists.txt`,
 * a `meson.build` or an MSBuild `.vcxproj` is what makes it a project with a build and a test
 * command to offer, and it is also the file a reader can open to check the claim.
 *
 * Extensions are already counted toward the language profile (`.c`, `.cc`, `.cpp`, `.h`, `.hpp`),
 * so this detector only has to decide when the advice applies.
 */

import { addCommand, addStack, addTool, type Detector, type DetectorContext, filesUnder, hasFile } from '../detector.ts'

type CppBuildSystem = { file: string; tool: 'cmake' | 'meson' | 'msbuild' }

/**
 * The first build system that makes this a C/C++ project, at any depth.
 *
 * Suffix matching rather than a glob, for the same reason the Android manifest probe is: the
 * hand-rolled double-star matcher is easy to get subtly wrong, and these files live at `src/` or
 * `libs/core/` as often as at the root.
 */
function cppBuildSystem(ctx: DetectorContext): CppBuildSystem | null {
  for (const file of filesUnder(ctx, '')) {
    const name = file.slice(file.lastIndexOf('/') + 1)
    if (name === 'CMakeLists.txt') return { file, tool: 'cmake' }
    if (name === 'meson.build') return { file, tool: 'meson' }
    if (file.endsWith('.vcxproj')) return { file, tool: 'msbuild' }
  }
  return null
}

export const cppDetector: Detector = {
  id: 'cpp',
  title: 'C / C++',
  priority: 62,
  matches: (ctx) => cppBuildSystem(ctx) !== null,
  detect(ctx, draft) {
    const build = cppBuildSystem(ctx)
    if (build === null) return
    addStack(draft, { id: 'cpp', version: null, evidence: [build.file] })
    addStack(draft, { id: build.tool, version: null, evidence: [build.file] })

    if (build.tool === 'cmake') {
      // `cmake --build` is CMake's documented driver; `inferred` because the build directory and
      // the configure step (`cmake -S . -B build`) are the project's choice, not a convention the
      // detector can read. Same honesty as `cargo build` for a Rust crate.
      addCommand(draft, 'build', { cmd: 'cmake --build build', source: 'inferred' })
      // `ctest` is the CMake test driver; it finds the tests the build enabled.
      addCommand(draft, 'test', { cmd: 'ctest --test-dir build --output-on-failure', source: 'inferred' })
    } else if (build.tool === 'meson') {
      addCommand(draft, 'build', { cmd: 'meson compile -C build', source: 'inferred' })
      addCommand(draft, 'test', { cmd: 'meson test -C build', source: 'inferred' })
    } else {
      addCommand(draft, 'build', { cmd: 'msbuild', source: 'inferred' })
    }

    // Formatting and lint are claimed only when the repository configures them: a `.clang-format`
    // is the one file that says the project has an opinion about formatting.
    for (const config of ['.clang-format', '_clang-format']) {
      if (hasFile(ctx, config)) {
        addTool(draft, 'formatter', 'clang-format')
        break
      }
    }
    if (hasFile(ctx, '.clang-tidy')) addTool(draft, 'lint', 'clang-tidy')

    // A package manager is a stack of its own: it changes what an install even means.
    for (const [rel, id] of [
      ['vcpkg.json', 'vcpkg'],
      ['conanfile.txt', 'conan'],
      ['conanfile.py', 'conan'],
    ] as const) {
      if (!hasFile(ctx, rel)) continue
      addStack(draft, { id, version: null, evidence: [rel] })
      break
    }
  },
}
