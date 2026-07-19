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
  RecordExpenseInput,
  PlanTier,
  TodayPriority,
  RelancePersonality,
  RelancePlanEntry,
  UpcomingDueEntry,
  UpdateQuoteLineInput,
  RemoveQuoteLineInput,
  Trade,
  VatRegime,
  CustomerPortfolio,
  CompanyBillingSettingsPatch,
  DiagnosticAssessmentWriteRequest,
} from '@bob/core';
import type {
  CreateCustomerClientInput,
  UpdateCustomerClientInput,
  NotificationView,
  RegisterPaymentClientInput,
  RecordExpensePaymentClientInput,
  RegularizeExpensePaymentClientInput,
  SearchSalesDocumentsClientInput,
  AttachQuotePurchaseOrderClientInput,
  DetachQuotePurchaseOrderClientInput,
  AttachInvoicePurchaseOrderClientInput,
  DetachInvoicePurchaseOrderClientInput,
} from '@bob/api-client';
import type { AppError } from '@bob/core';
import type { FiscalProfileFieldPatch, FiscalProfileView } from '@bob/core';
import { supabaseEnabled } from './supabase';
import { useAuth } from './auth';
import { useBobClient } from './client';
import { companyBillingSettingsQueryKey } from './billing-settings-query';

/** Ouvre une URL externe en remontant un échec à l'utilisateur (lien Stripe/paiement). */
function openUrl(url: string): void {
  if (!url) {
    Alert.alert('Lien indisponible', 'Aucun lien fourni. Réessaie plus tard.');
    return;
  }
  void Linking.openURL(url).catch(() =>
    Alert.alert('Lien indisponible', "Impossible d'ouvrir le lien."),
  );
}

/** Traduit une AppError en message utilisateur lisible (paywall, dépendance amont, introuvable, …). */
export function appErrorMessage(e: unknown): string {
  if (e && typeof e === 'object' && 'kind' in e) {
    const err = e as { kind: string; reason?: string };
    if (err.kind === 'forbidden') return err.reason ?? 'Action non autorisée pour ton offre.';
    if (err.kind === 'dependency')
      return 'Service indisponible pour le moment. Réessaie ou saisis les infos à la main.';
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
  bankBalance: ['bank-balance'] as const,
  quotes: ['quotes'] as const,
  invoices: ['invoices'] as const,
  invoice: (id: string) => ['invoice', id] as const,
  quote: (id: string) => ['quote', id] as const,
  notifications: ['notifications'] as const,
  notificationUnreadPreview: ['notifications', 'unread-preview'] as const,
  fiscalProfile: ['fiscal-profile'] as const,
  companyBillingSettings: companyBillingSettingsQueryKey,
  diagnosticAssessment: ['diagnostic-assessment'] as const,
  salesDocumentSearch: (input: SearchSalesDocumentsClientInput) =>
    ['sales-document-search', input] as const,
  salesDocumentSuggest: (query: string) => ['sales-document-suggest', query] as const,
};

export function useCompanyBillingSettings() {
  const { session } = useAuth();
  const client = useBobClient();
  return useQuery({
    queryKey: keys.companyBillingSettings(client.companyId),
    enabled: supabaseEnabled && !!session,
    queryFn: async () => {
      const result = await client.getCompanyBillingSettings();
      if (!result.ok) throw result.error;
      return result.value;
    },
  });
}

export function useUpdateCompanyBillingSettings() {
  const client = useBobClient();
  const queryClient = useQueryClient();
  const queryKey = keys.companyBillingSettings(client.companyId);
  return useMutation({
    mutationFn: async (input: {
      expectedRevision: number;
      patch: CompanyBillingSettingsPatch;
    }) => {
      const result = await client.updateCompanyBillingSettings(input);
      if (!result.ok) throw result.error;
      return result.value;
    },
    onSuccess: (settings) => {
      queryClient.setQueryData(queryKey, settings);
    },
    onError: () => {
      // Un 409 CAS ou une panne laisse l'ancien état visible, sans faux succès ; la relecture
      // remet ensuite l'écran sur la révision gagnante du serveur.
      void queryClient.invalidateQueries({ queryKey });
    },
  });
}

/** Politique staleTime par domaine (S8) : l'abonnement ne change que par un acte explicite
 * (checkout, portail de facturation) — ces mutateurs invalident la query ci-dessous. Entre deux,
 * aucun re-GET au retour d'écran : 15 min de fraîcheur assumée, invalidation-driven. */
const SUBSCRIPTION_STALE_TIME_MS = 15 * 60 * 1000;

export function useSubscription() {
  const client = useBobClient();
  return useQuery({
    queryKey: ['subscription'],
    staleTime: SUBSCRIPTION_STALE_TIME_MS,
    queryFn: async () => {
      const r = await client.getSubscription();
      if (!r.ok) throw r.error;
      return r.value;
    },
  });
}

export function useSubscriptionInvoices() {
  const client = useBobClient();
  return useQuery({
    queryKey: ['subscription-invoices'],
    queryFn: async () => {
      const r = await client.listSubscriptionInvoices();
      if (!r.ok) throw r.error;
      return r.value;
    },
  });
}

export function useStartCheckout() {
  const client = useBobClient();
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (tier: PlanTier) => {
      const r = await client.startCheckout(tier);
      if (!r.ok) throw r.error;
      return r.value;
    },
    onSuccess: (v) => {
      // L'achat se conclut HORS de l'app (navigateur Stripe) : on marque l'abonnement périmé
      // dès l'ouverture pour que le retour dans l'app relise l'état réel malgré le staleTime long.
      void qc.invalidateQueries({ queryKey: ['subscription'] });
      void qc.invalidateQueries({ queryKey: ['subscription-invoices'] });
      openUrl(v.url);
    },
    onError: alertError,
  });
}

export function useBillingPortal() {
  const client = useBobClient();
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async () => {
      const r = await client.billingPortal();
      if (!r.ok) throw r.error;
      return r.value;
    },
    onSuccess: (v) => {
      // Même doctrine que useStartCheckout : le portail peut changer l'offre hors de l'app.
      void qc.invalidateQueries({ queryKey: ['subscription'] });
      void qc.invalidateQueries({ queryKey: ['subscription-invoices'] });
      openUrl(v.url);
    },
    onError: alertError,
  });
}

/**
 * DELETE /account (Apple 5.1.1(v)) — clôture DÉFINITIVE du compte courant. Aucun onSuccess ici :
 * la composition (signOut() + retour login automatique via le gate de session) vit dans l'appelant
 * (CloseAccountSheet), pour rester séquencée avec la confirmation locale AVANT toute navigation.
 * Aucun alertError générique non plus : l'écran affiche l'erreur inline (texte de confirmation
 * erroné = le cas courant, pas une panne réseau à faire disparaître dans une alerte système).
 */
export function useCloseAccount() {
  const client = useBobClient();
  return useMutation({
    mutationFn: async (input: { confirmationText: string; reason?: string }) => {
      const r = await client.closeAccount(input);
      if (!r.ok) throw r.error;
      return r.value;
    },
  });
}

/**
 * Lien de paiement d'une facture — MÊME flux côté API dans les deux présentations.
 * · 'open' (défaut — tap « Lien de paiement », InvoiceActions) : le lien s'ouvre
 *   directement et l'échec s'affiche en Alert (comportement historique inchangé).
 * · 'manual' (parité vocale S5, facture/[id]) : l'appelant présente lui-même le lien
 *   (Share natif) et PARLE l'échec — le hook ne double ni l'ouverture ni l'alerte.
 */
export function useInvoicePaymentLink(presentation: 'open' | 'manual' = 'open') {
  const client = useBobClient();
  return useMutation({
    mutationFn: async (invoiceId: string) => {
      const r = await client.invoicePaymentLink(invoiceId);
      if (!r.ok) throw r.error;
      return r.value;
    },
    onSuccess: (v) => {
      if (presentation === 'open') openUrl(v.url);
    },
    onError: (e) => {
      if (presentation === 'open') alertError(e);
    },
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
    mutationFn: async (input: {
      name: string;
      customerId?: string | null;
      address?: string | null;
      notes?: string | null;
    }) => {
      const r = await client.createChantier(input);
      if (!r.ok) throw r.error;
      return r.value;
    },
    onSuccess: () => void qc.invalidateQueries({ queryKey: ['chantiers'] }),
    onError: alertError,
  });
}

/** Fiche chantier (extension V1) — journal de notes horodatées. */
export function useChantierNotes(chantierId: string, enabled = true) {
  const client = useBobClient();
  return useQuery({
    queryKey: ['chantier-notes', chantierId],
    enabled: enabled && chantierId.length > 0,
    queryFn: async () => {
      const r = await client.listChantierNotes(chantierId);
      if (!r.ok) throw r.error;
      return r.value;
    },
  });
}

export function useAddChantierNote(chantierId: string) {
  const client = useBobClient();
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (input: { text: string }) => {
      const r = await client.addChantierNote(chantierId, input);
      if (!r.ok) throw r.error;
      return r.value;
    },
    onSuccess: () => void qc.invalidateQueries({ queryKey: ['chantier-notes', chantierId] }),
    onError: alertError,
  });
}

/** Fiche chantier (extension V1) — grille de photos, octets via DocumentStoragePort. */
export function useWorksitePhotos(chantierId: string, enabled = true) {
  const client = useBobClient();
  return useQuery({
    queryKey: ['chantier-photos', chantierId],
    enabled: enabled && chantierId.length > 0,
    queryFn: async () => {
      const r = await client.listWorksitePhotos(chantierId);
      if (!r.ok) throw r.error;
      return r.value;
    },
  });
}

export function useUploadWorksitePhoto(chantierId: string) {
  const client = useBobClient();
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (input: { contentBase64: string; mimeType: string; filename: string }) => {
      const r = await client.uploadWorksitePhoto(chantierId, input);
      if (!r.ok) throw r.error;
      return r.value;
    },
    onSuccess: () => void qc.invalidateQueries({ queryKey: ['chantier-photos', chantierId] }),
    onError: alertError,
  });
}

export function useDeleteWorksitePhoto(chantierId: string) {
  const client = useBobClient();
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (photoId: string) => {
      const r = await client.deleteWorksitePhoto(photoId);
      if (!r.ok) throw r.error;
      return r.value;
    },
    onSuccess: () => void qc.invalidateQueries({ queryKey: ['chantier-photos', chantierId] }),
    onError: alertError,
  });
}

/** URL de visualisation signée (5 min, TTL serveur) — une requête par photo, réutilisée pour la
 * vignette ET le plein écran (mêmes octets, pas de rendition dédiée). */
export function useWorksitePhotoUrl(photoId: string, enabled = true) {
  const client = useBobClient();
  return useQuery({
    queryKey: ['chantier-photo-url', photoId],
    enabled: enabled && photoId.length > 0,
    staleTime: 4 * 60 * 1000,
    queryFn: async () => {
      const r = await client.worksitePhotoViewUrl(photoId);
      if (!r.ok) throw r.error;
      return r.value;
    },
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

/** Fiche société RÉELLE du tenant en mode connecté — GET /company/me (PONT-SERVEUR ④).
 *  Query PARTAGÉE ['company-me'] (une seule définition, un seul cache) : useIdentity
 *  (identity.ts) et l'écran Argent (C-EXP-UI2 — ligne cotisations du grand-livre) la
 *  consomment tous les deux. Absence/échec → data undefined, jamais un nom ou une provision
 *  inventés. */
export function useCompanyMe() {
  const { session } = useAuth();
  const client = useBobClient();
  return useQuery({
    queryKey: ['company-me'],
    enabled: supabaseEnabled && !!session,
    staleTime: 24 * 60 * 60 * 1000, // la fiche société bouge rarement
    queryFn: async () => {
      const r = await client.getCompanyMe();
      if (!r.ok) throw r.error;
      return r.value;
    },
  });
}

export function useUpdateCompanyProfile() {
  const client = useBobClient();
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (input: {
      trade: Trade;
      vatRegime: VatRegime;
      customerPortfolio?: CustomerPortfolio;
    }) => {
      const result = await client.updateCompanyProfile(input);
      if (!result.ok) throw result.error;
      return result.value;
    },
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['company-me'] });
      void queryClient.invalidateQueries({ queryKey: ['profile'] });
      void queryClient.invalidateQueries({ queryKey: ['fiscal-calendar'] });
      void queryClient.invalidateQueries({ queryKey: ['diagnostic'] });
    },
  });
}

/** Réglages facturation §Coordonnées bancaires — écrit iban/bic (PATCH /company/billing). */
export function useUpdateCompanyBilling() {
  const client = useBobClient();
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (input: { iban?: string | null; bic?: string | null }) => {
      const result = await client.updateCompanyBilling(input);
      if (!result.ok) throw result.error;
      return result.value;
    },
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['company-me'] });
    },
  });
}

/** Encaissements datés (listPayments, socle E3) — l'assiette du CA encaissé : la provision
 *  URSSAF micro (C-EXP-UI2) se dérive de CES paiements dans @bob/core (buildLedgerView). */
export function usePayments() {
  const client = useBobClient();
  return useQuery({
    queryKey: ['payments'],
    queryFn: async () => {
      const r = await client.listPayments();
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
    // S8 : dérivé de la fiche société + du profil fiscal — invalidé par leurs mutateurs
    // (useUpdateCompanyProfile, useUpdateFiscalProfileField). Pas de re-GET par navigation.
    staleTime: 15 * 60 * 1000,
    queryFn: async () => {
      const r = await client.getFiscalCalendar();
      if (!r.ok) throw r.error;
      return r.value;
    },
  });
}

/** BOB EXPERT FISCAL Phase 1B (SPEC_EXPERT_FISCAL.md §UX FLOW) : GET /fiscal-profile — chaque
 * champ porte son statut (source_fiable/confirme_utilisateur/hypothese/manquant, @bob/core
 * FiscalDatum). Consommée par la carte Argent, le badge Home, l'écran « Mon profil fiscal » et
 * le mini-flow — UNE seule query partagée (même clé), jamais un profil recalculé par écran. */
export function useFiscalProfile() {
  const client = useBobClient();
  return useQuery({
    queryKey: keys.fiscalProfile,
    queryFn: async () => {
      const r = await client.getFiscalProfile();
      if (!r.ok) throw r.error;
      return r.value;
    },
  });
}

/** PATCH /fiscal-profile/:field — confirme/corrige UN champ (statut → confirme_utilisateur).
 * La réponse est le profil COMPLET à jour : on l'écrit directement dans le cache (setQueryData)
 * plutôt que d'invalider — le serveur fait déjà autorité, pas besoin d'un aller-retour de plus
 * (mini-flow enchaîne plusieurs patches d'affilée, chaque écran doit voir l'état imMédiat). */
export function useUpdateFiscalProfileField() {
  const client = useBobClient();
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (patch: FiscalProfileFieldPatch) => {
      const r = await client.updateFiscalProfileField(patch.field, patch.value);
      if (!r.ok) throw r.error;
      return r.value;
    },
    onSuccess: (profile: FiscalProfileView) => {
      qc.setQueryData(keys.fiscalProfile, profile);
      // S8 : périodicité/régime confirmés changent les échéances dérivées — sans cette
      // invalidation, le calendrier fiscal (staleTime 15 min) resterait périmé après le mini-flow.
      void qc.invalidateQueries({ queryKey: ['fiscal-calendar'] });
    },
  });
}

export function useDiagnostic() {
  const client = useBobClient();
  return useQuery({
    queryKey: ['diagnostic'],
    // S8 : le diagnostic conformité ne bouge qu'avec la fiche société (useUpdateCompanyProfile
    // l'invalide) — 15 min de fraîcheur assumée, pas de re-GET à chaque retour d'écran.
    staleTime: 15 * 60 * 1000,
    queryFn: async () => {
      const r = await client.getDiagnostic();
      if (!r.ok) throw r.error;
      return r.value;
    },
  });
}

/** Résultat terminé en BDD. `never_run` et `stale` restent des états explicites et sans score. */
export function useDiagnosticAssessment() {
  const client = useBobClient();
  return useQuery({
    queryKey: keys.diagnosticAssessment,
    queryFn: async () => {
      const result = await client.getDiagnosticAssessment();
      if (!result.ok) throw result.error;
      return result.value;
    },
  });
}

/** Sauvegarde finale : le serveur revalide les réponses et recalcule score/axes depuis PostgreSQL. */
export function useSaveDiagnosticAssessment() {
  const client = useBobClient();
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (input: DiagnosticAssessmentWriteRequest) => {
      const result = await client.saveDiagnosticAssessment(input);
      if (!result.ok) throw result.error;
      return result.value;
    },
    onSuccess: (assessment) => {
      queryClient.setQueryData(keys.diagnosticAssessment, assessment);
    },
    onError: () => {
      void queryClient.invalidateQueries({ queryKey: keys.diagnosticAssessment });
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
      // La création poste AUSSI l'écriture comptable de la dépense dans la même transaction
      // (RecordExpenseAccountingEntries, cf. expense-creation-coordinator.ts) : Pilotage (SIG)
      // et le grand-livre Argent seraient périmés sans cette invalidation (audit correction 1).
      void qc.invalidateQueries({ queryKey: ['accounting-entries'] });
      void qc.invalidateQueries({ queryKey: ['cashflow'] });
    },
  });
}

/** Enregistrer un règlement déjà réalisé — preuve explicite ; rafraîchit charges, journal et tréso. */
export function usePayExpense() {
  const client = useBobClient();
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (input: RecordExpensePaymentClientInput) => {
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

/** Régulariser une ligne HISTORIQUE payée sans preuve — pose l'écriture 401/512-530 manquante. */
export function useRegularizeExpensePayment() {
  const client = useBobClient();
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (input: RegularizeExpensePaymentClientInput) => {
      const r = await client.regularizeExpensePayment(input);
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

/** Édition post-création (C13/C40 TODO partagé) — la fiche permet de compléter/corriger ce que
 * la création MINIMALE n'a pas saisi (adresse, SIREN, contact…). Remplacement complet. */
export function useUpdateCustomer() {
  const client = useBobClient();
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (input: { id: string; patch: UpdateCustomerClientInput }) => {
      const r = await client.updateCustomer(input.id, input.patch);
      if (!r.ok) throw r.error;
      return r.value;
    },
    onSuccess: () => void qc.invalidateQueries({ queryKey: keys.customers }),
    onError: alertError,
  });
}

export function useCashflow(scenario: Scenario, horizon: Horizon) {
  const client = useBobClient();
  return useQuery({
    queryKey: keys.cashflow(scenario, horizon),
    // S8 — invalidation-driven : TOUTES les mutations qui déplacent la trésorerie invalident
    // ['cashflow'] (recordExpense/payExpense/regularize, issueInvoice/registerPayment,
    // generateInvoice, recordManualBankBalance, flux scan/documents, refreshAfterAction de
    // l'assistant). Entre deux mutations, la projection est stable : 5 min sans re-GET.
    staleTime: 5 * 60 * 1000,
    queryFn: async () => {
      const r = await client.getCashflow({ scenario, horizon });
      if (!r.ok) throw r.error;
      return r.value;
    },
  });
}

export function useLatestBankBalance() {
  const client = useBobClient();
  return useQuery({
    queryKey: keys.bankBalance,
    queryFn: async () => {
      const r = await client.getLatestBankBalance();
      if (!r.ok) throw r.error;
      return r.value;
    },
  });
}

export function useRecordManualBankBalance() {
  const client = useBobClient();
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (input: { amountCents: number; observedAt: string }) => {
      const r = await client.recordManualBankBalance(input);
      if (!r.ok) throw r.error;
      return r.value;
    },
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: keys.bankBalance });
      void qc.invalidateQueries({ queryKey: ['cashflow'] });
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

/** B9 — GET /documents/search : source de vérité serveur des résultats FILTRÉS (recherche
 * ultra-rapide pg_trgm). `enabled` piloté par l'appelant (ventes.tsx n'interroge le serveur QUE
 * quand au moins un filtre est actif — sinon la liste complète déjà en cache local suffit). */
export function useSalesDocumentSearch(input: SearchSalesDocumentsClientInput, enabled: boolean) {
  const client = useBobClient();
  return useQuery({
    queryKey: keys.salesDocumentSearch(input),
    queryFn: async () => {
      const r = await client.searchSalesDocuments(input);
      if (!r.ok) throw r.error;
      return r.value;
    },
    enabled,
  });
}

/** B9 — GET /documents/suggest : autocomplétion typée, appelée par l'appelant déjà DEBOUNCED
 * (~250 ms) — cette couche ne fait qu'exposer l'état de chargement/erreur react-query. */
export function useSalesDocumentSuggestions(query: string, enabled: boolean) {
  const client = useBobClient();
  return useQuery({
    queryKey: keys.salesDocumentSuggest(query),
    queryFn: async () => {
      const r = await client.suggestSalesDocuments(query);
      if (!r.ok) throw r.error;
      return r.value;
    },
    enabled,
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
export interface TodayPrioritiesQuery {
  priorities: TodayPriority[];
  isLoading: boolean;
  isRefetching: boolean;
  isError: boolean;
  refetch: () => void;
}

export function useTodayPriorities(): TodayPrioritiesQuery {
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
    isLoading:
      invoices.isLoading || quotes.isLoading || customers.isLoading || diagnostic.isLoading,
    isRefetching:
      invoices.isRefetching ||
      quotes.isRefetching ||
      customers.isRefetching ||
      diagnostic.isRefetching,
    isError: invoices.isError || quotes.isError || customers.isError || diagnostic.isError,
    refetch: () => {
      void invoices.refetch();
      void quotes.refetch();
      void customers.refetch();
      void diagnostic.refetch();
    },
  };
}

/** Fil de notifications réelles (C25) — la cloche C10 et l'écran /notifications partagent CETTE
 * dérivation (une seule vérité). Deux sources honnêtes (C25 v2) :
 * · items = GET /notifications — le SERVEUR est la source de vérité (lu/non-lu persistés).
 *   La pastille de la cloche = NON-LUS de ce fil ;
 * · plan/échéances/conformité = agrégats @bob/core sur les queries partagées (actionnable). */
export interface NotificationsFeed {
  /** Fil serveur (relances envoyées/en retry, liens de signature) — récents d'abord. */
  items: NotificationView[];
  /** Non-lus du fil serveur = pastille de la cloche C10 (directive C25 v2). */
  /** null tant que le fil n'a pas répondu ou s'il est en erreur — jamais ramené à zéro. */
  unreadCount: number | null;
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
  isRefetching: boolean;
  isError: boolean;
  refetch: () => void;
  /** S8 : recharge le SEUL fil serveur (lu/non-lu) — le pull-to-refresh du dashboard s'en sert
   * pour ne pas re-GET factures/clients/diagnostic qui vivent sur leur propre politique. */
  refetchFeed: () => void;
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
    unreadCount: feed.data === undefined ? null : items.filter((n) => n.readAt === null).length,
    due,
    scheduled,
    upcoming,
    conformite,
    count: due.length + upcoming.length + (conformite ? 1 : 0),
    isLoading: invoices.isLoading || customers.isLoading || diagnostic.isLoading || feed.isLoading,
    isRefetching:
      invoices.isRefetching ||
      customers.isRefetching ||
      diagnostic.isRefetching ||
      feed.isRefetching,
    isError: invoices.isError || customers.isError || diagnostic.isError || feed.isError,
    refetch: () => {
      void invoices.refetch();
      void customers.refetch();
      void diagnostic.refetch();
      void feed.refetch();
    },
    refetchFeed: () => {
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

/** Portée serveur exacte d'un « tout marquer comme lu » ; indépendante de la pagination du fil. */
export function useUnreadNotificationsPreview() {
  const client = useBobClient();
  return useQuery({
    queryKey: keys.notificationUnreadPreview,
    queryFn: async () => {
      const r = await client.previewUnreadNotifications();
      if (!r.ok) throw r.error;
      return r.value;
    },
  });
}

/** Confirme la portée figée par useUnreadNotificationsPreview en une mutation atomique. */
export function useMarkNotificationsReadThrough() {
  const client = useBobClient();
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (throughCreatedAt: string) => {
      const r = await client.markNotificationsReadThrough({ throughCreatedAt });
      if (!r.ok) throw r.error;
      return r.value;
    },
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: keys.notifications });
      void qc.invalidateQueries({ queryKey: keys.notificationUnreadPreview });
    },
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

/**
 * P0 R4 : « Envoyer le lien » ne doit RIEN envoyer — prépare/rotate le lien de signature SANS
 * e-mail ni outbox (POST /quotes/:id/signature-link). Le partage (Share natif) reste côté
 * appelant : l'annuler = rien n'est parti. Aucune invalidation : cette commande ne change ni
 * le statut du devis ni ses montants.
 */
export function useCreateQuoteSignatureLink() {
  const client = useBobClient();
  return useMutation({
    mutationFn: async (quoteId: string) => {
      const r = await client.createQuoteSignatureLink(quoteId);
      if (!r.ok) throw r.error;
      return r.value;
    },
  });
}

/**
 * Lien public de VISUALISATION (devis) — canal d'envoi universel, sans e-mail requis. Même
 * doctrine SANS AUCUN sortant que useCreateQuoteSignatureLink : cette commande ne fait que
 * préparer/rotate le lien ; le partage (Share natif) reste côté appelant.
 */
export function useCreateQuoteViewLink() {
  const client = useBobClient();
  return useMutation({
    mutationFn: async (quoteId: string) => {
      const r = await client.createQuoteViewLink(quoteId);
      if (!r.ok) throw r.error;
      return r.value;
    },
  });
}

/** Lien public de VISUALISATION (facture) — même doctrine que useCreateQuoteViewLink. */
export function useCreateInvoiceViewLink() {
  const client = useBobClient();
  return useMutation({
    mutationFn: async (invoiceId: string) => {
      const r = await client.createInvoiceViewLink(invoiceId);
      if (!r.ok) throw r.error;
      return r.value;
    },
  });
}

export function useSignQuote() {
  const client = useBobClient();
  const qc = useQueryClient();
  return useMutation({
    /** R4 : `proofDataUrl` = tracé du pad — le serveur en calcule le hash de preuve. */
    mutationFn: async (input: { quoteId: string; signerName: string; proofDataUrl?: string }) => {
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
    mutationFn: async (input: { quoteId: string; mode: 'deposit' | 'final' }) => {
      const r = await client.generateInvoice(input);
      if (!r.ok) throw r.error;
      return r.value;
    },
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: keys.invoices });
      // Filet défensif (audit correction 1) : la facture générée reste BROUILLON (aucune
      // écriture comptable avant issueInvoice), donc cashflow/journal ne changent pas encore
      // en pratique — mais on s'aligne sur la même invalidation que les autres écritures de
      // vente pour ne jamais dépendre de cet invariant si le flow évolue (ex. génération
      // auto-émise). Coût nul : re-fetch d'une donnée inchangée.
      void qc.invalidateQueries({ queryKey: ['cashflow'] });
      void qc.invalidateQueries({ queryKey: ['accounting-entries'] });
    },
  });
}

/** R6 : édition d'une ligne de devis BROUILLON (swipe → Sheet, ou affordance vocale qui l'ouvre). */
export function useUpdateQuoteLine() {
  const client = useBobClient();
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (input: UpdateQuoteLineInput) => {
      const r = await client.updateQuoteLine(input);
      if (!r.ok) throw r.error;
      return r.value;
    },
    onSuccess: (_data, input) => {
      void qc.invalidateQueries({ queryKey: keys.quotes });
      void qc.invalidateQueries({ queryKey: keys.quote(input.quoteId) });
    },
  });
}

/** R6 : suppression d'une ligne de devis BROUILLON (swipe → ConfirmSheet destructive). */
export function useRemoveQuoteLine() {
  const client = useBobClient();
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (input: RemoveQuoteLineInput) => {
      const r = await client.removeQuoteLine(input);
      if (!r.ok) throw r.error;
      return r.value;
    },
    onSuccess: (_data, input) => {
      void qc.invalidateQueries({ queryKey: keys.quotes });
      void qc.invalidateQueries({ queryKey: keys.quote(input.quoteId) });
    },
  });
}

// ── B8 : bon de commande grands comptes (numéro d'engagement) ────────────────────────────
// Saisi UNE FOIS sur le devis, repris sur la facture dérivée — mêmes use cases que Bob
// (attach/detach-purchase-order, révision optimiste). Un client antérieur à B8 n'expose pas
// ces méthodes (interface optionnelle) : on échoue fermé avec une AppError standard.

/** Client sans support B8 (version antérieure) → AppError `unavailable` (fail-closed). */
function purchaseOrderUnavailable(): AppError {
  return { kind: 'unavailable', service: 'purchase-order' };
}

/** PUT /quotes/:id/purchase-order — attache (ou remplace) la référence sur un devis non facturé. */
export function useAttachQuotePurchaseOrder() {
  const client = useBobClient();
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (input: AttachQuotePurchaseOrderClientInput) => {
      if (!client.attachQuotePurchaseOrder) throw purchaseOrderUnavailable();
      const r = await client.attachQuotePurchaseOrder(input);
      if (!r.ok) throw r.error;
      return r.value;
    },
    onSuccess: (_data, input) => {
      void qc.invalidateQueries({ queryKey: keys.quotes });
      void qc.invalidateQueries({ queryKey: keys.quote(input.quoteId) });
    },
  });
}

/** DELETE /quotes/:id/purchase-order — retrait explicite (devis non facturé uniquement). */
export function useDetachQuotePurchaseOrder() {
  const client = useBobClient();
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (input: DetachQuotePurchaseOrderClientInput) => {
      if (!client.detachQuotePurchaseOrder) throw purchaseOrderUnavailable();
      const r = await client.detachQuotePurchaseOrder(input);
      if (!r.ok) throw r.error;
      return r.value;
    },
    onSuccess: (_data, input) => {
      void qc.invalidateQueries({ queryKey: keys.quotes });
      void qc.invalidateQueries({ queryKey: keys.quote(input.quoteId) });
    },
  });
}

/** PUT /invoices/:id/purchase-order — facture BROUILLON uniquement (figé à l'émission). */
export function useAttachInvoicePurchaseOrder() {
  const client = useBobClient();
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (input: AttachInvoicePurchaseOrderClientInput) => {
      if (!client.attachInvoicePurchaseOrder) throw purchaseOrderUnavailable();
      const r = await client.attachInvoicePurchaseOrder(input);
      if (!r.ok) throw r.error;
      return r.value;
    },
    onSuccess: (_data, input) => {
      void qc.invalidateQueries({ queryKey: keys.invoices });
      void qc.invalidateQueries({ queryKey: keys.invoice(input.invoiceId) });
    },
  });
}

/** DELETE /invoices/:id/purchase-order — retrait explicite (facture brouillon uniquement). */
export function useDetachInvoicePurchaseOrder() {
  const client = useBobClient();
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (input: DetachInvoicePurchaseOrderClientInput) => {
      if (!client.detachInvoicePurchaseOrder) throw purchaseOrderUnavailable();
      const r = await client.detachInvoicePurchaseOrder(input);
      if (!r.ok) throw r.error;
      return r.value;
    },
    onSuccess: (_data, input) => {
      void qc.invalidateQueries({ queryKey: keys.invoices });
      void qc.invalidateQueries({ queryKey: keys.invoice(input.invoiceId) });
    },
  });
}

/** R6 : suppression définitive d'une facture BROUILLON (erreur détectée après génération). */
export function useDeleteDraftInvoice() {
  const client = useBobClient();
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (invoiceId: string) => {
      const r = await client.deleteDraftInvoice(invoiceId);
      if (!r.ok) throw r.error;
      return r.value;
    },
    onSuccess: (_data, invoiceId) => {
      void qc.invalidateQueries({ queryKey: keys.invoices });
      void qc.invalidateQueries({ queryKey: keys.invoice(invoiceId) });
    },
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
      // L'émission poste l'écriture comptable (RecordIssuedInvoiceAccountingEntry,
      // backend.service.ts::issueInvoice) ET fait passer la facture en 'issued' — donc entre
      // AUSSI dans les créances de GetCashflow (statuts issued/partially_paid/late). Sans ces
      // deux invalidations, Pilotage (SIG) et Argent (grand-livre/trésorerie) restaient périmés
      // jusqu'à 30 s (audit correction 1).
      void qc.invalidateQueries({ queryKey: ['accounting-entries'] });
      void qc.invalidateQueries({ queryKey: ['cashflow'] });
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
      // …et l'assiette URSSAF micro (C-EXP-UI2) : la provision suit chaque encaissement.
      void qc.invalidateQueries({ queryKey: ['payments'] });
    },
  });
}
