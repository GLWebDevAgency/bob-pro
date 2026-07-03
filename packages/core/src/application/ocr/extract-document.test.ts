import { describe, it, expect } from 'vitest';
import { ok, type Result } from '../../shared-kernel/result';
import { type AppError } from '../result';
import { type OcrPort, type OcrExtractInput } from '../ports/ocr';
import { type OcrExtraction } from '../../domain/ocr/ocr-extraction';
import { ExtractDocument } from './extract-document';

const sample: OcrExtraction = {
  supplierName: 'Leroy Merlin',
  supplierSiren: null,
  documentDate: '2026-06-12',
  totalTtcCents: 12000,
  totalHtCents: 10000,
  vatCents: 2000,
  vatRatePctApplied: 20,
  currency: 'EUR',
  categoryGuess: 'fournitures',
  confidence: 0.9,
  rawText: 'ticket',
  suggestedTags: ['fournitures', 'leroy-merlin'],
  suggestedFilename: '2026-06-12_leroy-merlin_120.00eur',
};

class StubOcr implements OcrPort {
  lastInput?: OcrExtractInput;
  async extractDocument(input: OcrExtractInput): Promise<Result<OcrExtraction, AppError>> {
    this.lastInput = input;
    return ok(sample);
  }
  async health(): Promise<{ healthy: boolean }> {
    return { healthy: true };
  }
}

describe('ExtractDocument — use case', () => {
  it('rejette un type non supporté', async () => {
    const r = await new ExtractDocument({ ocr: new StubOcr() }).execute({ contentBase64: 'AAAA', mimeType: 'text/plain' });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.kind).toBe('validation');
  });

  it('rejette un document vide', async () => {
    const r = await new ExtractDocument({ ocr: new StubOcr() }).execute({ contentBase64: '', mimeType: 'image/jpeg' });
    expect(r.ok).toBe(false);
  });

  it('extrait et normalise, en retirant le préfixe data: URI', async () => {
    const stub = new StubOcr();
    const r = await new ExtractDocument({ ocr: stub }).execute({
      contentBase64: 'data:image/jpeg;base64,/9j/abcDEF',
      mimeType: 'image/jpeg',
    });
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.value.supplierName).toBe('Leroy Merlin');
    expect(stub.lastInput?.contentBase64).toBe('/9j/abcDEF'); // préfixe retiré
  });
});
