/**
 * Recherche globale (A7) — un champ, tout l'espace : clients, devis & factures, documents.
 * VUE = searchGlobal (@bob/core, use case pur testé — le MÊME que Bob utilisera pour
 * « retrouve la facture de la mairie ») sur les queries réelles du BobClient. Écran poussé
 * (pattern A3-C17) : page qui défile, rangée retour sticky (bg .92), en-tête compact,
 * champ de recherche (autofocus, pré-rempli par ?q= — porte d'entrée Documents).
 * États de premier rang : hint (requête vide) · noResults (voix de Bob) · sections
 * masquées si vides. Zéro hex, zéro fixture.
 */
import { useMemo, useState } from 'react';
import { Pressable, RefreshControl, ScrollView, Text, View } from 'react-native';
import { useLocalSearchParams, useRouter } from 'expo-router';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { formatEUR, searchGlobal, type GlobalSearchResult } from '@bob/core';
import { documentTile } from '@bob/tokens';
import { t } from '@bob/i18n';
import {
  Card,
  EmptyState,
  ErrorRetry,
  FadeIn,
  IconTile,
  SearchField,
  SectionHeader,
  Skeleton,
  SkeletonRow,
  StickyBackRow,
  font,
  useTheme,
  type StatusBadgeVariant,
} from '@bob/ui';
import { useCustomers, useInvoices, useQuotes } from '../src/data/hooks';
import { useDocuments } from '../src/data/documents';
import { usePublishAgentContext, type AgentContext } from '../src/agent';
import { combineQueryStates } from '../src/data/query-state';
import { useBobAwareScrollInsets } from '../src/components/use-bob-aware-scroll-insets';
import {
  ChevronRightIcon,
  FileIcon,
  FileTextIcon,
  PeopleIcon,
} from '../src/components/icons';

const TYPE_TONE: Record<'b2c' | 'b2b' | 'b2g', StatusBadgeVariant> = {
  b2c: 'particulier',
  b2b: 'b2b',
  b2g: 'b2g',
};

function formatDate(iso: string): string {
  const [y, m, d] = iso.slice(0, 10).split('-');
  return d && m && y ? `${d}/${m}/${y}` : iso.slice(0, 10);
}

/** Rangée de résultat générique : pastille + titre + meta + accessoire, hairline entre
 * rangées. Papa vocal (Lot 5) : le label accessible COMPOSE titre + meta + montant
 * (`trailingLabel`) — « FA-2026-012, Mairie de Lyon, 1 250 € » se comprend à l'oreille. */
function ResultRow({
  tile,
  title,
  meta,
  trailing,
  trailingLabel,
  divider,
  onPress,
}: {
  tile: React.ReactNode;
  title: string;
  meta: string;
  trailing?: React.ReactNode;
  /** Texte annoncé pour l'accessoire (le montant d'une pièce) — jamais un chiffre muet. */
  trailingLabel?: string;
  divider: boolean;
  onPress: () => void;
}) {
  const { colors, controls } = useTheme();
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={[title, meta, trailingLabel].filter(Boolean).join(', ')}
      onPress={onPress}
      style={({ pressed }) => ({
        flexDirection: 'row',
        alignItems: 'center',
        gap: 11,
        paddingVertical: 12,
        borderBottomWidth: divider ? 1 : 0,
        borderBottomColor: colors.lineSoft,
        opacity: pressed ? 0.65 : 1,
      })}
    >
      {tile}
      <View style={{ flex: 1, minWidth: 0 }}>
        <Text
          style={{ ...font('body', 700), fontSize: 14, color: colors.ink800 }}
          numberOfLines={1}
        >
          {title}
        </Text>
        <Text style={[font('meta'), { color: colors.slate400, marginTop: 1 }]} numberOfLines={1}>
          {meta}
        </Text>
      </View>
      {trailing ?? <ChevronRightIcon color={controls.chevron} size={14} strokeWidth={2} />}
    </Pressable>
  );
}

export default function Recherche() {
  const { personality, colors, semantic } = useTheme();
  const insets = useSafeAreaInsets();
  const bobScrollInsets = useBobAwareScrollInsets({ minimumBottom: insets.bottom + 34 });
  const router = useRouter();
  const params = useLocalSearchParams<{ q?: string }>();
  const [query, setQuery] = useState(typeof params.q === 'string' ? params.q : '');

  const customers = useCustomers();
  const invoices = useInvoices();
  const quotes = useQuotes();
  const documents = useDocuments();
  const queryState = combineQueryStates(customers, invoices, quotes, documents);
  const dataReady =
    !queryState.loading &&
    !queryState.failed &&
    customers.data !== undefined &&
    invoices.data !== undefined &&
    quotes.data !== undefined &&
    documents.data !== undefined;
  const refreshing =
    customers.isRefetching || invoices.isRefetching || quotes.isRefetching || documents.isRefetching;

  const trimmed = query.trim();
  const result: GlobalSearchResult = useMemo(
    () =>
      searchGlobal({
        query: trimmed,
        customers: customers.data ?? [],
        invoices: invoices.data ?? [],
        quotes: quotes.data ?? [],
        documents: documents.data ?? [],
      }),
    [trimmed, customers.data, invoices.data, quotes.data, documents.data],
  );
  const agentContext = useMemo<AgentContext>(
    () => ({
      screen: { name: '/recherche', instanceId: '/recherche' },
      entities: trimmed && dataReady
        ? [
            ...result.customers.slice(0, 6).map((customer) => ({
              type: 'customer' as const,
              id: customer.id,
              label: customer.name,
            })),
            ...result.pieces.slice(0, 6).map((piece) => ({
              type: piece.source as 'quote' | 'invoice',
              id: piece.id,
              label: piece.number ?? (piece.source === 'invoice' ? 'Facture brouillon' : 'Devis brouillon'),
            })),
            ...result.documents.slice(0, 4).map((document) => ({
              type: 'document' as const,
              id: document.id,
              label: document.filename,
            })),
          ]
        : [],
      capabilities: dataReady
        ? ['screen.read', 'search.read', 'invoice.read', 'quote.read', 'customer.read', 'document.read']
        : [],
    }),
    [dataReady, result, trimmed],
  );
  usePublishAgentContext(agentContext);

  const searching = trimmed.length > 0;

  return (
    <View style={{ flex: 1, backgroundColor: colors.bg }}>
      <ScrollView
        style={{ flex: 1 }}
        stickyHeaderIndices={[0]}
        showsVerticalScrollIndicator={false}
        keyboardShouldPersistTaps="handled"
        contentContainerStyle={{ paddingBottom: bobScrollInsets.paddingBottom }}
        automaticallyAdjustKeyboardInsets={bobScrollInsets.automaticallyAdjustKeyboardInsets}
        scrollIndicatorInsets={{ bottom: bobScrollInsets.scrollIndicatorBottom }}
        refreshControl={
          <RefreshControl
            refreshing={refreshing}
            onRefresh={queryState.refetchAll}
            tintColor={colors.ink800}
            colors={[colors.ink800]}
          />
        }
      >
        {/* Rangée retour sticky — StickyBackRow kit (44 pt, même mécanisme partout). */}
        <StickyBackRow
          backLabel={t('search.back', { personality })}
          onBack={() => router.back()}
        />

        <View style={{ paddingTop: 2, paddingHorizontal: 20, paddingBottom: 4 }}>
          <Text style={[font('eyebrow'), { color: colors.slate400 }]}>
            {t('search.eyebrow', { personality })}
          </Text>
          <Text
            style={[font('pageTitle'), { color: colors.ink800, marginTop: 2 }]}
            accessibilityRole="header"
          >
            {t('search.title', { personality })}
          </Text>
          <Text style={[font('body'), { color: colors.slate500, marginTop: 3 }]}>
            {t('search.subtitle', { personality })}
          </Text>
        </View>

        {/* Champ de recherche — SearchField kit (Lot 0) : loupe, placeholder AA (slate500),
            bouton clear à cible 44 pt avec libellé i18n (contrat de l'addendum). */}
        <SearchField
          value={query}
          onChange={setQuery}
          placeholder={t('search.placeholder', { personality })}
          autoFocus={!searching}
          onClear={() => setQuery('')}
          clearAccessibilityLabel={t('search.clear', { personality })}
          style={{ marginTop: 12, marginHorizontal: 18 }}
        />

        {queryState.failed ? (
          <View style={{ paddingHorizontal: 18, paddingTop: 16 }}>
            <ErrorRetry
              message={t('search.dataError', { personality })}
              onRetry={queryState.refetchAll}
              retrying={refreshing}
            />
          </View>
        ) : searching && queryState.loading ? (
          <View style={{ paddingHorizontal: 18, paddingTop: 18, gap: 10 }}>
            <Skeleton height={17} width="34%" radius={8} />
            <Card radius={18} padding={0} style={{ paddingHorizontal: 14 }}>
              <SkeletonRow avatar="square" trailing="text" style={{ minHeight: 68 }} />
              <SkeletonRow avatar="square" trailing="text" style={{ minHeight: 68 }} />
              <SkeletonRow avatar="square" trailing="text" style={{ minHeight: 68 }} />
            </Card>
          </View>
        ) : !searching ? (
          <View style={{ paddingHorizontal: 18, paddingTop: 16 }}>
            <Card>
              <EmptyState body={t('search.hint', { personality })} />
            </Card>
          </View>
        ) : result.totalCount === 0 ? (
          <View style={{ paddingHorizontal: 18, paddingTop: 16 }}>
            <Card>
              <EmptyState body={t('search.noResults', { personality, params: { query: trimmed } })} />
            </Card>
          </View>
        ) : (
          <>
            {result.customers.length > 0 ? (
              // FadeIn BORNÉ (index 0-2) : les sections fondent à l'arrivée des résultats,
              // apparition immédiate sous reduce-motion (kit).
              <FadeIn index={0} style={{ paddingHorizontal: 18, paddingTop: 18 }}>
                <SectionHeader
                  title={t('search.sectionClients', { personality })}
                  action={
                    <Text style={[font('label'), { color: colors.slate400 }]}>
                      {result.customers.length}
                    </Text>
                  }
                />
                <Card radius={18} padding={0} style={{ paddingHorizontal: 14 }}>
                  {result.customers.map((c, i) => (
                    <ResultRow
                      key={c.id}
                      tile={
                        <IconTile tone={TYPE_TONE[c.type]} size={34} radius={10}>
                          <PeopleIcon
                            color={
                              c.type === 'b2b'
                                ? semantic.b2b
                                : c.type === 'b2g'
                                  ? semantic.b2g
                                  : semantic.particulier
                            }
                            size={17}
                            strokeWidth={2}
                          />
                        </IconTile>
                      }
                      title={c.name}
                      meta={t(
                        c.type === 'b2b'
                          ? 'piece.typeB2b'
                          : c.type === 'b2g'
                            ? 'piece.typeB2g'
                            : 'piece.typeB2c',
                        { personality },
                      )}
                      divider={i < result.customers.length - 1}
                      onPress={() => router.push(`/client/${c.id}`)}
                    />
                  ))}
                </Card>
              </FadeIn>
            ) : null}

            {result.pieces.length > 0 ? (
              <FadeIn index={1} style={{ paddingHorizontal: 18, paddingTop: 18 }}>
                <SectionHeader
                  title={t('search.sectionPieces', { personality })}
                  action={
                    <Text style={[font('label'), { color: colors.slate400 }]}>
                      {result.pieces.length}
                    </Text>
                  }
                />
                <Card radius={18} padding={0} style={{ paddingHorizontal: 14 }}>
                  {result.pieces.map((p, i) => (
                    <ResultRow
                      key={`${p.source}-${p.id}`}
                      tile={
                        <IconTile tone="b2b" size={34} radius={10}>
                          <FileTextIcon color={semantic.b2b} size={16} />
                        </IconTile>
                      }
                      title={p.number ?? t('search.draftNumber', { personality })}
                      meta={p.customerName}
                      trailingLabel={formatEUR(p.amountCents)}
                      trailing={
                        <Text
                          style={{
                            ...font('sub', 700),
                            color: colors.ink800,
                            fontVariant: ['tabular-nums'],
                          }}
                        >
                          {formatEUR(p.amountCents)}
                        </Text>
                      }
                      divider={i < result.pieces.length - 1}
                      onPress={() =>
                        router.push(p.source === 'invoice' ? `/facture/${p.id}` : `/devis/${p.id}`)
                      }
                    />
                  ))}
                </Card>
              </FadeIn>
            ) : null}

            {result.documents.length > 0 ? (
              <FadeIn index={2} style={{ paddingHorizontal: 18, paddingTop: 18 }}>
                <SectionHeader
                  title={t('search.sectionDocs', { personality })}
                  action={
                    <Text style={[font('label'), { color: colors.slate400 }]}>
                      {result.documents.length}
                    </Text>
                  }
                />
                <Card radius={18} padding={0} style={{ paddingHorizontal: 14 }}>
                  {result.documents.map((d, i) => (
                    <ResultRow
                      key={d.id}
                      tile={
                        // Tone 'document' NEUTRE (Lot 0, arbitrage TONS RECYCLÉS) : le vert
                        // reste réservé à l'argent — l'intérim b2g est REFUSÉ.
                        <IconTile tone="document" size={34} radius={10}>
                          <FileIcon color={documentTile.ink} />
                        </IconTile>
                      }
                      title={d.filename}
                      meta={formatDate(d.documentDate ?? d.createdAt)}
                      divider={i < result.documents.length - 1}
                      onPress={() => router.push({ pathname: '/documents/[id]', params: { id: d.id } })}
                    />
                  ))}
                </Card>
              </FadeIn>
            ) : null}
          </>
        )}
      </ScrollView>
    </View>
  );
}
