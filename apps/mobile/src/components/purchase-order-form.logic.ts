/**
 * B8 — logique pure du formulaire « Bon de commande » (numéro d'engagement grands comptes).
 * La date de réception est FACULTATIVE : vide → null ; JJ/MM/AAAA (ou AAAA-MM-JJ) → Instant
 * ISO canonique minuit UTC — même forme que la normalisation serveur (toISOString), donc
 * l'aller-retour est stable. Le numéro garde UNE SEULE autorité : makePurchaseOrderRef
 * (@bob/core) — jamais une regex locale divergente (parité stricte client/serveur).
 */
import { isValidDateOnly, makePurchaseOrderRef, type PurchaseOrderRefInput } from '@bob/core';

export type PurchaseOrderDateParse =
  | { readonly ok: true; readonly value: string | null }
  | { readonly ok: false };

/** '' → null (facultative) ; JJ/MM/AAAA ou AAAA-MM-JJ réels → Instant ISO minuit UTC. */
export function parsePurchaseOrderReceivedDate(raw: string): PurchaseOrderDateParse {
  const trimmed = raw.trim();
  if (!trimmed) return { ok: true, value: null };
  const french = /^(\d{2})\/(\d{2})\/(\d{4})$/.exec(trimmed);
  const candidate = french ? `${french[3]}-${french[2]}-${french[1]}` : trimmed;
  if (!isValidDateOnly(candidate)) return { ok: false };
  return { ok: true, value: `${candidate}T00:00:00.000Z` };
}

/** Instant ISO → JJ/MM/AAAA (jour UTC — le parseur ci-dessus écrit minuit UTC). */
export function displayPurchaseOrderReceivedDate(receivedAt: string): string {
  const parsed = new Date(receivedAt);
  if (Number.isNaN(parsed.getTime())) return receivedAt;
  const day = String(parsed.getUTCDate()).padStart(2, '0');
  const month = String(parsed.getUTCMonth() + 1).padStart(2, '0');
  return `${day}/${month}/${parsed.getUTCFullYear()}`;
}

export type PurchaseOrderFormResult =
  | { readonly ok: true; readonly value: PurchaseOrderRefInput }
  | { readonly ok: false; readonly field: 'number' | 'receivedAt' };

/**
 * Validation locale = MÊME autorité que le serveur (makePurchaseOrderRef, use case pur) :
 * assainissement du numéro (trim + espaces normalisés), bornes 1..60, contrôles rejetés.
 * En sortie, la forme CANONIQUE assainie voyage — jamais la saisie brute.
 */
export function buildPurchaseOrderRefInput(form: {
  readonly number: string;
  readonly receivedDate: string;
  readonly documentId: string | null;
}): PurchaseOrderFormResult {
  const date = parsePurchaseOrderReceivedDate(form.receivedDate);
  if (!date.ok) return { ok: false, field: 'receivedAt' };
  const ref = makePurchaseOrderRef({
    number: form.number,
    receivedAt: date.value,
    documentId: form.documentId,
  });
  if (!ref.ok) {
    const field =
      ref.error.code === 'VALIDATION' && ref.error.field === 'receivedAt' ? 'receivedAt' : 'number';
    return { ok: false, field };
  }
  return {
    ok: true,
    value: {
      number: ref.value.number,
      receivedAt: ref.value.receivedAt,
      documentId: ref.value.documentId,
    },
  };
}

/**
 * Traduit une AppError de mutation bon de commande en message utilisateur — la voix du
 * SERVEUR d'abord (409 « Devis déjà facturé… », révision périmée, 422 domaine/validation :
 * messages français autoritaires du use case), repli générique i18n fourni par l'appelant.
 */
export function purchaseOrderErrorMessage(e: unknown, fallback: string): string {
  if (e && typeof e === 'object' && 'kind' in e) {
    const error = e as {
      kind: string;
      reason?: unknown;
      issues?: unknown;
      error?: unknown;
    };
    if (
      (error.kind === 'conflict' || error.kind === 'forbidden') &&
      typeof error.reason === 'string' &&
      error.reason.length > 0
    )
      return error.reason;
    if (error.kind === 'validation' && Array.isArray(error.issues)) {
      const first = error.issues[0] as { message?: unknown } | undefined;
      if (first && typeof first.message === 'string' && first.message.length > 0)
        return first.message;
    }
    if (error.kind === 'domain' && error.error && typeof error.error === 'object') {
      const domain = error.error as { message?: unknown };
      if (typeof domain.message === 'string' && domain.message.length > 0) return domain.message;
    }
  }
  return fallback;
}
