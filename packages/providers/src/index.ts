/**
 * @anvil/providers -- ticket provider implementations.
 *
 * `local` is the zero-auth escape hatch and works everywhere. The `gh` transport arrives
 * in M4.
 */

export {
  DEFAULT_TICKETS_DIR,
  LocalTicketProvider,
  parseTicketFile,
  renderTicketFile,
  type LocalProviderOptions,
  type LocalTicket,
  type TicketFileInput,
} from './local.ts'
