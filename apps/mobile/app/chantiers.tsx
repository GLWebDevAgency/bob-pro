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
import { shadowNative } from '@bob/tokens';
import { t } from '@bob/i18n';
import {
  Button,
  Card,
  EmptyState,
  ErrorRetry,
  InnerScreenHeader,
  SectionHeader,
  Sheet,
  Skeleton,
  SkeletonRow,
  StatusBadge,
  Toast,
  font,
  useTheme,
} from '@bob/ui';
import { useChantiers, useCreateChantier, useProfile, useSearchAddress } from '../src/data/hooks';
import { usePublishAgentContext, type AgentContext } from '../src/agent';
import { CheckIcon, ChevronLeftIcon, PlusIcon } from '../src/components/icons';
import { useBobAwareScrollInsets } from '../src/components/use-bob-aware-scroll-insets';

const SEARCH_DEBOUNCE_MS = 350;

function frDate(dateOnly: string): string {
  const [year, month, day] = dateOnly.split('-');
  return year && month && day ? `${day}/${month}/${year}` : dateOnly;
}

export default function Chantiers() {
  const { colors, semantic, theme, personality } = useTheme();
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

  const ready = moduleActive && !chantiers.isLoading && !chantiers.isError;
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
      capabilities: ready ? ['screen.read', 'chantier.read'] : ['screen.read'],
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
          setToast(t('chantiers.created', { personality, params: { name: createdName } }));
        },
        onError: () => setFormError(t('chantiers.createError', { personality })),
      },
    );
  };

  const list = chantiers.data ?? [];
  const showAddressResults =
    selectedAddress === null &&
    address.trim().length >= 3 &&
    search.variables === address.trim() &&
    search.isSuccess;

  return (
    <View style={{ flex: 1, backgroundColor: colors.bg }}>
      <View style={{ paddingTop: insets.top + 10, paddingHorizontal: 16 }}>
        <Pressable
          onPress={() => router.back()}
          accessibilityRole="button"
          accessibilityLabel={t('chantiers.back', { personality })}
          hitSlop={8}
          style={{
            minHeight: 44,
            flexDirection: 'row',
            alignItems: 'center',
            gap: 4,
            alignSelf: 'flex-start',
          }}
        >
          <ChevronLeftIcon color={colors.ink800} size={18} strokeWidth={2.2} />
          <Text style={[font('label', 600), { fontSize: 15, color: colors.ink800 }]}>
            {t('chantiers.back', { personality })}
          </Text>
        </Pressable>
      </View>

      <InnerScreenHeader
        eyebrow={t('chantiers.eyebrow', { personality })}
        title={t('chantiers.title', { personality })}
        subtitle={t('chantiers.subtitle', { personality })}
        action={
          moduleActive && !profile.isError ? (
            <Pressable
              accessibilityRole="button"
              accessibilityLabel={t('chantiers.add', { personality })}
              onPress={() => setCreateOpen(true)}
              style={{
                width: 44,
                height: 44,
                borderRadius: 22,
                backgroundColor: theme.ink,
                alignItems: 'center',
                justifyContent: 'center',
                ...shadowNative.e1,
              }}
            >
              <PlusIcon color={colors.surface} size={20} />
            </Pressable>
          ) : undefined
        }
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
        {profile.isLoading ? (
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
          <ErrorRetry message={t('chantiers.profileError', { personality })} onRetry={() => void profile.refetch()} />
        ) : !moduleActive ? (
          <Card>
            <EmptyState
              title={t('chantiers.moduleTitle', { personality })}
              body={t('chantiers.moduleBody', { personality })}
              cta={{ label: t('chantiers.seePlans', { personality }), onPress: () => router.push('/compte') }}
            />
          </Card>
        ) : chantiers.isLoading ? (
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
            message={t('chantiers.dataError', { personality })}
            onRetry={() => void chantiers.refetch()}
          />
        ) : list.length === 0 ? (
          <Card>
            <EmptyState
              title={t('chantiers.emptyTitle', { personality })}
              body={t('chantiers.emptyBody', { personality })}
              cta={{ label: t('chantiers.add', { personality }), onPress: () => setCreateOpen(true) }}
            />
          </Card>
        ) : (
          <View>
            <SectionHeader title={t('chantiers.listTitle', { personality })} />
            <View style={{ gap: 10 }}>
              {list.map((chantier) => (
                <Card key={chantier.id}>
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
                    </View>
                    <StatusBadge
                      label={t(chantier.status === 'open' ? 'chantiers.open' : 'chantiers.closed', {
                        personality,
                      })}
                      variant={chantier.status === 'open' ? 'b2b' : 'success'}
                    />
                  </View>
                </Card>
              ))}
            </View>
          </View>
        )}
      </ScrollView>

      <Sheet visible={createOpen} onClose={closeCreate}>
        <KeyboardAvoidingView {...(Platform.OS === 'ios' ? { behavior: 'padding' as const } : {})}>
          <Text style={[font('pageTitle'), { fontSize: 20, color: colors.ink900 }]}>
            {t('chantiers.createTitle', { personality })}
          </Text>
          <Text style={[font('sub'), { color: colors.slate500, lineHeight: 19, marginTop: 4 }]}>
            {t('chantiers.createHint', { personality })}
          </Text>

          <Text style={[font('label', 700), { color: colors.slate400, marginTop: 16 }]}>
            {t('chantiers.nameLabel', { personality }).toUpperCase()}
          </Text>
          <TextInput
            value={name}
            onChangeText={setName}
            placeholder={t('chantiers.namePlaceholder', { personality })}
            placeholderTextColor={colors.slate300}
            accessibilityLabel={t('chantiers.nameLabel', { personality })}
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
            placeholder={t('chantiers.addressPlaceholder', { personality })}
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
            title={t('chantiers.createSubmit', { personality })}
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
