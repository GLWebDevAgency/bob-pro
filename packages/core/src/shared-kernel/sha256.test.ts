import { describe, expect, it } from 'vitest';
import { sha256Hex } from './sha256';

/**
 * Vecteurs officiels FIPS 180-4 / NIST CAVP + vecteurs UTF-8 vérifiés avec `node:crypto`
 * (echo -n <input> | shasum -a 256). Le test croisé node:crypto vit côté API (pont-serveur).
 */
describe('sha256Hex', () => {
  it('vecteur vide', () => {
    expect(sha256Hex('')).toBe('e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855');
  });

  it("vecteur FIPS 'abc'", () => {
    expect(sha256Hex('abc')).toBe('ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad');
  });

  it('vecteur FIPS 448 bits (2 blocs après padding)', () => {
    expect(sha256Hex('abcdbcdecdefdefgefghfghighijhijkijkljklmklmnlmnomnopnopq')).toBe(
      '248d6a61d20638b8e5c026930c3e6039a33ce45964ff2167f6ecedd419db06c1',
    );
  });

  it('vecteur FIPS 896 bits', () => {
    expect(
      sha256Hex('abcdefghbcdefghicdefghijdefghijkefghijklfghijklmghijklmnhijklmnoijklmnopjklmnopqklmnopqrlmnopqrsmnopqrstnopqrstu'),
    ).toBe('cf5b16a778af8380036ce59e7b0492370b249b11e8f07a51afac45037afee9d1');
  });

  it("phrase ASCII usuelle ('quick brown fox')", () => {
    expect(sha256Hex('The quick brown fox jumps over the lazy dog')).toBe(
      'd7a8fbb307d7809469ca9abcb0082e4f8d5651e46d3cdb762d02d0bf37c9e592',
    );
  });

  it('message d’exactement 64 octets (un bloc plein, padding sur bloc suivant)', () => {
    expect(sha256Hex('a'.repeat(64))).toBe('ffe054fe7ae0cb6dc65c3af9b61d5209f439851db43d0ba5997337df154668eb');
  });

  it('million de a (vecteur FIPS long)', () => {
    expect(sha256Hex('a'.repeat(1_000_000))).toBe(
      'cdc76e5c9914fb9281a1c7e284d73e67f1809a48a497200e046d39ccc7112cd0',
    );
  });

  it('UTF-8 multi-octets (encodage 2 octets)', () => {
    // Vérifié avec node:crypto : createHash('sha256').update('é','utf8').
    expect(sha256Hex('é')).toBe('4a99557e4033c3539de2eb65472017cad5f9557f7a0625a09f1c3f6e2ba69c4c');
  });
});
