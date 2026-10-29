/**
 * A consumer that relies on the shared helper.
 */
import { format } from './format.js'

export function render(val) {
  return format(val)
}
