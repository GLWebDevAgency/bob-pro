import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import {
  addLine,
  applyQuoteDraftCommand,
  createQuoteDraft,
  selectCustomer,
  updateQuoteDraftLineForm,
  type QuoteDraftState,
} from './quote-draft-model';
import type { QuoteDraftStorageIdentity } from './quote-draft-codec';
import {
  chunkQuoteDraftPayload,
  GenerationQuoteDraftStore,
  QUOTE_DRAFT_SECURE_CHUNK_BYTES,
  QuoteDraftStoreError,
  type QuoteDraftKeyValueStore,
} from './quote-draft-store';

const IDENTITY: QuoteDraftStorageIdentity = {
  mode: 'authenticated',
  userId: 'user-1',
  companyId: 'company-1',
};

class MemoryKeyValueStore implements QuoteDraftKeyValueStore {
  readonly values = new Map<string, string>();
  readonly operations: Array<{ readonly type: 'get' | 'set' | 'remove'; readonly key: string }> =
    [];
  failSet: ((key: string) => boolean) | null = null;
  failRemove: ((key: string) => boolean) | null = null;

  async get(key: string): Promise<string | null> {
    this.operations.push({ type: 'get', key });
    return this.values.get(key) ?? null;
  }

  async set(key: string, value: string): Promise<void> {
    this.operations.push({ type: 'set', key });
    if (this.failSet?.(key) === true) throw new Error('injected_set_failure');
    this.values.set(key, value);
  }

  async remove(key: string): Promise<void> {
    this.operations.push({ type: 'remove', key });
    if (this.failRemove?.(key) === true) throw new Error('injected_remove_failure');
    this.values.delete(key);
  }
}

const runtime = {
  sha256: async (value: string) => createHash('sha256').update(value).digest('hex'),
};

function value(result: ReturnType<typeof selectCustomer>): QuoteDraftState {
  if (!result.ok) throw new Error(result.error.message);
  return result.value;
}

function draft(label = 'Pose chauffe-eau'): QuoteDraftState {
  let state = value(
    selectCustomer(createQuoteDraft('session-1'), {
      id: 'customer-1',
      name: 'Camping Les Pins',
    }),
  );
  state = value(applyQuoteDraftCommand(state, { type: 'next_step' }));
  state = value(
    applyQuoteDraftCommand(state, {
      type: 'set_vat',
      context: { housingOlderThan2y: true, energyRenovation: false },
      vatRate: 10,
    }),
  );
  return value(
    addLine(state, {
      lineId: 'line-1',
      interaction: 'manual',
      line: { label, category: 'labor', qty: 2, unitPriceHT: 5_500, vatRate: 10 },
    }),
  );
}

describe('generation quote draft store', () => {
  it('coupe en UTF-8 sous la limite sans casser les caractères', () => {
    const payload = `début-${'électricité-🔧-'.repeat(300)}-fin`;
    const chunks = chunkQuoteDraftPayload(payload);
    expect(chunks.join('')).toBe(payload);
    for (const chunk of chunks) {
      expect(new TextEncoder().encode(chunk).byteLength).toBeLessThanOrEqual(
        QUOTE_DRAFT_SECURE_CHUNK_BYTES,
      );
    }
  });

  it('refuse un brouillon hors quota avant de toucher le pointeur existant', async () => {
    const kv = new MemoryKeyValueStore();
    const store = new GenerationQuoteDraftStore(kv, runtime);
    await store.save(IDENTITY, draft('Version récupérable'), 100);
    const base = draft();
    const oversized: QuoteDraftState = {
      ...base,
      revision: 200,
      flow: {
        ...base.flow,
        draft: {
          ...base.flow.draft,
          lines: Array.from({ length: 200 }, (_, index) => ({
            label: `${String(index)}-${'x'.repeat(490)}`,
            category: 'labor' as const,
            qty: 1,
            unitPriceHT: 1_000,
            vatRate: 10 as const,
          })),
        },
      },
      lineMetadata: Array.from({ length: 200 }, (_, index) => ({
        id: `line-${String(index)}`,
        interaction: 'manual' as const,
      })),
    };

    await expect(store.save(IDENTITY, oversized, 200)).rejects.toEqual(
      expect.objectContaining<Partial<QuoteDraftStoreError>>({ code: 'payload_too_large' }),
    );
    expect((await store.load(IDENTITY))?.flow.draft.lines[0]?.label).toBe('Version récupérable');
  });

  it('écrit chunks puis manifeste puis pointeur, et recharge le snapshot validé', async () => {
    const kv = new MemoryKeyValueStore();
    const store = new GenerationQuoteDraftStore(kv, runtime);
    const saved = await store.save(IDENTITY, draft(), 100);
    expect(saved.saved?.at).toBe(100);

    const writes = kv.operations.filter((operation) => operation.type === 'set');
    expect(writes.at(-1)?.key).toMatch(/\.head$/u);
    expect(writes.at(-2)?.key).toMatch(/\.manifest$/u);
    // Nouvelle instance = nouveau processus JS ; seule la donnée native simulée subsiste.
    const loaded = await new GenerationQuoteDraftStore(kv, runtime).load(IDENTITY);
    expect(loaded).toMatchObject({
      sessionId: 'session-1',
      customer: { id: 'customer-1', name: 'Camping Les Pins' },
      saved: { at: 100 },
      proposal: null,
      mission: { status: 'idle' },
    });
  });

  it('conserve la génération précédente si le nouveau commit est interrompu', async () => {
    const kv = new MemoryKeyValueStore();
    const store = new GenerationQuoteDraftStore(kv, runtime);
    await store.save(IDENTITY, draft('Version sûre'), 100);
    kv.failSet = (key) => key.endsWith('.head');

    await expect(store.save(IDENTITY, draft('Version interrompue'), 200)).rejects.toEqual(
      expect.objectContaining<Partial<QuoteDraftStoreError>>({ code: 'write_failed' }),
    );
    kv.failSet = null;
    const loaded = await store.load(IDENTITY);
    expect(loaded?.flow.draft.lines[0]?.label).toBe('Version sûre');
    expect(loaded?.saved?.at).toBe(100);
  });

  it('alterne les slots et supprime l’ancienne génération après le pointeur', async () => {
    const kv = new MemoryKeyValueStore();
    const store = new GenerationQuoteDraftStore(kv, runtime);
    await store.save(IDENTITY, draft('A'), 100);
    await store.save(IDENTITY, draft('B'), 200);
    const keys = [...kv.values.keys()];
    expect(keys.some((key) => key.includes('.a.'))).toBe(false);
    expect(keys.some((key) => key.includes('.b.'))).toBe(true);
    expect((await store.load(IDENTITY))?.flow.draft.lines[0]?.label).toBe('B');
  });

  it('purge silencieusement corruption, pointeur inconnu et mauvais digest', async () => {
    const kv = new MemoryKeyValueStore();
    const store = new GenerationQuoteDraftStore(kv, runtime);
    await store.save(IDENTITY, draft(), 100);
    const chunkKey = [...kv.values.keys()].find((key) => /\.[ab]\.0$/u.test(key));
    expect(chunkKey).toBeDefined();
    kv.values.set(chunkKey!, `${kv.values.get(chunkKey!)!}corruption`);
    await expect(store.load(IDENTITY)).resolves.toBeNull();
    expect([...kv.values.keys()].some((key) => key.endsWith('.head'))).toBe(false);

    await store.save(IDENTITY, draft(), 200);
    const pointerKey = [...kv.values.keys()].find((key) => key.endsWith('.head'))!;
    kv.values.set(pointerKey, JSON.stringify({ version: 99, generation: 'a' }));
    await expect(store.load(IDENTITY)).resolves.toBeNull();
    expect(kv.values.size).toBe(0);
  });

  it('refuse un pointeur basculé vers un ancien slot même si son nettoyage avait échoué', async () => {
    const kv = new MemoryKeyValueStore();
    const store = new GenerationQuoteDraftStore(kv, runtime);
    await store.save(IDENTITY, draft('Ancienne version'), 100);
    kv.failRemove = (key) => key.includes('.a.');
    await store.save(IDENTITY, draft('Version courante'), 200);
    kv.failRemove = null;
    const pointerKey = [...kv.values.keys()].find((key) => key.endsWith('.head'))!;
    const pointer = JSON.parse(kv.values.get(pointerKey)!) as Record<string, unknown>;
    pointer['generation'] = 'a';
    kv.values.set(pointerKey, JSON.stringify(pointer));

    await expect(store.load(IDENTITY)).resolves.toBeNull();
    expect(kv.values.size).toBe(0);
  });

  it('isole les identités et supprime les deux générations au discard/logout', async () => {
    const kv = new MemoryKeyValueStore();
    const store = new GenerationQuoteDraftStore(kv, runtime);
    await store.save(IDENTITY, updateQuoteDraftLineForm(draft(), { label: 'À reprendre' }), 100);
    await expect(store.load({ ...IDENTITY, userId: 'user-2' })).resolves.toBeNull();
    await expect(store.load(IDENTITY)).resolves.not.toBeNull();
    await store.clear(IDENTITY);
    expect(kv.values.size).toBe(0);
    await expect(store.load(IDENTITY)).resolves.toBeNull();
  });

  it('remonte une suppression durable impossible au lieu de prétendre avoir quitté', async () => {
    const kv = new MemoryKeyValueStore();
    const store = new GenerationQuoteDraftStore(kv, runtime);
    await store.save(IDENTITY, draft(), 100);
    kv.failRemove = (key) => key.endsWith('.head');
    await expect(store.clear(IDENTITY)).rejects.toEqual(
      expect.objectContaining<Partial<QuoteDraftStoreError>>({ code: 'clear_failed' }),
    );
  });

  it('sérialise save puis logout-clear pour qu’aucun write tardif ne recrée le pointeur', async () => {
    const kv = new MemoryKeyValueStore();
    const store = new GenerationQuoteDraftStore(kv, runtime);
    const saving = store.save(IDENTITY, draft('Écriture en vol'), 100);
    const loggingOut = store.clear(IDENTITY);
    await expect(Promise.all([saving, loggingOut])).resolves.toBeDefined();
    expect(kv.values.size).toBe(0);
    await expect(store.load(IDENTITY)).resolves.toBeNull();
  });
});
