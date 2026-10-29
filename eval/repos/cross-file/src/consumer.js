/**
 * A consumer that relies on the shared helper.
 *
 * It currently uppercases the helper's result. A helper-only fix cannot make the hidden
 * integration test pass; the consumer has to be updated too.
 */
import { format } from './format.js'

export function render(val) {
  return format(val).toUpperCase()
}
