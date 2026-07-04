import { describe, expect, it } from 'vitest';
import { encodeLatin9 } from './latin9';

describe('encodeLatin9 (FEC — arrêté du 29/07/2013)', () => {
  it('couvre tout le français sans perte : accents, œ, € (0xA4 en Latin-9)', () => {
    const r = encodeLatin9('Sèvres réglée à 90 € cœur');
    expect(r.replacedCount).toBe(0);
    expect([...r.bytes]).toContain(0xbd); // œ
    expect([...r.bytes]).toContain(0xa4); // €
    expect([...r.bytes]).toContain(0xe8); // è (Latin-1 hérité)
  });

  it('les positions Latin-1 supprimées par Latin-9 (½, ¤, ´…) deviennent « ? » comptés', () => {
    const r = encodeLatin9('½ litre ¤');
    expect(r.replacedCount).toBe(2);
    expect(r.bytes[0]).toBe(0x3f);
  });

  it('hors répertoire (emoji, CJK) → « ? » compté, jamais une corruption silencieuse', () => {
    const r = encodeLatin9('ok 🚀 好');
    expect(r.replacedCount).toBeGreaterThan(0);
    expect(r.bytes.every((b) => b <= 0xff)).toBe(true);
  });

  it('ASCII pur : octets identiques, zéro remplacement', () => {
    const r = encodeLatin9('JournalCode\tVE\n');
    expect(r.replacedCount).toBe(0);
    expect([...r.bytes]).toEqual([...'JournalCode\tVE\n'].map((c) => c.charCodeAt(0)));
  });
});
