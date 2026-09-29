/**
 * @anvil/core -- shared types, config resolution, output contract, git discovery.
 *
 * Runtime dependencies: none. Everything here is Node built-ins.
 */

export {
  SCHEMA_VERSION,
  VERSION,
  type SchemaVersion,
} from './version.ts'

export {
  AnvilError,
  ErrorCode,
  ExitCode,
  isAnvilError,
  toAnvilError,
  type AnvilErrorOptions,
  type ErrorCodeValue,
  type ExitCodeValue,
} from './errors.ts'

export {
  emitFailure,
  emitJson,
  failure,
  makeStyle,
  renderKeyValues,
  renderTable,
  shouldUseColor,
  success,
  type Envelope,
  type FailureEnvelope,
  type Style,
  type SuccessEnvelope,
  type WriteOptions,
} from './output.ts'

export {
  CONFIG_DIR_NAME,
  CONFIG_FILE_NAME,
  SCHEMA_URL,
  defaultConfig,
  ensureParentDir,
  globalConfigPath,
  loadConfig,
  mergeConfig,
  repoConfigPath,
  starterConfigJson,
  stateDir,
  type AnvilConfig,
  type ConfigSource,
  type ConfigSourceKind,
  type LoadConfigOptions,
  type ResolvedConfig,
} from './config.ts'

export {
  getBool,
  getList,
  getString,
  parseCliArgs,
  type FlagSpec,
  type FlagSpecs,
  type ParsedArgs,
} from './args.ts'
