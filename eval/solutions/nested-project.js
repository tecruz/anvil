/**
 * Helper module for nested-project scenario.
 *
 * Reads the configuration from the detected project root and returns its parsed content.
 */
import { readFileSync } from 'node:fs'

export function readConfig() {
  return JSON.parse(readFileSync(new URL('../config.json', import.meta.url), 'utf8'))
}
