import { describe, expect, it } from 'vitest';
import { SIGN_UP_OR_IN_FLOW_ID, getDescopeProjectId } from './config';

describe('Descope config', () => {
  it('uses the existing sign-up-or-in flow configured in the Descope console', () => {
    expect(SIGN_UP_OR_IN_FLOW_ID).toBe('sign-up-or-in');
  });

  it('reads the Project ID from VITE_DESCOPE_PROJECT_ID, trimming whitespace', () => {
    expect(getDescopeProjectId({ VITE_DESCOPE_PROJECT_ID: '  P-abc123  ' })).toBe('P-abc123');
  });

  it.each([undefined, '', '   '])('throws a clear configuration error when the Project ID is %j', (value) => {
    expect(() => getDescopeProjectId({ VITE_DESCOPE_PROJECT_ID: value })).toThrow(
      /VITE_DESCOPE_PROJECT_ID is not set/,
    );
  });
});
