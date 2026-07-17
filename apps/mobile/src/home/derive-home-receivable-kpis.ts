import { deriveKnownReceivables, type InvoiceKind, type InvoiceStatus } from '@bob/core';

export interface HomeReceivableInvoice {
  readonly id: string;
  readonly companyId: string;
  readonly kind: InvoiceKind;
  readonly status: InvoiceStatus;
  readonly netToPayCents: number;
  readonly paidCents: number;
}

export interface HomeReceivableKpis {
  readonly owedCents: number;
  readonly lateCents: number;
}

const COLLECTIBLE = new Set<InvoiceStatus>(['issued', 'partially_paid', 'late']);

/**
 * KPIs Home exclusivement dérivés des factures persistées. Une portée mélangée ou une
 * pièce incohérente rend le bloc indisponible : l'écran n'affiche jamais un montant reconstitué.
 */
export function deriveHomeReceivableKpis(
  invoices: readonly HomeReceivableInvoice[],
): HomeReceivableKpis | null {
  if (invoices.length === 0) return { owedCents: 0, lateCents: 0 };

  const companyId = invoices[0]?.companyId;
  if (!companyId || invoices.some((invoice) => invoice.companyId !== companyId)) return null;

  const known = deriveKnownReceivables({ companyId, invoices });
  if (!known.ok) return null;

  let lateGross = 0;
  let credits = 0;
  for (const invoice of invoices) {
    if (!COLLECTIBLE.has(invoice.status)) continue;
    const remaining = invoice.netToPayCents - invoice.paidCents;
    if (!Number.isSafeInteger(remaining) || remaining < 0) return null;
    if (invoice.kind === 'credit_note') {
      credits += remaining;
    } else if (invoice.status === 'late') {
      lateGross += remaining;
    }
    if (!Number.isSafeInteger(lateGross) || !Number.isSafeInteger(credits)) return null;
  }

  return {
    owedCents: known.value.receivablesCents,
    // Les avoirs ouverts réduisent d'abord le montant réclamable en retard.
    lateCents: Math.max(0, lateGross - credits),
  };
}
