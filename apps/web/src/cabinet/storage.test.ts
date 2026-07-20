import { describe, expect, it } from 'vitest';
import type { FecAnalysis } from '../fec/analyze-fec';
import {
  summarizeClosingReview,
  summarizeFecAnalysis,
  type CabinetDossier,
  type StoredFecAnalysis,
} from './types';
import {
  CABINET_STORAGE_KEY,
  deleteDossier,
  exportCabinetStateJson,
  importCabinetStateJson,
  loadCabinetState,
  parseCabinetStateJson,
  saveCabinetState,
  upsertDossier,
  upsertStoredDossier,
  type CabinetStorage,
  type CabinetStateV1,
} from './storage';

const FEC_ANALYSIS_IS_STRUCTURALLY_PERSISTABLE: FecAnalysis extends StoredFecAnalysis
  ? true
  : false = true;

class MemoryStorage implements CabinetStorage {
  readonly values = new Map<string, string>();
  setCalls = 0;
  readError: unknown = null;
  writeError: unknown = null;

  getItem(key: string): string | null {
    if (this.readError !== null) throw this.readError;
    return this.values.get(key) ?? null;
  }

  setItem(key: string, value: string): void {
    this.setCalls += 1;
    if (this.writeError !== null) throw this.writeError;
    this.values.set(key, value);
  }
}

function analysis(): StoredFecAnalysis {
  return {
    trialBalance: {
      rows: [
        {
          account: '411000',
          label: 'Clients',
          debitCents: 120_000,
          creditCents: 0,
          balanceCents: 120_000,
        },
        {
          account: '445710',
          label: 'TVA collectée',
          debitCents: 0,
          creditCents: 20_000,
          balanceCents: -20_000,
        },
        {
          account: '706000',
          label: 'Prestations',
          debitCents: 0,
          creditCents: 100_000,
          balanceCents: -100_000,
        },
      ],
      totalDebitCents: 120_000,
      totalCreditCents: 120_000,
      balanced: true,
      resultCents: 100_000,
      revenueCents: 100_000,
      chargesCents: 0,
    },
    incomeStatement: {
      exploitationProduitsCents: 100_000,
      exploitationChargesCents: 0,
      resultatExploitationCents: 100_000,
      financierProduitsCents: 0,
      financierChargesCents: 0,
      resultatFinancierCents: 0,
      resultatCourantCents: 100_000,
      exceptionnelProduitsCents: 0,
      exceptionnelChargesCents: 0,
      resultatExceptionnelCents: 0,
      participationCents: 0,
      resultatNetAvantImpotCents: 100_000,
      impotBeneficesCents: 0,
      resultatNetCents: 100_000,
    },
    balanceSheet: {
      actif: {
        immobilisationsNettesCents: 0,
        stocksCents: 0,
        creancesCents: 120_000,
        disponibilitesCents: 0,
        totalCents: 120_000,
      },
      passif: {
        capitauxPropresCents: 0,
        resultatNetCents: 100_000,
        provisionsCents: 0,
        empruntsCents: 0,
        dettesCents: 20_000,
        decouvertCents: 0,
        totalCents: 120_000,
      },
      balanced: true,
      ecartCents: 0,
    },
    turnoverCents: 100_000,
    unbalancedEntries: [],
    checks: {
      entriesBalanced: true,
      trialBalanceBalanced: true,
      balanceSheetBalanced: true,
      resultConsistent: true,
      allPassed: true,
    },
  };
}

function dossier(overrides: Partial<CabinetDossier> = {}): CabinetDossier {
  const storedAnalysis = analysis();
  return {
    siren: '732829320',
    clientName: 'Mercier Plomberie',
    sourceFileName: 'MercierFEC2026.txt',
    entryCount: 1,
    rowCount: 3,
    period: { from: '2026-01-01', to: '2026-12-31' },
    financial: summarizeFecAnalysis(storedAnalysis),
    analysis: storedAnalysis,
    review: summarizeClosingReview({
      okCount: 8,
      attentionCount: 0,
      anomalieCount: 0,
      infoCount: 2,
    }),
    fiscal: {
      legalForm: 'EURL',
      vatRegime: 'reel_simpl',
      incomeTaxRegime: 'IS',
      fiscalYearEnd: '12-31',
      urssafPeriodicity: null,
      dateCreation: '2024-03-01',
    },
    lastImportedAt: '2026-07-11T10:20:30.000Z',
    ...overrides,
  };
}

function state(...dossiers: CabinetDossier[]): CabinetStateV1 {
  return { version: 1, dossiers };
}

describe('stockage cabinet local et versionné', () => {
  it('accepte structurellement la sortie analyzeFec sans importer ses lignes source', () => {
    expect(FEC_ANALYSIS_IS_STRUCTURALLY_PERSISTABLE).toBe(true);
  });

  it('résume la sortie de revue core sans en conserver les contrôles détaillés', () => {
    expect(
      summarizeClosingReview({ okCount: 5, attentionCount: 2, anomalieCount: 0, infoCount: 1 }),
    ).toEqual({
      verdict: 'reservations',
      okCount: 5,
      attentionCount: 2,
      anomalyCount: 0,
      infoCount: 1,
    });
    expect(
      summarizeClosingReview({ okCount: 5, attentionCount: 0, anomalieCount: 1, infoCount: 0 })
        .verdict,
    ).toBe('anomalies');
  });

  it('retourne un état v1 vide quand la clé est absente', () => {
    const storage = new MemoryStorage();

    expect(loadCabinetState(storage)).toEqual({ ok: true, value: { version: 1, dossiers: [] } });
    expect(storage.values.has(CABINET_STORAGE_KEY)).toBe(false);
  });

  it('enregistre puis recharge les états dérivés sans FEC brut', () => {
    const storage = new MemoryStorage();
    const original = state(dossier());

    expect(saveCabinetState(storage, original)).toEqual({ ok: true, value: original });
    expect(loadCabinetState(storage)).toEqual({ ok: true, value: original });

    const persisted = storage.values.get(CABINET_STORAGE_KEY) ?? '';
    expect(persisted).toContain('trialBalance');
    expect(persisted).not.toContain('EcritureNum');
    expect(persisted).not.toContain('rawFec');
    expect(persisted).not.toContain('parsedFec');
  });

  it('upsert un SIREN connu sans doublon et conserve sa position', () => {
    const second = dossier({
      siren: '552100554',
      clientName: 'Société Exemple',
      sourceFileName: 'second.txt',
    });
    const current = state(dossier(), second);

    const updated = upsertDossier(
      current,
      dossier({
        siren: '732 829 320',
        clientName: 'Mercier Plomberie — mise à jour',
        lastImportedAt: '2026-07-12T08:00:00.000Z',
      }),
    );

    expect(updated.dossiers).toHaveLength(2);
    expect(updated.dossiers.map((item) => item.siren)).toEqual(['732829320', '552100554']);
    expect(updated.dossiers[0]?.clientName).toContain('mise à jour');
    expect(current.dossiers[0]?.clientName).toBe('Mercier Plomberie');
  });

  it('upsert et persiste atomiquement via le helper de stockage', () => {
    const storage = new MemoryStorage();
    expect(saveCabinetState(storage, state(dossier()))).toMatchObject({ ok: true });

    const result = upsertStoredDossier(
      storage,
      dossier({ clientName: 'Mercier actualisé', sourceFileName: 'nouveau-fec.txt' }),
    );

    expect(result).toMatchObject({
      ok: true,
      value: { dossiers: [{ clientName: 'Mercier actualisé' }] },
    });
    expect(loadCabinetState(storage)).toEqual(result);
  });

  it('supprime par SIREN, y compris saisi avec espaces, sans muter l’état source', () => {
    const current = state(dossier());

    const updated = deleteDossier(current, '732 829 320');

    expect(updated.dossiers).toEqual([]);
    expect(current.dossiers).toHaveLength(1);
  });
});

describe('import/export JSON strict et non destructif', () => {
  it('exporte un JSON réimportable', () => {
    const original = state(dossier());
    const exported = exportCabinetStateJson(original);
    expect(exported.ok).toBe(true);
    if (!exported.ok) return;

    expect(parseCabinetStateJson(exported.value)).toEqual({ ok: true, value: original });
  });

  it("rejette un JSON mal formé sans appeler setItem ni écraser l'existant", () => {
    const storage = new MemoryStorage();
    storage.values.set(CABINET_STORAGE_KEY, JSON.stringify(state(dossier())));
    const previous = storage.values.get(CABINET_STORAGE_KEY);

    const result = importCabinetStateJson(storage, '{"version":1,');

    expect(result).toMatchObject({ ok: false, error: { code: 'invalid_json' } });
    expect(storage.setCalls).toBe(0);
    expect(storage.values.get(CABINET_STORAGE_KEY)).toBe(previous);
  });

  it('rejette tout champ inconnu, notamment un FEC brut, avant mutation', () => {
    const storage = new MemoryStorage();
    const payload = JSON.parse(JSON.stringify(state(dossier()))) as {
      dossiers: Array<Record<string, unknown>>;
    };
    payload.dossiers[0]!.rawFec = 'JournalCode\tEcritureNum\tDebit\tCredit';

    const result = importCabinetStateJson(storage, JSON.stringify(payload));

    expect(result).toMatchObject({
      ok: false,
      error: { code: 'invalid_state', path: '$.dossiers[0]' },
    });
    expect(storage.setCalls).toBe(0);
  });

  it('rejette une version future et deux dossiers portant le même SIREN', () => {
    expect(parseCabinetStateJson(JSON.stringify({ version: 2, dossiers: [] }))).toMatchObject({
      ok: false,
      error: { code: 'unsupported_version', path: '$.version' },
    });
    expect(parseCabinetStateJson(JSON.stringify(state(dossier(), dossier())))).toMatchObject({
      ok: false,
      error: { code: 'invalid_state', path: '$.dossiers[1].siren' },
    });
  });

  it('rejette une synthèse qui contredit les états persistés', () => {
    const payload = state(dossier());
    payload.dossiers[0]!.financial.resultCents = 42;

    expect(parseCabinetStateJson(JSON.stringify(payload))).toMatchObject({
      ok: false,
      error: { code: 'invalid_state', path: '$.dossiers[0]' },
    });
  });

  it('rejette un dossier sans écriture ou avec moins de lignes que d’écritures', () => {
    expect(
      parseCabinetStateJson(JSON.stringify(state(dossier({ entryCount: 0, rowCount: 0 })))),
    ).toMatchObject({
      ok: false,
      error: { code: 'invalid_state', path: '$.dossiers[0]' },
    });
    expect(
      parseCabinetStateJson(JSON.stringify(state(dossier({ entryCount: 4, rowCount: 3 })))),
    ).toMatchObject({
      ok: false,
      error: { code: 'invalid_state', path: '$.dossiers[0]' },
    });
  });
});

describe('erreurs du navigateur', () => {
  it('rend une erreur quota actionnable sans remplacer la valeur précédente', () => {
    const storage = new MemoryStorage();
    storage.values.set(CABINET_STORAGE_KEY, JSON.stringify({ version: 1, dossiers: [] }));
    storage.writeError = { name: 'QuotaExceededError' };
    const previous = storage.values.get(CABINET_STORAGE_KEY);

    const result = saveCabinetState(storage, state(dossier()));

    expect(result).toMatchObject({ ok: false, error: { code: 'quota_exceeded' } });
    expect(result.ok ? '' : result.error.message).toContain('Exportez');
    expect(storage.values.get(CABINET_STORAGE_KEY)).toBe(previous);
  });

  it('distingue un stockage illisible et une erreur d’écriture générique', () => {
    const unreadable = new MemoryStorage();
    unreadable.readError = new Error('privacy mode');
    expect(loadCabinetState(unreadable)).toMatchObject({
      ok: false,
      error: { code: 'storage_unavailable' },
    });

    const unwritable = new MemoryStorage();
    unwritable.writeError = new Error('disk failure');
    expect(saveCabinetState(unwritable, state(dossier()))).toMatchObject({
      ok: false,
      error: { code: 'write_failed' },
    });
  });
});
