import { Linking, Alert } from 'react-native';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import type { Scenario, Horizon, CreateQuoteInput, PaymentMethod, RecordExpenseInput, PlanTier } from '@bob/core';
import { useBobClient } from './client';

/** Ouvre une URL externe en remontant un échec à l'utilisateur (lien Stripe/paiement). */
function openUrl(url: string): void {
  if (!url) {
    Alert.alert('Lien indisponible', 'Aucun lien fourni. Réessaie plus tard.');
    return;
  }
  void Linking.openURL(url).catch(() => Alert.alert('Lien indisponible', "Impossible d'ouvrir le lien."));
}

/** Traduit une AppError en message utilisateur (paywall, dépendance, …). */
function alertError(e: unknown): void {
  let message = 'Action impossible. Réessaie.';
  if (e && typeof e === 'object' && 'kind' in e) {
    const err = e as { kind: string; reason?: string };
    if (err.kind === 'forbidden') message = err.reason ?? 'Action non autorisée pour ton offre.';
  }
  Alert.alert('Oups', message);
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

export function useChantiers() {
  const client = useBobClient();
  return useQuery({
    queryKey: ['chantiers'],
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
    onSuccess: () => void qc.invalidateQueries({ queryKey: keys.quotes }),
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
    onSuccess: () => void qc.invalidateQueries({ queryKey: keys.quotes }),
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
    onSuccess: () => void qc.invalidateQueries({ queryKey: keys.invoices }),
  });
}

export function useRegisterPayment() {
  const client = useBobClient();
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (input: { invoiceId: string; amount: number; method: PaymentMethod }) => {
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
