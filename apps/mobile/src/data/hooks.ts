import { useMemo } from 'react';
import { Linking, Alert } from 'react-native';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import {
  deriveRelancePlan,
  deriveTodayPriorities,
  deriveUpcomingDues,
  todayCompanyFromDiagnostic,
} from '@bob/core';
import type {
  Scenario,
  Horizon,
  CreateQuoteInput,
  PaymentMethod,
  RecordExpenseInput,
  PlanTier,
  TodayPriority,
  RelancePersonality,
  RelancePlanEntry,
  UpcomingDueEntry,
} from '@bob/core';
import type { CreateCustomerClientInput, NotificationView, RegisterPaymentClientInput } from '@bob/api-client';
import { useBobClient } from './client';

/** Ouvre une URL externe en remontant un échec à l'utilisateur (lien Stripe/paiement). */
function openUrl(url: string): void {
  if (!url) {
    Alert.alert('Lien indisponible', 'Aucun lien fourni. Réessaie plus tard.');
    return;
  }
  void Linking.openURL(url).catch(() => Alert.alert('Lien indisponible', "Impossible d'ouvrir le lien."));
}

/** Traduit une AppError en message utilisateur lisible (paywall, dépendance amont, introuvable, …). */
export function appErrorMessage(e: unknown): string {
  if (e && typeof e === 'object' && 'kind' in e) {
    const err = e as { kind: string; reason?: string };
    if (err.kind === 'forbidden') return err.reason ?? 'Action non autorisée pour ton offre.';
    if (err.kind === 'dependency') return 'Service indisponible pour le moment. Réessaie ou saisis les infos à la main.';
    if (err.kind === 'not_found') return 'Introuvable.';
  }
  return 'Action impossible. Réessaie.';
}

function alertError(e: unknown): void {
  Alert.alert('Oups', appErrorMessage(e));
}

const keys = {
  customers: ['customers'] as const,
  cashflow: (s: Scenario, h: Horizon) => ['cashflow', s, h] as const,
  quotes: ['quotes'] as const,
  invoices: ['invoices'] as const,
  invoice: (id: string) => ['invoice', id] as const,
  quote: (id: string) => ['quote', id] as const,
  notifications: ['notifications'] as const,
};

export function useSubscription() {
  const client = useBobClient();
  return useQuery({
    queryKey: ['subscription'],
    queryFn: async () => {
      const r = await client.getSubscription();
      if (!r.ok) throw r.error;
      return r.value;
    },
  });
}

export function useStartCheckout() {
  const client = useBobClient();
  return useMutation({
    mutationFn: async (tier: PlanTier) => {
      const r = await client.startCheckout(tier);
      if (!r.ok) throw r.error;
      return r.value;
    },
    onSuccess: (v) => openUrl(v.url),
    onError: alertError,
  });
}

export function useBillingPortal() {
  const client = useBobClient();
  return useMutation({
    mutationFn: async () => {
      const r = await client.billingPortal();
      if (!r.ok) throw r.error;
      return r.value;
    },
    onSuccess: (v) => openUrl(v.url),
    onError: alertError,
  });
}

export function useInvoicePaymentLink() {
  const client = useBobClient();
  return useMutation({
    mutationFn: async (invoiceId: string) => {
      const r = await client.invoicePaymentLink(invoiceId);
      if (!r.ok) throw r.error;
      return r.value;
    },
    onSuccess: (v) => openUrl(v.url),
    onError: alertError,
  });
}

export function useChantiers(enabled = true) {
  const client = useBobClient();
  return useQuery({
    queryKey: ['chantiers'],
    enabled,
    queryFn: async () => {
      const r = await client.listChantiers();
      if (!r.ok) throw r.error;
      return r.value;
    },
  });
}

export function useCreateChantier() {
  const client = useBobClient();
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (input: { name: string; customerId?: string | null; address?: string | null }) => {
      const r = await client.createChantier(input);
      if (!r.ok) throw r.error;
      return r.value;
    },
    onSuccess: () => void qc.invalidateQueries({ queryKey: ['chantiers'] }),
    onError: alertError,
  });
}

export function useLookupCompany() {
  const client = useBobClient();
  return useMutation({
    mutationFn: async (siret: string) => {
      const r = await client.lookupCompany(siret);
      if (!r.ok) throw r.error;
      return r.value;
    },
  });
}

export function useCheckVat() {
  const client = useBobClient();
  return useMutation({
    mutationFn: async (vatNumber: string) => {
      const r = await client.checkVat(vatNumber);
      if (!r.ok) throw r.error;
      return r.value;
    },
  });
}

export function useSearchAddress() {
  const client = useBobClient();
  return useMutation({
    mutationFn: async (query: string) => {
      const r = await client.searchAddress(query);
      if (!r.ok) throw r.error;
      return r.value;
    },
  });
}

export function useProfile() {
  const client = useBobClient();
  return useQuery({
    queryKey: ['profile'],
    queryFn: async () => {
      const r = await client.getProfile();
      if (!r.ok) throw r.error;
      return r.value;
    },
  });
}

/** Fiche société du tenant (nom, SIREN…) — GET /company/me. DOSSIER-1 : entête du dossier
 *  de clôture. Optionnel côté client : désactivé si l'implémentation ne l'expose pas. */
export function useCompany() {
  const client = useBobClient();
  return useQuery({
    queryKey: ['company'],
    enabled: typeof client.getCompanyMe === 'function',
    queryFn: async () => {
      const r = await client.getCompanyMe!();
      if (!r.ok) throw r.error;
      return r.value;
    },
  });
}

/** C-EXP-UI1 : échéancier fiscal 90 j (client.getFiscalCalendar — deriveFiscalCalendar serveur/démo).
 * Dates réelles dérivées de la fiche société ; amountHint null en v1 → l'écran n'affiche JAMAIS
 * de montant. Les échéances 'assumed' (périodicité/clôture inconnues) se badgent « à confirmer ». */
export function useFiscalCalendar() {
  const client = useBobClient();
  return useQuery({
    queryKey: ['fiscal-calendar'],
    queryFn: async () => {
      const r = await client.getFiscalCalendar();
      if (!r.ok) throw r.error;
      return r.value;
    },
  });
}

export function useDiagnostic() {
  const client = useBobClient();
  return useQuery({
    queryKey: ['diagnostic'],
    queryFn: async () => {
      const r = await client.getDiagnostic();
      if (!r.ok) throw r.error;
      return r.value;
    },
  });
}

export function useExtractDocument() {
  const client = useBobClient();
  return useMutation({
    mutationFn: async (input: { contentBase64: string; mimeType: string }) => {
      const r = await client.extractDocument(input);
      if (!r.ok) throw r.error;
      return r.value;
    },
  });
}

export function useExpenses() {
  const client = useBobClient();
  return useQuery({
    queryKey: ['expenses'],
    queryFn: async () => {
      const r = await client.listExpenses();
      if (!r.ok) throw r.error;
      return r.value;
    },
  });
}

export function useRecordExpense() {
  const client = useBobClient();
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (input: Omit<RecordExpenseInput, 'companyId'>) => {
      const r = await client.recordExpense(input);
      if (!r.ok) throw r.error;
      return r.value;
    },
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['expenses'] });
      void qc.invalidateQueries({ queryKey: ['cashflow'] });
    },
  });
}

/** E4 : régler une dépense — même use case que Bob ; rafraîchit charges, journal et tréso. */
export function usePayExpense() {
  const client = useBobClient();
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (input: { expenseId: string }) => {
      const r = await client.payExpense(input);
      if (!r.ok) throw r.error;
      return r.value;
    },
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['expenses'] });
      void qc.invalidateQueries({ queryKey: ['accounting-entries'] });
      void qc.invalidateQueries({ queryKey: ['cashflow'] });
    },
  });
}

export function useCustomers() {
  const client = useBobClient();
  return useQuery({
    queryKey: keys.customers,
    queryFn: async () => {
      const r = await client.listCustomers();
      if (!r.ok) throw r.error;
      return r.value;
    },
  });
}

/** Création client (C12/C40) — MÊME use case que l'outil agent creer_client (parité d'actions). */
export function useCreateCustomer() {
  const client = useBobClient();
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (input: CreateCustomerClientInput) => {
      const r = await client.createCustomer(input);
      if (!r.ok) throw r.error;
      return r.value;
    },
    onSuccess: () => void qc.invalidateQueries({ queryKey: keys.customers }),
  });
}

export function useCashflow(scenario: Scenario, horizon: Horizon) {
  const client = useBobClient();
  return useQuery({
    queryKey: keys.cashflow(scenario, horizon),
    queryFn: async () => {
      const r = await client.getCashflow({ scenario, horizon });
      if (!r.ok) throw r.error;
      return r.value;
    },
  });
}

export function useQuotes() {
  const client = useBobClient();
  return useQuery({
    queryKey: keys.quotes,
    queryFn: async () => {
      const r = await client.listQuotes();
      if (!r.ok) throw r.error;
      return r.value;
    },
  });
}

export function useInvoices() {
  const client = useBobClient();
  return useQuery({
    queryKey: keys.invoices,
    queryFn: async () => {
      const r = await client.listInvoices();
      if (!r.ok) throw r.error;
      return r.value;
    },
  });
}

/** Date locale du jour (DateOnly) — l'échéance d'une facture se juge en calendrier local, pas UTC. */
function localToday(): string {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

/**
 * Priorités du briefing « Aujourd'hui » (C10, amendement A1-C10) : compose les queries RÉELLES
 * (factures + devis + clients + diagnostic conformité) et projette via @bob/core deriveTodayPriorities
 * — l'agrégat métier se calcule dans le core, jamais dans l'écran. Aucun repli fixtures :
 * pas de données → zéro priorité (l'état vide est un état de premier rang).
 */
export function useTodayPriorities(): { priorities: TodayPriority[]; isLoading: boolean; isError: boolean } {
  const invoices = useInvoices();
  const quotes = useQuotes();
  const customers = useCustomers();
  const diagnostic = useDiagnostic();
  const today = localToday();

  const priorities = useMemo<TodayPriority[]>(() => {
    if (!invoices.data || !quotes.data || !customers.data) return [];
    return deriveTodayPriorities({
      invoices: invoices.data,
      quotes: quotes.data,
      customers: customers.data,
      // Signal conformité uniquement si le diagnostic réel a répondu — sinon on n'invente rien.
      ...(diagnostic.data ? { company: todayCompanyFromDiagnostic(diagnostic.data) } : {}),
      today,
    });
  }, [invoices.data, quotes.data, customers.data, diagnostic.data, today]);

  return {
    priorities,
    isLoading: invoices.isLoading || quotes.isLoading || customers.isLoading || diagnostic.isLoading,
    isError: invoices.isError || quotes.isError || customers.isError || diagnostic.isError,
  };
}

/** Fil de notifications réelles (C25) — la cloche C10 et l'écran /notifications partagent CETTE
 * dérivation (une seule vérité). Deux sources honnêtes (C25 v2) :
 * · items = GET /notifications — le SERVEUR est la source de vérité (lu/non-lu persistés) ; le
 *   LocalBobClient dérive localement en démo. La pastille de la cloche = NON-LUS de ce fil ;
 * · plan/échéances/conformité = agrégats @bob/core sur les queries partagées (actionnable). */
export interface NotificationsFeed {
  /** Fil serveur (relances envoyées/en retry, liens de signature) — récents d'abord. */
  items: NotificationView[];
  /** Non-lus du fil serveur = pastille de la cloche C10 (directive C25 v2). */
  unreadCount: number;
  /** Relances dues maintenant (palier atteint), tri du plan : retard puis montant. */
  due: RelancePlanEntry[];
  /** Relances planifiées (facture échue, premier palier pas encore atteint). */
  scheduled: RelancePlanEntry[];
  /** Échéances dans les 7 jours (pas encore en retard). */
  upcoming: UpcomingDueEntry[];
  /** Réception e-facture 2026 non configurée (signal réel du diagnostic — jamais inventé). */
  conformite: boolean;
  /** Items actionnables (dues + échéances + conformité) — états vides de l'écran. */
  count: number;
  isLoading: boolean;
  isError: boolean;
  refetch: () => void;
}

export function useNotificationsFeed(personality?: RelancePersonality): NotificationsFeed {
  const client = useBobClient();
  const invoices = useInvoices();
  const customers = useCustomers();
  const diagnostic = useDiagnostic();
  const today = localToday();

  // Fil serveur (source de vérité lu/non-lu) — même query key pour la cloche et l'écran.
  const feed = useQuery({
    queryKey: keys.notifications,
    queryFn: async () => {
      const r = await client.listNotifications();
      if (!r.ok) throw r.error;
      return r.value;
    },
  });

  const plan = useMemo<RelancePlanEntry[]>(() => {
    if (!invoices.data || !customers.data) return [];
    return deriveRelancePlan({
      invoices: invoices.data,
      customers: customers.data,
      today,
      ...(personality !== undefined ? { personality } : {}),
    });
  }, [invoices.data, customers.data, today, personality]);

  const upcoming = useMemo<UpcomingDueEntry[]>(() => {
    if (!invoices.data || !customers.data) return [];
    return deriveUpcomingDues({ invoices: invoices.data, customers: customers.data, today });
  }, [invoices.data, customers.data, today]);

  const due = plan.filter((e) => e.dueNow);
  const scheduled = plan.filter((e) => !e.dueNow);
  const conformite = diagnostic.data
    ? !todayCompanyFromDiagnostic(diagnostic.data).einvoiceReceptionConfigured
    : false;
  const items = feed.data ?? [];

  return {
    items,
    unreadCount: items.filter((n) => n.readAt === null).length,
    due,
    scheduled,
    upcoming,
    conformite,
    count: due.length + upcoming.length + (conformite ? 1 : 0),
    isLoading: invoices.isLoading || customers.isLoading || diagnostic.isLoading || feed.isLoading,
    isError: invoices.isError || customers.isError || diagnostic.isError || feed.isError,
    refetch: () => {
      void invoices.refetch();
      void customers.refetch();
      void diagnostic.refetch();
      void feed.refetch();
    },
  };
}

/** Marque une notification lue (POST /notifications/:id/read — persisté serveur, idempotent). */
export function useMarkNotificationRead() {
  const client = useBobClient();
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (id: string) => {
      const r = await client.markNotificationRead(id);
      if (!r.ok) throw r.error;
      return r.value;
    },
    onSuccess: () => void qc.invalidateQueries({ queryKey: keys.notifications }),
  });
}

/** Envoi RÉEL d'une relance ciblée (C25 ② — POST /invoices/:id/relance). À n'appeler qu'APRÈS
 * confirmation explicite (action sortante ; mise en demeure possible). Même endpoint que l'outil
 * agent envoyer_relance — parité d'actions. */
export function useSendRelance() {
  const client = useBobClient();
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (invoiceId: string) => {
      const r = await client.sendRelance(invoiceId);
      if (!r.ok) throw r.error;
      return r.value;
    },
    onSuccess: () => void qc.invalidateQueries({ queryKey: keys.notifications }),
  });
}

export function useInvoice(id: string) {
  const client = useBobClient();
  return useQuery({
    queryKey: keys.invoice(id),
    queryFn: async () => {
      const r = await client.getInvoice(id);
      if (!r.ok) throw r.error;
      return r.value;
    },
  });
}

export function useQuote(id: string) {
  const client = useBobClient();
  return useQuery({
    queryKey: keys.quote(id),
    queryFn: async () => {
      const r = await client.getQuote(id);
      if (!r.ok) throw r.error;
      return r.value;
    },
  });
}

/** Aperçu de l'écriture comptable d'une facture émise (411/70x/44571). `enabled` = ne fetch que si pertinent. */
export function useInvoiceAccountingPreview(id: string, enabled = true) {
  const client = useBobClient();
  return useQuery({
    queryKey: ['accounting-preview', id] as const,
    enabled,
    queryFn: async () => {
      const r = await client.invoiceAccountingPreview(id);
      if (!r.ok) throw r.error;
      return r.value;
    },
  });
}

/** Journal / grand livre : toutes les écritures comptables de la société (ventes, banque, OD…). */
export function useAccountingEntries() {
  const client = useBobClient();
  return useQuery({
    queryKey: ['accounting-entries'] as const,
    queryFn: async () => {
      const r = await client.listAccountingEntries();
      if (!r.ok) throw r.error;
      return r.value;
    },
  });
}

/** Export FEC (fichier des écritures comptables, conforme) sur une période — pour le cabinet comptable. */
export function useExportFec() {
  const client = useBobClient();
  return useMutation({
    mutationFn: async (input: { from: string; to: string }) => {
      const r = await client.exportFec(input);
      if (!r.ok) throw r.error;
      return r.value;
    },
  });
}

export function useCreateQuote() {
  const client = useBobClient();
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (input: Omit<CreateQuoteInput, 'companyId'>) => {
      const r = await client.createQuote(input);
      if (!r.ok) throw r.error;
      return r.value;
    },
    onSuccess: () => void qc.invalidateQueries({ queryKey: keys.quotes }),
  });
}

export function useSendQuote() {
  const client = useBobClient();
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (quoteId: string) => {
      const r = await client.sendQuote(quoteId);
      if (!r.ok) throw r.error;
      return r.value;
    },
    onSuccess: (_data, quoteId) => {
      void qc.invalidateQueries({ queryKey: keys.quotes });
      void qc.invalidateQueries({ queryKey: keys.quote(quoteId) });
    },
  });
}

export function useSignQuote() {
  const client = useBobClient();
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (input: { quoteId: string; signerName: string }) => {
      const r = await client.signQuote(input);
      if (!r.ok) throw r.error;
      return r.value;
    },
    onSuccess: (_data, input) => {
      void qc.invalidateQueries({ queryKey: keys.quotes });
      void qc.invalidateQueries({ queryKey: keys.quote(input.quoteId) });
    },
  });
}

export function useRefuseQuote() {
  const client = useBobClient();
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (quoteId: string) => {
      const r = await client.refuseQuote(quoteId);
      if (!r.ok) throw r.error;
      return r.value;
    },
    onSuccess: (_data, quoteId) => {
      void qc.invalidateQueries({ queryKey: keys.quotes });
      void qc.invalidateQueries({ queryKey: keys.quote(quoteId) });
    },
  });
}

export function useGenerateInvoice() {
  const client = useBobClient();
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (input: { quoteId: string; mode?: 'deposit' | 'final' }) => {
      const r = await client.generateInvoice(input);
      if (!r.ok) throw r.error;
      return r.value;
    },
    onSuccess: () => void qc.invalidateQueries({ queryKey: keys.invoices }),
  });
}

/** A6 : avoir TOTAL (brouillon) d'une facture émise — même use case que Bob (parité d'actions). */
export function useCreateCreditNote() {
  const client = useBobClient();
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (input: { invoiceId: string }) => {
      const r = await client.createCreditNote(input);
      if (!r.ok) throw r.error;
      return r.value;
    },
    onSuccess: () => void qc.invalidateQueries({ queryKey: keys.invoices }),
  });
}

export function useIssueInvoice() {
  const client = useBobClient();
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (invoiceId: string) => {
      const r = await client.issueInvoice({ invoiceId });
      if (!r.ok) throw r.error;
      return r.value;
    },
    onSuccess: (_data, invoiceId) => {
      void qc.invalidateQueries({ queryKey: keys.invoices });
      void qc.invalidateQueries({ queryKey: keys.invoice(invoiceId) });
    },
  });
}

export function useRegisterPayment() {
  const client = useBobClient();
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (input: RegisterPaymentClientInput) => {
      const r = await client.registerPayment(input);
      if (!r.ok) throw r.error;
      return r.value;
    },
    onSuccess: (_data, vars) => {
      void qc.invalidateQueries({ queryKey: keys.invoices });
      void qc.invalidateQueries({ queryKey: keys.invoice(vars.invoiceId) });
      // Un paiement change AUSSI l'encours client, la trésorerie et le journal comptable —
      // le briefing (KPI, héros) et la compta se rafraîchissent sans re-navigation (A2-C10).
      void qc.invalidateQueries({ queryKey: keys.customers });
      void qc.invalidateQueries({ queryKey: ['cashflow'] });
      void qc.invalidateQueries({ queryKey: ['accounting-entries'] });
    },
  });
}
