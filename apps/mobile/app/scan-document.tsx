import { useEffect, useMemo, useRef, useState } from 'react';
import {
  ActivityIndicator,
  KeyboardAvoidingView,
  Pressable,
  ScrollView,
  Text,
  TextInput,
  View,
} from 'react-native';
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
import { InMemoryCompanyMemory, suggestCategoryClarification, suggestExpenseDefaults } from '@bob/ai';
import { ErrorRetry, QuestionSheet, Sheet, Skeleton } from '@bob/ui';
import type { ExpenseCategory } from '@bob/core';
import { useTheme } from '../src/theme';
import { useQueryClient } from '@tanstack/react-query';
import { useExtractDocument, useExpenses } from '../src/data/hooks';
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
import { usePublishAgentContext, type AgentContext } from '../src/agent';
import { Card, Button, Badge, SectionHeader, font } from '../src/components/ui';

const DOCUMENT_MAX_BYTES = 10 * 1024 * 1024;
const LOCAL_FILE_READ_TIMEOUT_MS = 20_000;
const CREATE_FOLDER_OPTION = '__create_folder__';
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

const DOCUMENT_TYPE_LABEL: Record<DocumentAnalysis['type'], string> = {
  supplier_invoice: 'Facture fournisseur',
  receipt: 'Ticket ou reçu',
  bank_statement: 'Relevé bancaire',
  insurance_certificate: 'Attestation d’assurance',
  tax_or_social_document: 'Document fiscal ou social',
  contract: 'Contrat',
  company_record: 'Document de société',
  chantier_photo: 'Photo de chantier',
  accounting_document: 'Document comptable',
  other: 'Document à préciser',
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
  const { colors, semantic } = useTheme();
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
  const expenses = useExpenses();
  const client = useBobClient();
  const queryClient = useQueryClient();
  const mountedRef = useRef(true);
  // Copie de travail pour rejouer l'analyse. L'original est archivé côté serveur AVANT l'OCR.
  const photoRef = useRef<{ contentBase64: string; mimeType: string } | null>(null);
  const intakeInputRef = useRef<CreateDocumentIntakeClientInput | null>(null);
  const [archivedDocument, setArchivedDocument] = useState<DocumentView | null>(null);
  const [filingPromptDocumentId, setFilingPromptDocumentId] = useState<string | null>(null);
  const [filingDeferred, setFilingDeferred] = useState(false);
  const [folderEditorOpen, setFolderEditorOpen] = useState(false);
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
  const data = extract.data;

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
      capabilities: ['screen.read', 'document.read'],
    }),
    [archivedDocument],
  );
  usePublishAgentContext(agentContext, { bottomAvoidance: 24 });

  const suggestedFolderName = useMemo(() => {
    const result = analysis.data;
    if (!result) return null;
    return result.suggestedSystemFolder
      ? SYSTEM_FOLDER_NAME[result.suggestedSystemFolder]
      : (CUSTOM_FOLDER_NAME[result.type] ?? null);
  }, [analysis.data]);

  const suggestedFolder = useMemo(() => {
    const systemKey = analysis.data?.suggestedSystemFolder;
    const folders = rootFolders.data ?? [];
    if (systemKey) {
      const systemFolder = folders.find((folder) => folder.systemKey === systemKey);
      if (systemFolder) return systemFolder;
    }
    if (!suggestedFolderName) return null;
    const normalized = normalizeDocumentFolderName(suggestedFolderName);
    return folders.find((folder) => folder.normalizedName === normalized) ?? null;
  }, [analysis.data?.suggestedSystemFolder, rootFolders.data, suggestedFolderName]);

  const suggestedNewFolderName = suggestedFolder === null ? suggestedFolderName : null;

  const currentFolder = useMemo(
    () => (rootFolders.data ?? []).find((folder) => folder.id === archivedDocument?.folderId) ?? null,
    [archivedDocument?.folderId, rootFolders.data],
  );

  const archivedMimeType = archivedDocument
    ? normalizedArchiveMimeType(archivedDocument.mimeType, archivedDocument.filename)
    : null;
  const analysisUnavailable = archivedDocument !== null
    && (archivedMimeType === null || !supportsDocumentAnalysis(archivedMimeType));

  const filingOptions = useMemo(() => {
    const folders = rootFolders.data ?? [];
    const ordered = suggestedFolder
      ? [suggestedFolder, ...folders.filter((folder) => folder.id !== suggestedFolder.id)]
      : folders;
    const existing = ordered.map((folder) => ({
      value: folder.id,
      label: suggestedFolder?.id === folder.id ? `Recommandé · ${folder.name}` : folder.name,
      description: suggestedFolder?.id === folder.id
        ? 'Bob propose ce rangement à partir du contenu réellement lu.'
        : 'Classer l’original dans ce dossier.',
    }));
    return [
      ...existing,
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
  }, [rootFolders.data, suggestedFolder, suggestedNewFolderName]);

  useEffect(() => {
    if (
      !analysis.data
      || filingDeferred
      || rootFolders.isLoading
      || rootFolders.isError
      || filingRecoveryPending
      || filingPromptDocumentId === analysis.data.documentId
    ) return;
    setFilingPromptDocumentId(analysis.data.documentId);
  }, [analysis.data, filingDeferred, filingPromptDocumentId, filingRecoveryPending, rootFolders.isError, rootFolders.isLoading]);

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
    setArchivedDocument(null);
    setFilingPromptDocumentId(null);
    setFilingDeferred(false);
    setFolderEditorOpen(false);
    setFolderName('');
    setFolderError(null);
    setFilingRecoveryPending(false);
    setLinkedExpenseId(null);
    setRecordTargetError(false);
    setReconcilePending(false);
    setRecordResolution(null);
    setChosenCategory(null);
    setCategoryDismissed(false);
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

  // Mémoire d'entreprise dérivée de l'historique réel des dépenses (fournisseurs déjà classés).
  const memory = useMemo(
    () =>
      new InMemoryCompanyMemory(
        (expenses.data ?? []).map((e) => ({
          name: e.supplierName,
          siren: e.supplierSiren,
          category: e.category,
          vatRatePct: e.vatRatePct,
        })),
      ),
    [expenses.data],
  );
  // Défauts proposés : la mémoire fait primer TA catégorie habituelle sur la devinette OCR (sinon fallback OCR).
  const defaults = data ? suggestExpenseDefaults(memory, data) : null;

  // ASK-3 : catégorie ambiguë (devinette OCR hésitante ou « autre », jamais sur une habitude
  // fournisseur) — question structurée AVANT l'enregistrement ; le choix nourrit la mémoire.
  const [chosenCategory, setChosenCategory] = useState<ExpenseCategory | null>(null);
  const [categoryDismissed, setCategoryDismissed] = useState(false);
  const clarification = data && defaults ? suggestCategoryClarification(defaults, data) : null;
  const askCategory = clarification !== null && chosenCategory === null && !categoryDismissed;
  const category: ExpenseCategory = chosenCategory ?? defaults?.category ?? (data?.categoryGuess ?? 'autre');

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
    if (!document || !data || record.isPending) return;
    // Le choix « Plus tard — laisser dans À classer » reste respecté : créer une dépense ne
    // déclenche jamais un rangement silencieux. On redemande explicitement le dossier.
    if (document.folderId === null) {
      setRecordTargetError(true);
      setFilingDeferred(false);
      setFilingPromptDocumentId(document.id);
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
        supplierSiren: defaults?.supplierSiren ?? data.supplierSiren,
        documentDate: data.documentDate,
        totalTtcCents: data.totalTtcCents,
        totalHtCents: data.totalHtCents,
        vatCents: data.vatCents,
        vatRatePct: defaults?.vatRatePct ?? data.vatRatePctApplied,
        category,
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
    if (!archivedDocument) return;
    setFilingPromptDocumentId(null);
    moveDocument.mutate(
      { documentId: archivedDocument.id, folderId, expectedRevision: archivedDocument.revision },
      {
        onSuccess: (moved) => {
          setRecordTargetError(false);
          setArchivedDocument((current) =>
            current?.id === moved.documentId
              ? { ...current, folderId: moved.folderId, revision: moved.revision }
              : current);
        },
        onError: () => setFilingPromptDocumentId(archivedDocument.id),
      },
    );
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
      setFilingDeferred(false);
      setFilingPromptDocumentId(freshDocument.value.id);
    } finally {
      if (mountedRef.current) setFilingRecoveryPending(false);
    }
  }

  function openFolderEditor(): void {
    setFilingPromptDocumentId(null);
    setFolderName(suggestedNewFolderName ?? '');
    setFolderError(null);
    setFolderEditorOpen(true);
  }

  function createAndClassifyFolder(): void {
    if (!archivedDocument || createFolder.isPending) return;
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
          setFolderEditorOpen(false);
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
    || reconcilePending;
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
    <ScrollView style={{ flex: 1, backgroundColor: colors.bg }} contentContainerStyle={{ paddingBottom: 40 }}>
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
                rootFolders.isLoading ? (
                  <View accessibilityRole="progressbar" accessibilityLiveRegion="polite" accessibilityLabel="Chargement des dossiers">
                    <Skeleton height={52} radius={18} />
                  </View>
                ) : rootFolders.isError ? (
                  <View>
                    <Text accessibilityRole="alert" style={[font('sub'), { color: semantic.danger, lineHeight: 19 }]}>Les dossiers ne sont pas disponibles. L’original reste conservé dans « À classer ».</Text>
                    <View style={{ marginTop: 10 }}>
                      <Button title="Réessayer de charger les dossiers" variant="secondary" onPress={() => void rootFolders.refetch()} />
                    </View>
                  </View>
                ) : (
                  <Button
                    title="Choisir un dossier sans analyse"
                    variant="secondary"
                    onPress={() => {
                      setFilingDeferred(false);
                      setFilingPromptDocumentId(archivedDocument.id);
                    }}
                  />
                )
              ) : null}
              <Button
                title="Voir l’original"
                variant="secondary"
                onPress={() => router.push({ pathname: '/documents/[id]', params: { id: archivedDocument.id } })}
              />
            </View>
          </Card>
        ) : null}

        {analysis.isPending ? (
          <Card>
            <View accessibilityRole="progressbar" accessibilityLiveRegion="polite" accessibilityLabel="Bob lit le document et vérifie ses preuves" style={{ flexDirection: 'row', alignItems: 'center', gap: 10 }}>
              <ActivityIndicator color={semantic.ai} />
              <Text style={[font('body'), { color: colors.ink800, flex: 1 }]}>Bob lit le document et vérifie ses preuves…</Text>
            </View>
          </Card>
        ) : null}

        {analysis.data ? (
          <>
            <SectionHeader title="Ce que Bob a compris" />
            <Card>
              <View style={{ flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: 10 }}>
                <Text style={[font('cardTitle'), { color: colors.ink900, flex: 1 }]}>{DOCUMENT_TYPE_LABEL[analysis.data.type]}</Text>
                <Badge
                  label={`${Math.round(analysis.data.typeConfidence * 100)} %`}
                  tone={analysis.data.requiresHumanReview ? 'warning' : 'success'}
                />
              </View>
              <Text style={[font('body'), { color: colors.slate500, lineHeight: 21, marginTop: 8 }]}>{analysis.data.summary}</Text>
              {analysis.data.suggestedTags.length > 0 ? (
                <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 6, marginTop: 12 }}>
                  {analysis.data.suggestedTags.map((tag) => <Badge key={tag} label={`#${tag}`} tone="ai" />)}
                </View>
              ) : null}
              {analysis.data.warnings.map((warning) => (
                <Text key={warning} style={[font('meta'), { color: semantic.warning, marginTop: 9 }]}>• {warning}</Text>
              ))}
              <View style={{ marginTop: 14, gap: 8 }}>
                {currentFolder ? (
                  <View style={{ flexDirection: 'row', alignItems: 'center', gap: 7 }}>
                    <Ionicons name="folder" size={17} color={semantic.success} />
                    <Text style={[font('sub'), { color: colors.ink800, flex: 1 }]}>Classé dans « {currentFolder.name} »</Text>
                  </View>
                ) : rootFolders.isLoading ? (
                  <View accessibilityRole="progressbar" accessibilityLiveRegion="polite" accessibilityLabel="Chargement des dossiers">
                    <Skeleton height={52} radius={18} />
                  </View>
                ) : rootFolders.isError ? (
                  <View>
                    <Text accessibilityRole="alert" style={[font('sub'), { color: semantic.danger, lineHeight: 19 }]}>Les dossiers ne sont pas disponibles. Bob ne proposera aucun rangement tant qu’ils ne sont pas rechargés.</Text>
                    <View style={{ marginTop: 10 }}>
                      <Button title="Réessayer de charger les dossiers" variant="secondary" onPress={() => void rootFolders.refetch()} />
                    </View>
                  </View>
                ) : (
                  <Button
                    title={suggestedFolder ? `Classer dans « ${suggestedFolder.name} »` : 'Choisir un dossier'}
                    variant="ai"
                    onPress={() => {
                      setFilingDeferred(false);
                      setFilingPromptDocumentId(analysis.data.documentId);
                    }}
                  />
                )}
                <Button
                  title="Voir l’original et les preuves"
                  variant="secondary"
                  onPress={() => router.push({ pathname: '/documents/[id]', params: { id: analysis.data.documentId } })}
                />
              </View>
            </Card>
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

        {extract.isPending ? (
          <Card>
            <View accessibilityRole="progressbar" accessibilityLiveRegion="polite" accessibilityLabel="Lecture comptable du document" style={{ flexDirection: 'row', alignItems: 'center', gap: 10 }}>
              <ActivityIndicator color={colors.ink800} />
              <Text style={[font('body'), { color: colors.ink800 }]}>Lecture du document…</Text>
            </View>
          </Card>
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

        {data ? (
          <>
            <SectionHeader title="Extraction" />
            <Card>
              <View style={{ flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center' }}>
                <Text style={[font('cardTitle'), { color: colors.ink900 }]}>{data.supplierName}</Text>
                <Badge label={`${Math.round(data.confidence * 100)} %`} tone={data.confidence >= 0.85 ? 'success' : 'warning'} />
              </View>
              <View style={{ marginTop: 10, gap: 6 }}>
                <Row label="Date" value={data.documentDate} colors={colors} />
                <Row label="Total TTC" value={formatEUR(data.totalTtcCents)} colors={colors} strong />
                {data.vatCents !== null ? <Row label="TVA" value={formatEUR(data.vatCents)} colors={colors} /> : null}
                {(defaults?.vatRatePct ?? data.vatRatePctApplied) !== null ? (
                  <Row label="Taux TVA" value={`${defaults?.vatRatePct ?? data.vatRatePctApplied} %`} colors={colors} />
                ) : null}
                <View>
                  <Row label="Catégorie" value={CATEGORY_LABEL[category] ?? category} colors={colors} />
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
                {data.suggestedTags.length > 0 ? (
                  <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 6, marginTop: 4 }}>
                    {data.suggestedTags.map((tag) => (
                      <Badge key={tag} label={`#${tag}`} tone="ai" />
                    ))}
                  </View>
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
                  : recordResolution?.kind === 'stale' && recordResolution.current !== null
                    ? `Confirmer avec la version ${recordResolution.current.revision}`
                  : recordResolution?.kind === 'rejected'
                    ? 'Voir le document et corriger'
                  : archivedDocument?.folderId
                    ? 'Créer la dépense et lier l’original'
                    : 'Choisir un dossier avant de créer'}
              disabled={record.isPending || reconcilePending || archivedDocument === null || linkedExpenseId !== null}
              onPress={recordExpenseFromDocument}
            />
          </>
        ) : null}
      </View>

      {/* ASK-3 : la question de catégorie — mêmes modales que l'assistant (QuestionSheet). */}
      <QuestionSheet
        visible={askCategory}
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
      />

      <QuestionSheet
        visible={
          filingPromptDocumentId !== null
          && (analysis.data?.documentId ?? archivedDocument?.id) === filingPromptDocumentId
          && !rootFolders.isLoading
          && !rootFolders.isError
          && !filingRecoveryPending
          && filingOptions.length > 0
          && !askCategory
        }
        header="Rangement proposé par Bob"
        question={suggestedFolder
          ? `Je te propose « ${suggestedFolder.name} ». Où veux-tu conserver l’original ?`
          : suggestedNewFolderName
            ? `Aucun dossier ne correspond encore. Je te propose de créer « ${suggestedNewFolderName} ». Que préfères-tu ?`
            : 'Je ne veux pas deviner son dossier. Où veux-tu conserver l’original ?'}
        options={filingOptions}
        confirmLabel="Classer"
        otherLabel="Plus tard — laisser dans À classer"
        onClose={() => {
          setFilingPromptDocumentId(null);
          setFilingDeferred(true);
        }}
        onSelect={(values) => {
          const folderId = values[0];
          if (folderId === CREATE_FOLDER_OPTION) openFolderEditor();
          else if (folderId) classifyInFolder(folderId);
        }}
        onOther={() => {
          setFilingPromptDocumentId(null);
          setFilingDeferred(true);
        }}
      />

      <Sheet
        visible={folderEditorOpen}
        onClose={() => {
          if (createFolder.isPending) return;
          setFolderEditorOpen(false);
          setFolderError(null);
          setFilingDeferred(true);
        }}
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
                  setFolderEditorOpen(false);
                  setFolderError(null);
                  setFilingDeferred(true);
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
