import { test, describe } from 'node:test'
import assert from 'node:assert/strict'

import {
  AnvilError,
  ErrorCode,
  ExitCode,
  SCHEMA_VERSION,
  emitJson,
  failure,
  getBool,
  getList,
  getString,
  makeStyle,
  parseCliArgs,
  renderKeyValues,
  renderTable,
  shouldUseColor,
  success,
  toAnvilError,
  type ErrorCodeValue,
  type ExitCodeValue,
} from '@anvil/core'

function capture(): { lines: string[]; write: (chunk: string) => void } {
  const lines: string[] = []
  return { lines, write: (chunk) => lines.push(chunk) }
}

describe('envelopes', () => {
  test('success envelope shape is stable', () => {
    const env = success('doctor', { score: 42 })
    assert.deepEqual(env, {
      schemaVersion: SCHEMA_VERSION,
      ok: true,
      command: 'doctor',
      data: { score: 42 },
    })
  })

  test('failure envelope omits absent optional fields', () => {
    const env = failure('doctor', new AnvilError(ErrorCode.Usage, 'nope'))
    assert.deepEqual(env.error, { code: 'USAGE', message: 'nope' })
    assert.equal('hint' in env.error, false)
    assert.equal('details' in env.error, false)
  })

  test('failure envelope includes hint when present', () => {
    const env = failure('x', new AnvilError(ErrorCode.NotAGitRepo, 'no repo', { hint: 'git init' }))
    assert.equal(env.error.hint, 'git init')
  })

  test('emitJson writes one pretty-printed object with a trailing newline', () => {
    const { lines, write } = capture()
    emitJson('doctor', success('doctor', { a: 1 }), { stdout: write })
    assert.equal(lines.length, 1)
    assert.ok(lines[0]?.endsWith('\n'))
    const parsed: unknown = JSON.parse(lines[0] as string)
    assert.equal((parsed as { ok: boolean }).ok, true)
  })
})

describe('error codes and exit codes', () => {
  test('each code maps to its documented exit code', () => {
    const pairs: Array<[ErrorCodeValue, ExitCodeValue]> = [
      [ErrorCode.Usage, ExitCode.Usage],
      [ErrorCode.UnknownCommand, ExitCode.Usage],
      [ErrorCode.ConfigInvalid, ExitCode.Config],
      [ErrorCode.ConfigUnreadable, ExitCode.Config],
      [ErrorCode.NotAGitRepo, ExitCode.NotARepo],
      [ErrorCode.PreflightFailed, ExitCode.NotARepo],
      [ErrorCode.AuthFailed, ExitCode.Auth],
      [ErrorCode.UnsupportedHost, ExitCode.Auth],
      [ErrorCode.ToolMissing, ExitCode.ToolMissing],
      [ErrorCode.ThresholdNotMet, ExitCode.Threshold],
      [ErrorCode.StaleStaging, ExitCode.StaleStaging],
      [ErrorCode.Internal, ExitCode.Internal],
    ]
    for (const [code, exit] of pairs) {
      assert.equal(new AnvilError(code, 'x').exitCode, exit, `${code} should exit ${exit}`)
    }
  })

  test('an AnvilError passes through toAnvilError unchanged', () => {
    const original = new AnvilError(ErrorCode.Usage, 'boom')
    assert.equal(toAnvilError(original), original)
  })

  test('a plain Error becomes an internal error', () => {
    const converted = toAnvilError(new Error('kaboom'))
    assert.equal(converted.code, ErrorCode.Internal)
    assert.equal(converted.message, 'kaboom')
  })

  test('a thrown non-Error becomes an internal error', () => {
    assert.equal(toAnvilError('a string').code, ErrorCode.Internal)
  })
})

describe('parseCliArgs', () => {
  test('parses long and short flags', () => {
    const args = parseCliArgs(['--json', '-j'], { json: { type: 'boolean', short: 'j' } })
    assert.equal(getBool(args, 'json'), true)
  })

  test('collects positionals', () => {
    const args = parseCliArgs(['show', 'extra'], { json: { type: 'boolean' } })
    assert.deepEqual(args.positionals, ['show', 'extra'])
  })

  test('rejects unknown flags rather than ignoring them', () => {
    // A silently ignored --jso that emits human output is a nasty trap for anything
    // parsing stdout.
    assert.throws(
      () => parseCliArgs(['--jso'], { json: { type: 'boolean' } }),
      (err: unknown) => {
        assert.ok(err instanceof AnvilError)
        assert.equal(err.code, ErrorCode.Usage)
        assert.equal(err.exitCode, ExitCode.Usage)
        return true
      },
    )
  })

  test('getString returns undefined for a boolean flag', () => {
    const args = parseCliArgs(['--flag'], { flag: { type: 'boolean' } })
    assert.equal(getString(args, 'flag'), undefined)
  })

  test('getList splits comma-separated values', () => {
    const args = parseCliArgs(['--tickets', 'a, b ,c'], { tickets: { type: 'string' } })
    assert.deepEqual(getList(args, 'tickets'), ['a', 'b', 'c'])
  })

  test('getList handles a repeated flag', () => {
    const args = parseCliArgs(['--t', 'a', '--t', 'b'], { t: { type: 'string', multiple: true } })
    assert.deepEqual(getList(args, 't'), ['a', 'b'])
  })

  test('getList is empty when absent', () => {
    const args = parseCliArgs([], { t: { type: 'string' } })
    assert.deepEqual(getList(args, 't'), [])
  })
})

describe('color detection', () => {
  const stream = { isTTY: true } as NodeJS.WriteStream

  test('honors --no-color', () => {
    assert.equal(shouldUseColor({ noColor: true, stream, env: {} }), false)
  })

  test('honors NO_COLOR', () => {
    assert.equal(shouldUseColor({ noColor: false, stream, env: { NO_COLOR: '1' } }), false)
  })

  test('honors FORCE_COLOR', () => {
    assert.equal(shouldUseColor({ noColor: false, stream: { isTTY: false } as NodeJS.WriteStream, env: { FORCE_COLOR: '1' } }), true)
  })

  test('TERM=dumb disables color', () => {
    assert.equal(shouldUseColor({ noColor: false, stream, env: { TERM: 'dumb' } }), false)
  })

  test('non-TTY disables color by default', () => {
    assert.equal(shouldUseColor({ noColor: false, stream: { isTTY: false } as NodeJS.WriteStream, env: {} }), false)
  })

  test('FORCE_COLOR=0 disables color even on a TTY', () => {
    assert.equal(shouldUseColor({ noColor: false, stream, env: { FORCE_COLOR: '0' } }), false)
  })
})

describe('style', () => {
  test('disabled style is the identity function', () => {
    const s = makeStyle(false)
    assert.equal(s.red('boom'), 'boom')
    assert.equal(s.bold('x'), 'x')
  })

  test('enabled style wraps in escapes', () => {
    const s = makeStyle(true)
    assert.ok(s.red('boom').includes('boom'))
    assert.notEqual(s.red('boom'), 'boom')
  })
})

describe('renderTable', () => {
  const style = makeStyle(false)

  test('renders (none) for no rows', () => {
    assert.equal(renderTable(['a'], [], style), '(none)')
  })

  test('renders a header and every row', () => {
    const out = renderTable(['name', 'state'], [['a', 'ok'], ['b', 'bad']], style)
    assert.match(out, /name/)
    assert.match(out, /state/)
    assert.match(out, /a\s+ok/)
    assert.match(out, /b\s+bad/)
  })

  test('truncates to maxWidth instead of wrapping the terminal', () => {
    const long = 'x'.repeat(300)
    const out = renderTable(['k', 'v'], [['key', long]], style, 40)
    for (const line of out.split('\n')) {
      assert.ok(line.length <= 40, `line too long (${line.length}): ${line}`)
    }
  })

  test('truncation is marked', () => {
    const out = renderTable(['k', 'v'], [['key', 'y'.repeat(200)]], style, 40)
    assert.match(out, /…/)
  })

  test('tolerates short rows', () => {
    const out = renderTable(['a', 'b', 'c'], [['only-one']], style)
    assert.match(out, /only-one/)
  })
})

describe('renderKeyValues', () => {
  test('aligns keys into a column', () => {
    const out = renderKeyValues(
      [
        ['short', '1'],
        ['much-longer', '2'],
      ],
      makeStyle(false),
    )
    const lines = out.split('\n')
    assert.equal(lines.length, 2)
    assert.ok(lines.every((l) => l.includes('  ')))
  })

  test('handles an empty list', () => {
    assert.equal(renderKeyValues([], makeStyle(false)), '')
  })
})
