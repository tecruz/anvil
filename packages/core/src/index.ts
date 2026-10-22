/**
 * @anvil/core -- shared types, config resolution, output contract, git discovery.
 *
 * Runtime dependencies: none. Everything here is Node built-ins.
 */

export {
  type FlagSpec,
  type FlagSpecs,
  getBool,
  getList,
  getString,
  type ParsedArgs,
  parseCliArgs,
  tokenizeCommand,
} from './args.ts'
export {
  type AnvilConfig,
  CONFIG_DIR_NAME,
  CONFIG_FILE_NAME,
  type ConfigSource,
  type ConfigSourceKind,
  defaultConfig,
  ensureParentDir,
  globalConfigPath,
  type LoadConfigOptions,
  loadConfig,
  mergeConfig,
  type ResolvedConfig,
  repoConfigPath,
  SCHEMA_URL,
  starterConfigJson,
  stateDir,
} from './config.ts'
export { SHIP_GUARD_ENV } from './constants.ts'
export {
  AnvilError,
  type AnvilErrorOptions,
  ErrorCode,
  type ErrorCodeValue,
  ExitCode,
  type ExitCodeValue,
  isAnvilError,
  toAnvilError,
} from './errors.ts'
export {
  isExecutableFile,
  isUnsafeArgument,
  needsVerbatimArguments,
  type ProcessResult,
  probeCommandVersion,
  quoteForCmd,
  type ResolvedCommand,
  type RunProcessOptions,
  resolveCommand,
  runProcess,
  spawnArgv,
  WINDOWS_EXECUTABLE_EXTENSIONS,
} from './exec.ts'
export {
  type Envelope,
  emitFailure,
  emitJson,
  type FailureEnvelope,
  failure,
  makeStyle,
  renderKeyValues,
  renderTable,
  type Style,
  type SuccessEnvelope,
  shouldUseColor,
  success,
  type WriteOptions,
} from './output.ts'
export {
  SCHEMA_VERSION,
  type SchemaVersion,
  VERSION,
} from './version.ts'
