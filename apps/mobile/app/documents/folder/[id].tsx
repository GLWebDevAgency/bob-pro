import { useEffect, useMemo, useRef, useState } from 'react';
import {
  ActivityIndicator,
  KeyboardAvoidingView,
  Pressable,
  RefreshControl,
  ScrollView,
  Text,
  TextInput,
  View,
} from 'react-native';
import { useLocalSearchParams, useRouter } from 'expo-router';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { shadowNative } from '@bob/tokens';
import {
  validateDocumentFolderName,
  type DocumentFolderView,
  type DocumentView,
} from '@bob/core';
import {
  Button,
  Card,
  EmptyState,
  ErrorRetry,
  SectionHeader,
  Sheet,
  Skeleton,
  SkeletonCard,
  Toast,
  font,
  useTheme,
} from '@bob/ui';
import { usePublishAgentContext, type AgentContext } from '../../../src/agent';
import {
  useCreateDocumentFolder,
  useDocumentFolder,
  useDocumentFolders,
  useDocumentsInFolder,
  useExecuteDocumentFolderDeletion,
  usePreviewDocumentFolderDeletion,
  useUpdateDocumentFolder,
} from '../../../src/data/documents';
import {
  CheckIcon,
  ChevronLeftIcon,
  ChevronRightIcon,
  EllipsisIcon,
  FileTextIcon,
  FolderSmallIcon,
  LockIcon,
  PlusIcon,
  ShieldIcon,
} from '../../../src/components/icons';

type FolderEditor =
  | { readonly kind: 'create'; readonly name: string }
  | { readonly kind: 'rename'; readonly name: string }
  | null;

function firstParam(value: string | string[] | undefined): string {
  return Array.isArray(value) ? (value[0] ?? '') : (value ?? '');
}

function formatDate(value: string): string {
  const [year, month, day] = value.slice(0, 10).split('-');
  return day && month && year ? `${day}/${month}/${year}` : value.slice(0, 10);
}

function bytesLabel(value: number): string {
  if (value < 1024) return `${value} o`;
  if (value < 1024 * 1024) return `${Math.round(value / 1024)} Ko`;
  return `${(value / (1024 * 1024)).toFixed(1).replace('.', ',')} Mo`;
}

function mimeLabel(mimeType: string): string {
  if (mimeType === 'application/pdf') return 'PDF';
  if (mimeType === 'image/jpeg') return 'Image JPEG';
  if (mimeType === 'image/png') return 'Image PNG';
  return mimeType;
}

export default function DocumentFolderScreen() {
  const params = useLocalSearchParams<{
    id?: string | string[];
    manage?: string | string[];
  }>();
  const folderId = firstParam(params.id);
  const manageRequested = firstParam(params.manage) === '1';
  const router = useRouter();
  const insets = useSafeAreaInsets();
  const { colors, semantic, controls, theme } = useTheme();

  const folder = useDocumentFolder(folderId);
  const children = useDocumentFolders(folderId);
  const rootFolders = useDocumentFolders(null);
  const documents = useDocumentsInFolder(folderId);
  const createFolder = useCreateDocumentFolder();
  const updateFolder = useUpdateDocumentFolder();
  const previewDeletion = usePreviewDocumentFolderDeletion();
  const executeDeletion = useExecuteDocumentFolderDeletion();

  const [managementOpen, setManagementOpen] = useState(false);
  const [editor, setEditor] = useState<FolderEditor>(null);
  const [editorError, setEditorError] = useState<string | null>(null);
  const [toast, setToast] = useState<string | null>(null);
  const [deletionOpen, setDeletionOpen] = useState(false);
  const [transferTargetId, setTransferTargetId] = useState<string | null>(null);
  const handledManageRoute = useRef<string | null>(null);

  const transferTargets = useMemo(
    () => (rootFolders.data ?? []).filter((candidate) => candidate.id !== folderId && candidate.status === 'active'),
    [folderId, rootFolders.data],
  );
  const transferTarget = transferTargets.find((candidate) => candidate.id === transferTargetId) ?? null;

  useEffect(() => {
    if (!manageRequested) {
      handledManageRoute.current = null;
      return;
    }
    if (!folder.data || handledManageRoute.current === folder.data.id) return;
    handledManageRoute.current = folder.data.id;
    setManagementOpen(true);
  }, [folder.data, manageRequested]);

  const agentContext = useMemo<AgentContext>(
    () => {
      const folderReady = folder.data !== undefined;
      // Cet écran masque les rangées document lors d'une erreur de leur query. Bob doit voir
      // exactement la même surface : aucune photographie cachée ni faux dossier vide.
      const documentsReady = documents.data !== undefined && !documents.isError;
      return {
        screen: { name: 'document-folder', instanceId: `document-folder:${folderId}` },
        entities: documentsReady
          ? documents.data.slice(0, 16).map((document) => ({
              type: 'document' as const,
              id: document.id,
              label: document.filename,
            }))
          : [],
        capabilities: folderReady
          ? documentsReady
            ? ['screen.read', 'document.read']
            : ['screen.read']
          : [],
      };
    },
    [documents.data, documents.isError, folder.data, folderId],
  );
  usePublishAgentContext(agentContext);

  const refreshing = folder.isRefetching || children.isRefetching || documents.isRefetching;
  const refresh = (): void => {
    void Promise.all([folder.refetch(), children.refetch(), documents.refetch()]);
  };

  const closeEditor = (): void => {
    if (createFolder.isPending || updateFolder.isPending) return;
    setEditor(null);
    setEditorError(null);
  };

  const openCreate = (): void => {
    setManagementOpen(false);
    setEditorError(null);
    setEditor({ kind: 'create', name: '' });
  };

  const openRename = (): void => {
    if (!folder.data) return;
    setManagementOpen(false);
    setEditorError(null);
    setEditor({ kind: 'rename', name: folder.data.name });
  };

  const openDeletionPreview = (): void => {
    if (!folder.data || folder.data.systemKey !== null || previewDeletion.isPending) return;
    setManagementOpen(false);
    setTransferTargetId(null);
    previewDeletion.reset();
    executeDeletion.reset();
    setDeletionOpen(true);
    previewDeletion.mutate(folder.data.id, {
      onSuccess: () => undefined,
      onError: () => undefined,
    });
  };

  const closeDeletion = (): void => {
    if (executeDeletion.isPending) return;
    setDeletionOpen(false);
    setTransferTargetId(null);
    previewDeletion.reset();
    executeDeletion.reset();
  };

  const confirmDeletion = (): void => {
    const plan = previewDeletion.data;
    if (!plan || executeDeletion.isPending) return;
    const strategy = plan.canDeleteEmpty
      ? ({ kind: 'empty' } as const)
      : transferTarget
        ? ({
            kind: 'transfer',
            targetFolderId: transferTarget.id,
            targetExpectedRevision: transferTarget.revision,
          } as const)
        : null;
    if (!strategy) return;
    executeDeletion.mutate(
      { planId: plan.planId, strategy },
      {
        onSuccess: () => {
          setDeletionOpen(false);
          router.replace('/(tabs)/documents');
        },
      },
    );
  };

  const submitEditor = (): void => {
    if (!folder.data || !editor || createFolder.isPending || updateFolder.isPending) return;
    const validated = validateDocumentFolderName(editor.name);
    if (!validated.ok) {
      setEditorError(
        validated.error.code === 'VALIDATION'
          ? validated.error.message
          : 'Ce nom de dossier n’est pas valide.',
      );
      return;
    }
    setEditorError(null);
    if (editor.kind === 'create') {
      createFolder.mutate(
        { name: validated.value.name, parentId: folder.data.id },
        {
          onSuccess: () => {
            setEditor(null);
            setToast(`Le sous-dossier « ${validated.value.name} » est prêt.`);
          },
          onError: () =>
            setEditorError('Impossible de créer ce dossier. Vérifie le nom ou réessaie.'),
        },
      );
      return;
    }
    updateFolder.mutate(
      {
        folderId: folder.data.id,
        expectedRevision: folder.data.revision,
        name: validated.value.name,
      },
      {
        onSuccess: () => {
          setEditor(null);
          setToast('Le dossier a été renommé.');
          void folder.refetch();
        },
        onError: () =>
          setEditorError('Le dossier a changé ou ce nom existe déjà. Recharge puis réessaie.'),
      },
    );
  };

  if (
    folder.isLoading
    || (folder.data !== undefined && children.isLoading && !children.data)
    || (folder.data !== undefined && documents.isLoading && !documents.data)
  ) {
    return (
      <View style={{ flex: 1, backgroundColor: colors.bg }}>
        <ScrollView
          accessibilityLiveRegion="polite"
          accessibilityLabel="Chargement du dossier"
          contentContainerStyle={{
            paddingTop: insets.top + 10,
            paddingHorizontal: 18,
            paddingBottom: Math.max(insets.bottom, 24) + 92,
            gap: 18,
          }}
        >
          <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8 }}>
            <Pressable
              accessibilityRole="button"
              accessibilityLabel="Retour aux documents"
              onPress={() => router.back()}
              hitSlop={8}
              style={{ width: 44, height: 44, alignItems: 'center', justifyContent: 'center' }}
            >
              <ChevronLeftIcon color={colors.ink800} size={22} />
            </Pressable>
            <View style={{ flex: 1, gap: 6 }}>
              {folder.data ? (
                <Text accessibilityRole="header" numberOfLines={1} style={[font('pageTitle'), { color: colors.ink900 }]}>
                  {folder.data.name}
                </Text>
              ) : (
                <Skeleton width="64%" height={22} radius={10} />
              )}
              <Skeleton width={126} height={11} radius={6} />
            </View>
            <Skeleton width={44} height={44} radius={22} />
          </View>

          <SkeletonCard height={104} contentLines={3} />
          <View>
            <SectionHeader title="Sous-dossiers" />
            <View style={{ gap: 10 }}>
              <Skeleton height={66} radius={17} />
              <Skeleton height={66} radius={17} />
            </View>
          </View>
          <View>
            <SectionHeader title="Documents" />
            <View style={{ gap: 10 }}>
              <Skeleton height={86} radius={17} />
              <Skeleton height={86} radius={17} />
            </View>
          </View>
        </ScrollView>
      </View>
    );
  }

  if (!folder.data) {
    return (
      <View
        style={{
          flex: 1,
          backgroundColor: colors.bg,
          paddingTop: insets.top + 12,
          paddingHorizontal: 18,
          gap: 18,
        }}
      >
        <Pressable
          accessibilityRole="button"
          accessibilityLabel="Retour aux documents"
          onPress={() => router.back()}
          hitSlop={8}
          style={{ width: 44, height: 44, alignItems: 'center', justifyContent: 'center' }}
        >
          <ChevronLeftIcon color={colors.ink800} size={22} />
        </Pressable>
        <ErrorRetry
          message="Ce dossier n’existe plus ou le coffre n’a pas pu être chargé."
          onRetry={() => void folder.refetch()}
          retrying={folder.isRefetching}
        />
      </View>
    );
  }

  const currentFolder = folder.data;
  const childFolders = children.data ?? [];
  const storedDocuments = documents.data ?? [];
  const sectionError = children.isError || documents.isError;
  const empty = childFolders.length === 0 && storedDocuments.length === 0 && !sectionError;

  return (
    <View style={{ flex: 1, backgroundColor: colors.bg }}>
      <ScrollView
        contentInsetAdjustmentBehavior="automatic"
        keyboardShouldPersistTaps="handled"
        refreshControl={<RefreshControl refreshing={refreshing} onRefresh={refresh} tintColor={theme.ink} />}
        contentContainerStyle={{
          paddingTop: insets.top + 10,
          paddingHorizontal: 18,
          paddingBottom: Math.max(insets.bottom, 24) + 92,
          gap: 18,
        }}
      >
        <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8 }}>
          <Pressable
            accessibilityRole="button"
            accessibilityLabel="Retour aux documents"
            onPress={() => router.back()}
            hitSlop={8}
            style={{ width: 44, height: 44, alignItems: 'center', justifyContent: 'center' }}
          >
            <ChevronLeftIcon color={colors.ink800} size={22} />
          </Pressable>
          <View style={{ flex: 1, minWidth: 0 }}>
            <Text accessibilityRole="header" selectable numberOfLines={1} style={[font('pageTitle'), { color: colors.ink900 }]}>
              {currentFolder.name}
            </Text>
            <Text selectable style={[font('meta'), { color: colors.slate400, marginTop: 2 }]}>
              {currentFolder.systemKey ? 'Dossier du coffre' : 'Dossier personnalisé'}
            </Text>
          </View>
          <Pressable
            accessibilityRole="button"
            accessibilityLabel={`Gérer le dossier ${currentFolder.name}`}
            accessibilityHint="Permet de renommer le dossier ou de consulter les règles de suppression."
            onPress={() => setManagementOpen(true)}
            style={({ pressed }) => ({
              width: 44,
              height: 44,
              borderRadius: 22,
              backgroundColor: colors.surface,
              borderWidth: 1,
              borderColor: controls.cardBorder,
              alignItems: 'center',
              justifyContent: 'center',
              opacity: pressed ? 0.72 : 1,
              ...shadowNative.e1,
            })}
          >
            <EllipsisIcon color={colors.ink800} />
          </Pressable>
        </View>

        {folder.isError ? (
          <ErrorRetry
            message="Le dossier affiché est la dernière version disponible. Son actualisation n’a pas abouti."
            onRetry={() => void folder.refetch()}
            retrying={folder.isRefetching}
          />
        ) : null}

        <Card style={{ backgroundColor: semantic.successBg, borderColor: semantic.success }}>
          <View style={{ flexDirection: 'row', alignItems: 'flex-start', gap: 12 }}>
            <View
              style={{
                width: 36,
                height: 36,
                borderRadius: 11,
                backgroundColor: colors.surface,
                alignItems: 'center',
                justifyContent: 'center',
              }}
            >
              <ShieldIcon color={semantic.success} size={18} />
            </View>
            <View style={{ flex: 1, gap: 3 }}>
              <Text selectable style={[font('body', 700), { color: colors.ink900 }]}>Originaux conservés</Text>
              <Text selectable style={[font('sub'), { color: colors.slate500, lineHeight: 19 }]}>Chaque document garde son fichier d’origine, son empreinte et sa durée de conservation.</Text>
            </View>
          </View>
        </Card>

        {!empty ? (
          <>
            <View>
              <SectionHeader
                title="Sous-dossiers"
                action={
                  <Pressable
                    accessibilityRole="button"
                    accessibilityLabel={`Créer un sous-dossier dans ${currentFolder.name}`}
                    onPress={openCreate}
                    hitSlop={8}
                    style={{ flexDirection: 'row', alignItems: 'center', minHeight: 44, gap: 5 }}
                  >
                    <PlusIcon color={semantic.b2b} size={17} />
                    <Text style={[font('sub', 700), { color: semantic.b2b }]}>Nouveau</Text>
                  </Pressable>
                }
              />
              {children.isError ? (
                <ErrorRetry
                  message="Les sous-dossiers n’ont pas pu être chargés."
                  onRetry={() => void children.refetch()}
                  retrying={children.isRefetching}
                />
              ) : childFolders.length === 0 ? (
                <Card elevation="e1">
                  <EmptyState body="Aucun sous-dossier ici. Tu peux en créer pour organiser ce coffre à ton rythme." />
                </Card>
              ) : (
                <View style={{ gap: 10 }}>
                  {childFolders.map((child) => (
                    <FolderRow key={child.id} folder={child} />
                  ))}
                </View>
              )}
            </View>

            <View>
              <SectionHeader title={`Documents (${storedDocuments.length})`} />
              {documents.isError ? (
                <ErrorRetry
                  message="Les documents de ce dossier n’ont pas pu être chargés."
                  onRetry={() => void documents.refetch()}
                  retrying={documents.isRefetching}
                />
              ) : storedDocuments.length === 0 ? (
                <Card elevation="e1">
                  <EmptyState body="Aucun document directement dans ce dossier." />
                </Card>
              ) : (
                <View style={{ gap: 10 }}>
                  {storedDocuments.map((document) => (
                    <DocumentRow key={document.id} document={document} />
                  ))}
                </View>
              )}
            </View>
          </>
        ) : null}

        {empty ? (
          <Card style={{ paddingVertical: 24 }}>
            <EmptyState
              title="Ce dossier est vide"
              body="Crée un sous-dossier ou classe ici un original depuis l’analyse de Bob."
              cta={{ label: 'Créer un sous-dossier', onPress: openCreate }}
            />
          </Card>
        ) : null}
      </ScrollView>

      <Sheet visible={managementOpen} onClose={() => setManagementOpen(false)}>
        <Text accessibilityRole="header" selectable style={[font('pageTitle'), { fontSize: 20, color: colors.ink900 }]}>
          Gérer « {currentFolder.name} »
        </Text>
        <Text selectable style={[font('sub'), { color: colors.slate500, lineHeight: 19, marginTop: 4 }]}>Les changements d’organisation n’altèrent jamais le document comptable ni son original.</Text>

        <Button title="Renommer le dossier" variant="secondary" style={{ marginTop: 16 }} onPress={openRename} />
        <Button title="Créer un sous-dossier" variant="secondary" style={{ marginTop: 10 }} onPress={openCreate} />

        <View
          style={{
            flexDirection: 'row',
            alignItems: 'flex-start',
            gap: 10,
            backgroundColor: semantic.warningBg,
            borderRadius: 14,
            padding: 12,
            marginTop: 16,
          }}
        >
          <LockIcon color={semantic.warning} size={16} />
          <Text selectable style={[font('meta'), { color: colors.slate500, flex: 1, lineHeight: 18 }]}>
            {currentFolder.systemKey !== null
              ? 'Ce dossier structure le coffre de Bob : tu peux le renommer, mais pas le supprimer. Les originaux restent ainsi toujours classables.'
              : 'Bob calcule d’abord un aperçu complet. Si le dossier contient des éléments, tu devras choisir leur destination avant toute suppression.'}
          </Text>
        </View>
        <Button
          title="Supprimer le dossier"
          variant="danger"
          disabled={currentFolder.systemKey !== null || previewDeletion.isPending}
          loading={previewDeletion.isPending}
          accessibilityLabel={currentFolder.systemKey !== null ? 'Dossier système protégé contre la suppression' : 'Prévisualiser la suppression sûre du dossier'}
          style={{ marginTop: 10 }}
          onPress={openDeletionPreview}
        />
      </Sheet>

      <Sheet visible={deletionOpen} onClose={closeDeletion}>
        {previewDeletion.isPending ? (
          <View
            accessibilityRole="progressbar"
            accessibilityLiveRegion="polite"
            accessibilityLabel="Calcul de l’aperçu de suppression"
            style={{ minHeight: 150, alignItems: 'center', justifyContent: 'center', gap: 12 }}
          >
            <ActivityIndicator color={semantic.warning} />
            <Text style={[font('sub'), { color: colors.slate500 }]}>Bob vérifie chaque document et sous-dossier…</Text>
          </View>
        ) : previewDeletion.isError || !previewDeletion.data ? (
          <>
            <Text accessibilityRole="header" style={[font('pageTitle'), { fontSize: 20, color: colors.ink900 }]}>Aperçu indisponible</Text>
            <Text accessibilityRole="alert" selectable style={[font('sub'), { color: semantic.danger, lineHeight: 20, marginTop: 8 }]}>Le dossier a changé ou la vérification n’a pas abouti. Aucun élément n’a été déplacé ni supprimé.</Text>
            <View style={{ flexDirection: 'row', gap: 10, marginTop: 18 }}>
              <Button title="Annuler" variant="secondary" style={{ flex: 1 }} onPress={closeDeletion} />
              <Button title="Recalculer" style={{ flex: 1 }} onPress={openDeletionPreview} />
            </View>
          </>
        ) : (
          <>
            <Text accessibilityRole="header" selectable style={[font('pageTitle'), { fontSize: 20, color: colors.ink900 }]}>Supprimer « {previewDeletion.data.folder.name} » ?</Text>
            <Text selectable style={[font('sub'), { color: colors.slate500, lineHeight: 20, marginTop: 6 }]}>L’original de chaque document est protégé. Cette confirmation expire automatiquement et ne peut servir qu’une fois.</Text>

            <View style={{ backgroundColor: semantic.dangerBg, borderRadius: 15, padding: 13, marginTop: 15, gap: 5 }}>
              <Text selectable style={[font('body', 700), { color: colors.ink900 }]}>
                {previewDeletion.data.documentCount} document{previewDeletion.data.documentCount > 1 ? 's' : ''} · {previewDeletion.data.descendantFolderCount} sous-dossier{previewDeletion.data.descendantFolderCount > 1 ? 's' : ''}
              </Text>
              <Text selectable style={[font('meta'), { color: colors.slate500, lineHeight: 18 }]}>L’aperçu est verrouillé sur les versions actuellement affichées. Toute modification impose une nouvelle vérification.</Text>
            </View>

            {!previewDeletion.data.canDeleteEmpty ? (
              <View style={{ marginTop: 16 }}>
                <Text style={[font('label', 700), { color: colors.slate400, fontSize: 12 }]}>TRANSFÉRER AVANT SUPPRESSION</Text>
                <Text selectable style={[font('sub'), { color: colors.slate500, lineHeight: 19, marginTop: 4 }]}>Choisis le dossier qui recevra les documents directs et les sous-dossiers, avec tout leur contenu.</Text>
                {rootFolders.isLoading ? (
                  <View
                    accessibilityRole="progressbar"
                    accessibilityLiveRegion="polite"
                    accessibilityLabel="Chargement des destinations de transfert"
                    style={{ marginTop: 10, gap: 8 }}
                  >
                    <Skeleton height={48} radius={13} />
                    <Skeleton height={48} radius={13} />
                  </View>
                ) : rootFolders.isError ? (
                  <View style={{ marginTop: 10 }}>
                    <ErrorRetry
                      message="Les destinations de transfert n’ont pas pu être chargées. Aucun dossier ne sera supprimé."
                      onRetry={() => void rootFolders.refetch()}
                      retrying={rootFolders.isRefetching}
                    />
                  </View>
                ) : transferTargets.length === 0 ? (
                  <Text accessibilityRole="alert" style={[font('sub'), { color: semantic.danger, marginTop: 8 }]}>Crée d’abord un autre dossier : aucune destination sûre n’est disponible.</Text>
                ) : (
                  <ScrollView style={{ maxHeight: 230, marginTop: 10 }} nestedScrollEnabled>
                    {transferTargets.map((target) => {
                      const selected = transferTargetId === target.id;
                      return (
                        <Pressable
                          key={target.id}
                          accessibilityRole="radio"
                          accessibilityState={{ selected }}
                          accessibilityLabel={`Transférer vers ${target.name}`}
                          onPress={() => setTransferTargetId(target.id)}
                          style={({ pressed }) => ({
                            minHeight: 48,
                            flexDirection: 'row',
                            alignItems: 'center',
                            gap: 10,
                            borderWidth: 1.5,
                            borderColor: selected ? semantic.success : colors.lineSoft,
                            borderRadius: 13,
                            paddingHorizontal: 12,
                            marginBottom: 8,
                            opacity: pressed ? 0.78 : 1,
                          })}
                        >
                          <View style={{ width: 22, height: 22, borderRadius: 11, borderWidth: 2, borderColor: selected ? semantic.success : colors.slate300, alignItems: 'center', justifyContent: 'center', backgroundColor: selected ? semantic.success : colors.surface }}>
                            {selected ? <CheckIcon color={colors.surface} size={13} /> : null}
                          </View>
                          <FolderSmallIcon color={semantic.b2b} size={18} />
                          <Text numberOfLines={1} style={[font('sub', 700), { color: colors.ink900, flex: 1 }]}>{target.name}</Text>
                        </Pressable>
                      );
                    })}
                  </ScrollView>
                )}
              </View>
            ) : null}

            {executeDeletion.isError ? (
              <Text accessibilityRole="alert" selectable style={[font('sub'), { color: semantic.danger, lineHeight: 19, marginTop: 10 }]}>La confirmation a expiré ou le contenu a changé. Aucun original n’a été supprimé : recalcule l’aperçu.</Text>
            ) : null}

            <View style={{ flexDirection: 'row', gap: 10, marginTop: 18 }}>
              <Button title="Annuler" variant="secondary" style={{ flex: 1 }} disabled={executeDeletion.isPending} onPress={closeDeletion} />
              {executeDeletion.isError ? (
                <Button title="Recalculer" style={{ flex: 1 }} onPress={openDeletionPreview} />
              ) : (
                <Button
                  title={previewDeletion.data.canDeleteEmpty ? 'Supprimer' : 'Transférer et supprimer'}
                  variant="danger"
                  style={{ flex: 1 }}
                  loading={executeDeletion.isPending}
                  disabled={executeDeletion.isPending || (!previewDeletion.data.canDeleteEmpty && transferTarget === null)}
                  onPress={confirmDeletion}
                />
              )}
            </View>
          </>
        )}
      </Sheet>

      <Sheet visible={editor !== null} onClose={closeEditor}>
        <KeyboardAvoidingView {...(process.env.EXPO_OS === 'ios' ? { behavior: 'padding' as const } : {})}>
          {editor ? (
            <>
              <Text accessibilityRole="header" style={[font('pageTitle'), { fontSize: 20, color: colors.ink900 }]}>
                {editor.kind === 'create' ? 'Nouveau sous-dossier' : 'Renommer le dossier'}
              </Text>
              <Text selectable style={[font('sub'), { color: colors.slate500, lineHeight: 19, marginTop: 4 }]}>
                {editor.kind === 'create'
                  ? `Il sera créé dans « ${currentFolder.name} ».`
                  : 'Les documents restent au même emplacement et conservent toute leur traçabilité.'}
              </Text>

              <Text style={[font('label', 700), { fontSize: 12, color: colors.slate400, marginTop: 16 }]}>NOM DU DOSSIER</Text>
              <TextInput
                autoFocus
                value={editor.name}
                onChangeText={(name) => {
                  setEditor({ ...editor, name });
                  setEditorError(null);
                }}
                maxLength={80}
                autoCapitalize="sentences"
                autoCorrect
                returnKeyType="done"
                onSubmitEditing={submitEditor}
                accessibilityLabel="Nom du dossier"
                accessibilityHint="80 caractères maximum. Les barres obliques sont interdites."
                placeholder="Ex. Contrats clients"
                placeholderTextColor={colors.slate300}
                style={[
                  font('body'),
                  {
                    minHeight: 46,
                    marginTop: 7,
                    borderWidth: 1,
                    borderColor: editorError ? semantic.danger : colors.lineSoft,
                    borderRadius: 12,
                    paddingVertical: 11,
                    paddingHorizontal: 13,
                    color: colors.ink800,
                  },
                ]}
              />
              <Text selectable style={[font('meta'), { color: colors.slate300, textAlign: 'right', marginTop: 4, fontVariant: ['tabular-nums'] }]}>{editor.name.length}/80</Text>

              {editorError ? (
                <Text accessibilityRole="alert" selectable style={[font('sub'), { color: semantic.danger, lineHeight: 19, marginTop: 8 }]}>{editorError}</Text>
              ) : null}

              <View style={{ flexDirection: 'row', gap: 10, marginTop: 16 }}>
                <Button title="Annuler" variant="secondary" style={{ flex: 1 }} onPress={closeEditor} />
                <Button
                  title={editor.kind === 'create' ? 'Créer' : 'Enregistrer'}
                  disabled={!validateDocumentFolderName(editor.name).ok}
                  loading={createFolder.isPending || updateFolder.isPending}
                  style={{ flex: 1 }}
                  onPress={submitEditor}
                />
              </View>
            </>
          ) : null}
        </KeyboardAvoidingView>
      </Sheet>

      <Toast
        message={toast ?? ''}
        visible={toast !== null}
        onHide={() => setToast(null)}
        icon={<CheckIcon color={colors.surface} />}
      />
    </View>
  );

  function FolderRow({ folder: child }: { readonly folder: DocumentFolderView }) {
    const longPressHandled = useRef(false);
    const open = (): void => {
      if (longPressHandled.current) {
        longPressHandled.current = false;
        return;
      }
      router.push(`/documents/folder/${child.id}`);
    };
    const manage = (): void => {
      longPressHandled.current = true;
      router.push({ pathname: '/documents/folder/[id]', params: { id: child.id, manage: '1' } });
    };
    return (
      <Pressable
        accessibilityRole="button"
        accessibilityLabel={`Sous-dossier ${child.name}`}
        accessibilityHint="Ouvre le sous-dossier. Un appui long affiche ses options."
        accessibilityActions={[
          { name: 'activate', label: 'Ouvrir le sous-dossier' },
          { name: 'longpress', label: 'Gérer le sous-dossier' },
        ]}
        onAccessibilityAction={(event) => {
          if (event.nativeEvent.actionName === 'longpress') manage();
          else if (event.nativeEvent.actionName === 'activate') open();
        }}
        onPress={open}
        onLongPress={manage}
        delayLongPress={450}
        style={({ pressed }) => ({
          minHeight: 66,
          flexDirection: 'row',
          alignItems: 'center',
          gap: 12,
          backgroundColor: colors.surface,
          borderWidth: 1,
          borderColor: controls.cardBorder,
          borderRadius: 17,
          paddingVertical: 12,
          paddingHorizontal: 14,
          opacity: pressed ? 0.76 : 1,
          transform: [{ scale: pressed ? 0.99 : 1 }],
          ...shadowNative.e1,
        })}
      >
        <View
          style={{
            width: 40,
            height: 40,
            borderRadius: 12,
            backgroundColor: semantic.b2bBg,
            alignItems: 'center',
            justifyContent: 'center',
          }}
        >
          <FolderSmallIcon color={semantic.b2b} size={20} />
        </View>
        <View style={{ flex: 1, minWidth: 0 }}>
          <Text selectable numberOfLines={1} style={[font('body', 700), { color: colors.ink900 }]}>{child.name}</Text>
          <Text selectable style={[font('meta'), { color: colors.slate400, marginTop: 2 }]}>Sous-dossier</Text>
        </View>
        <ChevronRightIcon color={colors.slate400} size={18} />
      </Pressable>
    );
  }

  function DocumentRow({ document }: { readonly document: DocumentView }) {
    return (
      <Pressable
        accessibilityRole="button"
        accessibilityLabel={`${document.filename}, original ${mimeLabel(document.mimeType)} conservé`}
        accessibilityHint="Ouvre l’original, l’analyse de Bob et sa traçabilité."
        onPress={() => router.push(`/documents/${document.id}`)}
        style={({ pressed }) => ({
          minHeight: 86,
          flexDirection: 'row',
          alignItems: 'center',
          gap: 12,
          backgroundColor: colors.surface,
          borderWidth: 1,
          borderColor: controls.cardBorder,
          borderRadius: 17,
          padding: 14,
          opacity: pressed ? 0.76 : 1,
          transform: [{ scale: pressed ? 0.99 : 1 }],
          ...shadowNative.e1,
        })}
      >
        <View
          style={{
            width: 42,
            height: 50,
            borderRadius: 11,
            backgroundColor: semantic.aiBg,
            alignItems: 'center',
            justifyContent: 'center',
          }}
        >
          <FileTextIcon color={semantic.ai} size={21} />
        </View>
        <View style={{ flex: 1, minWidth: 0 }}>
          <Text selectable numberOfLines={1} style={[font('body', 700), { color: colors.ink900 }]}>{document.filename}</Text>
          <Text selectable numberOfLines={1} style={[font('meta'), { color: semantic.success, marginTop: 3 }]}>Original conservé · {mimeLabel(document.mimeType)} · {bytesLabel(document.byteSize)}</Text>
          <Text selectable numberOfLines={1} style={[font('meta'), { color: colors.slate400, marginTop: 2 }]}>Version {document.version} · jusqu’au {formatDate(document.retentionUntil)} · empreinte {document.sha256.slice(0, 8)}…</Text>
        </View>
        <ChevronRightIcon color={colors.slate400} size={18} />
      </Pressable>
    );
  }

}
