import { useEffect, useMemo, useState } from 'react';
import {
  KeyboardAvoidingView,
  Platform,
  Pressable,
  RefreshControl,
  ScrollView,
  Text,
  TextInput,
  View,
} from 'react-native';
import { useRouter } from 'expo-router';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { tradeToWorksiteTerminology } from '@bob/core';
import { t } from '@bob/i18n';
import {
  BackHeader,
  Button,
  Card,
  EmptyState,
  ErrorRetry,
  HeaderIconButton,
  PressableScale,
  SectionHeader,
  Sheet,
  Skeleton,
  SkeletonRow,
  StaggeredList,
  StatusBadge,
  Toast,
  font,
  useTheme,
} from '@bob/ui';
import { useChantiers, useCreateChantier, useProfile, useSearchAddress } from '../src/data/hooks';
import { usePublishAgentContext, type AgentContext } from '../src/agent';
import { CheckIcon, ChevronRightIcon, PlusIcon } from '../src/components/icons';
import { useBobAwareScrollInsets } from '../src/components/use-bob-aware-scroll-insets';
import { ChantierRowCountBadges } from '../src/components/chantier-row-counts';
import {
  chantierRowCountsAccessibilityLabel,
} from '../src/components/chantier-row-counts.logic';
import { DEFAULT_WORKSITE_TERM, worksiteParamsFor } from '../src/lib/worksite-terminology';

const SEARCH_DEBOUNCE_MS = 350;

function frDate(dateOnly: string): string {
  const [year, month, day] = dateOnly.split('-');
  return year && month && day ? `${day}/${month}/${year}` : dateOnly;
}

export default function Chantiers() {
  const { colors, controls, semantic, personality } = useTheme();
  const insets = useSafeAreaInsets();
  const bobScrollInsets = useBobAwareScrollInsets({ minimumBottom: insets.bottom + 40 });
  const router = useRouter();
  const profile = useProfile();
  const moduleActive = (profile.data?.modules ?? []).some(
    (module) => module.key === 'chantiers' && module.active,
  );
  const chantiers = useChantiers(moduleActive && !profile.isError);
  const create = useCreateChantier();
  const search = useSearchAddress();

  // Terminologie adaptative par métier (tradeToWorksiteTerminology @bob/core) — un plombier
  // parle de « chantier », un freelance IT de « mission »… Repli neutre tant que non chargé.
  const worksiteTerm = profile.data ? tradeToWorksiteTerminology(profile.data.trade) : DEFAULT_WORKSITE_TERM;
  const worksiteParams = worksiteParamsFor(worksiteTerm);

  const [createOpen, setCreateOpen] = useState(false);
  const [name, setName] = useState('');
  const [address, setAddress] = useState('');
  const [selectedAddress, setSelectedAddress] = useState<string | null>(null);
  const [formError, setFormError] = useState<string | null>(null);
  const [toast, setToast] = useState<string | null>(null);

  const resetDraft = (): void => {
    setName('');
    setAddress('');
    setSelectedAddress(null);
    setFormError(null);
    search.reset();
  };
  const closeCreate = (): void => {
    setCreateOpen(false);
    resetDraft();
  };

  // BAN : debounce + garde de sélection. Une suggestion choisie n'est pas recherchée à nouveau,
  // et les résultats d'une ancienne saisie ne sont jamais présentés sous une nouvelle adresse.
  useEffect(() => {
    if (!createOpen) return;
    const query = address.trim();
    if (query.length < 3 || query === selectedAddress) {
      search.reset();
      return;
    }
    const timeout = setTimeout(() => search.mutate(query), SEARCH_DEBOUNCE_MS);
    return () => clearTimeout(timeout);
  }, [address, createOpen, selectedAddress]);

  const ready =
    profile.data !== undefined &&
    moduleActive &&
    chantiers.data !== undefined &&
    !chantiers.isLoading &&
    !chantiers.isError;
  const agentContext = useMemo<AgentContext>(
    () => ({
      screen: { name: 'chantiers', instanceId: 'chantiers' },
      entities: ready
        ? (chantiers.data ?? []).slice(0, 20).map((chantier) => ({
            type: 'chantier' as const,
            id: chantier.id,
            label: chantier.name,
          }))
        : [],
      capabilities: ready ? ['screen.read', 'chantier.read'] : [],
    }),
    [chantiers.data, ready],
  );
  usePublishAgentContext(agentContext);

  const refresh = (): void => {
    void profile.refetch();
    if (moduleActive) void chantiers.refetch();
  };

  const submit = (): void => {
    const trimmedName = name.trim();
    if (!trimmedName || create.isPending) return;
    setFormError(null);
    create.mutate(
      { name: trimmedName, address: address.trim() || null },
      {
        onSuccess: () => {
          const createdName = trimmedName;
          closeCreate();
          setToast(t('chantiers.created', { personality, params: { ...worksiteParams, name: createdName } }));
        },
        onError: () => setFormError(t('chantiers.createError', { personality, params: worksiteParams })),
      },
    );
  };

  const list = chantiers.data ?? null;
  const showAddressResults =
    selectedAddress === null &&
    address.trim().length >= 3 &&
    search.variables === address.trim() &&
    search.isSuccess;

  return (
    <View style={{ flex: 1, backgroundColor: colors.bg }}>
      {/* Lot 4 : bloc retour + InnerScreenHeader → BackHeader kit (fin du sur-espace,
          retours device fondateur) ; « + » → HeaderIconButton (squircle 44/13, géométrie
          unifiée avec le carnet clients). */}
      <BackHeader
        backLabel={t('chantiers.back', { personality })}
        onBack={() => router.back()}
        eyebrow={t('chantiers.eyebrow', { personality })}
        title={t('chantiers.title', { personality, params: worksiteParams })}
        subtitle={t('chantiers.subtitle', { personality })}
        {...(ready
          ? {
              action: (
                <HeaderIconButton
                  accessibilityLabel={t('chantiers.add', { personality, params: worksiteParams })}
                  onPress={() => setCreateOpen(true)}
                >
                  <PlusIcon color={colors.surface} size={20} />
                </HeaderIconButton>
              ),
            }
          : {})}
      />

      <ScrollView
        style={{ flex: 1 }}
        contentContainerStyle={{ paddingHorizontal: 18, paddingTop: 14, paddingBottom: bobScrollInsets.paddingBottom }}
        automaticallyAdjustKeyboardInsets={bobScrollInsets.automaticallyAdjustKeyboardInsets}
        scrollIndicatorInsets={{ bottom: bobScrollInsets.scrollIndicatorBottom }}
        refreshControl={
          <RefreshControl
            refreshing={profile.isRefetching || (moduleActive && chantiers.isRefetching)}
            onRefresh={refresh}
            tintColor={colors.ink800}
            colors={[colors.ink800]}
          />
        }
      >
        {profile.isLoading || profile.data === undefined ? (
          <View style={{ gap: 10 }}>
            <Skeleton height={17} width="38%" radius={8} />
            <Card padding={0} style={{ paddingHorizontal: 14 }}>
              <SkeletonRow avatar="square" trailing="pill" style={{ minHeight: 78 }} />
            </Card>
            <Card padding={0} style={{ paddingHorizontal: 14 }}>
              <SkeletonRow avatar="square" trailing="pill" style={{ minHeight: 78 }} />
            </Card>
          </View>
        ) : profile.isError ? (
          <ErrorRetry
            message={t('chantiers.profileError', { personality, params: worksiteParams })}
            onRetry={() => void profile.refetch()}
            retrying={profile.isRefetching}
          />
        ) : !moduleActive ? (
          <Card>
            <EmptyState
              title={t('chantiers.moduleTitle', { personality, params: worksiteParams })}
              body={t('chantiers.moduleBody', { personality, params: worksiteParams })}
              cta={{ label: t('chantiers.seePlans', { personality }), onPress: () => router.push('/compte') }}
            />
          </Card>
        ) : chantiers.isLoading || list === null ? (
          <View style={{ gap: 10 }}>
            <Skeleton height={17} width="34%" radius={8} />
            {Array.from({ length: 3 }, (_, index) => (
              <Card key={index} padding={0} style={{ paddingHorizontal: 14 }}>
                <SkeletonRow avatar="square" trailing="pill" style={{ minHeight: 78 }} />
              </Card>
            ))}
          </View>
        ) : chantiers.isError ? (
          <ErrorRetry
            message={t('chantiers.dataError', { personality, params: worksiteParams })}
            onRetry={() => void chantiers.refetch()}
            retrying={chantiers.isRefetching}
          />
        ) : list.length === 0 ? (
          <Card>
            <EmptyState
              title={t('chantiers.emptyTitle', { personality, params: worksiteParams })}
              body={t('chantiers.emptyBody', { personality, params: worksiteParams })}
              cta={{
                label: t('chantiers.add', { personality, params: worksiteParams }),
                onPress: () => setCreateOpen(true),
              }}
            />
          </Card>
        ) : (
          <View>
            <SectionHeader title={t('chantiers.listTitle', { personality, params: worksiteParams })} />
            {/* Lot 4 : StaggeredList (cascade sobre fail-closed) + PressableScale (press
                feedback standard) + chevron controls.chevron + label VoiceOver enrichi —
                l'œil voit quatre faits (statut, date, compteurs), le lecteur d'écran aussi. */}
            <StaggeredList itemStyle={{ marginBottom: 10 }}>
              {list.map((chantier) => {
                const statusLabel = t(
                  chantier.status === 'open' ? 'chantiers.open' : 'chantiers.closed',
                  { personality },
                );
                const countsLabel = chantierRowCountsAccessibilityLabel(
                  { noteCount: chantier.noteCount, photoCount: chantier.photoCount },
                  personality,
                );
                return (
                  <PressableScale
                    key={chantier.id}
                    accessibilityRole="button"
                    accessibilityLabel={[
                      chantier.name,
                      statusLabel,
                      t('chantiers.openedOn', {
                        personality,
                        params: { date: frDate(chantier.openedAt) },
                      }),
                      countsLabel,
                    ]
                      .filter(Boolean)
                      .join(', ')}
                    onPress={() => router.push(`/chantier/${chantier.id}`)}
                    style={{ minHeight: 44 }}
                  >
                    <Card>
                      <View style={{ flexDirection: 'row', alignItems: 'flex-start', gap: 12 }}>
                        <View style={{ flex: 1 }}>
                          <Text style={[font('cardTitle'), { color: colors.ink900 }]}>{chantier.name}</Text>
                          {chantier.address ? (
                            <Text style={[font('sub'), { color: colors.slate500, marginTop: 4 }]}>{chantier.address}</Text>
                          ) : null}
                          <Text style={[font('meta'), { color: colors.slate400, marginTop: 5 }]}>
                            {t('chantiers.openedOn', {
                              personality,
                              params: { date: frDate(chantier.openedAt) },
                            })}
                          </Text>
                          <ChantierRowCountBadges
                            counts={{ noteCount: chantier.noteCount, photoCount: chantier.photoCount }}
                            personality={personality}
                          />
                        </View>
                        <StatusBadge label={statusLabel} variant={chantier.status === 'open' ? 'b2b' : 'success'} />
                        <ChevronRightIcon color={controls.chevron} size={14} strokeWidth={2} />
                      </View>
                    </Card>
                  </PressableScale>
                );
              })}
            </StaggeredList>
          </View>
        )}
      </ScrollView>

      <Sheet visible={createOpen} onClose={closeCreate}>
        <KeyboardAvoidingView {...(Platform.OS === 'ios' ? { behavior: 'padding' as const } : {})}>
          <Text style={[font('pageTitle'), { fontSize: 20, color: colors.ink900 }]}>
            {t('chantiers.createTitle', { personality, params: worksiteParams })}
          </Text>
          <Text style={[font('sub'), { color: colors.slate500, lineHeight: 19, marginTop: 4 }]}>
            {t('chantiers.createHint', { personality })}
          </Text>

          <Text style={[font('label', 700), { color: colors.slate400, marginTop: 16 }]}>
            {t('chantiers.nameLabel', { personality, params: worksiteParams }).toUpperCase()}
          </Text>
          <TextInput
            value={name}
            onChangeText={setName}
            placeholder={t('chantiers.namePlaceholder', { personality })}
            placeholderTextColor={colors.slate300}
            accessibilityLabel={t('chantiers.nameLabel', { personality, params: worksiteParams })}
            returnKeyType="next"
            style={[
              font('body'),
              {
                minHeight: 44,
                borderWidth: 1,
                borderColor: colors.lineSoft,
                borderRadius: 12,
                paddingHorizontal: 13,
                paddingVertical: 11,
                color: colors.ink800,
                marginTop: 7,
              },
            ]}
          />

          <Text style={[font('label', 700), { color: colors.slate400, marginTop: 14 }]}>
            {t('chantiers.addressLabel', { personality }).toUpperCase()}
          </Text>
          <TextInput
            value={address}
            onChangeText={(value) => {
              setAddress(value);
              setSelectedAddress(null);
            }}
            placeholder={t('chantiers.addressPlaceholder', { personality, params: worksiteParams })}
            placeholderTextColor={colors.slate300}
            accessibilityLabel={t('chantiers.addressLabel', { personality })}
            style={[
              font('body'),
              {
                minHeight: 44,
                borderWidth: 1,
                borderColor: colors.lineSoft,
                borderRadius: 12,
                paddingHorizontal: 13,
                paddingVertical: 11,
                color: colors.ink800,
                marginTop: 7,
              },
            ]}
          />

          {search.isPending && search.variables === address.trim() ? (
            <View accessibilityLiveRegion="polite" style={{ marginTop: 9, gap: 6 }}>
              <Skeleton height={13} width="88%" radius={6} />
              <Skeleton height={13} width="72%" radius={6} />
            </View>
          ) : search.isError && search.variables === address.trim() ? (
            <View style={{ marginTop: 9 }}>
              <Text accessibilityRole="alert" style={[font('sub'), { color: semantic.danger }]}>
                {t('chantiers.addressError', { personality })}
              </Text>
              <Button
                title={t('chantiers.retry', { personality })}
                variant="secondary"
                size="compact"
                style={{ alignSelf: 'flex-start', marginTop: 8 }}
                onPress={() => search.mutate(address.trim())}
              />
            </View>
          ) : showAddressResults ? (
            (search.data ?? []).length > 0 ? (
              <View accessibilityLiveRegion="polite" style={{ marginTop: 7, gap: 2 }}>
                {(search.data ?? []).map((suggestion, index) => (
                  <Pressable
                    key={`${suggestion.label}-${index}`}
                    accessibilityRole="button"
                    accessibilityLabel={suggestion.label}
                    onPress={() => {
                      setAddress(suggestion.label);
                      setSelectedAddress(suggestion.label);
                      search.reset();
                    }}
                    style={{ minHeight: 44, justifyContent: 'center', paddingHorizontal: 7 }}
                  >
                    <Text style={[font('sub'), { color: colors.ink800 }]}>{suggestion.label}</Text>
                  </Pressable>
                ))}
              </View>
            ) : (
              <Text accessibilityLiveRegion="polite" style={[font('sub'), { color: colors.slate500, marginTop: 9 }]}>
                {t('chantiers.addressNoResult', { personality })}
              </Text>
            )
          ) : null}

          {formError ? (
            <Text accessibilityRole="alert" style={[font('sub'), { color: semantic.danger, marginTop: 12 }]}>
              {formError}
            </Text>
          ) : null}

          <Button
            title={t('chantiers.createSubmit', { personality, params: worksiteParams })}
            disabled={!name.trim()}
            loading={create.isPending}
            onPress={submit}
            style={{ marginTop: 16 }}
          />
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
}
