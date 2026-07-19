/**
 * Écran document — « exactement la même chose que ce que tu as mis lors du scan » (fondateur) :
 * · titre = displayName INTELLIGENT (renommage humain > suggestion d'analyse), jamais le
 *   nom de fichier brut ;
 * · la CARTE PARTAGÉE DocumentInsightCard en tête (pastille « Document lu », titre, tableau
 *   Montant TTC / TVA récupérable / Rattaché à, tags, warnings) — source de rendu unique
 *   avec le scan, zéro duplication ;
 * · CTA « Classer dans {label} » (useApplyDestination — mêmes use cases que Bob) si non
 *   classé, état « Classé dans X » sinon, bouton de confirmation (AcknowledgeDocument,
 *   latch idempotent) tant que reviewedAt est null ;
 * · les facts détaillés avec provenance (« Lu · X % ») vivent dans la section Traçabilité
 *   REPLIÉE (accordéon) — plus de bruit en vue principale, la preuve reste accessible ;
 * · GET /documents/:id est ENRICHI (analysis/extraction du cache serveur) : AUCUN POST
 *   /analysis au montage quand le cache est là — le fallback mutation reste si absent ;
 * · Rangement : « Lier à un chantier » (doc SANS lien métier) — affordance MANUELLE du geste
 *   vocal classer_document (même use case ClassifyDocument, parité humain↔Bob) : feuille des
 *   chantiers OUVERTS réels (suggestion d'analyse en tête), confirmation explicite, toast ;
 *   lien déjà posé → état lecture « Chantier · {nom} » (ouvre le chantier, pas de déliaison).
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { Image, Linking, Pressable, RefreshControl, ScrollView, Text, View } from 'react-native';
import { useLocalSearchParams, useRouter } from 'expo-router';
import { Ionicons } from '@expo/vector-icons';
import { documentNeedsHumanReview, type DocumentFolderView, type DocumentView } from '@bob/core';
import { t } from '@bob/i18n';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { usePublishAgentContext, type AgentContext } from '../../src/agent';
import { useBobClient } from '../../src/data/client';
import {
  useAcknowledgeDocument,
  useAnalyzeDocument,
  useDocument,
  useDocumentFolder,
  useDocumentFolders,
  useMoveDocumentToFolder,
  supportsDocumentAnalysis,
} from '../../src/data/documents';
import { DocumentInsightCard } from '../../src/documents/document-insight-card';
import {
  FACT_LABEL,
  deriveDocumentInsight,
  extractionFromAnalysisFacts,
  factValue,
  smartDocumentTitle,
} from '../../src/documents/document-insight-card.logic';
import { useApplyDestination } from '../../src/documents/use-apply-destination';
import { linkChantierOptions, linkedChantierName } from '../../src/documents/link-chantier-options';
import { useChantiers } from '../../src/data/hooks';
import { useTheme } from '../../src/theme';
import { Button, Card, SectionHeader, font } from '../../src/components/ui';
import { ErrorRetry, IconTile, PressableScale, QuestionSheet, Sheet, Skeleton, SkeletonCard, SkeletonRow, Toast } from '@bob/ui';
import { ChevronRightIcon, FolderSmallIcon } from '../../src/components/icons';
import { useBobAwareScrollInsets } from '../../src/components/use-bob-aware-scroll-insets';

function bytesLabel(value: number): string {
  if (value < 1024) return `${value} o`;
  if (value < 1024 * 1024) return `${Math.round(value / 1024)} Ko`;
  return `${(value / (1024 * 1024)).toFixed(1)} Mo`;
}

function isDocumentView(value: unknown): value is DocumentView {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;
  const candidate = value as Partial<DocumentView>;
  return typeof candidate.id === 'string'
    && candidate.id.length > 0
    && typeof candidate.filename === 'string'
    && candidate.filename.length > 0
    && typeof candidate.mimeType === 'string'
    && candidate.mimeType.length > 0
    && Number.isSafeInteger(candidate.version)
    && (candidate.version ?? 0) >= 1
    && Number.isSafeInteger(candidate.byteSize)
    && (candidate.byteSize ?? -1) >= 0
    && typeof candidate.retentionUntil === 'string'
    && typeof candidate.sha256 === 'string'
    && /^[a-f0-9]{64}$/.test(candidate.sha256);
}

function validDownload(value: unknown): value is { url: string; expiresInSeconds: number } {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;
  const candidate = value as { url?: unknown; expiresInSeconds?: unknown };
  return typeof candidate.url === 'string'
    && (candidate.url.startsWith('https://') || candidate.url.startsWith('data:'))
    && Number.isSafeInteger(candidate.expiresInSeconds)
    && (candidate.expiresInSeconds as number) >= 60
    && (candidate.expiresInSeconds as number) <= 3_600;
}

export default function DocumentDetailScreen() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const documentId = typeof id === 'string' ? id : '';
  const router = useRouter();
  const insets = useSafeAreaInsets();
  const bobScrollInsets = useBobAwareScrollInsets({ minimumBottom: 80 });
  const { colors, semantic, personality } = useTheme();
  const client = useBobClient();
  const document = useDocument(documentId);
  const analysis = useAnalyzeDocument();
  const acknowledge = useAcknowledgeDocument();
  const moveDocument = useMoveDocumentToFolder();
  const [moveOpen, setMoveOpen] = useState(false);
  const [movePath, setMovePath] = useState<DocumentFolderView[]>([]);
  const moveParentId = movePath.at(-1)?.id ?? null;
  const moveFolders = useDocumentFolders(moveParentId);
  const rootFolders = useDocumentFolders(null);
  const currentFolder = useDocumentFolder(document.data?.folderId ?? '');
  const [selectedFolder, setSelectedFolder] = useState<DocumentFolderView | null>(null);
  const [moveError, setMoveError] = useState<string | null>(null);
  const [moveNotice, setMoveNotice] = useState<string | null>(null);
  const [refreshing, setRefreshing] = useState(false);
  // Accordéon Traçabilité : les preuves détaillées, repliées par défaut (zéro bruit).
  const [factsOpen, setFactsOpen] = useState(false);
  const [confirmNotice, setConfirmNotice] = useState<string | null>(null);
  const [confirmError, setConfirmError] = useState(false);
  const requestedAnalysis = useRef<string | null>(null);
  const [original, setOriginal] = useState<{ url: string; expiresAt: number } | null>(null);
  const [originalError, setOriginalError] = useState(false);
  const [originalLoading, setOriginalLoading] = useState(false);
  const originalRequest = useRef(0);

  // « Classer dans {label} » — hook PARTAGÉ avec le scan (move + classify + nom intelligent +
  // invalidations). Dossier système absent du coffre → choix humain via la feuille Déplacer.
  const applyDest = useApplyDestination({
    foldersReady: rootFolders.data !== undefined,
    rootFolders: rootFolders.data,
    onFilingRequested: () => openMoveSheet(),
  });

  // « Lier à un chantier » — chantiers réels chargés seulement quand le geste (ou l'état
  // lecture « Chantier · {nom} ») peut exister : doc sans lien métier, ou déjà lié chantier.
  const documentLinkedType = document.data?.linkedEntityType ?? null;
  const chantiers = useChantiers(
    document.data !== undefined && (documentLinkedType === null || documentLinkedType === 'chantier'),
  );
  const [linkOpen, setLinkOpen] = useState(false);
  const [linkToast, setLinkToast] = useState<string | null>(null);
  const [linkError, setLinkError] = useState(false);
  const queryClient = useQueryClient();
  // MÊME use case que la voix (classer_document) et le picker A8 : ClassifyDocument
  // linkedEntityType 'chantier' — anti-IDOR et pose de reviewedAt côté core, zéro logique locale.
  const linkChantier = useMutation({
    mutationFn: async (input: {
      documentId: string;
      chantierId: string;
      chantierName: string;
      expectedRevision: number;
    }) => {
      const result = await client.classifyDocument({
        documentId: input.documentId,
        linkedEntityType: 'chantier',
        linkedEntityId: input.chantierId,
        expectedRevision: input.expectedRevision,
      });
      if (!result.ok) throw result.error;
      return { chantierName: input.chantierName };
    },
    onSuccess: (result) => {
      setLinkToast(t('docs.linkChantierToast', { personality, params: { name: result.chantierName } }));
      void queryClient.invalidateQueries({ queryKey: ['documents'] });
      void queryClient.invalidateQueries({ queryKey: ['document', documentId] });
    },
    onError: () => {
      // Conflit de révision ou chantier disparu : données réactualisées, message honnête —
      // rien n'est écrasé (le CAS du use case refuse tout lien sur une version périmée).
      setLinkError(true);
      void document.refetch();
    },
  });

  useEffect(() => {
    const current = document.data;
    if (!current || requestedAnalysis.current === current.id) return;
    // Cache serveur présent (GET /documents/:id enrichi) : AUCUN POST /analysis au montage.
    if (current.analysis) return;
    requestedAnalysis.current = current.id;
    if (supportsDocumentAnalysis(current.mimeType)) analysis.mutate(current.id);
  }, [document.data]);

  const refreshOriginal = useCallback(async (): Promise<string | null> => {
    if (!documentId) return null;
    originalRequest.current += 1;
    const request = originalRequest.current;
    setOriginalLoading(true);
    setOriginalError(false);
    const result = await client.documentDownloadUrl(documentId);
    if (request !== originalRequest.current) return null;
    setOriginalLoading(false);
    if (!result.ok || !validDownload(result.value)) {
      setOriginalError(true);
      return null;
    }
    setOriginal({
      url: result.value.url,
      expiresAt: Date.now() + result.value.expiresInSeconds * 1_000,
    });
    return result.value.url;
  }, [client, documentId]);

  useEffect(() => {
    void refreshOriginal();
    return () => {
      originalRequest.current += 1;
    };
  }, [refreshOriginal]);

  useEffect(() => {
    if (!original) return undefined;
    const delay = Math.max(1_000, original.expiresAt - Date.now() - 30_000);
    const timer = setTimeout(() => void refreshOriginal(), delay);
    return () => clearTimeout(timer);
  }, [original, refreshOriginal]);

  const openOriginal = async (): Promise<void> => {
    const url = !original || original.expiresAt - Date.now() < 15_000
      ? await refreshOriginal()
      : original.url;
    if (!url) return;
    try {
      if (url.startsWith('https://') && !(await Linking.canOpenURL(url))) {
        throw new Error('Aucune application ne peut ouvrir cet original.');
      }
      await Linking.openURL(url);
    } catch {
      setOriginalError(true);
    }
  };

  useEffect(() => {
    if (!moveOpen || selectedFolder !== null || !currentFolder.data) return;
    setSelectedFolder(currentFolder.data);
  }, [currentFolder.data, moveOpen, selectedFolder]);

  const openMoveSheet = (): void => {
    setMovePath([]);
    setSelectedFolder(currentFolder.data ?? null);
    setMoveError(null);
    setMoveOpen(true);
  };

  const closeMoveSheet = (): void => {
    if (moveDocument.isPending) return;
    setMoveOpen(false);
    setMoveError(null);
  };

  const enterFolder = (folder: DocumentFolderView): void => {
    setMovePath((current) => [...current, folder]);
    setMoveError(null);
  };

  const leaveFolder = (): void => {
    setMovePath((current) => current.slice(0, -1));
    setMoveError(null);
  };

  const confirmMove = (): void => {
    const current = document.data;
    if (!isDocumentView(current) || !selectedFolder || selectedFolder.id === current.folderId) return;
    setMoveError(null);
    moveDocument.mutate(
      {
        documentId: current.id,
        folderId: selectedFolder.id,
        expectedRevision: current.revision,
      },
      {
        onSuccess: () => {
          setMoveOpen(false);
          setMoveNotice(`Document déplacé dans « ${selectedFolder.name} ».`);
        },
        onError: () => {
          setSelectedFolder(null);
          setMoveError('Le document ou le dossier a changé. Les données ont été actualisées : vérifie la destination puis réessaie.');
          void document.refetch();
          void moveFolders.refetch();
        },
      },
    );
  };

  const recoverMove = (): void => {
    moveDocument.reset();
    setSelectedFolder(null);
    setMoveError(null);
    void Promise.all([document.refetch(), moveFolders.refetch()]);
  };

  const refreshScreen = (): void => {
    setRefreshing(true);
    const folderRefresh = document.data?.folderId ? currentFolder.refetch() : Promise.resolve();
    void Promise.all([document.refetch(), folderRefresh, refreshOriginal()]).finally(() => setRefreshing(false));
  };

  const agentContext = useMemo<AgentContext>(
    () => {
      const contextDocument = isDocumentView(document.data) ? document.data : null;
      return {
        screen: { name: 'document-detail', instanceId: `document:${documentId}` },
        entities: contextDocument
          ? [{
              type: 'document' as const,
              id: contextDocument.id,
              // Parité humain↔Bob : l'agent voit le même libellé intelligent que l'écran.
              label: smartDocumentTitle(contextDocument, contextDocument.analysis?.suggestedDisplayName ?? null),
            }]
          : [],
        capabilities: contextDocument ? ['screen.read', 'document.read'] : [],
      };
    },
    [document.data, documentId],
  );
  usePublishAgentContext(agentContext);

  if (document.isLoading) {
    return (
      <View style={{ flex: 1, backgroundColor: colors.bg }}>
        <ScrollView
          accessibilityLiveRegion="polite"
          accessibilityLabel="Chargement du document"
          contentContainerStyle={{ paddingTop: insets.top + 10, paddingHorizontal: 18, paddingBottom: bobScrollInsets.paddingBottom }}
          automaticallyAdjustKeyboardInsets={bobScrollInsets.automaticallyAdjustKeyboardInsets}
          scrollIndicatorInsets={{ bottom: bobScrollInsets.scrollIndicatorBottom }}
        >
          <View style={{ flexDirection: 'row', alignItems: 'center', marginBottom: 18 }}>
            <Pressable
              accessibilityRole="button"
              accessibilityLabel="Retour"
              onPress={() => router.back()}
              hitSlop={10}
              style={{ width: 44, height: 44, alignItems: 'center', justifyContent: 'center' }}
            >
              <Ionicons name="chevron-back" size={25} color={colors.ink900} />
            </Pressable>
            <View style={{ flex: 1, gap: 6 }}>
              <Skeleton width="66%" height={22} radius={10} />
              <Skeleton width={112} height={11} radius={6} />
            </View>
          </View>
          <SectionHeader title="Ce que Bob a compris" />
          <SkeletonCard height={214} contentLines={5} radius={16} />
          <View style={{ marginTop: 20 }}>
            <SkeletonCard height={320} contentLines={2} radius={16} />
          </View>
          <View style={{ marginTop: 20 }}>
            <SectionHeader title="Rangement" />
          </View>
          <SkeletonCard height={136} contentLines={3} radius={16} />
          <View style={{ marginTop: 20 }}>
            <SectionHeader title="Traçabilité" />
          </View>
          <SkeletonCard height={160} contentLines={5} radius={16} />
        </ScrollView>
      </View>
    );
  }

  if (!isDocumentView(document.data)) {
    return (
      <View style={{ flex: 1, paddingTop: insets.top + 16, paddingHorizontal: 20, backgroundColor: colors.bg }}>
        <View style={{ flexDirection: 'row', alignItems: 'center', marginBottom: 18 }}>
          <Pressable
            accessibilityRole="button"
            accessibilityLabel="Retour"
            onPress={() => router.back()}
            hitSlop={10}
            style={{ width: 44, height: 44, alignItems: 'center', justifyContent: 'center' }}
          >
            <Ionicons name="chevron-back" size={25} color={colors.ink900} />
          </Pressable>
          <Text accessibilityRole="header" style={[font('pageTitle'), { color: colors.ink900, flex: 1 }]}>Document</Text>
        </View>
        <ErrorRetry
          message="Ce document n’est pas disponible. Il a peut-être été déplacé ou le coffre n’a pas pu être chargé."
          onRetry={() => void document.refetch()}
          retrying={document.isRefetching}
        />
      </View>
    );
  }

  const item = document.data;
  const imageOriginal = item.mimeType.startsWith('image/') && original !== null;
  const analysisSupported = supportsDocumentAnalysis(item.mimeType);
  // Analyse complète (mutation fraîche) > résumé persisté (cache serveur) — jamais inventée.
  const insightAnalysis = analysis.data ?? item.analysis ?? null;
  const insight = insightAnalysis
    ? deriveDocumentInsight({
        analysis: insightAnalysis,
        extraction: item.extraction
          ? { totalTtcCents: item.extraction.totalTtcCents, vatCents: item.extraction.vatCents }
          : analysis.data
            ? extractionFromAnalysisFacts(analysis.data.facts)
            : null,
        // Titre de la carte = préséance smartDocumentTitle : un renommage humain prime.
        document: item,
      })
    : null;
  const insightDestination = insightAnalysis?.suggestedDestination ?? null;
  // Titre intelligent : renommage humain > suggestion d'analyse > displayName serveur.
  const title = smartDocumentTitle(item, insightAnalysis?.suggestedDisplayName ?? null);
  // Même GESTE que la carte de la file « À valider » (PendingCard, filedToConfirm) :
  // documentNeedsHumanReview (@bob/core — RÈGLE UNIQUE, zéro duplication) ET déjà rangé.
  // Un doc non rangé (folderId null) ne se « confirme » pas : reviewedAt le sortirait de la
  // file sans le placer dans aucun dossier — pièce orpheline. Ici, le seul CTA reste « Classer ».
  const needsConfirmation = documentNeedsHumanReview(item) && item.folderId !== null;
  // Chantiers OUVERTS réels + suggestion d'analyse validée (logique pure, jamais un id inventé).
  const linkSuggestionId = insightDestination?.kind === 'chantier' ? insightDestination.chantierId : null;
  const linkOptions = linkChantierOptions(chantiers.data ?? [], linkSuggestionId);
  const linkedChantier = item.linkedEntityType === 'chantier'
    ? linkedChantierName(chantiers.data ?? [], item.linkedEntityId)
    : null;

  const confirmDocument = (): void => {
    if (acknowledge.isPending) return;
    setConfirmError(false);
    acknowledge.mutate(
      { documentId: item.id, expectedRevision: item.revision },
      {
        onSuccess: () =>
          setConfirmNotice(t('docs.confirmedBanner', { personality, params: { name: title } })),
        onError: () => {
          setConfirmError(true);
          void document.refetch();
        },
      },
    );
  };

  const toggleFacts = (): void => {
    const next = !factsOpen;
    setFactsOpen(next);
    // Les preuves détaillées ne vivent que dans l'analyse complète : on la (re)joue à la
    // demande — geste humain, jamais au montage quand le cache résumé suffit à la carte.
    if (next && analysisSupported && !analysis.data && !analysis.isPending) analysis.mutate(item.id);
  };

  // Bloc de confirmation (« C'est bon ») — rendu dans la carte partagée, ou seul si la
  // carte n'existe pas encore (analyse indisponible) : la validation reste toujours possible.
  const confirmBlock = needsConfirmation || confirmNotice !== null || confirmError ? (
    <>
      {needsConfirmation ? (
        // Même geste que « C'est bon » de la carte « À valider » : indigo plein (aiSolid),
        // jamais le dégradé cta réservé aux actions primaires de création.
        <Button
          title={t('docs.confirmCta', { personality })}
          variant="aiSolid"
          loading={acknowledge.isPending}
          disabled={acknowledge.isPending}
          onPress={confirmDocument}
        />
      ) : null}
      {confirmNotice ? (
        <Text accessibilityLiveRegion="polite" style={[font('meta'), { color: semantic.success }]}>
          {confirmNotice}
        </Text>
      ) : null}
      {confirmError ? (
        <Text accessibilityRole="alert" style={[font('sub'), { color: semantic.danger, lineHeight: 19 }]}>
          {t('docs.confirmError', { personality })}
        </Text>
      ) : null}
    </>
  ) : null;

  return (
    <>
      <ScrollView
        style={{ flex: 1, backgroundColor: colors.bg }}
        refreshControl={<RefreshControl refreshing={refreshing} onRefresh={refreshScreen} tintColor={colors.ink800} />}
        contentContainerStyle={{ paddingTop: insets.top + 10, paddingHorizontal: 18, paddingBottom: bobScrollInsets.paddingBottom }}
        automaticallyAdjustKeyboardInsets={bobScrollInsets.automaticallyAdjustKeyboardInsets}
        scrollIndicatorInsets={{ bottom: bobScrollInsets.scrollIndicatorBottom }}
      >
      <View style={{ flexDirection: 'row', alignItems: 'center', marginBottom: 18 }}>
        <Pressable
          accessibilityRole="button"
          accessibilityLabel="Retour"
          onPress={() => router.back()}
          hitSlop={10}
          style={{ width: 44, height: 44, alignItems: 'center', justifyContent: 'center' }}
        >
          <Ionicons name="chevron-back" size={25} color={colors.ink900} />
        </Pressable>
        <View style={{ flex: 1, minWidth: 0 }}>
          {/* Titre INTELLIGENT — jamais le nom de fichier brut quand un meilleur libellé existe. */}
          <Text accessibilityRole="header" style={[font('pageTitle'), { color: colors.ink900 }]} numberOfLines={1}>{title}</Text>
          <Text style={[font('meta'), { color: colors.slate400, marginTop: 2 }]}>Original · version {item.version}</Text>
        </View>
      </View>

      {document.isError ? (
        <View style={{ marginBottom: 16 }}>
          <ErrorRetry
            message="Le document affiché est la dernière version disponible. Son actualisation n’a pas abouti."
            onRetry={() => void document.refetch()}
            retrying={document.isRefetching}
          />
        </View>
      ) : null}

      <SectionHeader title="Ce que Bob a compris" />
      {!analysisSupported ? (
        <Card>
          <Text accessibilityRole="alert" style={[font('cardTitle'), { color: semantic.warning }]}>Analyse non disponible pour cet original</Text>
          <Text style={[font('sub'), { color: colors.slate500, marginTop: 4, lineHeight: 19 }]}>Le HEIC/HEIF reste conservé sans aucune modification. Bob ne lance pas d’analyse vouée à l’échec : importe une copie JPEG ou PDF pour obtenir une lecture assistée.</Text>
        </Card>
      ) : insight ? (
        <DocumentInsightCard
          insight={insight}
          actions={
            <>
              {item.folderId !== null && currentFolder.data ? (
                <View style={{ flexDirection: 'row', alignItems: 'center', gap: 7 }}>
                  <Ionicons name="folder" size={17} color={semantic.success} />
                  <Text style={[font('sub'), { color: colors.ink800, flex: 1 }]}>
                    {t('docs.classifiedIn', { personality, params: { folder: currentFolder.data.name } })}
                  </Text>
                </View>
              ) : item.folderId === null && insightDestination ? (
                <Button
                  title={t('scan.classifyInto', { personality, params: { label: insightDestination.label } })}
                  variant="aiSolid"
                  loading={applyDest.pending}
                  disabled={applyDest.pending || moveDocument.isPending}
                  onPress={() =>
                    void applyDest.apply(item, insightDestination, insightAnalysis?.suggestedDisplayName ?? null)}
                />
              ) : null}
              {applyDest.error ? (
                <Text accessibilityRole="alert" style={[font('sub'), { color: semantic.warning, lineHeight: 19 }]}>
                  {t('scan.destinationError', { personality })}
                </Text>
              ) : null}
              {confirmBlock}
            </>
          }
        />
      ) : analysis.isPending ? (
        <View
          accessibilityRole="progressbar"
          accessibilityLiveRegion="polite"
          accessibilityLabel="Bob lit l’original et vérifie ses preuves"
        >
          <SkeletonCard height={154} contentLines={4} radius={16} />
        </View>
      ) : (
        <Card>
          <Text style={[font('sub'), { color: colors.slate500 }]}>L’analyse n’a pas abouti. L’original reste conservé et tu peux relancer Bob.</Text>
          <View style={{ marginTop: 12 }}>
            <Button title="Relancer l’analyse" variant="secondary" onPress={() => analysis.mutate(item.id)} />
          </View>
        </Card>
      )}
      {insight === null && confirmBlock ? (
        <View style={{ marginTop: 12, gap: 8 }}>{confirmBlock}</View>
      ) : null}

      <View style={{ marginTop: 20 }}>
        <Card>
          {item.mimeType.startsWith('image/') && originalLoading && original === null ? (
            <Skeleton height={320} radius={14} />
          ) : imageOriginal ? (
            <Image
              source={{ uri: original.url }}
              accessibilityLabel={`Aperçu original de ${item.filename}`}
              resizeMode="contain"
              style={{ width: '100%', height: 320, borderRadius: 14, backgroundColor: colors.lineSoft }}
            />
          ) : (
            <View style={{ height: item.mimeType.startsWith('image/') ? 320 : 180, alignItems: 'center', justifyContent: 'center', gap: 10 }}>
              <Ionicons name={item.mimeType === 'application/pdf' ? 'document-text-outline' : 'document-outline'} size={46} color={semantic.b2b} />
              <Text style={[font('sub'), { color: colors.slate500, textAlign: 'center' }]}>
                {item.mimeType === 'application/pdf' ? 'PDF original conservé' : 'Original conservé dans le coffre'}
              </Text>
            </View>
          )}
          <View style={{ marginTop: 12 }}>
            <Button
              title={originalLoading ? 'Préparation de l’original…' : originalError ? 'Réessayer d’ouvrir l’original' : 'Voir l’original'}
              disabled={originalLoading}
              onPress={() => void openOriginal()}
            />
            {originalError ? (
              <Text accessibilityRole="alert" style={[font('meta'), { color: semantic.danger, marginTop: 8 }]}>Le lien sécurisé a expiré ou n’est pas disponible. Tu peux le régénérer sans modifier le document.</Text>
            ) : null}
          </View>
        </Card>
      </View>

      <View style={{ marginTop: 20 }}>
        <SectionHeader title="Rangement" />
      </View>
      <Card>
        <View style={{ flexDirection: 'row', alignItems: 'center', gap: 12 }}>
          <View
            style={{
              width: 40,
              height: 40,
              borderRadius: 12,
              alignItems: 'center',
              justifyContent: 'center',
              backgroundColor: semantic.b2bBg,
            }}
          >
            <Ionicons name="folder-outline" size={21} color={semantic.b2b} />
          </View>
          <View style={{ flex: 1, minWidth: 0 }}>
            <Text style={[font('meta'), { color: colors.slate400 }]}>Dossier actuel</Text>
            {item.folderId !== null && currentFolder.isLoading ? (
              <Skeleton width={116} height={16} radius={7} style={{ marginTop: 4 }} />
            ) : (
              <Text
                accessibilityRole={currentFolder.isError ? 'alert' : undefined}
                style={[
                  font('body'),
                  {
                    color: currentFolder.isError ? semantic.danger : colors.ink900,
                    fontWeight: '700',
                    marginTop: 2,
                  },
                ]}
                numberOfLines={1}
              >
                {item.folderId === null ? 'À classer' : currentFolder.data?.name ?? 'Dossier indisponible'}
              </Text>
            )}
          </View>
        </View>
        {item.folderId !== null && currentFolder.isError ? (
          <View style={{ marginTop: 10 }}>
            <Button title="Réessayer de charger le dossier" variant="secondary" onPress={() => void currentFolder.refetch()} />
          </View>
        ) : null}
        {moveNotice ? (
          <Text accessibilityLiveRegion="polite" style={[font('meta'), { color: semantic.success, marginTop: 10 }]}>
            {moveNotice}
          </Text>
        ) : null}
        <View style={{ marginTop: 12 }}>
          <Button title="Déplacer dans un dossier" variant="secondary" onPress={openMoveSheet} />
        </View>
        {/* Lien métier chantier — ligne sœur discrète du rangement (demande fondateur) :
            · doc SANS lien → « Lier à un chantier » (feuille des chantiers ouverts réels) ;
            · doc déjà lié chantier → état LECTURE « Chantier · {nom} », ouvre le chantier —
              pas de changement ni de déliaison en V1 (aucun geste dédié côté domaine) ;
            · doc lié à une autre entité (dépense, facture…) → rien : on n'écrase jamais. */}
        {item.linkedEntityType === null && linkOptions.length > 0 ? (
          <>
            <View style={{ height: 1, backgroundColor: colors.lineSoft, marginTop: 14 }} />
            <PressableScale
              accessibilityRole="button"
              accessibilityLabel={t('docs.linkChantierCta', { personality })}
              disabled={linkChantier.isPending}
              onPress={() => {
                setLinkError(false);
                setLinkOpen(true);
              }}
              style={{ minHeight: 48, flexDirection: 'row', alignItems: 'center', gap: 12, marginTop: 8 }}
            >
              <IconTile tone="b2b" size={40} radius={12}>
                <FolderSmallIcon color={semantic.b2b} size={19} />
              </IconTile>
              <Text style={[font('sub'), { color: colors.ink900, flex: 1, fontWeight: '700' }]}>
                {t('docs.linkChantierCta', { personality })}
              </Text>
              <ChevronRightIcon color={colors.slate300} size={14} strokeWidth={2} />
            </PressableScale>
          </>
        ) : item.linkedEntityType === 'chantier' ? (
          <>
            <View style={{ height: 1, backgroundColor: colors.lineSoft, marginTop: 14 }} />
            <PressableScale
              accessibilityRole="button"
              accessibilityLabel={linkedChantier !== null
                ? t('docs.linkChantierLinkedA11y', { personality, params: { name: linkedChantier } })
                : t('docs.linkChantierLinkedUnknown', { personality })}
              onPress={() => router.push(`/chantier/${item.linkedEntityId}`)}
              style={{ minHeight: 48, flexDirection: 'row', alignItems: 'center', gap: 12, marginTop: 8 }}
            >
              <IconTile tone="b2b" size={40} radius={12}>
                <FolderSmallIcon color={semantic.b2b} size={19} />
              </IconTile>
              <Text style={[font('sub'), { color: colors.ink900, flex: 1, fontWeight: '700' }]} numberOfLines={1}>
                {linkedChantier !== null
                  ? t('docs.linkChantierLinked', { personality, params: { name: linkedChantier } })
                  : t('docs.linkChantierLinkedUnknown', { personality })}
              </Text>
              <ChevronRightIcon color={colors.slate300} size={14} strokeWidth={2} />
            </PressableScale>
          </>
        ) : null}
        {linkError ? (
          <Text accessibilityRole="alert" style={[font('sub'), { color: semantic.danger, lineHeight: 19, marginTop: 10 }]}>
            {t('docs.linkChantierError', { personality })}
          </Text>
        ) : null}
      </Card>

      <View style={{ marginTop: 20 }}>
        <SectionHeader title="Traçabilité" />
      </View>
      <Card>
        {analysisSupported ? (
          <>
            {/* Accordéon : les preuves détaillées (« Lu · X % » PAR FAIT) restent accessibles
                sans polluer la vue principale — analyse (re)jouée à l'ouverture si absente. */}
            <Pressable
              accessibilityRole="button"
              accessibilityState={{ expanded: factsOpen }}
              accessibilityLabel={t('docs.traceToggle', { personality })}
              onPress={toggleFacts}
              style={{ minHeight: 44, flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: 10 }}
            >
              <Text style={[font('sub'), { color: colors.ink900, fontWeight: '700', flex: 1 }]}>
                {t('docs.traceToggle', { personality })}
              </Text>
              <Ionicons name={factsOpen ? 'chevron-up' : 'chevron-down'} size={18} color={colors.slate400} />
            </Pressable>
            {factsOpen ? (
              analysis.isPending ? (
                <View
                  accessibilityRole="progressbar"
                  accessibilityLiveRegion="polite"
                  accessibilityLabel="Bob relit l’original et vérifie ses preuves"
                  style={{ paddingVertical: 10, gap: 8 }}
                >
                  <Skeleton height={14} radius={7} />
                  <Skeleton height={14} width="82%" radius={7} />
                  <Skeleton height={14} width="64%" radius={7} />
                </View>
              ) : analysis.data ? (
                analysis.data.facts.length > 0 ? (
                  <View style={{ marginTop: 4, marginBottom: 8, gap: 10 }}>
                    {analysis.data.facts.map((fact) => (
                      <View key={fact.key} style={{ flexDirection: 'row', justifyContent: 'space-between', gap: 16 }}>
                        <Text style={[font('sub'), { color: colors.slate400, flex: 1 }]}>{FACT_LABEL[fact.key]}</Text>
                        <View style={{ flex: 1.3, alignItems: 'flex-end' }}>
                          <Text style={[font('sub'), { color: colors.ink900, fontWeight: '700', textAlign: 'right' }]}>{factValue(fact)}</Text>
                          <Text style={[font('meta'), { color: fact.confidence >= 0.75 ? semantic.success : semantic.warning }]}>
                            {fact.provenance.evidence.length > 0 ? `Lu · ${Math.round(fact.confidence * 100)} %` : `À confirmer · ${Math.round(fact.confidence * 100)} %`}
                          </Text>
                        </View>
                      </View>
                    ))}
                  </View>
                ) : (
                  <Text style={[font('sub'), { color: colors.slate500, paddingVertical: 8 }]}>
                    {t('docs.traceEmpty', { personality })}
                  </Text>
                )
              ) : (
                <View style={{ paddingVertical: 8 }}>
                  <Text style={[font('sub'), { color: colors.slate500 }]}>L’analyse n’a pas abouti. L’original reste conservé et tu peux relancer Bob.</Text>
                  <View style={{ marginTop: 10 }}>
                    <Button title="Relancer l’analyse" variant="secondary" onPress={() => analysis.mutate(item.id)} />
                  </View>
                </View>
              )
            ) : null}
            <View style={{ height: 1, backgroundColor: colors.lineSoft, marginVertical: 8 }} />
          </>
        ) : null}
        <InfoRow label="Format" value={item.mimeType} colors={colors} />
        <InfoRow label="Taille" value={bytesLabel(item.byteSize)} colors={colors} />
        <InfoRow label="Conservation" value={`Jusqu’au ${item.retentionUntil}`} colors={colors} />
        <InfoRow label="Empreinte" value={`${item.sha256.slice(0, 12)}…`} colors={colors} />
      </Card>

      </ScrollView>

      <Sheet visible={moveOpen} onClose={closeMoveSheet}>
        <Text accessibilityRole="header" style={[font('pageTitle'), { fontSize: 20, color: colors.ink900 }]}>
          Déplacer le document
        </Text>
        <Text style={[font('sub'), { color: colors.slate500, lineHeight: 19, marginTop: 4 }]}>
          Parcours l’arborescence, sélectionne une destination, puis confirme. L’original et son rattachement comptable ne changent pas.
        </Text>

        <View style={{ flexDirection: 'row', alignItems: 'center', minHeight: 44, marginTop: 12 }}>
          {movePath.length > 0 ? (
            <Pressable
              accessibilityRole="button"
              accessibilityLabel="Revenir au dossier parent"
              onPress={leaveFolder}
              hitSlop={6}
              style={{ width: 44, height: 44, alignItems: 'center', justifyContent: 'center' }}
            >
              <Ionicons name="chevron-back" size={21} color={colors.ink900} />
            </Pressable>
          ) : null}
          <Text style={[font('sub'), { color: colors.ink900, flex: 1, fontWeight: '700' }]} numberOfLines={2}>
            {movePath.length === 0 ? 'Tous les dossiers' : movePath.map((folder) => folder.name).join(' / ')}
          </Text>
        </View>

        <ScrollView style={{ maxHeight: 320 }} nestedScrollEnabled keyboardShouldPersistTaps="handled">
          {moveFolders.isLoading ? (
            <View
              accessibilityRole="progressbar"
              accessibilityLiveRegion="polite"
              accessibilityLabel="Chargement des dossiers"
              style={{ minHeight: 156, justifyContent: 'center' }}
            >
              <SkeletonRow avatar="square" trailing={false} />
              <SkeletonRow avatar="square" trailing={false} />
              <SkeletonRow avatar="square" trailing={false} />
            </View>
          ) : moveFolders.isError ? (
            <View style={{ paddingVertical: 12 }}>
              <Text accessibilityRole="alert" style={[font('sub'), { color: semantic.danger, lineHeight: 19 }]}>
                Cette partie de l’arborescence n’est pas disponible. Aucun déplacement n’a été effectué.
              </Text>
              <View style={{ marginTop: 10 }}>
                <Button title="Réessayer" variant="secondary" onPress={() => void moveFolders.refetch()} />
              </View>
            </View>
          ) : (moveFolders.data ?? []).length === 0 ? (
            <Text style={[font('sub'), { color: colors.slate500, paddingVertical: 16 }]}>Aucun sous-dossier ici.</Text>
          ) : (
            (moveFolders.data ?? []).map((folder) => {
              const selected = selectedFolder?.id === folder.id;
              const current = item.folderId === folder.id;
              return (
                <View
                  key={folder.id}
                  style={{
                    minHeight: 52,
                    flexDirection: 'row',
                    alignItems: 'center',
                    borderBottomWidth: 1,
                    borderBottomColor: colors.lineSoft,
                  }}
                >
                  <Pressable
                    accessibilityRole="radio"
                    accessibilityState={{ selected, disabled: current }}
                    accessibilityLabel={`${folder.name}${current ? ', dossier actuel' : ''}`}
                    disabled={current || moveDocument.isPending}
                    onPress={() => {
                      setSelectedFolder(folder);
                      setMoveError(null);
                    }}
                    style={({ pressed }) => ({
                      minHeight: 52,
                      flex: 1,
                      flexDirection: 'row',
                      alignItems: 'center',
                      gap: 10,
                      paddingVertical: 6,
                      opacity: current ? 0.55 : pressed ? 0.72 : 1,
                    })}
                  >
                    <View
                      style={{
                        width: 22,
                        height: 22,
                        borderRadius: 11,
                        borderWidth: 2,
                        borderColor: selected ? semantic.success : colors.slate300,
                        backgroundColor: selected ? semantic.success : colors.surface,
                        alignItems: 'center',
                        justifyContent: 'center',
                      }}
                    >
                      {selected ? <Ionicons name="checkmark" size={14} color={colors.surface} /> : null}
                    </View>
                    <Ionicons name="folder-outline" size={19} color={semantic.b2b} />
                    <Text style={[font('sub'), { color: colors.ink900, flex: 1, fontWeight: '700' }]} numberOfLines={1}>
                      {folder.name}
                    </Text>
                  </Pressable>
                  <Pressable
                    accessibilityRole="button"
                    accessibilityLabel={`Ouvrir les sous-dossiers de ${folder.name}`}
                    disabled={moveDocument.isPending}
                    onPress={() => enterFolder(folder)}
                    hitSlop={4}
                    style={{ width: 48, height: 48, alignItems: 'center', justifyContent: 'center' }}
                  >
                    <Ionicons name="chevron-forward" size={20} color={colors.slate400} />
                  </Pressable>
                </View>
              );
            })
          )}
        </ScrollView>

        {selectedFolder ? (
          <Text style={[font('meta'), { color: colors.slate500, marginTop: 10 }]} numberOfLines={2}>
            Destination : {selectedFolder.name}
          </Text>
        ) : null}
        {moveError ? (
          <View style={{ marginTop: 8 }}>
            <Text accessibilityRole="alert" style={[font('sub'), { color: semantic.danger, lineHeight: 19 }]}>
              {moveError}
            </Text>
            <View style={{ marginTop: 10 }}>
              <Button title="Actualiser les destinations" variant="secondary" onPress={recoverMove} />
            </View>
          </View>
        ) : null}
        <View style={{ flexDirection: 'row', gap: 10, marginTop: 16 }}>
          <View style={{ flex: 1 }}>
            <Button
              title="Annuler"
              variant="secondary"
              disabled={moveDocument.isPending}
              onPress={closeMoveSheet}
            />
          </View>
          <View style={{ flex: 1 }}>
            <Button
              title="Déplacer"
              loading={moveDocument.isPending}
              disabled={!selectedFolder || selectedFolder.id === item.folderId || moveDocument.isPending}
              onPress={confirmMove}
            />
          </View>
        </View>
      </Sheet>

      {/* Sélection du chantier — chantiers OUVERTS réels, suggestion d'analyse en tête,
          choix unique CONFIRMÉ (confirmSingle, pattern scan) : plus aucun lien au tap sec. */}
      <QuestionSheet
        visible={linkOpen}
        header={t('docs.linkChantierHeader', { personality })}
        question={t('docs.linkChantierQuestion', { personality })}
        options={linkOptions.map((option) => ({
          value: option.chantierId,
          label: option.name,
          description: option.suggested
            ? t('docs.linkChantierSuggestedDesc', { personality })
            : t('docs.pickChantierMeta', { personality }),
        }))}
        confirmSingle
        confirmLabel={t('docs.linkChantierConfirm', { personality })}
        otherLabel={t('docs.linkChantierLater', { personality })}
        onClose={() => setLinkOpen(false)}
        onSelect={(values) => {
          const picked = linkOptions.find((option) => option.chantierId === values[0]);
          if (!picked || linkChantier.isPending) return;
          // La feuille se ferme d'abord (pattern scan), puis le lien s'exécute — le CAS de
          // révision du use case refuse tout écrasement si le document a changé entre-temps.
          setLinkOpen(false);
          linkChantier.mutate({
            documentId: item.id,
            chantierId: picked.chantierId,
            chantierName: picked.name,
            expectedRevision: item.revision,
          });
        }}
        onOther={() => setLinkOpen(false)}
      />

      <Toast
        message={linkToast ?? ''}
        visible={linkToast !== null}
        onHide={() => setLinkToast(null)}
        icon={<Ionicons name="checkmark" size={16} color={colors.surface} />}
      />
    </>
  );
}

function InfoRow({
  label,
  value,
  colors,
}: {
  label: string;
  value: string;
  colors: ReturnType<typeof useTheme>['colors'];
}) {
  return (
    <View
      accessible
      accessibilityLabel={`${label} : ${value}`}
      style={{ minHeight: 32, flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: 12, paddingVertical: 5 }}
    >
      <Text accessible={false} style={[font('sub'), { color: colors.slate400 }]}>{label}</Text>
      <Text accessible={false} style={[font('sub'), { color: colors.ink900, flex: 1, fontWeight: '600', textAlign: 'right' }]} numberOfLines={1}>{value}</Text>
    </View>
  );
}
