/**
 * Frame sémantique `customer_contact@1` (spec Jarvis §5.4/§9.1) — lot U1-d,
 * SPEC_U1D_CALLERS_REELS_20260819 §3 « VOIX ».
 *
 * Frontière probabiliste → déterministe du vertical fiche client : le LLM ne reçoit AUCUNE
 * autorité et ne produit que cette union FERMÉE d'intentions. Rien ici n'exécute, ne résout et
 * n'invente : aucun identifiant interne (`customerId`, `proposalId`, `confirmationId`) n'entre
 * dans la frame — l'orchestrateur les relit du run admis ou les dérive côté serveur.
 *
 * Les champs proposés sont de la PII : ils voyagent dans la frame puis dans le payload store
 * scellé (§5.5), JAMAIS dans le state du run — le state ne porte que `fieldsDigest` et
 * `sensitiveDigest`, tous deux calculés ICI, purement, pour que la voix, le tap et l'exécuteur
 * scellent le même octet.
 */

import { hasAsciiControlCharacter } from '../../shared-kernel/control-characters';
import { sha256Hex } from '../../shared-kernel/sha256';

import {
  CUSTOMER_CONTACT_MAX_DUPLICATE_CANDIDATES,
  CUSTOMER_CONTACT_SENSITIVE_FIELDS,
  type CustomerContactSensitiveField,
} from './definitions/customer-contact-v1';

export const CUSTOMER_CONTACT_SEMANTIC_FRAME_SCHEMA = 'bob.semantic.customer-contact' as const;
export const CUSTOMER_CONTACT_SEMANTIC_FRAME_VERSION = 1 as const;

const MAX_MODEL_LENGTH = 120;
const MAX_SHORT_FIELD_LENGTH = 200;
const MAX_LONG_FIELD_LENGTH = 300;

/** Canal de facturation proposé — champ SENSIBLE §9.1 (`billing_channel`). */
export const CUSTOMER_CONTACT_BILLING_CHANNELS = Object.freeze(['email', 'postal'] as const);
export type CustomerContactBillingChannel = (typeof CUSTOMER_CONTACT_BILLING_CHANNELS)[number];

/**
 * Champs proposés d'une fiche client. Union totale et fermée : tout champ absent de cette liste
 * est refusé par la garde, et une frame qui ne propose RIEN est refusée (une proposition vide
 * n'est jamais une intention).
 */
export interface CustomerContactProposedFieldsV1 {
  readonly displayName: string | null;
  readonly legalName: string | null;
  readonly email: string | null;
  readonly phone: string | null;
  readonly addressLine: string | null;
  readonly postalCode: string | null;
  readonly city: string | null;
  readonly vatNumber: string | null;
  readonly billingChannel: CustomerContactBillingChannel | null;
  readonly recipientName: string | null;
}

/** Ordre canonique du digest — figé : le réordonner casserait le scellé des propositions. */
export const CUSTOMER_CONTACT_PROPOSED_FIELD_KEYS = Object.freeze([
  'displayName',
  'legalName',
  'email',
  'phone',
  'addressLine',
  'postalCode',
  'city',
  'vatNumber',
  'billingChannel',
  'recipientName',
] as const);
export type CustomerContactProposedFieldKey = (typeof CUSTOMER_CONTACT_PROPOSED_FIELD_KEYS)[number];

/**
 * Projection §9.1 champ sensible → champs proposés qui le composent. Une mutation de l'un
 * d'eux entre présentation et confirmation invalide la proposition — jamais `consumed`.
 */
export const CUSTOMER_CONTACT_SENSITIVE_FIELD_SOURCES = Object.freeze({
  vat_profile: Object.freeze(['vatNumber'] as const),
  billing_channel: Object.freeze(['billingChannel'] as const),
  address: Object.freeze(['addressLine', 'postalCode', 'city'] as const),
  recipient: Object.freeze(['recipientName', 'email'] as const),
}) satisfies Readonly<
  Record<CustomerContactSensitiveField, readonly CustomerContactProposedFieldKey[]>
>;

/**
 * Clés de champ qui COMPOSENT réellement un champ sensible §9.1 — dérivées de la table de
 * projection elle-même, jamais recopiées : ajouter une source à `CUSTOMER_CONTACT_SENSITIVE_FIELD_SOURCES`
 * élargit ce type et casse à la compilation tout appelant qui ne la relirait pas.
 */
export type CustomerContactSensitiveSourceKey =
  (typeof CUSTOMER_CONTACT_SENSITIVE_FIELD_SOURCES)[CustomerContactSensitiveField][number];

/** Longueur maximale admise par champ — bornes de canonicalisation, jamais des règles métier. */
const FIELD_MAX_LENGTHS: Readonly<Record<CustomerContactProposedFieldKey, number>> = Object.freeze({
  displayName: MAX_SHORT_FIELD_LENGTH,
  legalName: MAX_SHORT_FIELD_LENGTH,
  email: MAX_SHORT_FIELD_LENGTH,
  phone: 40,
  addressLine: MAX_LONG_FIELD_LENGTH,
  postalCode: 20,
  city: MAX_SHORT_FIELD_LENGTH,
  vatNumber: 40,
  billingChannel: 10,
  recipientName: MAX_SHORT_FIELD_LENGTH,
});

/**
 * Opérations vocales admises. FD-06 est fermée PAR CONSTRUCTION ici aussi : aucune fusion,
 * aucune suppression, aucune cible inventée. `open_customer_creation` ne transporte AUCUN champ :
 * la collecte passe par `propose_fields`, seule étape où la PII est scellée dans le store.
 */
export type CustomerContactSemanticOperationV1 =
  /**
   * U1-g — `customerName` est une REQUÊTE DE RAPPROCHEMENT, jamais un champ collecté : le serveur
   * s'en sert pour CHERCHER des doublons, et rien d'autre. §8 l'autorise explicitement — le modèle
   * peut proposer un libellé, il ne fournit jamais l'autorité d'une entité. `null` quand l'artisan
   * n'a nommé personne : Bob demande alors le nom plutôt que d'ouvrir à l'aveugle.
   */
  | { readonly kind: 'open_customer_creation'; readonly customerName: string | null }
  /**
   * REPRISE d'un run resté en `resolving_customer` (le second maillon a été refusé). Sans elle, un
   * run parqué n'aurait d'autre issue que l'annulation — la vivacité serait un espoir, pas une
   * propriété.
   */
  | { readonly kind: 'probe_duplicates'; readonly customerName: string }
  | { readonly kind: 'propose_fields'; readonly fields: CustomerContactProposedFieldsV1 }
  | { readonly kind: 'choose_duplicate'; readonly ordinal: number }
  | { readonly kind: 'continue_creation' }
  | { readonly kind: 'acknowledge_presentation' }
  | { readonly kind: 'confirm_proposal' }
  | { readonly kind: 'reject_proposal' }
  | { readonly kind: 'cancel_run' };

export interface CustomerContactSemanticFrameV1 {
  readonly schema: typeof CUSTOMER_CONTACT_SEMANTIC_FRAME_SCHEMA;
  readonly version: typeof CUSTOMER_CONTACT_SEMANTIC_FRAME_VERSION;
  readonly operation: CustomerContactSemanticOperationV1;
  readonly model: string;
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function exactKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  return (
    Object.keys(value).length === keys.length && keys.every((key) => Object.hasOwn(value, key))
  );
}

/** Ligne canonique : espaces normalisés, jamais vide, jamais de contrôle, bornée. */
function canonicalLine(value: unknown, maxLength: number): string | null {
  if (typeof value !== 'string') return null;
  const normalized = value.trim().replace(/\s+/gu, ' ');
  if (
    normalized.length === 0 ||
    normalized.length > maxLength ||
    hasAsciiControlCharacter(normalized)
  ) {
    return null;
  }
  return normalized;
}

/**
 * Garde de canonicité des champs proposés : chaque clé présente EXACTEMENT une fois, chaque
 * valeur canonique ou `null`, au moins une valeur non nulle. `null` signifie « non proposé » —
 * jamais « effacer », un effacement est une intention distincte hors U1-d.
 */
export function parseCustomerContactProposedFields(
  value: unknown,
): CustomerContactProposedFieldsV1 | null {
  if (!isPlainRecord(value) || !exactKeys(value, CUSTOMER_CONTACT_PROPOSED_FIELD_KEYS)) {
    return null;
  }
  const fields: Record<string, string | null> = {};
  let proposedCount = 0;
  for (const key of CUSTOMER_CONTACT_PROPOSED_FIELD_KEYS) {
    const raw = value[key];
    if (raw === null) {
      fields[key] = null;
      continue;
    }
    const canonical = canonicalLine(raw, FIELD_MAX_LENGTHS[key]);
    if (canonical === null) return null;
    if (
      key === 'billingChannel' &&
      !(CUSTOMER_CONTACT_BILLING_CHANNELS as readonly string[]).includes(canonical)
    ) {
      return null;
    }
    fields[key] = canonical;
    proposedCount += 1;
  }
  if (proposedCount === 0) return null;
  return Object.freeze(fields) as unknown as CustomerContactProposedFieldsV1;
}

/**
 * Requête de rapprochement : une phrase d'artisan, bornée. Un PLACEHOLDER de minimisation (`[email]`,
 * `[tel]`…) est refusé FERMÉ : il signalerait que le modèle a recopié une valeur masquée, donc que
 * la rédaction a fuité dans un champ métier.
 */
function parseCustomerNameQuery(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const requete = value.trim();
  if (requete.length < 1 || requete.length > 200) return null;
  // eslint-disable-next-line no-control-regex
  if (/[\u0000-\u001f\u007f]/.test(requete)) return null;
  if (/\[(email|tel|iban|siren)\]/i.test(requete)) return null;
  return requete;
}

function parseOperation(value: unknown): CustomerContactSemanticOperationV1 | null {
  if (!isPlainRecord(value)) return null;
  switch (value['kind']) {
    case 'open_customer_creation': {
      if (!exactKeys(value, ['kind', 'customerName'])) return null;
      const nom = value['customerName'];
      if (nom === null) {
        return Object.freeze({ kind: 'open_customer_creation' as const, customerName: null });
      }
      const requete = parseCustomerNameQuery(nom);
      return requete === null
        ? null
        : Object.freeze({ kind: 'open_customer_creation' as const, customerName: requete });
    }
    case 'probe_duplicates': {
      if (!exactKeys(value, ['kind', 'customerName'])) return null;
      // La reprise EXIGE un nom : sans terme de recherche, il n'y a rien à reprendre.
      const requete = parseCustomerNameQuery(value['customerName']);
      return requete === null
        ? null
        : Object.freeze({ kind: 'probe_duplicates' as const, customerName: requete });
    }
    case 'continue_creation':
    case 'acknowledge_presentation':
    case 'confirm_proposal':
    case 'reject_proposal':
    case 'cancel_run':
      return exactKeys(value, ['kind']) ? Object.freeze({ kind: value['kind'] }) : null;
    case 'propose_fields': {
      if (!exactKeys(value, ['kind', 'fields'])) return null;
      const fields = parseCustomerContactProposedFields(value['fields']);
      return fields === null ? null : Object.freeze({ kind: 'propose_fields' as const, fields });
    }
    case 'choose_duplicate': {
      if (!exactKeys(value, ['kind', 'ordinal'])) return null;
      const ordinal = value['ordinal'];
      if (
        !Number.isInteger(ordinal) ||
        (ordinal as number) < 1 ||
        (ordinal as number) > CUSTOMER_CONTACT_MAX_DUPLICATE_CANDIDATES
      ) {
        return null;
      }
      return Object.freeze({ kind: 'choose_duplicate' as const, ordinal: ordinal as number });
    }
    default:
      return null;
  }
}

/** Garde totale de la frame — une sortie non canonique du modèle échoue FERMÉE, sans exception. */
export function parseCustomerContactSemanticFrame(
  value: unknown,
): CustomerContactSemanticFrameV1 | null {
  if (!isPlainRecord(value) || !exactKeys(value, ['schema', 'version', 'operation', 'model'])) {
    return null;
  }
  if (
    value['schema'] !== CUSTOMER_CONTACT_SEMANTIC_FRAME_SCHEMA ||
    value['version'] !== CUSTOMER_CONTACT_SEMANTIC_FRAME_VERSION
  ) {
    return null;
  }
  const model = canonicalLine(value['model'], MAX_MODEL_LENGTH);
  if (model === null) return null;
  const operation = parseOperation(value['operation']);
  if (operation === null) return null;
  return Object.freeze({
    schema: CUSTOMER_CONTACT_SEMANTIC_FRAME_SCHEMA,
    version: CUSTOMER_CONTACT_SEMANTIC_FRAME_VERSION,
    operation,
    model,
  });
}

/**
 * Digest canonique de TOUS les champs proposés (§9.1) — scellé dans le state par
 * `stage_proposal` et revérifié à la recomposition de la présentation (greffe G4). Ordre figé,
 * `null` encodé explicitement : un champ absent ne peut jamais entrer en collision avec un
 * champ présent.
 */
export function computeCustomerContactFieldsDigest(
  fields: CustomerContactProposedFieldsV1,
): string {
  return sha256Hex(
    JSON.stringify([
      'bob.jarvis-run.customer-contact.fields.v1',
      CUSTOMER_CONTACT_PROPOSED_FIELD_KEYS.map((key) => [key, fields[key] ?? null]),
    ]),
  );
}

/**
 * Digest du sous-ensemble SENSIBLE (TVA, canal de facturation, adresse, destinataire) : garde
 * stale §9.1. Ordonné par `CUSTOMER_CONTACT_SENSITIVE_FIELDS`, jamais par l'ordre d'insertion.
 */
export function computeCustomerContactSensitiveDigest(
  fields: CustomerContactProposedFieldsV1,
): string {
  return sha256Hex(
    JSON.stringify([
      'bob.jarvis-run.customer-contact.sensitive.v1',
      CUSTOMER_CONTACT_SENSITIVE_FIELDS.map((sensitive) => [
        sensitive,
        CUSTOMER_CONTACT_SENSITIVE_FIELD_SOURCES[sensitive].map((key) => fields[key] ?? null),
      ]),
    ]),
  );
}

/**
 * Vue MINIMALE de la fiche client RELUE (§7.1) : exactement les colonnes qui composent les
 * champs sensibles §9.1, jamais la fiche entière — ce qui n'entre pas dans le digest n'a pas
 * à voyager. Le type des clés est DÉRIVÉ de la table de projection : impossible d'oublier une
 * source, impossible d'en inventer une.
 */
export type CustomerContactTargetSensitiveRecordV1 = Readonly<
  Record<CustomerContactSensitiveSourceKey, string | null>
>;

/**
 * Forme canonique d'une valeur STOCKÉE avant digest : espaces normalisés, vide ⇒ « absent ».
 * Aucune borne de longueur ici — contrairement à `canonicalLine`, qui garde une ENTRÉE du
 * modèle : une valeur trop longue déjà en base doit produire un digest, jamais un refus (le
 * refus éteindrait la garde §9.1 au lieu de la déclencher).
 */
function canonicalStoredValue(value: string | null): string | null {
  if (value === null) return null;
  const normalized = value.trim().replace(/\s+/gu, ' ');
  return normalized.length === 0 ? null : normalized;
}

/**
 * Digest du sous-ensemble SENSIBLE d'une fiche RELUE — l'entrée de la garde §9.1 (spec Jarvis
 * §7.1) : l'admission le dérive DANS sa transaction, sous le verrou de la ligne cible, à la
 * mise en proposition (sceau) puis à la confirmation (contrôle). Fonction PURE : ni horloge,
 * ni I/O, ni port.
 *
 * DOMAINE SÉPARÉ, volontairement : le préfixe diffère de celui des CHAMPS PROPOSÉS
 * (`computeCustomerContactSensitiveDigest`) pour qu'un digest de cible ne puisse JAMAIS être
 * confondu avec — ni satisfait par — un digest de proposition. Une comparaison croisée est
 * impossible par construction, jamais seulement improbable.
 */
export function computeCustomerContactTargetSensitiveDigest(
  record: CustomerContactTargetSensitiveRecordV1,
): string {
  return sha256Hex(
    JSON.stringify([
      'bob.jarvis-run.customer-contact.target-sensitive.v1',
      CUSTOMER_CONTACT_SENSITIVE_FIELDS.map((sensitive) => [
        sensitive,
        CUSTOMER_CONTACT_SENSITIVE_FIELD_SOURCES[sensitive].map((key) =>
          canonicalStoredValue(record[key]),
        ),
      ]),
    ]),
  );
}
