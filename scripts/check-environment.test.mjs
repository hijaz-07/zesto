import { describe, expect, it } from 'vitest';
import {
  PRODUCTION_PROJECT_ID,
  checkEnvironment,
  parseDotenv,
  razorpayMode,
  shorten,
} from './check-environment.mjs';

// Obviously fake identifiers: nothing here is a real project or key.
const PROD_FRONT = { VITE_FIREBASE_PROJECT_ID: PRODUCTION_PROJECT_ID, VITE_DESCOPE_PROJECT_ID: 'P2prodDESCOPEid' };
const PROD_BACK = { DESCOPE_PROJECT_ID: 'P2prodDESCOPEid', RAZORPAY_KEY_ID: 'rzp_test_PRODFAKE0001' };
const STAGE_FRONT = { VITE_FIREBASE_PROJECT_ID: 'zesto-staging-x', VITE_DESCOPE_PROJECT_ID: 'P2stageDESCOPEid' };
const STAGE_BACK = { DESCOPE_PROJECT_ID: 'P2stageDESCOPEid', RAZORPAY_KEY_ID: 'rzp_test_STAGEFAKE001' };

const production = (over = {}) => checkEnvironment({
  env: 'production', stagingProjectId: null, frontend: PROD_FRONT, backend: PROD_BACK,
  otherFrontend: null, otherBackend: null, ...over,
});
const staging = (over = {}) => checkEnvironment({
  env: 'staging', stagingProjectId: 'zesto-staging-x', frontend: STAGE_FRONT, backend: STAGE_BACK,
  otherFrontend: PROD_FRONT, otherBackend: PROD_BACK, ...over,
});

describe('parseDotenv', () => {
  it('reads names and values, ignoring comments, blanks, export and quotes', () => {
    expect(parseDotenv('# c\n\nA=1\nexport B="two"\n  C = \'3\'\n#D=4\nbad line\n')).toEqual({ A: '1', B: 'two', C: '3' });
  });
});

describe('razorpayMode / shorten', () => {
  it('names the mode from the public prefix only', () => {
    expect(razorpayMode('rzp_test_abc123')).toBe('test');
    expect(razorpayMode('rzp_live_abc123')).toBe('live');
    expect(razorpayMode('key_abc')).toBe('unknown');
    expect(razorpayMode('rzp_test_')).toBe('unknown');
    expect(razorpayMode(undefined)).toBe('missing');
  });

  it('never prints a whole identifier', () => {
    expect(shorten('P2prodDESCOPEidLONGVALUE')).toBe('P2pro…LUE');
    expect(shorten('abc')).toBe('abc…');
    expect(shorten(undefined)).toBe('(not set)');
    expect(shorten('P2prodDESCOPEidLONGVALUE')).not.toContain('DESCOPEid');
  });
});

describe('production', () => {
  it('passes with the production project, matching Descope ids and a Razorpay TEST key', () => {
    const result = production();
    expect(result.errors).toEqual([]);
    expect(result.summary).toMatchObject({ environment: 'production', firebaseProject: PRODUCTION_PROJECT_ID, razorpayMode: 'test' });
  });

  it('refuses a frontend that names another Firebase project', () => {
    expect(production({ frontend: { ...PROD_FRONT, VITE_FIREBASE_PROJECT_ID: 'zesto-staging-x' } }).errors.join()).toMatch(/VITE_FIREBASE_PROJECT_ID/);
  });

  it('refuses a Live key unless Live Mode is explicitly allowed', () => {
    const live = { ...PROD_BACK, RAZORPAY_KEY_ID: 'rzp_live_FAKE000000001' };
    expect(production({ backend: live }).errors.join()).toMatch(/LIVE/);
    expect(production({ backend: live, allowLive: true }).errors).toEqual([]);
  });

  it('refuses mismatched Descope projects and unrecognisable or missing keys', () => {
    expect(production({ backend: { ...PROD_BACK, DESCOPE_PROJECT_ID: 'P2other' } }).errors.join()).toMatch(/differ/);
    expect(production({ backend: { ...PROD_BACK, RAZORPAY_KEY_ID: 'oops' } }).errors.join()).toMatch(/recognisable/);
    expect(production({ backend: { DESCOPE_PROJECT_ID: PROD_BACK.DESCOPE_PROJECT_ID } }).errors.join()).toMatch(/RAZORPAY_KEY_ID is not set/);
  });

  it('refuses a secret in a file that is not a secret store, and never echoes its value', () => {
    const result = production({ backend: { ...PROD_BACK, RAZORPAY_KEY_SECRET: 'hunter2-very-secret' } });
    expect(result.errors.join()).toMatch(/RAZORPAY_KEY_SECRET/);
    expect(JSON.stringify(result)).not.toContain('hunter2');
  });
});

describe('staging', () => {
  it('reports "not configured" instead of guessing when no staging project exists', () => {
    const result = staging({ stagingProjectId: null, frontend: null, backend: null });
    expect(result.errors).toEqual([]);
    expect(result.summary.firebaseProject).toBe('(not configured)');
    expect(result.notes.join()).toMatch(/No staging Firebase project/);
  });

  it('passes when it shares nothing with production and uses a TEST key', () => {
    expect(staging().errors).toEqual([]);
  });

  it.each([
    ['the production Firebase project', { stagingProjectId: PRODUCTION_PROJECT_ID }, /PRODUCTION Firebase project/],
    ['a frontend built for the production project', { frontend: { ...STAGE_FRONT, VITE_FIREBASE_PROJECT_ID: PRODUCTION_PROJECT_ID } }, /VITE_FIREBASE_PROJECT_ID/],
    ['production\'s Descope project', {
      frontend: { ...STAGE_FRONT, VITE_DESCOPE_PROJECT_ID: PROD_FRONT.VITE_DESCOPE_PROJECT_ID },
      backend: { ...STAGE_BACK, DESCOPE_PROJECT_ID: PROD_FRONT.VITE_DESCOPE_PROJECT_ID },
    }, /same Descope project/],
    ['production\'s Razorpay key', { backend: { ...STAGE_BACK, RAZORPAY_KEY_ID: PROD_BACK.RAZORPAY_KEY_ID } }, /same Razorpay key/],
    ['a Razorpay LIVE key, even with --allow-live', { backend: { ...STAGE_BACK, RAZORPAY_KEY_ID: 'rzp_live_FAKE000000001' }, allowLive: true }, /TEST key/],
  ])('refuses staging that uses %s', (_name, over, pattern) => {
    expect(staging(over).errors.join()).toMatch(pattern);
  });
});
