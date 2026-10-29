/**
 * The consumer half of the cross-file fix: stop transforming the helper's result.
 */
import { format } from './format.js'

export function render(val) {
  return format(val)
}
