import { randomInt, randomUUID } from 'node:crypto';
import { PrismaClient, type Prisma } from '@prisma/client';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { INTERVENTION_TRANSITIONS, Intervention, type InterventionProps } from '@bob/core';
import { PrismaInterventionRepository } from './interventions.repository';
import { PrismaService } from './prisma.service';

const RUN_POSTGRES_CERT = process.env.RUN_POSTGRES_INTERVENTION_CERT === 'true';

/**
 * PR-15b — certification PostgreSQL de la fiche de passage :
 *  • RLS ENABLE+FORCE + tenant_isolation (lecture ET écriture confinées au tenant) ;
 *  • FK composites (chantierId/customerId/equipmentId, companyId) anti-IDOR ;
 *  • CHECK status GÉNÉRÉ depuis la source TS (garde anti-drift INTERVENTION_TRANSITIONS) ;
 *  • cohérence statut ↔ faits + TRIPLE signature (signed ⟺ preuve) ;
 *  • [P15] format uuid v4 STRICT de l'id client + collision de PK = `id_collision` (jamais un
 *    oracle d'existence inter-tenant) ;
 *  • trigger intervention_scope_coherence (trace taguée = fiche du MÊME site) et VERROU
 *    post-signature en base (insertion ET retrait refusés sur une fiche `signed`) ;
 *  • ERRATUM 6 : sur une fiche `completed`, la note de résolution est ACCEPTÉE côté serveur,
 *    puis le passage à `signed` réussit — la séquence terrain n'est jamais bloquée ;
 *  • [finding 6] trigger intervention_photo_phase_coherence : la phase avant/après suit la
 *    MACHINE À ÉTATS (« avant » jamais après la complétion, « après » jamais avant le
 *    démarrage), en insertion comme en re-étiquetage, la photo SANS phase restant acceptée ;
 *  • writer N-1 : la forme de ligne SANS interventionId/phase traverse intacte (notes ET photos).
 * Doctrine certs (leçon 28/07) : AUCUN .catch avaleur dans l'afterAll (échec VISIBLE),
 * SIREN aléatoires DÉDIÉS à la suite, sociétés jamais clôturées (DELETE direct légitime).
 *
 * LEÇON 29/07 (gate staging rouge, run 30424163601) : une erreur PostgreSQL ATTENDUE avorte sa
 * transaction et laisse la session inutilisable jusqu'à la fin du bloc — en connexion directe
 * comme derrière le pooler, toute commande suivante reçoit `25P02 current transaction is aborted`
 * sans jamais atteindre la règle qu'elle prétend prouver — donc UNE unité de travail par erreur
 * attendue (`expectRefused`) et `errorFormat: 'minimal'` sur tous les clients.
 */
describe.skipIf(!RUN_POSTGRES_CERT)('Fiches de passage — certification PostgreSQL tenantée', () => {
  const companyA = `intervention-cert-a-${randomUUID()}`;
  const companyB = `intervention-cert-b-${randomUUID()}`;
  const chantierA = `intervention-chantier-a-${randomUUID()}`;
  const chantierA2 = `intervention-chantier-a2-${randomUUID()}`;
  const chantierB = `intervention-chantier-b-${randomUUID()}`;
  const customerA = `intervention-customer-a-${randomUUID()}`;
  const customerB = `intervention-customer-b-${randomUUID()}`;
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

  function customer(id: string, companyId: string) {
    return {
      id,
      companyId,
      type: 'b2b' as const,
      name: `Client ${id}`,
      addrLine1: '2 rue du Client',
      addrZip: '75002',
      addrCity: 'Paris',
    };
  }

  function intervention(
    id: string,
    companyId: string,
    chantierId: string,
    customerId: string,
    overrides: Partial<InterventionProps> = {},
  ): Intervention {
    return Intervention.rehydrate({
      id,
      companyId,
      chantierId,
      customerId,
      contractId: null,
      equipmentId: null,
      kind: 'Visite d’entretien',
      status: 'scheduled',
      plannedAt: '2026-08-04T07:00:00.000Z',
      technicianLabel: 'Papa',
      startedAt: null,
      finishedAt: null,
      checklist: [{ label: 'Détartrage', done: false }],
      summary: null,
      signature: null,
      reportDocumentId: null,
      billedInvoiceId: null,
      revision: 1,
      ...overrides,
    });
  }

  const completedProps = {
    status: 'completed' as const,
    startedAt: '2026-08-04T07:04:00.000Z',
    finishedAt: '2026-08-04T08:12:00.000Z',
  };

  /** Passage EN COURS : l'état dans lequel la séquence terrain §3.6 enfile ses photos. */
  const inProgressProps = {
    status: 'in_progress' as const,
    startedAt: '2026-08-04T07:04:00.000Z',
  };

  /**
   * [finding 6] Séquence terrain §3.6 rejouée à l'endroit : les photos s'enfilent PENDANT le
   * passage, la complétion vient APRÈS elles (file FIFO photos → complete → sign). Les fixtures
   * qui inséraient une photo « avant » sur une fiche déjà `completed` décrivaient une séquence
   * que le terrain ne produit jamais — et que la base refuse désormais.
   */
  async function completeAfterPhotos(repo: PrismaInterventionRepository, id: string): Promise<void> {
    const loaded = await repo.findById(companyA, id);
    expect(loaded).not.toBeNull();
    expect(loaded!.complete('2026-08-04T08:12:00.000Z').ok).toBe(true);
    await repo.save(loaded!);
  }

  /**
   * UNE unité de travail par refus attendu — le seul geste autorisé pour prouver un refus ici.
   *
   * `withTenant` ouvre une transaction interactive. Le premier refus (trigger ou CHECK) avorte le
   * bloc PostgreSQL : la commande SUIVANTE ne reçoit plus la règle qu'elle vise mais
   * `25P02 current transaction is aborted, commands ignored until end of transaction block`, et
   * n'atteint jamais la base. Ouvrir une transaction PAR refus rend l'ordre des preuves
   * indifférent : une preuve ajoutée demain ne peut plus être avalée par celle qui la précède.
   *
   * `rule` est OBLIGATOIRE : un `rejects.toThrow()` nu se contenterait d'une transaction avortée
   * et cesserait silencieusement de prouver quoi que ce soit. Chaque refus nomme donc le trigger
   * ou la contrainte qui l'a produit.
   */
  async function expectRefused(
    worker: PrismaService,
    companyId: string,
    rule: RegExp,
    mutation: (tx: Prisma.TransactionClient) => Promise<unknown>,
  ): Promise<void> {
    await expect(worker.withTenant(companyId, mutation)).rejects.toThrow(rule);
  }

  beforeAll(async () => {
    if (!runtimeUrl || !directUrl) {
      throw new Error('DATABASE_URL (rôle runtime) et DIRECT_URL (admin) sont requis.');
    }
    // `errorFormat: 'minimal'` — SANS lui, Prisma préfixe chaque erreur d'un CADRE DE CODE qui
    // cite les lignes voisines de CE fichier : un `rejects.toThrow(/RÈGLE/)` peut alors matcher
    // le texte source de l'assertion PRÉCÉDENTE et rester vert sur une erreur qui n'a rien à
    // voir (c'est ce masque qui a laissé passer le verrou §3.4 en local le 29/07). Le gate tourne
    // avec NODE_ENV=production, où Prisma n'émet PAS ce cadre : cette ligne fait donc dire au
    // poste de travail exactement ce que dira la release.
    admin = new PrismaClient({ datasourceUrl: directUrl, errorFormat: 'minimal' });
    workerA = new PrismaService({ datasourceUrl: runtimeUrl, errorFormat: 'minimal' });
    workerB = new PrismaService({ datasourceUrl: runtimeUrl, errorFormat: 'minimal' });
    await Promise.all([admin.$connect(), workerA.$connect(), workerB.$connect()]);
    await admin.company.createMany({ data: [company(companyA, sirenA), company(companyB, sirenB)] });
    await admin.chantier.createMany({
      data: [chantier(chantierA, companyA), chantier(chantierA2, companyA), chantier(chantierB, companyB)],
    });
    await admin.customer.createMany({
      data: [customer(customerA, companyA), customer(customerB, companyB)],
    });
  }, 30_000);

  afterAll(async () => {
    // Cleanup transactionnel SANS .catch : toute dépendance oubliée fait échouer le gate au lieu
    // de fuir des sociétés dans la base commune (leçon 28/07).
    if (admin) {
      // Le verrou §3.4 protège les traces des fiches SIGNÉES contre tout retrait — y compris
      // celui du nettoyage. La certification lève donc explicitement la signature de SES
      // fixtures (retour à `completed`, preuve retirée : cohérence triple respectée) avant de
      // supprimer. Aucun contournement du trigger, aucun `.catch` avaleur.
      await admin.$executeRaw`
        UPDATE "interventions"
           SET "status" = 'completed', "signatureProof" = NULL
         WHERE "companyId" IN (${companyA}, ${companyB})
           AND "status" = 'signed'
      `;
      await admin.$transaction([
        admin.chantierNote.deleteMany({ where: { companyId: { in: [companyA, companyB] } } }),
        admin.chantierPhoto.deleteMany({ where: { companyId: { in: [companyA, companyB] } } }),
        admin.intervention.deleteMany({ where: { companyId: { in: [companyA, companyB] } } }),
        admin.companyInterventionSettings.deleteMany({
          where: { companyId: { in: [companyA, companyB] } },
        }),
        admin.chantier.deleteMany({ where: { companyId: { in: [companyA, companyB] } } }),
        admin.customer.deleteMany({ where: { companyId: { in: [companyA, companyB] } } }),
        admin.company.deleteMany({ where: { id: { in: [companyA, companyB] } } }),
      ]);
    }
    await Promise.all([workerA.$disconnect(), workerB.$disconnect(), admin?.$disconnect()]);
  });

  it('isole lecture/écriture par tenant (RLS FORCE) et sert les listes par site', async () => {
    const id = randomUUID();
    const idB = randomUUID();
    const repoA = new PrismaInterventionRepository(workerA);
    const repoB = new PrismaInterventionRepository(workerB);
    await workerA.withTenant(companyA, async () => {
      const created = await repoA.create(intervention(id, companyA, chantierA, customerA));
      expect(created.outcome).toBe('created');
    });
    await workerB.withTenant(companyB, async () => {
      const created = await repoB.create(intervention(idB, companyB, chantierB, customerB));
      expect(created.outcome).toBe('created');
      // La fiche du tenant A est INVISIBLE : ni lecture directe, ni liste.
      expect(await repoB.findById(companyB, id)).toBeNull();
      expect((await repoB.listByCompany(companyB)).map((i) => i.id)).toEqual([idB]);
    });
    await workerA.withTenant(companyA, async () => {
      expect((await repoA.listByChantier(companyA, chantierA)).map((i) => i.id)).toEqual([id]);
      expect(await repoA.findById(companyA, idB)).toBeNull();
    });
  });

  it('collision de PK inter-tenant = id_collision (jamais un oracle d’existence)', async () => {
    const id = randomUUID();
    const repoA = new PrismaInterventionRepository(workerA);
    const repoB = new PrismaInterventionRepository(workerB);
    await workerA.withTenant(companyA, async () => {
      expect((await repoA.create(intervention(id, companyA, chantierA, customerA))).outcome).toBe(
        'created',
      );
    });
    await workerB.withTenant(companyB, async () => {
      // Le tenant B ne VOIT pas la ligne de A, mais la PK est globale : réponse générique.
      expect(await repoB.findById(companyB, id)).toBeNull();
      expect((await repoB.create(intervention(id, companyB, chantierB, customerB))).outcome).toBe(
        'id_collision',
      );
    });
  });

  it('refuse un site ou un client d’un AUTRE tenant (FK composites anti-IDOR)', async () => {
    const repoA = new PrismaInterventionRepository(workerA);
    // Deux refus = deux transactions, et chacun NOMME la FK composite qui a refusé : le second
    // ne peut plus être satisfait par la transaction que le premier a avortée.
    await expectRefused(workerA, companyA, /interventions_chantier_company_fkey/, () =>
      repoA.create(intervention(randomUUID(), companyA, chantierB, customerA)),
    );
    await expectRefused(workerA, companyA, /interventions_customer_company_fkey/, () =>
      repoA.create(intervention(randomUUID(), companyA, chantierA, customerB)),
    );
  });

  it('le CHECK status est GÉNÉRÉ depuis la source TS (garde anti-drift)', async () => {
    const rows = await admin.$queryRaw<{ definition: string }[]>`
      SELECT pg_get_constraintdef(oid) AS definition
        FROM pg_constraint
       WHERE conname = 'interventions_status_check'
    `;
    expect(rows).toHaveLength(1);
    const definition = rows[0]!.definition;
    for (const status of Object.keys(INTERVENTION_TRANSITIONS)) {
      expect(definition).toContain(`'${status}'`);
    }
    // Aucune valeur EN PLUS de la source TS ne doit vivre dans le CHECK.
    const quoted = definition.match(/'[a-z_]+'/g) ?? [];
    expect(new Set(quoted.map((value) => value.slice(1, -1)))).toEqual(
      new Set(Object.keys(INTERVENTION_TRANSITIONS)),
    );
  });

  it('refuse un id hors uuid v4 et les demi-états (chronologie, signature, statut)', async () => {
    const base = {
      companyId: companyA,
      chantierId: chantierA,
      customerId: customerA,
      kind: 'Dépannage',
      updatedAt: new Date(),
    };
    // Quatre demi-états, quatre transactions, quatre CHECK nommés : avant, les trois derniers
    // refus étaient absorbés par la transaction avortée du premier et ne prouvaient plus rien.
    await expectRefused(workerA, companyA, /interventions_id_uuid_v4_check/, (tx) =>
      tx.intervention.create({ data: { id: 'pas-un-uuid', ...base } }),
    );
    await expectRefused(workerA, companyA, /interventions_finished_coherence_check/, (tx) =>
      tx.intervention.create({ data: { id: randomUUID(), ...base, status: 'completed' } }),
    );
    await expectRefused(workerA, companyA, /interventions_chronology_check/, (tx) =>
      tx.intervention.create({
        data: {
          id: randomUUID(),
          ...base,
          status: 'in_progress',
          startedAt: new Date('2026-08-04T09:00:00.000Z'),
          finishedAt: new Date('2026-08-04T08:00:00.000Z'),
        },
      }),
    );
    await expectRefused(workerA, companyA, /interventions_signed_coherence_check/, (tx) =>
      tx.intervention.create({
        data: {
          id: randomUUID(),
          ...base,
          status: 'signed',
          startedAt: new Date('2026-08-04T07:00:00.000Z'),
          finishedAt: new Date('2026-08-04T08:00:00.000Z'),
        },
      }),
    );
  });

  it('trigger : une trace taguée vise une fiche du MÊME site (mismatch refusé)', async () => {
    const id = randomUUID();
    const repoA = new PrismaInterventionRepository(workerA);
    await workerA.withTenant(companyA, async () => {
      await repoA.create(intervention(id, companyA, chantierA, customerA));
    });
    await expectRefused(workerA, companyA, /INTERVENTION_SCOPE_CHANTIER_MISMATCH/, (tx) =>
      tx.chantierNote.create({
        data: {
          id: randomUUID(),
          companyId: companyA,
          // Note du site A2 taguée à une fiche du site A : incohérence de SITE.
          chantierId: chantierA2,
          text: 'Note incohérente',
          authorLabel: 'Certification',
          interventionId: id,
        },
      }),
    );
  });

  it('la phase avant/après EXIGE la fiche (jamais un demi-état de photo)', async () => {
    await expectRefused(workerA, companyA, /chantier_photos_phase_check/, (tx) =>
      tx.chantierPhoto.create({
        data: {
          id: randomUUID(),
          companyId: companyA,
          chantierId: chantierA,
          filename: 'orpheline.jpg',
          mimeType: 'image/jpeg',
          byteSize: 3,
          storageKey: `cert/${randomUUID()}`,
          phase: 'before',
        },
      }),
    );
  });

  /**
   * [Revue adversariale 28/07 — finding 6] La phase est une AFFIRMATION DATÉE sur une pièce de
   * preuve : la base la re-vérifie contre la machine à états, comme elle re-vérifie le verrou
   * §3.4. Chaque refus est prouvé dans SA transaction (un refus de trigger avorte la sienne).
   */
  it('[finding 6] la phase suit la MACHINE À ÉTATS : « avant » jamais après la fin, « après » jamais avant le début', async () => {
    const planifiee = randomUUID();
    const terminee = randomUUID();
    const repoA = new PrismaInterventionRepository(workerA);
    await workerA.withTenant(companyA, async () => {
      await repoA.create(intervention(planifiee, companyA, chantierA, customerA));
      await repoA.create(intervention(terminee, companyA, chantierA, customerA, completedProps));
    });

    // « après » sur une fiche encore planifiée : il n'y a aucun travail à montrer.
    await expectRefused(workerA, companyA, /INTERVENTION_PHASE_AFTER_BEFORE_START/, (tx) =>
      tx.chantierPhoto.create({
        data: {
          id: randomUUID(),
          companyId: companyA,
          chantierId: chantierA,
          filename: 'apres.jpg',
          mimeType: 'image/jpeg',
          byteSize: 3,
          storageKey: `cert/${randomUUID()}`,
          interventionId: planifiee,
          phase: 'after',
        },
      }),
    );

    // « avant » après la complétion : l'état initial n'existe plus, la photo l'affirmerait.
    await expectRefused(workerA, companyA, /INTERVENTION_PHASE_BEFORE_AFTER_COMPLETION/, (tx) =>
      tx.chantierPhoto.create({
        data: {
          id: randomUUID(),
          companyId: companyA,
          chantierId: chantierA,
          filename: 'avant.jpg',
          mimeType: 'image/jpeg',
          byteSize: 3,
          storageKey: `cert/${randomUUID()}`,
          interventionId: terminee,
          phase: 'before',
        },
      }),
    );

    // Le RE-ÉTIQUETAGE d'une photo légitime passe par la même règle (branche UPDATE).
    const photoId = randomUUID();
    await workerA.withTenant(companyA, async () => {
      await workerA.client().chantierPhoto.create({
        data: {
          id: photoId,
          companyId: companyA,
          chantierId: chantierA,
          filename: 'apres.jpg',
          mimeType: 'image/jpeg',
          byteSize: 3,
          storageKey: `cert/${randomUUID()}`,
          interventionId: terminee,
          // « après » sur une fiche terminée : la séquence terrain, acceptée.
          phase: 'after',
        },
      });
    });
    await expectRefused(
      workerA,
      companyA,
      /INTERVENTION_PHASE_BEFORE_AFTER_COMPLETION/,
      (tx) => tx.$executeRaw`
        UPDATE "chantier_photos" SET "phase" = 'before'
         WHERE "id" = ${photoId} AND "companyId" = ${companyA}
      `,
    );

    // Et la MÊME photo SANS phase reste acceptée : le refus ne perd aucune preuve.
    await workerA.withTenant(companyA, async () => {
      await workerA.client().chantierPhoto.create({
        data: {
          id: randomUUID(),
          companyId: companyA,
          chantierId: chantierA,
          filename: 'oubliee.jpg',
          mimeType: 'image/jpeg',
          byteSize: 3,
          storageKey: `cert/${randomUUID()}`,
          interventionId: terminee,
        },
      });
    });
  });

  it('ERRATUM 6 : note de résolution acceptée sur `completed`, PUIS le sign passe', async () => {
    const id = randomUUID();
    const repoA = new PrismaInterventionRepository(workerA);
    const photoId = randomUUID();
    await workerA.withTenant(companyA, async () => {
      // Photo enfilée PENDANT le passage (§3.6), complétion ensuite — l'ordre du terrain.
      await repoA.create(intervention(id, companyA, chantierA, customerA, inProgressProps));
      // La photo en échec est retirée…
      await workerA.client().chantierPhoto.create({
        data: {
          id: photoId,
          companyId: companyA,
          chantierId: chantierA,
          filename: 'avant.jpg',
          mimeType: 'image/jpeg',
          byteSize: 3,
          storageKey: `cert/${randomUUID()}`,
          interventionId: id,
          phase: 'before',
        },
      });
      await completeAfterPhotos(repoA, id);
      await workerA.client().chantierPhoto.deleteMany({ where: { id: photoId, companyId: companyA } });
      // … et la note de résolution prend sa PLACE, AVANT la signature : ACCEPTÉE.
      await workerA.client().chantierNote.create({
        data: {
          id: randomUUID(),
          companyId: companyA,
          chantierId: chantierA,
          text: '1 photo n’a pas pu être jointe à la fiche.',
          authorLabel: 'Certification',
          interventionId: id,
        },
      });
      // Le sign resté en file passe ENSUITE — la séquence terrain n'est jamais bloquée.
      const loaded = await repoA.findById(companyA, id);
      expect(loaded).not.toBeNull();
      const signed = loaded!.sign({
        signerName: 'M. Responsable',
        method: 'onsite_draw',
        sha256: 'a'.repeat(64),
        capturedAt: '2026-08-04T10:00:00.000Z',
      });
      expect(signed.ok).toBe(true);
      await repoA.save(loaded!);
      expect((await repoA.findById(companyA, id))!.status).toBe('signed');
    });
  });

  it('VERROU post-signature en base : ni ajout, ni retrait de trace sur une fiche signée', async () => {
    const id = randomUUID();
    const repoA = new PrismaInterventionRepository(workerA);
    const photoId = randomUUID();
    await workerA.withTenant(companyA, async () => {
      await repoA.create(intervention(id, companyA, chantierA, customerA, inProgressProps));
      await workerA.client().chantierPhoto.create({
        data: {
          id: photoId,
          companyId: companyA,
          chantierId: chantierA,
          filename: 'avant.jpg',
          mimeType: 'image/jpeg',
          byteSize: 3,
          storageKey: `cert/${randomUUID()}`,
          interventionId: id,
          phase: 'before',
        },
      });
      await completeAfterPhotos(repoA, id);
      const loaded = await repoA.findById(companyA, id);
      loaded!.sign({
        signerName: 'M. Responsable',
        method: 'onsite_draw',
        sha256: 'b'.repeat(64),
        capturedAt: '2026-08-04T10:00:00.000Z',
      });
      await repoA.save(loaded!);
    });

    // TROIS refus, TROIS transactions. Enchaînés dans la transaction ci-dessus, seul le premier
    // atteignait le trigger : les deux suivants recevaient 25P02 (transaction avortée) et la
    // certification ne prouvait plus ni le refus d'une NOTE ni celui d'un RETRAIT.
    await expectRefused(workerA, companyA, /INTERVENTION_SIGNED_LOCKED/, (tx) =>
      tx.chantierPhoto.create({
        data: {
          id: randomUUID(),
          companyId: companyA,
          chantierId: chantierA,
          filename: 'apres.jpg',
          mimeType: 'image/jpeg',
          byteSize: 3,
          storageKey: `cert/${randomUUID()}`,
          interventionId: id,
          phase: 'after',
        },
      }),
    );
    await expectRefused(workerA, companyA, /INTERVENTION_SIGNED_LOCKED/, (tx) =>
      tx.chantierNote.create({
        data: {
          id: randomUUID(),
          companyId: companyA,
          chantierId: chantierA,
          text: 'Trop tard',
          authorLabel: 'Certification',
          interventionId: id,
        },
      }),
    );
    await expectRefused(workerA, companyA, /INTERVENTION_SIGNED_LOCKED/, (tx) =>
      tx.chantierPhoto.deleteMany({ where: { id: photoId, companyId: companyA } }),
    );

    // La photo d'origine est TOUJOURS là : le refus de retrait n'a rien emporté.
    await workerA.withTenant(companyA, async () => {
      const photo = await workerA.client().chantierPhoto.findFirst({ where: { id: photoId } });
      expect(photo?.interventionId).toBe(id);
    });
  });

  it('[finding 7] fiche signée : ni DÉ-TAGGAGE d’une trace, ni retrait d’une NOTE', async () => {
    const id = randomUUID();
    const repoA = new PrismaInterventionRepository(workerA);
    const photoId = randomUUID();
    const noteId = randomUUID();
    await workerA.withTenant(companyA, async () => {
      await repoA.create(intervention(id, companyA, chantierA, customerA, inProgressProps));
      await workerA.client().chantierPhoto.create({
        data: {
          id: photoId,
          companyId: companyA,
          chantierId: chantierA,
          filename: 'avant.jpg',
          mimeType: 'image/jpeg',
          byteSize: 3,
          storageKey: `cert/${randomUUID()}`,
          interventionId: id,
          phase: 'before',
        },
      });
      await workerA.client().chantierNote.create({
        data: {
          id: noteId,
          companyId: companyA,
          chantierId: chantierA,
          text: 'Trace du passage',
          authorLabel: 'Certification',
          interventionId: id,
        },
      });
      await completeAfterPhotos(repoA, id);
      const loaded = await repoA.findById(companyA, id);
      loaded!.sign({
        signerName: 'M. Responsable',
        method: 'onsite_draw',
        sha256: 'c'.repeat(64),
        capturedAt: '2026-08-04T10:00:00.000Z',
      });
      await repoA.save(loaded!);
    });

    // Refus attendu = unité de travail dédiée (voir `expectRefused`).
    // Dé-taggage : la trace SORTIRAIT de la preuve signée sans jamais être supprimée.
    await expectRefused(
      workerA,
      companyA,
      /INTERVENTION_SIGNED_LOCKED/,
      (tx) => tx.$executeRaw`
        UPDATE "chantier_photos" SET "interventionId" = NULL, "phase" = NULL
         WHERE "id" = ${photoId} AND "companyId" = ${companyA}
      `,
    );
    await expectRefused(
      workerA,
      companyA,
      /INTERVENTION_SIGNED_LOCKED/,
      (tx) => tx.$executeRaw`
        UPDATE "chantier_notes" SET "interventionId" = NULL
         WHERE "id" = ${noteId} AND "companyId" = ${companyA}
      `,
    );
    // Retrait d'une NOTE de fiche signée : refusé comme celui d'une photo.
    await expectRefused(workerA, companyA, /INTERVENTION_SIGNED_LOCKED/, (tx) =>
      tx.chantierNote.deleteMany({ where: { id: noteId, companyId: companyA } }),
    );

    // Les traces sont TOUJOURS là, toujours rattachées à la fiche signée.
    await workerA.withTenant(companyA, async () => {
      const photo = await workerA.client().chantierPhoto.findFirst({ where: { id: photoId } });
      const note = await workerA.client().chantierNote.findFirst({ where: { id: noteId } });
      expect(photo?.interventionId).toBe(id);
      expect(note?.interventionId).toBe(id);
    });
  });

  it('[finding 7] fiche NON signée : dé-taggage et retrait de note restent possibles', async () => {
    const id = randomUUID();
    const repoA = new PrismaInterventionRepository(workerA);
    const noteId = randomUUID();
    await workerA.withTenant(companyA, async () => {
      await repoA.create(intervention(id, companyA, chantierA, customerA, completedProps));
      await workerA.client().chantierNote.create({
        data: {
          id: noteId,
          companyId: companyA,
          chantierId: chantierA,
          text: 'Note du passage',
          authorLabel: 'Certification',
          interventionId: id,
        },
      });
      await workerA.client().$executeRaw`
        UPDATE "chantier_notes" SET "interventionId" = NULL
         WHERE "id" = ${noteId} AND "companyId" = ${companyA}
      `;
      const note = await workerA.client().chantierNote.findFirst({ where: { id: noteId } });
      expect(note?.interventionId).toBeNull();
      await workerA.client().chantierNote.deleteMany({ where: { id: noteId, companyId: companyA } });
    });
  });

  it('writer N-1 : notes ET photos SANS interventionId/phase traversent intactes', async () => {
    await workerA.withTenant(companyA, async () => {
      const noteId = randomUUID();
      const photoId = randomUUID();
      // Forme de ligne EXACTE d'un writer antérieur au train (aucune colonne nouvelle citée).
      await workerA.client().$executeRaw`
        INSERT INTO "chantier_notes" ("id", "companyId", "chantierId", "text", "authorLabel", "createdAt")
        VALUES (${noteId}, ${companyA}, ${chantierA}, 'Note N-1', 'Writer N-1', now())
      `;
      await workerA.client().$executeRaw`
        INSERT INTO "chantier_photos" ("id", "companyId", "chantierId", "filename", "mimeType", "byteSize", "storageKey", "createdAt")
        VALUES (${photoId}, ${companyA}, ${chantierA}, 'n1.jpg', 'image/jpeg', 3, ${`cert/${randomUUID()}`}, now())
      `;
      const note = await workerA.client().chantierNote.findFirst({ where: { id: noteId } });
      const photo = await workerA.client().chantierPhoto.findFirst({ where: { id: photoId } });
      expect(note?.interventionId).toBeNull();
      expect(photo?.interventionId).toBeNull();
      expect(photo?.phase).toBeNull();
      // Et le retrait d'une photo NON taguée reste possible (aucun verrou hérité).
      await workerA.client().chantierPhoto.deleteMany({ where: { id: photoId, companyId: companyA } });
    });
  });

  it('réglages de fiche : titre paramétrable persisté et isolé par tenant', async () => {
    await workerA.withTenant(companyA, async () => {
      await workerA.client().companyInterventionSettings.create({
        data: {
          companyId: companyA,
          reportTitle: 'Certificat sanitaire',
          checklistTemplates: { 'visite d’entretien': ['Détartrage'] },
          updatedAt: new Date(),
        },
      });
    });
    await workerB.withTenant(companyB, async () => {
      expect(
        await workerB.client().companyInterventionSettings.findFirst({ where: { companyId: companyA } }),
      ).toBeNull();
    });
    await workerA.withTenant(companyA, async () => {
      const settings = await workerA
        .client()
        .companyInterventionSettings.findFirst({ where: { companyId: companyA } });
      expect(settings?.reportTitle).toBe('Certificat sanitaire');
    });
  });
});
