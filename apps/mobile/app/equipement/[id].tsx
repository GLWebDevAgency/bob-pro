/**
 * PR-11c — Fiche équipement + HISTORIQUE DÉRIVÉ (écrans P1 §2.2). L'historique est LA valeur
 * (« montre-moi l'historique de la fontaine Y ») : fusion RÉELLE notes+photos taguées
 * (deriveEquipmentHistory serveur), jamais une trace inventée. Kit « matière Bob » : héros
 * BobSurface marine raised ; équipement retiré → bandeau `neutral` « Retirée le {retiredAt} »
 * (fait réel) + « Réactiver » — l'historique reste intégral. Retrait via ConfirmSheet qui
 * PORTE l'avertissement contrat du domaine lu AVANT la confirmation (amélioration 4 —
 * GET /equipments/:id/contract-coverage) ; filet post-ACK seulement si la lecture a échoué.
 * [Revue n°2] badge morph `replace 280` (Actif ↔ Retirée) après ACK — reduce-motion =
 * bascule immédiate + ANNONCE (MorphReplace, @bob/ui).
 */
import { useMemo, useState } from 'react';
import {
  AccessibilityInfo,
  Alert,
  RefreshControl,
  ScrollView,
  Text,
  TextInput,
  View,
} from 'react-native';
import { useLocalSearchParams, useRouter } from 'expo-router';
import { t } from '@bob/i18n';
import {
  BobSurface,
  Button,
  DateField,
  EmptyState,
  ErrorRetry,
  FormField,
  MorphReplace,
  Sheet,
  SkeletonCard,
  StatusBadge,
  font,
  statusBadgeColors,
  useErrorSheet,
  useStatusBadgePalette,
  useTheme,
} from '@bob/ui';
import { parisDateOnly, type EquipmentHistoryEntry } from '@bob/core';
import {
  appErrorMessage,
  useAddChantierNote,
  useEquipmentHistory,
  useReactivateEquipment,
  useRetireEquipment,
  useUpdateEquipment,
} from '../../src/data/hooks';
import { ScreenHeader } from '../../src/components/screen-header';
import { useBobAwareScrollInsets } from '../../src/components/use-bob-aware-scroll-insets';
import { warrantyChipOf } from '../../src/components/equipment-row.logic';
import {
  interventionStatusKey,
  timelineDotVariant,
} from '../../src/components/equipment-timeline.logic';
import { retireConfirmMessage } from '../../src/components/equipment-retire.logic';
import { useConfirm } from '../../src/components/ConfirmSheet';
import { useBobClient } from '../../src/data/client';
import { usePublishAgentContext, type AgentContext } from '../../src/agent';

const MONTHS_SHORT = [
  'janv.', 'févr.', 'mars', 'avr.', 'mai', 'juin',
  'juil.', 'août', 'sept.', 'oct.', 'nov.', 'déc.',
] as const;

function frDateOnly(dateOnly: string): string {
  const [year, month, day] = dateOnly.split('-');
  const monthLabel = MONTHS_SHORT[Number(month) - 1] ?? '';
  return `${Number(day)} ${monthLabel} ${year}`;
}

function frInstant(iso: string): string {
  return frDateOnly(iso.slice(0, 10));
}

type EditField =
  | 'label'
  | 'kind'
  | 'brand'
  | 'serialNumber'
  | 'location'
  | 'installedAt'
  | 'warrantyUntil';

const EDIT_FIELDS: { key: EditField; labelKey: Parameters<typeof t>[0] }[] = [
  { key: 'label', labelKey: 'equipements.labelField' },
  { key: 'kind', labelKey: 'equipements.kindField' },
  { key: 'brand', labelKey: 'equipements.brandField' },
  { key: 'serialNumber', labelKey: 'equipements.serialField' },
  { key: 'location', labelKey: 'equipements.locationField' },
  { key: 'installedAt', labelKey: 'equipements.installedField' },
  { key: 'warrantyUntil', labelKey: 'equipements.warrantyField' },
];

function TimelineRow({ entry }: { entry: EquipmentHistoryEntry }) {
  const { personality, colors } = useTheme();
  const palette = useStatusBadgePalette();
  const heading =
    entry.type === 'note'
      ? t('equipements.historyNote', { personality })
      : entry.type === 'photo'
        ? t('equipements.historyPhoto', { personality })
        : entry.type === 'intervention'
          ? entry.label
          : entry.filename;
  // Lot 4 : entry.status → i18n (statut serveur brut interdit à l'écran comme à l'oreille) ;
  // un statut inconnu du domaine reste affiché brut — honnête, jamais une invention.
  const interventionStatus =
    entry.type === 'intervention'
      ? (() => {
          const key = interventionStatusKey(entry.status);
          return key !== null ? t(key, { personality }) : entry.status;
        })()
      : null;
  const body =
    entry.type === 'note'
      ? `« ${entry.text} » — ${entry.authorLabel}`
      : entry.type === 'photo'
        ? entry.filename
        : entry.type === 'intervention'
          ? (interventionStatus ?? entry.status)
          : entry.kind;
  return (
    <View
      accessibilityRole="text"
      accessibilityLabel={`${frInstant(entry.at)}, ${heading}, ${body}`}
      style={{ flexDirection: 'row', gap: 10, paddingVertical: 10 }}
    >
      {/* Lot 4 : point teinté par TYPE d'entrée (statusBadgeColors) — l'historique, LA
          valeur de l'écran, devient scannable par couleur. */}
      <View
        style={{
          width: 8,
          height: 8,
          borderRadius: 4,
          marginTop: 6,
          backgroundColor: statusBadgeColors(timelineDotVariant(entry.type), palette).fg,
        }}
      />
      <View style={{ flex: 1, gap: 2 }}>
        <Text style={[font('meta'), { color: colors.slate400 }]}>{frInstant(entry.at)}</Text>
        <Text style={[font('body', 600), { color: colors.ink800 }]}>{heading}</Text>
        <Text style={[font('sub', 500), { color: colors.slate500 }]}>{body}</Text>
      </View>
    </View>
  );
}

export default function FicheEquipement() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const { personality, colors, controls, semantic } = useTheme();
  const router = useRouter();
  // Lot 4 — grammaire d'erreur : retrait/réactivation échoués parlent dans la feuille
  // Bob, plus jamais un Alert.alert « Oups » système (le filet post-ACK d'avertissement
  // contrat, lui, n'est pas une erreur et reste un Alert).
  const errorSheet = useErrorSheet();
  const scrollInsets = useBobAwareScrollInsets();
  const confirm = useConfirm();
  const client = useBobClient();
  const today = parisDateOnly();

  const history = useEquipmentHistory(id);
  const equipment = history.data?.equipment ?? null;
  const retire = useRetireEquipment();
  const reactivate = useReactivateEquipment();
  const update = useUpdateEquipment();
  const addNote = useAddChantierNote(equipment?.chantierId ?? '');
  const [noteOpen, setNoteOpen] = useState(false);
  const [noteDraft, setNoteDraft] = useState('');
  // « Modifier » (écrans §2.2) — feuille préremplie depuis la fiche RÉELLE ; null = fermée.
  const [editDraft, setEditDraft] = useState<Record<EditField, string> | null>(null);
  const [editError, setEditError] = useState<string | null>(null);

  const openEdit = (): void => {
    if (!equipment) return;
    setEditError(null);
    setEditDraft({
      label: equipment.label,
      kind: equipment.kind ?? '',
      brand: equipment.brand ?? '',
      serialNumber: equipment.serialNumber ?? '',
      location: equipment.location ?? '',
      installedAt: equipment.installedAt ?? '',
      warrantyUntil: equipment.warrantyUntil ?? '',
    });
  };

  const submitEdit = async (): Promise<void> => {
    if (!equipment || editDraft === null) return;
    if (editDraft.label.trim() === '') {
      setEditError(t('equipements.labelRequired', { personality }));
      return;
    }
    for (const candidate of [editDraft.installedAt, editDraft.warrantyUntil]) {
      if (candidate.trim() !== '' && !/^\d{4}-\d{2}-\d{2}$/.test(candidate.trim())) {
        setEditError(t('equipements.dateInvalid', { personality }));
        return;
      }
    }
    setEditError(null);
    try {
      await update.mutateAsync({
        equipmentId: equipment.id,
        chantierId: equipment.chantierId,
        expectedRevision: equipment.revision,
        patch: {
          label: editDraft.label.trim(),
          kind: editDraft.kind.trim() || null,
          brand: editDraft.brand.trim() || null,
          serialNumber: editDraft.serialNumber.trim() || null,
          location: editDraft.location.trim() || null,
          installedAt: editDraft.installedAt.trim() || null,
          warrantyUntil: editDraft.warrantyUntil.trim() || null,
        },
      });
      setEditDraft(null);
    } catch (error) {
      setEditError(appErrorMessage(error));
    }
  };

  usePublishAgentContext(
    useMemo<AgentContext>(
      () => ({
        screen: { name: '/equipement/[id]', instanceId: `equipment:${id}` },
        entities: equipment
          ? [{ type: 'equipment' as const, id: equipment.id, label: equipment.label }]
          : [],
        capabilities: ['screen.read'],
      }),
      [equipment, id],
    ),
  );

  const handleRetire = async (): Promise<void> => {
    if (!equipment) return;
    // [Amélioration 4, domaine §1.5-1.6] — la couverture contractuelle est LUE AVANT la
    // confirmation : la ConfirmSheet PORTE l'avertissement honnête du domaine (info, jamais
    // un blocage). Fail-open : lecture indisponible → feuille sans avertissement (le retrait
    // n'est jamais bloqué par une lecture) et le filet post-ACK du use case reprend la main.
    const readCoverage = client.equipmentContractCoverage?.bind(client);
    let coverageLabels: readonly string[] | null = null;
    if (readCoverage) {
      const coverage = await readCoverage(equipment.id);
      if (coverage.ok) coverageLabels = coverage.value.activeContractLabels;
    }
    const { message, warningShown } = retireConfirmMessage(
      t('equipements.retireConfirmBody', {
        personality,
        params: { label: equipment.label },
      }),
      coverageLabels,
    );
    const ok = await confirm({
      title: t('equipements.retireConfirmTitle', { personality }),
      message,
      challenge: { kind: 'tap' },
      destructive: true,
    });
    if (!ok) return;
    try {
      const result = await retire.mutateAsync({
        equipmentId: equipment.id,
        chantierId: equipment.chantierId,
        expectedRevision: equipment.revision,
      });
      // APRÈS ACK (§2.1) : la liste joue l'exit 140 vers Retirés, le badge morphe ici —
      // et l'ANNONCE porte le même fait (équivalence reduce-motion / lecteur d'écran).
      AccessibilityInfo.announceForAccessibility(
        t('equipements.retiredAnnounce', { personality, params: { label: equipment.label } }),
      );
      // Filet HONNÊTE uniquement quand l'avertissement n'a PAS pu être dit avant le geste
      // (lecture échouée) : le fait du use case n'est jamais perdu — ni répété inutilement.
      if (result.contractWarning && !warningShown) {
        Alert.alert(t('equipements.retireConfirmTitle', { personality }), result.contractWarning);
      }
    } catch (error) {
      errorSheet.showError(t('equipements.retireCta', { personality }), appErrorMessage(error));
    }
  };

  const handleReactivate = async (): Promise<void> => {
    if (!equipment) return;
    try {
      await reactivate.mutateAsync({
        equipmentId: equipment.id,
        chantierId: equipment.chantierId,
        expectedRevision: equipment.revision,
      });
      AccessibilityInfo.announceForAccessibility(
        t('equipements.reactivatedAnnounce', { personality, params: { label: equipment.label } }),
      );
    } catch (error) {
      errorSheet.showError(t('equipements.reactivateCta', { personality }), appErrorMessage(error));
    }
  };

  const submitNote = async (): Promise<void> => {
    if (!equipment || noteDraft.trim() === '') return;
    try {
      await addNote.mutateAsync({ text: noteDraft.trim(), equipmentId: equipment.id });
      setNoteDraft('');
      setNoteOpen(false);
      void history.refetch();
    } catch {
      // alertError du hook a déjà parlé — la feuille reste ouverte, la saisie est conservée.
    }
  };

  const warranty = equipment ? warrantyChipOf(equipment.warrantyUntil, today) : null;
  const retired = equipment?.status === 'retired';

  return (
    <View style={{ flex: 1, backgroundColor: colors.bg }}>
      <ScrollView
        contentContainerStyle={{ paddingBottom: scrollInsets.paddingBottom }}
        scrollIndicatorInsets={{ bottom: scrollInsets.scrollIndicatorBottom }}
        refreshControl={
          <RefreshControl refreshing={history.isRefetching} onRefresh={() => void history.refetch()} />
        }
      >
        <ScreenHeader
          backLabel={t('equipements.title', { personality })}
          onBack={() => router.back()}
          eyebrow={t('equipements.eyebrow', { personality })}
          title={equipment?.label ?? t('equipements.title', { personality })}
        />
        <View style={{ paddingHorizontal: 16, gap: 12 }}>
          {history.isPending ? (
            <SkeletonCard />
          ) : history.isError ? (
            history.error !== null && (history.error as { kind?: string }).kind === 'not_found' ? (
              <EmptyState body={t('equipements.notFound', { personality })} />
            ) : (
              <ErrorRetry message={t('chantierFiche.dataError', { personality })} onRetry={() => void history.refetch()} />
            )
          ) : equipment ? (
            <>
              <BobSurface tone="marine" emphasis="raised">
                <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 6, marginBottom: 8 }}>
                  {/* Badge morph §2.2 : Actif (success) ↔ Retirée (neutral) en `replace 280` —
                      reduce-motion : bascule immédiate (l'annonce d'ACK porte le fait). */}
                  <MorphReplace morphKey={retired && equipment.retiredAt ? 'retired' : 'active'}>
                    {retired && equipment.retiredAt ? (
                      <StatusBadge
                        variant="neutral"
                        label={t('equipements.retiredBadge', {
                          personality,
                          params: { date: frInstant(equipment.retiredAt) },
                        })}
                      />
                    ) : (
                      <StatusBadge variant="success" label={t('equipements.activeBadge', { personality })} />
                    )}
                  </MorphReplace>
                  {warranty ? (
                    <StatusBadge
                      variant={warranty.tone}
                      label={t(warranty.labelKey, {
                        personality,
                        params: { date: frDateOnly(warranty.date) },
                      })}
                    />
                  ) : null}
                </View>
                {[equipment.kind, equipment.brand, equipment.serialNumber]
                  .filter((part): part is string => part !== null)
                  .join(' · ') !== '' ? (
                  <Text style={[font('body', 600), { color: colors.ink800 }]}>
                    {[equipment.kind, equipment.brand, equipment.serialNumber]
                      .filter((part): part is string => part !== null)
                      .join(' · ')}
                  </Text>
                ) : null}
                {equipment.location ? (
                  <Text style={[font('sub', 500), { color: colors.slate500, marginTop: 2 }]}>
                    {equipment.location}
                  </Text>
                ) : null}
                {equipment.installedAt ? (
                  <Text style={[font('sub', 500), { color: colors.slate500, marginTop: 2 }]}>
                    {t('equipements.installedOn', {
                      personality,
                      params: { date: frDateOnly(equipment.installedAt) },
                    })}
                  </Text>
                ) : null}
              </BobSurface>

              {/* Lot 4 : la rangée de 3 boutons écrasés devient PRIMAIRE PLEINE LARGEUR
                  + 2 secondaires — le geste quotidien (la note) respire, et Dynamic Type
                  XL ne tronque plus les libellés. Retirée : Réactiver prend la primaire. */}
              {retired ? (
                <View style={{ gap: 8 }}>
                  <Button
                    title={t('equipements.reactivateCta', { personality })}
                    loading={reactivate.isPending}
                    onPress={() => void handleReactivate()}
                  />
                  <Button
                    title={t('equipements.addNoteCta', { personality })}
                    variant="secondary"
                    onPress={() => setNoteOpen(true)}
                  />
                </View>
              ) : (
                <View style={{ gap: 8 }}>
                  <Button
                    title={t('equipements.addNoteCta', { personality })}
                    onPress={() => setNoteOpen(true)}
                  />
                  <View style={{ flexDirection: 'row', gap: 8 }}>
                    <View style={{ flex: 1 }}>
                      <Button
                        title={t('equipements.editCta', { personality })}
                        variant="secondary"
                        onPress={openEdit}
                      />
                    </View>
                    <View style={{ flex: 1 }}>
                      <Button
                        title={t('equipements.retireCta', { personality })}
                        variant="secondary"
                        loading={retire.isPending}
                        onPress={() => void handleRetire()}
                      />
                    </View>
                  </View>
                </View>
              )}

              <BobSurface tone="neutral" emphasis="raised" padding={14}>
                <Text style={[font('section'), { color: colors.ink800 }]}>
                  {t('equipements.historyTitle', { personality })}
                </Text>
                {history.data!.entries.length === 0 ? (
                  <Text style={[font('sub', 500), { color: colors.slate500, marginTop: 8 }]}>
                    {t('equipements.historyEmpty', { personality })}
                  </Text>
                ) : (
                  history.data!.entries.map((entry, index) => (
                    <View key={`${entry.type}-${entry.id}`}>
                      {index > 0 ? (
                        <View style={{ height: 1, backgroundColor: colors.lineSoft }} />
                      ) : null}
                      <TimelineRow entry={entry} />
                    </View>
                  ))
                )}
              </BobSurface>
            </>
          ) : null}
        </View>
      </ScrollView>

      <Sheet
        visible={noteOpen}
        onClose={() => {
          if (!addNote.isPending) setNoteOpen(false);
        }}
        accessibilityLabel={t('equipements.addNoteCta', { personality })}
      >
        <Text style={[font('section'), { color: colors.ink800, marginBottom: 10 }]}>
          {t('equipements.addNoteCta', { personality })}
        </Text>
        <TextInput
          value={noteDraft}
          onChangeText={setNoteDraft}
          placeholder={t('equipements.notePlaceholder', { personality })}
          placeholderTextColor={colors.slate400}
          accessibilityLabel={t('equipements.notePlaceholder', { personality })}
          multiline
          style={[
            font('body'),
            {
              minHeight: 88,
              borderWidth: 1,
              borderColor: controls.cardBorder,
              borderRadius: 12,
              padding: 12,
              color: colors.ink800,
              backgroundColor: colors.surface,
              textAlignVertical: 'top',
            },
          ]}
        />
        <View style={{ marginTop: 10 }}>
          <Button
            title={t('equipements.noteCta', { personality })}
            loading={addNote.isPending}
            disabled={noteDraft.trim() === ''}
            onPress={() => void submitNote()}
          />
        </View>
      </Sheet>

      <Sheet
        visible={editDraft !== null}
        onClose={() => {
          if (!update.isPending) setEditDraft(null);
        }}
        accessibilityLabel={t('equipements.editCta', { personality })}
      >
        <Text style={[font('section'), { color: colors.ink800, marginBottom: 10 }]}>
          {t('equipements.editCta', { personality })}
        </Text>
        {/* Lot 4 : FormField ×5 + DateField ×2 — labels visibles persistants, masque
            AAAA-MM-JJ purement visuel ; l'erreur parle en danger avec role alert. */}
        <View style={{ gap: 8 }}>
          {EDIT_FIELDS.map((field) =>
            field.key === 'installedAt' || field.key === 'warrantyUntil' ? (
              <DateField
                key={field.key}
                label={t(field.labelKey, { personality })}
                value={editDraft?.[field.key] ?? ''}
                onChangeText={(value) => {
                  setEditError(null);
                  setEditDraft((current) => (current === null ? current : { ...current, [field.key]: value }));
                }}
              />
            ) : (
              <FormField
                key={field.key}
                label={t(field.labelKey, { personality })}
                value={editDraft?.[field.key] ?? ''}
                onChangeText={(value) => {
                  setEditError(null);
                  setEditDraft((current) => (current === null ? current : { ...current, [field.key]: value }));
                }}
              />
            ),
          )}
          {editError ? (
            <Text accessibilityRole="alert" style={[font('sub', 600), { color: semantic.danger }]}>
              {editError}
            </Text>
          ) : null}
          <Button
            title={t('equipements.editSaveCta', { personality })}
            loading={update.isPending}
            onPress={() => void submitEdit()}
          />
        </View>
      </Sheet>
      {errorSheet.errorSheet}
    </View>
  );
}
