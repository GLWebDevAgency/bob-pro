import { useEffect, useMemo, useRef, useState } from 'react';
import { ScrollView, TextInput, View, Text, Pressable } from 'react-native';
import { useLocalSearchParams, useRouter } from 'expo-router';
import { Ionicons } from '@expo/vector-icons';
import { challengeFor } from '@bob/ai';
import { formatEUR, normalizeVoiceText, type SalesDocumentSearchScope } from '@bob/core';
import { t } from '@bob/i18n';
import type { QuoteView, InvoiceView, SearchSalesDocumentsClientInput } from '@bob/api-client';
import { appErrorMessage, useCustomers, useQuotes, useInvoices, useSalesDocumentSearch, useSalesDocumentSuggestions } from '../src/data/hooks';
import { usePublishAgentContext, type AgentContext, type AgentSurface } from '../src/agent';
import { frDateLabel } from '@bob/ai';
// Extinction Lot 3 (plan DA 01/08) : dernier gros consommateur de src/components/ui —
// Card/Badge/MoneyText/SectionHeader/font viennent du kit, les badges par la table FIGÉE
// du Lot 0 (statusBadgeVariantForLegacyTone : identité sur 6 tones, 'ai' → 'ai').
import {
  BackHeader,
  Button,
  Card,
  DeleteIconButton,
  EmptyState,
  ErrorRetry,
  FilterChip,
  MoneyText,
  PressableScale,
  SectionHeader,
  SegmentedControl,
  SkeletonRow,
  StaggeredList,
  StatusBadge,
  font,
  statusBadgeVariantForLegacyTone,
  useErrorSheet,
  useTheme,
} from '@bob/ui';
import { combineQueryStates } from '../src/data/query-state';
import {
  QuoteActions,
  InvoiceActions,
  hasQuoteActions,
  hasInvoiceActions,
  invoiceListBadgeFor,
  QUOTE_BADGE,
  INVOICE_BADGE,
  type QuoteLinkedInvoices,
} from '../src/components/DocumentActions';
import { pieceDetail } from '@bob/tokens';
import { useBobAwareScrollInsets } from '../src/components/use-bob-aware-scroll-insets';
import { useConfirm } from '../src/components/ConfirmSheet';
import { hasMeaningfulQuoteDraft, useQuoteDraft } from '../src/quote-draft';
import { salesDocumentMatchesActiveSearch } from '../src/data/sales-search-result-policy';
import { useSalesDocumentVoiceAffordance } from '../src/documents-voice-search';
import { parseSalesDocumentRouteParams } from '../src/data/documents-search-route-params';
import { DateRangeChips, type DateRangeValue } from '../src/components/DateRangeChips';
import { DocumentSearchAutocomplete, useRecentSalesSearches } from '../src/components/DocumentSearchAutocomplete';
import {
  DocumentSearchFiltersModal,
  EMPTY_ADVANCED_FILTERS,
  type AdvancedSearchFilters,
} from '../src/components/DocumentSearchFiltersModal';

const SEARCH_DEBOUNCE_MS = 250;

// Suppression d'un brouillon = geste réversible-fort (même palier que le trash « brouillon »
// des factures, InvoiceActions) — TOUJOURS derrière une ConfirmSheet, jamais un tap unique.
const DRAFT_DELETE_RISK = { mutating: true, outbound: false, riskTier: 'reversible' } as const;

type QuoteStatus = QuoteView['status'];
type InvoiceStatus = InvoiceView['status'];

// Actionnable en premier : les brouillons/à traiter remontent, le terminé descend.
const QUOTE_ORDER: Record<QuoteStatus, number> = { draft: 0, sent: 1, viewed: 1, signed: 2, refused: 4, expired: 4 };
const INVOICE_ORDER: Record<InvoiceStatus, number> = { draft: 0, late: 1, issued: 2, partially_paid: 2, paid: 4, cancelled: 4 };

export default function Ventes() {
  const { colors, semantic, personality, theme } = useTheme();
  const router = useRouter();
  const bobScrollInsets = useBobAwareScrollInsets({ minimumBottom: 40 });

  const customers = useCustomers();
  const quotes = useQuotes();
  const invoices = useInvoices();
  const quoteDraft = useQuoteDraft();
  const confirm = useConfirm();
  const [draftDeleteBusy, setDraftDeleteBusy] = useState(false);

  const nameOf = (customerId: string) => (customers.data ?? []).find((c) => c.id === customerId)?.name ?? '—';

  // Brouillon propriétaire : slot PostgreSQL distinct de `quotes`, hydraté par GET avant rendu.
  // `pendingResume` prime uniquement comme vue mémoire de ce slot après un soft-reset du wizard.
  const persistedDraft = quoteDraft.persistence.ready
    ? quoteDraft.pendingResume
      ?? (hasMeaningfulQuoteDraft(quoteDraft.state) && quoteDraft.state.saved !== null
        ? quoteDraft.state
        : null)
    : null;
  const persistedDraftName = persistedDraft?.customer?.name ?? null;
  // Grammaire d'erreur (plan DA 01/08) : tout échec de mutation appelable au support.
  const { showError, errorSheet } = useErrorSheet();
  const deletePersistedDraft = async (): Promise<void> => {
    if (draftDeleteBusy) return;
    const ok = await confirm({
      title: t('ventes.draftCard.deleteConfirmTitle', { personality }),
      message: t('ventes.draftCard.deleteConfirmBody', {
        personality,
        params: { name: persistedDraftName ?? t('ventes.draftCard.noCustomer', { personality }) },
      }),
      challenge: challengeFor(DRAFT_DELETE_RISK, 'confirm_all'),
      destructive: true,
    });
    if (!ok) return;
    setDraftDeleteBusy(true);
    try {
      await quoteDraft.discard();
    } catch (e) {
      // LE catch manquant (correction d'état sous freeze, plan Lot 3) : un échec réseau de
      // suppression ne produisait RIEN — trou dans un système d'états par ailleurs exemplaire.
      showError(t('ventes.draftCard.deleteErrorTitle', { personality }), appErrorMessage(e));
    } finally {
      setDraftDeleteBusy(false);
    }
  };

  // failed se lit TOUJOURS avec loading (combineQueryStates) — un échec réseau ne devient
  // jamais silencieusement « zéro devis/facture » (classe de bug P0 de l'audit états).
  const queryState = combineQueryStates(quotes, invoices, customers);
  // Pending VISIBLE du « Réessayer » (ErrorRetry) — jamais un bouton muet qui refetch en douce.
  const ventesRefetching = quotes.isRefetching || invoices.isRefetching || customers.isRefetching;
  const ventesDataReady =
    !queryState.loading &&
    !queryState.failed &&
    quotes.data !== undefined &&
    invoices.data !== undefined &&
    customers.data !== undefined;

  // ── Filtre + recherche PLEIN TEXTE (n°, client, LIGNES — « chauffe-eau » retrouve la
  //    facture même sans se souvenir du client). Accents/casse ignorés, données déjà locales. ──
  const [kindFilter, setKindFilter] = useState<'all' | 'quotes' | 'invoices'>('all');
  const [query, setQuery] = useState('');
  const normalizedQuery = normalizeVoiceText(query).trim();
  const localMatches = (number: string | null, customerId: string, lines: readonly { label: string }[]): boolean => {
    if (normalizedQuery === '') return true;
    const haystack = normalizeVoiceText(
      `${number ?? ''} ${nameOf(customerId)} ${lines.map((l) => l.label).join(' ')}`,
    );
    return normalizedQuery.split(' ').every((word) => haystack.includes(word));
  };

  // ── B9 — recherche intelligente serveur (pg_trgm) : chips de dates, filtre client/statut
  //    avancés, autocomplétion, parité vocale par route params. Le texte tapé + les filtres
  //    avancés/chips restent TOUJOURS combinables avec kindFilter (toggle devis/factures déjà
  //    existant) — un seul jeu de résultats, jamais deux systèmes de filtre qui divergent. ──
  const routeParams = useLocalSearchParams<{ type?: string; from?: string; to?: string; customerId?: string; status?: string }>();
  const [debouncedQuery, setDebouncedQuery] = useState('');
  const [dateRange, setDateRange] = useState<DateRangeValue | null>(null);
  const [advancedCustomerId, setAdvancedCustomerId] = useState<string | null>(null);
  const [advancedStatus, setAdvancedStatus] = useState<string | null>(null);
  const [filtersModalOpen, setFiltersModalOpen] = useState(false);
  const [suggestOpen, setSuggestOpen] = useState(false);
  const { recent: recentSearches, push: pushRecentSearch } = useRecentSalesSearches();

  // Deep link vocal (« retrouve les devis de Mairie de Sèvres du mois dernier ») : LA clé de la
  // parité — Bob navigue ici avec des paramètres de route, cet effet les traduit en filtres via
  // parseSalesDocumentRouteParams (pure, testée isolément dans documents-search-route-params.test.ts).
  useEffect(() => {
    const parsed = parseSalesDocumentRouteParams(routeParams);
    if (parsed.kindFilter !== null) setKindFilter(parsed.kindFilter);
    if (parsed.dateRange !== null) setDateRange(parsed.dateRange);
    if (parsed.customerId !== null) setAdvancedCustomerId(parsed.customerId);
    if (parsed.status !== null) setAdvancedStatus(parsed.status);
  }, [routeParams.type, routeParams.from, routeParams.to, routeParams.customerId, routeParams.status]);

  useEffect(() => {
    const timeout = setTimeout(() => setDebouncedQuery(query.trim()), SEARCH_DEBOUNCE_MS);
    return () => clearTimeout(timeout);
  }, [query]);

  const searchScope: SalesDocumentSearchScope = kindFilter === 'quotes' ? 'quote' : kindFilter === 'invoices' ? 'invoice' : 'all';
  const hasServerFilters = debouncedQuery.length >= 2 || advancedCustomerId !== null || dateRange !== null || advancedStatus !== null;
  const searchInput: SearchSalesDocumentsClientInput = {
    query: debouncedQuery,
    scope: searchScope,
    limit: 50,
    ...(advancedCustomerId !== null ? { customerId: advancedCustomerId } : {}),
    ...(advancedStatus !== null ? { status: advancedStatus } : {}),
    ...(dateRange !== null ? { from: dateRange.from, to: dateRange.to } : {}),
  };
  const serverSearch = useSalesDocumentSearch(searchInput, hasServerFilters);
  const matchedIds = hasServerFilters && serverSearch.data ? new Set(serverSearch.data.hits.map((h) => h.id)) : null;
  const serverSearchBlockingError = hasServerFilters
    && serverSearch.isError
    && serverSearch.data === undefined;
  const serverSearchStaleError = hasServerFilters
    && serverSearch.isError
    && serverSearch.data !== undefined;

  const suggestQuery = debouncedQuery;
  const suggest = useSalesDocumentSuggestions(suggestQuery, suggestOpen && suggestQuery.length > 0);

  const matches = (id: string, number: string | null, customerId: string, lines: readonly { label: string }[]): boolean => {
    const local = localMatches(number, customerId, lines);
    return salesDocumentMatchesActiveSearch({
      id,
      localMatch: local,
      hasServerFilters,
      serverMatchedIds: matchedIds,
    });
  };
  const sortedQuotes = [...(quotes.data ?? [])]
    .filter((q) => kindFilter !== 'invoices' && matches(q.id, q.number, q.customerId, q.lines))
    .sort((a, b) => QUOTE_ORDER[a.status] - QUOTE_ORDER[b.status]);
  const sortedInvoices = [...(invoices.data ?? [])]
    .filter((i) => kindFilter !== 'quotes' && matches(i.id, i.number, i.customerId, i.lines))
    .sort((a, b) => INVOICE_ORDER[a.status] - INVOICE_ORDER[b.status]);

  const activeAdvancedCustomerName = advancedCustomerId !== null ? nameOf(advancedCustomerId) : null;
  const statusOptions = kindFilter === 'quotes'
    ? Object.entries(QUOTE_BADGE).map(([value, { label }]) => ({ value, label }))
    : kindFilter === 'invoices'
      ? Object.entries(INVOICE_BADGE).map(([value, { label }]) => ({ value, label }))
      : [];
  const statusLabel = advancedStatus !== null ? statusOptions.find((s) => s.value === advancedStatus)?.label ?? advancedStatus : null;
  const advancedInitial: AdvancedSearchFilters = {
    ...EMPTY_ADVANCED_FILTERS,
    customerId: advancedCustomerId,
    customerName: activeAdvancedCustomerName,
    dateRange,
    status: advancedStatus,
  };
  const applyAdvancedFilters = (filters: AdvancedSearchFilters): void => {
    setAdvancedCustomerId(filters.customerId);
    setAdvancedStatus(filters.status);
    setDateRange(filters.dateRange);
    const composedQuery = [filters.number, filters.label].filter((s) => s.trim().length > 0).join(' ');
    if (composedQuery.length > 0) setQuery(composedQuery);
  };
  const hasActiveFilterChips = advancedCustomerId !== null || dateRange !== null || advancedStatus !== null || debouncedQuery.length > 0;
  const dateRangeChipLabel =
    dateRange === null
      ? null
      : dateRange.preset === 'thisMonth'
        ? t('ventes.dateChip.thisMonth', { personality })
        : dateRange.preset === 'lastMonth'
          ? t('ventes.dateChip.lastMonth', { personality })
          : dateRange.preset === 'last2Months'
            ? t('ventes.dateChip.last2Months', { personality })
            : t('ventes.dateChip.customRange', {
                personality,
                params: { from: frDateLabel(dateRange.from), to: frDateLabel(dateRange.to) },
              });
  /** Croix des FilterChip — libellé i18n composé (« Retirer ce filtre — {label} »). */
  const removeFilterLabel = (label: string): string =>
    `${t('ventes.activeFilter.remove', { personality })} — ${label}`;

  // Liaison devis ↔ factures : chips discrètes automatiques sur chaque pièce.
  const invoicesOfQuote = (quoteId: string) =>
    (invoices.data ?? [])
      .filter((i) => i.parentQuoteId === quoteId)
      .sort((a, b) => (a.kind === 'deposit' ? 0 : 1) - (b.kind === 'deposit' ? 0 : 1));
  // R3/R5 : les 3 états RÉELS du CTA post-signature (QuoteActions) — un booléen « une facture
  // existe » était trop grossier pour distinguer acompte-sans-finale (bouton solde) de finale (badge).
  const linkedInvoicesOfQuote = (quoteId: string): QuoteLinkedInvoices => {
    const linked = invoicesOfQuote(quoteId);
    const deposit = linked.find((invoice) => invoice.kind === 'deposit') ?? null;
    const final = linked.find((invoice) => invoice.kind === 'final') ?? null;
    return {
      hasDepositInvoice: deposit !== null,
      hasFinalInvoice: final !== null,
      depositStatus: deposit?.status ?? null,
      finalStatus: final?.status ?? null,
    };
  };
  const quoteOf = (inv: InvoiceView) => (quotes.data ?? []).find((q) => q.id === inv.parentQuoteId) ?? null;
  // E6 : factures CRÉDITÉES — dérivé en UNE passe des avoirs déjà chargés dans la liste
  // (identité figée creditNoteSource, jamais le devis parent ambigu, jamais de N+1). Seul un
  // avoir réellement ÉMIS marque sa source (un brouillon d'avoir n'annule encore rien).
  const creditedInvoiceIds = new Set(
    (invoices.data ?? [])
      .filter(
        (i) =>
          i.kind === 'credit_note' &&
          i.status !== 'draft' &&
          i.status !== 'cancelled' &&
          i.creditNoteSource != null,
      )
      .map((i) => i.creditNoteSource!.invoiceId),
  );
  const kindChip = (inv: InvoiceView): string => {
    if (inv.kind === 'deposit') {
      const pct = quoteOf(inv)?.depositPct ?? null;
      return pct !== null
        ? t('ventes.chipAcompte', { personality, params: { pct } })
        : t('ventes.chipAcompteSimple', { personality });
    }
    if (inv.kind === 'credit_note') return t('ventes.chipAvoir', { personality });
    if (inv.kind === 'situation') return t('ventes.chipSituation', { personality });
    return t('ventes.chipFinale', { personality });
  };

  // ── Voix (parité) : « retrouve les factures avec un chauffe-eau » filtre CET écran. ──
  const setFiltersRef = useRef({ setKindFilter, setQuery });
  setFiltersRef.current = { setKindFilter, setQuery };
  const dataRef = useRef({ quotes: quotes.data ?? [], invoices: invoices.data ?? [], nameOf });
  dataRef.current = { quotes: quotes.data ?? [], invoices: invoices.data ?? [], nameOf };
  const ventesDataReadyRef = useRef(ventesDataReady);
  ventesDataReadyRef.current = ventesDataReady;
  const personalityRef = useRef(personality);
  personalityRef.current = personality;
  // ── Parité vocale du brouillon persistant (« continue mon brouillon » / « supprime le brouillon »)
  // — la suppression reste TOUJOURS derrière la ConfirmSheet, jamais un tap voix unique
  // (verrouillage fondateur : aucune suppression en un seul geste, nulle part).
  const hasPersistedDraftRef = useRef(persistedDraft !== null);
  hasPersistedDraftRef.current = persistedDraft !== null;
  const routerRef = useRef(router);
  routerRef.current = router;
  const deletePersistedDraftRef = useRef(deletePersistedDraft);
  deletePersistedDraftRef.current = deletePersistedDraft;
  const salesDocumentVoiceAffordance = useSalesDocumentVoiceAffordance(personality);
  const ventesSurface = useMemo<AgentSurface>(
    () => ({
      affordances: [
        // B9 — priorité au deep link période/client (« retrouve les devis de Mairie de Sèvres
        // du mois dernier ») : ne matche que si période ET/OU client sont reconnus, sinon rend
        // la main à ventes.search (filtre texte local) juste en dessous.
        salesDocumentVoiceAffordance,
        {
          id: 'ventes.resumeDraft',
          match: (utterance) => {
            if (!hasPersistedDraftRef.current) return null;
            const n = normalizeVoiceText(utterance);
            if (!/(continue|reprend\w*).{0,15}(devis|brouillon)/.test(n)) return null;
            return () => {
              routerRef.current.push('/devis/new?resume=1');
              return { say: t('ventes.voiceDraftResume', { personality: personalityRef.current }) };
            };
          },
        },
        {
          id: 'ventes.deleteDraft',
          match: (utterance) => {
            if (!hasPersistedDraftRef.current) return null;
            const n = normalizeVoiceText(utterance);
            if (!/(supprime|efface)\w*.{0,15}(devis|brouillon)/.test(n)) return null;
            return () => {
              void deletePersistedDraftRef.current();
              return { say: t('ventes.voiceDraftDeleteOpened', { personality: personalityRef.current }) };
            };
          },
        },
        {
          id: 'ventes.filterKind',
          match: (utterance) => {
            const n = normalizeVoiceText(utterance);
            const wantsQuotes = /(que|seulement|uniquement).{0,12}devis|devis seulement/.test(n);
            const wantsInvoices = /(que|seulement|uniquement).{0,12}factures?|factures? seulement/.test(n);
            const wantsAll = /(tout afficher|affiche tout|montre tout|enleve (le|les) filtre)/.test(n);
            if (!wantsQuotes && !wantsInvoices && !wantsAll) return null;
            return () => {
              setFiltersRef.current.setKindFilter(wantsAll ? 'all' : wantsQuotes ? 'quotes' : 'invoices');
              return { say: t('ventes.voiceFilterKind', { personality: personalityRef.current }) };
            };
          },
        },
        {
          id: 'ventes.search',
          match: (utterance) => {
            const n = normalizeVoiceText(utterance).trim();
            const m = /^(?:retrouve|cherche|trouve|filtre)(?:[- ]moi)?(?: les| la| le| mes)?(?: factures?| devis)?(?: ou j ai| avec| pour| sur| de| du| des| contenant)? (.+)$/.exec(n);
            if (!m || m[1] === undefined) return null;
            const spoken = m[1].replace(/^(un|une|le|la|les|l) /, '').trim();
            if (spoken.length < 3) return null;
            return () => {
              if (!ventesDataReadyRef.current) {
                return { say: t('docs.dataError', { personality: personalityRef.current }) };
              }
              setFiltersRef.current.setQuery(spoken);
              const { quotes: qs, invoices: is, nameOf: name } = dataRef.current;
              const hay = (number: string | null, customerId: string, lines: readonly { label: string }[]) =>
                normalizeVoiceText(`${number ?? ''} ${name(customerId)} ${lines.map((l) => l.label).join(' ')}`);
              const words = spoken.split(' ');
              const count =
                qs.filter((q) => words.every((w) => hay(q.number, q.customerId, q.lines).includes(w))).length +
                is.filter((i) => words.every((w) => hay(i.number, i.customerId, i.lines).includes(w))).length;
              return {
                say: t('ventes.voiceFiltered', {
                  personality: personalityRef.current,
                  params: { query: spoken, count },
                }),
              };
            };
          },
        },
      ],
    }),
    [salesDocumentVoiceAffordance],
  );
  const ventesContextReady =
    ventesDataReady
    && (!hasServerFilters || (serverSearch.data !== undefined && !serverSearch.isError));
  const ventesAgentContext = useMemo<AgentContext>(() => {
    const qs = ventesContextReady ? sortedQuotes.slice(0, 8) : [];
    const is = ventesContextReady ? sortedInvoices.slice(0, 8) : [];
    return {
      screen: { name: 'ventes', instanceId: 'ventes' },
      entities: [
        ...qs.map((q) => ({ type: 'quote' as const, id: q.id, label: q.number ? `Devis ${q.number}` : 'Devis brouillon' })),
        ...is.map((i) => ({ type: 'invoice' as const, id: i.id, label: i.number ? `Facture ${i.number}` : 'Facture brouillon' })),
      ],
      capabilities: ventesContextReady ? ['screen.read', 'quote.read', 'invoice.read'] : [],
    };
  }, [sortedInvoices, sortedQuotes, ventesContextReady]);
  usePublishAgentContext(ventesAgentContext, undefined, ventesSurface);

  return (
    <View style={{ flex: 1, backgroundColor: colors.bg }}>
      {/* Lot 3 : bloc retour + titre ad hoc → BackHeader kit (voile v2 hérité, retour 44 pt
          nommé « Accueil », i18n « Devis & Factures ») — mêmes textes qu'avant, en clés. */}
      <BackHeader
        backLabel={t('ventes.back', { personality })}
        onBack={() => router.back()}
        eyebrow={t('ventes.eyebrow', { personality })}
        title={t('ventes.headerTitle', { personality })}
      />

      <ScrollView
        contentContainerStyle={{
          padding: 20,
          paddingTop: 8,
          gap: 20,
          paddingBottom: bobScrollInsets.paddingBottom,
        }}
        scrollIndicatorInsets={{ bottom: bobScrollInsets.scrollIndicatorBottom }}
        automaticallyAdjustKeyboardInsets={bobScrollInsets.automaticallyAdjustKeyboardInsets}
        keyboardShouldPersistTaps="handled"
      >
        {/* Filtres + recherche plein texte (n°, client, prestations) — TOUJOURS montés (parité
            vocale : « retrouve les factures avec un chauffe-eau » pilote les mêmes états) ;
            seul le CORPS des sections en dessous bascule skeleton → erreur → données. */}
        <View style={{ gap: 10 }}>
          {/* PURGE DE L'INDIGO DÉVOYÉ (plan DA 01/08, Lot 3) : le kindFilter parle le
              SegmentedControl kit — l'indigo redevient le canal EXCLUSIF « Bob agit ».
              Le state ventes.filterKind est STRICTEMENT conservé (parité vocale) ; tant
              que les données ne sont pas servies, le contrôle est inerte (garde onChange
              + voile 0.5), exactement comme les anciennes pilules désactivées. */}
          <View
            pointerEvents={ventesDataReady ? 'auto' : 'none'}
            style={{ opacity: ventesDataReady ? 1 : 0.5 }}
          >
            <SegmentedControl
              options={[
                { key: 'all', label: t('ventes.filterAll', { personality }) },
                { key: 'quotes', label: t('ventes.filterQuotes', { personality }) },
                { key: 'invoices', label: t('ventes.filterInvoices', { personality }) },
              ]}
              value={kindFilter}
              onChange={(key) => {
                if (!ventesDataReady) return;
                setKindFilter(key);
              }}
              accessibilityLabel={t('ventes.filterKindLabel', { personality })}
            />
          </View>
          <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8 }}>
            <TextInput
              value={query}
              onChangeText={setQuery}
              editable={ventesDataReady}
              onFocus={() => setSuggestOpen(true)}
              onBlur={() => setSuggestOpen(false)}
              placeholder={t('ventes.searchPlaceholder', { personality })}
              placeholderTextColor={colors.slate400}
              accessibilityLabel={t('ventes.searchPlaceholder', { personality })}
              autoCorrect={false}
              style={[
                font('body'),
                {
                  flex: 1,
                  minHeight: 44,
                  color: colors.ink900,
                  borderWidth: 1,
                  borderColor: colors.line,
                  borderRadius: 12,
                  paddingHorizontal: 12,
                  backgroundColor: colors.surface,
                },
              ]}
            />
            {/* Filtres actifs = sélection UTILISATEUR : bord theme.ink (arbitrage), plus
                jamais l'indigo aiBg — l'indigo reste à Bob. */}
            <Pressable
              accessibilityRole="button"
              accessibilityLabel={t('ventes.searchAdvancedButton', { personality })}
              accessibilityState={{ disabled: !ventesDataReady }}
              disabled={!ventesDataReady}
              onPress={() => setFiltersModalOpen(true)}
              style={({ pressed }) => ({
                width: 44,
                height: 44,
                borderRadius: 12,
                borderWidth: 1,
                borderColor: hasActiveFilterChips ? theme.ink : colors.line,
                backgroundColor: colors.surface,
                alignItems: 'center',
                justifyContent: 'center',
                opacity: !ventesDataReady ? 0.5 : pressed ? 0.7 : 1,
                transform: [{ scale: pressed && ventesDataReady ? 0.95 : 1 }],
              })}
            >
              <Ionicons name="options-outline" size={20} color={hasActiveFilterChips ? theme.ink : colors.ink800} />
            </Pressable>
          </View>
          {suggestOpen && ventesDataReady ? (
            <DocumentSearchAutocomplete
              query={query}
              suggestions={suggest.data?.suggestions}
              loading={suggest.isLoading && query.trim().length > 0}
              recentQueries={recentSearches}
              onSelectSuggestion={(suggestion) => {
                if (suggestion.kind === 'customer') {
                  const found = (customers.data ?? []).find((c) => c.name === suggestion.value);
                  if (found) setAdvancedCustomerId(found.id);
                  setQuery('');
                } else {
                  setQuery(suggestion.value);
                  pushRecentSearch(suggestion.value);
                }
                setSuggestOpen(false);
              }}
              onSelectRecent={(recentQuery) => {
                setQuery(recentQuery);
                setSuggestOpen(false);
              }}
            />
          ) : null}
          {ventesDataReady ? (
            <DateRangeChips
              value={dateRange}
              onChange={setDateRange}
              today={new Date().toISOString().slice(0, 10)}
            />
          ) : null}
          {hasActiveFilterChips ? (
            // B9 — chips de filtre actif : FilterChip kit (sélection theme.ink, croix 44).
            <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 8 }}>
              {debouncedQuery.length > 0 ? (
                <FilterChip
                  label={debouncedQuery}
                  onRemove={() => setQuery('')}
                  removeAccessibilityLabel={removeFilterLabel(debouncedQuery)}
                />
              ) : null}
              {activeAdvancedCustomerName !== null ? (
                <FilterChip
                  label={t('ventes.activeFilter.customer', { personality, params: { name: activeAdvancedCustomerName } })}
                  onRemove={() => setAdvancedCustomerId(null)}
                  removeAccessibilityLabel={removeFilterLabel(
                    t('ventes.activeFilter.customer', { personality, params: { name: activeAdvancedCustomerName } }),
                  )}
                />
              ) : null}
              {dateRangeChipLabel !== null ? (
                <FilterChip
                  label={dateRangeChipLabel}
                  onRemove={() => setDateRange(null)}
                  removeAccessibilityLabel={removeFilterLabel(dateRangeChipLabel)}
                />
              ) : null}
              {statusLabel !== null ? (
                <FilterChip
                  label={statusLabel}
                  onRemove={() => setAdvancedStatus(null)}
                  removeAccessibilityLabel={removeFilterLabel(statusLabel)}
                />
              ) : null}
            </View>
          ) : null}
          {serverSearchBlockingError || serverSearchStaleError ? (
            <ErrorRetry
              message={t('docs.dataError', { personality })}
              onRetry={() => void serverSearch.refetch()}
              retrying={serverSearch.isRefetching}
            />
          ) : null}
          {!queryState.loading &&
          !queryState.failed &&
          !serverSearch.isError &&
          (hasServerFilters ? !serverSearch.isLoading : normalizedQuery !== '') &&
          sortedQuotes.length + sortedInvoices.length === 0 ? (
            <Text style={[font('sub'), { color: colors.slate500 }]}>
              {t('ventes.noResults', { personality })}
            </Text>
          ) : null}
        </View>

        <DocumentSearchFiltersModal
          key={`${advancedInitial.customerId ?? ''}|${advancedInitial.dateRange?.from ?? ''}|${advancedInitial.dateRange?.to ?? ''}|${advancedInitial.status ?? ''}`}
          visible={filtersModalOpen && ventesDataReady}
          onClose={() => setFiltersModalOpen(false)}
          onApply={applyAdvancedFilters}
          initial={advancedInitial}
          customers={customers.data ?? []}
          statusOptions={statusOptions}
          today={new Date().toISOString().slice(0, 10)}
        />

        {kindFilter !== 'invoices' ? (
          <View>
            <SectionHeader title="Devis" />
            {/* Slot de brouillon PostgreSQL — visible seulement après hydratation réussie,
                indépendamment de la liste des pièces (un seul slot propriétaire possible). */}
            {persistedDraft !== null ? (
              <Card style={{ marginBottom: 10, borderColor: semantic.warning }}>
                <View style={{ flexDirection: 'row', justifyContent: 'space-between', alignItems: 'flex-start' }}>
                  <View style={{ flex: 1, paddingRight: 12 }}>
                    <Text style={[font('cardTitle'), { color: colors.ink900 }]}>
                      {persistedDraftName ?? t('ventes.draftCard.noCustomer', { personality })}
                    </Text>
                    <Text style={[font('meta'), { color: colors.slate400, marginTop: 2 }]}>
                      {t('ventes.draftCard.subtitle', { personality })}
                    </Text>
                  </View>
                  {/* Casse au composant (StatusBadge 11/700) — fin du .toUpperCase() ad hoc. */}
                  <StatusBadge label={t('ventes.draftCard.badge', { personality })} variant="warning" />
                </View>
                <View style={{ flexDirection: 'row', gap: 8, marginTop: 12 }}>
                  {/* Le CTA le plus chaud de l'écran : press feedback standard du Button kit
                      (l'aplat artisanal ink900 n'avait pas la matière du kit). */}
                  <Button
                    title={t('ventes.draftCard.resume', { personality })}
                    radius={12}
                    style={{ flex: 1 }}
                    onPress={() => router.push('/devis/new?resume=1')}
                  />
                  {/* Corbeille canonique @bob/ui — même composant que DocumentActions/C27
                      (flux ConfirmSheet + busy STRICTEMENT conservé). */}
                  <DeleteIconButton
                    icon={<Ionicons name="trash-outline" size={18} color={semantic.danger} />}
                    accessibilityLabel={t('ventes.draftCard.delete', { personality })}
                    size={44}
                    radius={12}
                    loading={draftDeleteBusy}
                    disabled={draftDeleteBusy}
                    onPress={() => void deletePersistedDraft()}
                  />
                </View>
              </Card>
            ) : null}
            {queryState.loading || (hasServerFilters && serverSearch.isLoading) ? (
              <View style={{ gap: 10 }}>
                <SkeletonRow lines={2} trailing="text" />
                <SkeletonRow lines={2} trailing="text" />
                <SkeletonRow lines={2} trailing="text" />
              </View>
            ) : queryState.failed ? (
              <ErrorRetry
                message={t('ventes.dataError', { personality })}
                onRetry={queryState.refetchAll}
                retrying={ventesRefetching}
              />
            ) : serverSearchBlockingError ? null : sortedQuotes.length === 0 ? (
              // Vide de PREMIER PAS uniquement (aucun filtre actif) : recherche vide = la ligne
              // « noResults » au-dessus parle déjà — pas de double message.
              normalizedQuery === '' && !hasServerFilters ? (
                <Card>
                  <EmptyState
                    title={t('ventes.emptyQuotesTitle', { personality })}
                    body={t('ventes.emptyQuotesBody', { personality })}
                    icon={<Ionicons name="document-text-outline" size={17} color={semantic.success} />}
                    {...(persistedDraft === null
                      ? {
                          cta: {
                            label: t('ventes.emptyQuotesCta', { personality }),
                            onPress: () => router.push('/devis/new'),
                          },
                        }
                      : {})}
                  />
                </Card>
              ) : null
            ) : (
              // FadeIn de bloc → StaggeredList PAR CARTE (cascade 40 ms, cap 8, au montage
              // seulement — reduce-motion et préférence non résolue : apparition immédiate).
              <View style={{ gap: 10 }}>
                <StaggeredList>
                  {sortedQuotes.map((q) => {
                    const badge = QUOTE_BADGE[q.status];
                    return (
                      <Card key={q.id}>
                        <Pressable
                          onPress={() => router.push(`/devis/${q.id}`)}
                          accessibilityRole="button"
                          accessibilityLabel={`Devis ${q.number ?? 'brouillon'} — ${nameOf(q.customerId)}`}
                          style={({ pressed }) => ({
                            flexDirection: 'row',
                            justifyContent: 'space-between',
                            alignItems: 'flex-start',
                            opacity: pressed ? 0.65 : 1,
                          })}
                        >
                          <View style={{ flex: 1, paddingRight: 12 }}>
                            <Text style={[font('cardTitle'), { color: colors.ink900 }]}>{q.number ?? 'Brouillon'}</Text>
                            <Text style={[font('meta'), { color: colors.slate400, marginTop: 2 }]}>{nameOf(q.customerId)}</Text>
                            {q.validUntil !== null ? (
                              <Text style={[font('meta'), { color: colors.slate400, marginTop: 2 }]}>
                                {t('ventes.validUntil', { personality, params: { date: frDateLabel(q.validUntil) } })}
                              </Text>
                            ) : null}
                            {invoicesOfQuote(q.id).length > 0 ? (
                              // Chips liées : NAVIGATION, pas « Bob agit » — l'indigo rendu à
                              // Bob, ton neutre (parité chip devis des cartes facture) ;
                              // cible ≥ 28 pt + hitSlop 8 (→ 44) + press feedback standard.
                              <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 6, marginTop: 6 }}>
                                {invoicesOfQuote(q.id).map((li) => (
                                  <PressableScale
                                    key={li.id}
                                    accessibilityRole="button"
                                    accessibilityLabel={`Facture ${li.number ?? ''}`}
                                    hitSlop={8}
                                    onPress={() => router.push(`/facture/${li.id}`)}
                                    style={{
                                      minHeight: 28,
                                      minWidth: 28,
                                      justifyContent: 'center',
                                      borderWidth: 1,
                                      borderColor: colors.line,
                                      borderRadius: 999,
                                      paddingHorizontal: 9,
                                      paddingVertical: 3,
                                    }}
                                  >
                                    <Text style={[font('meta', 600), { color: colors.slate500 }]}>
                                      {li.number ?? '—'} · {formatEUR(li.totals.netToPay)}
                                    </Text>
                                  </PressableScale>
                                ))}
                              </View>
                            ) : null}
                          </View>
                          <View style={{ alignItems: 'flex-end', gap: 6 }}>
                            <MoneyText cents={q.totals.ttc} />
                            <StatusBadge label={badge.label} variant={statusBadgeVariantForLegacyTone(badge.tone)} />
                          </View>
                        </Pressable>
                        {hasQuoteActions(q) ? (
                          <View style={{ marginTop: 12 }}>
                            <QuoteActions
                              quote={q}
                              customerName={nameOf(q.customerId)}
                              customerType={
                                (customers.data ?? []).find((customer) => customer.id === q.customerId)
                                  ?.type ?? null
                              }
                              linkedInvoices={linkedInvoicesOfQuote(q.id)}
                            />
                          </View>
                        ) : null}
                      </Card>
                    );
                  })}
                </StaggeredList>
              </View>
              )}
          </View>
        ) : null}

        {kindFilter !== 'quotes' ? (
          <View>
            <SectionHeader
              title="Factures"
              action={
                // B1 : entrée du flux « facture directe » là où le flux naturel l'attend —
                // wizard allégé client → lignes → récap (facture SANS devis signé).
                <Pressable
                  accessibilityRole="button"
                  accessibilityLabel={t('fd.entryVentes', { personality })}
                  onPress={() => router.push('/facture/new')}
                  style={({ pressed }) => ({
                    flexDirection: 'row',
                    alignItems: 'center',
                    gap: 5,
                    minHeight: 44,
                    paddingHorizontal: 12,
                    borderRadius: 999,
                    borderWidth: 1,
                    borderColor: semantic.ai,
                    backgroundColor: semantic.aiBg,
                    opacity: pressed ? 0.7 : 1,
                  })}
                >
                  <Ionicons name="add" size={15} color={semantic.aiInk} />
                  <Text style={[font('meta'), { fontWeight: '700', color: semantic.aiInk }]}>
                    {t('fd.entryVentes', { personality })}
                  </Text>
                </Pressable>
              }
            />
            {queryState.loading || (hasServerFilters && serverSearch.isLoading) ? (
              <View style={{ gap: 10 }}>
                <SkeletonRow lines={2} trailing="text" />
                <SkeletonRow lines={2} trailing="text" />
                <SkeletonRow lines={2} trailing="text" />
                <SkeletonRow lines={2} trailing="text" />
              </View>
            ) : queryState.failed ? (
              kindFilter === 'invoices' ? (
                <ErrorRetry
                  message={t('ventes.dataError', { personality })}
                  onRetry={queryState.refetchAll}
                  retrying={ventesRefetching}
                />
              ) : null
            ) : serverSearchBlockingError ? null : sortedInvoices.length === 0 ? (
              normalizedQuery === '' && !hasServerFilters ? (
                <Card>
                  <EmptyState body={t('ventes.emptyInvoicesBody', { personality })} />
                </Card>
              ) : null
            ) : (
              <View style={{ gap: 10 }}>
                <StaggeredList>
                  {sortedInvoices.map((inv) => {
                    // E5 : badge dérivé par kind — avoir émis = « Émis » AMBRE (masculin).
                    // PR-02 : pièce émise JAMAIS transmise (aucun envoi constaté, aucun dépôt
                    // déclaré) = AMBRE « À transmettre » — impossible à rater dans la liste.
                    const badge = invoiceListBadgeFor(inv, personality);
                    // Assiette = netToPay (acompte si depositPct) : montant réellement encaissable sur la facture.
                    const remaining = Math.max(0, inv.totals.netToPay - inv.paid);
                    const showRemaining = remaining > 0 && remaining !== inv.totals.netToPay;
                    return (
                      <Card key={inv.id}>
                        <Pressable
                          onPress={() => router.push(`/facture/${inv.id}`)}
                          accessibilityRole="button"
                          accessibilityLabel={`Facture ${inv.number ?? 'brouillon'} — ${nameOf(inv.customerId)}`}
                          style={({ pressed }) => ({
                            flexDirection: 'row',
                            justifyContent: 'space-between',
                            alignItems: 'flex-start',
                            opacity: pressed ? 0.65 : 1,
                          })}
                        >
                          <View style={{ flex: 1, paddingRight: 12 }}>
                            <Text style={[font('cardTitle'), { color: colors.ink900 }]}>{inv.number ?? 'Brouillon'}</Text>
                            <Text style={[font('meta'), { color: colors.slate400, marginTop: 2 }]}>{nameOf(inv.customerId)}</Text>
                            <Text style={[font('meta'), { color: colors.slate400, marginTop: 2 }]}>
                              {[
                                inv.issuedAt ? t('ventes.issuedOn', { personality, params: { date: frDateLabel(inv.issuedAt) } }) : null,
                                inv.dueAt ? t('ventes.dueOn', { personality, params: { date: frDateLabel(inv.dueAt) } }) : null,
                              ]
                                .filter(Boolean)
                                .join(' · ')}
                            </Text>
                            <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 6, marginTop: 6 }}>
                              {/* Chip de nature : information neutre — l'indigo rendu à Bob ;
                                  ≥ 28 pt, cran meta 12 (fin du 11 ad hoc). */}
                              <View
                                style={{
                                  minHeight: 28,
                                  justifyContent: 'center',
                                  borderWidth: 1,
                                  borderColor: colors.line,
                                  borderRadius: 999,
                                  paddingHorizontal: 9,
                                  paddingVertical: 3,
                                }}
                              >
                                <Text style={[font('meta', 600), { color: colors.slate500 }]}>
                                  {kindChip(inv)}
                                </Text>
                              </View>
                              {/* E6 : la facture CRÉDITÉE se reconnaît d'un coup d'œil — tag
                                  ambre « Avoir émis » (mêmes tokens que la carte avoir). */}
                              {inv.kind !== 'credit_note' && creditedInvoiceIds.has(inv.id) ? (
                                <View
                                  style={{
                                    minHeight: 28,
                                    justifyContent: 'center',
                                    borderWidth: 1,
                                    borderColor: pieceDetail.creditBorder,
                                    backgroundColor: semantic.warningBg,
                                    borderRadius: 999,
                                    paddingHorizontal: 9,
                                    paddingVertical: 3,
                                  }}
                                >
                                  <Text style={[font('meta', 600), { color: pieceDetail.creditInk }]}>
                                    {t('ventes.tagAvoirEmis', { personality })}
                                  </Text>
                                </View>
                              ) : null}
                              {quoteOf(inv) !== null ? (
                                <PressableScale
                                  accessibilityRole="button"
                                  accessibilityLabel={`Devis ${quoteOf(inv)?.number ?? ''}`}
                                  hitSlop={8}
                                  onPress={() => router.push(`/devis/${inv.parentQuoteId}`)}
                                  style={{
                                    minHeight: 28,
                                    minWidth: 28,
                                    justifyContent: 'center',
                                    borderWidth: 1,
                                    borderColor: colors.line,
                                    borderRadius: 999,
                                    paddingHorizontal: 9,
                                    paddingVertical: 3,
                                  }}
                                >
                                  <Text style={[font('meta', 600), { color: colors.slate500 }]}>
                                    {t('piece.kindDevis', { personality })} {quoteOf(inv)?.number ?? ''}
                                  </Text>
                                </PressableScale>
                              ) : null}
                            </View>
                          </View>
                          <View style={{ alignItems: 'flex-end', gap: 6 }}>
                            {/* Règle acompte (mémoire billing-nettopay-ceiling) : la liste montre CE QUE
                                CETTE FACTURE FACTURE (netToPay) — jamais le TTC du document total (un
                                acompte 30 % de 1 386 € affichait « 1 386 € » et ouvrait… 415,80 €). */}
                            <MoneyText cents={inv.totals.netToPay} />
                            {showRemaining ? (
                              <Text style={[font('meta'), { color: colors.slate500 }]}>À encaisser {formatEUR(remaining)}</Text>
                            ) : null}
                            <StatusBadge label={badge.label} variant={statusBadgeVariantForLegacyTone(badge.tone)} />
                          </View>
                        </Pressable>
                        {hasInvoiceActions(inv) ? (
                          <View style={{ marginTop: 12 }}>
                            <InvoiceActions invoice={inv} />
                          </View>
                        ) : null}
                      </Card>
                    );
                  })}
                </StaggeredList>
              </View>
              )}
          </View>
        ) : null}
      </ScrollView>
      {/* Feuille d'erreur premium locale (grammaire d'erreur du plan) — rendue au niveau
          de l'écran : l'échec de deletePersistedDraft n'est plus jamais muet. */}
      {errorSheet}
    </View>
  );
}
