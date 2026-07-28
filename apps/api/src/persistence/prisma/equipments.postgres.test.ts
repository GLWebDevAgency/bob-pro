import { randomInt, randomUUID } from 'node:crypto';
import { PrismaClient } from '@prisma/client';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { EQUIPMENT_TRANSITIONS, Equipment } from '@bob/core';
import { PrismaEquipmentRepository } from './equipments.repository';
import { PrismaService } from './prisma.service';

const RUN_POSTGRES_CERT = process.env.RUN_POSTGRES_EQUIPMENT_CERT === 'true';

/**
 * PR-11b — certification PostgreSQL du parc d'équipements :
 *  • RLS ENABLE+FORCE + tenant_isolation (lecture ET écriture confinées au tenant) ;
 *  • FK composite (chantierId, companyId) anti-IDOR ;
 *  • CHECK status GÉNÉRÉ depuis la source TS (garde anti-drift EQUIPMENT_TRANSITIONS) ;
 *  • cohérence TRIPLE statut/retiredAt (revue P11) ;
 *  • trigger equipment_scope_coherence (note/photo taguée = équipement du MÊME site) ;
 *  • writer N-1 : la forme de ligne SANS equipmentId traverse intacte (notes ET photos).
 * Doctrine certs (leçon 28/07) : AUCUN .catch avaleur dans l'afterAll (échec VISIBLE),
 * SIREN aléatoires dédiés à la suite, sociétés jamais clôturées (DELETE direct légitime).
 */
describe.skipIf(!RUN_POSTGRES_CERT)('Équipements — certification PostgreSQL tenantée', () => {
  const companyA = `equipment-cert-a-${randomUUID()}`;
  const companyB = `equipment-cert-b-${randomUUID()}`;
  const chantierA = `equipment-chantier-a-${randomUUID()}`;
  const chantierA2 = `equipment-chantier-a2-${randomUUID()}`;
  const chantierB = `equipment-chantier-b-${randomUUID()}`;
  const equipA = randomUUID();
  const equipA2 = randomUUID();
  const equipB = randomUUID();
  const sirenA = String(randomInt(100_000_000, 899_999_999));
  const sirenB = String(randomInt(100_000_000, 899_999_999));
  const runtimeUrl = process.env.DATABASE_URL ?? '';
  const directUrl = process.env.DIRECT_URL ?? '';

  let admin: PrismaClient;
  let workerA: PrismaService;
  let workerB: PrismaService;

  function company(id: string, siren: string) {
    return {
      id,
      name: `Certification ${id}`,
      legalForm: 'EI' as const,
      siren,
      siret: `${siren}00001`,
      trade: 'autre',
      vatRegime: 'reel_normal' as const,
      addrLine1: '1 rue de la Certification',
      addrZip: '75001',
      addrCity: 'Paris',
    };
  }

  function chantier(id: string, companyId: string) {
    return {
      id,
      companyId,
      name: `Site ${id}`,
      status: 'open' as const,
      openedAt: new Date('2026-07-01T00:00:00.000Z'),
      updatedAt: new Date('2026-07-01T00:00:00.000Z'),
    };
  }

  function equipment(id: string, companyId: string, chantierId: string, label: string): Equipment {
    return Equipment.rehydrate({
      id,
      companyId,
      chantierId,
      label,
      kind: 'Fontaine réseau',
      brand: 'Culligan',
      serialNumber: null,
      location: null,
      installedAt: '2024-03-12',
      warrantyUntil: '2027-03-12',
      status: 'active',
      retiredAt: null,
      notes: null,
      revision: 1,
    });
  }

  beforeAll(async () => {
    if (!runtimeUrl || !directUrl) {
      throw new Error('DATABASE_URL (rôle runtime) et DIRECT_URL (admin) sont requis.');
    }
    admin = new PrismaClient({ datasourceUrl: directUrl });
    workerA = new PrismaService({ datasourceUrl: runtimeUrl });
    workerB = new PrismaService({ datasourceUrl: runtimeUrl });
    await Promise.all([admin.$connect(), workerA.$connect(), workerB.$connect()]);
    await admin.company.createMany({ data: [company(companyA, sirenA), company(companyB, sirenB)] });
    await admin.chantier.createMany({
      data: [chantier(chantierA, companyA), chantier(chantierA2, companyA), chantier(chantierB, companyB)],
    });
  }, 30_000);

  afterAll(async () => {
    // Cleanup transactionnel SANS .catch : toute dépendance oubliée fait échouer le gate au
    // lieu de fuir des sociétés dans la base commune (leçon 28/07). Les sociétés de cette
    // suite ne sont jamais clôturées : aucun contournement replica n'est nécessaire.
    if (admin) {
      await admin.$transaction([
        admin.chantierNote.deleteMany({ where: { companyId: { in: [companyA, companyB] } } }),
        admin.chantierPhoto.deleteMany({ where: { companyId: { in: [companyA, companyB] } } }),
        admin.equipment.deleteMany({ where: { companyId: { in: [companyA, companyB] } } }),
        admin.chantier.deleteMany({ where: { companyId: { in: [companyA, companyB] } } }),
        admin.company.deleteMany({ where: { id: { in: [companyA, companyB] } } }),
      ]);
    }
    await Promise.all([workerA.$disconnect(), workerB.$disconnect(), admin?.$disconnect()]);
  });

  it('isole lecture/écriture par tenant (RLS FORCE) et sert les listes par site', async () => {
    const repoA = new PrismaEquipmentRepository(workerA);
    const repoB = new PrismaEquipmentRepository(workerB);
    await workerA.withTenant(companyA, async () => {
      await repoA.save(equipment(equipA, companyA, chantierA, 'Fontaine accueil R+2'));
      await repoA.save(equipment(equipA2, companyA, chantierA2, 'PAC toiture'));
    });
    await workerB.withTenant(companyB, async () => {
      await repoB.save(equipment(equipB, companyB, chantierB, 'Vitrine froide'));
    });

    await workerA.withTenant(companyA, async () => {
      expect((await repoA.listByChantier(companyA, chantierA)).map((e) => e.id)).toEqual([equipA]);
      expect((await repoA.listByCompany(companyA)).map((e) => e.id).sort()).toEqual(
        [equipA, equipA2].sort(),
      );
      // Lecture croisée : la ligne du tenant B est INVISIBLE sous le contexte A.
      expect(await repoA.findById(companyB, equipB)).toBeNull();
      expect(await repoA.listByCompany(companyB)).toEqual([]);
    });
  });

  it('écriture croisée refusée : la policy WITH CHECK bloque un INSERT hors tenant courant', async () => {
    const repoA = new PrismaEquipmentRepository(workerA);
    await expect(
      workerA.withTenant(companyA, () =>
        repoA.save(equipment(randomUUID(), companyB, chantierB, 'Intrusion')),
      ),
    ).rejects.toBeDefined();
  });

  it('FK composite anti-IDOR : un équipement ne référence jamais le site d’un autre tenant', async () => {
    const repoA = new PrismaEquipmentRepository(workerA);
    await expect(
      workerA.withTenant(companyA, () =>
        repoA.save(equipment(randomUUID(), companyA, chantierB, 'Site volé')),
      ),
    ).rejects.toBeDefined();
  });

  it('CHECK status généré depuis la source TS — garde anti-drift EQUIPMENT_TRANSITIONS', async () => {
    const statuses = Object.keys(EQUIPMENT_TRANSITIONS).sort();
    expect(statuses).toEqual(['active', 'retired']);
    const rows = await admin.$queryRaw<{ definition: string }[]>`
      SELECT pg_get_constraintdef(oid) AS definition
        FROM pg_constraint
       WHERE conname = 'equipments_status_check'
    `;
    const definition = rows[0]?.definition ?? '';
    for (const status of statuses) expect(definition).toContain(`'${status}'`);
    // Un statut hors union TS est refusé par la base.
    await expect(
      admin.equipment.create({
        data: {
          id: randomUUID(),
          companyId: companyA,
          chantierId: chantierA,
          label: 'Statut inconnu',
          status: 'broken',
          updatedAt: new Date(),
        },
      }),
    ).rejects.toBeDefined();
  });

  it('cohérence TRIPLE statut/retiredAt (revue P11) : jamais un demi-état', async () => {
    await expect(
      admin.equipment.create({
        data: {
          id: randomUUID(),
          companyId: companyA,
          chantierId: chantierA,
          label: 'Retirée sans fait',
          status: 'retired',
          retiredAt: null,
          updatedAt: new Date(),
        },
      }),
    ).rejects.toBeDefined();
    await expect(
      admin.equipment.create({
        data: {
          id: randomUUID(),
          companyId: companyA,
          chantierId: chantierA,
          label: 'Fait sans retrait',
          status: 'active',
          retiredAt: new Date(),
          updatedAt: new Date(),
        },
      }),
    ).rejects.toBeDefined();
  });

  it('trigger equipment_scope_coherence : la note taguée vise un équipement du MÊME site', async () => {
    // Même site : accepté.
    await workerA.withTenant(companyA, async () => {
      await workerA.client().chantierNote.create({
        data: {
          id: randomUUID(),
          companyId: companyA,
          chantierId: chantierA,
          text: 'Détartrage complet',
          authorLabel: 'Fly Services',
          equipmentId: equipA,
        },
      });
    });
    // Équipement d'un AUTRE site du même tenant : refusé par le trigger.
    await expect(
      workerA.withTenant(companyA, () =>
        workerA.client().chantierNote.create({
          data: {
            id: randomUUID(),
            companyId: companyA,
            chantierId: chantierA,
            text: 'Note égarée',
            authorLabel: 'Fly Services',
            equipmentId: equipA2,
          },
        }),
      ),
    ).rejects.toThrowError(/EQUIPMENT_SCOPE_CHANTIER_MISMATCH/);
    // Photo taguée vers l'équipement d'un autre TENANT : FK composite + RLS la refusent.
    await expect(
      workerA.withTenant(companyA, () =>
        workerA.client().chantierPhoto.create({
          data: {
            id: randomUUID(),
            companyId: companyA,
            chantierId: chantierA,
            filename: 'intrusion.jpg',
            mimeType: 'image/jpeg',
            byteSize: 1000,
            storageKey: `cert/${randomUUID()}.jpg`,
            equipmentId: equipB,
          },
        }),
      ),
    ).rejects.toBeDefined();
  });

  it('writer N-1 : la forme de ligne SANS equipmentId traverse intacte sous le trigger', async () => {
    await workerA.withTenant(companyA, async () => {
      // Forme N-1 exacte des notes (aucune colonne equipmentId fournie).
      await workerA.client().chantierNote.create({
        data: {
          id: randomUUID(),
          companyId: companyA,
          chantierId: chantierA,
          text: 'Note historique sans tag',
          authorLabel: 'Fly Services',
        },
      });
      // Forme N-1 exacte des photos.
      await workerA.client().chantierPhoto.create({
        data: {
          id: randomUUID(),
          companyId: companyA,
          chantierId: chantierA,
          filename: 'photo-n1.jpg',
          mimeType: 'image/jpeg',
          byteSize: 1000,
          storageKey: `cert/${randomUUID()}.jpg`,
        },
      });
    });
  });

  it('retrait logique persisté par le repository (CAS de révision au niveau agrégat)', async () => {
    const repoA = new PrismaEquipmentRepository(workerA);
    await workerA.withTenant(companyA, async () => {
      const loaded = await repoA.lockById(companyA, equipA);
      expect(loaded).not.toBeNull();
      const retired = loaded!.retire('2026-07-28T09:00:00.000Z');
      expect(retired.ok).toBe(true);
      await repoA.save(loaded!);
      const reloaded = await repoA.findById(companyA, equipA);
      expect(reloaded?.status).toBe('retired');
      expect(reloaded?.retiredAt).toBe('2026-07-28T09:00:00.000Z');
      expect(reloaded?.revision).toBe(2);
    });
  });
});
