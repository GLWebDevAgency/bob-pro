/**
 * Jarvis U1-g — LE RAPPROCHEMENT CLIENT, SOURCE UNIQUE (SPEC_U1G §2).
 *
 * POURQUOI CE MODULE EXISTE. Le prédicat de similarité, son ordre et sa projection étaient écrits
 * en clair dans `agent-mission.persistence.ts`, en trois exemplaires dont deux jumeaux ne
 * différaient QUE par leur clause de verrou. Le vertical fiche client a besoin du même
 * rapprochement, mais depuis une lecture STATELESS — et c'est là que la duplication cesse d'être
 * un défaut de style pour devenir un défaut de correction (voir ci-dessous). Une quatrième copie
 * aurait fini par diverger de celle du devis : deux Bob ne doivent pas trouver deux clients
 * différents pour la même phrase.
 *
 * LE VERROU EST LA SEULE VARIABLE, et il n'est pas négociable :
 *   · `'share'` — transaction de DÉCISION (résolution client du devis) : le candidat lu devient
 *     la cible d'une écriture DANS LA MÊME transaction, donc il doit être stable jusqu'au commit ;
 *   · `'none'`  — lecture stateless §5.2 : rien n'est décidé sur cette lecture, ET PostgreSQL
 *     REFUSE l'autre. Vérifié à l'exécution sur PostgreSQL 17 :
 *         ERROR: cannot execute SELECT FOR SHARE in a read-only transaction
 *     Or `readJarvisStateless` ouvre sa transaction en `readOnly: true`. Brancher la variante
 *     verrouillée sur la vue stateless échouerait donc EN PRODUCTION, et seulement là — aucun
 *     test en mémoire ne peut l'attraper. Le paramètre n'est pas une élégance, c'est une
 *     condition d'exécution.
 *
 * Ce module ne connaît ni tenant courant, ni GUC, ni RLS : il rend du SQL. L'identité de la
 * transaction reste posée par l'appelant, et la RLS s'applique par-dessus le filtre `companyId`
 * explicite — ceinture et bretelles, comme partout ailleurs dans ce dépôt.
 */
import { Prisma } from '@prisma/client';
import { normalizeCustomerName } from '@bob/core';

/** Borne du rapprochement, PINCÉE ICI. Un `limit` choisi par l'appelant serait une mini-autorité. */
export const CUSTOMER_CANDIDATE_SEARCH_LIMIT = 6;

export type CustomerCandidateLock = 'share' | 'none';

/**
 * LE NOM D'UNE FICHE, TEL QU'IL DOIT SORTIR DE LA BASE — source unique.
 *
 * Les lignes historiques precedent parfois la normalisation du domaine : une valeur reellement
 * invalide reste INCHANGEE, pour que le validateur du noyau echoue ferme ; seules les espaces sans
 * semantique sont reparees a la frontiere Prisma.
 *
 * POURQUOI ELLE VIT ICI, et pas dans un seul adaptateur. Elle etait privee dans
 * `agent-mission.persistence.ts`, ou quatre lectures du devis l'appliquaient — pendant que son
 * jumeau Jarvis (`readJarvisCustomerLabels`) rendait la colonne BRUTE. Deux regles de frontiere
 * pour la meme donnee, dont une seule etait exercee : le chemin Jarvis etait livre sans appelant.
 * Deux Bob ne doivent pas prononcer deux noms differents pour la meme fiche, et la seule facon de
 * le garantir est qu'il n'existe qu'une regle. Une fixture d'egalite couvre les cinq sites.
 */
export function canonicalCustomerName(value: string): string {
  return normalizeCustomerName(value) ?? value;
}


function lockClause(lock: CustomerCandidateLock, alias: string): Prisma.Sql {
  return lock === 'share' ? Prisma.raw(`FOR SHARE OF ${alias}`) : Prisma.empty;
}

/**
 * Candidats par NOM : égalité insensible aux accents et à la casse d'abord, similarité de mots
 * ensuite. L'ordre est TOTAL et déterministe (exact, score, nom en collation binaire, id) — deux
 * appels sur le même monde rendent la même page, condition de l'idempotence des tours vocaux.
 */
export function customerCandidateSearchSql(input: {
  readonly companyId: string;
  readonly query: string;
  readonly limit: number;
  readonly lock: CustomerCandidateLock;
}): Prisma.Sql {
  return Prisma.sql`
      SELECT
        c."id" AS "customerId",
        c."name" AS "canonicalName",
        CASE
          WHEN immutable_unaccent(lower(c."name"))
            = immutable_unaccent(lower(${input.query}))
          THEN 'exact'::text
          ELSE 'fuzzy'::text
        END AS "matchKind",
        CASE
          WHEN immutable_unaccent(lower(c."name"))
            = immutable_unaccent(lower(${input.query}))
          THEN 1.0::double precision
          ELSE word_similarity(
            immutable_unaccent(lower(${input.query})),
            immutable_unaccent(lower(c."name"))
          )::double precision
        END AS "score"
      FROM public.customers c
      WHERE c."companyId" = ${input.companyId}
        AND (
          immutable_unaccent(lower(c."name"))
            = immutable_unaccent(lower(${input.query}))
          OR immutable_unaccent(lower(${input.query}))
            <% immutable_unaccent(lower(c."name"))
        )
      ORDER BY
        (
          immutable_unaccent(lower(c."name"))
            = immutable_unaccent(lower(${input.query}))
        ) DESC,
        "score" DESC,
        immutable_unaccent(lower(c."name")) COLLATE "C" ASC,
        c."id" ASC
      LIMIT ${input.limit}
      ${lockClause(input.lock, 'c')}
    `;
}

/** Référence d'UNE fiche par identité — le chemin de confirmation, jamais de recherche. */
export function customerReferenceByIdSql(input: {
  readonly companyId: string;
  readonly customerId: string;
  readonly lock: CustomerCandidateLock;
}): Prisma.Sql {
  return Prisma.sql`
      SELECT c."id" AS "customerId", c."name" AS "canonicalName"
      FROM public.customers c
      WHERE c."companyId" = ${input.companyId}
        AND c."id" = ${input.customerId}
      LIMIT 1
      ${lockClause(input.lock, 'c')}
    `;
}

/**
 * Références par lot d'identités. `ORDER BY id` : la sortie ne dépend jamais de l'ordre d'entrée,
 * donc deux appelants qui demandent le même ensemble obtiennent la même page.
 */
export function customerReferenceByIdsSql(input: {
  readonly companyId: string;
  readonly customerIds: readonly string[];
  readonly lock: CustomerCandidateLock;
}): Prisma.Sql {
  return Prisma.sql`
      SELECT c."id" AS "customerId", c."name" AS "canonicalName"
      FROM public.customers c
      WHERE c."companyId" = ${input.companyId}
        AND c."id" IN (${Prisma.join(input.customerIds)})
      ORDER BY c."id" ASC
      ${lockClause(input.lock, 'c')}
    `;
}
