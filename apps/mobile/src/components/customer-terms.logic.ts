/**
 * B4 / canal — logique PURE des sections « Conditions de paiement » et « Comment ce client
 * reçoit ses factures » de la fiche client, et de l'échéance affichée à l'émission.
 * Les plafonds légaux (L441-10) viennent du DOMAINE (validateProPaymentTermsCeiling) —
 * jamais recodés ici.
 */
import {
  PaymentTerms,
  formatDateOnlyFr,
  validateProPaymentTermsCeiling,
  type CustomerBillingChannel,
  type CustomerBillingChannelType,
  type CustomerPaymentTerms,
  type CustomerType,
} from '@bob/core';
import { t, type Personality } from '@bob/i18n';

/** « 45 jours fin de mois » / « 30 jours » / « Suit ton réglage société ». */
export function describePaymentTerms(
  terms: CustomerPaymentTerms | null,
  personality: Personality,
): string {
  if (terms === null) return t('terms.followsDefault', { personality });
  return t(terms.endOfMonth ? 'terms.daysEom' : 'terms.daysOnly', {
    personality,
    params: { days: terms.days },
  });
}

/** Saisie du délai (texte) → entier 0..365, sinon null (mêmes bornes que la fiche domaine). */
export function parseTermsDaysInput(raw: string): number | null {
  const trimmed = raw.trim();
  if (!/^\d{1,3}$/.test(trimmed)) return null;
  const days = Number(trimmed);
  return Number.isInteger(days) && days >= 0 && days <= 365 ? days : null;
}

/** Plafond légal L441-10 dépassé pour CE client ? (b2c jamais concerné — règle domaine). */
export function termsCeilingExceeded(
  customerType: CustomerType,
  days: number,
  endOfMonth: boolean,
): boolean {
  return !validateProPaymentTermsCeiling(customerType, { days, endOfMonth }).ok;
}

/**
 * Échéance dérivée AFFICHÉE à l'émission : « Échéance : 12/09/2026 — 45 jours fin de mois ».
 * `dueAt` vient de la pièce (source serveur) ; le libellé vient des conditions du client si
 * elles existent — sinon la date seule (jamais un libellé inventé).
 */
export function dueLineForInvoice(
  dueAt: string | null | undefined,
  terms: CustomerPaymentTerms | null,
  personality: Personality,
): string | null {
  if (dueAt == null || !/^\d{4}-\d{2}-\d{2}$/.test(dueAt)) return null;
  const date = formatDateOnlyFr(dueAt);
  if (terms === null) return t('terms.dueAtIssuedNoLabel', { personality, params: { date } });
  return t('terms.dueAtIssued', {
    personality,
    params: { date, label: describePaymentTerms(terms, personality) },
  });
}

/** Aperçu LIVE de l'échéance dans la feuille d'édition (depuis un jour métier injecté). */
export function previewDueDate(
  days: number,
  endOfMonth: boolean,
  from: string,
): string | null {
  const terms = PaymentTerms.of({ days, endOfMonth, label: '—' });
  if (!terms.ok) return null;
  const due = terms.value.dueDateFrom(from);
  return due === null ? null : formatDateOnlyFr(due);
}

/** Type effectif du canal — null/absent = email (défaut honnête, jamais un canal inventé). */
export function billingChannelTypeOf(
  channel: CustomerBillingChannel | null | undefined,
): CustomerBillingChannelType {
  return channel?.type ?? 'email';
}

const CHANNEL_LABEL_KEY = {
  email: 'canal.email',
  chorus: 'canal.chorus',
  portail: 'canal.portail',
} as const;

export function describeBillingChannel(
  channel: CustomerBillingChannel | null | undefined,
  personality: Personality,
): string {
  const type = billingChannelTypeOf(channel);
  const label = t(CHANNEL_LABEL_KEY[type], { personality });
  if (type === 'chorus' && channel?.chorusServiceCode)
    return `${label} · ${channel.chorusServiceCode}`;
  if (type === 'portail' && channel?.portailNom) return `${label} · ${channel.portailNom}`;
  return label;
}

/**
 * Formulaire canal → CustomerBillingChannel normalisé (champs annexes liés à LEUR type — la
 * validation STRUCTURELLE complète reste au domaine validateBillingChannel, revalidée serveur).
 */
export function buildBillingChannel(input: {
  type: CustomerBillingChannelType;
  chorusServiceCode: string;
  portailNom: string;
  portailUrl: string;
}): CustomerBillingChannel {
  if (input.type === 'chorus') {
    const code = input.chorusServiceCode.trim();
    return { type: 'chorus', ...(code !== '' ? { chorusServiceCode: code } : {}) };
  }
  if (input.type === 'portail') {
    const nom = input.portailNom.trim();
    const url = input.portailUrl.trim();
    return {
      type: 'portail',
      ...(nom !== '' ? { portailNom: nom } : {}),
      ...(url !== '' ? { portailUrl: url } : {}),
    };
  }
  return { type: 'email' };
}
