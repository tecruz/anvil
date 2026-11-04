/**
 * C and C++.
 *
 * A C/C++ *project* needs both a build system and at least one C/C++ source or header. Neither
 * alone is enough, and the two failure modes are opposite:
 *
 *  - Source extensions without a build system are the C/C++ *language*, not a project with a
 *    build and a test command to offer. A vendored reference implementation or a native addon
 *    that builds through node-gyp is exactly this.
 *  - A build system without C/C++ sources is a project written in another language that happens
 *    to use CMake or Meson. `apple/swift-argument-parser` enables C in its `CMakeLists.txt` only
 *    to work around a CMake `GNUInstallDirs` bug; the project is Swift.
 *
 * Extensions are already counted toward the language profile (`.c`, `.cc`, `.cpp`, `.h`, `.hpp`),
 * so this detector only has to decide when the advice applies.
 */

import { addCommand, addStack, addTool, type Detector, type DetectorContext, filesUnder, hasFile } from '../detector.ts'

type CppBuildSystem = { file: string; tool: 'cmake' | 'meson' | 'msbuild' }

/** Extensions that are unambiguously C or C++ source or headers. */
const CPP_SOURCE_EXTENSIONS = new Set(['.c', '.cc', '.cpp', '.cxx', '.h', '.hh', '.hpp', '.hxx', '.inl', '.ipp'])

/**
 * Whether the tree contains a C/C++ translation unit or header.
 *
 * A build system on its own is not language evidence. `apple/swift-argument-parser` ships a
 * `CMakeLists.txt` that enables C only because of a CMake `GNUInstallDirs` bug; the project is
 * Swift. Requiring a C/C++ file keeps CMake-for-Swift out of the C++ playbook, while a
 * header-only C++ library still counts through its `.hpp`/`.h` files.
 */
function hasCppSource(ctx: DetectorContext): boolean {
  return filesUnder(ctx, '').some((file) => {
    const name = file.slice(file.lastIndexOf('/') + 1)
    const dot = name.lastIndexOf('.')
    return dot > 0 && CPP_SOURCE_EXTENSIONS.has(name.slice(dot).toLowerCase())
  })
}

/**
 * The first build system that makes this a C/C++ project, at any depth.
 *
 * Suffix matching rather than a glob, for the same reason the Android manifest probe is: the
 * hand-rolled double-star matcher is easy to get subtly wrong, and these files live at `src/` or
 * `libs/core/` as often as at the root.
 *
 * CMake and Meson are general build systems; they only become C/C++ evidence when there is a
 * C/C++ source file to build. An MSBuild `.vcxproj` is itself a C/C++ project file.
 */
function cppBuildSystem(ctx: DetectorContext): CppBuildSystem | null {
  const source = hasCppSource(ctx)
  for (const file of filesUnder(ctx, '')) {
    const name = file.slice(file.lastIndexOf('/') + 1)
    if (name === 'CMakeLists.txt') {
      if (source) return { file, tool: 'cmake' }
      continue
    }
    if (name === 'meson.build') {
      if (source) return { file, tool: 'meson' }
      continue
    }
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
    // `cpp-project` is the declared-project marker the playbook matches. The `cpp` stack stays
    // for the language/toolchain identity, but it is also an inferred language id elsewhere, so
    // the playbook must not match on it.
    addStack(draft, { id: 'cpp-project', version: null, evidence: [build.file] })
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
