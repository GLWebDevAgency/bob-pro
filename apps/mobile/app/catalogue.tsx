/**
 * Catalogue de prestations (claim C27, réf proto dc.html §catalogue « Mon catalogue »).
 *
 * MOTEUR : use case PUR @bob/core deriveCatalogue — l'écran ne calcule AUCUNE fusion :
 * suggestions MÉTIER (TRADE_PROFILES via le profil réel useProfile, PU HT indicatifs marchés
 * FR 2026 marqués « prix indicatif ») + prestations PERSO de l'artisan (persistance locale
 * typée src/data/catalogue.ts — AUCUN endpoint serveur, TODO documenté dans le module).
 *
 * GESTES : recherche (searchCatalogue core, accents/casse ignorés) · filtre par catégorie
 * (proto : Tout / Main-d'œuvre / Fournitures / Déplacement) · ajout et édition via Sheet
 * (libellé / PU HT / TVA / catégorie) · une suggestion métier s'ÉDITE aussi : l'enregistrer
 * pose le prix DE L'ARTISAN (fusion « Bob garde tes prix » — l'indicatif disparaît) ·
 * suppression réservée aux prestations perso (jamais de bouton fantôme sur un indicatif).
 *
 * Écarts assumés vs proto : le proto présente le catalogue en feuille du devis — ici l'écran
 * autonome de GESTION (l'insertion au devis vit dans devis/new, suggestions au fil de la
 * saisie) ; la catégorie « Forfaits » du proto n'existe pas dans LineCategory → les forfaits
 * vivent en main-d'œuvre avec leur unité « forfait ». Zéro hex/rgba — tokens only.
 */
import { useMemo, useState } from 'react';
import {
  KeyboardAvoidingView,
  Platform,
  Pressable,
  RefreshControl,
  ScrollView,
  Text,
  TextInput,
  View,
} from 'react-native';
import { useRouter } from 'expo-router';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { shadowNative } from '@bob/tokens';
import {
  formatEUR,
  searchCatalogue,
  CATALOGUE_CATEGORIES,
  type CataloguePrestation,
  type CatalogueCategory,
  type VatRate,
} from '@bob/core';
import { t, type I18nKey } from '@bob/i18n';
import {
  Button,
  Card,
  Chip,
  EmptyState,
  ErrorRetry,
  InnerScreenHeader,
  MoneyText,
  SectionHeader,
  Sheet,
  Skeleton,
  SkeletonRow,
  Toast,
  font,
  useTheme,
} from '@bob/ui';
import {
  newPrestationId,
  useCatalogue,
  useDeletePrestation,
  useUpsertPrestation,
} from '../src/data/catalogue';
import { CheckIcon, ChevronLeftIcon, PlusIcon, SearchIcon } from '../src/components/icons';

/** Libellés de catégorie partagés avec la revue voix (C20) et l'étape lignes du devis (C21). */
const CATEGORY_KEY: Record<CatalogueCategory, I18nKey> = {
  labor: 'voix.catLabor',
  supply: 'voix.catSupply',
  travel: 'voix.catTravel',
};

/** Taux proposés à l'édition (ensemble légal courant) — CreateQuote revalide à la génération. */
const VAT_CHOICES: readonly VatRate[] = [0, 5.5, 10, 20];

/** Taux affiché à la française (5.5 → « 5,5 ») — même règle que devis/new. */
const fmtRate = (rate: number): string => String(rate).replace('.', ',');

const parsePositive = (value: string): number | null => {
  const n = Number(value.trim().replace(',', '.'));
  return Number.isFinite(n) && n > 0 ? n : null;
};

type Filter = 'all' | CatalogueCategory;

/** Brouillon d'édition de la feuille — null = feuille fermée. */
interface SheetDraft {
  /** Prestation d'origine (édition/personnalisation) — null = création pure. */
  source: CataloguePrestation | null;
  label: string;
  price: string;
  vatRate: VatRate;
  category: CatalogueCategory;
}

export default function Catalogue() {
  const { colors, semantic, theme, radius, personality } = useTheme();
  const insets = useSafeAreaInsets();
  const router = useRouter();
  const catalogue = useCatalogue();
  const upsert = useUpsertPrestation();
  const remove = useDeletePrestation();

  const [query, setQuery] = useState('');
  const [filter, setFilter] = useState<Filter>('all');
  const [draft, setDraft] = useState<SheetDraft | null>(null);
  const [toast, setToast] = useState<string | null>(null);

  const visible = useMemo(() => {
    const found = searchCatalogue(catalogue.prestations, query);
    return filter === 'all' ? found : found.filter((p) => p.category === filter);
  }, [catalogue.prestations, query, filter]);

  /** Groupes par catégorie (ordre du core : labor → supply → travel) pour les SectionHeader. */
  const groups = useMemo(
    () =>
      CATALOGUE_CATEGORIES.map((cat) => ({
        category: cat,
        items: visible.filter((p) => p.category === cat),
      })).filter((g) => g.items.length > 0),
    [visible],
  );

  const openAdd = (): void =>
    setDraft({ source: null, label: '', price: '', vatRate: 20, category: 'labor' });

  const openEdit = (p: CataloguePrestation): void =>
    setDraft({
      source: p,
      label: p.label,
      price: (p.unitPriceHT / 100).toFixed(2).replace('.', ','),
      vatRate: p.vatRate,
      category: p.category,
    });

  const priceValue = draft !== null ? parsePositive(draft.price) : null;
  const draftValid = draft !== null && draft.label.trim() !== '' && priceValue !== null;

  const save = (): void => {
    if (draft === null || !draftValid || priceValue === null || upsert.isPending) return;
    // Une perso garde son id (édition) ; une suggestion métier enregistrée DEVIENT une perso
    // (nouvel id — la fusion du core éclipse l'indicatif au même libellé : « Bob garde tes prix »).
    const id = draft.source !== null && draft.source.source === 'perso' ? draft.source.id : newPrestationId();
    upsert.mutate(
      {
        id,
        label: draft.label.trim(),
        category: draft.category,
        unit: draft.source?.unit ?? null,
        unitPriceHT: Math.round(priceValue * 100),
        vatRate: draft.vatRate,
      },
      {
        onSuccess: () => {
          setDraft(null);
          setToast(t('catalogue.savedToast', { personality }));
        },
        onError: () => setToast(t('catalogue.dataError', { personality })),
      },
    );
  };

  const deletePerso = (): void => {
    if (draft === null || draft.source === null || draft.source.source !== 'perso' || remove.isPending) return;
    remove.mutate(draft.source.id, {
      onSuccess: () => {
        setDraft(null);
        setToast(t('catalogue.deletedToast', { personality }));
      },
      onError: () => setToast(t('catalogue.dataError', { personality })),
    });
  };

  const sheetTitleKey: I18nKey =
    draft === null || draft.source === null
      ? 'catalogue.sheetAddTitle'
      : draft.source.source === 'perso'
        ? 'catalogue.sheetEditTitle'
        : 'catalogue.sheetCustomizeTitle';

  return (
    <View style={{ flex: 1, backgroundColor: colors.bg }}>
      {/* Retour + en-tête clair (mêmes redlines que notifications/C25) */}
      <View style={{ paddingTop: insets.top + 10, paddingHorizontal: 16 }}>
        <Pressable
          accessibilityRole="button"
          accessibilityLabel={t('catalogue.back', { personality })}
          onPress={() => router.back()}
          hitSlop={8}
          style={{ flexDirection: 'row', alignItems: 'center', gap: 4, alignSelf: 'flex-start', minHeight: 44 }}
        >
          <ChevronLeftIcon color={colors.ink800} size={18} strokeWidth={2.2} />
          <Text style={[font('label', 600), { fontSize: 15, color: colors.ink800 }]}>
            {t('catalogue.back', { personality })}
          </Text>
        </Pressable>
      </View>

      <InnerScreenHeader
        eyebrow={t('catalogue.eyebrow', { personality })}
        title={t('catalogue.title', { personality })}
        subtitle={t('catalogue.subtitle', { personality })}
        action={
          <Pressable
            accessibilityRole="button"
            accessibilityLabel={t('catalogue.add', { personality })}
            onPress={openAdd}
            style={{
              width: 44,
              height: 44,
              borderRadius: 22,
              backgroundColor: theme.ink,
              alignItems: 'center',
              justifyContent: 'center',
              ...shadowNative.e1,
            }}
          >
            <PlusIcon color={colors.surface} size={20} strokeWidth={2.4} />
          </Pressable>
        }
      />

      {/* Recherche (proto : « Chercher une prestation… ») + filtres par catégorie */}
      <View style={{ paddingHorizontal: 18, paddingTop: 14, gap: 12 }}>
        <View
          style={{
            flexDirection: 'row',
            alignItems: 'center',
            gap: 9,
            backgroundColor: colors.surface,
            borderRadius: 12,
            paddingHorizontal: 14,
            minHeight: 44,
            ...shadowNative.e1,
          }}
        >
          <SearchIcon color={colors.slate400} size={16} />
          <TextInput
            value={query}
            onChangeText={setQuery}
            placeholder={t('catalogue.searchPlaceholder', { personality })}
            placeholderTextColor={colors.slate400}
            autoCorrect={false}
            accessibilityLabel={t('catalogue.searchPlaceholder', { personality })}
            style={[font('body'), { flex: 1, color: colors.ink900, paddingVertical: 10 }]}
          />
        </View>
        <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 8 }}>
          <Chip
            label={t('catalogue.catAll', { personality })}
            active={filter === 'all'}
            onPress={() => setFilter('all')}
          />
          {CATALOGUE_CATEGORIES.map((cat) => (
            <Chip
              key={cat}
              label={t(CATEGORY_KEY[cat], { personality })}
              active={filter === cat}
              onPress={() => setFilter(cat)}
            />
          ))}
        </View>
      </View>

      <ScrollView
        style={{ flex: 1 }}
        contentContainerStyle={{ paddingHorizontal: 18, paddingTop: 6, paddingBottom: insets.bottom + 34 }}
        keyboardShouldPersistTaps="handled"
        showsVerticalScrollIndicator={false}
        refreshControl={
          <RefreshControl
            refreshing={catalogue.isRefetching}
            onRefresh={catalogue.refetch}
            tintColor={colors.ink800}
            colors={[colors.ink800]}
          />
        }
      >
        {catalogue.isLoading ? (
          <View style={{ marginTop: 8, gap: 9 }}>
            <Skeleton height={17} width="42%" radius={8} style={{ marginBottom: 2 }} />
            {Array.from({ length: 4 }, (_, index) => (
              <Card key={index} radius={radius.card} padding={0} style={{ paddingHorizontal: 15 }}>
                <SkeletonRow avatar={false} trailing="text" style={{ minHeight: 70 }} />
              </Card>
            ))}
          </View>
        ) : catalogue.isError ? (
          <View style={{ marginTop: 8 }}>
            <ErrorRetry
              message={t('catalogue.dataError', { personality })}
              onRetry={catalogue.refetch}
            />
          </View>
        ) : visible.length === 0 ? (
          <Card style={{ marginTop: 8 }}>
            <EmptyState
              body={t('catalogue.empty', { personality })}
              cta={{ label: t('catalogue.add', { personality }), onPress: openAdd }}
            />
          </Card>
        ) : (
          groups.map((group) => (
            <View key={group.category}>
              <SectionHeader title={t(CATEGORY_KEY[group.category], { personality })} />
              <View style={{ gap: 9 }}>
                {group.items.map((p) => (
                  <Pressable
                    key={p.id}
                    onPress={() => openEdit(p)}
                    accessibilityRole="button"
                    accessibilityLabel={`${p.label} · ${formatEUR(p.unitPriceHT)}`}
                    style={{
                      flexDirection: 'row',
                      alignItems: 'center',
                      gap: 12,
                      minHeight: 44,
                      backgroundColor: colors.surface,
                      borderRadius: radius.card,
                      paddingVertical: 13,
                      paddingHorizontal: 15,
                      ...shadowNative.e1,
                    }}
                  >
                    <View style={{ flex: 1, gap: 4 }}>
                      <Text style={[font('label', 600), { fontSize: 14.5, color: colors.ink900 }]}>
                        {p.label}
                        {p.unit !== null ? (
                          <Text style={[font('meta'), { fontSize: 12.5, color: colors.slate400 }]}>
                            {`  ·  ${p.unit}`}
                          </Text>
                        ) : null}
                      </Text>
                      <Text
                        style={[
                          font('meta', 600),
                          { fontSize: 11.5, color: p.source === 'perso' ? theme.ink2 : colors.slate400 },
                        ]}
                      >
                        {p.source === 'perso'
                          ? t('catalogue.persoBadge', { personality })
                          : t('catalogue.indicative', { personality })}
                        {` · ${t('catalogue.vatRatePct', { personality, params: { rate: fmtRate(p.vatRate) } })}`}
                      </Text>
                    </View>
                    <MoneyText cents={p.unitPriceHT} />
                  </Pressable>
                ))}
              </View>
            </View>
          ))
        )}
      </ScrollView>

      {/* Feuille ajout/édition — libellé / PU HT / TVA / catégorie (contrat C27) */}
      <Sheet visible={draft !== null} onClose={() => setDraft(null)}>
        <KeyboardAvoidingView {...(Platform.OS === 'ios' ? { behavior: 'padding' as const } : {})}>
          {draft !== null ? (
            <>
              <Text style={[font('pageTitle'), { fontSize: 20, color: colors.ink900 }]}>
                {t(sheetTitleKey, { personality })}
              </Text>
              {draft.source !== null && draft.source.source === 'metier' ? (
                <Text style={[font('sub'), { color: colors.slate500, lineHeight: 19, marginTop: 4 }]}>
                  {t('catalogue.sheetCustomizeHint', { personality })}
                </Text>
              ) : null}

              <Text style={[font('label', 700), { fontSize: 12, color: colors.slate400, marginTop: 16 }]}>
                {t('catalogue.labelField', { personality }).toUpperCase()}
              </Text>
              <TextInput
                value={draft.label}
                onChangeText={(label) => setDraft({ ...draft, label })}
                placeholder={t('catalogue.labelPlaceholder', { personality })}
                placeholderTextColor={colors.slate400}
                autoCorrect={false}
                accessibilityLabel={t('catalogue.labelField', { personality })}
                style={[
                  font('body'),
                  {
                    marginTop: 7,
                    minHeight: 44,
                    borderWidth: 1,
                    borderColor: colors.lineSoft,
                    borderRadius: 12,
                    paddingVertical: 11,
                    paddingHorizontal: 13,
                    color: colors.ink800,
                  },
                ]}
              />

              <Text style={[font('label', 700), { fontSize: 12, color: colors.slate400, marginTop: 14 }]}>
                {t('catalogue.priceField', { personality }).toUpperCase()}
              </Text>
              <TextInput
                value={draft.price}
                onChangeText={(price) => setDraft({ ...draft, price })}
                keyboardType="decimal-pad"
                placeholder="0,00"
                placeholderTextColor={colors.slate400}
                accessibilityLabel={t('catalogue.priceField', { personality })}
                style={[
                  font('body'),
                  {
                    marginTop: 7,
                    minHeight: 44,
                    borderWidth: 1,
                    borderColor: colors.lineSoft,
                    borderRadius: 12,
                    paddingVertical: 11,
                    paddingHorizontal: 13,
                    color: colors.ink800,
                  },
                ]}
              />

              <Text style={[font('label', 700), { fontSize: 12, color: colors.slate400, marginTop: 14 }]}>
                {t('catalogue.vatField', { personality }).toUpperCase()}
              </Text>
              <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 8, marginTop: 8 }}>
                {VAT_CHOICES.map((rate) => (
                  <Chip
                    key={rate}
                    label={t('catalogue.vatRatePct', { personality, params: { rate: fmtRate(rate) } })}
                    active={draft.vatRate === rate}
                    onPress={() => setDraft({ ...draft, vatRate: rate })}
                  />
                ))}
              </View>

              <Text style={[font('label', 700), { fontSize: 12, color: colors.slate400, marginTop: 14 }]}>
                {t('catalogue.categoryField', { personality }).toUpperCase()}
              </Text>
              <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 8, marginTop: 8 }}>
                {CATALOGUE_CATEGORIES.map((cat) => (
                  <Chip
                    key={cat}
                    label={t(CATEGORY_KEY[cat], { personality })}
                    active={draft.category === cat}
                    onPress={() => setDraft({ ...draft, category: cat })}
                  />
                ))}
              </View>

              <Button
                title={t('catalogue.save', { personality })}
                variant="primary"
                disabled={!draftValid}
                loading={upsert.isPending}
                style={{ marginTop: 18 }}
                onPress={save}
              />
              {draft.source !== null && draft.source.source === 'perso' ? (
                <Pressable
                  accessibilityRole="button"
                  accessibilityLabel={t('catalogue.delete', { personality })}
                  onPress={deletePerso}
                  style={{ minHeight: 44, alignItems: 'center', justifyContent: 'center', marginTop: 6 }}
                >
                  <Text style={[font('label', 600), { fontSize: 14, color: semantic.danger }]}>
                    {t('catalogue.delete', { personality })}
                  </Text>
                </Pressable>
              ) : null}
            </>
          ) : null}
        </KeyboardAvoidingView>
      </Sheet>

      <Toast
        message={toast ?? ''}
        visible={toast !== null}
        onHide={() => setToast(null)}
        icon={<CheckIcon color={colors.surface} size={16} strokeWidth={2.4} />}
      />
    </View>
  );
}
