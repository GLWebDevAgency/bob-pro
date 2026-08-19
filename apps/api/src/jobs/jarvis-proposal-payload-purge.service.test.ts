/**
 * Jarvis U1-d — la rétention du magasin PII est CÂBLÉE, pas décorative (spec §5.5, revue C1).
 *
 * Fakes seulement : les preuves de policy (une charge vivante est INDESTRUCTIBLE par
 * l'applicatif, une charge échue disparaît vraiment) vivent dans
 * jarvis-proposal-payloads.postgres.test.ts (preuve 8). Ici on prouve le BALAYAGE : un @Cron
 * réel appelle `purgeExpired` par (tenant, propriétaire) sous des bornes dures, ne demande
 * jamais autre chose que ce qui est échu, ne s'arrête pas au premier échec, et se tait
 * fail-closed tant que ses autorités ne sont pas liées.
 */
import { describe, expect, it, vi } from 'vitest';
import { AppLogger } from '../observability/logger';
import type { Persistence } from '../persistence/persistence';
import { InMemoryPersistence } from '../persistence/persistence.testing';
import type { ScheduledTenantDirectory } from './tenant-directory';
import {
  JARVIS_PROPOSAL_PAYLOAD_PURGE_LIMIT_PER_OWNER,
  JARVIS_PROPOSAL_PAYLOAD_PURGE_MAX_OWNERS_PER_TENANT,
  JarvisProposalPayloadPurgeService,
  asJarvisProposalPayloadRetention,
  asJarvisProposalPayloadRetentionOwners,
  type JarvisProposalPayloadRetentionOwnersPort,
} from './jarvis-proposal-payload-purge.service';

const NOW = new Date('2026-09-01T00:00:00.000Z');

interface StoredRow {
  readonly companyId: string;
  readonly ownerUserId: string;
  readonly proposalId: string;
  readonly retentionExpiresAt: string;
}

interface PurgeCall {
  readonly companyId: string;
  readonly ownerUserId: string;
  readonly before: string;
  readonly limit: number;
}

/**
 * Magasin fake NON complaisant : il applique la règle de la POLICY DELETE — n'effacer que les
 * lignes du couple (company, owner) demandé ET déjà échues à la borne. Une purge qui tricherait
 * sur le scope ou sur l'échéance échouerait ici comme elle échouerait en base.
 */
class FakePayloadStore {
  readonly calls: PurgeCall[] = [];
  failFor = new Set<string>();

  constructor(public rows: StoredRow[]) {}

  async sealProposalPayload(): Promise<never> {
    throw new Error('inattendu : un balayage de rétention n’écrit jamais de PII');
  }

  async readProposalPayload(): Promise<null> {
    throw new Error('inattendu : un balayage de rétention ne lit jamais le contenu');
  }

  async purgeExpired(input: PurgeCall): Promise<number> {
    this.calls.push(input);
    if (this.failFor.has(`${input.companyId}/${input.ownerUserId}`)) {
      throw new Error('purge indisponible');
    }
    const doomed = this.rows.filter(
      (row) =>
        row.companyId === input.companyId &&
        row.ownerUserId === input.ownerUserId &&
        Date.parse(row.retentionExpiresAt) <= Date.parse(input.before),
    );
    const kept = doomed.slice(input.limit);
    this.rows = this.rows.filter((row) => !doomed.includes(row) || kept.includes(row));
    return doomed.length - kept.length;
  }
}

function persistenceWith(store: FakePayloadStore | null): Persistence {
  return { createJarvisProposalPayloadStore: () => store } as unknown as Persistence;
}

function tenantDirectory(companyIds: string[]): ScheduledTenantDirectory {
  return { listCompanyIds: async () => companyIds } as unknown as ScheduledTenantDirectory;
}

function ownerDirectory(
  ownersByCompany: Record<string, string[] | Error>,
): JarvisProposalPayloadRetentionOwnersPort {
  return {
    listRetentionOwners: async (companyId) => {
      const owners = ownersByCompany[companyId] ?? [];
      if (owners instanceof Error) throw owners;
      return owners;
    },
  };
}

function harness(options: {
  rows?: StoredRow[];
  companyIds?: string[];
  owners?: Record<string, string[] | Error>;
  ownerDirectoryAbsent?: boolean;
  /** Persistance de substitution : sert à prouver le no-op quand le magasin durable est absent. */
  persistence?: Persistence;
}) {
  const store = new FakePayloadStore(options.rows ?? []);
  const logger = new AppLogger();
  const audit = vi.spyOn(logger, 'audit').mockImplementation(() => undefined);
  const warn = vi.spyOn(logger, 'warn').mockImplementation(() => undefined);
  const service = new JarvisProposalPayloadPurgeService(
    options.persistence ?? persistenceWith(store),
    tenantDirectory(options.companyIds ?? ['co_1']),
    logger,
    options.ownerDirectoryAbsent === true ? null : ownerDirectory(options.owners ?? {}),
    () => NOW,
  );
  return { service, store, audit, warn };
}

function row(overrides: Partial<StoredRow> = {}): StoredRow {
  return {
    companyId: 'co_1',
    ownerUserId: 'usr_1',
    proposalId: 'prop_1',
    retentionExpiresAt: '2026-08-01T00:00:00.000Z',
    ...overrides,
  };
}

describe('JarvisProposalPayloadPurgeService — le PII périmé disparaît vraiment (§5.5)', () => {
  it('efface les charges échues et ne demande RIEN hors échéance', async () => {
    const expired = row({ proposalId: 'prop_echue' });
    const alive = row({
      proposalId: 'prop_vivante',
      retentionExpiresAt: '2026-09-30T00:00:00.000Z',
    });
    const h = harness({ rows: [expired, alive], owners: { co_1: ['usr_1'] } });

    const summary = await h.service.sweep();

    expect(summary).toEqual({ skipped: null, tenants: 1, owners: 1, purged: 1, failures: 0 });
    expect(h.store.rows).toEqual([alive]);
    // Borne = l'instant du balayage, jamais une borne future qui réclamerait du PII vivant.
    expect(h.store.calls).toEqual([
      {
        companyId: 'co_1',
        ownerUserId: 'usr_1',
        before: NOW.toISOString(),
        limit: JARVIS_PROPOSAL_PAYLOAD_PURGE_LIMIT_PER_OWNER,
      },
    ]);
  });

  it('balaye chaque (tenant, propriétaire) sous SON scope — jamais un balayage global', async () => {
    const rows = [
      row({ companyId: 'co_1', ownerUserId: 'usr_1' }),
      row({ companyId: 'co_1', ownerUserId: 'usr_2' }),
      row({ companyId: 'co_2', ownerUserId: 'usr_3' }),
    ];
    const h = harness({
      rows,
      companyIds: ['co_1', 'co_2'],
      owners: { co_1: ['usr_1', 'usr_2'], co_2: ['usr_3'] },
    });

    const summary = await h.service.sweep();

    expect(summary).toMatchObject({ tenants: 2, owners: 3, purged: 3, failures: 0 });
    expect(h.store.calls.map((call) => `${call.companyId}/${call.ownerUserId}`)).toEqual([
      'co_1/usr_1',
      'co_1/usr_2',
      'co_2/usr_3',
    ]);
    expect(h.store.rows).toEqual([]);
  });

  it('un propriétaire en échec n’empêche ni son tenant ni les suivants d’être purgés', async () => {
    const h = harness({
      rows: [row({ ownerUserId: 'usr_ko' }), row({ ownerUserId: 'usr_ok' })],
      owners: { co_1: ['usr_ko', 'usr_ok'] },
    });
    h.store.failFor.add('co_1/usr_ko');

    const summary = await h.service.sweep();

    expect(summary).toMatchObject({ owners: 2, purged: 1, failures: 1 });
    expect(h.store.rows.map((stored) => stored.ownerUserId)).toEqual(['usr_ko']);
  });

  it('annuaire de propriétaires indisponible : le tenant est sauté, les autres sont purgés', async () => {
    const h = harness({
      rows: [row({ companyId: 'co_ok', ownerUserId: 'usr_ok' })],
      companyIds: ['co_ko', 'co_ok'],
      owners: { co_ko: new Error('annuaire indisponible'), co_ok: ['usr_ok'] },
    });

    const summary = await h.service.sweep();

    expect(summary).toMatchObject({ tenants: 2, owners: 1, purged: 1, failures: 1 });
    expect(h.store.rows).toEqual([]);
  });

  it('borne le travail : propriétaires dédoublonnés puis plafonnés par tenant', async () => {
    const owners = Array.from(
      { length: JARVIS_PROPOSAL_PAYLOAD_PURGE_MAX_OWNERS_PER_TENANT + 5 },
      (_, index) => `usr_${String(index).padStart(3, '0')}`,
    );
    const h = harness({ owners: { co_1: [...owners, ...owners] } });

    const summary = await h.service.sweep();

    expect(summary.owners).toBe(JARVIS_PROPOSAL_PAYLOAD_PURGE_MAX_OWNERS_PER_TENANT);
    expect(h.store.calls).toHaveLength(JARVIS_PROPOSAL_PAYLOAD_PURGE_MAX_OWNERS_PER_TENANT);
    expect(new Set(h.store.calls.map((call) => call.ownerUserId)).size).toBe(
      JARVIS_PROPOSAL_PAYLOAD_PURGE_MAX_OWNERS_PER_TENANT,
    );
  });

  it('fait tourner les tenants sans famine : un balayage ne prend jamais toute la base', async () => {
    const companyIds = Array.from(
      { length: 101 },
      (_, index) => `co_${String(index).padStart(3, '0')}`,
    );
    const h = harness({ companyIds, owners: {} });

    const summary = await h.service.sweep();

    expect(summary.tenants).toBeLessThanOrEqual(100);
    expect(summary.tenants).toBeGreaterThan(0);
  });

  it('magasin durable absent (double mémoire) ⇒ no-op AUDITÉ, aucune purge simulée', async () => {
    const h = harness({
      persistence: new InMemoryPersistence() as unknown as Persistence,
      owners: { co_1: ['usr_1'] },
    });

    const first = await h.service.sweep();
    const second = await h.service.sweep();

    expect(first).toEqual({
      skipped: 'retention_absent',
      tenants: 0,
      owners: 0,
      purged: 0,
      failures: 0,
    });
    expect(second.skipped).toBe('retention_absent');
    // Une dépendance absente est un état de déploiement : elle se dit UNE fois, pas à chaque tick.
    expect(h.audit).toHaveBeenCalledTimes(1);
    expect(h.audit.mock.calls[0]?.[0]).toBe('jarvis.proposal_payload.purge_dependencies_absent');
  });

  it('annuaire de propriétaires non lié ⇒ no-op AUDITÉ, jamais un balayage sans propriétaire', async () => {
    const h = harness({ rows: [row()], ownerDirectoryAbsent: true });

    const summary = await h.service.sweep();

    expect(summary.skipped).toBe('owner_directory_absent');
    expect(h.store.calls).toEqual([]);
    // Fail-closed : la charge échue reste en base, mais elle n'est jamais réputée effacée.
    expect(h.store.rows).toHaveLength(1);
  });

  it('ne relance pas un balayage déjà en cours', async () => {
    const h = harness({ rows: [row()], owners: { co_1: ['usr_1'] } });

    const [first, second] = await Promise.all([h.service.sweep(), h.service.sweep()]);

    expect([first.skipped, second.skipped]).toContain('running');
    expect(h.store.calls).toHaveLength(1);
  });

  /**
   * U1-e §4 — LA LIAISON. Le magasin durable porte désormais `listRetentionOwners` (autorité
   * SECURITY DEFINER `list_jarvis_payload_retention_owners_v1`). Ce qui suit prouve que le
   * câblage est STRUCTUREL et fail-closed : reconnu quand la méthode existe, `null` sinon, et
   * qu'une fois reconnu le tick cesse vraiment de rendre `owner_directory_absent`.
   */
  it('reconnaît structurellement l’annuaire du magasin durable, et rien d’autre', () => {
    const withDirectory = {
      purgeExpired: async () => 0,
      listRetentionOwners: async () => [],
    } as unknown as Parameters<typeof asJarvisProposalPayloadRetentionOwners>[0];
    const withoutDirectory = {
      purgeExpired: async () => 0,
    } as unknown as Parameters<typeof asJarvisProposalPayloadRetentionOwners>[0];

    expect(asJarvisProposalPayloadRetentionOwners(withDirectory)).toBe(withDirectory);
    // Fail-closed : un magasin qui sait purger mais pas énumérer n'improvise pas un annuaire.
    expect(asJarvisProposalPayloadRetentionOwners(withoutDirectory)).toBeNull();
    expect(asJarvisProposalPayloadRetentionOwners(null)).toBeNull();
    // Les deux reconnaissances sont INDÉPENDANTES : l'une ne vaut jamais l'autre.
    expect(asJarvisProposalPayloadRetention(withoutDirectory)).toBe(withoutDirectory);
  });

  it('annuaire lié ⇒ le tick n’est plus `owner_directory_absent` et le PII échu part', async () => {
    // Le MÊME objet porte les deux capacités, comme l'adapter Prisma réel : une seule connexion,
    // une purge owner-scopée et une énumération sous autorité.
    const store = new FakePayloadStore([row({ ownerUserId: 'usr_1' })]);
    const durable = Object.assign(store, {
      listRetentionOwners: async (companyId: string, limit: number) => {
        expect(companyId).toBe('co_1');
        expect(limit).toBe(JARVIS_PROPOSAL_PAYLOAD_PURGE_MAX_OWNERS_PER_TENANT);
        return ['usr_1'];
      },
    });
    const logger = new AppLogger();
    const audit = vi.spyOn(logger, 'audit').mockImplementation(() => undefined);
    const service = new JarvisProposalPayloadPurgeService(
      persistenceWith(durable),
      tenantDirectory(['co_1']),
      logger,
      asJarvisProposalPayloadRetentionOwners(
        durable as unknown as Parameters<typeof asJarvisProposalPayloadRetentionOwners>[0],
      ),
      () => NOW,
    );

    const summary = await service.sweep();

    expect(summary).toEqual({ skipped: null, tenants: 1, owners: 1, purged: 1, failures: 0 });
    expect(store.rows).toEqual([]);
    // Plus AUCUN audit de dépendance absente : la rétention n'est plus une promesse creuse.
    expect(audit.mock.calls.map((call) => call[0])).not.toContain(
      'jarvis.proposal_payload.purge_dependencies_absent',
    );
  });

  it('le tick planifié n’explose jamais : un annuaire de tenants en panne est journalisé', async () => {
    const store = new FakePayloadStore([]);
    const logger = new AppLogger();
    const warn = vi.spyOn(logger, 'warn').mockImplementation(() => undefined);
    const service = new JarvisProposalPayloadPurgeService(
      persistenceWith(store),
      {
        listCompanyIds: async () => Promise.reject(new Error('annuaire mort')),
      } as unknown as ScheduledTenantDirectory,
      logger,
      ownerDirectory({}),
      () => NOW,
    );

    service.scheduled();
    await new Promise((resolve) => setImmediate(resolve));

    expect(warn).toHaveBeenCalledOnce();
    // Le verrou de réentrance est RENDU même après une panne : le tick suivant retente vraiment
    // (un balayage figé sur `running` laisserait le PII échu en base pour toujours).
    await expect(service.sweep()).rejects.toThrow('annuaire mort');
  });
});
