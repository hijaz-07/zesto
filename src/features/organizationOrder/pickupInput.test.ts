import { describe, expect, it } from 'vitest';
import {
  PICKUP_INPUT_EMPTY,
  PICKUP_INPUT_MALFORMED,
  PICKUP_INPUT_MAX_LENGTH,
  normalizePickupInput,
} from './pickupInput';

const QR = 'ZP1.kQ3vR8nT2xLpA7mZdW1e.AbCdEfGhIjKlMnOpQrStUv';

describe('normalizePickupInput', () => {
  describe('the 8-character backup code', () => {
    it.each([
      ['as displayed', 'K7QX-4M2P'],
      ['without the hyphen', 'K7QX4M2P'],
      ['in lower case', 'k7qx-4m2p'],
      ['with a space instead of the hyphen', 'K7QX 4M2P'],
      ['with spaces everywhere', ' k 7 q x - 4 m 2 p '],
      ['with a tab and newline from a paste', '\tK7QX-4M2P\r\n'],
      ['with a newline from a keyboard-wedge scanner', 'K7QX4M2P\n'],
    ])('reads a code typed %s', (_label, raw) => {
      expect(normalizePickupInput(raw)).toEqual({ ok: true, kind: 'code', credential: 'K7QX-4M2P' });
    });

    it('reads the characters that look alike as their digit, as the backend alphabet does (O->0, I and L->1)', () => {
      expect(normalizePickupInput('oilo-oil1')).toEqual({ ok: true, kind: 'code', credential: '0110-0111' });
    });

    it.each([
      ['7 characters', 'K7QX-4M2'],
      ['9 characters', 'K7QX-4M2PA'],
      ['a letter the alphabet does not have (U)', 'K7QX-4M2U'],
      ['a symbol', 'K7QX-4M2!'],
      ['an emoji', 'K7QX-4M2🙂'],
      ['two codes run together', 'K7QX-4M2P K7QX-4M2P'],
    ])('rejects %s', (_label, raw) => {
      expect(normalizePickupInput(raw)).toEqual({ ok: false, message: PICKUP_INPUT_MALFORMED });
    });
  });

  describe('the QR payload (pasted, or typed by a keyboard-wedge scanner)', () => {
    it('passes a well-formed payload through untouched', () => {
      expect(normalizePickupInput(QR)).toEqual({ ok: true, kind: 'qr', credential: QR });
    });

    it('drops the newline a wedge scanner appends, and surrounding whitespace', () => {
      expect(normalizePickupInput(`  ${QR}\r\n`)).toEqual({ ok: true, kind: 'qr', credential: QR });
    });

    it('is case-sensitive: it is not re-cased into something else', () => {
      expect(normalizePickupInput(QR.toLowerCase())).toEqual({ ok: false, message: PICKUP_INPUT_MALFORMED });
      expect(normalizePickupInput(QR)).toMatchObject({ credential: QR });
    });

    it.each([
      ['no order id', 'ZP1..AbCdEfGhIjKlMnOpQrStUv'],
      ['no proof', 'ZP1.kQ3vR8nT2xLpA7mZdW1e.'],
      ['a short proof', 'ZP1.kQ3vR8nT2xLpA7mZdW1e.abcd'],
      ['a long proof', `ZP1.kQ3vR8nT2xLpA7mZdW1e.${'a'.repeat(23)}`],
      ['a proof with a bad character', `ZP1.kQ3vR8nT2xLpA7mZdW1e.${'a'.repeat(21)}!`],
      ['an order id with a space', `ZP1.kQ3 vR8.${'a'.repeat(22)}`],
      ['an order id with a slash', `ZP1.a/b.${'a'.repeat(22)}`],
      ['no separator', 'ZP1.kQ3vR8nT2xLpA7mZdW1e'],
      ['trailing text after the proof', `${QR} extra`],
    ])('rejects a payload with %s', (_label, raw) => {
      expect(normalizePickupInput(raw)).toEqual({ ok: false, message: PICKUP_INPUT_MALFORMED });
    });
  });

  describe('input that is not a pickup code at all', () => {
    it.each([['empty', ''], ['blank', '   '], ['only a newline', '\n'], ['only control characters', '\u0000\u0007\u001b']])(
      'asks for a code when it is %s',
      (_label, raw) => {
        expect(normalizePickupInput(raw)).toEqual({ ok: false, message: PICKUP_INPUT_EMPTY });
      },
    );

    it.each([
      ['a URL', 'https://example.com/pay?x=1'],
      ['an order id', 'kQ3vR8nT2xLpA7mZdW1e'],
      ['a QR payload of another version', 'ZP2.kQ3vR8nT2xLpA7mZdW1e.AbCdEfGhIjKlMnOpQrStUv'],
      ['plain words', 'hello world'],
    ])('rejects %s', (_label, raw) => {
      expect(normalizePickupInput(raw)).toEqual({ ok: false, message: PICKUP_INPUT_MALFORMED });
    });

    it('rejects anything longer than the bound, however it is shaped', () => {
      expect(normalizePickupInput('A'.repeat(PICKUP_INPUT_MAX_LENGTH + 1))).toEqual({
        ok: false,
        message: PICKUP_INPUT_MALFORMED,
      });
      expect(normalizePickupInput(`ZP1.${'a'.repeat(PICKUP_INPUT_MAX_LENGTH)}`)).toMatchObject({ ok: false });
    });
  });

  it('never echoes the input in a message', () => {
    const secretLooking = 'SUPER-SECRET-VALUE';

    const result = normalizePickupInput(secretLooking);

    expect(JSON.stringify(result)).not.toContain('SECRET');
  });

  it('sends the code in the backend format, so what is shown to staff and what is sent agree', () => {
    expect(normalizePickupInput('zz99ab12')).toMatchObject({ credential: 'ZZ99-AB12' });
  });
});
