import { type Instant } from '../../shared-kernel/time';

/**
 * WIN-BACK SUR VALEUR DORMANTE (pilier 2, rétention) — service domaine PUR : quand un
 * utilisateur décroche, la SEULE bonne raison de le rappeler est une valeur À LUI qui dort
 * (un devis qui expire, un impayé qui attend). Jamais un « tu nous manques ».
 *
 * Règles non négociables :
 * · un signal = UN crochet concret, chiffré, daté — pas une liste culpabilisante ;
 * · anti-harcèlement STRUCTUREL : cooldown minimal entre deux win-back (la politique est
 *   une donnée d'entrée, testable, jamais une constante cachée) ;
 * · zéro valeur dormante → zéro message, quelle que soit la durée d'inactivité.
 */

export interface ExpiringQuote {
  readonly id: string;
  readonly label: string;
  readonly totalCents: number;
  readonly expiresAt: Instant;
}

export interface OverdueInvoice {
  readonly id: string;
  readonly label: string;
  readonly remainingCents: number;
  readonly dueAt: Instant;
}

export interface WinBackPolicy {
  /** Jours d'inactivité avant d'envisager un rappel. */
  readonly inactivityDays: number;
  /** Jours MINIMUM entre deux win-back — le silence est un droit. */
  readonly cooldownDays: number;
  /** Fenêtre d'urgence d'un devis : expirant au-delà, il n'est pas encore un crochet. */
  readonly quoteHorizonDays: number;
}

export const DEFAULT_WINBACK_POLICY: WinBackPolicy = {
  inactivityDays: 7,
  cooldownDays: 14,
  quoteHorizonDays: 14,
};

export type WinBackHook =
  | { readonly type: 'expiring_quote'; readonly id: string; readonly label: string; readonly amountCents: number; readonly deadline: Instant }
  | { readonly type: 'overdue_invoice'; readonly id: string; readonly label: string; readonly amountCents: number; readonly dueAt: Instant };

export type WinBackDecision = { readonly kind: 'none' } | { readonly kind: 'send'; readonly hook: WinBackHook };

const DAY_MS = 24 * 60 * 60 * 1000;

export function decideWinBack(input: {
  readonly now: Instant;
  readonly lastActivityAt: Instant;
  readonly lastWinBackAt: Instant | null;
  readonly expiringQuotes: readonly ExpiringQuote[];
  readonly overdueInvoices: readonly OverdueInvoice[];
  readonly policy?: WinBackPolicy;
}): WinBackDecision {
  const policy = input.policy ?? DEFAULT_WINBACK_POLICY;
  const nowMs = Date.parse(input.now);

  const inactiveDays = (nowMs - Date.parse(input.lastActivityAt)) / DAY_MS;
  if (inactiveDays < policy.inactivityDays) return { kind: 'none' };

  if (input.lastWinBackAt !== null) {
    const sinceLast = (nowMs - Date.parse(input.lastWinBackAt)) / DAY_MS;
    if (sinceLast < policy.cooldownDays) return { kind: 'none' }; // le silence est un droit
  }

  // Devis encore VIVANTS (non expirés) dont l'échéance tombe dans l'horizon d'urgence.
  const horizonMs = nowMs + policy.quoteHorizonDays * DAY_MS;
  const urgentQuotes = input.expiringQuotes.filter((quote) => {
    const expiry = Date.parse(quote.expiresAt);
    return expiry > nowMs && expiry <= horizonMs && quote.totalCents > 0;
  });
  const realOverdue = input.overdueInvoices.filter(
    (invoice) => Date.parse(invoice.dueAt) < nowMs && invoice.remainingCents > 0,
  );

  // UN crochet : le plus gros montant gagne (c'est LA raison de revenir) ; à montant égal,
  // l'échéance la plus proche — l'urgence vraie, pas fabriquée.
  const candidates: { hook: WinBackHook; amount: number; deadlineMs: number }[] = [
    ...urgentQuotes.map((quote) => ({
      hook: {
        type: 'expiring_quote' as const,
        id: quote.id,
        label: quote.label,
        amountCents: quote.totalCents,
        deadline: quote.expiresAt,
      },
      amount: quote.totalCents,
      deadlineMs: Date.parse(quote.expiresAt),
    })),
    ...realOverdue.map((invoice) => ({
      hook: {
        type: 'overdue_invoice' as const,
        id: invoice.id,
        label: invoice.label,
        amountCents: invoice.remainingCents,
        dueAt: invoice.dueAt,
      },
      amount: invoice.remainingCents,
      deadlineMs: Date.parse(invoice.dueAt),
    })),
  ].sort((a, b) => b.amount - a.amount || a.deadlineMs - b.deadlineMs);

  const best = candidates[0];
  return best === undefined ? { kind: 'none' } : { kind: 'send', hook: best.hook };
}
