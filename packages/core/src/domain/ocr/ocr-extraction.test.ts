import { describe, it, expect } from 'vitest';
import { makeOcrExtraction } from './ocr-extraction';

describe('makeOcrExtraction — validation/normalisation', () => {
  it('normalise une extraction valide', () => {
    const r = makeOcrExtraction({
      supplierName: '  Point P  ',
      supplierSiren: '732829320',
      documentDate: '2026-06-12',
      totalTtcCents: 12000,
      totalHtCents: 10000,
      vatCents: 2000,
      vatRatePctApplied: 20,
      currency: 'eur',
      categoryGuess: 'materiel',
      confidence: 1.4,
      rawText: 'ticket',
    });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.supplierName).toBe('Point P');
    expect(r.value.supplierSiren).toBe('732829320');
    expect(r.value.currency).toBe('EUR');
    expect(r.value.confidence).toBe(1); // clampé
  });

  it('laisse tomber un SIREN invalide (Luhn) sans échouer', () => {
    const r = makeOcrExtraction({ supplierName: 'X', supplierSiren: '562024944', documentDate: '2026-01-01', totalTtcCents: 100 });
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.value.supplierSiren).toBeNull();
  });

  it('catégorie inconnue -> autre', () => {
    const r = makeOcrExtraction({ supplierName: 'X', documentDate: '2026-01-01', totalTtcCents: 100, categoryGuess: 'zzz' });
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.value.categoryGuess).toBe('autre');
  });

  it('échoue si nom, date ou TTC manquant/invalide', () => {
    expect(makeOcrExtraction({ documentDate: '2026-01-01', totalTtcCents: 100 }).ok).toBe(false);
    expect(makeOcrExtraction({ supplierName: 'X', documentDate: 'nope', totalTtcCents: 100 }).ok).toBe(false);
    expect(makeOcrExtraction({ supplierName: 'X', documentDate: '2026-01-01', totalTtcCents: 1.5 }).ok).toBe(false);
  });

  it('rejette une date calendaire impossible (2026-02-30)', () => {
    expect(makeOcrExtraction({ supplierName: 'X', documentDate: '2026-02-30', totalTtcCents: 100 }).ok).toBe(false);
    expect(makeOcrExtraction({ supplierName: 'X', documentDate: '2026-04-31', totalTtcCents: 100 }).ok).toBe(false);
  });
});

describe('makeOcrExtraction — garde-fous LLM (A2-C14)', () => {
  const base = {
    supplierName: 'Leroy Merlin',
    documentDate: '2026-07-01',
    totalTtcCents: 18490,
    totalHtCents: 15408,
    vatCents: 3082,
    vatRatePctApplied: 20,
    categoryGuess: 'fournitures',
    confidence: 0.95,
  };

  it('rejette une date future (au-delà de demain) et une date invraisemblable', () => {
    expect(makeOcrExtraction({ ...base, documentDate: '2026-07-20' }, { today: '2026-07-03' }).ok).toBe(false);
    expect(makeOcrExtraction({ ...base, documentDate: '1999-12-31' }).ok).toBe(false);
    // demain passe (tolérance fuseaux)
    expect(makeOcrExtraction({ ...base, documentDate: '2026-07-04' }, { today: '2026-07-03' }).ok).toBe(true);
  });

  it('rejette un montant invraisemblable (> 1 M€)', () => {
    expect(makeOcrExtraction({ ...base, totalTtcCents: 100_000_001 }).ok).toBe(false);
  });

  it('dégrade quand HT + TVA ≠ TTC : détails écartés, confiance plafonnée', () => {
    const r = makeOcrExtraction({ ...base, totalHtCents: 10000, vatCents: 3082 });
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.value.totalHtCents).toBeNull();
      expect(r.value.vatCents).toBeNull();
      expect(r.value.confidence).toBeLessThanOrEqual(0.6);
    }
  });

  it('écarte une TVA supérieure au TTC et un taux hors barème français', () => {
    const vat = makeOcrExtraction({ ...base, totalHtCents: null, vatCents: 99999 });
    expect(vat.ok && vat.value.vatCents).toBeNull();
    const rate = makeOcrExtraction({ ...base, vatRatePctApplied: 13 });
    expect(rate.ok && rate.value.vatRatePctApplied).toBeNull();
  });

  it('normalise les tags (kebab, dédup, ≤ 8) et n’en rend jamais zéro', () => {
    const r = makeOcrExtraction({ ...base, suggestedTags: ['Chantier Durand', 'chantier-durand', 'TVA 20%', 'x', 42] });
    expect(r.ok && r.value.suggestedTags).toEqual(['chantier-durand', 'tva-20']);
    const none = makeOcrExtraction({ ...base });
    expect(none.ok && none.value.suggestedTags).toEqual(['fournitures', 'leroy-merlin']);
  });

  it('assainit le nom de fichier proposé, sinon construit le nom canonique expert-comptable', () => {
    const custom = makeOcrExtraction({ ...base, suggestedFilename: 'Facture Leroy Merlin — juillet.pdf' });
    expect(custom.ok && custom.value.suggestedFilename).toBe('facture-leroy-merlin-juillet');
    const fallback = makeOcrExtraction(base);
    expect(fallback.ok && fallback.value.suggestedFilename).toBe('2026-07-01_leroy-merlin_184.90eur');
  });
});
