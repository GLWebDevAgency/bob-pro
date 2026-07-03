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
import { Linking, Pressable, ScrollView, Text, TextInput, View } from 'react-native';
import { useLocalSearchParams, useRouter } from 'expo-router';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { formatEUR, searchGlobal, type GlobalSearchResult } from '@bob/core';
import { patterns, shadowNative } from '@bob/tokens';
import { t } from '@bob/i18n';
import { Card, IconTile, SectionHeader, font, useTheme, type StatusBadgeVariant } from '@bob/ui';
import { useCustomers, useInvoices, useQuotes } from '../src/data/hooks';
import { useDocuments } from '../src/data/documents';
import { useBobClient } from '../src/data/client';
import {
  ChevronLeftIcon,
  ChevronRightIcon,
  FileIcon,
  FileTextIcon,
  PeopleIcon,
  SearchIcon,
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

/** Rangée de résultat générique : pastille + titre + meta + accessoire, hairline entre rangées. */
function ResultRow({
  tile,
  title,
  meta,
  trailing,
  divider,
  onPress,
}: {
  tile: React.ReactNode;
  title: string;
  meta: string;
  trailing?: React.ReactNode;
  divider: boolean;
  onPress: () => void;
}) {
  const { colors, controls } = useTheme();
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={title}
      onPress={onPress}
      style={{
        flexDirection: 'row',
        alignItems: 'center',
        gap: 11,
        paddingVertical: 12,
        borderBottomWidth: divider ? 1 : 0,
        borderBottomColor: colors.lineSoft,
      }}
    >
      {tile}
      <View style={{ flex: 1, minWidth: 0 }}>
        <Text style={{ ...font('body', 700), fontSize: 14, color: colors.ink800 }} numberOfLines={1}>
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
  const { personality, colors, semantic, controls } = useTheme();
  const insets = useSafeAreaInsets();
  const router = useRouter();
  const client = useBobClient();
  const params = useLocalSearchParams<{ q?: string }>();
  const [query, setQuery] = useState(typeof params.q === 'string' ? params.q : '');

  const customers = useCustomers();
  const invoices = useInvoices();
  const quotes = useQuotes();
  const documents = useDocuments();

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

  const openDocument = async (id: string): Promise<void> => {
    const r = await client.documentDownloadUrl(id);
    if (r.ok) await Linking.openURL(r.value.url);
  };

  const searching = trimmed.length > 0;

  return (
    <View style={{ flex: 1, backgroundColor: colors.bg }}>
      <ScrollView
        style={{ flex: 1 }}
        stickyHeaderIndices={[0]}
        showsVerticalScrollIndicator={false}
        keyboardShouldPersistTaps="handled"
        contentContainerStyle={{ paddingBottom: insets.bottom + 34 }}
      >
        {/* Rangée retour sticky (pattern A3-C17 : bg .92) */}
        <View
          style={{
            paddingTop: insets.top + 10,
            paddingHorizontal: 16,
            paddingBottom: 8,
            backgroundColor: patterns.bottomTabBar.fade[1],
          }}
        >
          <Pressable
            accessibilityRole="button"
            accessibilityLabel={t('search.back', { personality })}
            onPress={() => router.back()}
            hitSlop={8}
            style={{ flexDirection: 'row', alignItems: 'center', gap: 4, alignSelf: 'flex-start', minHeight: 34 }}
          >
            <ChevronLeftIcon color={colors.ink800} size={18} strokeWidth={2.2} />
            <Text style={[font('label', 600), { fontSize: 15, color: colors.ink800 }]}>
              {t('search.back', { personality })}
            </Text>
          </Pressable>
        </View>

        <View style={{ paddingTop: 2, paddingHorizontal: 20, paddingBottom: 4 }}>
          <Text style={[font('eyebrow'), { color: colors.slate400 }]}>{t('search.eyebrow', { personality })}</Text>
          <Text style={[font('pageTitle'), { color: colors.ink800, marginTop: 2 }]} accessibilityRole="header">
            {t('search.title', { personality })}
          </Text>
          <Text style={[font('body'), { color: colors.slate500, marginTop: 3 }]}>
            {t('search.subtitle', { personality })}
          </Text>
        </View>

        {/* Champ de recherche — même recette que le coffre C14 */}
        <View
          style={{
            marginTop: 12,
            marginHorizontal: 18,
            flexDirection: 'row',
            alignItems: 'center',
            gap: 9,
            backgroundColor: colors.surface,
            borderRadius: 14,
            borderWidth: 1,
            borderColor: controls.cardBorder,
            paddingVertical: 11,
            paddingHorizontal: 14,
            ...shadowNative.e1,
          }}
        >
          <SearchIcon color={colors.slate300} />
          <TextInput
            value={query}
            onChangeText={setQuery}
            autoFocus={!searching}
            returnKeyType="search"
            placeholder={t('search.placeholder', { personality })}
            placeholderTextColor={colors.slate300}
            accessibilityLabel={t('search.placeholder', { personality })}
            style={{ ...font('body'), fontSize: 14, color: colors.ink800, flex: 1, padding: 0 }}
          />
        </View>

        {!searching ? (
          <View style={{ paddingHorizontal: 18, paddingTop: 16 }}>
            <Card>
              <Text style={[font('sub'), { color: colors.slate500, lineHeight: 19 }]}>
                {t('search.hint', { personality })}
              </Text>
            </Card>
          </View>
        ) : result.totalCount === 0 ? (
          <View style={{ paddingHorizontal: 18, paddingTop: 16 }}>
            <Card>
              <Text style={[font('sub'), { color: colors.slate500, lineHeight: 19 }]}>
                {t('search.noResults', { personality, params: { query: trimmed } })}
              </Text>
            </Card>
          </View>
        ) : (
          <>
            {result.customers.length > 0 ? (
              <View style={{ paddingHorizontal: 18, paddingTop: 18 }}>
                <SectionHeader
                  title={t('search.sectionClients', { personality })}
                  action={<Text style={[font('label'), { color: colors.slate400 }]}>{result.customers.length}</Text>}
                />
                <Card radius={18} padding={0} style={{ paddingHorizontal: 14 }}>
                  {result.customers.map((c, i) => (
                    <ResultRow
                      key={c.id}
                      tile={
                        <IconTile tone={TYPE_TONE[c.type]} size={34} radius={10}>
                          <PeopleIcon
                            color={
                              c.type === 'b2b' ? semantic.b2b : c.type === 'b2g' ? semantic.b2g : semantic.particulier
                            }
                            size={17}
                            strokeWidth={2}
                          />
                        </IconTile>
                      }
                      title={c.name}
                      meta={t(
                        c.type === 'b2b' ? 'piece.typeB2b' : c.type === 'b2g' ? 'piece.typeB2g' : 'piece.typeB2c',
                        { personality },
                      )}
                      divider={i < result.customers.length - 1}
                      onPress={() => router.push(`/client/${c.id}`)}
                    />
                  ))}
                </Card>
              </View>
            ) : null}

            {result.pieces.length > 0 ? (
              <View style={{ paddingHorizontal: 18, paddingTop: 18 }}>
                <SectionHeader
                  title={t('search.sectionPieces', { personality })}
                  action={<Text style={[font('label'), { color: colors.slate400 }]}>{result.pieces.length}</Text>}
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
                      trailing={
                        <Text style={{ ...font('sub', 700), color: colors.ink800, fontVariant: ['tabular-nums'] }}>
                          {formatEUR(p.amountCents)}
                        </Text>
                      }
                      divider={i < result.pieces.length - 1}
                      onPress={() => router.push(p.source === 'invoice' ? `/facture/${p.id}` : `/devis/${p.id}`)}
                    />
                  ))}
                </Card>
              </View>
            ) : null}

            {result.documents.length > 0 ? (
              <View style={{ paddingHorizontal: 18, paddingTop: 18 }}>
                <SectionHeader
                  title={t('search.sectionDocs', { personality })}
                  action={<Text style={[font('label'), { color: colors.slate400 }]}>{result.documents.length}</Text>}
                />
                <Card radius={18} padding={0} style={{ paddingHorizontal: 14 }}>
                  {result.documents.map((d, i) => (
                    <ResultRow
                      key={d.id}
                      tile={
                        <IconTile tone="success" size={34} radius={10}>
                          <FileIcon color={semantic.success} />
                        </IconTile>
                      }
                      title={d.filename}
                      meta={formatDate(d.documentDate ?? d.createdAt)}
                      divider={i < result.documents.length - 1}
                      onPress={() => void openDocument(d.id)}
                    />
                  ))}
                </Card>
              </View>
            ) : null}

          </>
        )}
      </ScrollView>
    </View>
  );
}
