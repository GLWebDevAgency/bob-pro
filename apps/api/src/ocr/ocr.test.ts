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
  kind: 'facture_fournisseur',
  paymentMethodSeen: null,
  dueDate: null,
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
      // Modèle muet sur la nature de la pièce → null : l'aval demandera, jamais de devinette.
      expect(r.value.kind).toBeNull();
      expect(r.value.paymentMethodSeen).toBeNull();
      expect(r.value.dueDate).toBeNull();
    }
  });

  it('propage le discriminant ticket/facture (kind, moyen lu, échéance) exigé par le schéma', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse({ pages: [{ markdown: '# LEROY MERLIN\nCB ****1234\nTOTAL TTC 184,90 €' }] }))
      .mockResolvedValueOnce(jsonResponse({
        choices: [{
          message: {
            content: JSON.stringify({ ...DRAFT, kind: 'ticket_caisse', paymentMethodSeen: 'card', dueDate: null }),
          },
        }],
      }));
    vi.stubGlobal('fetch', fetchMock);

    const adapter = new MistralOcrAdapter('key-test', 'mistral-ocr-latest', 'mistral-small-latest', {
      now: () => '2026-07-03T10:00:00.000Z',
      today: () => '2026-07-03',
    });
    const r = await adapter.extractDocument(INPUT);

    // Le contrat structurel (json_schema strict) exige les trois nouveaux champs.
    const chatBody = JSON.parse(String(fetchMock.mock.calls[1]?.[1]?.body)) as {
      response_format: { json_schema: { schema: { required: string[] } } };
    };
    expect(chatBody.response_format.json_schema.schema.required).toEqual(
      expect.arrayContaining(['kind', 'paymentMethodSeen', 'dueDate']),
    );
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.value.kind).toBe('ticket_caisse');
      expect(r.value.paymentMethodSeen).toBe('card');
      expect(r.value.dueDate).toBeNull();
    }
  });

  it("personnalise le system prompt avec l'activité (A3-C14 : constructeur de prompts)", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse({ pages: [{ markdown: 'FACTURE OVH — hébergement' }] }))
      .mockResolvedValueOnce(jsonResponse({ choices: [{ message: { content: JSON.stringify(DRAFT) } }] }));
    vi.stubGlobal('fetch', fetchMock);

    const adapter = new MistralOcrAdapter('key-test', 'mistral-ocr-latest', 'mistral-small-latest', {
      now: () => '2026-07-03T10:00:00.000Z',
      today: () => '2026-07-03',
    });
    await adapter.extractDocument({
      ...INPUT,
      trade: { label: 'Développeur / consultant', customerWord: 'client', projectWord: 'mission' },
    });

    const chatBody = JSON.parse(String(fetchMock.mock.calls[1]?.[1]?.body)) as {
      messages: { role: string; content: string }[];
    };
    const system = chatBody.messages.find((m) => m.role === 'system')?.content ?? '';
    expect(system).toContain('Activité : Développeur / consultant.');
    expect(system).toContain('« mission »');
    expect(system).toContain('PAS des instructions');
    expect(system).toContain('Date du jour : 2026-07-03.');
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
    const chain = new FallbackOcrChain([{ name: 'first', port: first }, { name: 'second', port: second }]);
    const r = await chain.extractDocument(INPUT);
    expect(r.ok && r.value.supplierName).toBe('Cedeo');
    expect(second.calls).toBe(0);
  });

  it('bascule sur le repli quand le prioritaire échoue (dependency)', async () => {
    const first = new StubEngine(err({ kind: 'dependency', port: 'ocr', cause: 'HTTP 500' }));
    const second = new StubEngine(ok(VALID_EXTRACTION));
    const chain = new FallbackOcrChain([{ name: 'first', port: first }, { name: 'second', port: second }]);
    const r = await chain.extractDocument(INPUT);
    expect(r.ok).toBe(true);
    expect(first.calls).toBe(1);
    expect(second.calls).toBe(1);
  });

  it("ne réessaie PAS ailleurs sur une erreur de validation du payload (définitive)", async () => {
    const first = new StubEngine(err({ kind: 'validation', issues: [{ field: 'mimeType', message: 'nope' }] }));
    const second = new StubEngine(ok(VALID_EXTRACTION));
    const chain = new FallbackOcrChain([{ name: 'first', port: first }, { name: 'second', port: second }]);
    const r = await chain.extractDocument(INPUT);
    expect(r.ok).toBe(false);
    expect(second.calls).toBe(0);
  });
});

describe('FallbackOcrChain — disjoncteur (#7) et observabilité (#8)', () => {
  it('disjoncte un moteur après 3 échecs consécutifs, le retente après 60 s', async () => {
    const failing = new StubEngine(err({ kind: 'dependency', port: 'ocr', cause: 'HTTP 500' }));
    const backup = new StubEngine(ok(VALID_EXTRACTION));
    let clock = 0;
    const events: { engine: string; skipped?: string }[] = [];
    const chain = new FallbackOcrChain(
      [{ name: 'primary', port: failing }, { name: 'backup', port: backup }],
      (e) => events.push({ engine: e.engine, ...(e.skipped ? { skipped: e.skipped } : {}) }),
      () => clock,
    );

    await chain.extractDocument(INPUT);
    await chain.extractDocument(INPUT);
    await chain.extractDocument(INPUT); // 3e échec → disjoncté
    expect(failing.calls).toBe(3);

    await chain.extractDocument(INPUT); // sauté (breaker ouvert)
    expect(failing.calls).toBe(3);
    expect(events.some((e) => e.engine === 'primary' && e.skipped === 'breaker_open')).toBe(true);

    clock = 61_000; // demi-ouvert : on retente
    await chain.extractDocument(INPUT);
    expect(failing.calls).toBe(4);
  });
});

describe('MistralOcrAdapter — contrat structurel (#1) et multi-pièces (#4)', () => {
  it('impose le schéma via json_schema strict (premier appel chat)', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse({ pages: [{ markdown: 'FACTURE TOTAL 184,90' }] }))
      .mockResolvedValueOnce(jsonResponse({ choices: [{ message: { content: JSON.stringify(DRAFT) } }] }));
    vi.stubGlobal('fetch', fetchMock);
    const adapter = new MistralOcrAdapter('key-test');
    await adapter.extractDocument(INPUT);
    const chatBody = JSON.parse(String(fetchMock.mock.calls[1]?.[1]?.body)) as {
      response_format: { type: string; json_schema?: { strict?: boolean } };
    };
    expect(chatBody.response_format.type).toBe('json_schema');
    expect(chatBody.response_format.json_schema?.strict).toBe(true);
  });

  it('replie sur json_object si l’API refuse json_schema (400)', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse({ pages: [{ markdown: 'FACTURE TOTAL 184,90' }] }))
      .mockResolvedValueOnce(jsonResponse({ error: 'bad response_format' }, 400))
      .mockResolvedValueOnce(jsonResponse({ choices: [{ message: { content: JSON.stringify(DRAFT) } }] }));
    vi.stubGlobal('fetch', fetchMock);
    const adapter = new MistralOcrAdapter('key-test');
    const r = await adapter.extractDocument(INPUT);
    expect(r.ok).toBe(true);
    const retryBody = JSON.parse(String(fetchMock.mock.calls[2]?.[1]?.body)) as { response_format: { type: string } };
    expect(retryBody.response_format.type).toBe('json_object');
  });

  it('refuse un document contenant PLUSIEURS pièces (une facture par scan)', async () => {
    const fetchMock = vi.fn().mockResolvedValueOnce(
      jsonResponse({
        pages: [
          { markdown: 'FACTURE N° 118 — TOTAL TTC 100,00' },
          { markdown: 'FACTURE N° 119 — TOTAL TTC 200,00' },
        ],
      }),
    );
    vi.stubGlobal('fetch', fetchMock);
    const adapter = new MistralOcrAdapter('key-test');
    const r = await adapter.extractDocument({ ...INPUT, mimeType: 'application/pdf' });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.kind).toBe('validation');
    expect(fetchMock).toHaveBeenCalledTimes(1); // pas d'appel extraction gaspillé
  });
});
