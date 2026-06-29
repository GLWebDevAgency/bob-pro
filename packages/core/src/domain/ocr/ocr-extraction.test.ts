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
});
