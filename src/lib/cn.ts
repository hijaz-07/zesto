export type ClassValue = string | number | false | null | undefined;

/** Joins truthy class names together, skipping falsy values. */
export function cn(...values: ClassValue[]): string {
  return values.filter(Boolean).join(' ');
}
