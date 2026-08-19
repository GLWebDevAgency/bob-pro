/**
 * Jarvis U1-d — magasin durable des payloads de proposition (port `@bob/core`
 * `JarvisProposalPayloadStorePort`, spec Jarvis §5.1/§5.5/§9.1, SPEC_U1D §3 « MOBILE » + G4).
 *
 * Le state d'un run ne porte que des digests : le CONTENU proposé (nom, adresse, e-mail — de
 * la PII) vit dans `jarvis_proposal_payloads`, scellé par `fieldsDigest`. Ce fichier est le seul
 * endroit où ce contenu entre et sort de PostgreSQL.
 *
 * TROIS PROPRIÉTÉS, toutes prouvées côté base (jarvis-proposal-payloads.postgres.test.ts) :
 *
 *  1. ÉCRITURE UNIQUE, IDEMPOTENTE, AVANT `stage_proposal` — `INSERT … ON CONFLICT DO NOTHING` :
 *     le même tour rejoué rend `replayed` (zéro écriture), un contenu divergent sous la même
 *     clé rend `conflict` (jamais un écrasement — le digest inscrit dans le run cesserait de
 *     prouver quoi que ce soit). Écrire AVANT l'admission est ce qui garantit qu'une proposition
 *     scellée a toujours sa charge ; l'inverse (admettre puis écrire) laisserait un run qui
 *     référence du vide. Le prix — un orphelin si l'admission échoue — est payé par la rétention.
 *
 *  2. SCEAU RECALCULÉ DES DEUX CÔTÉS (greffe G4) — à l'écriture comme à la relecture, les
 *     digests sont RECALCULÉS depuis le contenu par les fonctions du domaine
 *     (`computeCustomerContactFieldsDigest` / `computeCustomerContactSensitiveDigest`, @bob/core,
 *     les mêmes qu'utilise l'admission). Un digest attendu qui ne correspond pas, un contenu
 *     illisible, une ligne altérée au repos ou une charge périmée : la relecture rend `null` —
 *     présentation indisponible, effet refusé. Jamais une approximation.
 *
 *  3. RLS ZÉRO-AMENDEMENT — chaque méthode s'exécute sous les GUC de la LIGNE CIBLE
 *     (company/owner par `withIsolatedOwner`, run par `app.current_agent_mission_id`), exactement
 *     comme `jarvis-work-items.persistence.ts`. Sans coordonnées exactes, la base ne montre ni
 *     n'écrit rien. La purge est owner-scopée elle aussi, et la policy de rétention ne lui
 *     concède le DELETE que sur des lignes déjà échues — la base reste l'autorité de
 *     l'effacement, jamais le `WHERE` de l'applicatif.
 *
 * Horloge : `statement_timestamp()` PostgreSQL pour `createdAt` et pour toute comparaison
 * d'échéance — aucune horloge ambiante ne décide qu'une PII est encore lisible.
 */
import { Prisma } from '@prisma/client';
import {
  computeCustomerContactFieldsDigest,
  computeCustomerContactSensitiveDigest,
  hasAsciiControlCharacter,
  parseCustomerContactProposedFields,
  type JarvisProposalPayloadRef,
  type JarvisProposalPayloadSealInput,
  type JarvisProposalPayloadSealResult,
  type JarvisProposalPayloadStorePort,
  type JarvisProposalPayloadV1,
} from '@bob/core';

import type { PrismaService } from './prisma.service';

const PAYLOAD_TRANSACTION_OPTIONS = {
  maxWaitMs: 5_000,
  timeoutMs: 15_000,
} as const;

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;
const SHA256_HEX = /^[0-9a-f]{64}$/u;
const MAX_IDENTIFIER_LENGTH = 200;
const MAX_PURGE_LIMIT = 500;

/** Entrée structurellement invalide = bug d'appelant, jamais un état runtime : on échoue fort. */
function assertUuid(value: string, label: string): void {
  if (!UUID.test(value)) {
    throw new Error(`Identifiant ${label} de payload Jarvis invalide : UUID canonique attendu.`);
  }
}

function assertDigest(value: string, label: string): void {
  if (!SHA256_HEX.test(value)) {
    throw new Error(`Digest ${label} de payload Jarvis invalide : sha-256 hexadécimal minuscule.`);
  }
}

function assertOwnerIdentifier(value: string, label: string): void {
  if (
    value.length < 1 ||
    value.length > MAX_IDENTIFIER_LENGTH ||
    value !== value.trim() ||
    hasAsciiControlCharacter(value)
  ) {
    throw new Error(`Identifiant ${label} de payload Jarvis invalide.`);
  }
}

function assertRef(ref: JarvisProposalPayloadRef): void {
  assertOwnerIdentifier(ref.companyId, 'de société');
  assertOwnerIdentifier(ref.ownerUserId, 'de propriétaire');
  assertUuid(ref.runId, 'de run');
  assertUuid(ref.proposalId, 'de proposition');
  assertDigest(ref.fieldsDigest, 'de champs');
}

/** Code d'erreur PostgreSQL derrière une erreur Prisma (patron realtime-control.prisma.ts). */
function postgresErrorCode(error: unknown): string | null {
  if (error instanceof Prisma.PrismaClientKnownRequestError) {
    const databaseCode = error.meta?.['code'];
    return typeof databaseCode === 'string' ? databaseCode : error.code;
  }
  if (typeof error !== 'object' || error === null) return null;
  const code = (error as { code?: unknown }).code;
  return typeof code === 'string' ? code : null;
}

/**
 * Panne de BASE (run absent via FK, policy refusée, transaction expirée, connexion perdue) —
 * seule catégorie que ce magasin traduit en refus typé. Un défaut de programmation remonte tel
 * quel : un `unavailable` qui masque un bug ferait boucler l'appelant sur une cause invisible.
 */
function isDatabaseFailure(error: unknown): boolean {
  return (
    error instanceof Prisma.PrismaClientKnownRequestError ||
    error instanceof Prisma.PrismaClientUnknownRequestError ||
    error instanceof Prisma.PrismaClientInitializationError ||
    error instanceof Prisma.PrismaClientRustPanicError ||
    postgresErrorCode(error) !== null
  );
}

interface StoredPayloadRow {
  readonly fieldsDigest: string;
  readonly sensitiveDigest: string;
  readonly payload: unknown;
}

export class PrismaJarvisProposalPayloadStore implements JarvisProposalPayloadStorePort {
  constructor(private readonly prisma: PrismaService) {}

  /**
   * GUC de la ligne cible — company/owner posés par `withIsolatedOwner`, run posé ici. Les
   * policies U1-d s'appliquent telles quelles : sans les trois, la base ne montre ni n'écrit
   * rien (option zéro-amendement, même patron que le repository de dispatch U1-c).
   */
  private withRowAuthority<T>(
    ref: JarvisProposalPayloadRef,
    readOnly: boolean,
    work: (transaction: Prisma.TransactionClient) => Promise<T>,
  ): Promise<T> {
    return this.prisma.withIsolatedOwner(
      ref.companyId,
      ref.ownerUserId,
      async (transaction) => {
        await transaction.$executeRaw`
          SELECT
            set_config('lock_timeout', '5s', true),
            set_config('statement_timeout', '10s', true),
            set_config('app.current_agent_mission_id', ${ref.runId}, true)
        `;
        return work(transaction);
      },
      { ...PAYLOAD_TRANSACTION_OPTIONS, readOnly },
    );
  }

  async sealProposalPayload(
    input: JarvisProposalPayloadSealInput,
  ): Promise<JarvisProposalPayloadSealResult> {
    assertRef(input);
    assertDigest(input.sensitiveDigest, 'sensible');
    // Le sceau est RECALCULÉ : le magasin ne fait jamais confiance au digest déclaré. Un écart
    // ici n'est pas un état runtime possible (l'admission scelle avec la même fonction du
    // domaine) — c'est un défaut d'appelant, et il doit être bruyant.
    if (computeCustomerContactFieldsDigest(input.fields) !== input.fieldsDigest) {
      throw new Error('Sceau de payload Jarvis rompu : fieldsDigest ne décrit pas son contenu.');
    }
    if (computeCustomerContactSensitiveDigest(input.fields) !== input.sensitiveDigest) {
      throw new Error('Sceau de payload Jarvis rompu : sensitiveDigest ne décrit pas son contenu.');
    }
    const retentionEpoch = Date.parse(input.retentionExpiresAt);
    if (Number.isNaN(retentionEpoch)) {
      throw new Error('Échéance de rétention de payload Jarvis invalide.');
    }
    // Normalisation UTC : le paramètre part en texte explicitement zoné, jamais dépendant du
    // fuseau de session PostgreSQL.
    const retentionExpiresAt = new Date(retentionEpoch).toISOString();
    const payloadJson = JSON.stringify(input.fields);
    try {
      return await this.withRowAuthority(input, false, async (transaction) => {
        // Insertion idempotente : le gagnant écrit, le rejoueur ne touche RIEN. La contrainte
        // CHECK `retentionExpiresAt > createdAt` refuse en base une échéance déjà échue —
        // un magasin PII ne s'écrit pas mort-né.
        const inserted = await transaction.$queryRaw<Array<{ proposalId: string }>>`
          INSERT INTO public.jarvis_proposal_payloads (
            "companyId", "runId", "proposalId", "ownerUserId",
            "fieldsDigest", "sensitiveDigest", "payload",
            "createdAt", "retentionExpiresAt"
          ) VALUES (
            ${input.companyId}, ${input.runId}::uuid, ${input.proposalId}::uuid,
            ${input.ownerUserId},
            ${input.fieldsDigest}, ${input.sensitiveDigest}, ${payloadJson}::jsonb,
            statement_timestamp(), ${retentionExpiresAt}::timestamptz
          )
          ON CONFLICT ("companyId", "runId", "proposalId") DO NOTHING
          RETURNING "proposalId"
        `;
        if (inserted.length === 1) return { status: 'sealed' as const };
        // Conflit de clé : la charge existante fait foi. Elle n'est « la même » que si son
        // CONTENU redonne le même sceau — comparer les seuls digests persistés reviendrait à
        // croire la ligne sur parole.
        const rows = await transaction.$queryRaw<StoredPayloadRow[]>`
          SELECT "fieldsDigest", "sensitiveDigest", "payload"
            FROM public.jarvis_proposal_payloads
           WHERE "companyId" = ${input.companyId}
             AND "runId" = ${input.runId}::uuid
             AND "proposalId" = ${input.proposalId}::uuid
             AND "ownerUserId" = ${input.ownerUserId}
        `;
        const existing = rows[0];
        if (existing === undefined) return { status: 'conflict' as const };
        const fields = parseCustomerContactProposedFields(existing.payload);
        if (
          fields === null ||
          computeCustomerContactFieldsDigest(fields) !== existing.fieldsDigest ||
          existing.fieldsDigest !== input.fieldsDigest ||
          existing.sensitiveDigest !== input.sensitiveDigest
        ) {
          return { status: 'conflict' as const };
        }
        return { status: 'replayed' as const };
      });
    } catch (error) {
      // Run absent (FK), GUC incohérents (policy), base indisponible : l'appelant n'admet
      // AUCUNE proposition. Fail-closed — jamais une proposition sans charge scellée.
      if (!isDatabaseFailure(error)) throw error;
      return { status: 'unavailable' };
    }
  }

  async readProposalPayload(
    ref: JarvisProposalPayloadRef,
  ): Promise<JarvisProposalPayloadV1 | null> {
    assertRef(ref);
    let row: StoredPayloadRow | undefined;
    try {
      row = await this.withRowAuthority(ref, true, async (transaction) => {
        const rows = await transaction.$queryRaw<StoredPayloadRow[]>`
          SELECT "fieldsDigest", "sensitiveDigest", "payload"
            FROM public.jarvis_proposal_payloads
           WHERE "companyId" = ${ref.companyId}
             AND "runId" = ${ref.runId}::uuid
             AND "proposalId" = ${ref.proposalId}::uuid
             AND "ownerUserId" = ${ref.ownerUserId}
             AND "retentionExpiresAt" > statement_timestamp()
        `;
        return rows[0];
      });
    } catch (error) {
      // Une charge illisible est une charge ABSENTE : l'appelant se rend indisponible, il
      // n'improvise pas une présentation ni un effet (G4). Un bug, lui, reste bruyant.
      if (!isDatabaseFailure(error)) throw error;
      return null;
    }
    if (row === undefined) return null;
    // Sceau attendu (celui du run) VS sceau persisté VS sceau recalculé : les trois doivent
    // coïncider. Deux suffisaient à détecter une dérive de la proposition ; le troisième
    // détecte une altération du contenu au repos.
    if (row.fieldsDigest !== ref.fieldsDigest) return null;
    const fields = parseCustomerContactProposedFields(row.payload);
    if (fields === null) return null;
    if (computeCustomerContactFieldsDigest(fields) !== row.fieldsDigest) return null;
    if (computeCustomerContactSensitiveDigest(fields) !== row.sensitiveDigest) return null;
    return {
      companyId: ref.companyId,
      ownerUserId: ref.ownerUserId,
      runId: ref.runId,
      proposalId: ref.proposalId,
      fieldsDigest: row.fieldsDigest,
      sensitiveDigest: row.sensitiveDigest,
      fields,
    };
  }

  /**
   * Purge de rétention (§5.5) — hors du port : les appelants métier n'effacent pas de la PII,
   * seul un balayage d'exploitation le fait (précédent `voice_traces.purgeExpired`). La
   * politique n'est PAS rejouée ici : chaque ligne porte son échéance, posée à l'écriture.
   *
   * Le balayage est OWNER-SCOPÉ comme le reste de la table : il ne voit et n'efface que les
   * charges de CE propriétaire — un GC qui verrait la PII de tous serait un privilège que rien
   * ne justifie (les coordonnées viennent d'un annuaire SERVEUR, patron du worker de dispatch).
   * Et la policy DELETE ne concède le droit d'effacer QUE sur des lignes déjà échues : une borne
   * `before` future ne supprime rien, quoi qu'en demande l'appelant — la base est l'autorité.
   */
  async purgeExpired(input: {
    readonly companyId: string;
    readonly ownerUserId: string;
    readonly before: string;
    readonly limit: number;
  }): Promise<number> {
    assertOwnerIdentifier(input.companyId, 'de société');
    assertOwnerIdentifier(input.ownerUserId, 'de propriétaire');
    const beforeEpoch = Date.parse(input.before);
    if (Number.isNaN(beforeEpoch)) {
      throw new Error('Borne de purge de payloads Jarvis invalide.');
    }
    const before = new Date(beforeEpoch).toISOString();
    const safeLimit = Math.max(1, Math.min(input.limit, MAX_PURGE_LIMIT));
    return this.prisma.withIsolatedOwner(
      input.companyId,
      input.ownerUserId,
      async (transaction) => {
        await transaction.$executeRaw`
          SELECT
            set_config('lock_timeout', '5s', true),
            set_config('statement_timeout', '10s', true)
        `;
        return transaction.$executeRaw`
          WITH expired AS (
            SELECT "companyId", "runId", "proposalId"
              FROM public.jarvis_proposal_payloads
             WHERE "companyId" = ${input.companyId}
               AND "ownerUserId" = ${input.ownerUserId}
               AND "retentionExpiresAt" <= ${before}::timestamptz
             ORDER BY "retentionExpiresAt" ASC, "runId" ASC, "proposalId" ASC
             LIMIT ${safeLimit}
          )
          DELETE FROM public.jarvis_proposal_payloads AS payload
            USING expired
           WHERE payload."companyId" = expired."companyId"
             AND payload."runId" = expired."runId"
             AND payload."proposalId" = expired."proposalId"
        `;
      },
      { ...PAYLOAD_TRANSACTION_OPTIONS, readOnly: false },
    );
  }
}
