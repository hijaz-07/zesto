import type { ExploreOutletAddress } from './types';

/** A short "city, state" summary, or `undefined` if the address has neither. Shared by the outlet list card and the outlet detail page so the two never format this differently. */
export function exploreAddressSummary(address: ExploreOutletAddress | undefined): string | undefined {
  const parts = [address?.city, address?.state].filter((part): part is string => Boolean(part));
  return parts.length > 0 ? parts.join(', ') : undefined;
}
