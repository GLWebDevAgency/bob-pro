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
import { KeyboardAvoidingView, Linking, Pressable, RefreshControl, ScrollView, Text, TextInput, View } from 'react-native';
import { useRouter } from 'expo-router';
import { LinearGradient } from 'expo-linear-gradient';
import { Feather } from '@expo/vector-icons';
import {
  deriveVaultView,
  documentSystemFolderLabel,
  formatEUR,
  formatEURWhole,
  searchVault,
  summarizeExpenses,
  validateDocumentFolderName,
  type DocumentFolderSystemKey,
  type VaultDocumentData,
  type VaultExpenseData,
  type VaultFolderKey,
  type VaultPendingDoc,
  type VaultRecentInvoice,
  type VaultView,
  type DocumentFolderView,
} from '@bob/core';
import { conformityCard, shadowComponentsNative, shadowNative, vault, vaultShadowNative } from '@bob/tokens';
import { t, type Personality } from '@bob/i18n';
import {
  Button,
  Card,
  EmptyState,
  ErrorRetry,
  FadeIn,
  IconTile,
  InnerScreenHeader,
  PressableScale,
  Sheet,
  Skeleton,
  SkeletonCard,
  SkeletonRow,
  Toast,
  font,
  parseGradient,
  useTheme,
} from '@bob/ui';
import {
  analysisTypeLabelKey,
  destinationSuggestionSegments,
  formatDayMonth,
  suggestedRenameFor,
} from '../../src/documents/pending-card-copy';
import { useBobClient } from '../../src/data/client';
import { shareFec } from '../../src/lib/share-fec';
import { useChantiers, useCustomers, useExpenses, useExportFec, useInvoices } from '../../src/data/hooks';
import { useCreateDocumentFolder, useDocumentFolders, useDocuments } from '../../src/data/documents';
import { usePublishAgentContext, type AgentContext } from '../../src/agent';
import { useBobAwareScrollInsets } from '../../src/components/use-bob-aware-scroll-insets';
import { hasBlockingAuthoritativeDataError } from '../../src/data/authoritative-query-state';
import {
  ChartIcon,
  ChatIcon,
  ChevronRightIcon,
  ClipboardCheckIcon,
  FileIcon,
  FolderSmallIcon,
  SearchIcon,
  SparkSmallIcon,
  WalletIcon,
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

/** Titre intelligent d'une row du coffre — jamais un nom de fichier brut quand un displayName existe. */
function vaultDocTitle(docItem: VaultDocumentData): string {
  return docItem.displayName?.trim() || docItem.filename;
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

const KIND_LABEL_KEY = {
  deposit: 'docs.kindDeposit',
  final: 'docs.kindFinal',
  credit_note: 'docs.kindCreditNote',
  situation: 'docs.kindSituation',
} as const;

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

/** Chip métrique (fond #F6F8FA radius 9) — libellé gris + valeur 700, teinte injectée. */
function MetricChip({ label, value, valueColor, tabular }: {
  label: string;
  value: string;
  valueColor: string;
  tabular?: boolean;
}) {
  const { colors } = useTheme();
  return (
    <View style={{ backgroundColor: vault.metricChipBg, borderRadius: 9, paddingVertical: 7, paddingHorizontal: 10, flexDirection: 'row' }}>
      <Text style={{ ...font('meta', 500), fontSize: 12.5, color: colors.slate400 }}>{label}</Text>
      <Text style={{ ...font('meta', 700), fontSize: 12.5, color: valueColor, ...(tabular ? { fontVariant: ['tabular-nums'] as const } : {}) }}>
        {value}
      </Text>
    </View>
  );
}

/**
 * Carte « À valider » (handoff §isDocs) — alimentée par les VRAIES données de GET /documents :
 * badge = type analysé (uppercase violet) · titre = displayName intelligent · chips depuis
 * l'extraction même sans dépense rapprochée · « Je pense : … » = destination VALIDÉE côté
 * domaine (chantier nominatif OU dossier hors chantier — jamais un chantier forcé).
 */
function PendingCard({
  doc,
  onOpen,
  onClassify,
  onPickTarget,
  classifying,
}: {
  doc: VaultPendingDoc;
  onOpen: () => void;
  /** 1-tap « Classer là » : applique la destination suggérée (parent = même use case que Bob). */
  onClassify: () => void;
  /** A8 : ouvre le choix d'une AUTRE destination (chantiers + dossiers hors chantier). */
  onPickTarget: () => void;
  classifying: boolean;
}) {
  const { personality, colors, semantic } = useTheme();
  const metrics = doc.metrics;
  const suggestion = doc.suggestedDestination;
  const oneTap = suggestion !== null || doc.matchedExpense !== null;
  const guessSegments = suggestion
    ? destinationSuggestionSegments(suggestion.motif, suggestion.label)
    : null;
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
      {/* Vignette + identité — la rangée ouvre l'original (l'affordance « Ouvrir » demeure). */}
      <PressableScale
        accessibilityRole="button"
        accessibilityLabel={`${t('docs.open', { personality })} — ${doc.displayName}`}
        onPress={onOpen}
        style={{ flexDirection: 'row', gap: 13 }}
      >
        <DocThumb />
        <View style={{ flex: 1, minWidth: 0 }}>
          <View style={{ flexDirection: 'row', alignItems: 'center', gap: 7, marginBottom: 2 }}>
            <View style={{ backgroundColor: semantic.aiBg, borderRadius: 5, paddingVertical: 2, paddingHorizontal: 6 }}>
              <Text style={{ ...font('label', 700), fontSize: 10, color: vault.aiDeep }}>
                {t(analysisTypeLabelKey(doc.analysisType), { personality }).toUpperCase()}
              </Text>
            </View>
            <Text style={{ ...font('meta', 500), fontSize: 11, color: colors.slate300 }}>
              {agoLabel(doc.receivedAt, personality)}
            </Text>
          </View>
          <Text style={[font('cardTitle'), { color: colors.ink800 }]} numberOfLines={1}>
            {doc.displayName}
          </Text>
        </View>
      </PressableScale>

      {/* Chips Montant / TVA récup. / Date — extraction OCR réelle même sans dépense liée. */}
      {metrics ? (
        <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 8, marginTop: 13 }}>
          <MetricChip
            label={t('docs.metricAmount', { personality })}
            value={formatEUR(metrics.totalTtcCents)}
            valueColor={colors.ink800}
            tabular
          />
          {metrics.vatCents !== null ? (
            <MetricChip
              label={t('docs.metricVat', { personality })}
              value={formatEUR(metrics.vatCents)}
              valueColor={semantic.success}
              tabular
            />
          ) : null}
          {metrics.documentDate !== null ? (
            <MetricChip
              label={t('docs.metricDate', { personality })}
              value={formatDayMonth(metrics.documentDate)}
              valueColor={colors.ink800}
            />
          ) : null}
        </View>
      ) : null}

      {/* « Je pense : … » — cible validée en gras ; repli honnête : dépense rapprochée. */}
      {guessSegments && guessSegments.length > 0 ? (
        <View
          style={{
            flexDirection: 'row',
            alignItems: 'center',
            gap: 7,
            backgroundColor: conformityCard.bgTop,
            borderRadius: 11,
            paddingVertical: 9,
            paddingHorizontal: 12,
            marginTop: 13,
          }}
        >
          <SparkSmallIcon color={semantic.ai} />
          <Text style={{ ...font('meta', 600), fontSize: 12.5, color: semantic.ai, flex: 1 }}>
            {t('docs.aiGuess', { personality })}
            {guessSegments.map((segment, i) => (
              <Text
                key={`${i}-${segment.text}`}
                style={{ ...font('meta', segment.bold ? 700 : 600), fontSize: 12.5, color: semantic.ai }}
              >
                {segment.text}
              </Text>
            ))}
          </Text>
        </View>
      ) : doc.matchedExpense ? (
        <View
          style={{
            flexDirection: 'row',
            alignItems: 'center',
            gap: 7,
            backgroundColor: conformityCard.bgTop,
            borderRadius: 11,
            paddingVertical: 9,
            paddingHorizontal: 12,
            marginTop: 13,
          }}
        >
          <SparkSmallIcon color={semantic.ai} />
          <Text style={{ ...font('meta', 600), fontSize: 12.5, color: semantic.ai, flex: 1 }}>
            {t('docs.aiGuessExpense', { personality, params: { supplier: doc.matchedExpense.supplierName } })}
          </Text>
        </View>
      ) : null}

      {/* « Classer là » PLEIN indigo (aiSolid) + « Autre dossier » blanc bordé (handoff). */}
      <View style={{ flexDirection: 'row', gap: 9, marginTop: 13 }}>
        {oneTap ? (
          <Button
            title={t('docs.classify', { personality })}
            variant="aiSolid"
            size="compact"
            radius={12}
            loading={classifying}
            style={{ flex: 1 }}
            onPress={onClassify}
            accessibilityLabel={`${t('docs.classify', { personality })} — ${doc.displayName}`}
          />
        ) : null}
        <Button
          title={t('docs.otherFolder', { personality })}
          variant="secondary"
          size="compact"
          radius={12}
          {...(oneTap ? {} : { style: { flex: 1 } })}
          onPress={onPickTarget}
          accessibilityLabel={`${t('docs.otherFolder', { personality })} — ${doc.displayName}`}
        />
      </View>
    </View>
  );
}

/** Destination d'un classement — chaque variante porte le libellé prêt pour le bandeau vert. */
type ClassifyTarget =
  | { kind: 'chantier'; chantierId: string; label: string }
  | { kind: 'system_folder'; systemKey: DocumentFolderSystemKey; label: string }
  | { kind: 'expense'; expenseId: string; label: string }
  | { kind: 'folder'; folderId: string; label: string };

/**
 * Cible du « Classer là » : la destination validée par le domaine prime ; la dépense
 * rapprochée reprend la main quand la destination est « Achats » (le lien de preuve
 * dépense↔document est plus riche qu'un simple rangement) ou qu'aucune n'existe.
 */
function oneTapTargetFor(doc: VaultPendingDoc): ClassifyTarget | null {
  const destination = doc.suggestedDestination;
  if (
    doc.matchedExpense
    && (destination === null || (destination.kind === 'system_folder' && destination.systemKey === 'purchases'))
  ) {
    return {
      kind: 'expense',
      expenseId: doc.matchedExpense.id,
      label: destination?.label ?? documentSystemFolderLabel('purchases'),
    };
  }
  if (destination === null) return null;
  return destination.kind === 'chantier'
    ? { kind: 'chantier', chantierId: destination.chantierId, label: destination.label }
    : { kind: 'system_folder', systemKey: destination.systemKey, label: destination.label };
}

export default function Documents() {
  const { personality, colors, semantic, controls, overlays, grad } = useTheme();
  const router = useRouter();
  const bobScrollInsets = useBobAwareScrollInsets({ minimumBottom: 140 });
  const client = useBobClient();
  const documents = useDocuments();
  const documentFolders = useDocumentFolders(null);
  const createRootFolder = useCreateDocumentFolder();
  const expenses = useExpenses();
  const invoices = useInvoices();
  const customers = useCustomers();
  const exportFec = useExportFec();
  const queryClient = useQueryClient();

  const [query, setQuery] = useState('');
  const [toast, setToast] = useState<string | null>(null);
  // Bandeau vert « {nom} classé · {destination} » (handoff, état classé) — FadeIn à chaque clé.
  const [classifiedBanner, setClassifiedBanner] = useState<{ key: number; text: string } | null>(null);
  // A8 : doc en cours de classement manuel (Sheet des destinations réelles).
  const [pickerDoc, setPickerDoc] = useState<VaultPendingDoc | null>(null);
  const [rootFolderEditorOpen, setRootFolderEditorOpen] = useState(false);
  const [rootFolderName, setRootFolderName] = useState('');
  const [rootFolderError, setRootFolderError] = useState<string | null>(null);
  const chantiers = useChantiers();
  const openChantiers = useMemo(
    () => (chantiers.data ?? []).filter((c) => c.status === 'open'),
    [chantiers.data],
  );

  // Bob voit les documents AFFICHÉS : « résume ce document », « classe celui-ci » (S2).
  const agentContext = useMemo<AgentContext>(
    () => {
      const contextReady =
        documents.data !== undefined &&
        documentFolders.data !== undefined &&
        expenses.data !== undefined &&
        invoices.data !== undefined &&
        customers.data !== undefined;
      return {
        screen: { name: 'documents', instanceId: 'documents' },
        entities: contextReady
          ? documents.data.slice(0, 12).map((d) => ({
              type: 'document' as const,
              id: d.id,
              // Parité humain↔Bob : l'agent voit le même libellé intelligent que l'écran.
              label: d.displayName || d.filename,
            }))
          : [],
        capabilities: contextReady ? ['screen.read', 'document.read'] : [],
      };
    },
    [customers.data, documentFolders.data, documents.data, expenses.data, invoices.data],
  );
  usePublishAgentContext(agentContext);

  // « Classer là » (A1-C14) + picker de cible (A8) : confirme le classement — mêmes use
  // cases que Bob (MoveDocumentToFolder / ClassifyDocument / RenameDocument). La cible peut
  // être la destination suggérée (chantier OU dossier hors chantier), la dépense rapprochée,
  // un chantier ouvert ou un dossier du coffre choisi à la main.
  const classify = useMutation({
    mutationFn: async (input: {
      documentId: string;
      /** Nom intelligent courant (bandeau) — remplacé par le renommage s'il s'applique. */
      displayName: string;
      target: ClassifyTarget;
    }) => {
      const document = documents.data?.find((candidate) => candidate.id === input.documentId);
      if (!document) throw new Error('Document indisponible.');
      let revision = document.revision;
      // 1) Rangement. Une destination « dossier » déplace toujours (c'est l'action même) ;
      //    un lien métier (chantier/dépense) ne déplace que si l'original n'a pas encore de
      //    dossier — on n'écrase jamais un rangement déjà choisi par l'humain.
      const isFolderDestination = input.target.kind === 'folder' || input.target.kind === 'system_folder';
      const targetFolderId = input.target.kind === 'folder'
        ? input.target.folderId
        : (documentFolders.data?.find((folder) =>
            folder.systemKey === (input.target.kind === 'system_folder'
              ? input.target.systemKey
              : input.target.kind === 'chantier' ? 'projects' : 'purchases'),
          )?.id ?? null);
      if (targetFolderId === null) {
        if (isFolderDestination || document.folderId === null) {
          throw new Error('Dossier de destination indisponible.');
        }
      } else if (isFolderDestination ? document.folderId !== targetFolderId : document.folderId === null) {
        const moved = await client.moveDocumentToFolder({
          documentId: document.id,
          folderId: targetFolderId,
          expectedRevision: revision,
        });
        if (!moved.ok) throw moved.error;
        revision = moved.value.revision;
      }
      // 2) Lien métier (deuxième axe) — même use case que Bob (ClassifyDocument @bob/core).
      if (input.target.kind === 'chantier' || input.target.kind === 'expense') {
        const classified = await client.classifyDocument({
          documentId: document.id,
          linkedEntityType: input.target.kind,
          linkedEntityId: input.target.kind === 'chantier' ? input.target.chantierId : input.target.expenseId,
          expectedRevision: revision,
        });
        if (!classified.ok) throw classified.error;
        revision = classified.value.revision;
      }
      // 3) Le nom professionnel proposé devient le nom du document au classement (l'intelligence
      //    demandée). Best-effort : le classement est déjà commis, un échec de renommage ne le
      //    défait pas — le libellé intelligent reste servi par l'analyse en attendant.
      const rename = suggestedRenameFor(document, document.analysis?.suggestedDisplayName ?? null);
      let appliedName = rename ?? input.displayName;
      if (rename !== null) {
        const renamed = await client.renameDocument({
          documentId: document.id,
          displayName: rename,
          expectedRevision: revision,
        });
        if (!renamed.ok) appliedName = input.displayName;
      }
      return { target: input.target, appliedName };
    },
    onSuccess: (result) => {
      void queryClient.invalidateQueries({ queryKey: ['documents'] });
      void queryClient.invalidateQueries({ queryKey: ['expenses'] });
      setPickerDoc(null);
      setClassifiedBanner({
        key: Date.now(),
        text: t('docs.classifiedBanner', {
          personality,
          params: { name: result.appliedName, destination: result.target.label },
        }),
      });
    },
    onError: () => setToast(t('docs.classifyError', { personality })),
  });

  const cta = parseGradient(grad.cta);
  const folderTints = useFolderTints();

  const isLoading = documents.isLoading
    || documentFolders.isLoading
    || expenses.isLoading
    || invoices.isLoading
    || customers.isLoading;
  const hasError = hasBlockingAuthoritativeDataError([
    documents,
    documentFolders,
    expenses,
    invoices,
    customers,
  ]);
  const staleVaultError = (documents.isError && documents.data !== undefined)
    || (documentFolders.isError && documentFolders.data !== undefined);
  const secondaryError = (expenses.isError && expenses.data !== undefined)
    || (invoices.isError && invoices.data !== undefined)
    || (customers.isError && customers.data !== undefined);
  const refreshing = documents.isRefetching
    || documentFolders.isRefetching
    || expenses.isRefetching
    || invoices.isRefetching
    || customers.isRefetching
    || chantiers.isRefetching;
  const refreshAll = (): void => {
    void Promise.all([
      documents.refetch(),
      documentFolders.refetch(),
      expenses.refetch(),
      invoices.refetch(),
      customers.refetch(),
      chantiers.refetch(),
    ]);
  };

  const openRootFolderEditor = (): void => {
    setRootFolderName('');
    setRootFolderError(null);
    setRootFolderEditorOpen(true);
  };

  const closeRootFolderEditor = (): void => {
    if (createRootFolder.isPending) return;
    setRootFolderEditorOpen(false);
    setRootFolderError(null);
  };

  const submitRootFolder = (): void => {
    if (createRootFolder.isPending) return;
    const validated = validateDocumentFolderName(rootFolderName);
    if (!validated.ok) {
      setRootFolderError(t('docs.folderCreateInvalid', { personality }));
      return;
    }
    setRootFolderError(null);
    createRootFolder.mutate(
      { name: validated.value.name, parentId: null },
      {
        onSuccess: (folder) => {
          setRootFolderEditorOpen(false);
          setRootFolderName('');
          setToast(t('docs.folderCreateSuccess', { personality, params: { name: folder.name } }));
        },
        onError: () => setRootFolderError(t('docs.folderCreateError', { personality })),
      },
    );
  };

  // Le rapprochement EXPLICITE dépense↔document passe par paymentEvidence.proofDocumentId :
  // l'appelant projette le lien à plat (contrat VaultExpenseData) — jamais deviné côté core.
  const vaultExpenses: VaultExpenseData[] | undefined = useMemo(
    () =>
      expenses.data?.map((expense) => ({
        id: expense.id,
        supplierName: expense.supplierName,
        documentDate: expense.documentDate,
        totalTtcCents: expense.totalTtcCents,
        vatCents: expense.vatCents,
        proofDocumentId: expense.paymentEvidence?.proofDocumentId ?? null,
      })),
    [expenses.data],
  );

  // Projections structurelles : DocumentListItemView/InvoiceView/CustomerListItem ⊇ Vault*Data.
  const view: VaultView | null = useMemo(() => {
    // Aucun `?? []` ici : une réponse serveur réellement vide est `[]`, tandis qu'une source
    // jamais chargée reste `undefined` et bloque l'agrégat complet via `hasError` ci-dessus.
    if (!documents.data || !vaultExpenses || !invoices.data || !customers.data) return null;
    return deriveVaultView({
      documents: documents.data,
      expenses: vaultExpenses,
      invoices: invoices.data,
      customers: customers.data,
      today: todayISO(),
    });
  }, [documents.data, vaultExpenses, invoices.data, customers.data]);

  // E10 : reste à payer réel (summarizeExpenses @bob/core) — sous-titre de la porte Dépenses.
  const expensesToPayCents = useMemo(
    () =>
      expenses.data === undefined
        ? null
        : summarizeExpenses(expenses.data, { month: todayISO().slice(0, 7) }).toPayCents,
    [expenses.data],
  );

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
    if (invoice.customerType === null) {
      return t('docs.recentSubUnavailable', { personality, params: { kind } });
    }
    if (invoice.customerType === 'b2b') return t('docs.recentSubB2b', { personality, params: { kind } });
    if (invoice.customerType === 'b2g') return t('docs.recentSubB2g', { personality });
    return t('docs.recentSubB2c', { personality });
  };

  const searching = trimmedQuery.length > 0;
  const empty = view !== null && view.totalCount === 0 && view.toValidate.length === 0;

  const rootFolders = documentFolders.data ?? [];
  const folderCount = (folderId: string): number =>
    (documents.data ?? []).filter((document) => document.status === 'active' && document.folderId === folderId).length;
  const folderTint = (folder: DocumentFolderView): { tint: string; bg: string } => {
    const legacyKey: VaultFolderKey =
      folder.systemKey === 'projects'
        ? 'chantiers'
        : folder.systemKey === 'purchases'
          ? 'achats'
          : folder.systemKey === 'insurance'
            ? 'assurances'
            : folder.systemKey === 'tax_social'
              ? 'fiscal'
              : folder.systemKey === 'bank'
                ? 'banque'
                : 'comptable';
    return folderTints[legacyKey];
  };

  return (
    <View style={{ flex: 1, backgroundColor: colors.bg }}>
      <ScrollView
        style={{ flex: 1 }}
        contentContainerStyle={{ paddingBottom: bobScrollInsets.paddingBottom }}
        scrollIndicatorInsets={{ bottom: bobScrollInsets.scrollIndicatorBottom }}
        automaticallyAdjustKeyboardInsets={bobScrollInsets.automaticallyAdjustKeyboardInsets}
        refreshControl={<RefreshControl refreshing={refreshing} onRefresh={refreshAll} tintColor={colors.ink800} />}
      >
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
            minHeight: 44,
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

        {secondaryError && !hasError ? (
          <View style={{ paddingHorizontal: 18, paddingTop: 14 }}>
            <Card>
              <Text accessibilityRole="alert" accessibilityLiveRegion="polite" style={[font('sub'), { color: colors.slate500, lineHeight: 19 }]}>
                {t('docs.staleSummaries', { personality })}
              </Text>
              <View style={{ marginTop: 10 }}>
                <Button
                  title={t('docs.staleSummariesCta', { personality })}
                  variant="secondary"
                  loading={refreshing}
                  onPress={refreshAll}
                />
              </View>
            </Card>
          </View>
        ) : null}

        {staleVaultError && !hasError ? (
          <View style={{ paddingHorizontal: 18, paddingTop: 14 }}>
            <ErrorRetry
              message={t('docs.staleVault', { personality })}
              onRetry={refreshAll}
              retrying={refreshing}
            />
          </View>
        ) : null}

        {hasError ? (
          <View style={{ paddingHorizontal: 18, paddingTop: 20 }}>
            <ErrorRetry
              message={t('docs.dataError', { personality })}
              onRetry={refreshAll}
              retrying={refreshing}
            />
          </View>
        ) : isLoading ? (
          <View
            accessibilityRole="progressbar"
            accessibilityLiveRegion="polite"
            accessibilityLabel="Chargement du coffre de documents"
            style={{ paddingHorizontal: 18, paddingTop: 20, gap: 12 }}
          >
            <SkeletonCard height={264} contentLines={6} radius={20} />
            <Skeleton width={132} height={18} radius={8} />
            <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 11 }}>
              <Skeleton width="47%" height={112} radius={16} />
              <Skeleton width="47%" height={112} radius={16} />
              <Skeleton width="47%" height={112} radius={16} />
              <Skeleton width="47%" height={112} radius={16} />
            </View>
            <Skeleton width={156} height={18} radius={8} style={{ marginTop: 8 }} />
            <SkeletonCard height={158} contentLines={4} />
            <Card>
              <SkeletonRow avatar="square" trailing="text" />
              <SkeletonRow avatar="square" trailing="text" />
            </Card>
          </View>
        ) : searching ? (
          /* Résultats de recherche — rows réelles, ouverture du document */
          <View style={{ paddingHorizontal: 18, paddingTop: 20, gap: 10 }}>
            {/* A7 : porte d'entrée vers la recherche GLOBALE (clients + pièces + docs). */}
            <Pressable
              accessibilityRole="button"
              accessibilityLabel={t('search.everywhere', { personality, params: { query: trimmedQuery } })}
              onPress={() => router.push({ pathname: '/recherche', params: { q: trimmedQuery } })}
              style={({ pressed }) => ({
                opacity: pressed ? 0.82 : 1,
                transform: [{ scale: pressed ? 0.98 : 1 }],
              })}
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
                <EmptyState body={t('docs.noResults', { personality, params: { query: trimmedQuery } })} />
              </Card>
            ) : (
              results.map((docItem) => (
                <Pressable
                  key={docItem.id}
                  accessibilityRole="button"
                  accessibilityLabel={vaultDocTitle(docItem)}
                  onPress={() => void openDocument(docItem.id)}
                  style={({ pressed }) => ({
                    opacity: pressed ? 0.82 : 1,
                    transform: [{ scale: pressed ? 0.98 : 1 }],
                  })}
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
                          {vaultDocTitle(docItem)}
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
            {/* Bandeau vert « {nom} classé · {destination} » — fade-in après un classement. */}
            {classifiedBanner ? (
              <FadeIn key={classifiedBanner.key} index={0} style={{ paddingHorizontal: 18, paddingTop: 20 }}>
                <View
                  accessibilityLiveRegion="polite"
                  style={{
                    flexDirection: 'row',
                    alignItems: 'center',
                    gap: 12,
                    backgroundColor: semantic.successBg,
                    borderWidth: 1,
                    borderColor: vault.classifiedBorder,
                    borderRadius: 18,
                    paddingVertical: 14,
                    paddingHorizontal: 16,
                  }}
                >
                  <Feather name="check-circle" size={22} color={semantic.success} />
                  <Text style={{ ...font('body', 600), fontSize: 14, color: semantic.success, flex: 1 }}>
                    {classifiedBanner.text}
                  </Text>
                </View>
              </FadeIn>
            ) : null}

            {/* À valider — uniquement s'il y a des docs OCR non classés (données réelles) */}
            {view.toValidate.length > 0 ? (
              <FadeIn index={0} style={{ paddingHorizontal: 18, paddingTop: 20 }}>
                <View style={{ flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', marginBottom: 12 }}>
                  <Text style={[font('cardTitle'), { color: colors.ink800 }]} accessibilityRole="header">
                    {t('docs.sectionToValidate', { personality })}
                  </Text>
                  {/* Compteur INDIGO PLEIN (handoff) — semantic.ai, texte blanc. */}
                  <View style={{ backgroundColor: semantic.ai, borderRadius: 10, paddingVertical: 2, paddingHorizontal: 8 }}>
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
                      onClassify={() => {
                        const target = oneTapTargetFor(p);
                        if (target && !classify.isPending) {
                          classify.mutate({ documentId: p.id, displayName: p.displayName, target });
                        }
                      }}
                    />
                  ))}
                </View>
              </FadeIn>
            ) : null}

            {empty ? (
              <FadeIn index={0} style={{ paddingHorizontal: 18, paddingTop: 20 }}>
                <Card>
                  <EmptyState
                    title={t('docs.emptyTitle', { personality })}
                    body={t('docs.emptyBody', { personality })}
                    icon={<FileIcon color={semantic.success} />}
                  />
                </Card>
              </FadeIn>
            ) : null}

            {/* Dossiers persistés : navigation réelle, identité stable, sous-dossiers côté détail. */}
            <FadeIn index={1} style={{ paddingHorizontal: 18, paddingTop: 20 }}>
              <View style={{ minHeight: 44, flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: 12, marginBottom: 8 }}>
                <Text style={[font('cardTitle'), { color: colors.ink800, flex: 1 }]} accessibilityRole="header">
                  {t('docs.sectionFolders', { personality })}
                </Text>
                <Pressable
                  accessibilityRole="button"
                  accessibilityLabel={t('docs.folderCreateCta', { personality })}
                  onPress={openRootFolderEditor}
                  hitSlop={6}
                  style={({ pressed }) => ({
                    minHeight: 44,
                    flexDirection: 'row',
                    alignItems: 'center',
                    gap: 5,
                    paddingHorizontal: 8,
                    opacity: pressed ? 0.72 : 1,
                  })}
                >
                  <Feather name="plus" size={16} color={semantic.b2b} />
                  <Text style={{ ...font('meta', 700), color: semantic.b2b }}>
                    {t('docs.folderCreateCta', { personality })}
                  </Text>
                </Pressable>
              </View>
              {rootFolders.length === 0 ? (
                <Card>
                  <EmptyState body={t('docs.folderCreateBody', { personality })} />
                </Card>
              ) : (
                <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 11 }}>
                  {rootFolders.map((folder) => {
                    const count = folderCount(folder.id);
                    const tint = folderTint(folder);
                    return (
                      <Pressable
                      key={folder.id}
                      accessibilityRole="button"
                      accessibilityLabel={`${folder.name}, ${count} document${count > 1 ? 's' : ''}`}
                      accessibilityHint="Ouvre ce dossier. Un appui long affiche les options."
                      accessibilityActions={[
                        { name: 'activate', label: 'Ouvrir le dossier' },
                        { name: 'longpress', label: 'Gérer le dossier' },
                      ]}
                      onAccessibilityAction={(event) => {
                        if (event.nativeEvent.actionName === 'longpress') {
                          router.push({ pathname: '/documents/folder/[id]', params: { id: folder.id, manage: '1' } });
                        } else if (event.nativeEvent.actionName === 'activate') {
                          router.push(`/documents/folder/${folder.id}`);
                        }
                      }}
                      onPress={() => router.push(`/documents/folder/${folder.id}`)}
                      onLongPress={() => router.push({ pathname: '/documents/folder/[id]', params: { id: folder.id, manage: '1' } })}
                      delayLongPress={450}
                      style={({ pressed }) => ({
                        flexBasis: '47%',
                        flexGrow: 1,
                        minHeight: 112,
                        backgroundColor: colors.surface,
                        borderRadius: 16,
                        borderWidth: 1,
                        borderColor: controls.cardBorder,
                        padding: 14,
                        opacity: pressed ? 0.82 : 1,
                        transform: [{ scale: pressed ? 0.98 : 1 }],
                        ...shadowNative.e1,
                      })}
                    >
                      <View
                        style={{
                          width: 36,
                          height: 36,
                          borderRadius: 11,
                          backgroundColor: tint.bg,
                          alignItems: 'center',
                          justifyContent: 'center',
                          marginBottom: 10,
                        }}
                      >
                        <FolderSmallIcon color={tint.tint} />
                      </View>
                      <Text style={{ ...font('body', 600), fontSize: 14, color: colors.ink800 }} numberOfLines={1}>
                        {folder.name}
                      </Text>
                      <Text style={{ ...font('meta', 500), color: colors.slate300, marginTop: 1 }}>
                        {count === 0
                          ? t('docs.folderCountNone', { personality })
                          : count === 1
                            ? t('docs.folderCountOne', { personality })
                            : t('docs.folderCount', { personality, params: { count } })}
                      </Text>
                      </Pressable>
                    );
                  })}
                </View>
              )}
            </FadeIn>

            {/* Compta & conformité */}
            <FadeIn index={2} style={{ paddingHorizontal: 18, paddingTop: 20 }}>
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

              {/* Accès aux Dépenses (E10) : reste à payer réel en sous-titre — E4 payer. */}
              <Pressable
                accessibilityRole="button"
                accessibilityLabel={t('dep.title', { personality })}
                onPress={() => router.push('/depenses')}
                style={({ pressed }) => ({
                  marginBottom: 12,
                  opacity: pressed ? 0.82 : 1,
                  transform: [{ scale: pressed ? 0.98 : 1 }],
                })}
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
                      backgroundColor: semantic.particulierBg,
                      alignItems: 'center',
                      justifyContent: 'center',
                    }}
                  >
                    <WalletIcon color={semantic.particulier} size={17} strokeWidth={2} />
                  </View>
                  <View style={{ flex: 1, minWidth: 0 }}>
                    <Text style={{ ...font('body', 700), fontSize: 14, color: colors.ink800 }}>
                      {t('dep.title', { personality })}
                    </Text>
                    <Text style={{ ...font('meta', 500), color: colors.slate300, marginTop: 1 }} numberOfLines={1}>
                      {t('dep.toPay', { personality })} · {expensesToPayCents === null ? '—' : formatEUR(expensesToPayCents)}
                    </Text>
                  </View>
                  <ChevronRightIcon color={controls.chevron} size={14} strokeWidth={2} />
                </View>
              </Pressable>

              {/* Accès au grand-livre (C17) : la compta complète (journal, équilibre, clôture)
                  vit sur son écran dédié — ici, la porte d'entrée. */}
              <Pressable
                accessibilityRole="button"
                accessibilityLabel={t('compta.title', { personality })}
                onPress={() => router.push('/comptabilite')}
                style={({ pressed }) => ({
                  marginBottom: 12,
                  opacity: pressed ? 0.82 : 1,
                  transform: [{ scale: pressed ? 0.98 : 1 }],
                })}
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
                      accessibilityLabel={`${invoice.number} · ${invoice.customerName ?? t('docs.recentCustomerUnavailable', { personality })}`}
                      onPress={() => router.push(`/facture/${invoice.id}`)}
                      style={({ pressed }) => ({
                        flexDirection: 'row',
                        alignItems: 'center',
                        gap: 11,
                        paddingVertical: 12,
                        borderBottomWidth: i < view.recentInvoices.length - 1 ? 1 : 0,
                        borderBottomColor: colors.lineSoft,
                        opacity: pressed ? 0.65 : 1,
                      })}
                    >
                      <View
                        style={{
                          width: 34,
                          height: 34,
                          borderRadius: 10,
                          backgroundColor: invoice.customerType === 'b2b'
                            ? semantic.b2bBg
                            : invoice.customerType === 'b2g'
                              ? semantic.b2gBg
                              : invoice.customerType === 'b2c'
                                ? semantic.particulierBg
                                : colors.lineSoft,
                          alignItems: 'center',
                          justifyContent: 'center',
                        }}
                      >
                        <FileIcon
                          color={invoice.customerType === 'b2b'
                            ? semantic.b2b
                            : invoice.customerType === 'b2g'
                              ? semantic.b2g
                              : invoice.customerType === 'b2c'
                                ? semantic.particulier
                                : colors.slate500}
                        />
                      </View>
                      <View style={{ flex: 1, minWidth: 0 }}>
                        <Text style={{ ...font('body', 700), fontSize: 14, color: colors.ink800 }} numberOfLines={1}>
                          {invoice.number} · {invoice.customerName ?? t('docs.recentCustomerUnavailable', { personality })}
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
            </FadeIn>

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

      <Sheet visible={rootFolderEditorOpen} onClose={closeRootFolderEditor}>
        <KeyboardAvoidingView {...(process.env.EXPO_OS === 'ios' ? { behavior: 'padding' as const } : {})}>
          <Text style={[font('pageTitle'), { fontSize: 20, color: colors.ink900 }]} accessibilityRole="header">
            {t('docs.folderCreateTitle', { personality })}
          </Text>
          <Text style={[font('sub'), { color: colors.slate500, lineHeight: 19, marginTop: 4 }]}>
            {t('docs.folderCreateBody', { personality })}
          </Text>
          <Text style={[font('label', 700), { color: colors.slate400, fontSize: 12, marginTop: 16 }]}>
            {t('docs.folderCreateName', { personality }).toUpperCase()}
          </Text>
          <TextInput
            autoFocus
            value={rootFolderName}
            editable={!createRootFolder.isPending}
            maxLength={80}
            autoCapitalize="sentences"
            autoCorrect
            returnKeyType="done"
            onSubmitEditing={submitRootFolder}
            onChangeText={(name) => {
              setRootFolderName(name);
              setRootFolderError(null);
            }}
            accessibilityLabel={t('docs.folderCreateName', { personality })}
            accessibilityHint={t('docs.folderCreateHint', { personality })}
            placeholder={t('docs.folderCreatePlaceholder', { personality })}
            placeholderTextColor={colors.slate300}
            style={[
              font('body'),
              {
                minHeight: 46,
                marginTop: 7,
                borderWidth: 1,
                borderColor: rootFolderError ? semantic.danger : colors.lineSoft,
                borderRadius: 12,
                paddingVertical: 11,
                paddingHorizontal: 13,
                color: colors.ink800,
              },
            ]}
          />
          <Text style={[font('meta'), { color: colors.slate300, textAlign: 'right', marginTop: 4, fontVariant: ['tabular-nums'] }]}>
            {rootFolderName.length}/80
          </Text>
          {rootFolderError ? (
            <Text accessibilityRole="alert" style={[font('sub'), { color: semantic.danger, lineHeight: 19, marginTop: 8 }]}>
              {rootFolderError}
            </Text>
          ) : null}
          <View style={{ flexDirection: 'row', gap: 10, marginTop: 18 }}>
            <Button
              title={t('docs.folderCreateCancel', { personality })}
              variant="secondary"
              style={{ flex: 1 }}
              disabled={createRootFolder.isPending}
              onPress={closeRootFolderEditor}
            />
            <Button
              title={t('docs.folderCreateSubmit', { personality })}
              style={{ flex: 1 }}
              loading={createRootFolder.isPending}
              disabled={createRootFolder.isPending || rootFolderName.trim().length === 0}
              onPress={submitRootFolder}
            />
          </View>
        </KeyboardAvoidingView>
      </Sheet>

      {/* A8 : Sheet des destinations RÉELLES — la suggestion en tête, puis les chantiers
          ouverts ET les dossiers hors chantier (un doc hors chantier est un cas de première
          classe : frais généraux, assurances, fiscal…). */}
      <Sheet visible={pickerDoc !== null} onClose={() => setPickerDoc(null)}>
        <Text style={[font('cardTitle'), { color: colors.ink900, marginBottom: 12 }]} accessibilityRole="header">
          {t('docs.pickTitle', { personality })}
        </Text>
        {pickerDoc ? (() => {
          const suggested = oneTapTargetFor(pickerDoc);
          if (!suggested) return null;
          const title = suggested.kind === 'expense' && pickerDoc.matchedExpense
            ? pickerDoc.matchedExpense.supplierName
            : suggested.label;
          const meta = suggested.kind === 'expense'
            ? t('docs.pickProposalMeta', { personality })
            : t('docs.pickSuggestedMeta', { personality });
          return (
            <Pressable
              accessibilityRole="button"
              accessibilityLabel={`${title} — ${meta}`}
              disabled={classify.isPending}
              onPress={() =>
                classify.mutate({ documentId: pickerDoc.id, displayName: pickerDoc.displayName, target: suggested })
              }
              style={({ pressed }) => ({
                minHeight: 48,
                flexDirection: 'row',
                alignItems: 'center',
                gap: 11,
                paddingVertical: 12,
                borderBottomWidth: 1,
                borderBottomColor: colors.lineSoft,
                opacity: classify.isPending ? 0.6 : pressed ? 0.65 : 1,
              })}
            >
              <View
                style={{
                  width: 34,
                  height: 34,
                  borderRadius: 10,
                  backgroundColor: semantic.aiBg,
                  alignItems: 'center',
                  justifyContent: 'center',
                }}
              >
                <SparkSmallIcon color={semantic.ai} />
              </View>
              <View style={{ flex: 1, minWidth: 0 }}>
                <Text style={{ ...font('body', 700), fontSize: 14, color: colors.ink800 }} numberOfLines={1}>
                  {title}
                </Text>
                <Text style={[font('meta'), { color: colors.slate400, marginTop: 1 }]}>
                  {meta}
                </Text>
              </View>
              <ChevronRightIcon color={controls.chevron} size={14} strokeWidth={2} />
            </Pressable>
          );
        })() : null}
        {chantiers.isLoading ? (
          <View
            accessibilityRole="progressbar"
            accessibilityLiveRegion="polite"
            accessibilityLabel="Chargement des chantiers"
          >
            <SkeletonRow avatar="square" trailing={false} />
            <SkeletonRow avatar="square" trailing={false} />
          </View>
        ) : chantiers.isError ? (
          <ErrorRetry
            message={t('chantiers.dataError', { personality })}
            onRetry={() => void chantiers.refetch()}
          />
        ) : (
          openChantiers.map((chantier) => (
            <Pressable
              key={chantier.id}
              accessibilityRole="button"
              accessibilityLabel={chantier.name}
              disabled={classify.isPending}
              onPress={() =>
                pickerDoc
                  ? classify.mutate({
                      documentId: pickerDoc.id,
                      displayName: pickerDoc.displayName,
                      target: { kind: 'chantier', chantierId: chantier.id, label: chantier.name },
                    })
                  : undefined
              }
              style={({ pressed }) => ({
                minHeight: 48,
                flexDirection: 'row',
                alignItems: 'center',
                gap: 11,
                paddingVertical: 12,
                borderBottomWidth: 1,
                borderBottomColor: colors.lineSoft,
                opacity: classify.isPending ? 0.6 : pressed ? 0.65 : 1,
              })}
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
          ))
        )}
        {/* Dossiers hors chantier (racine du coffre : Achats, Assurances, Fiscal & social…). */}
        {rootFolders.map((folder, i) => {
          const tint = folderTint(folder);
          return (
            <Pressable
              key={folder.id}
              accessibilityRole="button"
              accessibilityLabel={folder.name}
              disabled={classify.isPending}
              onPress={() =>
                pickerDoc
                  ? classify.mutate({
                      documentId: pickerDoc.id,
                      displayName: pickerDoc.displayName,
                      target: { kind: 'folder', folderId: folder.id, label: folder.name },
                    })
                  : undefined
              }
              style={({ pressed }) => ({
                minHeight: 48,
                flexDirection: 'row',
                alignItems: 'center',
                gap: 11,
                paddingVertical: 12,
                borderBottomWidth: i < rootFolders.length - 1 ? 1 : 0,
                borderBottomColor: colors.lineSoft,
                opacity: classify.isPending ? 0.6 : pressed ? 0.65 : 1,
              })}
            >
              <View
                style={{
                  width: 34,
                  height: 34,
                  borderRadius: 10,
                  backgroundColor: tint.bg,
                  alignItems: 'center',
                  justifyContent: 'center',
                }}
              >
                <FolderSmallIcon color={tint.tint} />
              </View>
              <View style={{ flex: 1, minWidth: 0 }}>
                <Text style={{ ...font('body', 700), fontSize: 14, color: colors.ink800 }} numberOfLines={1}>
                  {folder.name}
                </Text>
                <Text style={[font('meta'), { color: colors.slate400, marginTop: 1 }]}>
                  {t('docs.pickFolderMeta', { personality })}
                </Text>
              </View>
              <ChevronRightIcon color={controls.chevron} size={14} strokeWidth={2} />
            </Pressable>
          );
        })}
        {!chantiers.isLoading
          && !chantiers.isError
          && (pickerDoc === null || oneTapTargetFor(pickerDoc) === null)
          && openChantiers.length === 0
          && rootFolders.length === 0 ? (
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
