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
import { deriveChantierPieces, formatEUR, tradeToWorksiteTerminology } from '@bob/core';
import { overlays, shadowNative } from '@bob/tokens';
import { t } from '@bob/i18n';
import {
  BobSurface,
  Button,
  Card,
  EmptyState,
  ErrorRetry,
  PhotoViewer,
  SectionHeader,
  Sheet,
  Skeleton,
  SkeletonRow,
  StatusBadge,
  font,
  useTheme,
} from '@bob/ui';
import {
  useAddChantierNote,
  useChantierEquipments,
  useChantierNotes,
  useChantiers,
  useDeleteWorksitePhoto,
  useExpenses,
  useInvoices,
  useProfile,
  useQuotes,
  useUploadWorksitePhoto,
  useWorksitePhotos,
  useWorksitePhotoUrl,
} from '../../src/data/hooks';
import { INVOICE_BADGE, QUOTE_BADGE } from '../../src/components/invoice-badge.logic';
import { chantierExpensesTotalCents, expensesForChantier } from '../../src/expenses/chantier-expenses';
import { RetenueSuiviCard } from '../../src/components/RetenueSuiviCard';
import { useConfirm } from '../../src/components/ConfirmSheet';
import { usePublishAgentContext, type AgentContext, type AgentSurface } from '../../src/agent';
import { CameraIcon, ChevronLeftIcon, CloseIcon } from '../../src/components/icons';
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
  // BUG corrigé (Lot 4, correction de comportement assumée) : personality:'pote' était
  // hardcodée dans t() — l'utilisateur en « pro »/« direct » entendait la voix « pote »
  // sur chaque miniature. La personnalité vient du thème, comme partout.
  const { personality, colors } = useTheme();
  const url = useWorksitePhotoUrl(photoId);
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={t('chantierFiche.photoOpen', { personality })}
      onPress={() => onOpen(photoId)}
      style={{
        width: '31%',
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
  // Dépenses imputées au chantier — filtre CLIENT sur la liste déjà servie par useExpenses
  // (aucun endpoint dédié) : logique pure testée, total TTC simple.
  const expenses = useExpenses();
  const linkedExpenses = useMemo(
    () => expensesForChantier(expenses.data ?? [], id),
    [expenses.data, id],
  );
  // PR-08 — pièces du site : dérivation PURE (deriveChantierPieces @bob/core) sur les listes
  // déjà servies par useQuotes/useInvoices (aucun endpoint dédié) — fail-closed : une
  // projection sans chantierId transporté n'est jamais comptée ici.
  const quotes = useQuotes();
  const invoices = useInvoices();
  const pieces = useMemo(
    () =>
      deriveChantierPieces({
        chantierId: id,
        quotes: (quotes.data ?? []).map((quote) => ({
          id: quote.id,
          chantierId: quote.chantierId,
          number: quote.number,
          status: quote.status,
          totalTtcCents: quote.totals.ttc,
          issuedAt: quote.issuedAt ?? null,
        })),
        invoices: (invoices.data ?? []).map((invoice) => ({
          id: invoice.id,
          chantierId: invoice.chantierId,
          number: invoice.number,
          status: invoice.status,
          kind: invoice.kind,
          totalTtcCents: invoice.totals.ttc,
          issuedAt: invoice.issuedAt ?? null,
        })),
      }),
    [quotes.data, invoices.data, id],
  );
  const photos = useWorksitePhotos(id);
  // PR-11 — parc du site (section 3 rows + Voir tout, matière réelle uniquement).
  const equipments = useChantierEquipments(id);
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
    void Promise.all([chantiers.refetch(), notes.refetch(), photos.refetch(), expenses.refetch()]);
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
              refreshing={chantiers.isRefetching || notes.isRefetching || photos.isRefetching || expenses.isRefetching}
              onRefresh={refresh}
              tintColor={colors.ink800}
              colors={[colors.ink800]}
            />
          }
        >
          {/* ── Héros BobSurface marine (Lot 4 — parité fiche équipement) :
               nom, adresse, statut sur la matière Bob, jamais la transparence iOS. ── */}
          <BobSurface tone="marine" emphasis="raised">
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
          </BobSurface>

          {/* ── Journal (notes horodatées) — SectionHeader kit (Lot 4 : 5 titres maison
               résorbés, rythme marginTop 28 unifié). ── */}
          <View style={{ marginTop: 28 }}>
            <SectionHeader title={t('chantierFiche.notesTitle', { personality })} />
          </View>
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

          {/* ── Photos — SectionHeader kit, bouton appareil photo en action ── */}
          <View style={{ marginTop: 28 }}>
            <SectionHeader
              title={t('chantierFiche.photosTitle', { personality })}
              action={
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
              }
            />
          </View>
          {photos.isLoading ? (
            <SkeletonRow avatar="square" trailing={false} style={{ minHeight: 58 }} />
          ) : photos.isError ? (
            <ErrorRetry
              message={t('chantierFiche.dataError', { personality })}
              onRetry={() => void photos.refetch()}
              retrying={photos.isRefetching}
            />
          ) : (photos.data ?? []).length === 0 && !uploadPhoto.isPending ? (
            <Card>
              <EmptyState
                body={t('chantierFiche.photosEmpty', { personality })}
                cta={{ label: t('chantierFiche.photoAdd', { personality }), onPress: () => setPhotoSourceOpen(true) }}
              />
            </Card>
          ) : (
            /* Grille en POINTS NUMÉRIQUES (gap 8, plus jamais un gap en pourcentage) ;
               l'envoi en cours est une TUILE FANTÔME dans la grille — sur un chantier en
               3G, l'artisan voit que Bob travaille sans re-taper (Lot 4). */
            <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 8 }}>
              {(photos.data ?? []).map((photo) => (
                <PhotoThumbnail key={photo.id} photoId={photo.id} onOpen={setFullscreenPhotoId} />
              ))}
              {uploadPhoto.isPending ? (
                <View
                  accessible
                  accessibilityLabel={t('chantierFiche.photoUploading', { personality })}
                  accessibilityState={{ busy: true }}
                  style={{ width: '31%', aspectRatio: 1, borderRadius: 12, overflow: 'hidden' }}
                >
                  <Skeleton height={1} radius={12} style={{ flex: 1 }} />
                </View>
              ) : null}
            </View>
          )}
          {photoError ? (
            <Text accessibilityRole="alert" style={[font('sub'), { color: semantic.danger, marginTop: 8 }]}>
              {photoError}
            </Text>
          ) : null}

          {/* ── B5 — Retenue de garantie à récupérer (loi 71-584) : créance suivie du CLIENT
               du chantier — la carte se tait quand aucune retenue n'est constituée. ── */}
          {chantier.customerId !== null ? (
            <View style={{ marginTop: 24 }}>
              <RetenueSuiviCard customerId={chantier.customerId} />
            </View>
          ) : null}

          {/* ── PR-11 — ÉQUIPEMENTS du site (3 premières rows + Voir tout, écrans §6.2) :
               la section se tait tant que le parc est vide (matière réelle uniquement). ── */}
          {(equipments.data ?? []).length > 0 ? (
            <>
              <View style={{ marginTop: 28 }}>
                <SectionHeader
                  title={`${t('equipements.sectionOnSite', { personality })} (${(equipments.data ?? []).length})`}
                  action={
                    <Pressable
                      accessibilityRole="button"
                      accessibilityLabel={t('equipements.seeAll', { personality })}
                      onPress={() => router.push(`/equipements/${chantier.id}`)}
                      hitSlop={8}
                      style={({ pressed }) => ({ opacity: pressed ? 0.6 : 1, minHeight: 44, justifyContent: 'center' })}
                    >
                      <Text style={[font('label', 700), { fontSize: 13, color: colors.ink600 }]}>
                        {t('equipements.seeAll', { personality })}
                      </Text>
                    </Pressable>
                  }
                />
              </View>
              <Card radius={16} padding={0} style={{ paddingHorizontal: 14 }}>
                {(equipments.data ?? []).slice(0, 3).map((equipment, index, rows) => (
                  <Pressable
                    key={equipment.id}
                    accessibilityRole="button"
                    accessibilityLabel={equipment.label}
                    onPress={() => router.push(`/equipement/${equipment.id}`)}
                    style={({ pressed }) => [
                      {
                        minHeight: 48,
                        paddingVertical: 11,
                        borderBottomWidth: index === rows.length - 1 ? 0 : 1,
                        borderBottomColor: colors.lineSoft,
                      },
                      pressed && { opacity: 0.7 },
                    ]}
                  >
                    <Text accessible={false} style={[font('sub', 600), { color: colors.ink800 }]} numberOfLines={1}>
                      {equipment.label}
                    </Text>
                    {equipment.kind ? (
                      <Text accessible={false} style={[font('meta'), { color: colors.slate400, marginTop: 2 }]}>
                        {equipment.kind}
                      </Text>
                    ) : null}
                  </Pressable>
                ))}
              </Card>
            </>
          ) : (
            <View style={{ marginTop: 28 }}>
              <Button
                title={t('equipements.addCta', { personality })}
                variant="secondary"
                onPress={() => router.push(`/equipements/${chantier.id}`)}
              />
            </View>
          )}

          {/* ── PR-08 — Pièces du site : devis + factures rattachés (dérivation pure sur les
               listes existantes ; chaque row navigue vers sa fiche). ── */}
          <View style={{ marginTop: 28 }}>
            <SectionHeader title={t('chantierFiche.piecesTitle', { personality })} />
          </View>
          {quotes.isLoading || invoices.isLoading ? (
            <SkeletonRow avatar="square" trailing={false} style={{ minHeight: 58 }} />
          ) : quotes.isError || invoices.isError ? (
            <ErrorRetry
              message={t('chantierFiche.dataError', { personality })}
              onRetry={() => {
                if (quotes.isError) void quotes.refetch();
                if (invoices.isError) void invoices.refetch();
              }}
              retrying={quotes.isRefetching || invoices.isRefetching}
            />
          ) : pieces.quotes.length === 0 && pieces.invoices.length === 0 ? (
            <Card>
              <EmptyState body={t('chantierFiche.piecesEmpty', { personality, params: worksiteParams })} />
            </Card>
          ) : (
            <Card radius={16} padding={0} style={{ paddingHorizontal: 14 }}>
              {[
                ...pieces.quotes.map((piece) => ({
                  key: `quote-${piece.id}`,
                  kindLabel: t('chantierFiche.pieceQuote', { personality }),
                  number: piece.number,
                  badge: QUOTE_BADGE[piece.status],
                  totalTtcCents: piece.totalTtcCents,
                  route: `/devis/${piece.id}` as const,
                })),
                ...pieces.invoices.map((piece) => ({
                  key: `invoice-${piece.id}`,
                  kindLabel: t('chantierFiche.pieceInvoice', { personality }),
                  number: piece.number,
                  badge: INVOICE_BADGE[piece.status],
                  totalTtcCents: piece.totalTtcCents,
                  route: `/facture/${piece.id}` as const,
                })),
              ].map((row, index, rows) => (
                <Pressable
                  key={row.key}
                  accessibilityRole="button"
                  accessibilityLabel={`${row.kindLabel} ${row.number ?? t('chantierFiche.pieceDraft', { personality })} · ${row.badge.label} · ${formatEUR(row.totalTtcCents)}`}
                  onPress={() => router.push(row.route)}
                  style={({ pressed }) => [
                    {
                      minHeight: 48,
                      paddingVertical: 11,
                      flexDirection: 'row',
                      alignItems: 'center',
                      gap: 12,
                      borderBottomWidth: index === rows.length - 1 ? 0 : 1,
                      borderBottomColor: colors.lineSoft,
                    },
                    pressed && { opacity: 0.7 },
                  ]}
                >
                  <View style={{ flex: 1, minWidth: 0 }}>
                    <Text accessible={false} style={[font('sub', 600), { color: colors.ink800 }]} numberOfLines={1}>
                      {row.kindLabel} {row.number ?? t('chantierFiche.pieceDraft', { personality })}
                    </Text>
                    <Text accessible={false} style={[font('meta'), { color: colors.slate400, marginTop: 2 }]}>
                      {row.badge.label}
                    </Text>
                  </View>
                  <Text
                    accessible={false}
                    style={{ ...font('sub', 700), color: colors.ink800, fontVariant: ['tabular-nums'] }}
                  >
                    {formatEUR(row.totalTtcCents)}
                  </Text>
                </Pressable>
              ))}
            </Card>
          )}

          {/* ── Dépenses imputées (rentabilité par chantier) — filtre CLIENT sur la liste
               existante (useExpenses), les plus récentes en tête, total TTC en pied. ── */}
          <View style={{ marginTop: 28 }}>
            <SectionHeader title={t('chantierFiche.expensesTitle', { personality })} />
          </View>
          {expenses.isLoading ? (
            <SkeletonRow avatar="square" trailing={false} style={{ minHeight: 58 }} />
          ) : expenses.isError ? (
            <ErrorRetry
              message={t('chantierFiche.dataError', { personality })}
              onRetry={() => void expenses.refetch()}
              retrying={expenses.isRefetching}
            />
          ) : linkedExpenses.length === 0 ? (
            <Card>
              <EmptyState body={t('chantierFiche.expensesEmpty', { personality })} />
            </Card>
          ) : (
            <Card radius={16} padding={0} style={{ paddingHorizontal: 14 }}>
              {linkedExpenses.map((expense) => (
                <View
                  key={expense.id}
                  accessible
                  accessibilityLabel={`${expense.supplierName} · ${formatEUR(expense.totalTtcCents)} · ${t(expense.status === 'paid' ? 'dep.statusPaid' : 'dep.statusToPay', { personality })}`}
                  style={{
                    minHeight: 48,
                    paddingVertical: 11,
                    flexDirection: 'row',
                    alignItems: 'center',
                    gap: 12,
                    borderBottomWidth: 1,
                    borderBottomColor: colors.lineSoft,
                  }}
                >
                  <View style={{ flex: 1, minWidth: 0 }}>
                    <Text accessible={false} style={[font('sub', 600), { color: colors.ink800 }]} numberOfLines={1}>
                      {expense.supplierName}
                    </Text>
                    <Text accessible={false} style={[font('meta'), { color: colors.slate400, marginTop: 2 }]}>
                      {frDate(expense.documentDate)} · {t(expense.status === 'paid' ? 'dep.statusPaid' : 'dep.statusToPay', { personality })}
                    </Text>
                  </View>
                  <Text
                    accessible={false}
                    style={{ ...font('sub', 700), color: colors.ink800, fontVariant: ['tabular-nums'] }}
                  >
                    {formatEUR(expense.totalTtcCents)}
                  </Text>
                </View>
              ))}
              <View
                accessible
                accessibilityLabel={`${t('chantierFiche.expensesTotal', { personality })} : ${formatEUR(chantierExpensesTotalCents(linkedExpenses))}`}
                style={{
                  minHeight: 44,
                  paddingVertical: 11,
                  flexDirection: 'row',
                  alignItems: 'center',
                  justifyContent: 'space-between',
                  gap: 12,
                }}
              >
                <Text accessible={false} style={[font('sub', 700), { color: colors.ink900 }]}>
                  {t('chantierFiche.expensesTotal', { personality })}
                </Text>
                <Text
                  accessible={false}
                  style={{ ...font('sub', 700), color: colors.ink900, fontVariant: ['tabular-nums'] }}
                >
                  {formatEUR(chantierExpensesTotalCents(linkedExpenses))}
                </Text>
              </View>
            </Card>
          )}
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

      {/* ── Plein écran — PhotoViewer kit (Lot 4) : scrim/chrome tokenisés (fin des hex
           de cet écran), fade gaté reduce-motion fail-closed. Le contenu (skeleton, image,
           erreur en corps AA on-dark ≥ white80) reste ici : les données sont à l'écran. ── */}
      <PhotoViewer
        visible={fullscreenPhotoId !== null}
        onRequestClose={() => setFullscreenPhotoId(null)}
        closeAccessibilityLabel={t('chantierFiche.photoClose', { personality })}
        onDelete={() => {
          if (fullscreenPhotoId !== null) void confirmDeletePhoto(fullscreenPhotoId);
        }}
        deleteAccessibilityLabel={t('chantierFiche.photoDelete', { personality })}
      >
        {fullscreenUrl.isLoading ? (
          <Skeleton height={280} width="86%" radius={12} />
        ) : fullscreenUrl.isSuccess ? (
          <Image
            source={{ uri: fullscreenUrl.data.url }}
            style={{ width: '100%', height: '80%' }}
            resizeMode="contain"
          />
        ) : (
          <Text style={[font('sub'), { color: overlays.white80 }]}>
            {t('chantierFiche.photoLoadError', { personality })}
          </Text>
        )}
      </PhotoViewer>
    </View>
  );
}
