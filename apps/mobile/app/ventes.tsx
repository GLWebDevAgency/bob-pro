import { useMemo, useRef, useState } from 'react';
import { ScrollView, TextInput, View, Text, Pressable } from 'react-native';
import { useRouter } from 'expo-router';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { Ionicons } from '@expo/vector-icons';
import { formatEUR, normalizeVoiceText } from '@bob/core';
import { t } from '@bob/i18n';
import type { QuoteView, InvoiceView } from '@bob/api-client';
import { useTheme } from '../src/theme';
import { useCustomers, useQuotes, useInvoices } from '../src/data/hooks';
import { usePublishAgentContext, type AgentContext, type AgentSurface } from '../src/agent';
import { frDateLabel } from '@bob/ai';
import { Card, Badge, MoneyText, SectionHeader, font } from '../src/components/ui';
import { ErrorRetry, SkeletonRow } from '@bob/ui';
import { combineQueryStates } from '../src/data/query-state';
import {
  QuoteActions,
  InvoiceActions,
  hasQuoteActions,
  hasInvoiceActions,
  QUOTE_BADGE,
  INVOICE_BADGE,
} from '../src/components/DocumentActions';

type QuoteStatus = QuoteView['status'];
type InvoiceStatus = InvoiceView['status'];

// Actionnable en premier : les brouillons/à traiter remontent, le terminé descend.
const QUOTE_ORDER: Record<QuoteStatus, number> = { draft: 0, sent: 1, viewed: 1, signed: 2, refused: 4, expired: 4 };
const INVOICE_ORDER: Record<InvoiceStatus, number> = { draft: 0, late: 1, issued: 2, partially_paid: 2, paid: 4, cancelled: 4 };

export default function Ventes() {
  const { colors, semantic, personality } = useTheme();
  const insets = useSafeAreaInsets();
  const router = useRouter();

  const customers = useCustomers();
  const quotes = useQuotes();
  const invoices = useInvoices();

  const nameOf = (customerId: string) => (customers.data ?? []).find((c) => c.id === customerId)?.name ?? 'Client';

  // failed se lit TOUJOURS avec loading (combineQueryStates) — un échec réseau ne devient
  // jamais silencieusement « zéro devis/facture » (classe de bug P0 de l'audit états).
  const queryState = combineQueryStates(quotes, invoices);

  // ── Filtre + recherche PLEIN TEXTE (n°, client, LIGNES — « chauffe-eau » retrouve la
  //    facture même sans se souvenir du client). Accents/casse ignorés, données déjà locales. ──
  const [kindFilter, setKindFilter] = useState<'all' | 'quotes' | 'invoices'>('all');
  const [query, setQuery] = useState('');
  const normalizedQuery = normalizeVoiceText(query).trim();
  const matches = (number: string | null, customerId: string, lines: readonly { label: string }[]): boolean => {
    if (normalizedQuery === '') return true;
    const haystack = normalizeVoiceText(
      `${number ?? ''} ${nameOf(customerId)} ${lines.map((l) => l.label).join(' ')}`,
    );
    return normalizedQuery.split(' ').every((word) => haystack.includes(word));
  };
  const sortedQuotes = [...(quotes.data ?? [])]
    .filter((q) => kindFilter !== 'invoices' && matches(q.number, q.customerId, q.lines))
    .sort((a, b) => QUOTE_ORDER[a.status] - QUOTE_ORDER[b.status]);
  const sortedInvoices = [...(invoices.data ?? [])]
    .filter((i) => kindFilter !== 'quotes' && matches(i.number, i.customerId, i.lines))
    .sort((a, b) => INVOICE_ORDER[a.status] - INVOICE_ORDER[b.status]);

  // Liaison devis ↔ factures : chips discrètes automatiques sur chaque pièce.
  const invoicesOfQuote = (quoteId: string) =>
    (invoices.data ?? [])
      .filter((i) => i.parentQuoteId === quoteId)
      .sort((a, b) => (a.kind === 'deposit' ? 0 : 1) - (b.kind === 'deposit' ? 0 : 1));
  const quoteOf = (inv: InvoiceView) => (quotes.data ?? []).find((q) => q.id === inv.parentQuoteId) ?? null;
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
  const personalityRef = useRef(personality);
  personalityRef.current = personality;
  const ventesSurface = useMemo<AgentSurface>(
    () => ({
      affordances: [
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
    [],
  );
  const ventesAgentContext = useMemo<AgentContext>(() => {
    const qs = [...(quotes.data ?? [])].sort((a, b) => QUOTE_ORDER[a.status] - QUOTE_ORDER[b.status]).slice(0, 8);
    const is = [...(invoices.data ?? [])].sort((a, b) => INVOICE_ORDER[a.status] - INVOICE_ORDER[b.status]).slice(0, 8);
    return {
      screen: { name: 'ventes', instanceId: 'ventes' },
      entities: [
        ...qs.map((q) => ({ type: 'quote' as const, id: q.id, label: q.number ? `Devis ${q.number}` : 'Devis brouillon' })),
        ...is.map((i) => ({ type: 'invoice' as const, id: i.id, label: i.number ? `Facture ${i.number}` : 'Facture brouillon' })),
      ],
      capabilities: ['screen.read', 'quote.read', 'invoice.read'],
    };
  }, [quotes.data, invoices.data]);
  usePublishAgentContext(ventesAgentContext, undefined, ventesSurface);

  return (
    <View style={{ flex: 1, backgroundColor: colors.bg }}>
      <View style={{ paddingTop: insets.top + 8, paddingHorizontal: 20, paddingBottom: 8 }}>
        <Pressable
          onPress={() => router.back()}
          accessibilityRole="button"
          accessibilityLabel="Retour"
          style={{ flexDirection: 'row', alignItems: 'center', gap: 4 }}
        >
          <Ionicons name="chevron-back" size={22} color={colors.ink800} />
          <Text style={[font('body'), { color: colors.ink800 }]}>Accueil</Text>
        </Pressable>
        <Text style={[font('screenH1'), { color: colors.ink900, marginTop: 6 }]}>Devis &amp; Factures</Text>
      </View>

      <ScrollView contentContainerStyle={{ padding: 20, paddingTop: 8, gap: 20, paddingBottom: 40 }}>
        {/* Filtres + recherche plein texte (n°, client, prestations) — TOUJOURS montés (parité
            vocale : « retrouve les factures avec un chauffe-eau » pilote les mêmes états) ;
            seul le CORPS des sections en dessous bascule skeleton → erreur → données. */}
        <View style={{ gap: 10 }}>
          <View style={{ flexDirection: 'row', gap: 8 }}>
            {(
              [
                ['all', 'ventes.filterAll'],
                ['quotes', 'ventes.filterQuotes'],
                ['invoices', 'ventes.filterInvoices'],
              ] as const
            ).map(([key, labelKey]) => (
              <Pressable
                key={key}
                accessibilityRole="button"
                accessibilityState={{ selected: kindFilter === key }}
                onPress={() => setKindFilter(key)}
                style={{
                  paddingHorizontal: 14,
                  paddingVertical: 8,
                  borderRadius: 999,
                  borderWidth: 1,
                  borderColor: kindFilter === key ? semantic.ai : colors.line,
                  backgroundColor: kindFilter === key ? semantic.aiBg : colors.surface,
                }}
              >
                <Text
                  style={[
                    font('meta'),
                    { fontWeight: kindFilter === key ? '700' : '600', color: kindFilter === key ? semantic.aiInk : colors.ink800 },
                  ]}
                >
                  {t(labelKey, { personality })}
                </Text>
              </Pressable>
            ))}
          </View>
          <TextInput
            value={query}
            onChangeText={setQuery}
            placeholder={t('ventes.searchPlaceholder', { personality })}
            placeholderTextColor={colors.slate400}
            accessibilityLabel={t('ventes.searchPlaceholder', { personality })}
            autoCorrect={false}
            style={[
              font('body'),
              {
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
          {!queryState.loading &&
          !queryState.failed &&
          normalizedQuery !== '' &&
          sortedQuotes.length + sortedInvoices.length === 0 ? (
            <Text style={[font('sub'), { color: colors.slate500 }]}>
              {t('ventes.noResults', { personality })}
            </Text>
          ) : null}
        </View>

        {kindFilter !== 'invoices' ? (
          <View>
            <SectionHeader title="Devis" />
            {queryState.loading ? (
              <View style={{ gap: 10 }}>
                <SkeletonRow lines={2} trailing="text" />
                <SkeletonRow lines={2} trailing="text" />
                <SkeletonRow lines={2} trailing="text" />
              </View>
            ) : queryState.failed ? (
              <ErrorRetry message="Impossible de charger tes documents." onRetry={queryState.refetchAll} />
            ) : sortedQuotes.length === 0 ? (
              <Card>
                <Text style={[font('body'), { color: colors.slate500 }]}>Aucun devis pour l&apos;instant.</Text>
              </Card>
            ) : (
              <View style={{ gap: 10 }}>
                  {sortedQuotes.map((q) => {
                    const badge = QUOTE_BADGE[q.status];
                    return (
                      <Card key={q.id}>
                        <Pressable
                          onPress={() => router.push(`/devis/${q.id}`)}
                          accessibilityRole="button"
                          accessibilityLabel={`Devis ${q.number ?? 'brouillon'} — ${nameOf(q.customerId)}`}
                          style={{ flexDirection: 'row', justifyContent: 'space-between', alignItems: 'flex-start' }}
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
                              <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 6, marginTop: 6 }}>
                                {invoicesOfQuote(q.id).map((li) => (
                                  <Pressable
                                    key={li.id}
                                    accessibilityRole="button"
                                    accessibilityLabel={`Facture ${li.number ?? ''}`}
                                    onPress={() => router.push(`/facture/${li.id}`)}
                                    style={{
                                      borderWidth: 1,
                                      borderColor: semantic.ai,
                                      backgroundColor: semantic.aiBg,
                                      borderRadius: 999,
                                      paddingHorizontal: 8,
                                      paddingVertical: 3,
                                    }}
                                  >
                                    <Text style={[font('meta'), { fontSize: 11, fontWeight: '600', color: semantic.aiInk }]}>
                                      {li.number ?? '—'} · {formatEUR(li.totals.netToPay)}
                                    </Text>
                                  </Pressable>
                                ))}
                              </View>
                            ) : null}
                          </View>
                          <View style={{ alignItems: 'flex-end', gap: 6 }}>
                            <MoneyText cents={q.totals.ttc} />
                            <Badge label={badge.label} tone={badge.tone} />
                          </View>
                        </Pressable>
                        {hasQuoteActions(q) ? (
                          <View style={{ marginTop: 12 }}>
                            <QuoteActions
                              quote={q}
                              customerName={nameOf(q.customerId)}
                              alreadyInvoiced={(invoices.data ?? []).some((i) => i.parentQuoteId === q.id)}
                            />
                          </View>
                        ) : null}
                      </Card>
                    );
                  })}
                </View>
              )}
          </View>
        ) : null}

        {kindFilter !== 'quotes' ? (
          <View>
            <SectionHeader title="Factures" />
            {queryState.loading ? (
              <View style={{ gap: 10 }}>
                <SkeletonRow lines={2} trailing="text" />
                <SkeletonRow lines={2} trailing="text" />
                <SkeletonRow lines={2} trailing="text" />
                <SkeletonRow lines={2} trailing="text" />
              </View>
            ) : queryState.failed ? (
              <ErrorRetry message="Impossible de charger tes documents." onRetry={queryState.refetchAll} />
            ) : sortedInvoices.length === 0 ? (
              <Card>
                <Text style={[font('body'), { color: colors.slate500 }]}>Aucune facture pour l&apos;instant.</Text>
              </Card>
            ) : (
              <View style={{ gap: 10 }}>
                  {sortedInvoices.map((inv) => {
                    const badge = INVOICE_BADGE[inv.status];
                    // Assiette = netToPay (acompte si depositPct) : montant réellement encaissable sur la facture.
                    const remaining = Math.max(0, inv.totals.netToPay - inv.paid);
                    const showRemaining = remaining > 0 && remaining !== inv.totals.netToPay;
                    return (
                      <Card key={inv.id}>
                        <Pressable
                          onPress={() => router.push(`/facture/${inv.id}`)}
                          accessibilityRole="button"
                          accessibilityLabel={`Facture ${inv.number ?? 'brouillon'} — ${nameOf(inv.customerId)}`}
                          style={{ flexDirection: 'row', justifyContent: 'space-between', alignItems: 'flex-start' }}
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
                              <View
                                style={{
                                  borderWidth: 1,
                                  borderColor: semantic.ai,
                                  backgroundColor: semantic.aiBg,
                                  borderRadius: 999,
                                  paddingHorizontal: 8,
                                  paddingVertical: 3,
                                }}
                              >
                                <Text style={[font('meta'), { fontSize: 11, fontWeight: '600', color: semantic.aiInk }]}>
                                  {kindChip(inv)}
                                </Text>
                              </View>
                              {quoteOf(inv) !== null ? (
                                <Pressable
                                  accessibilityRole="button"
                                  accessibilityLabel={`Devis ${quoteOf(inv)?.number ?? ''}`}
                                  onPress={() => router.push(`/devis/${inv.parentQuoteId}`)}
                                  style={{
                                    borderWidth: 1,
                                    borderColor: colors.line,
                                    borderRadius: 999,
                                    paddingHorizontal: 8,
                                    paddingVertical: 3,
                                  }}
                                >
                                  <Text style={[font('meta'), { fontSize: 11, fontWeight: '600', color: colors.slate500 }]}>
                                    {t('piece.kindDevis', { personality })} {quoteOf(inv)?.number ?? ''}
                                  </Text>
                                </Pressable>
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
                            <Badge label={badge.label} tone={badge.tone} />
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
                </View>
              )}
          </View>
        ) : null}
      </ScrollView>
    </View>
  );
}
