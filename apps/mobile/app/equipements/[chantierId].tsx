/**
 * PR-11c — Parc d'équipements d'un SITE (écrans P1 §2.1). Premier écran du kit « matière
 * Bob » : BobSurface (surfaces teintées OPAQUES — jamais la transparence iOS), StatusBadge
 * `neutral` pour les retirées, chip de garantie dérivée de la colonne réelle. DONNÉES 100 %
 * RÉELLES (useChantierEquipments) — loading → skeletons, erreur → ErrorRetry sans effacer la
 * liste, site clôturé → état EXPLIQUÉ + CTA « Rouvrir le site » (jamais un bouton grisé
 * mystère). Chaque CTA passe par les MÊMES use cases que la voix (parité).
 * Micro-interactions §2.1 [revue n°2] : insertion + highlight `enter 240` APRÈS ACK de
 * création, sortie `exitFast 140` d'une rangée retirée (y compris retirée PAR BOB à la voix,
 * la liste ouverte) — reduce-motion = immédiat + ANNONCE (useRowPresence, @bob/ui).
 */
import { useEffect, useMemo, useState } from 'react';
import {
  AccessibilityInfo,
  Alert,
  Pressable,
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
  EmptyState,
  ErrorRetry,
  PresenceRow,
  SegmentedControl,
  Sheet,
  SkeletonRow,
  StatusBadge,
  font,
  useRowPresence,
  useTheme,
} from '@bob/ui';
import { parisDateOnly, type EquipmentProps } from '@bob/core';
import {
  appErrorMessage,
  useChantierEquipments,
  useChantiers,
  useCreateEquipment,
  useReopenChantier,
} from '../../src/data/hooks';
import { ScreenHeader } from '../../src/components/screen-header';
import { SearchIcon } from '../../src/components/icons';
import { useBobAwareScrollInsets } from '../../src/components/use-bob-aware-scroll-insets';
import {
  equipmentRowSubtitle,
  matchesEquipmentQuery,
  warrantyChipOf,
} from '../../src/components/equipment-row.logic';
import { usePublishAgentContext, type AgentContext } from '../../src/agent';

const MONTHS_SHORT = [
  'janv.', 'févr.', 'mars', 'avr.', 'mai', 'juin',
  'juil.', 'août', 'sept.', 'oct.', 'nov.', 'déc.',
] as const;

/** « 2027-03-12 » → « 12 mars 2027 » (dates complètes — jamais couleur seule, a11y §9). */
function frDateOnly(dateOnly: string): string {
  const [year, month, day] = dateOnly.split('-');
  const monthLabel = MONTHS_SHORT[Number(month) - 1] ?? '';
  return `${Number(day)} ${monthLabel} ${year}`;
}

type Segment = 'active' | 'retired';

function EquipmentRow({
  equipment,
  today,
  onPress,
}: {
  equipment: EquipmentProps;
  today: string;
  onPress: () => void;
}) {
  const { personality, colors } = useTheme();
  const subtitle = equipmentRowSubtitle(equipment);
  const warranty = warrantyChipOf(equipment.warrantyUntil, today);
  const retired = equipment.status === 'retired';
  const a11y = [
    equipment.label,
    retired && equipment.retiredAt
      ? t('equipements.retiredBadge', { personality, params: { date: frDateOnly(equipment.retiredAt.slice(0, 10)) } })
      : t('equipements.activeBadge', { personality }),
    subtitle ?? '',
  ]
    .filter(Boolean)
    .join(', ');
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={a11y}
      onPress={onPress}
      style={({ pressed }) => ({
        paddingVertical: 12,
        gap: 4,
        opacity: pressed ? 0.7 : 1,
        transform: [{ scale: pressed ? 0.99 : 1 }],
      })}
    >
      <Text style={[font('cardTitle'), { color: retired ? colors.slate500 : colors.ink800 }]}>
        {equipment.label}
      </Text>
      {subtitle ? (
        <Text style={[font('sub', 500), { color: colors.slate500 }]}>{subtitle}</Text>
      ) : null}
      <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 6, marginTop: 2 }}>
        {retired && equipment.retiredAt ? (
          <StatusBadge
            variant="neutral"
            label={t('equipements.retiredBadge', {
              personality,
              params: { date: frDateOnly(equipment.retiredAt.slice(0, 10)) },
            })}
          />
        ) : null}
        {warranty ? (
          <StatusBadge
            variant={warranty.tone}
            label={t(warranty.labelKey, { personality, params: { date: frDateOnly(warranty.date) } })}
          />
        ) : null}
        {equipment.location ? (
          <StatusBadge variant="b2b" label={equipment.location} />
        ) : null}
      </View>
    </Pressable>
  );
}

export default function ParcEquipements() {
  const { chantierId } = useLocalSearchParams<{ chantierId: string }>();
  const { personality, colors, controls, semantic } = useTheme();
  const router = useRouter();
  const scrollInsets = useBobAwareScrollInsets();
  const today = parisDateOnly();

  const chantiers = useChantiers();
  const chantier = (chantiers.data ?? []).find((c) => c.id === chantierId) ?? null;
  const siteClosed = chantier?.status === 'closed';
  const equipments = useChantierEquipments(chantierId);
  const reopen = useReopenChantier();
  const create = useCreateEquipment(chantierId);

  const [segment, setSegment] = useState<Segment>('active');
  const [query, setQuery] = useState('');
  const [sheetOpen, setSheetOpen] = useState(false);
  const [draft, setDraft] = useState({
    label: '',
    kind: '',
    brand: '',
    serialNumber: '',
    location: '',
    installedAt: '',
    warrantyUntil: '',
  });
  const [draftError, setDraftError] = useState<string | null>(null);

  const all = equipments.data ?? [];
  const bySegment = all.filter((equipment) => equipment.status === segment);
  const visible = bySegment.filter((equipment) => matchesEquipmentQuery(equipment, query));
  const counts = useMemo(
    () => ({
      active: all.filter((equipment) => equipment.status === 'active').length,
      retired: all.filter((equipment) => equipment.status === 'retired').length,
    }),
    [all],
  );
  // Micro-interactions §2.1 : les rangées VIVENT (enter 240 / exitFast 140) dans la MÊME vue ;
  // une bascule segment/recherche — et la PREMIÈRE arrivée des données (pending → ready) —
  // change le viewKey → remplacement de contenu SANS animation (l'enter est réservé aux
  // vraies insertions après ACK, jamais au chargement initial).
  const presence = useRowPresence({
    items: visible,
    keyOf: (equipment) => equipment.id,
    viewKey: `${equipments.isPending ? 'pending' : 'ready'}|${segment}|${query.trim().toLowerCase()}`,
  });
  // Rangée fraîchement créée ICI : voile d'insertion (highlight) après ACK — puis oubli.
  const [highlightId, setHighlightId] = useState<string | null>(null);
  useEffect(() => {
    if (highlightId === null) return;
    const timer = setTimeout(() => setHighlightId(null), 1600);
    return () => clearTimeout(timer);
  }, [highlightId]);

  usePublishAgentContext(
    useMemo<AgentContext>(
      () => ({
        screen: { name: '/equipements/[chantierId]', instanceId: `equipments:${chantierId}` },
        entities: [
          ...(chantier ? [{ type: 'chantier' as const, id: chantier.id, label: chantier.name }] : []),
          ...all.slice(0, 18).map((equipment) => ({
            type: 'equipment' as const,
            id: equipment.id,
            label: equipment.label,
          })),
        ],
        capabilities: ['screen.read'],
      }),
      [all, chantier, chantierId],
    ),
  );

  const submitCreate = async (): Promise<void> => {
    const label = draft.label.trim();
    if (!label) {
      setDraftError(t('equipements.labelRequired', { personality }));
      return;
    }
    const dateOf = (value: string): string | null => (value.trim() === '' ? null : value.trim());
    for (const candidate of [draft.installedAt, draft.warrantyUntil]) {
      if (candidate.trim() !== '' && !/^\d{4}-\d{2}-\d{2}$/.test(candidate.trim())) {
        setDraftError(t('equipements.dateInvalid', { personality }));
        return;
      }
    }
    setDraftError(null);
    try {
      const created = await create.mutateAsync({
        label,
        kind: draft.kind.trim() || null,
        brand: draft.brand.trim() || null,
        serialNumber: draft.serialNumber.trim() || null,
        location: draft.location.trim() || null,
        installedAt: dateOf(draft.installedAt),
        warrantyUntil: dateOf(draft.warrantyUntil),
      });
      setSheetOpen(false);
      setDraft({ label: '', kind: '', brand: '', serialNumber: '', location: '', installedAt: '', warrantyUntil: '' });
      // APRÈS ACK (§2.1) : insertion + highlight `enter 240` de la rangée réelle — et ANNONCE
      // (équivalence d'information : reduce-motion et lecteur d'écran reçoivent le même fait).
      setHighlightId(created.id);
      AccessibilityInfo.announceForAccessibility(
        t('equipements.createdAnnounce', { personality, params: { label } }),
      );
    } catch (error) {
      setDraftError(appErrorMessage(error));
    }
  };

  const fields: { key: keyof typeof draft; labelKey: Parameters<typeof t>[0] }[] = [
    { key: 'label', labelKey: 'equipements.labelField' },
    { key: 'kind', labelKey: 'equipements.kindField' },
    { key: 'brand', labelKey: 'equipements.brandField' },
    { key: 'serialNumber', labelKey: 'equipements.serialField' },
    { key: 'location', labelKey: 'equipements.locationField' },
    { key: 'installedAt', labelKey: 'equipements.installedField' },
    { key: 'warrantyUntil', labelKey: 'equipements.warrantyField' },
  ];

  return (
    <View style={{ flex: 1, backgroundColor: colors.bg }}>
      <ScrollView
        contentContainerStyle={{ paddingBottom: scrollInsets.paddingBottom }}
        scrollIndicatorInsets={{ bottom: scrollInsets.scrollIndicatorBottom }}
        refreshControl={
          <RefreshControl refreshing={equipments.isRefetching} onRefresh={() => void equipments.refetch()} />
        }
      >
        <ScreenHeader
          backLabel={chantier?.name ?? t('chantiers.back', { personality })}
          onBack={() => router.back()}
          eyebrow={t('equipements.eyebrow', { personality })}
          title={t('equipements.title', { personality })}
          subtitle={t('equipements.count', { personality, params: { count: String(all.length) } })}
        />
        <View style={{ paddingHorizontal: 16, gap: 12 }}>
          {siteClosed ? (
            // [Revue A12] — jamais un bouton grisé mystère : état expliqué + transition offerte.
            <BobSurface tone="warning" emphasis="raised">
              <Text style={[font('cardTitle'), { color: colors.ink800 }]}>
                {t('equipements.closedSiteTitle', { personality })}
              </Text>
              <Text style={[font('sub', 500), { color: colors.slate500, marginTop: 4, marginBottom: 10 }]}>
                {t('equipements.closedSiteBody', { personality })}
              </Text>
              <View style={{ alignSelf: 'flex-start' }}>
                <Button
                  title={t('equipements.reopenCta', { personality })}
                  loading={reopen.isPending}
                  onPress={() =>
                    void reopen
                      .mutateAsync(chantierId)
                      .catch((error) => Alert.alert('Oups', appErrorMessage(error)))
                  }
                />
              </View>
            </BobSurface>
          ) : null}
          <View
            style={{
              flexDirection: 'row',
              alignItems: 'center',
              gap: 8,
              backgroundColor: colors.surface,
              borderRadius: 12,
              borderWidth: 1,
              borderColor: controls.cardBorder,
              paddingHorizontal: 12,
            }}
          >
            <SearchIcon color={colors.slate400} size={16} />
            <TextInput
              value={query}
              onChangeText={setQuery}
              placeholder={t('equipements.searchPlaceholder', { personality })}
              placeholderTextColor={colors.slate400}
              accessibilityLabel={t('equipements.searchPlaceholder', { personality })}
              style={[font('body'), { flex: 1, minHeight: 44, color: colors.ink800 }]}
            />
          </View>
          <SegmentedControl<Segment>
            options={[
              { key: 'active', label: `${t('equipements.segmentActive', { personality })} ${counts.active}` },
              { key: 'retired', label: `${t('equipements.segmentRetired', { personality })} ${counts.retired}` },
            ]}
            value={segment}
            onChange={setSegment}
            accessibilityLabel={t('equipements.title', { personality })}
          />

          {equipments.isPending && !siteClosed ? (
            <BobSurface tone="neutral" emphasis="raised">
              <SkeletonRow />
              <SkeletonRow />
              <SkeletonRow />
            </BobSurface>
          ) : equipments.isError ? (
            <ErrorRetry message={t('chantierFiche.dataError', { personality })} onRetry={() => void equipments.refetch()} />
          ) : presence.rows.length === 0 ? (
            bySegment.length === 0 && all.length === 0 ? (
              <EmptyState
                title={t('equipements.emptyTitle', { personality })}
                body={t('equipements.emptyBody', { personality })}
              />
            ) : (
              <EmptyState body={t('equipements.emptyFilter', { personality })} />
            )
          ) : (
            <BobSurface tone="neutral" emphasis="raised" padding={12}>
              {presence.rows.map((row, index) => (
                <PresenceRow
                  key={row.key}
                  presence={row.presence}
                  motion={presence.motion}
                  {...(row.key === highlightId
                    ? { highlightColor: semantic.successBg, highlightRadius: 10 }
                    : {})}
                >
                  {index > 0 ? (
                    <View style={{ height: 1, backgroundColor: colors.lineSoft }} />
                  ) : null}
                  <EquipmentRow
                    equipment={row.item}
                    today={today}
                    onPress={() => router.push(`/equipement/${row.item.id}`)}
                  />
                </PresenceRow>
              ))}
            </BobSurface>
          )}

          {!siteClosed ? (
            <Button
              title={t('equipements.addCta', { personality })}
              onPress={() => {
                setDraftError(null);
                setSheetOpen(true);
              }}
            />
          ) : null}
        </View>
      </ScrollView>

      <Sheet
        visible={sheetOpen}
        onClose={() => {
          if (!create.isPending) setSheetOpen(false);
        }}
        accessibilityLabel={t('equipements.sheetTitle', { personality })}
      >
        <Text style={[font('section'), { color: colors.ink800, marginBottom: 10 }]}>
          {t('equipements.sheetTitle', { personality })}
        </Text>
        <View style={{ gap: 8 }}>
          {fields.map((field) => (
            <TextInput
              key={field.key}
              value={draft[field.key]}
              onChangeText={(value) => {
                setDraftError(null);
                setDraft((current) => ({ ...current, [field.key]: value }));
              }}
              placeholder={t(field.labelKey, { personality })}
              placeholderTextColor={colors.slate400}
              accessibilityLabel={t(field.labelKey, { personality })}
              autoCapitalize={field.key === 'installedAt' || field.key === 'warrantyUntil' ? 'none' : 'sentences'}
              style={[
                font('body'),
                {
                  minHeight: 44,
                  borderWidth: 1,
                  borderColor: controls.cardBorder,
                  borderRadius: 12,
                  paddingHorizontal: 12,
                  color: colors.ink800,
                  backgroundColor: colors.surface,
                },
              ]}
            />
          ))}
          {draftError ? (
            <Text
              accessibilityLiveRegion="polite"
              style={[font('sub', 500), { color: colors.slate500 }]}
            >
              {draftError}
            </Text>
          ) : null}
          <Button
            title={t('equipements.saveCta', { personality })}
            loading={create.isPending}
            onPress={() => void submitCreate()}
          />
        </View>
      </Sheet>
    </View>
  );
}
