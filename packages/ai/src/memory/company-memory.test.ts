import { describe, it, expect } from 'vitest';
import {
  normalizeSupplierName,
  InMemoryCompanyMemory,
  suggestExpenseDefaults,
  suggestCategoryClarification,
  type OcrDefaultsInput,
} from './company-memory';

const ocr = (over: Partial<OcrDefaultsInput> = {}): OcrDefaultsInput => ({
  supplierName: 'Leroy Merlin',
  supplierSiren: null,
  vatRatePctApplied: null,
  categoryGuess: 'autre',
  ...over,
});

describe('normalizeSupplierName', () => {
  it('rapproche casse, accents, ponctuation et espaces', () => {
    expect(normalizeSupplierName('LEROY  MERLIN')).toBe('leroy merlin');
    expect(normalizeSupplierName('Léroy-Merlin')).toBe('leroy merlin');
    expect(normalizeSupplierName('  Leroy   Merlin  ')).toBe('leroy merlin');
  });
});

describe('InMemoryCompanyMemory', () => {
  it('mémorise/retrouve un fournisseur (normalisation) et incrémente la confiance', () => {
    const mem = new InMemoryCompanyMemory();
    mem.rememberSupplier({ name: 'Leroy Merlin', category: 'materiel', vatRatePct: 20, siren: '552100554' });
    const p = mem.supplierProfile('LEROY MERLIN');
    expect(p?.category).toBe('materiel');
    expect(p?.vatRatePct).toBe(20);
    expect(p?.seen).toBe(1);

    mem.rememberSupplier({ name: 'Leroy Merlin', category: 'materiel' }); // 2e occurrence, sans SIREN
    const p2 = mem.supplierProfile('leroy merlin');
    expect(p2?.seen).toBe(2);
    expect(p2?.siren).toBe('552100554'); // le SIREN mémorisé persiste
  });

  it('fournisseur inconnu -> null', () => {
    expect(new InMemoryCompanyMemory().supplierProfile('Inconnu')).toBeNull();
  });
});

describe('suggestExpenseDefaults', () => {
  it('fournisseur CONNU : la catégorie de ta mémoire prime sur la devinette OCR (source=memory)', () => {
    const mem = new InMemoryCompanyMemory([{ name: 'Leroy Merlin', category: 'materiel', vatRatePct: 20 }]);
    const d = suggestExpenseDefaults(mem, ocr({ categoryGuess: 'autre' }));
    expect(d.category).toBe('materiel');
    expect(d.vatRatePct).toBe(20);
    expect(d.source).toBe('memory');
  });

  it('les données de la pièce (SIREN/TVA OCR) priment quand présentes', () => {
    const mem = new InMemoryCompanyMemory([{ name: 'Leroy Merlin', category: 'materiel', vatRatePct: 20, siren: '111111111' }]);
    const d = suggestExpenseDefaults(mem, ocr({ supplierSiren: '999999999', vatRatePctApplied: 10 }));
    expect(d.supplierSiren).toBe('999999999');
    expect(d.vatRatePct).toBe(10);
  });

  it('fournisseur INCONNU : fallback devinette OCR, rien inventé (source=ocr)', () => {
    const d = suggestExpenseDefaults(
      new InMemoryCompanyMemory(),
      ocr({ supplierName: 'Nouveau Fournisseur', categoryGuess: 'carburant', supplierSiren: '552100554' }),
    );
    expect(d.category).toBe('carburant');
    expect(d.supplierName).toBe('Nouveau Fournisseur');
    expect(d.supplierSiren).toBe('552100554');
    expect(d.source).toBe('ocr');
  });
});

describe('suggestCategoryClarification (ASK-3) — la question seulement quand la décision est réelle', () => {
  const defaults = (over: Partial<Parameters<typeof suggestCategoryClarification>[0]> = {}) => ({
    supplierName: 'Nouveau Fournisseur',
    supplierSiren: null,
    category: 'fournitures' as const,
    vatRatePct: 20,
    source: 'ocr' as const,
    ...over,
  });

  it('habitude fournisseur (source memory) : JAMAIS de question — ton historique prime', () => {
    expect(suggestCategoryClarification(defaults({ source: 'memory' }), { confidence: 0.2 })).toBeNull();
  });

  it('OCR confiant et devinette ≠ « autre » : silence (pas de question inutile)', () => {
    expect(suggestCategoryClarification(defaults(), { confidence: 0.9 })).toBeNull();
  });

  it('OCR hésitant : question — devinette en premier, « autre » joignable, 4 options max, descriptions comptables', () => {
    const q = suggestCategoryClarification(defaults(), { confidence: 0.6 });
    expect(q).not.toBeNull();
    expect(q!.options[0]?.value).toBe('fournitures');
    expect(q!.options.some((o) => o.value === 'autre')).toBe(true);
    expect(q!.options.length).toBeLessThanOrEqual(4);
    for (const o of q!.options) expect(o.description.length).toBeGreaterThan(0);
    expect(q!.question).toContain('Nouveau Fournisseur');
  });

  it('devinette « autre » = ambiguïté DE FAIT : question même à confiance haute', () => {
    const q = suggestCategoryClarification(defaults({ category: 'autre' }), { confidence: 0.9 });
    expect(q).not.toBeNull();
    // « autre » (la devinette) reste en tête, sans doublon.
    expect(q!.options[0]?.value).toBe('autre');
    expect(new Set(q!.options.map((o) => o.value)).size).toBe(q!.options.length);
  });
});

