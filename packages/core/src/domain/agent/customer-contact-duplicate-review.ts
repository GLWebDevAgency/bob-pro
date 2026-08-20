/**
 * Jarvis U1-g — LA REVUE DE DOUBLONS, DÉRIVATION PURE (SPEC_U1G §3, FD-2026-0817-06).
 *
 * Transforme des candidats bruts, relus en base, en la résolution que le domaine attend. Fonction
 * PURE : ni horloge, ni aléa, ni entrée-sortie — deux appels sur le même monde produisent le même
 * octet, condition de l'idempotence d'un tour vocal rejoué.
 *
 * ZÉRO PII DANS CE QUI EST SCELLÉ. Un candidat retenu ne porte que son identité et un digest
 * d'évidence : le nom ne franchit jamais la frontière du durable (§9.1). Les libellés, eux, sont
 * rendus À PART et marqués transitoires — ils servent à PARLER, jamais à persister.
 *
 * « JE NE SAIS PAS » N'EST JAMAIS « AUCUN DOUBLON ». Une requête hors forme, une requête que le
 * MOTEUR ne sait pas exploiter, ou un jeu de candidats inexploitable rendent `unusable` — jamais
 * `no_duplicates`. Sceller « aucun doublon » sans avoir cherché écrirait un fait CERTIFIÉ FAUX dans
 * un journal immuable, et brûlerait l'unique fenêtre de résolution du run : la détection
 * deviendrait impossible pour toujours.
 *
 * « Bien formée » et « exploitable » sont DEUX questions. La première regarde la chaîne, la seconde
 * regarde le moteur : `<%` compare des TRIGRAMMES, et `pg_trgm` n'en tire que des caractères
 * alphanumériques — une requête qui n'en contient aucun ne peut RIEN trouver par ressemblance, quel
 * que soit le contenu de la base. La seconde garde ne mord donc que sur la conclusion d'ABSENCE, et
 * seulement sur l'impossible (voir `isSearchableQuery`).
 *
 * RAPPROCHEMENT PAR NOM UNIQUEMENT. §9.1 autorise aussi SIREN, e-mail et téléphone ; ce lot ne les
 * fait pas — ces champs sont exclus de la voix par la minimisation. `matchKind` entre dans le
 * digest pour qu'un lot futur puisse les ajouter sans casser le domaine, mais personne ne doit
 * croire la garde plus large qu'elle n'est.
 */
import { hasAsciiControlCharacter } from '../../shared-kernel/control-characters';
import { sha256Hex } from '../../shared-kernel/sha256';
import { sanitizeSpokenLabel } from '../../shared-kernel/spoken-label';
import type { CustomerCandidate } from '../../application/ports/customer-candidate-search';
import {
  CUSTOMER_CONTACT_MAX_DUPLICATE_CANDIDATES,
  type CustomerContactDuplicateCandidateV1,
} from './definitions/customer-contact-v1';

/** Miroir EXACT de la borne de l'adaptateur : au-delà, la page a saturé. */
export const CUSTOMER_CONTACT_CANDIDATE_PROBE_LIMIT = 6;

/**
 * Borne d'un libellé PRONONCÉ, en points de code.
 *
 * Elle protège la chaîne vocale : la parole entière entre dans l'historique du tour suivant, que le
 * planner refuse au-delà de 1 200 caractères — cinq libellés de 200 plus l'ossature de la phrase
 * franchissaient ce seuil et faisaient tomber TOUTES les lanes, devis compris.
 *
 * POURQUOI 160, ET PAS PLUS BAS. C'est la borne que le dépôt applique DÉJÀ à un libellé présenté
 * (`MAX_CHOICE_LABEL_LENGTH` du planner, qui refuse un choix de devis au-delà) : la même chose doit
 * se dire du même nombre. Une première version serrait à 80 pour ménager l'oreille, et fabriquait
 * ainsi des libellés IDENTIQUES pour des fiches DISTINCTES — deux syndics au préfixe long dont
 * seule la fin diffère. L'artisan choisissait alors à l'aveugle, et scellait un rattachement
 * durable. Ménager l'oreille ne vaut pas de faire prendre une décision aveugle : à 160, les noms
 * réels passent entiers, et au-delà l'élision MÉDIANE préserve le discriminant final.
 *
 * Cinq libellés de 160 plus l'ossature restent très en deçà de 1 200, et la preuve de frontière de
 * `@bob/ai` le vérifie contre le planner lui-même plutôt que contre un nombre recopié ici.
 */
export const CUSTOMER_CONTACT_SPOKEN_LABEL_LIMIT = 160;

const REVIEW_NAMESPACE = 'bob.jarvis-run.customer-contact.duplicate-review.v1';
const CHOICE_NAMESPACE = 'bob.jarvis-run.customer-contact.duplicate-choice.v1';
const MATCH_NAMESPACE = 'bob.jarvis-run.customer-contact.duplicate-match.v1';

/**
 * Identifiant canonique de fiche, mêmes bornes que le domaine.
 *
 * `hasAsciiControlCharacter` plutôt qu'une classe de regex : c'est la convention du noyau partagé,
 * et une regex de contrôle finit trop facilement écrite avec les octets BRUTS — git classe alors
 * le fichier binaire, `git diff` n'affiche plus qu'une taille et `grep` devient silencieusement
 * aveugle. La garde `source-control-bytes` interdit désormais la rechute.
 */
function isCanonicalIdentifier(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    value.length >= 1 &&
    value.length <= 200 &&
    value === value.trim() &&
    !hasAsciiControlCharacter(value)
  );
}

/** Une requête de rapprochement est une phrase d'artisan, pas un identifiant technique. */
function isUsableQuery(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    value.trim().length >= 1 &&
    value.length <= 200 &&
    !hasAsciiControlCharacter(value)
  );
}

/** Lettres et chiffres : les seuls caractères dont `pg_trgm` tire des trigrammes. */
const ALPHANUMERIC = /[\p{L}\p{N}]/u;

/**
 * LA REQUÊTE EST-ELLE EXPLOITABLE PAR LE MOTEUR ? Question distincte de « est-elle bien formée ».
 *
 * Le prédicat SQL `<%` ne compare pas des caractères mais des TRIGRAMMES, et `pg_trgm` ne tire de
 * trigrammes que des caractères alphanumériques : tout le reste est un séparateur de mots. Une
 * requête qui n'en contient AUCUN ne produit donc aucun trigramme, et sa branche de similarité est
 * structurellement morte — elle ne peut RIEN trouver, quel que soit le contenu de la base. Conclure
 * « aucun doublon » sur une telle requête certifierait une absence jamais cherchée.
 *
 * LA BORNE EST « AU MOINS UN », ET SÛREMENT PAS « AU MOINS DEUX ». Une première version exigeait un
 * MOT de deux caractères, en généralisant à tort `word_similarity('d','dupont plomberie')` = 0,5 :
 * ce 0,5 vient de la longueur du mot CIBLE, jamais de la requête. Mesuré sur PostgreSQL 17.6 :
 *   show_trgm('?') = {} · show_trgm('-') = {} · show_trgm('&') = {}
 *   show_trgm('h&m') = {"  h","  m"," h "," m "} · 'h&m' <% 'h&m paris centre' = t (ws = 1)
 *   'j-c' <% 'j-c dupont' = t (ws = 1) · 'm' <% 'm dupont' = t (ws = 1) · '4' <% '4 murs' = t
 * Autrement dit un mot d'UN caractère se rapproche parfaitement d'un mot d'un caractère. Exiger
 * deux rendait « H&M », « C&A », « B&B », « J-C » IMPOSSIBLES à créer à la voix : Bob répondait
 * « je ne peux pas vérifier » juste après avoir vérifié, et la redite reprenait la même branche
 * indéfiniment. La garde censée empêcher « je ne sais pas » de devenir « aucun doublon » produisait
 * exactement l'inverse : « je sais » devenait « je ne sais pas ».
 *
 * CE QUE CETTE GARDE NE PRÉTEND PAS ÊTRE. Elle ne juge pas de la QUALITÉ du rapprochement : « Z »
 * ne retrouvera pas « Zorglub » (0,5 < 0,6), et c'est une limite assumée du rapprochement par nom,
 * pas une panne — la recherche a bien eu lieu et a conclu. On ne refuse que l'impossible.
 */
function isSearchableQuery(value: string): boolean {
  return ALPHANUMERIC.test(value);
}

/**
 * Un candidat rendu par la base peut être aberrant (nom vide, score hors bornes, identité hors
 * forme) : c'est le signe d'une dérive, jamais une raison de conclure « aucun doublon ».
 */
function isUsableCandidate(candidate: CustomerCandidate): boolean {
  return (
    isCanonicalIdentifier(candidate.customerId) &&
    typeof candidate.canonicalName === 'string' &&
    candidate.canonicalName.trim().length >= 1 &&
    (candidate.matchKind === 'exact' || candidate.matchKind === 'fuzzy') &&
    typeof candidate.score === 'number' &&
    Number.isFinite(candidate.score) &&
    candidate.score >= 0 &&
    candidate.score <= 1
  );
}

/** UUID de forme v4 dérivé — les identités de choix doivent être stables au rejeu. */
function uuidFromDigest(digest: string): string {
  const hex = digest.slice(0, 32);
  const variant = ((Number.parseInt(hex[16]!, 16) & 0x3) | 0x8).toString(16);
  const uuid = `${hex.slice(0, 12)}4${hex.slice(13, 16)}${variant}${hex.slice(17)}`;
  return [
    uuid.slice(0, 8),
    uuid.slice(8, 12),
    uuid.slice(12, 16),
    uuid.slice(16, 20),
    uuid.slice(20),
  ].join('-');
}

/**
 * Évidence de correspondance, CLOISONNÉE par (runId, reviewId).
 *
 * CE QU'ELLE PROUVE : l'immuabilité du jeu présenté et le déterminisme du rejeu.
 * CE QU'ELLE NE PROUVE PAS : la pertinence du rapprochement — la requête n'est conservée nulle
 * part, délibérément.
 *
 * Le `score` PostgreSQL est VOLONTAIREMENT exclu : flottant dépendant de la version et de la
 * collation, il produirait un digest que personne ne saurait recalculer — un axe mort.
 */
export function computeCustomerContactMatchDigest(input: {
  readonly runId: string;
  readonly reviewId: string;
  readonly customerId: string;
  readonly matchKind: 'exact' | 'fuzzy';
  readonly queryDigest: string;
  readonly candidateNameDigest: string;
}): string {
  return sha256Hex(
    JSON.stringify([
      MATCH_NAMESPACE,
      input.runId,
      input.reviewId,
      input.customerId,
      input.matchKind,
      input.queryDigest,
      input.candidateNameDigest,
    ]),
  );
}

export type CustomerContactDuplicateProbe =
  | { readonly kind: 'no_duplicates' }
  | {
      readonly kind: 'duplicate_candidates';
      readonly reviewId: string;
      /** Ce qui sera SCELLÉ : identité + évidence, zéro PII. */
      readonly candidates: readonly CustomerContactDuplicateCandidateV1[];
      /** Libellés alignés sur l'ordinal — TRANSITOIRES, pour la parole seule. Jamais persistés. */
      readonly labels: readonly string[];
      /** La page a saturé : on ne prétendra JAMAIS être exhaustif. */
      readonly moreThanShown: boolean;
    }
  | {
      readonly kind: 'unusable';
      readonly reason: 'invalid_query' | 'invalid_candidate_set';
    };

/**
 * Dérive la revue. L'ORDRE DE L'ADAPTATEUR EST CONSERVÉ TEL QUEL (exact d'abord, score, nom en
 * collation binaire, id) : re-trier ici ferait diverger Bob du résolveur du devis — deux Bob ne
 * doivent pas proposer deux ordres différents pour la même phrase.
 *
 * Un candidat `exact` UNIQUE produit quand même une revue : §8 — un candidat fort reste une
 * suggestion, jamais une décision prise à la place de l'artisan.
 */
export function deriveCustomerContactDuplicateReview(input: {
  readonly runId: string;
  readonly commandId: string;
  readonly query: string;
  readonly candidates: readonly CustomerCandidate[];
}): CustomerContactDuplicateProbe {
  if (!isUsableQuery(input.query)) return { kind: 'unusable', reason: 'invalid_query' };
  // LA GARDE NE MORD QUE SUR L'ABSENCE, et c'est délibéré. Le prédicat SQL a DEUX branches :
  // l'égalité exacte, qui marche à n'importe quelle longueur, et la similarité de trigrammes, qui
  // exige un mot d'au moins deux caractères. Des candidats REMONTÉS sont donc toujours réels et
  // présentables — c'est la conclusion « aucun doublon » qui serait fausse, puisqu'une requête
  // inexploitable ne pouvait de toute façon rien trouver par ressemblance. On refuse de conclure,
  // sans retirer la seule capacité que la branche d'égalité offrait encore.
  if (input.candidates.length === 0) {
    return isSearchableQuery(input.query)
      ? { kind: 'no_duplicates' }
      : { kind: 'unusable', reason: 'invalid_query' };
  }
  // Une identité en double dans la page signale une dérive de la base : on REFUSE, on ne
  // déduplique jamais en silence — le silence ferait passer une anomalie pour un résultat.
  const vus = new Set<string>();
  for (const candidate of input.candidates) {
    if (!isUsableCandidate(candidate) || vus.has(candidate.customerId)) {
      return { kind: 'unusable', reason: 'invalid_candidate_set' };
    }
    vus.add(candidate.customerId);
  }
  const reviewId = uuidFromDigest(
    sha256Hex(JSON.stringify([REVIEW_NAMESPACE, input.runId, input.commandId])),
  );
  const queryDigest = sha256Hex(input.query.trim().toLowerCase());
  // Troncature APRÈS validation : on valide ce que la base a rendu, on ne présente que ce que
  // l'artisan peut tenir de tête.
  const retenus = input.candidates.slice(0, CUSTOMER_CONTACT_MAX_DUPLICATE_CANDIDATES);
  // LES LIBELLÉS SONT ASSAINIS AVANT DE PARLER. Le nom relu en base n'est pas de confiance : le
  // validateur de création ne refuse que les contrôles ASCII, si bien qu'une espace de largeur
  // nulle s'y stocke et en ressort. Or la parole de Bob entre dans l'historique du tour suivant,
  // et le planner rejette l'historique ENTIER — devis compris — dès qu'un tour porte un invisible
  // ou dépasse sa borne : une seule fiche mal nommée rendrait l'assistant muet plusieurs tours.
  // Un libellé qui ne laisse rien après assainissement est une dérive, jamais un nom de secours.
  const labels: string[] = [];
  for (const candidate of retenus) {
    const label = sanitizeSpokenLabel(candidate.canonicalName, CUSTOMER_CONTACT_SPOKEN_LABEL_LIMIT);
    if (label === null) return { kind: 'unusable', reason: 'invalid_candidate_set' };
    labels.push(label);
  }
  const candidates = retenus.map((candidate) =>
    Object.freeze({
      choiceId: uuidFromDigest(
        sha256Hex(JSON.stringify([CHOICE_NAMESPACE, reviewId, candidate.customerId])),
      ),
      customerId: candidate.customerId,
      matchDigest: computeCustomerContactMatchDigest({
        runId: input.runId,
        reviewId,
        customerId: candidate.customerId,
        matchKind: candidate.matchKind,
        queryDigest,
        candidateNameDigest: sha256Hex(candidate.canonicalName.trim().toLowerCase()),
      }),
    }),
  );
  return {
    kind: 'duplicate_candidates',
    reviewId,
    candidates: Object.freeze(candidates),
    labels: Object.freeze(labels),
    moreThanShown: input.candidates.length >= CUSTOMER_CONTACT_CANDIDATE_PROBE_LIMIT,
  };
}
