export function releaseLine(version) {
  if (typeof version !== 'string' || version.trim() === '') {
    throw new TypeError('a release version must be a non-empty string')
  }
  return version.includes('-') ? `v${version} (pre-release)` : `v${version}`
}
