import { type DomainResult, ok, err } from '../../../shared-kernel/result';
import { type Instant } from '../../../shared-kernel/time';
import { hasBillingControlCharacter } from './line-item';

/**
 * Bon de commande (purchase order) — B8 : les clients professionnels/grands comptes (RATP,
 * collectivités, majors du BTP) répondent à un devis par un bon de commande porteur d'un
 * numéro d'engagement. Ce numéro DOIT figurer sur la facture (exigence de paiement des
 * grands comptes + obligation Chorus Pro pour le secteur public) — sans lui, la facture
 * est rejetée ou retardée. La référence est SAISIE UNE FOIS (sur le devis) puis reprise
 * automatiquement sur la facture dérivée : source unique, jamais re-saisie.
 */
export interface PurchaseOrderRef {
  /** Numéro d'engagement tel qu'imprimé sur la facture (assaini : trim + espaces normalisés). */
  readonly number: string;
  /** Réception du bon de commande (traçabilité) — null si non renseignée. */
  readonly receivedAt: Instant | null;
  /** Document du coffre contenant le bon de commande scanné — null si non archivé. */
  readonly documentId: string | null;
}

export const MAX_PURCHASE_ORDER_NUMBER_LENGTH = 60;
const MAX_PURCHASE_ORDER_DOCUMENT_ID_LENGTH = 100;

export interface PurchaseOrderRefInput {
  number: string;
  receivedAt?: Instant | null;
  documentId?: string | null;
}

/**
 * Fabrique pure du bon de commande : assainit le numéro (trim + espaces internes normalisés),
 * borne sa longueur (1..60), rejette les caractères de contrôle, valide la date de réception
 * et l'identifiant de document. Retourne un objet GELÉ : la référence est immuable.
 */
export function makePurchaseOrderRef(input: PurchaseOrderRefInput): DomainResult<PurchaseOrderRef> {
  if (typeof input.number !== 'string')
    return err({ code: 'VALIDATION', field: 'number', message: 'Numéro de bon de commande requis.' });
  // Assainissement AVANT le contrôle des caractères : tabulations/retours à la ligne issus
  // d'un scan ou de la voix deviennent des espaces simples — seuls les contrôles restants
  // (non-blancs) sont rejetés.
  const number = input.number.replace(/\s+/gu, ' ').trim();
  if (number.length === 0)
    return err({ code: 'VALIDATION', field: 'number', message: 'Numéro de bon de commande requis.' });
  if (number.length > MAX_PURCHASE_ORDER_NUMBER_LENGTH)
    return err({
      code: 'VALIDATION',
      field: 'number',
      message: `Numéro de bon de commande trop long (${MAX_PURCHASE_ORDER_NUMBER_LENGTH} caractères max).`,
    });
  if (hasBillingControlCharacter(number))
    return err({ code: 'VALIDATION', field: 'number', message: 'Numéro de bon de commande invalide.' });

  const receivedAt = input.receivedAt ?? null;
  if (receivedAt !== null && (typeof receivedAt !== 'string' || Number.isNaN(Date.parse(receivedAt))))
    return err({ code: 'VALIDATION', field: 'receivedAt', message: 'Date de réception invalide.' });

  let documentId = input.documentId ?? null;
  if (documentId !== null) {
    if (typeof documentId !== 'string') {
      return err({ code: 'VALIDATION', field: 'documentId', message: 'Document invalide.' });
    }
    documentId = documentId.trim();
    if (
      documentId.length === 0 ||
      documentId.length > MAX_PURCHASE_ORDER_DOCUMENT_ID_LENGTH ||
      hasBillingControlCharacter(documentId)
    )
      return err({ code: 'VALIDATION', field: 'documentId', message: 'Document invalide.' });
  }

  return ok(Object.freeze({ number, receivedAt, documentId }));
}

/** Égalité structurelle — fonde l'idempotence d'attachPurchaseOrder (ré-attacher l'identique = no-op). */
export function purchaseOrderRefEquals(
  a: PurchaseOrderRef | null,
  b: PurchaseOrderRef | null,
): boolean {
  if (a === null || b === null) return a === b;
  return a.number === b.number && a.receivedAt === b.receivedAt && a.documentId === b.documentId;
}

/** Copie défensive gelée — snapshots et reprise devis → facture sans partage de référence mutable. */
export function clonePurchaseOrderRef(ref: PurchaseOrderRef): PurchaseOrderRef {
  return Object.freeze({ number: ref.number, receivedAt: ref.receivedAt, documentId: ref.documentId });
}
