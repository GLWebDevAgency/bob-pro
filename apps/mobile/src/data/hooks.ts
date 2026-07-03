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
import type { CreateCustomerClientInput, RegisterPaymentClientInput } from '@bob/api-client';
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
 * dérivation (une seule vérité). Agrégats @bob/core (deriveRelancePlan + deriveUpcomingDues +
 * diagnostic réel) sur les queries partagées — aucun repli fixtures : pas de données, pas d'items. */
export interface NotificationsFeed {
  /** Relances dues maintenant (palier atteint), tri du plan : retard puis montant. */
  due: RelancePlanEntry[];
  /** Relances planifiées (facture échue, premier palier pas encore atteint). */
  scheduled: RelancePlanEntry[];
  /** Échéances dans les 7 jours (pas encore en retard). */
  upcoming: UpcomingDueEntry[];
  /** Réception e-facture 2026 non configurée (signal réel du diagnostic — jamais inventé). */
  conformite: boolean;
  /** Items « à signaler » (badge non-lu de la cloche) : dues + échéances + conformité. */
  count: number;
  isLoading: boolean;
  isError: boolean;
  refetch: () => void;
}

export function useNotificationsFeed(personality?: RelancePersonality): NotificationsFeed {
  const invoices = useInvoices();
  const customers = useCustomers();
  const diagnostic = useDiagnostic();
  const today = localToday();

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

  return {
    due,
    scheduled,
    upcoming,
    conformite,
    count: due.length + upcoming.length + (conformite ? 1 : 0),
    isLoading: invoices.isLoading || customers.isLoading || diagnostic.isLoading,
    isError: invoices.isError || customers.isError || diagnostic.isError,
    refetch: () => {
      void invoices.refetch();
      void customers.refetch();
      void diagnostic.refetch();
    },
  };
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
    },
  });
}
