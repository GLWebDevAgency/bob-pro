/**
 * Mon profil fiscal — écran dédié (SPEC_EXPERT_FISCAL.md §UX FLOW amendement 5 : « résidence :
 * carte Compte → écran dédié... INPUTS seulement — les résultats de simulation sont une AUTRE
 * tranche »). Une ligne par champ (FISCAL_PROFILE_FIELDS, @bob/core) : valeur + STATUT EN TEXTE
 * (Confirmé/À confirmer/Manquant, amendement 6 — jamais couleur/coche seules) + source + date.
 * Tap → la MÊME bottom sheet de confirmation/édition que le mini-flow (FiscalFieldEditSheet,
 * réutilise FiscalFlowSheet). Voix : mêmes affordances que le mini-flow (parité stricte,
 * amendement 7) — « je suis en SASU », « j'ai l'ACRE depuis mars 2026»…
 */
import { useMemo, useState } from 'react';
import { Pressable, RefreshControl, ScrollView, Text, View } from 'react-native';
import { useRouter } from 'expo-router';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { applicableFiscalFields, type FiscalProfileView } from '@bob/core';
import { spacing } from '@bob/tokens';
import { t, type Personality } from '@bob/i18n';
import { BackHeader, Button, Card, ErrorRetry, Skeleton, font, useTheme } from '@bob/ui';
import { usePublishAgentContext, type AgentContext, type AgentSurface } from '../src/agent';
import { useFiscalProfileFlow } from '../src/fiscal/use-fiscal-profile-flow';
import { FIELD_NAME_KEY, FIELD_STATUS_LABEL_KEY, FIELD_STATUS_TONE, type FiscalProfileFieldName } from '../src/fiscal/fiscal-i18n-keys';
import { fieldSourceCaption, fieldValueDisplay } from '../src/fiscal/fiscal-value-labels';
import { FiscalStatusPill } from '../src/components/fiscal/FiscalStatusPill';
import { FiscalFieldEditSheet, type FiscalEditableField } from '../src/components/fiscal/FiscalFieldEditSheet';
import { CheckIcon, ChevronRightIcon } from '../src/components/icons';
import { useBobAwareScrollInsets } from '../src/components/use-bob-aware-scroll-insets';

function FiscalFieldRow({
  field,
  profile,
  personality,
  onPress,
  last,
}: {
  readonly field: FiscalProfileFieldName;
  readonly profile: FiscalProfileView;
  readonly personality: Personality;
  readonly onPress: () => void;
  readonly last: boolean;
}) {
  const { colors } = useTheme();
  const datum = profile[field];
  const statusLabel = t(FIELD_STATUS_LABEL_KEY[datum.status], { personality });
  const tone = FIELD_STATUS_TONE[datum.status];
  const valueLabel = fieldValueDisplay(field, profile, personality);
  const sourceCaption = fieldSourceCaption(datum, personality);
  const fieldLabel = t(FIELD_NAME_KEY[field], { personality });

  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={`${fieldLabel}, ${valueLabel}, ${statusLabel}. ${sourceCaption}`}
      onPress={onPress}
      style={{
        flexDirection: 'row',
        alignItems: 'center',
        gap: 10,
        paddingVertical: 13,
        minHeight: 44,
        borderBottomWidth: last ? 0 : 1,
        borderBottomColor: colors.lineSoft,
      }}
    >
      <View style={{ flex: 1, minWidth: 0 }}>
        {/* Passe typo (vague hors-lots) : les demi-tailles 14.5/14/11.5 s'arrondissent aux
            crans existants — body 14.5 et meta 12 (arbitrage : aucune demi-taille ad hoc). */}
        <Text style={[font('body', 600), { color: colors.ink800 }]}>{fieldLabel}</Text>
        <Text numberOfLines={1} style={[font('body'), { color: colors.ink900, marginTop: 2 }]}>
          {valueLabel}
        </Text>
        <View style={{ flexDirection: 'row', alignItems: 'center', gap: 7, marginTop: 6 }}>
          <FiscalStatusPill label={statusLabel} tone={tone} />
          <Text numberOfLines={1} style={[font('meta'), { color: colors.slate400, flexShrink: 1 }]}>
            {sourceCaption}
          </Text>
        </View>
      </View>
      <ChevronRightIcon color={colors.slate300} size={16} />
    </Pressable>
  );
}

export default function ProfilFiscal() {
  const { colors, semantic, personality } = useTheme();
  const insets = useSafeAreaInsets();
  const bobScrollInsets = useBobAwareScrollInsets({ minimumBottom: insets.bottom + 34 });
  const router = useRouter();
  const flow = useFiscalProfileFlow();
  const profile = flow.profile;
  const [editingField, setEditingField] = useState<FiscalEditableField | null>(null);
  const profileReady = profile !== undefined;

  const agentContext = useMemo<AgentContext>(
    () => ({
      screen: { name: 'profil-fiscal', instanceId: 'profil-fiscal' },
      entities: [],
      capabilities: profileReady ? ['screen.read', 'fiscal_profile.read', 'fiscal_profile.propose'] : [],
    }),
    [profileReady],
  );
  // Les arguments de `usePublishAgentContext` sont des DÉPENDANCES d'effet (agent-context:177) :
  // un littéral inline change d'identité à chaque rendu → republication → nouvelle valeur de
  // contexte → re-rendu → boucle infinie (mesurée : 20 002 rendus sans convergence, fil JS saturé
  // = écran figé sur l'appareil). `undefined` retombe sur la constante figée EMPTY_LAYOUT.
  const agentSurface = useMemo<AgentSurface>(
    () => ({ affordances: flow.voiceAffordances }),
    [flow.voiceAffordances],
  );
  usePublishAgentContext(agentContext, undefined, agentSurface);

  return (
    <View style={{ flex: 1, backgroundColor: colors.bg }}>
      {/* BackHeader importé directement de @bob/ui — le réexport local est déprécié. */}
      <BackHeader
        backLabel={t('reglages.back', { personality })}
        onBack={() => router.back()}
        eyebrow={t('fiscal.screen.eyebrow', { personality })}
        title={t('fiscal.screen.title', { personality })}
        subtitle={t('fiscal.screen.subtitle', { personality })}
      />

      <ScrollView
        style={{ flex: 1 }}
        contentContainerStyle={{
          paddingHorizontal: spacing.gutter,
          paddingTop: 14,
          paddingBottom: bobScrollInsets.paddingBottom,
        }}
        automaticallyAdjustKeyboardInsets={bobScrollInsets.automaticallyAdjustKeyboardInsets}
        scrollIndicatorInsets={{ bottom: bobScrollInsets.scrollIndicatorBottom }}
        showsVerticalScrollIndicator={false}
        refreshControl={
          <RefreshControl
            refreshing={flow.isRefetching}
            onRefresh={() => void flow.refetch()}
            tintColor={colors.ink800}
            colors={[colors.ink800]}
          />
        }
      >
        {flow.isLoading && !profile ? (
          // Skeleton FIDÈLE (doctrine des gabarits) : la silhouette de la liste de rangées
          // (deux lignes + pastille), jamais un bloc plein qui saute à l'arrivée des données.
          <Card radius={18} padding={0} style={{ paddingHorizontal: 16 }}>
            {Array.from({ length: 6 }, (_, index) => (
              <View
                key={index}
                style={{
                  paddingVertical: 13,
                  gap: 6,
                  borderBottomWidth: index === 5 ? 0 : 1,
                  borderBottomColor: colors.lineSoft,
                }}
              >
                <Skeleton height={13} width="42%" radius={6} />
                <Skeleton height={13} width="64%" radius={6} />
                <View style={{ flexDirection: 'row', alignItems: 'center', gap: 7 }}>
                  <Skeleton height={17} width={74} radius={6} />
                  <Skeleton height={10} width="30%" radius={5} />
                </View>
              </View>
            ))}
          </Card>
        ) : flow.isError && !profile ? (
          // Aucune donnée en cache : un échec pur, jamais un profil vide qui laisserait croire
          // que rien n'est renseigné.
          <ErrorRetry
            message={t('fiscal.screen.dataError', { personality })}
            onRetry={() => void flow.refetch()}
            retrying={flow.isRefetching}
          />
        ) : profile ? (
          <>
            {flow.isError ? (
              // Un refetch a échoué mais le dernier instantané reste affiché (amendement 8 :
              // « offline → dernier snapshot + mention stale ») — jamais un écran vide.
              <Card style={{ marginBottom: 16, backgroundColor: colors.lineSoft, borderWidth: 0 }}>
                <Text accessibilityRole="alert" style={[font('sub', 600), { color: colors.ink800 }]}>
                  {t('fiscal.screen.stale', { personality })}
                </Text>
              </Card>
            ) : null}
            {flow.hasPending ? (
              <View style={{ marginBottom: 16 }}>
                <Button
                  title={t(flow.remainingCount === 1 ? 'fiscal.screen.completeCtaOne' : 'fiscal.screen.completeCta', {
                    personality,
                    params: { count: flow.remainingCount },
                  })}
                  variant="ai"
                  onPress={flow.openFlow}
                />
              </View>
            ) : (
              // Le vert est la récompense du geste commis : un profil fiscal entièrement
              // confirmé est exactement ce moment — successBg + successInk + coche discrète
              // (l'état neutre lineSoft le faisait ressembler à un bloc désactivé).
              <Card style={{ marginBottom: 16, backgroundColor: semantic.successBg, borderWidth: 0 }}>
                <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8 }}>
                  <CheckIcon color={semantic.successInk} size={15} strokeWidth={2.6} />
                  <Text style={[font('sub', 600), { color: semantic.successInk, flex: 1 }]}>
                    {t('fiscal.screen.allSet', { personality })}
                  </Text>
                </View>
              </Card>
            )}

            {/* Seuls les champs APPLICABLES à ce profil (fiscal-field-rules @bob/core) : le
                versement libératoire n'existe qu'au régime micro (art. 151-0 CGI) — hors micro,
                l'afficher « Manquant » serait un bruit trompeur, il est masqué. */}
            <Card radius={18} padding={0} style={{ paddingHorizontal: 16 }}>
              {applicableFiscalFields(profile).map((field, index, all) => (
                <FiscalFieldRow
                  key={field}
                  field={field}
                  profile={profile}
                  personality={personality}
                  last={index === all.length - 1}
                  onPress={() => setEditingField(field)}
                />
              ))}
            </Card>
          </>
        ) : null}
      </ScrollView>

      {profile ? (
        <FiscalFieldEditSheet
          field={editingField}
          profile={profile}
          personality={personality}
          confirmField={flow.confirmField}
          confirmPatches={flow.confirmPatches}
          onClose={() => setEditingField(null)}
        />
      ) : null}
      {flow.sheets}
    </View>
  );
}
