/**
 * Fiche chantier/projet (extension V1 du module vertical Chantiers) — journal de notes
 * horodatées (création manuelle ET vocale, « ajoute une note : … » préremplit le composeur,
 * seul le tap Ajouter écrit) + grille de photos (appareil photo/galerie, plein écran,
 * suppression ConfirmSheet). Le titre de la fiche est le nom donné par l'utilisateur — aucun
 * texte de cet écran ne prononce « chantier » en dur : terminologie adaptative appliquée en
 * amont (onglet et création depuis la fiche client) ET ici même (permission appareil photo,
 * seule copie de cet écran qui nommait encore le regroupement — cf. tradeToWorksiteTerminology).
 *
 * Octets des photos : DocumentStoragePort (même stockage que le coffre documents) derrière le
 * port applicatif WorksiteMediaStorage — la migration Cloudflare R2 (post-V1) ne touchera QUE
 * l'implémentation de ce port, jamais cet écran.
 *
 * DONNÉES 100 % RÉELLES : useChantiers (liste déjà en cache) + useChantierNotes/useWorksitePhotos
 * dédiés à cette fiche. AUCUN repli fixtures : loading → skeletons · erreur → voix de Bob ·
 * chantier introuvable → chantierFiche.notFound + retour.
 */
import { useMemo, useState } from 'react';
import {
  Alert,
  Image,
  Modal,
  Pressable,
  RefreshControl,
  ScrollView,
  Text,
  TextInput,
  View,
} from 'react-native';
import { useLocalSearchParams, useRouter } from 'expo-router';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import * as ImagePicker from 'expo-image-picker';
import { tradeToWorksiteTerminology } from '@bob/core';
import { shadowNative } from '@bob/tokens';
import { t } from '@bob/i18n';
import {
  Button,
  Card,
  EmptyState,
  ErrorRetry,
  Sheet,
  Skeleton,
  SkeletonRow,
  StatusBadge,
  font,
  useTheme,
} from '@bob/ui';
import {
  useAddChantierNote,
  useChantierNotes,
  useChantiers,
  useDeleteWorksitePhoto,
  useProfile,
  useUploadWorksitePhoto,
  useWorksitePhotos,
  useWorksitePhotoUrl,
} from '../../src/data/hooks';
import { useConfirm } from '../../src/components/ConfirmSheet';
import { usePublishAgentContext, type AgentContext, type AgentSurface } from '../../src/agent';
import { CameraIcon, ChevronLeftIcon, CloseIcon, TrashIcon } from '../../src/components/icons';
import { useBobAwareScrollInsets } from '../../src/components/use-bob-aware-scroll-insets';
import { DEFAULT_WORKSITE_TERM, worksiteParamsFor } from '../../src/lib/worksite-terminology';

const MONTHS_SHORT = [
  'janv.', 'févr.', 'mars', 'avr.', 'mai', 'juin',
  'juil.', 'août', 'sept.', 'oct.', 'nov.', 'déc.',
] as const;

/** « 2026-07-17T10:32:00.000Z » → « 17 juil. · 10:32 » (heure locale, sans Intl). */
function frDateTime(iso: string): string {
  const d = new Date(iso);
  const month = MONTHS_SHORT[d.getMonth()] ?? '';
  const hh = String(d.getHours()).padStart(2, '0');
  const mm = String(d.getMinutes()).padStart(2, '0');
  return `${d.getDate()} ${month} · ${hh}:${mm}`;
}

function frDate(dateOnly: string): string {
  const [year, month, day] = dateOnly.split('-');
  return year && month && day ? `${day}/${month}/${year}` : dateOnly;
}

/** Extrait le texte d'une note dictée — « ajoute une note : … » / « note, … » (utterance BRUTE,
 * la ponctuation ':'/',' est significative ici, contrairement à normalizeVoiceText). */
function extractVoiceNoteText(utterance: string): string | null {
  const trimmed = utterance.trim();
  const m =
    /(?:ajoute(?:r)?|mets|note|écris|ecris)\s+(?:une\s+)?note\s*[:,]?\s*(.+)/i.exec(trimmed) ??
    /^note\s*[:,]?\s*(.+)/i.exec(trimmed);
  const text = m?.[1]?.trim();
  return text && text.length > 0 ? text : null;
}

function PhotoThumbnail({
  photoId,
  onOpen,
}: {
  photoId: string;
  onOpen: (photoId: string) => void;
}) {
  const { colors } = useTheme();
  const url = useWorksitePhotoUrl(photoId);
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={t('chantierFiche.photoOpen', { personality: 'pote' })}
      onPress={() => onOpen(photoId)}
      style={{
        width: '31.5%',
        aspectRatio: 1,
        borderRadius: 12,
        overflow: 'hidden',
        backgroundColor: colors.lineSoft,
      }}
    >
      {url.isLoading ? (
        <View style={{ flex: 1, backgroundColor: colors.lineSoft }} />
      ) : url.isSuccess ? (
        <Image source={{ uri: url.data.url }} style={{ width: '100%', height: '100%' }} resizeMode="cover" />
      ) : (
        <View style={{ flex: 1, alignItems: 'center', justifyContent: 'center' }}>
          <CloseIcon color={colors.slate300} size={16} />
        </View>
      )}
    </Pressable>
  );
}

export default function ChantierDetail() {
  const { personality, colors, semantic, theme } = useTheme();
  const insets = useSafeAreaInsets();
  const router = useRouter();
  const params = useLocalSearchParams<{ id: string }>();
  const id = typeof params.id === 'string' ? params.id : '';

  const chantiers = useChantiers();
  const chantier = (chantiers.data ?? []).find((c) => c.id === id) ?? null;
  const profile = useProfile();

  // Terminologie adaptative par métier (tradeToWorksiteTerminology @bob/core) — seule copie de
  // cette fiche qui nomme encore le regroupement (permission appareil photo).
  const worksiteTerm = profile.data ? tradeToWorksiteTerminology(profile.data.trade) : DEFAULT_WORKSITE_TERM;
  const worksiteParams = worksiteParamsFor(worksiteTerm);

  const notes = useChantierNotes(id);
  const addNote = useAddChantierNote(id);
  const photos = useWorksitePhotos(id);
  const uploadPhoto = useUploadWorksitePhoto(id);
  const deletePhoto = useDeleteWorksitePhoto(id);
  const confirm = useConfirm();
  const bobScrollInsets = useBobAwareScrollInsets({ minimumBottom: insets.bottom + 40 });

  const [noteDraft, setNoteDraft] = useState('');
  const [noteError, setNoteError] = useState(false);
  const [photoSourceOpen, setPhotoSourceOpen] = useState(false);
  const [photoError, setPhotoError] = useState<string | null>(null);
  const [fullscreenPhotoId, setFullscreenPhotoId] = useState<string | null>(null);

  const agentContext = useMemo<AgentContext>(
    () => ({
      screen: { name: 'chantier-detail', instanceId: `chantier:${id}` },
      entities: chantier ? [{ type: 'chantier' as const, id: chantier.id, label: chantier.name }] : [],
      capabilities: chantier ? ['screen.read', 'chantier.read'] : ['screen.read'],
    }),
    [chantier, id],
  );
  // Pouvoir vocal LOCAL (S2-GUIDÉ) : « ajoute une note : fuite réparée, reste le joint du
  // ballon » PRÉREMPLIT le composeur — jamais d'écriture directe, le tap Ajouter reste le seul
  // point d'écriture (même contrat que les affordances devis/[id].tsx).
  const voiceSurface = useMemo<AgentSurface>(
    () => ({
      affordances: [
        {
          id: 'chantierFiche.addNoteVoice',
          match: (utterance: string) => {
            const text = extractVoiceNoteText(utterance);
            if (!text) return null;
            return () => {
              setNoteDraft(text);
              return { say: t('chantierFiche.voiceNoteOpened', { personality }) };
            };
          },
        },
      ],
    }),
    [personality],
  );
  usePublishAgentContext(agentContext, undefined, voiceSurface);

  const goBack = (): void => {
    if (router.canGoBack()) router.back();
    else router.replace('/(tabs)/clients');
  };

  const submitNote = (): void => {
    const text = noteDraft.trim();
    if (!text || addNote.isPending) return;
    setNoteError(false);
    addNote.mutate(
      { text },
      {
        onSuccess: () => setNoteDraft(''),
        onError: () => setNoteError(true),
      },
    );
  };

  const pickPhoto = async (source: 'camera' | 'library'): Promise<void> => {
    setPhotoSourceOpen(false);
    setPhotoError(null);
    const perm =
      source === 'camera'
        ? await ImagePicker.requestCameraPermissionsAsync()
        : await ImagePicker.requestMediaLibraryPermissionsAsync();
    if (!perm.granted) {
      setPhotoError(
        t(source === 'camera' ? 'chantierFiche.photoPermissionCamera' : 'chantierFiche.photoPermissionLibrary', {
          personality,
          params: worksiteParams,
        }),
      );
      return;
    }
    // Compression via l'option native ImagePicker (quality 0.6) — aucune dépendance native
    // supplémentaire (expo-image-manipulator n'est pas installé ; scan-document.tsx, à l'inverse,
    // n'en a pas besoin car il capture des documents en pleine qualité avec un plafond 10 Mo).
    const options: ImagePicker.ImagePickerOptions = { base64: true, quality: 0.6, mediaTypes: ['images'] };
    const res =
      source === 'camera' ? await ImagePicker.launchCameraAsync(options) : await ImagePicker.launchImageLibraryAsync(options);
    if (res.canceled) return;
    const asset = res.assets[0];
    if (!asset?.base64) {
      setPhotoError(t('chantierFiche.photoUploadError', { personality }));
      return;
    }
    uploadPhoto.mutate(
      {
        contentBase64: asset.base64,
        mimeType: asset.mimeType ?? 'image/jpeg',
        filename: asset.fileName ?? `photo-${Date.now()}.jpg`,
      },
      { onError: () => setPhotoError(t('chantierFiche.photoUploadError', { personality })) },
    );
  };

  const confirmDeletePhoto = async (photoId: string): Promise<void> => {
    const ok = await confirm({
      title: t('chantierFiche.photoDeleteConfirmTitle', { personality }),
      message: t('chantierFiche.photoDeleteConfirmBody', { personality }),
      challenge: { kind: 'tap' },
      destructive: true,
    });
    if (!ok) return;
    deletePhoto.mutate(photoId, {
      onSuccess: () => setFullscreenPhotoId(null),
      onError: () => Alert.alert('Oups', t('chantierFiche.photoDeleteError', { personality })),
    });
  };

  const refresh = (): void => {
    void Promise.all([chantiers.refetch(), notes.refetch(), photos.refetch()]);
  };

  const booting = chantiers.isLoading;
  const notFound = !booting && !chantiers.isError && chantier === null;
  const fullscreenUrl = useWorksitePhotoUrl(fullscreenPhotoId ?? '', fullscreenPhotoId !== null);

  return (
    <View style={{ flex: 1, backgroundColor: colors.bg }}>
      <View
        style={{
          paddingTop: insets.top + 8,
          paddingHorizontal: 18,
          flexDirection: 'row',
          alignItems: 'center',
        }}
      >
        <Pressable
          accessibilityRole="button"
          accessibilityLabel={t('chantierFiche.back', { personality })}
          onPress={goBack}
          hitSlop={8}
          style={{ flexDirection: 'row', alignItems: 'center', gap: 3, minHeight: 44 }}
        >
          <ChevronLeftIcon color={colors.ink800} />
          <Text style={[font('body', 600), { color: colors.ink800 }]}>
            {t('chantierFiche.back', { personality })}
          </Text>
        </Pressable>
      </View>

      {booting ? (
        <View style={{ paddingHorizontal: 18, paddingTop: 14, gap: 12 }}>
          <Skeleton height={26} width="60%" radius={8} />
          <Skeleton height={16} width="40%" radius={6} />
          <SkeletonRow avatar="square" trailing="pill" style={{ minHeight: 60 }} />
        </View>
      ) : chantiers.isError ? (
        <View style={{ paddingHorizontal: 18, paddingTop: 14 }}>
          <ErrorRetry
            message={t('chantierFiche.dataError', { personality })}
            onRetry={() => void chantiers.refetch()}
            retrying={chantiers.isRefetching}
          />
        </View>
      ) : notFound ? (
        <View style={{ paddingHorizontal: 18, paddingTop: 14 }}>
          <Card>
            <EmptyState body={t('chantierFiche.notFound', { personality })} />
          </Card>
        </View>
      ) : chantier === null ? null : (
        <ScrollView
          style={{ flex: 1 }}
          contentContainerStyle={{ paddingHorizontal: 18, paddingTop: 14, paddingBottom: bobScrollInsets.paddingBottom }}
          automaticallyAdjustKeyboardInsets={bobScrollInsets.automaticallyAdjustKeyboardInsets}
          scrollIndicatorInsets={{ bottom: bobScrollInsets.scrollIndicatorBottom }}
          refreshControl={
            <RefreshControl
              refreshing={chantiers.isRefetching || notes.isRefetching || photos.isRefetching}
              onRefresh={refresh}
              tintColor={colors.ink800}
              colors={[colors.ink800]}
            />
          }
        >
          {/* ── En-tête : nom, adresse, statut ── */}
          <View style={{ flexDirection: 'row', alignItems: 'flex-start', justifyContent: 'space-between', gap: 12 }}>
            <View style={{ flex: 1 }}>
              <Text style={[font('pageTitle'), { fontSize: 22, color: colors.ink900 }]}>{chantier.name}</Text>
              {chantier.address ? (
                <Text style={[font('sub'), { color: colors.slate500, marginTop: 4 }]}>{chantier.address}</Text>
              ) : null}
              <Text style={[font('meta'), { color: colors.slate400, marginTop: 5 }]}>
                {t('chantiers.openedOn', { personality, params: { date: frDate(chantier.openedAt) } })}
              </Text>
              {chantier.notes ? (
                <Text style={[font('sub'), { color: colors.slate500, marginTop: 8, lineHeight: 19 }]}>
                  {chantier.notes}
                </Text>
              ) : null}
            </View>
            <StatusBadge
              label={t(chantier.status === 'open' ? 'chantiers.open' : 'chantiers.closed', { personality })}
              variant={chantier.status === 'open' ? 'b2b' : 'success'}
            />
          </View>

          {/* ── Journal (notes horodatées) ── */}
          <Text style={[font('label', 700), { fontSize: 13, color: colors.slate500, marginTop: 26, marginBottom: 10 }]}>
            {t('chantierFiche.notesTitle', { personality })}
          </Text>
          {notes.isLoading ? (
            <SkeletonRow avatar="square" trailing={false} style={{ minHeight: 58 }} />
          ) : notes.isError ? (
            <ErrorRetry
              message={t('chantierFiche.dataError', { personality })}
              onRetry={() => void notes.refetch()}
              retrying={notes.isRefetching}
            />
          ) : (notes.data ?? []).length === 0 ? (
            <Card>
              <EmptyState body={t('chantierFiche.notesEmpty', { personality })} />
            </Card>
          ) : (
            <Card radius={16} padding={0} style={{ paddingHorizontal: 14 }}>
              {(notes.data ?? []).map((note, index) => (
                <View
                  key={note.id}
                  style={{
                    paddingVertical: 11,
                    borderBottomWidth: index < (notes.data ?? []).length - 1 ? 1 : 0,
                    borderBottomColor: colors.lineSoft,
                  }}
                >
                  <Text style={[font('sub'), { color: colors.ink800, lineHeight: 19 }]}>{note.text}</Text>
                  <Text style={[font('meta'), { color: colors.slate400, marginTop: 4 }]}>
                    {t('chantierFiche.noteAuthorDate', {
                      personality,
                      params: { author: note.authorLabel, date: frDateTime(note.createdAt) },
                    })}
                  </Text>
                </View>
              ))}
            </Card>
          )}

          <View style={{ flexDirection: 'row', gap: 8, marginTop: 10, alignItems: 'flex-end' }}>
            <TextInput
              value={noteDraft}
              onChangeText={setNoteDraft}
              placeholder={t('chantierFiche.notePlaceholder', { personality })}
              placeholderTextColor={colors.slate300}
              accessibilityLabel={t('chantierFiche.notesTitle', { personality })}
              multiline
              style={[
                font('body'),
                {
                  flex: 1,
                  minHeight: 44,
                  maxHeight: 110,
                  borderWidth: 1,
                  borderColor: colors.lineSoft,
                  borderRadius: 12,
                  paddingHorizontal: 13,
                  paddingVertical: 11,
                  color: colors.ink800,
                },
              ]}
            />
            <Button
              title={t('chantierFiche.noteSubmit', { personality })}
              size="compact"
              disabled={!noteDraft.trim()}
              loading={addNote.isPending}
              onPress={submitNote}
            />
          </View>
          {noteError ? (
            <Text accessibilityRole="alert" style={[font('sub'), { color: semantic.danger, marginTop: 8 }]}>
              {t('chantierFiche.noteError', { personality })}
            </Text>
          ) : null}

          {/* ── Photos ── */}
          <View
            style={{
              flexDirection: 'row',
              alignItems: 'center',
              justifyContent: 'space-between',
              marginTop: 28,
              marginBottom: 10,
            }}
          >
            <Text style={[font('label', 700), { fontSize: 13, color: colors.slate500 }]}>
              {t('chantierFiche.photosTitle', { personality })}
            </Text>
            <Pressable
              accessibilityRole="button"
              accessibilityLabel={t('chantierFiche.photoAdd', { personality })}
              onPress={() => setPhotoSourceOpen(true)}
              hitSlop={8}
              style={({ pressed }) => [
                {
                  width: 44,
                  height: 44,
                  borderRadius: 22,
                  backgroundColor: theme.ink,
                  alignItems: 'center',
                  justifyContent: 'center',
                  ...shadowNative.e1,
                },
                pressed && { transform: [{ scale: 0.94 }] },
              ]}
            >
              <CameraIcon color={colors.surface} size={18} />
            </Pressable>
          </View>
          {photos.isLoading ? (
            <SkeletonRow avatar="square" trailing={false} style={{ minHeight: 58 }} />
          ) : photos.isError ? (
            <ErrorRetry
              message={t('chantierFiche.dataError', { personality })}
              onRetry={() => void photos.refetch()}
              retrying={photos.isRefetching}
            />
          ) : (photos.data ?? []).length === 0 ? (
            <Card>
              <EmptyState
                body={t('chantierFiche.photosEmpty', { personality })}
                cta={{ label: t('chantierFiche.photoAdd', { personality }), onPress: () => setPhotoSourceOpen(true) }}
              />
            </Card>
          ) : (
            <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: '2.5%' }}>
              {(photos.data ?? []).map((photo) => (
                <PhotoThumbnail key={photo.id} photoId={photo.id} onOpen={setFullscreenPhotoId} />
              ))}
            </View>
          )}
          {photoError ? (
            <Text accessibilityRole="alert" style={[font('sub'), { color: semantic.danger, marginTop: 8 }]}>
              {photoError}
            </Text>
          ) : null}
          {uploadPhoto.isPending ? (
            <View style={{ marginTop: 10 }}>
              <Skeleton height={13} width="50%" radius={6} />
            </View>
          ) : null}
        </ScrollView>
      )}

      {/* ── Choix de la source photo ── */}
      <Sheet visible={photoSourceOpen} onClose={() => setPhotoSourceOpen(false)}>
        <Text style={[font('pageTitle'), { fontSize: 18, color: colors.ink900, marginBottom: 14 }]}>
          {t('chantierFiche.photoSourceTitle', { personality })}
        </Text>
        <Button
          title={t('chantierFiche.photoSourceCamera', { personality })}
          onPress={() => void pickPhoto('camera')}
          style={{ marginBottom: 10 }}
        />
        <Button
          title={t('chantierFiche.photoSourceLibrary', { personality })}
          variant="secondary"
          onPress={() => void pickPhoto('library')}
        />
      </Sheet>

      {/* ── Plein écran ── */}
      <Modal visible={fullscreenPhotoId !== null} transparent animationType="fade" onRequestClose={() => setFullscreenPhotoId(null)}>
        <View style={{ flex: 1, backgroundColor: 'rgba(0,0,0,0.92)' }}>
          <View
            style={{
              paddingTop: insets.top + 8,
              paddingHorizontal: 16,
              flexDirection: 'row',
              justifyContent: 'space-between',
            }}
          >
            <Pressable
              accessibilityRole="button"
              accessibilityLabel={t('chantierFiche.photoClose', { personality })}
              onPress={() => setFullscreenPhotoId(null)}
              hitSlop={8}
              style={{ width: 44, height: 44, alignItems: 'center', justifyContent: 'center' }}
            >
              <CloseIcon color="#ffffff" size={20} />
            </Pressable>
            <Pressable
              accessibilityRole="button"
              accessibilityLabel={t('chantierFiche.photoDelete', { personality })}
              onPress={() => fullscreenPhotoId && void confirmDeletePhoto(fullscreenPhotoId)}
              hitSlop={8}
              style={{ width: 44, height: 44, alignItems: 'center', justifyContent: 'center' }}
            >
              <TrashIcon color="#ffffff" size={19} />
            </Pressable>
          </View>
          <View style={{ flex: 1, alignItems: 'center', justifyContent: 'center' }}>
            {fullscreenUrl.isLoading ? (
              <Skeleton height={280} width="86%" radius={12} />
            ) : fullscreenUrl.isSuccess ? (
              <Image
                source={{ uri: fullscreenUrl.data.url }}
                style={{ width: '100%', height: '80%' }}
                resizeMode="contain"
              />
            ) : (
              <Text style={[font('sub'), { color: '#ffffff' }]}>
                {t('chantierFiche.photoLoadError', { personality })}
              </Text>
            )}
          </View>
        </View>
      </Modal>
    </View>
  );
}
