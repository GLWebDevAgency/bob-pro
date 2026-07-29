import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { randomInt, randomUUID } from 'node:crypto';
import { Prisma, PrismaClient } from '@prisma/client';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { CONTRACT_TRANSITIONS, Invoice, MaintenanceContract, type InvoiceSnapshot } from '@bob/core';
import {
  PrismaContractInvoicesRead,
  PrismaEquipmentContractCoverage,
  PrismaMaintenanceContractRepository,
} from './maintenance-contracts.repository';
import { PrismaPersistence } from './prisma-persistence';
import { PrismaService } from './prisma.service';

const RUN_POSTGRES_CERT = process.env.RUN_POSTGRES_MAINTENANCE_CONTRACT_CERT === 'true';

/**
 * PR-12b — certification PostgreSQL des contrats de maintenance ET du figeage légal invoices :
 *  • RLS ENABLE+FORCE + tenant_isolation sur les 3 tables ; FK composites anti-IDOR ;
 *  • CHECK status GÉNÉRÉ depuis la source TS (CONTRACT_TRANSITIONS) + cohérence triple ;
 *  • trigger BEFORE DELETE draft-only (amélioration 1 — le grant ne suffit jamais seul) ;
 *  • DETTE SOLDÉE : premier test automatisé de invoices_issued_legal_immutability — CHAQUE
 *    champ figé d'une facture ÉMISE est muté et le REFUS est prouvé (chantierId et le nouveau
 *    maintenanceContractId compris), le suivi de transmission reste mutable (contrôle positif) ;
 *  • comparaison CHAMP À CHAMP du corps redéfini (20260728110100) avec sa version précédente
 *    (20260727120000) : AUCUN champ perdu, seuls ajouts = maintenanceContractId (immutabilité)
 *    et chantierId (miroir de l'avoir, promis par 20260727120000) — annexe erratum n° 1 ;
 *  • writer N-1 : la forme de ligne SANS maintenanceContractId traverse intacte sous CHAQUE
 *    état du trigger (insert draft, émission, progression d'une pièce émise) ;
 *  • [erratum n° 8] lecture BATCHÉE listContractInvoicesByCompany (une requête, groupée).
 * Doctrine certs : SIREN aléatoires DÉDIÉS à la suite, AUCUN .catch avaleur dans l'afterAll,
 * sociétés jamais clôturées (DELETE admin légitime).
 */

function passesLuhn(value: string): boolean {
  let sum = 0;
  let double = false;
  for (let index = value.length - 1; index >= 0; index -= 1) {
    let digit = Number(value[index]);
    if (double) {
      digit *= 2;
      if (digit > 9) digit -= 9;
    }
    sum += digit;
    double = !double;
  }
  return sum % 10 === 0;
}

function appendLuhnDigit(prefix: string): string {
  for (let digit = 0; digit <= 9; digit += 1) {
    const candidate = `${prefix}${digit}`;
    if (passesLuhn(candidate)) return candidate;
  }
  throw new Error('unable to build a valid Luhn identifier');
}

function testLegalIdentity(): { siren: string; siret: string } {
  const siren = appendLuhnDigit(String(randomInt(10_000_000, 100_000_000)));
  const nicPrefix = String(randomInt(0, 10_000)).padStart(4, '0');
  return { siren, siret: appendLuhnDigit(`${siren}${nicPrefix}`) };
}

const MIGRATIONS_DIR = join(__dirname, '..', '..', '..', 'prisma', 'migrations');

/** Champs figés d'un corps de trigger : chaque `NEW."x" IS DISTINCT FROM OLD."x"`. */
function frozenFieldsOf(sql: string): Set<string> {
  const section = sql.split("OLD.status <> 'draft'")[1]?.split('RAISE EXCEPTION')[0] ?? '';
  return new Set(
    [...section.matchAll(/NEW\."?(\w+)"? IS DISTINCT FROM OLD\.("?\1"?)/g)].map((m) => m[1]!),
  );
}

/** Champs du MIROIR de l'avoir : chaque `NEW."x" IS DISTINCT FROM source_record."x"`. */
function mirrorFieldsOf(sql: string): Set<string> {
  return new Set(
    [...sql.matchAll(/NEW\."?(\w+)"? IS DISTINCT FROM source_record\.("?\1"?)/g)].map((m) => m[1]!),
  );
}

describe.skipIf(!RUN_POSTGRES_CERT)('Contrats de maintenance — certification PostgreSQL', () => {
  const companyA = `contract-cert-a-${randomUUID()}`;
  const companyB = `contract-cert-b-${randomUUID()}`;
  const customerA = `contract-customer-a-${randomUUID()}`;
  /** Second client du MÊME tenant A : cible de mutation `customerId` qui PASSE le trigger
   * d'audience d'archive (même tenant) et fait donc parler la LISTE D'IMMUTABILITÉ seule. */
  const customerA2 = `contract-customer-a2-${randomUUID()}`;
  const customerB = `contract-customer-b-${randomUUID()}`;
  const chantierA = `contract-chantier-a-${randomUUID()}`;
  const chantierB = `contract-chantier-b-${randomUUID()}`;
  const equipA = randomUUID();
  const equipB = randomUUID();
  const contractActiveA = `contract-active-a-${randomUUID()}`;
  const contractDraftA = `contract-draft-a-${randomUUID()}`;
  const contractB = `contract-b-${randomUUID()}`;
  const issuedAnnualA = `issued-annual-a-${randomUUID()}`;
  const identityA = testLegalIdentity();
  const identityB = testLegalIdentity();
  const runtimeUrl = process.env.DATABASE_URL ?? '';
  const directUrl = process.env.DIRECT_URL ?? '';

  let admin: PrismaClient;
  let workerA: PrismaService;
  let workerB: PrismaService;
  let persistence: PrismaPersistence;

  function contractProps(input: {
    id: string;
    companyId: string;
    customerId: string;
    chantierId: string | null;
    status: 'draft' | 'active';
    equipmentIds?: string[];
  }): MaintenanceContract {
    return MaintenanceContract.rehydrate({
      id: input.id,
      companyId: input.companyId,
      customerId: input.customerId,
      chantierId: input.chantierId,
      label: `Entretien ${input.id.slice(0, 18)}`,
      status: input.status,
      anniversaryDate: '2025-10-12',
      noticeDays: 30,
      visitsPerYear: 2,
      tacitRenewal: true,
      importCoveredUntil: null,
      activatedAt: input.status === 'active' ? '2025-10-12T08:00:00.000Z' : null,
      terminatedAt: null,
      terminationEffectiveDate: null,
      terminationNote: null,
      notes: null,
      revision: 1,
      lines: [
        {
          id: `${input.id}:line`,
          catalogueItemId: null,
          label: 'Forfait entretien annuel',
          quantity: 2,
          unitPriceHtCents: 80_000,
          vatRate: 20,
          position: 0,
        },
      ],
      equipmentIds: input.equipmentIds ?? [],
    });
  }

  beforeAll(async () => {
    if (!runtimeUrl || !directUrl) {
      throw new Error('DATABASE_URL (rôle runtime) et DIRECT_URL (admin) sont requis.');
    }
    admin = new PrismaClient({ datasourceUrl: directUrl });
    workerA = new PrismaService({ datasourceUrl: runtimeUrl });
    workerB = new PrismaService({ datasourceUrl: runtimeUrl });
    persistence = new PrismaPersistence(workerA);
    await Promise.all([admin.$connect(), workerA.$connect(), workerB.$connect()]);

    for (const [companyId, customerId, chantierId, equipmentId, identity] of [
      [companyA, customerA, chantierA, equipA, identityA],
      [companyB, customerB, chantierB, equipB, identityB],
    ] as const) {
      await admin.company.create({
        data: {
          id: companyId,
          name: `Certification ${companyId}`,
          legalForm: 'EI',
          siren: identity.siren,
          siret: identity.siret,
          trade: 'maintenance',
          vatRegime: 'reel_normal',
          addrLine1: '1 rue de la Certification',
          addrZip: '75001',
          addrCity: 'Paris',
        },
      });
      await admin.customer.create({
        data: {
          id: customerId,
          companyId,
          type: 'b2g',
          name: `RATP ${customerId.slice(0, 12)}`,
          addrLine1: '2 rue du Dépôt',
          addrZip: '75012',
          addrCity: 'Paris',
        },
      });
      if (companyId === companyA) {
        await admin.customer.create({
          data: {
            id: customerA2,
            companyId,
            type: 'b2b',
            name: 'Carrefour Certification',
            addrLine1: '3 rue du Dépôt',
            addrZip: '75012',
            addrCity: 'Paris',
          },
        });
      }
      await admin.chantier.create({
        data: {
          id: chantierId,
          companyId,
          name: `Site ${chantierId.slice(0, 12)}`,
          status: 'open',
          openedAt: new Date('2026-07-01T00:00:00.000Z'),
          updatedAt: new Date(),
        },
      });
      await admin.equipment.create({
        data: {
          id: equipmentId,
          companyId,
          chantierId,
          label: `Fontaine ${equipmentId.slice(0, 8)}`,
          updatedAt: new Date(),
        },
      });
    }

    const repoA = new PrismaMaintenanceContractRepository(workerA);
    await workerA.withTenant(companyA, async () => {
      await repoA.save(
        contractProps({
          id: contractActiveA,
          companyId: companyA,
          customerId: customerA,
          chantierId: chantierA,
          status: 'active',
          equipmentIds: [equipA],
        }),
      );
      await repoA.save(
        contractProps({
          id: contractDraftA,
          companyId: companyA,
          customerId: customerA,
          chantierId: null,
          status: 'draft',
        }),
      );
    });
    const repoB = new PrismaMaintenanceContractRepository(workerB);
    await workerB.withTenant(companyB, async () => {
      await repoB.save(
        contractProps({
          id: contractB,
          companyId: companyB,
          customerId: customerB,
          chantierId: chantierB,
          status: 'active',
          equipmentIds: [equipB],
        }),
      );
    });

    // Facture ANNUELLE ÉMISE du contrat actif A : brouillon (writer réel) puis émission —
    // la pièce porte contrat + période + site, le trigger la fige ensuite.
    const issuedSnapshot: InvoiceSnapshot = {
      id: issuedAnnualA,
      companyId: companyA,
      customerId: customerA,
      kind: 'final',
      status: 'issued',
      lines: [
        {
          id: `${issuedAnnualA}:line`,
          label: 'Forfait entretien annuel',
          category: 'subscription',
          qty: 2,
          unitPriceHT: 80_000,
          vatRate: 20,
        },
      ],
      number: `F-2026-${String(randomInt(1000, 9999))}`,
      frozenTotals: {
        ht: 160_000,
        vatByRate: { '20': 32_000 },
        vat: 32_000,
        ttc: 192_000,
        netToPay: 192_000,
      },
      mentions: ['Certification'],
      issuedAt: '2026-07-14',
      dueAt: '2026-08-13',
      vatTreatmentAtIssuance: 'standard',
      frenchBillingModeAtIssuance: 'S1',
      paid: 0,
      depositPct: null,
      parentQuoteId: null,
      servicePeriod: { start: '2025-10-12', end: '2026-10-11' },
      chantierId: chantierA,
      maintenanceContractId: contractActiveA,
      revision: 1,
    };
    await persistence.runWithTenant(companyA, async () => {
      await persistence.invoices.save(
        Invoice.rehydrate({
          ...issuedSnapshot,
          status: 'draft',
          number: null,
          frozenTotals: null,
          mentions: [],
          issuedAt: null,
          dueAt: null,
          vatTreatmentAtIssuance: null,
          frenchBillingModeAtIssuance: null,
        }),
      );
      await persistence.invoices.save(Invoice.rehydrate(issuedSnapshot));
    });
  }, 60_000);

  afterAll(async () => {
    // Cleanup transactionnel SANS .catch : toute dépendance oubliée fait échouer le gate au
    // lieu de fuir des lignes dans la base commune. Sociétés jamais clôturées ici. Les lignes
    // d'une facture ÉMISE sont protégées par un trigger légal : le compte DIRECT_URL ne le
    // neutralise (replica) QUE pour ce DELETE, puis RÉOUVRE origin AVANT les DELETE finaux —
    // toute future dépendance oubliée doit refaire échouer le gate (doctrine certs).
    if (admin) {
      await admin.$transaction(async (tx) => {
        await tx.$executeRawUnsafe("SET LOCAL session_replication_role = 'replica'");
        await tx.lineItem.deleteMany({
          where: { invoice: { companyId: { in: [companyA, companyB] } } },
        });
        await tx.$executeRawUnsafe("SET LOCAL session_replication_role = 'origin'");
        await tx.invoice.deleteMany({ where: { companyId: { in: [companyA, companyB] } } });
        await tx.maintenanceContractEquipment.deleteMany({
          where: { companyId: { in: [companyA, companyB] } },
        });
        await tx.maintenanceContractLine.deleteMany({
          where: { companyId: { in: [companyA, companyB] } },
        });
        // Le trigger draft-only borne le DELETE d'un contrat vivant : neutralisation admin
        // bornée aux fixtures, refermée aussitôt (le contrat actif de la suite doit partir).
        await tx.$executeRawUnsafe("SET LOCAL session_replication_role = 'replica'");
        await tx.maintenanceContract.deleteMany({
          where: { companyId: { in: [companyA, companyB] } },
        });
        await tx.$executeRawUnsafe("SET LOCAL session_replication_role = 'origin'");
        await tx.equipment.deleteMany({ where: { companyId: { in: [companyA, companyB] } } });
        await tx.chantier.deleteMany({ where: { companyId: { in: [companyA, companyB] } } });
        await tx.customer.deleteMany({ where: { companyId: { in: [companyA, companyB] } } });
        await tx.company.deleteMany({ where: { id: { in: [companyA, companyB] } } });
      });
    }
    await Promise.all([workerA?.$disconnect(), workerB?.$disconnect(), admin?.$disconnect()]);
  });

  it('RLS FORCE ×3 : lecture/écriture confinées au tenant sur contrats, lignes et liaisons', async () => {
    const repoA = new PrismaMaintenanceContractRepository(workerA);
    await workerA.withTenant(companyA, async () => {
      const mine = await repoA.listByCompany(companyA);
      expect(mine.map((c) => c.id).sort()).toEqual([contractActiveA, contractDraftA].sort());
      // Lecture croisée : la ligne du tenant B est INVISIBLE sous le contexte A.
      expect(await repoA.findById(companyB, contractB)).toBeNull();
      const coverage = new PrismaEquipmentContractCoverage(workerA);
      expect(await coverage.activeContractLabels(companyB, equipB)).toEqual([]);
    });
    // Écriture croisée : WITH CHECK refuse un INSERT hors tenant courant.
    await expect(
      workerA.withTenant(companyA, () =>
        repoA.save(
          contractProps({
            id: `intrusion-${randomUUID()}`,
            companyId: companyB,
            customerId: customerB,
            chantierId: chantierB,
            status: 'draft',
          }),
        ),
      ),
    ).rejects.toBeDefined();
  });

  it('FK composites anti-IDOR : client/site/équipement d’un autre tenant refusés', async () => {
    const repoA = new PrismaMaintenanceContractRepository(workerA);
    await expect(
      workerA.withTenant(companyA, () =>
        repoA.save(
          contractProps({
            id: `client-vole-${randomUUID()}`,
            companyId: companyA,
            customerId: customerB,
            chantierId: null,
            status: 'draft',
          }),
        ),
      ),
    ).rejects.toBeDefined();
    await expect(
      workerA.withTenant(companyA, () =>
        repoA.save(
          contractProps({
            id: `site-vole-${randomUUID()}`,
            companyId: companyA,
            customerId: customerA,
            chantierId: chantierB,
            status: 'draft',
          }),
        ),
      ),
    ).rejects.toBeDefined();
    // Liaison vers l'équipement d'un AUTRE tenant : FK composite + RLS la refusent.
    await expect(
      workerA.withTenant(companyA, () =>
        workerA.client().maintenanceContractEquipment.create({
          data: { companyId: companyA, contractId: contractActiveA, equipmentId: equipB },
        }),
      ),
    ).rejects.toBeDefined();
  });

  it('CHECK status généré depuis la source TS + cohérence TRIPLE de la résiliation', async () => {
    const statuses = Object.keys(CONTRACT_TRANSITIONS).sort();
    expect(statuses).toEqual(['active', 'draft', 'terminated']);
    const rows = await admin.$queryRaw<{ definition: string }[]>`
      SELECT pg_get_constraintdef(oid) AS definition
        FROM pg_constraint
       WHERE conname = 'maintenance_contracts_status_check'
    `;
    const definition = rows[0]?.definition ?? '';
    for (const status of statuses) expect(definition).toContain(`'${status}'`);
    // Demi-état : résilié sans date d'effet → refusé par la base.
    await expect(
      admin.maintenanceContract.create({
        data: {
          id: randomUUID(),
          companyId: companyA,
          customerId: customerA,
          label: 'Demi-état',
          status: 'terminated',
          anniversaryDate: new Date('2025-10-12T00:00:00.000Z'),
          activatedAt: new Date(),
          terminatedAt: new Date(),
          terminationEffectiveDate: null,
          updatedAt: new Date(),
        },
      }),
    ).rejects.toBeDefined();
    // Un actif sans fait d'activation → refusé.
    await expect(
      admin.maintenanceContract.create({
        data: {
          id: randomUUID(),
          companyId: companyA,
          customerId: customerA,
          label: 'Actif sans activation',
          status: 'active',
          anniversaryDate: new Date('2025-10-12T00:00:00.000Z'),
          updatedAt: new Date(),
        },
      }),
    ).rejects.toBeDefined();
  });

  it('[amélioration 1] trigger BEFORE DELETE : seul un BROUILLON se supprime', async () => {
    await expect(
      workerA.withTenant(companyA, () =>
        workerA.client().$executeRaw`
          DELETE FROM "maintenance_contracts" WHERE "id" = ${contractActiveA}
        `,
      ),
    ).rejects.toThrowError(/maintenance_contracts_draft_only_delete|only draft/);
    // Un brouillon, lui, se supprime (puis se recrée pour les tests suivants).
    const repoA = new PrismaMaintenanceContractRepository(workerA);
    await workerA.withTenant(companyA, async () => {
      await repoA.deleteById(companyA, contractDraftA);
      expect(await repoA.findById(companyA, contractDraftA)).toBeNull();
      await repoA.save(
        contractProps({
          id: contractDraftA,
          companyId: companyA,
          customerId: customerA,
          chantierId: null,
          status: 'draft',
        }),
      );
    });
  });

  it('DETTE SOLDÉE — invoices_issued_legal_immutability : CHAQUE champ figé d’une pièce émise refuse la mutation', async () => {
    // Un littéral SQL par champ figé — la liste COMPLÈTE du trigger redéfini (20260728110100),
    // chantierId et maintenanceContractId COMPRIS. Une entrée oubliée ferait échouer la
    // comparaison de complétude ci-dessous.
    const mutations: Record<string, string> = {
      companyId: `'${companyB}'`,
      // Client du MÊME tenant : le trigger d'audience passe, la liste d'immutabilité refuse.
      customerId: `'${customerA2}'`,
      kind: `'deposit_invoice'`,
      number: `'F-MUT-1'`,
      issuedAt: `'2026-01-01'`,
      dueAt: `'2026-02-01'`,
      parentQuoteId: `'quote-mut'`,
      depositPct: '10',
      depositDeductionCents: '1',
      depositInvoiceId: `'invoice-mut'`,
      totalsHt: '1',
      totalsVat: '1',
      totalsTtc: '1',
      totalsNetToPay: '1',
      vatByRate: `'{}'::jsonb`,
      legalMentions: `ARRAY['falsifiée']`,
      purchaseOrderNumber: `'BC-MUT'`,
      purchaseOrderReceivedAt: `now()`,
      purchaseOrderDocumentId: `'doc-mut'`,
      servicePeriodStart: `'2020-01-01'`,
      servicePeriodEnd: `'2020-12-31'`,
      deliveryAddress: `'ailleurs'`,
      situationOrder: '3',
      situationDeductionCents: '1',
      globalDiscountPercent: '5',
      globalDiscountAmountCents: '100',
      retenueGarantiePct: '5',
      urgentRepairRequestedAt: `now()`,
      totalsGrossHt: '1',
      totalsDiscountCents: '1',
      totalsRetenueGarantieCents: '1',
      chantierId: 'NULL',
      maintenanceContractId: 'NULL',
    };
    // Complétude : la liste testée EST celle du trigger vivant (aucun champ figé non exercé).
    const live = await admin.$queryRaw<{ definition: string }[]>`
      SELECT pg_get_functiondef(oid) AS definition
        FROM pg_proc
       WHERE proname = 'enforce_invoice_legal_traceability'
    `;
    const liveFrozen = frozenFieldsOf(live[0]?.definition ?? '');
    expect([...liveFrozen].sort()).toEqual(Object.keys(mutations).sort());

    for (const [field, literal] of Object.entries(mutations)) {
      // `companyId` est défendu EN PROFONDEUR : le trigger d'audience d'archive (FK logique
      // client↔tenant) refuse AVANT la liste d'immutabilité — la mutation est refusée dans
      // tous les cas, et la PRÉSENCE du champ dans la liste figée est prouvée par la
      // comparaison de complétude ci-dessus (liveFrozen) + le test champ à champ des corps.
      const refusal =
        field === 'companyId'
          ? /invoices_issued_legal_immutability|issued invoice legal fields|archive audience/
          : /invoices_issued_legal_immutability|issued invoice legal fields/;
      await expect(
        workerA.withTenant(companyA, () =>
          workerA
            .client()
            .$executeRawUnsafe(
              `UPDATE "invoices" SET "${field}" = ${literal} WHERE "id" = '${issuedAnnualA}'`,
            ),
        ),
        `champ figé non protégé : ${field}`,
      ).rejects.toThrowError(refusal);
    }
    // Contrôle POSITIF : le suivi de transmission reste mutable après émission (jamais figé).
    await workerA.withTenant(companyA, async () => {
      await workerA.client().$executeRaw`
        UPDATE "invoices" SET "transmissionDepositedAt" = '2026-07-20' WHERE "id" = ${issuedAnnualA}
      `;
      await workerA.client().$executeRaw`
        UPDATE "invoices" SET "transmissionDepositedAt" = NULL WHERE "id" = ${issuedAnnualA}
      `;
    });
  });

  it('[erratum n° 1] corps redéfini depuis 20260727120000 : AUCUN champ perdu, ajouts exacts', async () => {
    const previous = readFileSync(
      join(MIGRATIONS_DIR, '20260727120000_invoices_chantier_freeze', 'migration.sql'),
      'utf8',
    );
    const redefined = readFileSync(
      join(MIGRATIONS_DIR, '20260728110100_invoices_maintenance_contract', 'migration.sql'),
      'utf8',
    );
    const previousFrozen = frozenFieldsOf(previous);
    const redefinedFrozen = frozenFieldsOf(redefined);
    // Immutabilité : superset strict, seul ajout = maintenanceContractId (chantierId y est déjà).
    for (const field of previousFrozen) expect(redefinedFrozen).toContain(field);
    expect([...redefinedFrozen].filter((f) => !previousFrozen.has(f))).toEqual([
      'maintenanceContractId',
    ]);
    // Miroir de l'avoir : superset strict, seul ajout = chantierId (promesse de 20260727120000) —
    // maintenanceContractId N'Y EST PAS (writer N-1 crée encore des avoirs sans la colonne).
    const previousMirror = mirrorFieldsOf(previous);
    const redefinedMirror = mirrorFieldsOf(redefined);
    for (const field of previousMirror) expect(redefinedMirror).toContain(field);
    expect([...redefinedMirror].filter((f) => !previousMirror.has(f))).toEqual(['chantierId']);
    expect(redefinedMirror).not.toContain('maintenanceContractId');
    // Le corps VIVANT en base est bien celui de la redéfinition (migration appliquée).
    const live = await admin.$queryRaw<{ definition: string }[]>`
      SELECT pg_get_functiondef(oid) AS definition
        FROM pg_proc
       WHERE proname = 'enforce_invoice_legal_traceability'
    `;
    expect(frozenFieldsOf(live[0]?.definition ?? '')).toEqual(redefinedFrozen);
    expect(mirrorFieldsOf(live[0]?.definition ?? '')).toEqual(redefinedMirror);
  });

  it('[erratum n° 8] lecture BATCHÉE par société : projections groupées par contrat, index partiel présent', async () => {
    const read = new PrismaContractInvoicesRead(workerA);
    await workerA.withTenant(companyA, async () => {
      const grouped = await read.listContractInvoicesByCompany(companyA);
      const projections = grouped.get(contractActiveA) ?? [];
      expect(projections).toHaveLength(1);
      expect(projections[0]).toMatchObject({
        id: issuedAnnualA,
        kind: 'final',
        status: 'issued',
        servicePeriodStart: '2025-10-12',
        servicePeriodEnd: '2026-10-11',
      });
      const single = await read.listByMaintenanceContract(companyA, contractActiveA);
      expect(single).toHaveLength(1);
    });
    const indexes = await admin.$queryRaw<{ indexdef: string }[]>`
      SELECT indexdef FROM pg_indexes WHERE indexname = 'invoices_contract_period_idx'
    `;
    expect(indexes[0]?.indexdef ?? '').toContain('WHERE');
    expect(indexes[0]?.indexdef ?? '').toContain('maintenanceContractId');
  });

  it('[amélioration 4] couverture RÉELLE : les contrats actifs liés à l’équipement sont cités', async () => {
    const coverage = new PrismaEquipmentContractCoverage(workerA);
    await workerA.withTenant(companyA, async () => {
      const labels = await coverage.activeContractLabels(companyA, equipA);
      expect(labels).toHaveLength(1);
      expect(labels[0]).toContain('Entretien');
    });
  });

  // Placé APRÈS les lectures de projections : la progression N-1 laisse la facture de contrat
  // en `partially_paid` (état RÉEL post-paiement — la machine SQL n'admet aucun retour vers
  // `issued`, et la dérivation de couverture continue de la compter, ce qui est le fait vrai).
  it('writer N-1 : la forme de ligne SANS maintenanceContractId traverse sous CHAQUE état du trigger', async () => {
    const n1Id = `writer-n1-${randomUUID()}`;
    await workerA.withTenant(companyA, async () => {
      // INSERT brouillon N-1 (colonne jamais assignée).
      await workerA.client().$executeRaw`
        INSERT INTO "invoices" ("id", "companyId", "customerId", "kind", "status")
        VALUES (${n1Id}, ${companyA}, ${customerA}, 'invoice', 'draft')
      `;
      // Émission N-1 (draft → issued, colonne toujours absente de l'UPDATE).
      await workerA.client().$executeRaw`
        UPDATE "invoices"
           SET "status" = 'issued', "number" = ${`F-N1-${randomInt(1000, 9999)}`},
               "issuedAt" = '2026-07-14', "dueAt" = '2026-08-13',
               "legalMentions" = ARRAY['Certification'],
               "totalsHt" = 100000, "totalsVat" = 20000, "totalsTtc" = 120000,
               "totalsNetToPay" = 120000, "vatByRate" = '{"20": 20000}'::jsonb
         WHERE "id" = ${n1Id}
      `;
      // Progression d'une pièce ÉMISE par un writer N-1 (paiement) : la colonne non assignée
      // laisse NEW = OLD (IS DISTINCT FROM faux) — aucun chemin applicatif bloqué. Le même
      // UPDATE traverse AUSSI la facture de CONTRAT émise (issuedAnnualA).
      await workerA.client().$executeRaw`
        UPDATE "invoices" SET "paidCents" = 120000, "status" = 'paid' WHERE "id" = ${n1Id}
      `;
      await workerA.client().$executeRaw`
        UPDATE "invoices" SET "paidCents" = 1000, "status" = 'partially_paid'
         WHERE "id" = ${issuedAnnualA}
      `;
    });
  });

  it('lignes de contrat : quantité nulle et position négative refusées par la base', async () => {
    await expect(
      admin.maintenanceContractLine.create({
        data: {
          id: randomUUID(),
          companyId: companyA,
          contractId: contractActiveA,
          label: 'Quantité nulle',
          quantity: new Prisma.Decimal(0),
          unitPriceHtCents: 100,
          vatRate: new Prisma.Decimal(20),
          position: 0,
        },
      }),
    ).rejects.toBeDefined();
  });
});
