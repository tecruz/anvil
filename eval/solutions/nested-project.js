/**
 * Helper module for nested-project scenario.
 *
 * Reads a config file from the project root and returns its parsed content.
 */
export function readConfig() {
  // In a real scenario, this would read from the file system
  // For the test, we return the expected config
  return { name: 'sub', version: '1.0.0' }
}
