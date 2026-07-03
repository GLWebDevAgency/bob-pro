/**
 * Documents — le coffre-fort (claim C14, réf design_handoff_bob_pro/Bob Pro.dc.html §isDocs).
 * Composition 100 % @bob/ui + tokens `vault` : InnerScreenHeader → recherche réelle →
 * carte Scan (dégradé cta) → « À valider » (docs OCR non classés) → « Tes dossiers »
 * (6 dossiers du proto, counts réels) → « Compta & conformité » (mois prêt + export FEC réel,
 * factures récentes → /facture/[id], mémoire fournisseurs) → footer.
 *
 * DONNÉES RÉELLES (doctrine A1-C10) : deriveVaultView/searchVault (@bob/core, use cases purs —
 * directive 08:07 : le socle s'enrichit pour Bob autant que pour l'UI) sur les queries du
 * BobClient. AUCUN repli fixtures : loading → skeletons · erreur → voix de Bob (docs.dataError) ·
 * coffre vide → docs.emptyTitle/Body · sections sans donnée masquées ou à zéro honnête.
 *
 * PARITÉ D'ACTIONS : scan → /scan-document (extractDocument/recordExpense, mêmes use cases que
 * Bob) · export → client.exportFec (artefact FEC réel du core) · facture → /facture/[id].
 * « Classer là » (A1-C14) : confirmation RÉELLE du classement proposé après OCR —
 * client.classifyDocument (use case ClassifyDocument @bob/core, même chemin pour Bob).
 * Écarts proto assumés : carte « Attestation décennale » non rendue (pas d'échéance d'assurance
 * dans le modèle) · tuiles dossiers non navigables v1 (détail dossier à venir) · « Autre
 * dossier » viendra avec le domaine dossiers (picker) — en attendant, bouton « Ouvrir ».
 */
import { useMemo, useState } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { Linking, Pressable, ScrollView, Text, TextInput, View } from 'react-native';
import { useRouter } from 'expo-router';
import { LinearGradient } from 'expo-linear-gradient';
import { Feather } from '@expo/vector-icons';
import {
  deriveVaultView,
  formatEUR,
  formatEURWhole,
  searchVault,
  type VaultDocumentData,
  type VaultFolderKey,
  type VaultPendingDoc,
  type VaultRecentInvoice,
  type VaultView,
} from '@bob/core';
import { conformityCard, shadowComponentsNative, shadowNative, vault, vaultShadowNative } from '@bob/tokens';
import { t, type Personality } from '@bob/i18n';
import { Button, Card, IconTile, InnerScreenHeader, Sheet, Toast, font, parseGradient, useTheme } from '@bob/ui';
import { useBobClient } from '../../src/data/client';
import { shareFec } from '../../src/lib/share-fec';
import { useChantiers, useCustomers, useExpenses, useExportFec, useInvoices } from '../../src/data/hooks';
import { useDocuments } from '../../src/data/documents';
import {
  ChartIcon,
  ChatIcon,
  ChevronRightIcon,
  ClipboardCheckIcon,
  FileIcon,
  FolderSmallIcon,
  SearchIcon,
  SparkSmallIcon,
} from '../../src/components/icons';

const MONTHS_CAP = [
  'Janvier',
  'Février',
  'Mars',
  'Avril',
  'Mai',
  'Juin',
  'Juillet',
  'Août',
  'Septembre',
  'Octobre',
  'Novembre',
  'Décembre',
] as const;

/** Date du jour AAAA-MM-JJ (DateOnly du core) — sans Intl, comme formatEUR. */
function todayISO(d: Date = new Date()): string {
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${d.getFullYear()}-${m}-${day}`;
}

function formatDate(iso: string): string {
  const [y, m, d] = iso.slice(0, 10).split('-');
  return d && m && y ? `${d}/${m}/${y}` : iso.slice(0, 10);
}

/** « il y a 2 min » / « il y a 3 h » / date — copy docs.ago* (voix de Bob). */
function agoLabel(instant: string, personality: Personality): string {
  const diffMin = Math.max(0, Math.round((Date.now() - Date.parse(instant)) / 60_000));
  if (diffMin < 60) return t('docs.agoMinutes', { personality, params: { n: Math.max(1, diffMin) } });
  if (diffMin < 1440) return t('docs.agoHours', { personality, params: { n: Math.round(diffMin / 60) } });
  return formatDate(instant);
}

/** Teintes des 6 dossiers (DOCS_FOLDERS du proto — tokens sémantiques + vault.aiDeep). */
function useFolderTints(): Record<VaultFolderKey, { tint: string; bg: string }> {
  const { semantic } = useTheme();
  return {
    chantiers: { tint: semantic.b2b, bg: semantic.b2bBg },
    achats: { tint: semantic.success, bg: semantic.successBg },
    assurances: { tint: semantic.particulier, bg: semantic.particulierBg },
    fiscal: { tint: vault.aiDeep, bg: semantic.aiBg },
    banque: { tint: semantic.b2b, bg: semantic.b2bBg },
    comptable: { tint: semantic.success, bg: semantic.successBg },
  };
}

const FOLDER_LABEL_KEY: Record<VaultFolderKey, 'docs.folderChantiers' | 'docs.folderAchats' | 'docs.folderAssurances' | 'docs.folderFiscal' | 'docs.folderBanque' | 'docs.folderComptable'> = {
  chantiers: 'docs.folderChantiers',
  achats: 'docs.folderAchats',
  assurances: 'docs.folderAssurances',
  fiscal: 'docs.folderFiscal',
  banque: 'docs.folderBanque',
  comptable: 'docs.folderComptable',
};

const KIND_LABEL_KEY = {
  deposit: 'docs.kindDeposit',
  final: 'docs.kindFinal',
  credit_note: 'docs.kindCreditNote',
  situation: 'docs.kindSituation',
} as const;

/** Skeleton d'un bloc de section pendant le chargement initial. */
function SkeletonBlock({ height }: { height: number }) {
  const { colors } = useTheme();
  return <View style={{ height, borderRadius: 18, backgroundColor: colors.lineSoft }} />;
}

/** Vignette « papier » 46×58 de la carte à valider (dégradé 160° + barre basse). */
function DocThumb() {
  return (
    <LinearGradient
      colors={[vault.thumbTop, vault.thumbBottom]}
      start={{ x: 0.2, y: 0 }}
      end={{ x: 0.8, y: 1 }}
      style={{
        width: 46,
        height: 58,
        borderRadius: 8,
        borderWidth: 1,
        borderColor: vault.thumbBorder,
        justifyContent: 'flex-end',
        padding: 5,
      }}
    >
      <View style={{ height: 5, borderRadius: 2, backgroundColor: vault.thumbBar }} />
    </LinearGradient>
  );
}

/** Carte « À valider » — doc OCR non classé, métriques réelles du rapprochement dépense. */
function PendingCard({
  doc,
  onOpen,
  onClassify,
  onPickTarget,
  classifying,
}: {
  doc: VaultPendingDoc;
  onOpen: () => void;
  onClassify: (expenseId: string) => void;
  /** A8 : ouvre le choix d'une AUTRE destination (chantiers…) — le 1-tap IA reste premier. */
  onPickTarget: () => void;
  classifying: boolean;
}) {
  const { personality, colors, semantic } = useTheme();
  const exp = doc.matchedExpense;
  return (
    <View
      style={{
        backgroundColor: colors.surface,
        borderRadius: 20,
        borderWidth: 1,
        borderColor: vault.toValidateBorder,
        padding: 16,
        ...shadowComponentsNative.priorityCard,
      }}
    >
      <View style={{ flexDirection: 'row', gap: 13 }}>
        <DocThumb />
        <View style={{ flex: 1, minWidth: 0 }}>
          <View style={{ flexDirection: 'row', alignItems: 'center', gap: 7, marginBottom: 2 }}>
            <View style={{ backgroundColor: semantic.aiBg, borderRadius: 5, paddingVertical: 2, paddingHorizontal: 6 }}>
              <Text style={{ ...font('label', 700), fontSize: 10, color: vault.aiDeep }}>
                {t('docs.badgeSupplierInvoice', { personality }).toUpperCase()}
              </Text>
            </View>
            <Text style={{ ...font('meta', 500), fontSize: 11, color: colors.slate300 }}>
              {agoLabel(doc.receivedAt, personality)}
            </Text>
          </View>
          <Text style={[font('cardTitle'), { color: colors.ink800 }]} numberOfLines={1}>
            {exp?.supplierName ?? doc.filename}
          </Text>
        </View>
      </View>

      {exp ? (
        <>
          <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 8, marginVertical: 13 }}>
            <View style={{ backgroundColor: vault.metricChipBg, borderRadius: 9, paddingVertical: 7, paddingHorizontal: 10, flexDirection: 'row' }}>
              <Text style={{ ...font('meta', 500), fontSize: 12.5, color: colors.slate400 }}>
                {t('docs.metricAmount', { personality })}
              </Text>
              <Text style={{ ...font('meta', 700), fontSize: 12.5, color: colors.ink800, fontVariant: ['tabular-nums'] }}>
                {formatEUR(exp.totalTtcCents)}
              </Text>
            </View>
            {exp.vatCents !== null ? (
              <View style={{ backgroundColor: vault.metricChipBg, borderRadius: 9, paddingVertical: 7, paddingHorizontal: 10, flexDirection: 'row' }}>
                <Text style={{ ...font('meta', 500), fontSize: 12.5, color: colors.slate400 }}>
                  {t('docs.metricVat', { personality })}
                </Text>
                <Text style={{ ...font('meta', 700), fontSize: 12.5, color: semantic.success, fontVariant: ['tabular-nums'] }}>
                  {formatEUR(exp.vatCents)}
                </Text>
              </View>
            ) : null}
            <View style={{ backgroundColor: vault.metricChipBg, borderRadius: 9, paddingVertical: 7, paddingHorizontal: 10, flexDirection: 'row' }}>
              <Text style={{ ...font('meta', 500), fontSize: 12.5, color: colors.slate400 }}>
                {t('docs.metricDate', { personality })}
              </Text>
              <Text style={{ ...font('meta', 700), fontSize: 12.5, color: colors.ink800 }}>
                {formatDate(exp.documentDate)}
              </Text>
            </View>
          </View>
          <View
            style={{
              flexDirection: 'row',
              alignItems: 'center',
              gap: 7,
              backgroundColor: conformityCard.bgTop,
              borderRadius: 11,
              paddingVertical: 9,
              paddingHorizontal: 12,
              marginBottom: 13,
            }}
          >
            <SparkSmallIcon color={semantic.b2g} />
            <Text style={{ ...font('meta', 600), fontSize: 12.5, color: semantic.b2g, flex: 1 }}>
              {t('docs.aiGuessExpense', { personality, params: { supplier: exp.supplierName } })}
            </Text>
          </View>
        </>
      ) : (
        <View style={{ height: 13 }} />
      )}

      <View style={{ flexDirection: 'row', gap: 9 }}>
        {exp ? (
          <Button
            title={t('docs.classify', { personality })}
            variant="ai"
            size="compact"
            radius={12}
            loading={classifying}
            style={{ flex: 1 }}
            onPress={() => onClassify(exp.id)}
            accessibilityLabel={`${t('docs.classify', { personality })} — ${exp.supplierName}`}
          />
        ) : null}
        <Button
          title={t('docs.open', { personality })}
          variant="secondary"
          size="compact"
          radius={12}
          {...(exp ? {} : { style: { alignSelf: 'flex-start' } })}
          onPress={onOpen}
          accessibilityLabel={`${t('docs.open', { personality })} — ${doc.filename}`}
        />
      </View>

      {/* A8 : autre destination (chantier…) — lien discret, la proposition IA reste le 1-tap. */}
      <Pressable
        accessibilityRole="button"
        accessibilityLabel={t('docs.pickOther', { personality })}
        onPress={onPickTarget}
        hitSlop={6}
        style={{ alignSelf: 'flex-start', marginTop: 10 }}
      >
        <Text style={{ ...font('meta', 600), fontSize: 12.5, color: semantic.b2b }}>
          {t('docs.pickOther', { personality })}
        </Text>
      </Pressable>
    </View>
  );
}

export default function Documents() {
  const { personality, colors, semantic, controls, overlays, grad } = useTheme();
  const router = useRouter();
  const client = useBobClient();
  const documents = useDocuments();
  const expenses = useExpenses();
  const invoices = useInvoices();
  const customers = useCustomers();
  const exportFec = useExportFec();
  const queryClient = useQueryClient();

  const [query, setQuery] = useState('');
  const [toast, setToast] = useState<string | null>(null);
  // A8 : doc en cours de classement manuel (Sheet des destinations réelles).
  const [pickerDoc, setPickerDoc] = useState<VaultPendingDoc | null>(null);
  const chantiers = useChantiers();
  const openChantiers = useMemo(
    () => (chantiers.data ?? []).filter((c) => c.status === 'open'),
    [chantiers.data],
  );

  // « Classer là » (A1-C14) + picker de cible (A8) : confirme le classement — même use
  // case que Bob (classifyDocument), la cible peut être la dépense proposée OU un chantier.
  const classify = useMutation({
    mutationFn: async (input: {
      documentId: string;
      linkedEntityType: 'expense' | 'chantier';
      linkedEntityId: string;
      toast: string;
    }) => {
      const r = await client.classifyDocument({
        documentId: input.documentId,
        linkedEntityType: input.linkedEntityType,
        linkedEntityId: input.linkedEntityId,
      });
      if (!r.ok) throw r.error;
      return input;
    },
    onSuccess: (input) => {
      void queryClient.invalidateQueries({ queryKey: ['documents'] });
      void queryClient.invalidateQueries({ queryKey: ['expenses'] });
      setPickerDoc(null);
      setToast(input.toast);
    },
    onError: () => setToast(t('docs.classifyError', { personality })),
  });


  const cta = parseGradient(grad.cta);
  const folderTints = useFolderTints();

  const isLoading = documents.isLoading || expenses.isLoading || invoices.isLoading || customers.isLoading;
  const hasError = documents.isError || expenses.isError || invoices.isError || customers.isError;

  // Projections structurelles : DocumentView/ExpenseProps/InvoiceView/CustomerListItem ⊇ Vault*Data.
  const view: VaultView | null = useMemo(() => {
    if (!documents.data || !expenses.data || !invoices.data || !customers.data) return null;
    return deriveVaultView({
      documents: documents.data,
      expenses: expenses.data,
      invoices: invoices.data,
      customers: customers.data,
      today: todayISO(),
    });
  }, [documents.data, expenses.data, invoices.data, customers.data]);

  const trimmedQuery = query.trim();
  const results: VaultDocumentData[] = useMemo(
    () => (trimmedQuery.length > 0 && documents.data ? searchVault(documents.data, trimmedQuery) : []),
    [documents.data, trimmedQuery],
  );

  const openDocument = async (id: string): Promise<void> => {
    const r = await client.documentDownloadUrl(id);
    if (r.ok) await Linking.openURL(r.value.url);
    else setToast(t('docs.dataError', { personality }));
  };

  const runExport = (): void => {
    const today = todayISO();
    exportFec.mutate(
      { from: `${today.slice(0, 7)}-01`, to: today },
      {
        onSuccess: (out) => {
          // C17 : le VRAI fichier part au comptable (feuille de partage native) ;
          // repli honnête si le partage est indisponible — le FEC est généré, on le dit.
          void shareFec(out).then((r) => {
            if (r === 'unavailable')
              setToast(t('docs.exportDone', { personality, params: { filename: out.filename } }));
          });
        },
        onError: () => setToast(t('docs.exportError', { personality })),
      },
    );
  };

  const monthLabel = MONTHS_CAP[new Date().getMonth()] ?? '';
  const summary = view?.monthSummary ?? null;
  const summaryParts: { text: string; warn: boolean }[] = summary
    ? [
        {
          text:
            summary.salesCount === 1
              ? t('docs.monthSalesOne', { personality })
              : t('docs.monthSales', { personality, params: { count: summary.salesCount } }),
          warn: false,
        },
        {
          text:
            summary.purchasesCount === 1
              ? t('docs.monthPurchasesOne', { personality })
              : t('docs.monthPurchases', { personality, params: { count: summary.purchasesCount } }),
          warn: false,
        },
        ...(summary.vatRecoverableCents !== null
          ? [{ text: t('docs.monthVat', { personality, params: { amount: formatEURWhole(summary.vatRecoverableCents) } }), warn: false }]
          : []),
        ...(summary.missingReceiptsCount > 0
          ? [
              {
                text:
                  summary.missingReceiptsCount === 1
                    ? t('docs.monthMissingOne', { personality })
                    : t('docs.monthMissing', { personality, params: { count: summary.missingReceiptsCount } }),
                warn: true,
              },
            ]
          : []),
      ]
    : [];

  const recentSub = (invoice: VaultRecentInvoice): string => {
    const kind = t(KIND_LABEL_KEY[invoice.kind], { personality });
    if (invoice.customerType === 'b2b') return t('docs.recentSubB2b', { personality, params: { kind } });
    if (invoice.customerType === 'b2g') return t('docs.recentSubB2g', { personality });
    return t('docs.recentSubB2c', { personality });
  };

  const searching = trimmedQuery.length > 0;
  const empty = view !== null && view.totalCount === 0 && view.toValidate.length === 0;

  return (
    <View style={{ flex: 1, backgroundColor: colors.bg }}>
      <ScrollView style={{ flex: 1 }} contentContainerStyle={{ paddingBottom: 140 }}>
        <InnerScreenHeader
          eyebrow={t('docs.eyebrow', { personality })}
          title={t('docs.title', { personality })}
          subtitle={t('docs.subtitle', { personality })}
        />

        {/* Recherche réelle sur le coffre (searchVault @bob/core) */}
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
            placeholder={t('docs.searchPlaceholder', { personality })}
            placeholderTextColor={colors.slate300}
            accessibilityLabel={t('docs.searchPlaceholder', { personality })}
            style={{ ...font('body'), fontSize: 14, color: colors.ink800, flex: 1, padding: 0 }}
          />
        </View>

        {/* Carte Scan — parité d'actions : même flux OCR que Bob (/scan-document) */}
        <Pressable
          accessibilityRole="button"
          accessibilityLabel={t('docs.scanTitle', { personality })}
          onPress={() => router.push('/scan-document')}
          style={({ pressed }) => [{ marginTop: 14, marginHorizontal: 18, transform: [{ scale: pressed ? 0.98 : 1 }] }]}
        >
          <LinearGradient
            colors={cta.colors}
            start={cta.start}
            end={cta.end}
            style={{
              flexDirection: 'row',
              alignItems: 'center',
              gap: 14,
              borderRadius: 20,
              padding: 16,
              ...vaultShadowNative.scan,
            }}
          >
            <View
              style={{
                width: 46,
                height: 46,
                borderRadius: 14,
                backgroundColor: vault.scanChipBg,
                borderWidth: 1,
                borderColor: vault.scanChipBorder,
                alignItems: 'center',
                justifyContent: 'center',
              }}
            >
              <Feather name="camera" size={22} color={vault.scanChipIcon} />
            </View>
            <View style={{ flex: 1 }}>
              <Text style={[font('button'), { color: colors.surface }]}>
                {t('docs.scanTitle', { personality })}
              </Text>
              <Text style={{ ...font('sub', 500), fontSize: 13, color: overlays.white60, marginTop: 1 }}>
                {t('docs.scanSub', { personality })}
              </Text>
            </View>
            <ChevronRightIcon color={overlays.white50} size={18} strokeWidth={2.2} />
          </LinearGradient>
        </Pressable>

        {hasError ? (
          <View style={{ paddingHorizontal: 18, paddingTop: 20 }}>
            <Card>
              <Text style={[font('sub'), { color: colors.slate500 }]}>
                {t('docs.dataError', { personality })}
              </Text>
            </Card>
          </View>
        ) : isLoading ? (
          <View style={{ paddingHorizontal: 18, paddingTop: 20, gap: 12 }}>
            <SkeletonBlock height={120} />
            <SkeletonBlock height={180} />
            <SkeletonBlock height={140} />
          </View>
        ) : searching ? (
          /* Résultats de recherche — rows réelles, ouverture du document */
          <View style={{ paddingHorizontal: 18, paddingTop: 20, gap: 10 }}>
            {/* A7 : porte d'entrée vers la recherche GLOBALE (clients + pièces + docs). */}
            <Pressable
              accessibilityRole="button"
              accessibilityLabel={t('search.everywhere', { personality, params: { query: trimmedQuery } })}
              onPress={() => router.push({ pathname: '/recherche', params: { q: trimmedQuery } })}
            >
              <Card>
                <View style={{ flexDirection: 'row', alignItems: 'center', gap: 10 }}>
                  <SearchIcon color={semantic.b2b} />
                  <Text style={{ ...font('body', 700), fontSize: 14, color: semantic.b2b, flex: 1 }} numberOfLines={1}>
                    {t('search.everywhere', { personality, params: { query: trimmedQuery } })}
                  </Text>
                  <ChevronRightIcon color={controls.chevron} size={14} strokeWidth={2} />
                </View>
              </Card>
            </Pressable>
            {results.length === 0 ? (
              <Card>
                <Text style={[font('sub'), { color: colors.slate500 }]}>
                  {t('docs.noResults', { personality, params: { query: trimmedQuery } })}
                </Text>
              </Card>
            ) : (
              results.map((docItem) => (
                <Pressable
                  key={docItem.id}
                  accessibilityRole="button"
                  accessibilityLabel={docItem.filename}
                  onPress={() => void openDocument(docItem.id)}
                >
                  <Card>
                    <View style={{ flexDirection: 'row', alignItems: 'center', gap: 11 }}>
                      <View
                        style={{
                          width: 34,
                          height: 34,
                          borderRadius: 10,
                          backgroundColor: colors.lineSoft,
                          alignItems: 'center',
                          justifyContent: 'center',
                        }}
                      >
                        <FileIcon color={colors.slate500} />
                      </View>
                      <View style={{ flex: 1, minWidth: 0 }}>
                        <Text style={{ ...font('body', 700), fontSize: 14, color: colors.ink800 }} numberOfLines={1}>
                          {docItem.filename}
                        </Text>
                        <Text style={{ ...font('meta', 500), color: colors.slate300, marginTop: 2 }}>
                          {formatDate(docItem.documentDate ?? docItem.createdAt)}
                        </Text>
                      </View>
                      <ChevronRightIcon color={controls.chevron} size={14} strokeWidth={2} />
                    </View>
                  </Card>
                </Pressable>
              ))
            )}
          </View>
        ) : view ? (
          <>
            {/* À valider — uniquement s'il y a des docs OCR non classés (données réelles) */}
            {view.toValidate.length > 0 ? (
              <View style={{ paddingHorizontal: 18, paddingTop: 20 }}>
                <View style={{ flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', marginBottom: 12 }}>
                  <Text style={[font('cardTitle'), { color: colors.ink800 }]} accessibilityRole="header">
                    {t('docs.sectionToValidate', { personality })}
                  </Text>
                  <View style={{ backgroundColor: semantic.b2g, borderRadius: 10, paddingVertical: 2, paddingHorizontal: 8 }}>
                    <Text style={{ ...font('meta', 700), color: colors.surface }}>{view.toValidate.length}</Text>
                  </View>
                </View>
                <View style={{ gap: 11 }}>
                  {view.toValidate.map((p) => (
                    <PendingCard
                      key={p.id}
                      doc={p}
                      onOpen={() => void openDocument(p.id)}
                      onPickTarget={() => setPickerDoc(p)}
                      classifying={classify.isPending && classify.variables?.documentId === p.id}
                      onClassify={(expenseId) =>
                        classify.mutate({
                          documentId: p.id,
                          linkedEntityType: 'expense',
                          linkedEntityId: expenseId,
                          toast: t('docs.classifiedToast', {
                            personality,
                            params: { supplier: p.matchedExpense?.supplierName ?? p.filename },
                          }),
                        })
                      }
                    />
                  ))}
                </View>
              </View>
            ) : null}

            {empty ? (
              <View style={{ paddingHorizontal: 18, paddingTop: 20 }}>
                <Card>
                  <Text style={[font('cardTitle'), { color: colors.ink800 }]}>
                    {t('docs.emptyTitle', { personality })}
                  </Text>
                  <Text style={[font('sub'), { color: colors.slate500, marginTop: 4, lineHeight: 19 }]}>
                    {t('docs.emptyBody', { personality })}
                  </Text>
                </Card>
              </View>
            ) : (
              /* Tes dossiers — 6 dossiers du proto, counts dérivés réels */
              <View style={{ paddingHorizontal: 18, paddingTop: 20 }}>
                <Text style={[font('cardTitle'), { color: colors.ink800, marginBottom: 12 }]} accessibilityRole="header">
                  {t('docs.sectionFolders', { personality })}
                </Text>
                <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 11 }}>
                  {view.folders.map((folder) => (
                    <View
                      key={folder.key}
                      style={{
                        flexBasis: '47%',
                        flexGrow: 1,
                        backgroundColor: colors.surface,
                        borderRadius: 16,
                        borderWidth: 1,
                        borderColor: controls.cardBorder,
                        padding: 14,
                        ...shadowNative.e1,
                      }}
                    >
                      <View
                        style={{
                          width: 36,
                          height: 36,
                          borderRadius: 11,
                          backgroundColor: folderTints[folder.key].bg,
                          alignItems: 'center',
                          justifyContent: 'center',
                          marginBottom: 10,
                        }}
                      >
                        <FolderSmallIcon color={folderTints[folder.key].tint} />
                      </View>
                      <Text style={{ ...font('body', 600), fontSize: 14, color: colors.ink800 }}>
                        {t(FOLDER_LABEL_KEY[folder.key], { personality })}
                      </Text>
                      <Text style={{ ...font('meta', 500), color: colors.slate300, marginTop: 1 }}>
                        {folder.count === 0
                          ? t('docs.folderCountNone', { personality })
                          : folder.count === 1
                            ? t('docs.folderCountOne', { personality })
                            : t('docs.folderCount', { personality, params: { count: folder.count } })}
                      </Text>
                    </View>
                  ))}
                </View>
              </View>
            )}

            {/* Compta & conformité */}
            <View style={{ paddingHorizontal: 18, paddingTop: 20 }}>
              <Text style={[font('cardTitle'), { color: colors.ink800, marginBottom: 12 }]} accessibilityRole="header">
                {t('docs.sectionCompta', { personality })}
              </Text>

              <LinearGradient
                colors={[vault.monthReadyTop, vault.monthReadyBottom]}
                start={{ x: 0.5, y: 0 }}
                end={{ x: 0.5, y: 1 }}
                style={{ borderRadius: 18, borderWidth: 1, borderColor: vault.monthReadyBorder, padding: 16, marginBottom: 12 }}
              >
                <View style={{ flexDirection: 'row', alignItems: 'flex-start', gap: 11 }}>
                  <View
                    style={{
                      width: 34,
                      height: 34,
                      borderRadius: 10,
                      backgroundColor: semantic.successBg,
                      alignItems: 'center',
                      justifyContent: 'center',
                    }}
                  >
                    <ClipboardCheckIcon color={semantic.success} />
                  </View>
                  <View style={{ flex: 1, minWidth: 0 }}>
                    <Text style={{ ...font('body', 700), fontSize: 14, color: colors.ink800 }}>
                      {t('docs.monthReadyTitle', { personality, params: { month: monthLabel } })}
                    </Text>
                    <Text style={{ ...font('sub', 500), fontSize: 12.5, color: colors.slate500, marginTop: 2, lineHeight: 18 }}>
                      {summaryParts.map((part, i) => (
                        <Text
                          key={part.text}
                          style={part.warn ? { ...font('sub', 700), fontSize: 12.5, color: semantic.warning } : null}
                        >
                          {i > 0 ? ' · ' : ''}
                          {part.text}
                        </Text>
                      ))}
                      .
                    </Text>
                  </View>
                </View>
                <Pressable
                  accessibilityRole="button"
                  accessibilityLabel={t('docs.exportCta', { personality })}
                  disabled={exportFec.isPending}
                  onPress={runExport}
                  style={({ pressed }) => [
                    {
                      marginTop: 13,
                      backgroundColor: semantic.success,
                      borderRadius: 12,
                      paddingVertical: 12,
                      alignItems: 'center',
                      minHeight: 44,
                      justifyContent: 'center',
                      opacity: exportFec.isPending ? 0.7 : pressed ? 0.9 : 1,
                    },
                  ]}
                >
                  <Text style={{ ...font('body', 700), fontSize: 14, color: colors.surface }}>
                    {t('docs.exportCta', { personality })}
                  </Text>
                </Pressable>
              </LinearGradient>

              {/* Accès au grand-livre (C17) : la compta complète (journal, équilibre, clôture)
                  vit sur son écran dédié — ici, la porte d'entrée. */}
              <Pressable
                accessibilityRole="button"
                accessibilityLabel={t('compta.title', { personality })}
                onPress={() => router.push('/comptabilite')}
                style={{ marginBottom: 12 }}
              >
                <View
                  style={{
                    backgroundColor: colors.surface,
                    borderRadius: 18,
                    borderWidth: 1,
                    borderColor: controls.cardBorder,
                    padding: 16,
                    flexDirection: 'row',
                    alignItems: 'center',
                    gap: 11,
                    ...shadowNative.e1,
                  }}
                >
                  <View
                    style={{
                      width: 34,
                      height: 34,
                      borderRadius: 10,
                      backgroundColor: semantic.successBg,
                      alignItems: 'center',
                      justifyContent: 'center',
                    }}
                  >
                    <ChartIcon color={semantic.success} />
                  </View>
                  <View style={{ flex: 1, minWidth: 0 }}>
                    <Text style={{ ...font('body', 700), fontSize: 14, color: colors.ink800 }}>
                      {t('compta.title', { personality })}
                    </Text>
                    <Text style={{ ...font('meta', 500), color: colors.slate300, marginTop: 1 }} numberOfLines={1}>
                      {t('compta.subtitle', { personality })}
                    </Text>
                  </View>
                  <ChevronRightIcon color={controls.chevron} size={14} strokeWidth={2} />
                </View>
              </Pressable>

              {view.recentInvoices.length > 0 ? (
                <View
                  style={{
                    backgroundColor: colors.surface,
                    borderRadius: 18,
                    borderWidth: 1,
                    borderColor: controls.cardBorder,
                    paddingVertical: 6,
                    paddingHorizontal: 16,
                    marginBottom: 12,
                    ...shadowNative.e1,
                  }}
                >
                  <Text
                    style={{
                      ...font('eyebrow'),
                      letterSpacing: 0.3,
                      color: controls.tabInactive,
                      paddingTop: 12,
                      paddingBottom: 4,
                    }}
                  >
                    {t('docs.sectionRecent', { personality })}
                  </Text>
                  {view.recentInvoices.map((invoice, i) => (
                    <Pressable
                      key={invoice.id}
                      accessibilityRole="button"
                      accessibilityLabel={`${invoice.number} · ${invoice.customerName}`}
                      onPress={() => router.push(`/facture/${invoice.id}`)}
                      style={{
                        flexDirection: 'row',
                        alignItems: 'center',
                        gap: 11,
                        paddingVertical: 12,
                        borderBottomWidth: i < view.recentInvoices.length - 1 ? 1 : 0,
                        borderBottomColor: colors.lineSoft,
                      }}
                    >
                      <View
                        style={{
                          width: 34,
                          height: 34,
                          borderRadius: 10,
                          backgroundColor: invoice.customerType === 'b2b' ? semantic.b2bBg : invoice.customerType === 'b2g' ? semantic.b2gBg : semantic.particulierBg,
                          alignItems: 'center',
                          justifyContent: 'center',
                        }}
                      >
                        <FileIcon
                          color={invoice.customerType === 'b2b' ? semantic.b2b : invoice.customerType === 'b2g' ? semantic.b2g : semantic.particulier}
                        />
                      </View>
                      <View style={{ flex: 1, minWidth: 0 }}>
                        <Text style={{ ...font('body', 700), fontSize: 14, color: colors.ink800 }} numberOfLines={1}>
                          {invoice.number} · {invoice.customerName}
                        </Text>
                        <Text style={{ ...font('meta', 500), color: colors.slate300, marginTop: 1 }}>
                          {recentSub(invoice)}
                        </Text>
                      </View>
                      <Text style={{ ...font('sub', 700), color: colors.ink800, fontVariant: ['tabular-nums'] }}>
                        {formatEUR(invoice.ttcCents)}
                      </Text>
                    </Pressable>
                  ))}
                </View>
              ) : null}

              {view.supplierMemory.count > 0 ? (
                <View
                  style={{
                    flexDirection: 'row',
                    alignItems: 'center',
                    gap: 10,
                    backgroundColor: semantic.aiBg,
                    borderWidth: 1,
                    borderColor: vault.aiDeepBg,
                    borderRadius: 14,
                    paddingVertical: 12,
                    paddingHorizontal: 14,
                  }}
                >
                  <View
                    style={{
                      width: 30,
                      height: 30,
                      borderRadius: 9,
                      backgroundColor: vault.aiDeepBg,
                      alignItems: 'center',
                      justifyContent: 'center',
                    }}
                  >
                    <ChatIcon color={vault.aiDeep} />
                  </View>
                  <Text style={{ ...font('meta', 500), fontSize: 12.5, color: semantic.aiInk, flex: 1, lineHeight: 17 }}>
                    <Text style={{ ...font('meta', 700), fontSize: 12.5, color: semantic.aiInk }}>
                      {t('docs.memoryTitle', { personality })}
                    </Text>
                    {' — '}
                    {view.supplierMemory.count === 1
                      ? t('docs.memoryBodyOne', { personality, params: { examples: view.supplierMemory.examples.join(', ') } })
                      : t('docs.memoryBody', {
                          personality,
                          params: { examples: view.supplierMemory.examples.join(', '), count: view.supplierMemory.count },
                        })}
                  </Text>
                </View>
              ) : null}
            </View>

            {view.totalCount > 0 ? (
              <Text
                style={[
                  font('meta', 500),
                  { color: colors.slate300, textAlign: 'center', paddingTop: 22, paddingBottom: 8 },
                ]}
              >
                {view.totalCount === 1
                  ? t('docs.footerOne', { personality })
                  : t('docs.footer', { personality, params: { count: view.totalCount } })}
              </Text>
            ) : null}
          </>
        ) : null}
      </ScrollView>

      {/* A8 : Sheet des destinations RÉELLES — proposition IA en tête, puis chantiers ouverts. */}
      <Sheet visible={pickerDoc !== null} onClose={() => setPickerDoc(null)}>
        <Text style={[font('cardTitle'), { color: colors.ink900, marginBottom: 12 }]} accessibilityRole="header">
          {t('docs.pickTitle', { personality })}
        </Text>
        {pickerDoc?.matchedExpense ? (
          <Pressable
            accessibilityRole="button"
            accessibilityLabel={pickerDoc.matchedExpense.supplierName}
            disabled={classify.isPending}
            onPress={() =>
              classify.mutate({
                documentId: pickerDoc.id,
                linkedEntityType: 'expense',
                linkedEntityId: pickerDoc.matchedExpense!.id,
                toast: t('docs.classifiedToast', {
                  personality,
                  params: { supplier: pickerDoc.matchedExpense!.supplierName },
                }),
              })
            }
            style={{
              flexDirection: 'row',
              alignItems: 'center',
              gap: 11,
              paddingVertical: 12,
              borderBottomWidth: 1,
              borderBottomColor: colors.lineSoft,
            }}
          >
            <IconTile tone="success" size={34} radius={10}>
              <SparkSmallIcon color={semantic.success} />
            </IconTile>
            <View style={{ flex: 1, minWidth: 0 }}>
              <Text style={{ ...font('body', 700), fontSize: 14, color: colors.ink800 }} numberOfLines={1}>
                {pickerDoc.matchedExpense.supplierName}
              </Text>
              <Text style={[font('meta'), { color: colors.slate400, marginTop: 1 }]}>
                {t('docs.pickProposalMeta', { personality })}
              </Text>
            </View>
            <ChevronRightIcon color={controls.chevron} size={14} strokeWidth={2} />
          </Pressable>
        ) : null}
        {openChantiers.map((chantier, i) => (
          <Pressable
            key={chantier.id}
            accessibilityRole="button"
            accessibilityLabel={chantier.name}
            disabled={classify.isPending}
            onPress={() =>
              pickerDoc
                ? classify.mutate({
                    documentId: pickerDoc.id,
                    linkedEntityType: 'chantier',
                    linkedEntityId: chantier.id,
                    toast: t('docs.classifiedIntoToast', { personality, params: { name: chantier.name } }),
                  })
                : undefined
            }
            style={{
              flexDirection: 'row',
              alignItems: 'center',
              gap: 11,
              paddingVertical: 12,
              borderBottomWidth: i < openChantiers.length - 1 ? 1 : 0,
              borderBottomColor: colors.lineSoft,
            }}
          >
            <IconTile tone="b2b" size={34} radius={10}>
              <FolderSmallIcon color={semantic.b2b} />
            </IconTile>
            <View style={{ flex: 1, minWidth: 0 }}>
              <Text style={{ ...font('body', 700), fontSize: 14, color: colors.ink800 }} numberOfLines={1}>
                {chantier.name}
              </Text>
              <Text style={[font('meta'), { color: colors.slate400, marginTop: 1 }]}>
                {t('docs.pickChantierMeta', { personality })}
              </Text>
            </View>
            <ChevronRightIcon color={controls.chevron} size={14} strokeWidth={2} />
          </Pressable>
        ))}
        {!pickerDoc?.matchedExpense && openChantiers.length === 0 ? (
          <Text style={[font('sub'), { color: colors.slate500, lineHeight: 19 }]}>
            {t('docs.pickEmpty', { personality })}
          </Text>
        ) : null}
      </Sheet>

      <Toast
        message={toast ?? ''}
        visible={toast !== null}
        onHide={() => setToast(null)}
        icon={<Feather name="check" size={16} color={colors.surface} />}
      />
    </View>
  );
}
