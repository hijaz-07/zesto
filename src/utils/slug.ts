export const SLUG_MIN_LENGTH = 3;
export const SLUG_MAX_LENGTH = 50;

/** Lowercase letters/digits, hyphen-separated — mirrors the backend's `SLUG_PATTERN`. */
export const SLUG_PATTERN = /^[a-z0-9]+(-[a-z0-9]+)*$/;

/**
 * Suggests a slug from an organization name. This is only a starting point
 * for the user to edit — it never guarantees the result is valid or unique;
 * the backend remains the sole authority on both.
 */
export function suggestSlug(name: string): string {
  return name
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, SLUG_MAX_LENGTH);
}
