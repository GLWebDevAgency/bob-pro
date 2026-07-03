import { afterEach, describe, expect, it, vi } from 'vitest';
import { ok, err, type OcrPort, type OcrExtraction, type OcrExtractInput, type Result, type AppError } from '@bob/core';
import { FallbackOcrChain, MistralOcrAdapter } from './ocr';

const INPUT: OcrExtractInput = { contentBase64: 'aGVsbG8=', mimeType: 'image/jpeg' };

const DRAFT = {
  supplierName: 'Leroy Merlin',
  supplierSiren: null,
  documentDate: '2026-07-01',
  totalTtcCents: 18490,
  totalHtCents: 15408,
  vatCents: 3082,
  vatRatePctApplied: 20,
  currency: 'EUR',
  categoryGuess: 'fournitures',
  confidence: 0.93,
  rawText: 'ignoré (remplacé par le markdown OCR)',
  suggestedTags: ['Chantier Durand', 'fournitures'],
  suggestedFilename: 'Facture Leroy juillet',
};

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
}

class StubEngine implements OcrPort {
  calls = 0;
  constructor(private readonly result: Result<OcrExtraction, AppError>) {}
  async extractDocument(): Promise<Result<OcrExtraction, AppError>> {
    this.calls += 1;
    return this.result;
  }
  async health(): Promise<{ healthy: boolean }> {
    return { healthy: true };
  }
}

const VALID_EXTRACTION: OcrExtraction = {
  supplierName: 'Cedeo',
  supplierSiren: null,
  documentDate: '2026-07-01',
  totalTtcCents: 34200,
  totalHtCents: 28500,
  vatCents: 5700,
  vatRatePctApplied: 20,
  currency: 'EUR',
  categoryGuess: 'materiel',
  confidence: 0.9,
  rawText: 'CEDEO',
  suggestedTags: ['materiel', 'cedeo'],
  suggestedFilename: '2026-07-01_cedeo_342.00eur',
};

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('MistralOcrAdapter (OCR dédié → extraction structurée → garde-fous domaine)', () => {
  it('enchaîne /v1/ocr puis /v1/chat/completions et normalise (tags kebab, rawText = markdown OCR)', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse({ pages: [{ markdown: '# LEROY MERLIN\nTOTAL TTC 184,90 €' }] }))
      .mockResolvedValueOnce(jsonResponse({ choices: [{ message: { content: JSON.stringify(DRAFT) } }] }));
    vi.stubGlobal('fetch', fetchMock);

    const adapter = new MistralOcrAdapter('key-test', 'mistral-ocr-latest', 'mistral-small-latest', {
      now: () => '2026-07-03T10:00:00.000Z',
      today: () => '2026-07-03',
    });
    const r = await adapter.extractDocument(INPUT);

    expect(fetchMock.mock.calls[0]?.[0]).toBe('https://api.mistral.ai/v1/ocr');
    expect(fetchMock.mock.calls[1]?.[0]).toBe('https://api.mistral.ai/v1/chat/completions');
    const ocrBody = JSON.parse(String(fetchMock.mock.calls[0]?.[1]?.body)) as { model: string };
    expect(ocrBody.model).toBe('mistral-ocr-latest');
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.value.supplierName).toBe('Leroy Merlin');
      expect(r.value.rawText).toContain('LEROY MERLIN'); // le markdown OCR, pas la paraphrase
      expect(r.value.suggestedTags).toEqual(['chantier-durand', 'fournitures']);
      expect(r.value.suggestedFilename).toBe('facture-leroy-juillet');
    }
  });

  it("refuse un MIME non supporté et un payload trop volumineux SANS appeler l'API", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    const adapter = new MistralOcrAdapter('key-test');
    const mime = await adapter.extractDocument({ contentBase64: 'aGVsbG8=', mimeType: 'text/plain' });
    expect(mime.ok).toBe(false);
    const huge = await adapter.extractDocument({ contentBase64: 'a'.repeat(14_000_001), mimeType: 'image/jpeg' });
    expect(huge.ok).toBe(false);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('remonte une erreur dependency si le modèle répond hors-JSON (aucune invention)', async () => {
    vi.stubGlobal(
      'fetch',
      vi
        .fn()
        .mockResolvedValueOnce(jsonResponse({ pages: [{ markdown: 'texte' }] }))
        .mockResolvedValueOnce(jsonResponse({ choices: [{ message: { content: 'désolé, voici la facture…' } }] })),
    );
    const adapter = new MistralOcrAdapter('key-test');
    const r = await adapter.extractDocument(INPUT);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.kind).toBe('dependency');
  });
});

describe('FallbackOcrChain (Mistral prioritaire, replis ordonnés)', () => {
  it('rend le premier succès sans appeler les moteurs suivants', async () => {
    const first = new StubEngine(ok(VALID_EXTRACTION));
    const second = new StubEngine(ok({ ...VALID_EXTRACTION, supplierName: 'Autre' }));
    const chain = new FallbackOcrChain([first, second]);
    const r = await chain.extractDocument(INPUT);
    expect(r.ok && r.value.supplierName).toBe('Cedeo');
    expect(second.calls).toBe(0);
  });

  it('bascule sur le repli quand le prioritaire échoue (dependency)', async () => {
    const first = new StubEngine(err({ kind: 'dependency', port: 'ocr', cause: 'HTTP 500' }));
    const second = new StubEngine(ok(VALID_EXTRACTION));
    const chain = new FallbackOcrChain([first, second]);
    const r = await chain.extractDocument(INPUT);
    expect(r.ok).toBe(true);
    expect(first.calls).toBe(1);
    expect(second.calls).toBe(1);
  });

  it("ne réessaie PAS ailleurs sur une erreur de validation du payload (définitive)", async () => {
    const first = new StubEngine(err({ kind: 'validation', issues: [{ field: 'mimeType', message: 'nope' }] }));
    const second = new StubEngine(ok(VALID_EXTRACTION));
    const chain = new FallbackOcrChain([first, second]);
    const r = await chain.extractDocument(INPUT);
    expect(r.ok).toBe(false);
    expect(second.calls).toBe(0);
  });
});
