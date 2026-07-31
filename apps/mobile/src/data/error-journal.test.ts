import { describe, expect, it } from 'vitest';
import type { ApiErrorReport } from '@bob/api-client';
import {
  ERROR_JOURNAL_MAX_ENTRIES,
  ERROR_JOURNAL_STORAGE_KEY,
  appendJournalEntry,
  clearJournal,
  journalEntryFromReport,
  journalEntryTime,
  journalShareText,
  parseJournal,
  readJournal,
  recordJournalEntry,
  type ErrorJournalEntry,
  type JournalStorage,
} from './error-journal';

function entry(overrides: Partial<ErrorJournalEntry> = {}): ErrorJournalEntry {
  return {
    at: '2026-07-31T14:03:00.000Z',
    code: 'BOB-SIRET-404',
    kind: 'not_found',
    correlationId: '98f73810-1111-4222-8333-444455556666',
    method: 'GET',
    path: '/company/lookup',
    status: 404,
    durationMs: 120,
    ...overrides,
  };
}

function memoryStorage(initial: Record<string, string> = {}): JournalStorage & {
  data: Map<string, string>;
} {
  const data = new Map(Object.entries(initial));
  return {
    data,
    getItem: async (key) => data.get(key) ?? null,
    setItem: async (key, value) => void data.set(key, value),
    removeItem: async (key) => void data.delete(key),
  };
}

describe('journal local — logique pure', () => {
  it('ajoute en tête et BORNE à N entrées (jamais de croissance infinie)', () => {
    let entries: ErrorJournalEntry[] = [];
    for (let index = 0; index < ERROR_JOURNAL_MAX_ENTRIES + 10; index += 1) {
      entries = appendJournalEntry(entries, entry({ code: `BOB-API-${index}` }));
    }
    expect(entries).toHaveLength(ERROR_JOURNAL_MAX_ENTRIES);
    expect(entries[0]?.code).toBe(`BOB-API-${ERROR_JOURNAL_MAX_ENTRIES + 9}`);
  });

  it('construit une entrée par LISTE BLANCHE : jamais cause/message, chemin ré-expurgé', () => {
    const report: ApiErrorReport = {
      at: '2026-07-31T14:03:00.000Z',
      method: 'GET',
      // Défense en profondeur : même si un chemin brut fuyait dans le rapport, l'entrée l'expurge.
      path: '/company/lookup?siret=91300380500017',
      status: 404,
      durationMs: 88,
      code: 'BOB-SIRET-404',
      error: {
        kind: 'not_found',
        entity: 'company',
        id: '91300380500017',
        correlationId: 'corr-abc-12345',
        code: 'BOB-SIRET-404',
      },
    };
    const journalEntry = journalEntryFromReport(report);
    expect(journalEntry).toEqual({
      at: '2026-07-31T14:03:00.000Z',
      code: 'BOB-SIRET-404',
      kind: 'not_found',
      correlationId: 'corr-abc-12345',
      method: 'GET',
      path: '/company/lookup',
      status: 404,
      durationMs: 88,
    });
    expect(JSON.stringify(journalEntry)).not.toContain('91300380500017');
  });

  it('parse tolérant : écarte les entrées corrompues sans jeter le journal entier', () => {
    const valid = entry();
    const raw = JSON.stringify([
      valid,
      { code: 'sans-les-autres-champs' },
      42,
      null,
      { ...valid, status: 'oops' },
    ]);
    expect(parseJournal(raw)).toEqual([valid]);
    expect(parseJournal('{pas-du-json')).toEqual([]);
    expect(parseJournal('"une chaîne"')).toEqual([]);
    expect(parseJournal(null)).toEqual([]);
  });

  it('texte de partage : composition FERMÉE code · corrélation · heure · route · statut', () => {
    const text = journalShareText([
      entry(),
      entry({ correlationId: null, status: null, code: 'BOB-API-502' }),
    ]);
    const lines = text.split('\n');
    expect(lines[0]).toBe('Bob Pro — diagnostic technique (2 échec(s))');
    expect(lines[1]).toContain('BOB-SIRET-404 · 98f73810-1111-4222-8333-444455556666');
    expect(lines[1]).toContain('GET /company/lookup · HTTP 404');
    expect(lines[2]).toContain('BOB-API-502 · sans-correlation');
    expect(lines[2]).toContain('sans-reponse');
    expect(lines[1]?.split(' · ')).toHaveLength(5);
  });

  it('journalEntryTime : « JJ/MM HH:MM » locale, vide si illisible', () => {
    expect(journalEntryTime('2026-07-31T14:03:00.000Z')).toMatch(/^\d{2}\/\d{2} \d{2}:\d{2}$/);
    expect(journalEntryTime('illisible')).toBe('');
  });
});

describe('journal local — persistance sérialisée', () => {
  it('enregistre puis relit, écritures concurrentes toutes conservées', async () => {
    const storage = memoryStorage();
    await Promise.all([
      recordJournalEntry(entry({ code: 'BOB-API-403' }), storage),
      recordJournalEntry(entry({ code: 'BOB-API-409' }), storage),
      recordJournalEntry(entry({ code: 'BOB-API-410' }), storage),
    ]);
    const read = await readJournal(storage);
    expect(read.map((item) => item.code).sort()).toEqual([
      'BOB-API-403',
      'BOB-API-409',
      'BOB-API-410',
    ]);
  });

  it('un stockage corrompu est remplacé au prochain enregistrement, jamais propagé', async () => {
    const storage = memoryStorage({ [ERROR_JOURNAL_STORAGE_KEY]: '{corrompu' });
    await recordJournalEntry(entry(), storage);
    expect(await readJournal(storage)).toEqual([entry()]);
  });

  it('clearJournal vide la clé ; un stockage en panne ne jette jamais', async () => {
    const storage = memoryStorage();
    await recordJournalEntry(entry(), storage);
    await clearJournal(storage);
    expect(await readJournal(storage)).toEqual([]);

    const broken: JournalStorage = {
      getItem: async () => {
        throw new Error('stockage HS');
      },
      setItem: async () => {
        throw new Error('stockage HS');
      },
      removeItem: async () => {
        throw new Error('stockage HS');
      },
    };
    await expect(recordJournalEntry(entry(), broken)).resolves.toBeUndefined();
    await expect(clearJournal(broken)).resolves.toBeUndefined();
    await expect(readJournal(broken)).resolves.toEqual([]);
  });
});
