import { useEffect, useMemo, useReducer, useRef, useState } from 'react';
import {
  ActivityIndicator,
  Animated,
  Easing,
  KeyboardAvoidingView,
  Pressable,
  ScrollView,
  Text,
  TextInput,
  View,
} from 'react-native';
import { LinearGradient } from 'expo-linear-gradient';
import { useNavigation, useRouter } from 'expo-router';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { Ionicons } from '@expo/vector-icons';
import * as ImagePicker from 'expo-image-picker';
import { File as ExpoFile } from 'expo-file-system';
import {
  formatEUR,
  normalizeDocumentFolderName,
  validateDocumentFolderName,
  type DocumentAnalysis,
  type DocumentFolderSystemKey,
  type DocumentView,
} from '@bob/core';
import {
  reconcileDocumentExpenseCommand,
  type CreateDocumentIntakeClientInput,
  type DocumentExpenseReconciliation,
  type RecordDocumentExpenseClientInput,
  type RecordDocumentExpenseClientOutput,
} from '@bob/api-client';
import { suggestCategoryClarification } from '@bob/ai';
import { t } from '@bob/i18n';
import { ErrorRetry, QuestionSheet, Sheet, Skeleton, useReduceMotion } from '@bob/ui';
import { vault } from '@bob/tokens';
import type { ExpenseCategory, PaymentMethod } from '@bob/core';
import { useTheme } from '../src/theme';
import { useQueryClient } from '@tanstack/react-query';
import { useChantiers, useExtractDocument } from '../src/data/hooks';
import { suggestedRenameFor } from '../src/documents/pending-card-copy';
import { DocumentInsightCard } from '../src/documents/document-insight-card';
import { deriveDocumentInsight } from '../src/documents/document-insight-card.logic';
import { useApplyDestination } from '../src/documents/use-apply-destination';
import {
  SCAN_LINE_TRAVEL_BOTTOM,
  SCAN_LINE_TRAVEL_TOP,
  SCAN_PULSE_OPACITY_MAX,
  SCAN_PULSE_OPACITY_MIN,
  resolveScanReadingMotion,
} from '../src/scan/scan-reading-motion';
import { planScanChantierChoice } from '../src/scan/scan-chantier-destination';
import {
  useAnalyzeDocument,
  useCreateDocumentFolder,
  useCreateDocumentIntake,
  useDocumentFolders,
  useMoveDocumentToFolder,
  useRecordDocumentExpense,
  supportsDocumentAnalysis,
} from '../src/data/documents';
import { useBobClient } from '../src/data/client';
import { usePublishAgentContext, type AgentAccessLayout, type AgentContext } from '../src/agent';
import { Card, Button, Badge, SectionHeader, font } from '../src/components/ui';
import { useBobAwareScrollInsets } from '../src/components/use-bob-aware-scroll-insets';
import { useSupplierExpenseDefaults } from '../src/data/supplier-memory';
import { deriveSupplierExpenseDefaultsState } from '../src/data/supplier-memory-query';
import {
  DEFAULT_TICKET_PAYMENT_METHOD,
  deriveScanSettlementProposal,
  settlementExpenseFields,
  type ScanSettlementChoice,
} from '../src/scan/scan-settlement';
import {
  INITIAL_SCAN_DECISION_QUEUE,
  reduceScanDecisionQueue,
  visibleScanSheet,
  type ScanDecisionSignals,
} from '../src/scan/scan-decision-queue';

/** Layout FIGÉ hors composant : passé en dépendance d'effet, un littéral inline ferait boucler le rendu. */
const SCAN_AGENT_LAYOUT: AgentAccessLayout = Object.freeze({ bottomAvoidance: 24 });

const DOCUMENT_MAX_BYTES = 10 * 1024 * 1024;
const LOCAL_FILE_READ_TIMEOUT_MS = 20_000;
const CREATE_FOLDER_OPTION = '__create_folder__';
/** Option « chantier » du rangement — encode l'id réel du chantier ouvert (jamais inventé). */
const CHANTIER_OPTION_PREFIX = 'chantier:';
const ARCHIVE_MIME_TYPES = new Set<string>([
  'application/pdf',
  'application/xml',
  'text/xml',
  'image/jpeg',
  'image/png',
  'image/webp',
  'image/heic',
  'image/heif',
]);
const OCR_MIME_TYPES = new Set<string>(['image/jpeg', 'image/png', 'image/webp', 'application/pdf']);
const MIME_BY_EXTENSION: Record<string, string> = {
  pdf: 'application/pdf',
  xml: 'application/xml',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  png: 'image/png',
  webp: 'image/webp',
  heic: 'image/heic',
  heif: 'image/heif',
};

function normalizedArchiveMimeType(value: string | null | undefined, filename: string): string | null {
  const normalized = (value ?? '').split(';', 1)[0]!.trim().toLowerCase();
  const canonical = normalized === 'image/jpg' ? 'image/jpeg' : normalized;
  if (ARCHIVE_MIME_TYPES.has(canonical)) return canonical;
  const extension = filename.trim().toLowerCase().split('.').at(-1) ?? '';
  return MIME_BY_EXTENSION[extension] ?? null;
}

function safeArchiveFilename(value: string, fallback: string): string {
  const basename = value.replace(/\\/g, '/').split('/').at(-1)?.trim() ?? '';
  const safe = [...basename]
    .map((character) => {
      const codePoint = character.codePointAt(0) ?? 0;
      return codePoint <= 0x1f || codePoint === 0x7f ? '_' : character;
    })
    .join('')
    .replace(/\s+/g, ' ')
    .slice(0, 180)
    .trim();
  return safe || fallback;
}

function newIntakeKey(): string {
  return `mobile-scan:${Date.now().toString(36)}:${Math.random().toString(36).slice(2, 14)}`;
}

class LocalFileReadTimeoutError extends Error {}

async function readLocalFileWithTimeout(file: ExpoFile): Promise<string> {
  let timeout: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      file.base64(),
      new Promise<never>((_resolve, reject) => {
        timeout = setTimeout(
          () => reject(new LocalFileReadTimeoutError('Lecture locale trop longue.')),
          LOCAL_FILE_READ_TIMEOUT_MS,
        );
      }),
    ]);
  } finally {
    if (timeout !== undefined) clearTimeout(timeout);
  }
}

const CATEGORY_LABEL: Record<string, string> = {
  fournitures: 'Fournitures',
  materiel: 'Matériel',
  carburant: 'Carburant',
  repas: 'Repas',
  sous_traitance: 'Sous-traitance',
  autre: 'Autre',
};

const SYSTEM_FOLDER_NAME: Readonly<Record<DocumentFolderSystemKey, string>> = {
  projects: 'Chantiers',
  purchases: 'Achats',
  insurance: 'Assurances',
  tax_social: 'Fiscal & social',
  bank: 'Banque',
  accounting: 'Comptable',
};

const CUSTOM_FOLDER_NAME: Partial<Readonly<Record<DocumentAnalysis['type'], string>>> = {
  contract: 'Contrats',
  company_record: 'Documents de société',
};

export default function ScanDocument() {
  const { colors, semantic, personality } = useTheme();
  const insets = useSafeAreaInsets();
  const router = useRouter();
  const navigation = useNavigation();
  const extract = useExtractDocument();
  const intake = useCreateDocumentIntake();
  const analysis = useAnalyzeDocument();
  const rootFolders = useDocumentFolders(null);
  const createFolder = useCreateDocumentFolder();
  const moveDocument = useMoveDocumentToFolder();
  const record = useRecordDocumentExpense();
  // Chantiers ouverts du tenant — cibles réelles du rangement (un doc peut vivre hors chantier).
  const chantiers = useChantiers();
  const client = useBobClient();
  const queryClient = useQueryClient();
  const mountedRef = useRef(true);
  // Copie de travail pour rejouer l'analyse. L'original est archivé côté serveur AVANT l'OCR.
  const photoRef = useRef<{ contentBase64: string; mimeType: string } | null>(null);
  const intakeInputRef = useRef<CreateDocumentIntakeClientInput | null>(null);
  const [archivedDocument, setArchivedDocument] = useState<DocumentView | null>(null);
  // SÉQUENCEMENT DES DÉCISIONS (machine pure) : au plus UNE sheet visible, ordre
  // catégorie → règlement, et la feuille de rangement JAMAIS auto-ouverte — elle ne
  // s'ouvre que sur geste humain (« Choisir un autre dossier », reprise, re-demande).
  const [decisionQueue, dispatchDecision] = useReducer(reduceScanDecisionQueue, INITIAL_SCAN_DECISION_QUEUE);
  const visibleSheet = visibleScanSheet(decisionQueue);
  const [folderName, setFolderName] = useState('');
  const [folderError, setFolderError] = useState<string | null>(null);
  const [filingRecoveryPending, setFilingRecoveryPending] = useState(false);
  const [linkedExpenseId, setLinkedExpenseId] = useState<string | null>(null);
  const [recordTargetError, setRecordTargetError] = useState(false);
  const [reconcilePending, setReconcilePending] = useState(false);
  const [recordResolution, setRecordResolution] = useState<
    Exclude<DocumentExpenseReconciliation, { kind: 'verified' }> | null
  >(null);
  const [capturePending, setCapturePending] = useState(false);
  const [captureError, setCaptureError] = useState<string | null>(null);
  const [exitBlocked, setExitBlocked] = useState(false);
  // Destination CHANTIER choisie pour un document de DÉPENSE : la dépense naîtra IMPUTÉE
  // (chantierId transmis à recordDocumentExpense — chantier PROUVÉ côté serveur, anti-IDOR,
  // sinon RIEN n'est créé). L'original reste libre d'être lié 'expense' à la création.
  const [expenseChantier, setExpenseChantier] = useState<{ id: string; name: string } | null>(null);
  const data = extract.data;
  const openChantiers = useMemo(
    () => (chantiers.data ?? []).filter((chantier) => chantier.status === 'open'),
    [chantiers.data],
  );
  const foldersReady = rootFolders.data !== undefined;
  const foldersBlockingError = rootFolders.isError && !foldersReady;
  const foldersStale = rootFolders.isError && foldersReady;

  /**
   * « Classer dans {destination} » (handoff §SCAN OVERLAY) : hook PARTAGÉ avec l'écran
   * document (move + classify chantier + nom intelligent + invalidations — mêmes use cases
   * que Bob, comportement du scan inchangé). Échec → l'original reste dans « À classer ».
   */
  const applyDestination = useApplyDestination({
    foldersReady,
    rootFolders: rootFolders.data,
    // Dossier système absent du coffre : on redemande à l'humain, aucun rangement deviné.
    onFilingRequested: () => dispatchDecision({ type: 'filing-requested' }),
    onMoved: (moved) =>
      setArchivedDocument((current) =>
        current?.id === moved.documentId
          ? { ...current, folderId: moved.folderId, revision: moved.revision }
          : current),
    onDocumentReplaced: (fresh) =>
      setArchivedDocument((current) => (current?.id === fresh.id ? fresh : current)),
    onApplied: () => {
      setRecordTargetError(false);
      // Destination appliquée : l'invite de rangement est consommée pour ce document.
      dispatchDecision({ type: 'filing-classified' });
    },
  });

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

  const agentContext = useMemo<AgentContext>(
    () => ({
      screen: {
        name: 'document-scan',
        instanceId: archivedDocument ? `document-scan:${archivedDocument.id}` : 'document-scan:new',
      },
      entities: archivedDocument
        ? [{ type: 'document', id: archivedDocument.id, label: archivedDocument.filename }]
        : [],
      capabilities: archivedDocument ? ['screen.read', 'document.read'] : [],
    }),
    [archivedDocument],
  );
  usePublishAgentContext(agentContext, SCAN_AGENT_LAYOUT);
  const bobScrollInsets = useBobAwareScrollInsets({
    minimumBottom: 40,
    keyboardMode: 'parent',
  });

  // Destination suggérée VALIDÉE côté domaine (chantier du contexte OU dossier système) —
  // null = décision humaine, jamais un chantier forcé. PRÉSÉANCE : quand le core a validé
  // une destination, elle PRIME sur l'heuristique brute suggestedSystemFolder de l'analyse
  // — jamais deux « Recommandé » concurrents (chantier ET dossier système) dans le rangement.
  const suggestedDestination = analysis.data?.suggestedDestination ?? null;
  const suggestedChantierId = suggestedDestination?.kind === 'chantier' ? suggestedDestination.chantierId : null;

  const suggestedFolderName = useMemo(() => {
    const result = analysis.data;
    if (!result) return null;
    // Destination chantier validée : aucun dossier système concurrent n'est proposé.
    if (suggestedChantierId !== null) return null;
    const systemKey = suggestedDestination?.kind === 'system_folder'
      ? suggestedDestination.systemKey
      : result.suggestedSystemFolder;
    return systemKey
      ? SYSTEM_FOLDER_NAME[systemKey]
      : (CUSTOM_FOLDER_NAME[result.type] ?? null);
  }, [analysis.data, suggestedChantierId, suggestedDestination]);

  const suggestedFolder = useMemo(() => {
    if (!foldersReady || suggestedChantierId !== null) return null;
    const systemKey = suggestedDestination?.kind === 'system_folder'
      ? suggestedDestination.systemKey
      : analysis.data?.suggestedSystemFolder;
    const folders = rootFolders.data;
    if (systemKey) {
      const systemFolder = folders.find((folder) => folder.systemKey === systemKey);
      if (systemFolder) return systemFolder;
    }
    if (!suggestedFolderName) return null;
    const normalized = normalizeDocumentFolderName(suggestedFolderName);
    return folders.find((folder) => folder.normalizedName === normalized) ?? null;
  }, [
    analysis.data?.suggestedSystemFolder,
    foldersReady,
    rootFolders.data,
    suggestedChantierId,
    suggestedDestination,
    suggestedFolderName,
  ]);

  const suggestedNewFolderName = foldersReady && suggestedFolder === null ? suggestedFolderName : null;

  const currentFolder = useMemo(
    () => rootFolders.data?.find((folder) => folder.id === archivedDocument?.folderId) ?? null,
    [archivedDocument?.folderId, rootFolders.data],
  );

  const archivedMimeType = archivedDocument
    ? normalizedArchiveMimeType(archivedDocument.mimeType, archivedDocument.filename)
    : null;
  const analysisUnavailable = archivedDocument !== null
    && (archivedMimeType === null || !supportsDocumentAnalysis(archivedMimeType));

  // Un original déjà rattaché à une autre entité que la dépense (ex. chantier après le CTA
  // « Classer dans Chantier · X ») ne peut plus devenir le justificatif d'une NOUVELLE dépense :
  // le serveur refuse par conflit et le coordinator annule toute la création. On retire donc la
  // confirmation vouée à l'échec au lieu de laisser l'artisan la découvrir en 409 terminal.
  const documentLinkedElsewhere =
    archivedDocument !== null
    && archivedDocument.linkedEntityType !== null
    && archivedDocument.linkedEntityType !== 'expense';

  // Rangement proposé : la suggestion en tête, puis les dossiers hors chantier (première
  // classe : frais généraux, assurances, fiscal…), puis les chantiers ouverts, puis créer.
  const filingOptions = useMemo(() => {
    if (!foldersReady) return [];
    const folders = rootFolders.data;
    const ordered = suggestedFolder
      ? [suggestedFolder, ...folders.filter((folder) => folder.id !== suggestedFolder.id)]
      : folders;
    const folderOptions = ordered.map((folder) => ({
      value: folder.id,
      label: suggestedFolder?.id === folder.id
        ? t('scan.recommendedOption', { personality, params: { label: folder.name } })
        : folder.name,
      description: suggestedFolder?.id === folder.id
        ? t('scan.folderOptionDescSuggested', { personality })
        : t('scan.folderOptionDesc', { personality }),
    }));
    const chantierOptions = openChantiers.map((chantier) => ({
      value: `${CHANTIER_OPTION_PREFIX}${chantier.id}`,
      label: chantier.id === suggestedChantierId
        ? t('scan.recommendedOption', {
            personality,
            params: { label: t('scan.chantierOption', { personality, params: { name: chantier.name } }) },
          })
        : t('scan.chantierOption', { personality, params: { name: chantier.name } }),
      // Document de DÉPENSE : le coût remontera par la dépense créée imputée — description
      // honnête, distincte du lien document↔chantier des autres originaux.
      description: t(data !== undefined ? 'scan.chantierOptionDescExpense' : 'scan.chantierOptionDesc', { personality }),
    }));
    const recommendedValue = suggestedChantierId === null ? null : `${CHANTIER_OPTION_PREFIX}${suggestedChantierId}`;
    return [
      ...chantierOptions.filter((option) => option.value === recommendedValue),
      ...folderOptions,
      ...chantierOptions.filter((option) => option.value !== recommendedValue),
      {
        value: CREATE_FOLDER_OPTION,
        label: suggestedNewFolderName
          ? `Créer « ${suggestedNewFolderName} »`
          : 'Créer un nouveau dossier',
        description: suggestedNewFolderName
          ? 'Bob propose ce nouveau rangement. Tu pourras corriger son nom avant de le créer.'
          : 'Choisir toi-même le nom du nouveau dossier.',
      },
    ];
  }, [data, foldersReady, openChantiers, personality, rootFolders.data, suggestedChantierId, suggestedFolder, suggestedNewFolderName]);

  // La machine suit le document archivé : tout changement remet la file de décisions à
  // zéro — l'invite de rangement consommée d'un document ne fuit jamais vers le suivant.
  const archivedDocumentId = archivedDocument?.id ?? null;
  useEffect(() => {
    dispatchDecision({ type: 'document-changed', documentId: archivedDocumentId });
  }, [archivedDocumentId]);

  async function archiveAndAnalyze(input: CreateDocumentIntakeClientInput): Promise<void> {
    try {
      const archived = await intake.mutateAsync(input);
      intakeInputRef.current = null;
      setArchivedDocument(archived);
      const mimeType = normalizedArchiveMimeType(archived.mimeType, archived.filename);
      if (mimeType && supportsDocumentAnalysis(mimeType)) analysis.mutate(archived.id);
      if (photoRef.current) extract.mutate(photoRef.current);
    } catch {
      // La même clé reste disponible : un retry réseau ne dupliquera jamais l'original.
    }
  }

  function resetForNewDocument(): void {
    // La file de décisions se réinitialise via l'effet « document-changed » (archivedDocument → null).
    setArchivedDocument(null);
    setFolderName('');
    setFolderError(null);
    setFilingRecoveryPending(false);
    setLinkedExpenseId(null);
    setRecordTargetError(false);
    setReconcilePending(false);
    setRecordResolution(null);
    setExpenseChantier(null);
    applyDestination.reset();
    setChosenCategory(null);
    setCategoryDismissed(false);
    setSettlementChoice(null);
    setSettlementMethod(null);
    setSettlementDismissed(false);
    setSettlementError(false);
    intake.reset();
    extract.reset();
    analysis.reset();
    moveDocument.reset();
    createFolder.reset();
    record.reset();
  }

  async function prepareOriginal(
    file: ExpoFile,
    fallbackMimeType?: string,
    fallbackFilename?: string | null,
  ): Promise<void> {
    setCaptureError(null);
    setCapturePending(true);
    try {
      const filenameCandidate = fallbackFilename?.trim() || file.name || `document-${Date.now()}`;
      const mimeType = normalizedArchiveMimeType(file.type || fallbackMimeType, filenameCandidate);
      if (!mimeType) {
        setCaptureError('Ce format n’est pas encore pris en charge. Choisis un PDF, XML, JPEG, PNG, WebP ou HEIC.');
        return;
      }
      if (file.size > DOCUMENT_MAX_BYTES) {
        setCaptureError('Ce document dépasse 10 Mo. L’original n’a pas été envoyé.');
        return;
      }
      const contentBase64 = await readLocalFileWithTimeout(file);
      const estimatedBytes = Math.floor(contentBase64.replace(/=+$/, '').length * 3 / 4);
      if (!contentBase64 || estimatedBytes === 0) {
        setCaptureError('Le fichier sélectionné est vide ou illisible. Aucun original n’a été envoyé.');
        return;
      }
      if (estimatedBytes > DOCUMENT_MAX_BYTES) {
        setCaptureError('Ce document dépasse 10 Mo. L’original n’a pas été envoyé.');
        return;
      }
      const extension = Object.entries(MIME_BY_EXTENSION).find(([, type]) => type === mimeType)?.[0] ?? 'bin';
      const filename = safeArchiveFilename(filenameCandidate, `document-${Date.now()}.${extension}`);
      resetForNewDocument();
      // Le binaire lu ici provient du fichier natif, pas de la représentation JPEG réencodée
      // d'ImagePicker : l'empreinte serveur porte donc sur l'original effectivement choisi.
      photoRef.current = OCR_MIME_TYPES.has(mimeType) ? { contentBase64, mimeType } : null;
      const intakeInput: CreateDocumentIntakeClientInput = {
        contentBase64,
        mimeType,
        filename,
        idempotencyKey: newIntakeKey(),
      };
      intakeInputRef.current = intakeInput;
      await archiveAndAnalyze(intakeInput);
    } catch (error) {
      setCaptureError(error instanceof LocalFileReadTimeoutError
        ? 'La lecture du fichier prend trop de temps. Aucun envoi n’a été lancé : réessaie depuis Documents.'
        : 'Le fichier n’a pas pu être lu sur cet appareil. Aucun original n’a été envoyé.');
    } finally {
      setCapturePending(false);
    }
  }

  const supplierDefaultsInput = useMemo(
    () => data
      ? {
          supplierName: data.supplierName,
          supplierSiren: data.supplierSiren,
          vatRatePctApplied: data.vatRatePctApplied,
          categoryGuess: data.categoryGuess,
        }
      : null,
    [data],
  );
  // Source unique : mémoire fournisseur PostgreSQL/RLS du tenant. Une panne ne devient jamais
  // silencieusement « aucune habitude » et ne déclenche aucun recalcul depuis les dépenses locales.
  const supplierDefaults = useSupplierExpenseDefaults(supplierDefaultsInput);
  const supplierDefaultsState = deriveSupplierExpenseDefaultsState({
    hasExtraction: data !== undefined,
    companyId: supplierDefaults.companyId,
    query: supplierDefaults,
  });
  const defaults = supplierDefaultsState.kind === 'ready' ? supplierDefaultsState.value : null;

  // ASK-3 : catégorie ambiguë (devinette OCR hésitante ou « autre », jamais sur une habitude
  // fournisseur) — question structurée AVANT l'enregistrement ; le choix nourrit la mémoire.
  const [chosenCategory, setChosenCategory] = useState<ExpenseCategory | null>(null);
  const [categoryDismissed, setCategoryDismissed] = useState(false);
  const clarification = data && defaults ? suggestCategoryClarification(defaults, data) : null;
  // Plus de dépense possible quand l'original est rattaché ailleurs : ne rien demander.
  const askCategory =
    clarification !== null && chosenCategory === null && !categoryDismissed && !documentLinkedElsewhere;
  const category: ExpenseCategory = chosenCategory ?? defaults?.category ?? (data?.categoryGuess ?? 'autre');

  // Statut payé/à payer : un ticket EST une preuve de paiement → dépense créée PAYÉE avec le
  // scan comme preuve ; une facture reste « à payer » (+ échéance lue). Ambigu → on demande,
  // on ne devine jamais. Le choix se corrige d'un tap (« c'est déjà payé » / « c'est à payer »).
  const [settlementChoice, setSettlementChoice] = useState<ScanSettlementChoice | null>(null);
  const [settlementMethod, setSettlementMethod] = useState<PaymentMethod | null>(null);
  const [settlementDismissed, setSettlementDismissed] = useState(false);
  const [settlementError, setSettlementError] = useState(false);
  const settlementProposal = useMemo(
    () => (data ? deriveScanSettlementProposal(data) : null),
    [data],
  );
  const effectiveSettlement: ScanSettlementChoice | null =
    settlementChoice ?? settlementProposal?.proposal ?? null;
  const effectiveMethod: PaymentMethod =
    settlementMethod ?? settlementProposal?.methodSeen ?? DEFAULT_TICKET_PAYMENT_METHOD;
  const askSettlement =
    data !== undefined
    && effectiveSettlement === null
    && !settlementDismissed
    && !askCategory
    && !documentLinkedElsewhere;

  // Signaux de la file de décisions — la machine pure garantit l'ordre catégorie →
  // règlement et n'ouvre JAMAIS le rangement d'elle-même (geste humain requis).
  const documentFolderId = archivedDocument?.folderId ?? null;
  const decisionSignals = useMemo<ScanDecisionSignals>(
    () => ({
      categoryPending: askCategory,
      settlementPending: askSettlement,
      filingReady: foldersReady && !filingRecoveryPending && filingOptions.length > 0,
      documentFiled: documentFolderId !== null,
    }),
    [askCategory, askSettlement, documentFolderId, filingOptions.length, filingRecoveryPending, foldersReady],
  );
  useEffect(() => {
    dispatchDecision({ type: 'signals-changed', signals: decisionSignals });
  }, [decisionSignals]);

  async function capture(from: 'camera' | 'library'): Promise<void> {
    setCaptureError(null);
    try {
      const perm =
        from === 'camera'
          ? await ImagePicker.requestCameraPermissionsAsync()
          : await ImagePicker.requestMediaLibraryPermissionsAsync();
      if (!perm.granted) {
        setCaptureError(from === 'camera'
          ? 'Autorise l’appareil photo pour scanner un original.'
          : 'Autorise l’accès aux photos pour choisir un original.');
        return;
      }
      const options: ImagePicker.ImagePickerOptions = {
        base64: false,
        quality: 1,
        mediaTypes: ['images'],
      };
      const res = from === 'camera'
        ? await ImagePicker.launchCameraAsync(options)
        : await ImagePicker.launchImageLibraryAsync(options);
      if (res.canceled) return;
      const asset = res.assets[0];
      if (!asset) return;
      await prepareOriginal(new ExpoFile(asset.uri), asset.mimeType, asset.fileName);
    } catch {
      setCaptureError('La capture n’a pas abouti. Aucun original n’a été envoyé.');
    }
  }

  async function importDocument(): Promise<void> {
    setCaptureError(null);
    try {
      const picked = await ExpoFile.pickFileAsync({
        mimeTypes: [...ARCHIVE_MIME_TYPES],
      });
      if (picked.canceled) return;
      await prepareOriginal(picked.result, picked.result.type, picked.result.name);
    } catch {
      setCaptureError('Le sélecteur de documents n’a pas pu être ouvert. Aucun original n’a été envoyé.');
    }
  }

  async function invalidateDocumentExpense(out: RecordDocumentExpenseClientOutput): Promise<void> {
    await Promise.all([
      queryClient.invalidateQueries({ queryKey: ['documents'] }),
      queryClient.invalidateQueries({ queryKey: ['document', out.document.id] }),
      queryClient.invalidateQueries({ queryKey: ['document-folders'] }),
      queryClient.invalidateQueries({ queryKey: ['expenses'] }),
      queryClient.invalidateQueries({ queryKey: ['cashflow'] }),
      queryClient.invalidateQueries({ queryKey: ['accounting-entries'] }),
    ]);
  }

  function completeDocumentExpense(
    out: RecordDocumentExpenseClientOutput,
    invalidateAfterDirectReplay = false,
  ): void {
    if (invalidateAfterDirectReplay) void invalidateDocumentExpense(out);
    // L'enregistrement serveur vient d'apprendre/actualiser ce fournisseur. Ne jamais laisser
    // un ancien résultat « OCR » masquer ce nouveau profil lors du scan suivant.
    void queryClient.invalidateQueries({ queryKey: ['supplier-memory'] });
    // L'utilisateur peut quitter dès que l'original est archivé. Un retour réseau tardif met à
    // jour les caches, mais ne doit jamais le téléporter vers un écran qu'il vient de fermer.
    if (!mountedRef.current) return;
    setArchivedDocument(out.document);
    setLinkedExpenseId(out.expenseId);
    setRecordResolution(null);
    record.reset();
    router.replace({ pathname: '/documents/[id]', params: { id: out.document.id } });
  }

  async function reconcileDocumentExpense(
    command: RecordDocumentExpenseClientInput,
    error: Parameters<typeof reconcileDocumentExpenseCommand>[2],
  ): Promise<void> {
    setReconcilePending(true);
    try {
      const resolution = await reconcileDocumentExpenseCommand(client, command, error);
      if (resolution.kind === 'verified') {
        completeDocumentExpense(resolution.value, true);
        return;
      }
      if (!mountedRef.current) return;
      if (resolution.kind === 'stale' && resolution.current) {
        setArchivedDocument(resolution.current);
      }
      setRecordResolution(resolution);
      record.reset();
      if (resolution.kind === 'stale') void rootFolders.refetch();
    } finally {
      if (mountedRef.current) setReconcilePending(false);
    }
  }

  async function reloadStaleDocument(
    resolution: Extract<DocumentExpenseReconciliation, { kind: 'stale' }>,
  ): Promise<void> {
    setReconcilePending(true);
    try {
      const fresh = await client.getDocument(resolution.command.documentId);
      if (!mountedRef.current) return;
      if (fresh.ok) {
        setArchivedDocument(fresh.value);
        setRecordResolution({ ...resolution, current: fresh.value, readError: null });
      } else {
        setRecordResolution({ ...resolution, current: null, readError: fresh.error });
      }
    } finally {
      if (mountedRef.current) setReconcilePending(false);
    }
  }

  function recordExpenseFromDocument(): void {
    if (recordResolution?.kind === 'unresolved') {
      void reconcileDocumentExpense(recordResolution.command, recordResolution.error);
      return;
    }
    if (recordResolution?.kind === 'stale' && recordResolution.current === null) {
      void reloadStaleDocument(recordResolution);
      return;
    }
    if (recordResolution?.kind === 'rejected') {
      router.push({ pathname: '/documents/[id]', params: { id: recordResolution.command.documentId } });
      return;
    }
    if (
      recordResolution?.kind === 'stale'
      && recordResolution.current
      && recordResolution.current.linkedEntityId !== null
    ) {
      router.push({ pathname: '/documents/[id]', params: { id: recordResolution.command.documentId } });
      return;
    }
    const document = archivedDocument;
    if (!document || !data || !defaults || record.isPending) return;
    // Statut payé/à payer non tranché (extraction ambiguë et pas encore de réponse) :
    // on repose la question au lieu de deviner un « à payer » absurde pour un ticket.
    if (effectiveSettlement === null) {
      setSettlementError(true);
      setSettlementDismissed(false);
      return;
    }
    setSettlementError(false);
    // Le choix « Plus tard — laisser dans À classer » reste respecté : créer une dépense ne
    // déclenche jamais un rangement silencieux. On redemande explicitement le dossier —
    // geste humain (tentative de dépense) : la machine ré-ouvre même une invite consommée.
    if (document.folderId === null) {
      setRecordTargetError(true);
      dispatchDecision({ type: 'filing-requested' });
      return;
    }
    setRecordTargetError(false);
    setRecordResolution(null);
    const command: RecordDocumentExpenseClientInput = {
      documentId: document.id,
      expectedRevision: document.revision,
      targetFolderId: document.folderId,
      expense: {
        supplierName: data.supplierName,
        supplierSiren: defaults.supplierSiren,
        documentDate: data.documentDate,
        totalTtcCents: data.totalTtcCents,
        totalHtCents: data.totalHtCents,
        vatCents: data.vatCents,
        vatRatePct: defaults.vatRatePct,
        category,
        // Destination chantier choisie au scan : la dépense naît IMPUTÉE — le serveur PROUVE
        // le chantier dans le tenant (anti-IDOR, not_found('chantier') sinon, RIEN n'est créé).
        ...(expenseChantier !== null ? { chantierId: expenseChantier.id } : {}),
        // Ticket → dépense payée d'emblée (le scan devient la preuve, autorité serveur) ;
        // facture → à payer avec l'échéance lue si présente.
        ...settlementExpenseFields(
          {
            choice: effectiveSettlement,
            method: effectiveMethod,
            dueAt: settlementProposal?.dueAt ?? null,
          },
          data.documentDate,
        ),
      },
    };
    record.mutate(
      command,
      {
        onSuccess: (out) => {
          completeDocumentExpense(out);
        },
        onError: (error) => void reconcileDocumentExpense(command, error),
      },
    );
  }

  function classifyInFolder(folderId: string): void {
    if (!archivedDocument || !foldersReady) return;
    moveDocument.mutate(
      { documentId: archivedDocument.id, folderId, expectedRevision: archivedDocument.revision },
      {
        onSuccess: (moved) => {
          setRecordTargetError(false);
          setArchivedDocument((current) =>
            current?.id === moved.documentId
              ? { ...current, folderId: moved.folderId, revision: moved.revision }
              : current);
          // Classement réussi : invite CONSOMMÉE — plus aucune ré-ouverture automatique.
          dispatchDecision({ type: 'filing-classified' });
          applySuggestedName(moved.documentId, moved.revision);
        },
        // Échec du déplacement : la feuille revient pour reprendre le geste interrompu.
        onError: () => dispatchDecision({ type: 'filing-requested' }),
      },
    );
  }

  /**
   * Le nom professionnel proposé devient le nom du document AU CLASSEMENT (l'intelligence
   * demandée) — best-effort : jamais sur un renommage humain, jamais bloquant pour le
   * rangement déjà commis. La révision fraîche renvoyée resynchronise l'état local.
   */
  function applySuggestedName(documentId: string, revision: number): void {
    const document = archivedDocument;
    if (!document || document.id !== documentId) return;
    const rename = suggestedRenameFor(document, analysis.data?.suggestedDisplayName ?? null);
    if (rename === null) return;
    void client
      .renameDocument({ documentId, displayName: rename, expectedRevision: revision })
      .then((renamed) => {
        if (!renamed.ok || !mountedRef.current) return;
        setArchivedDocument((current) => (current?.id === documentId ? renamed.value : current));
        void queryClient.invalidateQueries({ queryKey: ['documents'] });
        void queryClient.invalidateQueries({ queryKey: ['document', documentId] });
      });
  }

  /**
   * Destination chantier choisie — deux sens métier distincts (plan PUR testé) :
   * · document de DÉPENSE (extraction présente) → la dépense naîtra IMPUTÉE au chantier
   *   (chantierId transmis à la création) ; l'original est rangé dans « Chantiers » s'il
   *   n'est pas encore rangé et reste LIBRE d'être lié 'expense' (justificatif) ;
   * · autre document → lien métier document↔chantier (ClassifyDocument, historique).
   */
  function chooseChantierDestination(chantierId: string, name: string): void {
    const plan = planScanChantierChoice({
      hasExtraction: data !== undefined,
      documentFolderId: archivedDocument?.folderId ?? null,
      projectsFolderId: rootFolders.data?.find((folder) => folder.systemKey === 'projects')?.id ?? null,
    });
    if (plan.kind === 'impute_expense') {
      setExpenseChantier({ id: chantierId, name });
      if (plan.moveToFolderId !== null) classifyInFolder(plan.moveToFolderId);
      // Déjà rangé (ou « Chantiers » absent du coffre) : aucun déplacement — invite consommée.
      else dispatchDecision({ type: 'filing-classified' });
      return;
    }
    void applyDestination.apply(
      archivedDocument,
      { kind: 'chantier', chantierId, label: name, motif: '' },
      analysis.data?.suggestedDisplayName ?? null,
    );
  }

  /** Choix « Chantier · {name} » du rangement — cible réelle listée, jamais un id inventé. */
  function classifyToChantier(chantierId: string): void {
    const chantier = openChantiers.find((candidate) => candidate.id === chantierId);
    if (!chantier) return;
    chooseChantierDestination(chantier.id, chantier.name);
  }

  async function recoverFolderChoice(): Promise<void> {
    if (!archivedDocument || filingRecoveryPending) return;
    setFilingRecoveryPending(true);
    try {
      const [, freshDocument] = await Promise.all([
        rootFolders.refetch(),
        client.getDocument(archivedDocument.id),
      ]);
      if (!freshDocument.ok || !mountedRef.current) return;
      setArchivedDocument(freshDocument.value);
      moveDocument.reset();
      // Geste humain de reprise : la feuille de rangement se ré-ouvre sur l'état frais.
      dispatchDecision({ type: 'filing-requested' });
    } finally {
      if (mountedRef.current) setFilingRecoveryPending(false);
    }
  }

  function openFolderEditor(): void {
    if (!foldersReady) return;
    setFolderName(suggestedNewFolderName ?? '');
    setFolderError(null);
    // L'éditeur prendra la place de la feuille de rangement APRÈS sa sortie (jamais superposé).
    dispatchDecision({ type: 'folder-editor-requested' });
  }

  function createAndClassifyFolder(): void {
    if (!archivedDocument || !foldersReady || createFolder.isPending) return;
    const validated = validateDocumentFolderName(folderName);
    if (!validated.ok) {
      setFolderError(
        validated.error.code === 'VALIDATION'
          ? validated.error.message
          : 'Ce nom de dossier n’est pas valide.',
      );
      return;
    }
    setFolderError(null);
    createFolder.mutate(
      { name: validated.value.name, parentId: null },
      {
        onSuccess: (created) => {
          dispatchDecision({ type: 'folder-editor-completed' });
          setFolderName('');
          classifyInFolder(created.id);
        },
        onError: () => {
          setFolderError('Ce dossier existe peut-être déjà ou le coffre a changé. Recharge puis réessaie.');
          void rootFolders.refetch();
        },
      },
    );
  }

  const workflowBusy = capturePending
    || intake.isPending
    || analysis.isPending
    || extract.isPending
    || moveDocument.isPending
    || filingRecoveryPending
    || createFolder.isPending
    || record.isPending
    || reconcilePending
    || applyDestination.pending;
  const recordActionRequiresSupplierDefaults = recordResolution === null
    || (
      recordResolution.kind === 'stale'
      && recordResolution.current !== null
      && recordResolution.current.linkedEntityId === null
    );
  // Après l'archivage, toutes les opérations sont reprenables depuis le coffre et bornées côté
  // client HTTP. Seule la courte fenêtre où l'on ne sait pas encore si l'original existe empêche
  // une sortie accidentelle.
  const exitUnsafe = archivedDocument === null && (capturePending || intake.isPending);

  useEffect(() => {
    if (!exitUnsafe) {
      setExitBlocked(false);
      return undefined;
    }
    return navigation.addListener('beforeRemove', (event) => {
      event.preventDefault();
      setExitBlocked(true);
    });
  }, [exitUnsafe, navigation]);

  const closeScreen = (): void => {
    if (exitUnsafe) {
      setExitBlocked(true);
      return;
    }
    router.back();
  };

  return (
    <ScrollView
      style={{ flex: 1, backgroundColor: colors.bg }}
      contentContainerStyle={{ paddingBottom: bobScrollInsets.paddingBottom }}
      automaticallyAdjustKeyboardInsets={bobScrollInsets.automaticallyAdjustKeyboardInsets}
      scrollIndicatorInsets={{ bottom: bobScrollInsets.scrollIndicatorBottom }}
    >
      <View style={{ paddingTop: insets.top + 8, paddingHorizontal: 20, paddingBottom: 8 }}>
        <Pressable
          onPress={closeScreen}
          accessibilityRole="button"
          accessibilityLabel={exitUnsafe ? 'Archivage en cours, fermeture temporairement indisponible' : 'Fermer'}
          accessibilityState={{ disabled: exitUnsafe }}
          style={{ minHeight: 44, alignSelf: 'flex-start', flexDirection: 'row', alignItems: 'center', gap: 4, opacity: exitUnsafe ? 0.55 : 1 }}
        >
          <Ionicons name="chevron-back" size={22} color={colors.ink800} />
          <Text style={[font('body'), { color: colors.ink800 }]}>{exitUnsafe ? 'Archivage en cours…' : 'Fermer'}</Text>
        </Pressable>
        {exitBlocked ? (
          <Text accessibilityRole="alert" style={[font('meta'), { color: semantic.warning, marginTop: 8, lineHeight: 17 }]}>
            Le résultat de l’archivage n’est pas encore connu. L’attente est bornée ; en cas de coupure, le bouton de reprise conservera exactement la même clé sans créer de doublon.
          </Text>
        ) : null}
      </View>

      <View style={{ padding: 20, gap: 16 }}>
        <Text style={[font('pageTitle'), { color: colors.ink900 }]}>Scanner un document</Text>
        <Text style={[font('body'), { color: colors.slate500 }]}>
          Photographie n’importe quel document de l’entreprise. Bob conserve toujours l’original, explique ce qu’il comprend et te propose un rangement avant toute action comptable.
        </Text>

        <View style={{ gap: 8 }}>
          <Button
            title={capturePending ? 'Préparation de l’original…' : 'Prendre une photo'}
            disabled={workflowBusy}
            onPress={() => void capture('camera')}
          />
          <Button
            title="Choisir dans la galerie"
            variant="secondary"
            disabled={workflowBusy}
            onPress={() => void capture('library')}
          />
          <Button
            title="Importer un PDF, XML ou une image"
            variant="secondary"
            disabled={workflowBusy}
            onPress={() => void importDocument()}
          />
        </View>

        {captureError ? (
          <Text accessibilityRole="alert" style={[font('sub'), { color: semantic.danger }]}>{captureError}</Text>
        ) : null}

        {intake.isPending ? (
          <Card>
            <View accessibilityRole="progressbar" accessibilityLiveRegion="polite" accessibilityLabel="Archivage sécurisé de l’original" style={{ flexDirection: 'row', alignItems: 'center', gap: 10 }}>
              <ActivityIndicator color={colors.ink800} />
              <Text style={[font('body'), { color: colors.ink800 }]}>Archivage sécurisé de l’original…</Text>
            </View>
          </Card>
        ) : null}

        {intake.isError ? (
          <Card>
            <Text accessibilityRole="alert" style={[font('cardTitle'), { color: semantic.warning }]}>Archivage à confirmer</Text>
            <Text style={[font('sub'), { color: colors.slate500, marginTop: 4, lineHeight: 19 }]}>La réponse n’est pas revenue à temps. L’original peut déjà être conservé. La reprise renvoie exactement la même clé : le serveur le retrouve ou l’archive une seule fois, puis seulement Bob lance l’analyse.</Text>
            {intakeInputRef.current ? (
              <View style={{ marginTop: 12 }}>
                <Button
                  title="Réessayer sans créer de doublon"
                  variant="secondary"
                  onPress={() => intakeInputRef.current && void archiveAndAnalyze(intakeInputRef.current)}
                />
              </View>
            ) : null}
          </Card>
        ) : null}

        {archivedDocument ? (
          <Card>
            <View accessibilityLiveRegion="polite" style={{ flexDirection: 'row', alignItems: 'center', gap: 10 }}>
              <Ionicons name="shield-checkmark" size={22} color={semantic.success} />
              <View style={{ flex: 1 }}>
                <Text style={[font('cardTitle'), { color: colors.ink900 }]}>Original conservé</Text>
                <Text style={[font('sub'), { color: colors.slate500, marginTop: 2, lineHeight: 19 }]}>Le document reste dans « À classer » même si l’analyse échoue. Tu peux fermer maintenant et reprendre depuis Documents.</Text>
              </View>
            </View>
          </Card>
        ) : null}

        {analysisUnavailable && archivedDocument ? (
          <Card>
            <Text accessibilityRole="alert" style={[font('cardTitle'), { color: semantic.warning }]}>Original archivé · analyse non disponible</Text>
            <Text style={[font('sub'), { color: colors.slate500, marginTop: 4, lineHeight: 19 }]}>Bob conserve le HEIC/HEIF original sans le modifier. Aucun transcodage fiable n’est installé sur cet appareil, donc il ne lance pas une analyse vouée à l’échec. Pour une lecture assistée, importe une copie JPEG ou PDF.</Text>
            <View style={{ marginTop: 12, gap: 8 }}>
              {archivedDocument.folderId === null ? (
                <>
                  {foldersStale ? (
                    <Text accessibilityRole="alert" style={[font('meta'), { color: semantic.warning, lineHeight: 17 }]}>La dernière liste serveur des dossiers reste affichée ; sa mise à jour a échoué.</Text>
                  ) : null}
                  {!foldersReady ? (
                    foldersBlockingError ? (
                      <View>
                        <Text accessibilityRole="alert" style={[font('sub'), { color: semantic.danger, lineHeight: 19 }]}>Les dossiers ne sont pas disponibles. L’original reste conservé dans « À classer ».</Text>
                        <View style={{ marginTop: 10 }}>
                          <Button title="Réessayer de charger les dossiers" variant="secondary" onPress={() => void rootFolders.refetch()} />
                        </View>
                      </View>
                    ) : (
                      <View accessibilityRole="progressbar" accessibilityLiveRegion="polite" accessibilityLabel="Chargement des dossiers">
                        <Skeleton height={52} radius={18} />
                      </View>
                    )
                  ) : (
                    <Button
                      title="Choisir un dossier sans analyse"
                      variant="secondary"
                      onPress={() => dispatchDecision({ type: 'filing-requested' })}
                    />
                  )}
                </>
              ) : null}
              <Button
                title="Voir l’original"
                variant="secondary"
                onPress={() => router.push({ pathname: '/documents/[id]', params: { id: archivedDocument.id } })}
              />
            </View>
          </Card>
        ) : null}

        {/* « Je lis ton document… » (handoff §SCAN OVERLAY) — miniature squelette + ligne de
            scan indigo en aller-retour ; reduced-motion → pulse discret sans déplacement. */}
        {analysis.isPending || extract.isPending ? <ScanReadingCard /> : null}

        {analysis.data ? (
          <>
            <SectionHeader title="Ce que Bob a compris" />
            {/* CARTE PARTAGÉE scan ↔ écran document (source unique du rendu, zéro duplication). */}
            <DocumentInsightCard
              insight={deriveDocumentInsight({
                analysis: analysis.data,
                extraction: data ? { totalTtcCents: data.totalTtcCents, vatCents: data.vatCents } : null,
                // Préséance du titre : un renommage humain déjà persisté prime sur la suggestion.
                document: archivedDocument,
              })}
              actions={
                <>
                  {foldersStale ? (
                    <Text accessibilityRole="alert" style={[font('meta'), { color: semantic.warning, lineHeight: 17 }]}>La dernière liste serveur des dossiers reste utilisable ; sa mise à jour a échoué.</Text>
                  ) : null}
                  {currentFolder ? (
                    <View style={{ flexDirection: 'row', alignItems: 'center', gap: 7 }}>
                      <Ionicons name="folder" size={17} color={semantic.success} />
                      <Text style={[font('sub'), { color: colors.ink800, flex: 1 }]}>
                        {t('docs.classifiedIn', { personality, params: { folder: currentFolder.name } })}
                      </Text>
                    </View>
                  ) : !foldersReady ? (
                    foldersBlockingError ? (
                      <View>
                        <Text accessibilityRole="alert" style={[font('sub'), { color: semantic.danger, lineHeight: 19 }]}>Les dossiers ne sont pas disponibles. Bob ne proposera aucun rangement tant qu’ils ne sont pas rechargés.</Text>
                        <View style={{ marginTop: 10 }}>
                          <Button title="Réessayer de charger les dossiers" variant="secondary" onPress={() => void rootFolders.refetch()} />
                        </View>
                      </View>
                    ) : (
                      <View accessibilityRole="progressbar" accessibilityLiveRegion="polite" accessibilityLabel="Chargement des dossiers">
                        <Skeleton height={52} radius={18} />
                      </View>
                    )
                  ) : analysis.data.suggestedDestination ? (
                    <>
                      {/* CTA plein indigo du handoff : applique la destination validée en 1 tap. */}
                      <Button
                        title={t('scan.classifyInto', {
                          personality,
                          params: { label: analysis.data.suggestedDestination.label },
                        })}
                        variant="aiSolid"
                        loading={applyDestination.pending}
                        disabled={applyDestination.pending || moveDocument.isPending}
                        onPress={() => {
                          const destination = analysis.data?.suggestedDestination;
                          if (!destination) return;
                          if (destination.kind === 'chantier') {
                            // Même décision que la feuille de rangement : dépense → imputation
                            // par la dépense ; autre document → lien document↔chantier.
                            chooseChantierDestination(
                              destination.chantierId,
                              openChantiers.find((chantier) => chantier.id === destination.chantierId)?.name
                                ?? destination.label,
                            );
                            return;
                          }
                          void applyDestination.apply(
                            archivedDocument,
                            destination,
                            analysis.data?.suggestedDisplayName ?? null,
                          );
                        }}
                      />
                      <Button
                        title={t('scan.chooseOtherFolder', { personality })}
                        variant="secondary"
                        disabled={applyDestination.pending}
                        onPress={() => dispatchDecision({ type: 'filing-requested' })}
                      />
                    </>
                  ) : (
                    <Button
                      title={suggestedFolder ? `Classer dans « ${suggestedFolder.name} »` : 'Choisir un dossier'}
                      variant="ai"
                      onPress={() => dispatchDecision({ type: 'filing-requested' })}
                    />
                  )}
                  {applyDestination.error ? (
                    <Text accessibilityRole="alert" style={[font('sub'), { color: semantic.warning, lineHeight: 19 }]}>
                      {t('scan.destinationError', { personality })}
                    </Text>
                  ) : null}
                  <Button
                    title="Voir l’original et les preuves"
                    variant="secondary"
                    onPress={() => router.push({ pathname: '/documents/[id]', params: { id: analysis.data.documentId } })}
                  />
                </>
              }
            />
          </>
        ) : null}

        {analysis.isError ? (
          <Card>
            <Text style={[font('cardTitle'), { color: semantic.warning }]}>Bob n’a pas pu terminer la lecture</Text>
            <Text style={[font('sub'), { color: colors.slate500, marginTop: 4 }]}>L’original est déjà conservé. Tu peux relancer l’analyse sans rescanner ni risquer de perdre la pièce.</Text>
            {archivedDocument ? (
              <View style={{ marginTop: 12 }}>
                <Button title="Relancer Bob" variant="secondary" onPress={() => analysis.mutate(archivedDocument.id)} />
              </View>
            ) : null}
          </Card>
        ) : null}

        {moveDocument.isPending ? (
          <Card>
            <View accessibilityRole="progressbar" accessibilityLiveRegion="polite" accessibilityLabel="Classement de l’original">
              <Skeleton height={16} width="62%" radius={7} />
            </View>
          </Card>
        ) : null}

        {moveDocument.isError ? (
          filingRecoveryPending ? (
            <Card>
              <View accessibilityRole="progressbar" accessibilityLiveRegion="polite" accessibilityLabel="Actualisation du document et des dossiers">
                <Skeleton height={16} width="76%" radius={7} />
              </View>
            </Card>
          ) : (
            <ErrorRetry
              message="Le dossier ou le document a changé entre-temps. Bob a conservé l’original sans le reclasser."
              onRetry={() => void recoverFolderChoice()}
            />
          )
        ) : null}

        {extract.isError ? (
          <Card>
            <Text style={[font('cardTitle'), { color: semantic.warning }]}>Lecture comptable non disponible</Text>
            <Text style={[font('sub'), { color: colors.slate500, marginTop: 4 }]}>
              Ce document ne ressemble peut-être pas à une facture fournisseur. L’analyse générale de Bob et l’original restent disponibles.
            </Text>
            {photoRef.current ? (
              <View style={{ marginTop: 12 }}>
                <Button
                  title="Retenter la lecture comptable"
                  variant="secondary"
                  onPress={() => photoRef.current && extract.mutate(photoRef.current)}
                />
              </View>
            ) : null}
          </Card>
        ) : null}

        {supplierDefaultsState.kind === 'loading' ? (
          <Card>
            <View
              accessibilityRole="progressbar"
              accessibilityLiveRegion="polite"
              accessibilityLabel="Vérification de la mémoire fournisseur"
            >
              <Skeleton height={16} width="74%" radius={7} />
            </View>
          </Card>
        ) : null}

        {supplierDefaultsState.kind === 'unavailable' ? (
          <ErrorRetry
            message="La mémoire fournisseur de cette société n’est pas disponible. Les valeurs visibles restent celles lues sur le document ; aucune dépense ne sera créée tant que le serveur ne les aura pas vérifiées."
            onRetry={() => void supplierDefaults.refetch()}
            retrying={supplierDefaults.isRefetching}
          />
        ) : null}

        {/* La pièce est désormais liée à son chantier : plus aucune dépense ne peut la prendre
            comme preuve (conflit serveur garanti). Message honnête au lieu d'un bouton piégé.
            Une réconciliation en cours (stale/rejected) garde ses cartes dédiées plus précises. */}
        {data && documentLinkedElsewhere && recordResolution === null ? (
          <Card>
            <Text accessibilityLiveRegion="polite" style={[font('cardTitle'), { color: colors.ink900 }]}>
              {t('scan.linkedChantierTitle', { personality })}
            </Text>
            <Text style={[font('sub'), { color: colors.slate500, marginTop: 4, lineHeight: 19 }]}>
              {t('scan.linkedChantierBody', { personality })}
            </Text>
            {archivedDocument ? (
              <View style={{ marginTop: 12 }}>
                <Button
                  title={t('scan.linkedChantierCta', { personality })}
                  variant="secondary"
                  onPress={() => router.push({ pathname: '/documents/[id]', params: { id: archivedDocument.id } })}
                />
              </View>
            ) : null}
          </Card>
        ) : null}

        {data && (!documentLinkedElsewhere || recordResolution !== null) ? (
          <>
            <SectionHeader title="Extraction" />
            <Card>
              <View style={{ flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center' }}>
                <Text style={[font('cardTitle'), { color: colors.ink900 }]}>{data.supplierName}</Text>
                <Badge
                  label={`${Math.round(data.confidence * 100)} %`}
                  tone={data.confidence >= 0.85 ? 'success' : 'warning'}
                  accessibilityLabel={t('docs.confidenceA11y', {
                    personality,
                    params: { pct: Math.round(data.confidence * 100) },
                  })}
                />
              </View>
              <View style={{ marginTop: 10, gap: 6 }}>
                <Row label="Date" value={data.documentDate} colors={colors} />
                <Row label="Total TTC" value={formatEUR(data.totalTtcCents)} colors={colors} strong />
                {data.vatCents !== null ? <Row label="TVA" value={formatEUR(data.vatCents)} colors={colors} /> : null}
                {(defaults?.vatRatePct ?? data.vatRatePctApplied) !== null ? (
                  <Row label="Taux TVA" value={`${defaults?.vatRatePct ?? data.vatRatePctApplied} %`} colors={colors} />
                ) : null}
                <View>
                  <Row
                    label={defaults ? 'Catégorie' : 'Catégorie OCR · non vérifiée'}
                    value={CATEGORY_LABEL[category] ?? category}
                    colors={colors}
                  />
                  {defaults?.source === 'memory' ? (
                    <Text style={[font('meta'), { color: semantic.ai, marginTop: 2, textAlign: 'right' }]}>
                      ✨ Proposé d’après ton historique
                    </Text>
                  ) : clarification !== null ? (
                    <Pressable
                      accessibilityRole="button"
                      accessibilityLabel="Préciser la catégorie"
                      onPress={() => {
                        setChosenCategory(null);
                        setCategoryDismissed(false);
                      }}
                      style={{ minHeight: 44, justifyContent: 'center' }}
                    >
                      <Text style={[font('meta'), { color: chosenCategory ? semantic.ai : semantic.warning, marginTop: 2, textAlign: 'right' }]}>
                        {chosenCategory ? '✓ Catégorie confirmée — modifier' : '? Devinette incertaine — préciser'}
                      </Text>
                    </Pressable>
                  ) : null}
                </View>
                {(defaults?.supplierSiren ?? data.supplierSiren) ? (
                  <Row label="SIREN" value={(defaults?.supplierSiren ?? data.supplierSiren)!} colors={colors} />
                ) : null}
                {/* Destination chantier choisie : la dépense naîtra imputée (ligne honnête,
                    même préséance visuelle que la mémoire fournisseur). */}
                {expenseChantier !== null ? (
                  <View>
                    <Row
                      label={t('scan.expenseChantierLabel', { personality })}
                      value={expenseChantier.name}
                      colors={colors}
                    />
                    <Text style={[font('meta'), { color: semantic.ai, marginTop: 2, textAlign: 'right' }]}>
                      ✨ {t('scan.expenseChantierNote', { personality })}
                    </Text>
                  </View>
                ) : null}
                {data.suggestedTags.length > 0 ? (
                  <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 6, marginTop: 4 }}>
                    {data.suggestedTags.map((tag) => (
                      <Badge key={tag} label={`#${tag}`} tone="ai" />
                    ))}
                  </View>
                ) : null}
              </View>
              {/* Statut payé/à payer proposé (ticket = preuve de paiement ≠ facture à régler).
                  Corrigeable d'un tap — même affordance que la réponse vocale « c'est déjà
                  payé » / « c'est à payer ». */}
              <View
                style={{
                  marginTop: 14,
                  paddingTop: 12,
                  borderTopWidth: 1,
                  borderTopColor: colors.lineSoft,
                  gap: 8,
                }}
              >
                <Text style={[font('label'), { color: colors.slate400, fontSize: 12, fontWeight: '700' }]}>
                  {t('scan.settlementLabel', { personality }).toUpperCase()}
                </Text>
                <View style={{ flexDirection: 'row', gap: 8 }}>
                  <ChoiceChip
                    label={t('scan.settlementPaid', { personality })}
                    accessibilityLabel="C’est déjà payé"
                    selected={effectiveSettlement === 'paid'}
                    onPress={() => {
                      setSettlementChoice('paid');
                      setSettlementError(false);
                    }}
                    colors={colors}
                    semantic={semantic}
                  />
                  <ChoiceChip
                    label={t('scan.settlementToPay', { personality })}
                    accessibilityLabel="C’est à payer"
                    selected={effectiveSettlement === 'to_pay'}
                    onPress={() => {
                      setSettlementChoice('to_pay');
                      setSettlementError(false);
                    }}
                    colors={colors}
                    semantic={semantic}
                  />
                </View>
                {effectiveSettlement === 'paid' ? (
                  <>
                    <Text style={[font('meta'), { color: semantic.success, lineHeight: 17 }]}>
                      {t('scan.settlementPaidDetail', {
                        personality,
                        params: { date: displayDate(data.documentDate) },
                      })}
                    </Text>
                    <View style={{ flexDirection: 'row', alignItems: 'center', flexWrap: 'wrap', gap: 8 }}>
                      <Text style={[font('meta'), { color: colors.slate400 }]}>
                        {t('scan.settlementMethodLabel', { personality })}
                      </Text>
                      {(['card', 'transfer', 'cash'] as const).map((method) => (
                        <ChoiceChip
                          key={method}
                          compact
                          label={t(
                            method === 'card'
                              ? 'dep.paymentMethodCard'
                              : method === 'transfer'
                                ? 'dep.paymentMethodTransfer'
                                : 'dep.paymentMethodCash',
                            { personality },
                          )}
                          selected={effectiveMethod === method}
                          onPress={() => setSettlementMethod(method)}
                          colors={colors}
                          semantic={semantic}
                        />
                      ))}
                    </View>
                    {settlementProposal?.methodSeen && settlementMethod === null ? (
                      <Text style={[font('meta'), { color: semantic.ai }]}>
                        ✨ {t('scan.settlementMethodSeen', { personality })}
                      </Text>
                    ) : null}
                  </>
                ) : effectiveSettlement === 'to_pay' ? (
                  <>
                    <Text style={[font('meta'), { color: colors.slate500, lineHeight: 17 }]}>
                      {t('scan.settlementToPayDetail', { personality })}
                    </Text>
                    {settlementProposal?.dueAt ? (
                      <Row
                        label={t('scan.settlementDueDate', { personality })}
                        value={displayDate(settlementProposal.dueAt)}
                        colors={colors}
                      />
                    ) : null}
                  </>
                ) : null}
                {settlementError ? (
                  <Text accessibilityRole="alert" style={[font('sub'), { color: semantic.warning, lineHeight: 19 }]}>
                    {t('scan.settlementRequired', { personality })}
                  </Text>
                ) : null}
              </View>
            </Card>
            {recordResolution?.kind === 'unresolved' ? (
              <Card>
                <Text accessibilityRole="alert" style={[font('cardTitle'), { color: semantic.warning }]}>Résultat encore incertain</Text>
                <Text style={[font('sub'), { color: colors.slate500, marginTop: 4, lineHeight: 19 }]}>
                  Deux réponses réseau ont manqué. Bob n’invente pas le résultat et ne change pas la révision : « Vérifier la même commande » rejoue uniquement la validation d’origine pour retrouver un éventuel commit.
                </Text>
              </Card>
            ) : null}
            {recordResolution?.kind === 'stale' ? (
              <Card>
                <Text accessibilityRole="alert" style={[font('cardTitle'), { color: semantic.warning }]}>Le document a changé</Text>
                {recordResolution.current ? (
                  <View style={{ marginTop: 7, gap: 5 }}>
                    <Text style={[font('sub'), { color: colors.slate500, lineHeight: 19 }]}>La validation visait la version {recordResolution.command.expectedRevision}, mais le coffre affiche maintenant la version {recordResolution.current.revision}. Bob n’a exécuté aucune nouvelle action avec cette version.</Text>
                    <Row
                      label="Dossier demandé"
                      value={(rootFolders.data ?? []).find((folder) => folder.id === recordResolution.command.targetFolderId)?.name ?? recordResolution.command.targetFolderId}
                      colors={colors}
                    />
                    <Row
                      label="Dossier actuel"
                      value={recordResolution.current.folderId === null
                        ? 'À classer'
                        : (rootFolders.data ?? []).find((folder) => folder.id === recordResolution.current?.folderId)?.name ?? recordResolution.current.folderId}
                      colors={colors}
                    />
                    {recordResolution.current.linkedEntityId ? (
                      <Text style={[font('meta'), { color: semantic.warning, lineHeight: 17 }]}>Ce document est désormais lié à une autre entité. Ouvre son détail pour décider, sans créer de seconde dépense.</Text>
                    ) : (
                      <Text style={[font('meta'), { color: semantic.ai, lineHeight: 17 }]}>Relis cet état. Le prochain bouton constitue une nouvelle confirmation explicite avec la version {recordResolution.current.revision}.</Text>
                    )}
                  </View>
                ) : (
                  <Text style={[font('sub'), { color: colors.slate500, marginTop: 4, lineHeight: 19 }]}>Le conflit est certain, mais l’état actuel n’a pas pu être rechargé. « Recharger l’état » ne déclenche aucune écriture.</Text>
                )}
              </Card>
            ) : null}
            {recordResolution?.kind === 'rejected' ? (
              <Card>
                <Text accessibilityRole="alert" style={[font('cardTitle'), { color: semantic.danger }]}>Validation refusée</Text>
                <Text style={[font('sub'), { color: colors.slate500, marginTop: 4, lineHeight: 19 }]}>Le serveur a répondu de façon définitive : aucune reprise automatique n’a été lancée. Ouvre le document pour vérifier son état avant de décider de la suite.</Text>
              </Card>
            ) : null}
            {recordTargetError ? (
              <Text accessibilityRole="alert" style={[font('sub'), { color: semantic.warning }]}>
                Choisis d’abord où conserver l’original. Bob ne le classera pas sans ton accord.
              </Text>
            ) : null}
            <Button
              title={record.isPending
                ? 'Validation atomique…'
                : reconcilePending
                  ? 'Vérification du résultat…'
                : linkedExpenseId
                  ? 'Dépense créée'
                  : recordResolution?.kind === 'unresolved'
                    ? 'Vérifier la même commande'
                  : recordResolution?.kind === 'stale' && recordResolution.current === null
                    ? 'Recharger l’état'
                  : recordResolution?.kind === 'stale'
                    && recordResolution.current !== null
                    && recordResolution.current.linkedEntityId !== null
                    ? 'Voir le document actuel'
                  : recordResolution?.kind === 'rejected'
                    ? 'Voir le document et corriger'
                  : supplierDefaultsState.kind === 'loading'
                    ? 'Vérification du fournisseur…'
                  : supplierDefaultsState.kind === 'unavailable'
                    ? 'Mémoire fournisseur indisponible'
                  : recordResolution?.kind === 'stale' && recordResolution.current !== null
                    ? `Confirmer avec la version ${recordResolution.current.revision}`
                  : archivedDocument?.folderId
                    ? 'Créer la dépense et lier l’original'
                    : 'Choisir un dossier avant de créer'}
              disabled={
                record.isPending
                || reconcilePending
                || (
                  recordActionRequiresSupplierDefaults
                  && supplierDefaultsState.kind !== 'ready'
                )
                || archivedDocument === null
                || linkedExpenseId !== null
              }
              onPress={recordExpenseFromDocument}
            />
          </>
        ) : null}
      </View>

      {/* ASK-3 : la question de catégorie — mêmes modales que l'assistant (QuestionSheet).
          La visibilité est arbitrée par la machine : au plus UNE sheet, catégorie d'abord. */}
      <QuestionSheet
        visible={visibleSheet === 'category'}
        header={clarification?.header ?? ''}
        question={clarification?.question ?? ''}
        options={clarification?.options ?? []}
        confirmLabel="Valider"
        otherLabel={`Garder « ${CATEGORY_LABEL[defaults?.category ?? 'autre']} »`}
        onClose={() => setCategoryDismissed(true)}
        onSelect={(values) => {
          const picked = values[0] as ExpenseCategory | undefined;
          if (picked) setChosenCategory(picked);
          setCategoryDismissed(true);
        }}
        onOther={() => setCategoryDismissed(true)}
        onDidClose={() => dispatchDecision({ type: 'sheet-closed', sheet: 'category' })}
      />

      {/* Statut ambigu (extraction sans discriminant fiable) : Bob DEMANDE au lieu de deviner
          — « ticket déjà payé » ou « facture à régler », les deux réponses vocales naturelles.
          La machine la présente APRÈS la catégorie, jamais en même temps. */}
      <QuestionSheet
        visible={visibleSheet === 'settlement'}
        header={t('scan.settlementQuestionHeader', { personality })}
        question={t('scan.settlementQuestion', { personality })}
        options={[
          {
            value: 'paid',
            label: t('scan.settlementOptionTicket', { personality }),
            description: t('scan.settlementOptionTicketDesc', { personality }),
          },
          {
            value: 'to_pay',
            label: t('scan.settlementOptionInvoice', { personality }),
            description: t('scan.settlementOptionInvoiceDesc', { personality }),
          },
        ]}
        confirmLabel={t('scan.settlementConfirm', { personality })}
        otherLabel={t('scan.settlementLater', { personality })}
        onClose={() => setSettlementDismissed(true)}
        onSelect={(values) => {
          const picked = values[0];
          if (picked === 'paid' || picked === 'to_pay') {
            setSettlementChoice(picked);
            setSettlementError(false);
          }
          setSettlementDismissed(true);
        }}
        onOther={() => setSettlementDismissed(true)}
        onDidClose={() => dispatchDecision({ type: 'sheet-closed', sheet: 'settlement' })}
      />

      {/* Rangement — JAMAIS auto-ouverte : la machine ne la présente que sur geste humain
          (« Choisir un autre dossier », reprise, re-demande avant dépense). Choix unique
          CONFIRMÉ (confirmSingle) : sélection surlignée + bouton « Classer », plus aucun
          classement au tap sec. */}
      <QuestionSheet
        visible={visibleSheet === 'filing'}
        header="Rangement proposé par Bob"
        question={suggestedChantierId !== null && suggestedDestination
          // Préséance : la destination chantier VALIDÉE par le core porte seule la proposition.
          ? t('scan.filingQuestionChantier', { personality, params: { label: suggestedDestination.label } })
          : suggestedFolder
            ? `Je te propose « ${suggestedFolder.name} ». Où veux-tu conserver l’original ?`
            : suggestedNewFolderName
              ? `Aucun dossier ne correspond encore. Je te propose de créer « ${suggestedNewFolderName} ». Que préfères-tu ?`
              : 'Je ne veux pas deviner son dossier. Où veux-tu conserver l’original ?'}
        options={filingOptions}
        confirmSingle
        confirmLabel={t('scan.filingConfirm', { personality })}
        otherLabel="Plus tard — laisser dans À classer"
        onClose={() => dispatchDecision({ type: 'filing-deferred' })}
        onSelect={(values) => {
          const value = values[0];
          // La feuille se ferme d'abord (invite relâchée), puis le geste choisi s'exécute.
          dispatchDecision({ type: 'filing-selected' });
          if (value === CREATE_FOLDER_OPTION) openFolderEditor();
          else if (value?.startsWith(CHANTIER_OPTION_PREFIX)) classifyToChantier(value.slice(CHANTIER_OPTION_PREFIX.length));
          else if (value) classifyInFolder(value);
        }}
        onOther={() => dispatchDecision({ type: 'filing-deferred' })}
        onDidClose={() => dispatchDecision({ type: 'sheet-closed', sheet: 'filing' })}
      />

      <Sheet
        visible={visibleSheet === 'folderEditor'}
        onClose={() => {
          if (createFolder.isPending) return;
          setFolderError(null);
          dispatchDecision({ type: 'folder-editor-deferred' });
        }}
        onDidClose={() => dispatchDecision({ type: 'sheet-closed', sheet: 'folderEditor' })}
      >
        <KeyboardAvoidingView {...(process.env.EXPO_OS === 'ios' ? { behavior: 'padding' as const } : {})}>
          <Text accessibilityRole="header" style={[font('pageTitle'), { fontSize: 20, color: colors.ink900 }]}>Créer le dossier proposé</Text>
          <Text style={[font('sub'), { color: colors.slate500, lineHeight: 19, marginTop: 5 }]}>Bob classera uniquement cet original après la création. Tu gardes le dernier mot sur le nom et le rangement.</Text>
          <Text style={[font('label'), { color: colors.slate400, fontSize: 12, fontWeight: '700', marginTop: 16 }]}>NOM DU DOSSIER</Text>
          <TextInput
            autoFocus
            value={folderName}
            onChangeText={(value) => {
              setFolderName(value);
              setFolderError(null);
            }}
            maxLength={80}
            autoCapitalize="sentences"
            autoCorrect
            returnKeyType="done"
            onSubmitEditing={createAndClassifyFolder}
            accessibilityLabel="Nom du nouveau dossier"
            accessibilityHint="80 caractères maximum. Les barres obliques sont interdites."
            placeholder="Ex. Contrats clients"
            placeholderTextColor={colors.slate400}
            style={[
              font('body'),
              {
                minHeight: 46,
                marginTop: 7,
                borderWidth: 1,
                borderColor: folderError ? semantic.danger : colors.lineSoft,
                borderRadius: 12,
                paddingVertical: 11,
                paddingHorizontal: 13,
                color: colors.ink800,
              },
            ]}
          />
          <Text style={[font('meta'), { color: colors.slate400, textAlign: 'right', marginTop: 4 }]}>{folderName.length}/80</Text>
          {folderError ? (
            <Text accessibilityRole="alert" style={[font('sub'), { color: semantic.danger, lineHeight: 19, marginTop: 8 }]}>{folderError}</Text>
          ) : null}
          <View style={{ flexDirection: 'row', gap: 10, marginTop: 16 }}>
            <View style={{ flex: 1 }}>
              <Button
                title="Plus tard"
                variant="secondary"
                disabled={createFolder.isPending}
                onPress={() => {
                  setFolderError(null);
                  dispatchDecision({ type: 'folder-editor-deferred' });
                }}
              />
            </View>
            <View style={{ flex: 1 }}>
              <Button
                title="Créer et classer"
                variant="ai"
                disabled={!validateDocumentFolderName(folderName).ok}
                loading={createFolder.isPending}
                onPress={createAndClassifyFolder}
              />
            </View>
          </View>
        </KeyboardAvoidingView>
      </Sheet>
    </ScrollView>
  );
}

function displayDate(iso: string): string {
  const [y, m, d] = iso.slice(0, 10).split('-');
  return d && m && y ? `${d}/${m}/${y}` : iso.slice(0, 10);
}

/**
 * « Je lis ton document… » (handoff §SCAN OVERLAY) : miniature papier squelette 120×154 +
 * LIGNE DE SCAN indigo (glow) en aller-retour + spinner. Reduced-motion : la ligne reste
 * au centre et bat doucement en opacité (resolveScanReadingMotion — logique pure testée).
 */
function ScanReadingCard() {
  const { colors, semantic, personality } = useTheme();
  const reduceMotion = useReduceMotion();
  const progress = useRef(new Animated.Value(0)).current;

  useEffect(() => {
    const readingMotion = resolveScanReadingMotion(reduceMotion);
    progress.setValue(0);
    const sweep = Animated.loop(
      Animated.sequence([
        Animated.timing(progress, {
          toValue: 1,
          duration: readingMotion.durationMs,
          easing: Easing.inOut(Easing.ease),
          useNativeDriver: true,
        }),
        Animated.timing(progress, {
          toValue: 0,
          duration: readingMotion.durationMs,
          easing: Easing.inOut(Easing.ease),
          useNativeDriver: true,
        }),
      ]),
    );
    sweep.start();
    return () => sweep.stop();
  }, [progress, reduceMotion]);

  const mode = resolveScanReadingMotion(reduceMotion).mode;
  const midTravel = (SCAN_LINE_TRAVEL_TOP + SCAN_LINE_TRAVEL_BOTTOM) / 2;
  const translateY = mode === 'sweep'
    ? progress.interpolate({ inputRange: [0, 1], outputRange: [SCAN_LINE_TRAVEL_TOP, SCAN_LINE_TRAVEL_BOTTOM] })
    : midTravel;
  const lineOpacity = mode === 'pulse'
    ? progress.interpolate({ inputRange: [0, 1], outputRange: [SCAN_PULSE_OPACITY_MIN, SCAN_PULSE_OPACITY_MAX] })
    : 1;

  return (
    <Card>
      <View
        accessibilityRole="progressbar"
        accessibilityLiveRegion="polite"
        accessibilityLabel={t('scan.reading', { personality })}
        style={{ alignItems: 'center', paddingVertical: 6 }}
      >
        <View
          style={{
            width: 120,
            height: 154,
            borderRadius: 12,
            borderWidth: 1,
            borderColor: vault.readerBorder,
            overflow: 'hidden',
          }}
        >
          <LinearGradient
            colors={[colors.surface, vault.thumbTop]}
            start={{ x: 0.2, y: 0 }}
            end={{ x: 0.8, y: 1 }}
            style={{ flex: 1, paddingVertical: 14, paddingHorizontal: 12 }}
          >
            <View style={{ height: 8, width: '60%', backgroundColor: vault.readerLineTitle, borderRadius: 3, marginBottom: 9 }} />
            <View style={{ height: 6, width: '90%', backgroundColor: vault.readerLineBody, borderRadius: 3, marginBottom: 6 }} />
            <View style={{ height: 6, width: '80%', backgroundColor: vault.readerLineBody, borderRadius: 3, marginBottom: 6 }} />
            <View style={{ height: 6, width: '88%', backgroundColor: vault.readerLineBody, borderRadius: 3, marginBottom: 6 }} />
            <View style={{ height: 6, width: '50%', backgroundColor: vault.readerLineBody, borderRadius: 3 }} />
          </LinearGradient>
          <Animated.View
            style={{
              position: 'absolute',
              left: '6%',
              right: '6%',
              top: 0,
              height: 3,
              borderRadius: 3,
              backgroundColor: semantic.ai,
              opacity: lineOpacity,
              transform: [{ translateY }],
              shadowColor: vault.scanLineGlow,
              shadowOpacity: 1,
              shadowRadius: 10,
              shadowOffset: { width: 0, height: 0 },
              elevation: 4,
            }}
          />
        </View>
        <View style={{ flexDirection: 'row', alignItems: 'center', gap: 9, marginTop: 20 }}>
          <ActivityIndicator color={semantic.ai} />
          <Text style={[font('body'), { fontWeight: '600', fontSize: 15, color: colors.ink800 }]}>
            {t('scan.reading', { personality })}
          </Text>
        </View>
      </View>
    </Card>
  );
}

/** Chip de choix binaire/multiple (statut payé·à payer, moyen de règlement) — zéro hex. */
function ChoiceChip({
  label,
  selected,
  onPress,
  colors,
  semantic,
  compact,
  accessibilityLabel,
}: {
  label: string;
  selected: boolean;
  onPress: () => void;
  colors: ReturnType<typeof useTheme>['colors'];
  semantic: ReturnType<typeof useTheme>['semantic'];
  compact?: boolean;
  accessibilityLabel?: string;
}) {
  return (
    <Pressable
      accessibilityRole="radio"
      accessibilityState={{ checked: selected }}
      accessibilityLabel={accessibilityLabel ?? label}
      onPress={onPress}
      // Densité visuelle 34pt conservée, zone TACTILE portée à 44pt (34 + 2×5 de hitSlop).
      hitSlop={compact ? { top: 5, bottom: 5 } : undefined}
      style={({ pressed }) => ({
        minHeight: compact ? 34 : 44,
        justifyContent: 'center',
        borderWidth: 1.5,
        borderColor: selected ? semantic.success : colors.lineSoft,
        backgroundColor: selected ? colors.surface : 'transparent',
        borderRadius: 12,
        paddingHorizontal: compact ? 12 : 16,
        paddingVertical: compact ? 6 : 10,
        opacity: pressed ? 0.85 : 1,
      })}
    >
      <Text
        style={[
          font('sub'),
          {
            color: selected ? colors.ink900 : colors.slate500,
            fontWeight: selected ? '700' : '500',
          },
        ]}
      >
        {label}
      </Text>
    </Pressable>
  );
}

function Row({
  label,
  value,
  colors,
  strong,
}: {
  label: string;
  value: string;
  colors: ReturnType<typeof useTheme>['colors'];
  strong?: boolean;
}) {
  return (
    <View style={{ flexDirection: 'row', justifyContent: 'space-between' }}>
      <Text style={[font('sub'), { color: colors.slate400 }]}>{label}</Text>
      <Text style={[strong ? font('cardTitle') : font('sub'), { color: colors.ink900 }]}>{value}</Text>
    </View>
  );
}
