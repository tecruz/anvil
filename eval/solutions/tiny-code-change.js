/**
 * URL slugs.
 */

/**
 * Turn a title into a URL slug: lowercase, runs of spaces become one dash, and dashes
 * at the ends are trimmed.
 */
export function slugify(title) {
  return title
    .trim()
    .toLowerCase()
    .replace(/\s+/g, '-')
    .replace(/^-+|-+$/g, '')
}
