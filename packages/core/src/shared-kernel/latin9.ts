/**
 * Encodage ISO 8859-15 (Latin-9) — l'arrêté du 29 juillet 2013 (FEC, art. A47 A-1 LPF)
 * prescrit ASCII, ISO 8859-15 ou EBCDIC : un FEC remis en UTF-8 peut être rejeté.
 * Latin-9 = Latin-1 avec 8 substitutions (dont € en 0xA4 et œ/Œ — le répertoire couvre
 * tout le français). Les caractères hors répertoire sont remplacés par « ? » et comptés,
 * pour que l'appelant puisse avertir plutôt que corrompre en silence.
 */

/** Les 8 positions où Latin-9 diverge de Latin-1 (code point Unicode → octet Latin-9). */
const LATIN9_OVERRIDES = new Map<number, number>([
  [0x20ac, 0xa4], // €
  [0x0160, 0xa6], // Š
  [0x0161, 0xa8], // š
  [0x017d, 0xb4], // Ž
  [0x017e, 0xb8], // ž
  [0x0152, 0xbc], // Œ
  [0x0153, 0xbd], // œ
  [0x0178, 0xbe], // Ÿ
]);

/** Les positions Latin-1 SUPPRIMÉES par Latin-9 (¤ ¦ ¨ ´ ¸ ¼ ½ ¾) — hors répertoire. */
const LATIN1_REMOVED = new Set([0xa4, 0xa6, 0xa8, 0xb4, 0xb8, 0xbc, 0xbd, 0xbe]);

const REPLACEMENT = 0x3f; // '?'

export interface Latin9Encoded {
  bytes: Uint8Array;
  /** Caractères hors répertoire remplacés par « ? » — 0 = encodage sans perte. */
  replacedCount: number;
}

export function encodeLatin9(text: string): Latin9Encoded {
  const bytes = new Uint8Array(text.length);
  let replacedCount = 0;
  for (let i = 0; i < text.length; i += 1) {
    const cp = text.charCodeAt(i);
    const override = LATIN9_OVERRIDES.get(cp);
    if (override !== undefined) {
      bytes[i] = override;
    } else if (cp <= 0xff && !LATIN1_REMOVED.has(cp)) {
      bytes[i] = cp;
    } else {
      bytes[i] = REPLACEMENT;
      replacedCount += 1;
    }
  }
  return { bytes, replacedCount };
}
