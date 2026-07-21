import { describe, expect, it } from 'vitest';
import { hasAsciiControlCharacter } from './control-characters';

describe('hasAsciiControlCharacter', () => {
  it('accepte le texte visible, les accents et les emojis', () => {
    expect(hasAsciiControlCharacter('Référence chantier 🧰')).toBe(false);
  });

  it('détecte les deux bornes C0 et DEL', () => {
    expect(hasAsciiControlCharacter('\u0000référence')).toBe(true);
    expect(hasAsciiControlCharacter('ligne\n suivante')).toBe(true);
    expect(hasAsciiControlCharacter('chantier\u001f')).toBe(true);
    expect(hasAsciiControlCharacter('document\u007f')).toBe(true);
  });

  it('ne confond pas les caractères non ASCII avec la plage contractuelle', () => {
    expect(hasAsciiControlCharacter('\u0085')).toBe(false);
  });
});
