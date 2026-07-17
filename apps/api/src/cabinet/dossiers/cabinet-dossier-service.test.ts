import { describe, expect, it } from 'vitest';
import type { CabinetRole } from '@bob/core';
import {
  cabinetDossierAnalysisSha256,
  deriveCabinetDossierFinancialSummary,
  type CabinetDossier,
  type StoredFecAnalysis,
} from './cabinet-dossier-contract';
import type {
  CabinetDossierDeleteOutcome,
  CabinetDossierMutationOutcome,
  CabinetDossierPage,
  CabinetDossierRepository,
} from './cabinet-dossier-repository';
import {
  CabinetDossierService,
  CabinetDossierServiceError,
  type CabinetDossierActorResolver,
} from './cabinet-dossier-service';

const NOW = '2026-07-17T08:30:00.000Z';

function validStoredFecAnalysis(): StoredFecAnalysis {
  return {
    trialBalance: {
      rows: [
        { account: '101', label: 'Capital', debitCents: 0, creditCents: 10_000, balanceCents: -10_000 },
        { account: '512', label: 'Banque', debitCents: 10_000, creditCents: 0, balanceCents: 10_000 },
      ],
      totalDebitCents: 10_000,
      totalCreditCents: 10_000,
      balanced: true,
      resultCents: 0,
      revenueCents: 0,
      chargesCents: 0,
    },
    incomeStatement: {
      exploitationProduitsCents: 0,
      exploitationChargesCents: 0,
      resultatExploitationCents: 0,
      financierProduitsCents: 0,
      financierChargesCents: 0,
      resultatFinancierCents: 0,
      resultatCourantCents: 0,
      exceptionnelProduitsCents: 0,
      exceptionnelChargesCents: 0,
      resultatExceptionnelCents: 0,
      participationCents: 0,
      resultatNetAvantImpotCents: 0,
      impotBeneficesCents: 0,
      resultatNetCents: 0,
    },
    balanceSheet: {
      actif: {
        immobilisationsNettesCents: 0,
        stocksCents: 0,
        creancesCents: 0,
        disponibilitesCents: 10_000,
        totalCents: 10_000,
      },
      passif: {
        capitauxPropresCents: 10_000,
        resultatNetCents: 0,
        provisionsCents: 0,
        empruntsCents: 0,
        dettesCents: 0,
        decouvertCents: 0,
        totalCents: 10_000,
      },
      balanced: true,
      ecartCents: 0,
    },
    turnoverCents: 0,
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

function validDossierInput(expectedRevision: number | null = null) {
  return {
    siren: '552100554',
    clientName: '  Atelier   Martin  ',
    sourceFileName: '552100554FEC20251231.txt',
    entryCount: 1,
    rowCount: 2,
    period: { from: '2025-01-01', to: '2025-12-31' },
    analysis: validStoredFecAnalysis(),
    review: { verdict: 'ready', okCount: 4, attentionCount: 0, anomalyCount: 0, infoCount: 1 },
    fiscal: {
      legalForm: 'SASU',
      vatRegime: 'reel_normal',
      incomeTaxRegime: 'IS',
      fiscalYearEnd: '12-31',
      urssafPeriodicity: 'monthly',
      dateCreation: '2020-03-12',
    },
    expectedRevision,
  };
}

class Actors implements CabinetDossierActorResolver {
  readonly roles = new Map<string, CabinetRole>();

  async resolveActiveActor(cabinetId: string, userId: string) {
    const role = this.roles.get(`${cabinetId}:${userId}`);
    return role ? { cabinetId, userId, role } : null;
  }
}

class TestRepository implements CabinetDossierRepository {
  readonly rows = new Map<string, CabinetDossier>();
  readonly audits: Array<{ cabinetId: string; siren: string; actorUserId: string; action: string }> = [];

  private key(cabinetId: string, siren: string) {
    return `${cabinetId}:${siren}`;
  }

  async listSummaries(input: { cabinetId: string; cursor?: string; limit: number }): Promise<CabinetDossierPage> {
    const rows = [...this.rows.values()]
      .filter((row) => row.cabinetId === input.cabinetId)
      .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt) || right.id.localeCompare(left.id));
    const start = input.cursor ? rows.findIndex((row) => row.id === input.cursor) + 1 : 0;
    const page = rows.slice(start, start + input.limit);
    return {
      items: page.map(({ analysis: _analysis, analysisSha256: _hash, ...summary }) => summary),
      nextCursor: rows.length > start + input.limit ? page.at(-1)?.id ?? null : null,
    };
  }

  async findBySiren(cabinetId: string, siren: string): Promise<CabinetDossier | null> {
    return this.rows.get(this.key(cabinetId, siren)) ?? null;
  }

  async create(input: Parameters<CabinetDossierRepository['create']>[0]): Promise<CabinetDossierMutationOutcome> {
    const key = this.key(input.cabinetId, input.data.siren);
    if (this.rows.has(key)) return { kind: 'conflict' };
    const dossier: CabinetDossier = {
      id: input.id,
      cabinetId: input.cabinetId,
      ...input.data,
      revision: 1,
      createdAt: input.now,
      updatedAt: input.now,
    };
    this.rows.set(key, dossier);
    this.audits.push({ cabinetId: input.cabinetId, siren: input.data.siren, actorUserId: input.actorUserId, action: 'created' });
    return { kind: 'saved', dossier };
  }

  async replace(input: Parameters<CabinetDossierRepository['replace']>[0]): Promise<CabinetDossierMutationOutcome> {
    const key = this.key(input.cabinetId, input.data.siren);
    const current = this.rows.get(key);
    if (!current) return { kind: 'not_found' };
    if (current.revision !== input.expectedRevision) return { kind: 'conflict' };
    const dossier: CabinetDossier = {
      id: current.id,
      cabinetId: input.cabinetId,
      ...input.data,
      revision: current.revision + 1,
      createdAt: current.createdAt,
      updatedAt: input.now,
    };
    this.rows.set(key, dossier);
    this.audits.push({ cabinetId: input.cabinetId, siren: input.data.siren, actorUserId: input.actorUserId, action: 'updated' });
    return { kind: 'saved', dossier };
  }

  async delete(input: Parameters<CabinetDossierRepository['delete']>[0]): Promise<CabinetDossierDeleteOutcome> {
    const key = this.key(input.cabinetId, input.siren);
    const current = this.rows.get(key);
    if (!current) return 'not_found';
    if (current.revision !== input.expectedRevision) return 'conflict';
    this.rows.delete(key);
    this.audits.push({ cabinetId: input.cabinetId, siren: input.siren, actorUserId: input.actorUserId, action: 'deleted' });
    return 'deleted';
  }
}

function setup() {
  const actors = new Actors();
  const dossiers = new TestRepository();
  let sequence = 0;
  const service = new CabinetDossierService({
    actors,
    dossiers,
    ids: { newId: () => `dossier-${++sequence}` },
    clock: { now: () => NOW },
  });
  return { actors, dossiers, service };
}

async function expectCode(promise: Promise<unknown>, code: string) {
  await expect(promise).rejects.toBeInstanceOf(CabinetDossierServiceError);
  await expect(promise).rejects.toMatchObject({ code });
}

describe('CabinetDossierService', () => {
  it('crée deux dossiers de même SIREN dans deux cabinets sans lecture croisée', async () => {
    const { actors, service } = setup();
    actors.roles.set('cabinet-a:admin-a', 'admin');
    actors.roles.set('cabinet-b:admin-b', 'admin');

    const a = await service.upsert({ cabinetId: 'cabinet-a', actorUserId: 'admin-a', dossier: validDossierInput() });
    const b = await service.upsert({ cabinetId: 'cabinet-b', actorUserId: 'admin-b', dossier: { ...validDossierInput(), clientName: 'Entreprise B' } });

    expect(a.id).not.toBe(b.id);
    expect((await service.list({ cabinetId: 'cabinet-a', actorUserId: 'admin-a' })).items).toHaveLength(1);
    expect((await service.get({ cabinetId: 'cabinet-a', actorUserId: 'admin-a', siren: a.siren })).clientName).toBe('Atelier Martin');
    expect((await service.get({ cabinetId: 'cabinet-b', actorUserId: 'admin-b', siren: b.siren })).clientName).toBe('Entreprise B');
    await expectCode(
      service.get({ cabinetId: 'cabinet-b', actorUserId: 'admin-a', siren: b.siren }),
      'CABINET_DOSSIER_FORBIDDEN',
    );
  });

  it('recalcule la synthèse et l’horodatage côté serveur au lieu de les accepter du client', async () => {
    const { actors, service } = setup();
    actors.roles.set('cabinet-a:manager', 'manager');
    const created = await service.upsert({ cabinetId: 'cabinet-a', actorUserId: 'manager', dossier: validDossierInput() });
    expect(created.lastImportedAt).toBe(NOW);
    expect(created.financial).toEqual(deriveCabinetDossierFinancialSummary(created.analysis));
    expect(created.analysisSha256).toBe(cabinetDossierAnalysisSha256(created.analysis));
  });

  it('refuse le create ambigu, puis applique le remplacement avec CAS exact', async () => {
    const { actors, dossiers, service } = setup();
    actors.roles.set('cabinet-a:manager', 'manager');
    const created = await service.upsert({ cabinetId: 'cabinet-a', actorUserId: 'manager', dossier: validDossierInput() });
    await expectCode(
      service.upsert({ cabinetId: 'cabinet-a', actorUserId: 'manager', dossier: validDossierInput() }),
      'CABINET_DOSSIER_CONFLICT',
    );

    const updated = await service.upsert({
      cabinetId: 'cabinet-a',
      actorUserId: 'manager',
      dossier: { ...validDossierInput(created.revision), clientName: 'Atelier Martin mis à jour' },
    });
    expect(updated.revision).toBe(2);
    expect(updated.clientName).toBe('Atelier Martin mis à jour');
    await expectCode(
      service.upsert({
        cabinetId: 'cabinet-a',
        actorUserId: 'manager',
        dossier: { ...validDossierInput(created.revision), clientName: 'Écriture obsolète' },
      }),
      'CABINET_DOSSIER_CONFLICT',
    );
    expect(dossiers.audits.map((audit) => audit.action)).toEqual(['created', 'updated']);
  });

  it('ferme le portefeuille au collaborateur tant que les assignations ne sont pas matérialisées', async () => {
    const { actors, dossiers, service } = setup();
    actors.roles.set('cabinet-a:collab', 'collaborator');
    await expectCode(
      service.list({ cabinetId: 'cabinet-a', actorUserId: 'collab' }),
      'CABINET_DOSSIER_FORBIDDEN',
    );
    await expectCode(
      service.upsert({ cabinetId: 'cabinet-a', actorUserId: 'collab', dossier: validDossierInput() }),
      'CABINET_DOSSIER_FORBIDDEN',
    );
    expect(dossiers.rows.size).toBe(0);
  });

  it('réserve la suppression à l’admin et exige la révision courante', async () => {
    const { actors, dossiers, service } = setup();
    actors.roles.set('cabinet-a:admin', 'admin');
    actors.roles.set('cabinet-a:manager', 'manager');
    const created = await service.upsert({ cabinetId: 'cabinet-a', actorUserId: 'admin', dossier: validDossierInput() });
    await expectCode(
      service.delete({ cabinetId: 'cabinet-a', actorUserId: 'manager', siren: created.siren, expectedRevision: created.revision }),
      'CABINET_DOSSIER_FORBIDDEN',
    );
    await expectCode(
      service.delete({ cabinetId: 'cabinet-a', actorUserId: 'admin', siren: created.siren, expectedRevision: created.revision + 1 }),
      'CABINET_DOSSIER_CONFLICT',
    );
    await service.delete({ cabinetId: 'cabinet-a', actorUserId: 'admin', siren: created.siren, expectedRevision: created.revision });
    expect(dossiers.rows.size).toBe(0);
    expect(dossiers.audits.at(-1)).toMatchObject({ action: 'deleted', actorUserId: 'admin' });
  });

  it('échoue fermé si l’analyse relue ne correspond plus à son empreinte', async () => {
    const { actors, dossiers, service } = setup();
    actors.roles.set('cabinet-a:admin', 'admin');
    const created = await service.upsert({ cabinetId: 'cabinet-a', actorUserId: 'admin', dossier: validDossierInput() });
    dossiers.rows.set(`cabinet-a:${created.siren}`, { ...created, analysisSha256: '0'.repeat(64) });
    await expectCode(
      service.get({ cabinetId: 'cabinet-a', actorUserId: 'admin', siren: created.siren }),
      'CABINET_DOSSIER_INTEGRITY',
    );
  });
});
