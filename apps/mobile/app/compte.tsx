/**
 * Mon compte — Profil / Abonnement (claim C26 v2, réf proto dc.html §COMPTE & ABONNEMENT).
 *
 * DOCTRINE HONNÊTETÉ (le cœur du claim) : GET /subscription dit la vérité PAR TENANT. En V1 privée,
 * une ligne BDD explicite porte earlyAccess: true, 0 €, et le serveur masque les offres tant que la
 * facturation live n'est pas complètement configurée :
 * · offre courante = Accès anticipé · 0 €/mois · toutes les fonctions ouvertes ;
 * · à l'ouverture publique, la grille vient du catalogue serveur et déclenche le checkout durable
 *   ou le portail réellement lié au canal de facturation persistant ;
 * · toucher une offre ≠ la sienne affiche le diff honnête « tu gagnes / tu perds » sous la
 *   grille (diffPlanChange @bob/core, SPEC pilier 2 décision 7) : gains ET pertes au même poids,
 *   économie affichée si downgrade — comparaison factuelle avant toute action ;
 * · GET /subscription/invoices distingue une source indisponible, une vraie liste vide et les
 *   factures Stripe persistées après webhook vérifié ;
 *   banque = « À connecter » (aucun bridge) ·
 *   services en plus = badge dérivé du réel (deriveServiceStatus, module TradeConfig) sinon
 *   « À venir ».
 * Toute la dérivation vit dans @bob/core (deriveAccountView, use case pur testé) ; l'écran rend.
 *
 * DONNÉES RÉELLES : identité via useIdentity (jamais de société d'exemple),
 * email = session Supabase (useAuth), profil métier via useProfile (client.getProfile),
 * Se déconnecter = signOut réel, « Facturation & modèles » → /reglages-facturation (C27).
 * Erreur profil → bannière voix de Bob SANS bloquer l'écran (la déconnexion reste accessible),
 * la vue se dégrade honnêtement (tradeConfig null → pas de taux TVA inventé, services « À venir »).
 *
 * Écarts assumés vs proto (listés au contrat) : pas de badge ACTIVE ni d'essai 14 j fantôme,
 * pas de « Banque — Crédit Agricole connectée », parrainage/équipe = teasers
 * « à venir » (aucun flux) ; les réglages autonomie/dictée de l'ancien écran ne font pas partie
 * de la structure C26. Zéro hex/rgba : useTheme()/@bob/tokens uniquement.
 */
import { useEffect, useMemo, useState } from 'react';
import { Alert, Linking, Pressable, RefreshControl, ScrollView, Text, View } from 'react-native';
import { useRouter, useLocalSearchParams } from 'expo-router';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { LinearGradient } from 'expo-linear-gradient';
import Constants from 'expo-constants';
import { Feather } from '@expo/vector-icons';
import {
  deriveAccountView,
  diffPlanChange,
  formatEURWhole,
  PLAN_CATALOG,
  TIER_ORDER,
  type AccountConnectionView,
  type AccountServiceKey,
  type AccountView,
  type PaidTier,
  type PlanTier,
} from '@bob/core';
import { t, type I18nKey } from '@bob/i18n';
import { shadowComponentsNative, spacing } from '@bob/tokens';
import { bobErrorCode } from '@bob/api-client';
import { featureLabel } from '../src/monetization/feature-labels';
import {
  Avatar,
  Button,
  Card,
  EmptyState,
  ErrorRetry,
  FILTER_CHIP_TINT_SHARE,
  FadeIn,
  IconTile,
  SectionHeader,
  SegmentedControl,
  Skeleton,
  SkeletonCard,
  SkeletonRow,
  StatusBadge,
  font,
  mixTint,
  parseGradient,
  useErrorSheet,
  useTheme,
  type ErrorSheetFacts,
} from '@bob/ui';
import { useIdentity } from '../src/data/identity';
import { useAuth } from '../src/data/auth';
import {
  appErrorMessage,
  useCompanyMe,
  useProfile,
  useBillingPortal,
  useStartCheckout,
  useSubscription,
  useSubscriptionInvoices,
} from '../src/data/hooks';
import { useFiscalProfileFlow } from '../src/fiscal/use-fiscal-profile-flow';
import { LEGAL_URLS, SUPPORT_EMAIL, SUPPORT_MAILTO } from '../src/config/legal';
import { CloseAccountSheet } from '../src/components/account/close-account-sheet';
import { ScreenHeader } from '../src/components/screen-header';
import { useBobAwareScrollInsets } from '../src/components/use-bob-aware-scroll-insets';
import { hasBlockingAuthoritativeDataError } from '../src/data/authoritative-query-state';
import {
  CheckIcon,
  ChevronRightIcon,
  CurrencyIcon,
  FileTextIcon,
  MailIcon,
  PeopleIcon,
  ShieldIcon,
  TrendUpIcon,
  WalletIcon,
} from '../src/components/icons';

type AccountTab = 'profil' | 'abonnement';

/** Clés i18n des connexions (libellé + statut) — le statut vient du core, jamais de l'écran. */
const CONNECTION_LABEL_KEYS = {
  bank: 'account.connBank',
  payment: 'account.connPayment',
  accountant: 'account.connAccountant',
} as const;

/** Clés i18n des services en plus (titre + sous-titre). */
const SERVICE_LABEL_KEYS: Record<AccountServiceKey, { title: I18nKey; sub: I18nKey }> = {
  online_payment: { title: 'account.serviceOnlinePayment', sub: 'account.serviceOnlinePaymentSub' },
  invoice_advance: { title: 'account.serviceAdvance', sub: 'account.serviceAdvanceSub' },
  insurance: { title: 'account.serviceInsurance', sub: 'account.serviceInsuranceSub' },
  accountant: { title: 'account.serviceAccountant', sub: 'account.serviceAccountantSub' },
};

function ProfileSkeleton({ label }: { label: string }) {
  return (
    <View style={{ gap: 12 }} accessibilityRole="progressbar" accessibilityLabel={label}>
      <Skeleton height={17} width="34%" radius={8} />
      <Card padding={0} style={{ paddingHorizontal: 15 }}>
        {Array.from({ length: 4 }, (_, index) => (
          <View key={index} style={{ paddingVertical: 11 }}>
            <Skeleton height={13} width={index % 2 === 0 ? '72%' : '58%'} radius={6} />
          </View>
        ))}
      </Card>
      <SkeletonCard height={72} contentLines={2} />
      <SkeletonCard height={176} contentLines={4} />
    </View>
  );
}

function SubscriptionSkeleton({ label }: { label: string }) {
  return (
    <View style={{ gap: 12 }} accessibilityRole="progressbar" accessibilityLabel={label}>
      <Skeleton height={126} radius={20} />
      <Skeleton height={17} width="42%" radius={8} />
      <SkeletonCard height={164} contentLines={4} />
      <SkeletonCard height={164} contentLines={4} />
      <Card padding={0} style={{ paddingHorizontal: 15 }}>
        <SkeletonRow avatar="square" trailing="pill" style={{ minHeight: 76 }} />
        <SkeletonRow avatar="square" trailing="pill" style={{ minHeight: 76 }} />
      </Card>
    </View>
  );
}

export default function Compte() {
  const { colors, semantic, controls, overlays, radius, grad, theme, personality } = useTheme();
  const insets = useSafeAreaInsets();
  const bobScrollInsets = useBobAwareScrollInsets({ minimumBottom: insets.bottom + 34 });
  const router = useRouter();
  const identity = useIdentity();
  const { enabled: authEnabled, session, signOut } = useAuth();
  const profile = useProfile();
  const companyMe = useCompanyMe();
  const subscription = useSubscription();
  const subscriptionInvoices = useSubscriptionInvoices();
  const startCheckout = useStartCheckout();
  const billingPortal = useBillingPortal();
  // SPEC_EXPERT_FISCAL §UX FLOW amendement 5 : résidence du profil fiscal = carte Compte →
  // écran dédié /profil-fiscal (query PARTAGÉE — coût nul, déjà chaude si Argent/Home l'ont lue).
  const fiscalFlow = useFiscalProfileFlow();
  // Onglet adressable (deep link : /compte?tab=abonnement — notifications d'abo, docs).
  // useEffect (pas seulement l'initialiseur) : un deep link doit basculer l'onglet même
  // quand l'écran est déjà monté (tap sur une notification, app au premier plan).
  const params = useLocalSearchParams<{ tab?: string }>();
  const [tab, setTab] = useState<AccountTab>(params.tab === 'abonnement' ? 'abonnement' : 'profil');
  useEffect(() => {
    if (params.tab === 'abonnement' || params.tab === 'profil') setTab(params.tab);
  }, [params.tab]);
  // Diff « tu gagnes / tu perds » (SPEC pilier 2, décision 7) : offre touchée ≠ la sienne →
  // comparaison factuelle sous la grille ; second tap = désélection. AUCUNE souscription.
  const [comparedTier, setComparedTier] = useState<PaidTier | null>(null);
  // Échecs de checkout/portail (mutations appelables au support) → ErrorSheet 2 faces —
  // le Alert.alert('Oups') du hook partagé est banni par la grammaire d'erreur.
  const { showErrorFacts, errorSheet } = useErrorSheet();
  const mutationFacts = (e: unknown, message: string): ErrorSheetFacts => {
    const err = (e ?? {}) as { code?: string; correlationId?: string; kind?: string };
    return {
      message,
      code: err.code ?? bobErrorCode(e),
      ...(err.correlationId !== undefined ? { correlationId: err.correlationId } : {}),
      ...(err.kind !== undefined ? { kind: err.kind } : {}),
      at: new Date().toISOString(),
    };
  };

  const view: AccountView = useMemo(
    () =>
      deriveAccountView({
        identity: {
          firstName: identity.firstName,
          companyName: identity.companyName,
          legalLine: identity.legalLine,
        },
        company: companyMe.data ?? null,
        tradeConfig: profile.data ?? null,
        // GET /subscription RÉEL (C26b) — l'accès anticipé est un état BDD explicite. Une
        // absence de photographie reste `null`/indisponible et n'est jamais interprétée.
        subscription: subscription.data ?? null,
        subscriptionInvoices: subscriptionInvoices.data ?? null,
      }),
    [companyMe.data, identity, profile.data, subscription.data, subscriptionInvoices.data],
  );

  const email = session?.user?.email ?? null;
  const displayName = view.profile.displayName ?? '—';
  const avatarName = [identity.firstName, identity.companyName].filter(Boolean).join(' ') || displayName;
  const subline = email ?? identity.companyName;
  const say = (key: I18nKey, params?: Record<string, string | number>) =>
    t(key, params ? { personality, params } : { personality });

  // Audit stores 20260716 (bloquants #1 et #4) : suppression de compte + footer légal.
  const [deleteSheetOpen, setDeleteSheetOpen] = useState(false);
  const appVersion = Constants.expoConfig?.version ?? '—';
  const openExternalUrl = (url: string): void => {
    void Linking.openURL(url).catch(() => Alert.alert(say('account.linkUnavailable')));
  };

  const heroGradient = parseGradient(grad.hero);
  const offer = view.subscription.offer;
  const profileHasBlockingError = hasBlockingAuthoritativeDataError([
    profile,
    companyMe,
    { isError: fiscalFlow.isError, data: fiscalFlow.profile },
  ]);
  const profileHasStaleError = !profileHasBlockingError
    && (profile.isError || companyMe.isError || fiscalFlow.isError);
  const profileSourcesReady =
    profile.data !== undefined && companyMe.data !== undefined && fiscalFlow.profile !== undefined;
  const profileFresh = profileSourcesReady && !profileHasStaleError;
  const profileLoading =
    !profileSourcesReady
    && !profileHasBlockingError
    && (profile.isLoading || companyMe.isLoading || fiscalFlow.isLoading || !profileSourcesReady);
  const subscriptionReady =
    subscription.data !== undefined && subscriptionInvoices.data !== undefined;
  const subscriptionBlockingError =
    (subscription.isError && subscription.data === undefined)
    || (subscriptionInvoices.isError && subscriptionInvoices.data === undefined);
  const subscriptionStaleError =
    subscriptionReady && (subscription.isError || subscriptionInvoices.isError);
  const subscriptionLoading = !subscriptionReady && !subscriptionBlockingError;
  const deleteCompanyName = profileFresh ? companyMe.data?.name ?? null : null;
  const deleteAllowed = authEnabled && deleteCompanyName !== null && deleteCompanyName.trim() !== '';
  const refetchProfile = (): void => {
    void profile.refetch();
    void companyMe.refetch();
    void fiscalFlow.refetch();
  };
  const refetchSubscription = (): void => {
    void subscription.refetch();
    void subscriptionInvoices.refetch();
  };
  const openStoreSubscriptionManagement = (): void => {
    const store = subscription.data?.store;
    if (store === 'apple') {
      openExternalUrl('https://apps.apple.com/account/subscriptions');
    } else if (store === 'google') {
      openExternalUrl('https://play.google.com/store/account/subscriptions');
    }
  };

  useEffect(() => {
    if (!deleteAllowed) setDeleteSheetOpen(false);
  }, [deleteAllowed]);

  return (
    <View style={{ flex: 1, backgroundColor: colors.bg }}>
      <ScreenHeader
        backLabel={say('account.back')}
        onBack={() => router.back()}
        eyebrow={say('account.eyebrow')}
        title={say('account.title')}
        subtitle={say('account.subtitle')}
      />

      <View style={{ paddingHorizontal: spacing.gutter, paddingTop: 14 }}>
        <SegmentedControl<AccountTab>
          options={[
            { key: 'profil', label: say('account.tabProfile') },
            { key: 'abonnement', label: say('account.tabSubscription') },
          ]}
          value={tab}
          onChange={setTab}
          accessibilityLabel={say('account.title')}
        />
      </View>

      <ScrollView
        style={{ flex: 1 }}
        contentContainerStyle={{
          paddingHorizontal: spacing.gutter,
          paddingTop: 16,
          paddingBottom: bobScrollInsets.paddingBottom,
        }}
        automaticallyAdjustKeyboardInsets={bobScrollInsets.automaticallyAdjustKeyboardInsets}
        scrollIndicatorInsets={{ bottom: bobScrollInsets.scrollIndicatorBottom }}
        showsVerticalScrollIndicator={false}
        refreshControl={
          <RefreshControl
            refreshing={
              tab === 'profil'
                ? profile.isRefetching || companyMe.isRefetching || fiscalFlow.isRefetching
                : subscription.isRefetching || subscriptionInvoices.isRefetching
            }
            onRefresh={() => {
              if (tab === 'profil') refetchProfile();
              else refetchSubscription();
            }}
            tintColor={colors.ink800}
            colors={[colors.ink800]}
          />
        }
      >
        {/* Fade-through fail-closed au changement d'onglet (pattern client/[id]) — le FadeIn
            kit rejoue au remontage (key) et s'éteint par construction sous reduce-motion. */}
        <FadeIn key={tab}>
        {tab === 'profil' ? (
          <>
            {/* Identité — session signée + fiche société BDD uniquement. */}
            <View style={{ flexDirection: 'row', alignItems: 'center', gap: 13, marginBottom: 16 }}>
              <Avatar name={avatarName} size={54} />
              <View style={{ flex: 1 }}>
                {/* 17 ad hoc → cran section (17/700 display) ; sous-titre slate500 (AA). */}
                <Text style={[font('section'), { color: colors.ink900 }]}>
                  {displayName}
                </Text>
                {subline ? (
                  <Text style={[font('sub'), { color: colors.slate500, marginTop: 2 }]}>{subline}</Text>
                ) : null}
              </View>
            </View>

            {profileLoading ? (
              <ProfileSkeleton label={say('account.profileLoading')} />
            ) : profileHasBlockingError ? (
              <ErrorRetry
                message={say('account.dataError')}
                onRetry={refetchProfile}
                retrying={profile.isRefetching || companyMe.isRefetching || fiscalFlow.isRefetching}
              />
            ) : (
              <>
            {profileHasStaleError ? (
              <View style={{ marginBottom: 16 }}>
                <ErrorRetry
                  message={say('account.dataError')}
                  onRetry={refetchProfile}
                  retrying={
                    profile.isRefetching || companyMe.isRefetching || fiscalFlow.isRefetching
                  }
                />
              </View>
            ) : null}
            <SectionHeader title={say('account.sectionCompany')} />
            {view.profile.company ? (
              <Card padding={15} style={{ marginBottom: 16 }}>
                {(
                  [
                    { key: 'name', label: say('account.companyName'), value: view.profile.company.name, tabular: false },
                    { key: 'siret', label: say('account.companySiret'), value: view.profile.company.siretFormatted, tabular: true },
                    { key: 'legal', label: say('account.companyLegalTrade'), value: view.profile.company.legalTradeLine, tabular: false },
                    { key: 'vat', label: say('account.companyVat'), value: view.profile.company.vatLine, tabular: false },
                  ] as const
                ).map((row, index, rows) => (
                  <View
                    key={row.key}
                    style={{
                      flexDirection: 'row',
                      justifyContent: 'space-between',
                      alignItems: 'center',
                      gap: 12,
                      paddingVertical: 11,
                      borderBottomWidth: index === rows.length - 1 ? 0 : 1,
                      borderBottomColor: colors.lineSoft,
                    }}
                  >
                    <Text style={[font('sub'), { color: colors.slate400 }]}>{row.label}</Text>
                    <Text
                      style={[
                        font('body', 700),
                        { color: colors.ink800, flexShrink: 1, textAlign: 'right' },
                        row.tabular ? { fontVariant: ['tabular-nums'] } : null,
                      ]}
                    >
                      {row.value}
                    </Text>
                  </View>
                ))}
              </Card>
            ) : (
              // Cul-de-sac corrigé (retours device fondateur) : en architecture, une fiche
              // société arrive TOUJOURS avant cet écran (ProvisioningScreen, gate racine
              // _layout.tsx) — ce null ne devrait donc survenir que si `GET /company/me`
              // a échoué silencieusement malgré un tenant valide dans le JWT. Aucun flow
              // libre-service de ré-édition de la fiche n'existe encore (SIRET/raison
              // sociale ne sont éditables qu'à l'inscription) : la carte reste ACTIONNABLE
              // (contact support réel) plutôt qu'un texte mort « ça s'affichera bientôt ».
              // TODO tracé : construire un écran dédié de complétion post-inscription +
              // endpoint d'écriture (au-delà d'iban/bic, cf. PATCH /company/billing) le
              // jour où ce cas cesse d'être une exception.
              // Coquille Card kit + pressed state (les rangées de navigation étaient mortes
              // au doigt) ; tuile 'document' — la fiche société est du CONTENU papier, pas du
              // B2G (l'alias indigo est banni hors canal Bob).
              <Card padding={15} style={{ marginBottom: 16 }}>
                <Pressable
                  accessibilityRole="button"
                  accessibilityLabel={`${say('account.companyEmptyTitle')}. ${say('account.companyEmptyBody')}`}
                  onPress={() => openExternalUrl(SUPPORT_MAILTO)}
                  style={({ pressed }) => ({
                    flexDirection: 'row',
                    alignItems: 'center',
                    gap: 13,
                    minHeight: 44,
                    opacity: pressed ? 0.65 : 1,
                  })}
                >
                  <IconTile tone="document" size={36} radius={11}>
                    <FileTextIcon color={colors.slate500} size={18} />
                  </IconTile>
                  <View style={{ flex: 1 }}>
                    <Text style={[font('body', 700), { color: colors.ink800 }]}>
                      {say('account.companyEmptyTitle')}
                    </Text>
                    <Text style={[font('meta'), { color: colors.slate500, marginTop: 1 }]}>
                      {say('account.companyEmptyBody')}
                    </Text>
                  </View>
                  <ChevronRightIcon color={colors.slate300} size={17} />
                </Pressable>
              </Card>
            )}

            {/* Facturation & modèles → écran C27 (réel) — coquille Card kit + pressed state. */}
            <Card padding={15} style={{ marginBottom: 16 }}>
              <Pressable
                accessibilityRole="button"
                accessibilityLabel={say('account.billingRow')}
                onPress={() => router.push('/reglages-facturation')}
                style={({ pressed }) => ({
                  flexDirection: 'row',
                  alignItems: 'center',
                  gap: 11,
                  minHeight: 44,
                  opacity: pressed ? 0.65 : 1,
                })}
              >
                <IconTile tone="success" size={34} radius={11}>
                  <FileTextIcon color={semantic.success} size={18} />
                </IconTile>
                <View style={{ flex: 1 }}>
                  <Text style={[font('body', 600), { color: colors.ink800 }]}>
                    {say('account.billingRow')}
                  </Text>
                  <Text style={[font('meta'), { color: colors.slate500, marginTop: 1 }]}>
                    {say('account.billingRowSub')}
                  </Text>
                </View>
                <ChevronRightIcon color={colors.slate300} size={17} />
              </Pressable>
            </Card>

            {/* Mon profil fiscal → écran dédié (SPEC_EXPERT_FISCAL §UX FLOW amendement 5) —
                tuile 'document' : un profil déclaratif est du CONTENU, pas du B2G. */}
            <Card padding={15} style={{ marginBottom: 16 }}>
              <Pressable
                accessibilityRole="button"
                accessibilityLabel={`${say('fiscal.account.row')}. ${
                  fiscalFlow.hasPending
                    ? say(
                        fiscalFlow.remainingCount === 1 ? 'fiscal.account.rowSubPendingOne' : 'fiscal.account.rowSubPending',
                        { count: fiscalFlow.remainingCount },
                      )
                    : say('fiscal.account.rowSubComplete')
                }`}
                onPress={() => router.push('/profil-fiscal')}
                style={({ pressed }) => ({
                  flexDirection: 'row',
                  alignItems: 'center',
                  gap: 11,
                  minHeight: 44,
                  opacity: pressed ? 0.65 : 1,
                })}
              >
                <IconTile tone="document" size={34} radius={11}>
                  <CurrencyIcon color={colors.slate500} size={18} />
                </IconTile>
                <View style={{ flex: 1 }}>
                  <Text style={[font('body', 600), { color: colors.ink800 }]}>{say('fiscal.account.row')}</Text>
                  <Text style={[font('meta'), { color: colors.slate500, marginTop: 1 }]}>
                    {fiscalFlow.hasPending
                      ? say(
                          fiscalFlow.remainingCount === 1 ? 'fiscal.account.rowSubPendingOne' : 'fiscal.account.rowSubPending',
                          { count: fiscalFlow.remainingCount },
                        )
                      : say('fiscal.account.rowSubComplete')}
                  </Text>
                </View>
                <ChevronRightIcon color={colors.slate300} size={17} />
              </Pressable>
            </Card>

            <SectionHeader title={say('account.sectionConnections')} />
            <Card padding={15} style={{ marginBottom: 16 }}>
              {view.profile.connections.map((conn: AccountConnectionView, index) => (
                <View
                  key={conn.key}
                  style={{
                    flexDirection: 'row',
                    alignItems: 'center',
                    gap: 11,
                    paddingVertical: 12,
                    borderBottomWidth: index === view.profile.connections.length - 1 ? 0 : 1,
                    borderBottomColor: colors.lineSoft,
                  }}
                >
                  {conn.key === 'bank' ? (
                    <WalletIcon color={colors.ink600} size={19} strokeWidth={2} />
                  ) : conn.key === 'payment' ? (
                    <CurrencyIcon color={colors.ink600} size={19} strokeWidth={2} />
                  ) : (
                    <PeopleIcon color={colors.ink600} size={19} strokeWidth={2} />
                  )}
                  <Text style={[font('body', 600), { color: colors.ink800, flex: 1 }]}>
                    {say(CONNECTION_LABEL_KEYS[conn.key])}
                  </Text>
                  {/* « À connecter » : warningInk (l'ambre nu ≈3,4:1 échouait en 12 px). */}
                  <Text
                    style={[
                      font('meta', 700),
                      { color: conn.status === 'to_connect' ? semantic.warningInk : colors.slate500 },
                    ]}
                  >
                    {conn.status === 'to_connect' ? say('account.connToConnect') : say('account.connSoon')}
                  </Text>
                </View>
              ))}
            </Card>

            {/* Parrainage — teaser honnête : aucun flux n'existe encore. Matière MARINE
                (b2bBg) : ce n'est pas Bob qui parle — l'indigo est son canal EXCLUSIF. */}
            <Card padding={15} style={{ marginBottom: 16, backgroundColor: semantic.b2bBg, borderColor: semantic.b2bBg }}>
              <View style={{ flexDirection: 'row', alignItems: 'center', gap: 13 }}>
                <IconTile tone="b2b" size={34} radius={11}>
                  <Feather name="gift" size={18} color={semantic.b2b} />
                </IconTile>
                <View style={{ flex: 1 }}>
                  <Text style={[font('body', 700), { color: colors.ink800 }]}>
                    {say('account.referralTitle')}
                  </Text>
                  <Text style={[font('meta'), { color: colors.slate500, marginTop: 1 }]}>
                    {say('account.referralSoon')}
                  </Text>
                </View>
              </View>
            </Card>

            {/* Équipe & rôles — badge du palier requis : 'neutral' (un palier d'abonnement
                n'est pas une typologie client B2G). */}
            <Card padding={15} style={{ marginBottom: 16 }}>
              <View style={{ flexDirection: 'row', alignItems: 'center', gap: 11 }}>
                <IconTile tone="b2b" size={34} radius={11}>
                  <PeopleIcon color={semantic.b2b} size={18} strokeWidth={2} />
                </IconTile>
                <View style={{ flex: 1 }}>
                  <Text style={[font('body', 600), { color: colors.ink800 }]}>
                    {say('account.teamRow')}
                  </Text>
                  <Text style={[font('meta'), { color: colors.slate500, marginTop: 1 }]}>
                    {say('account.teamRowSub')}
                  </Text>
                </View>
                <StatusBadge
                  variant="neutral"
                  label={PLAN_CATALOG[view.profile.team.requiredTier].label.toUpperCase()}
                />
              </View>
            </Card>
              </>
            )}

            {authEnabled ? (
              <Button
                title={say('account.signOut')}
                variant="danger"
                onPress={() => void signOut()}
              />
            ) : null}

            {/* Section légale (audit stores 20260716, bloquant #4) — version, CGU, confidentialité, contact */}
            <View style={{ marginTop: 24, marginBottom: 8 }}>
              <SectionHeader title={say('account.sectionLegal')} />
            </View>
            <Card padding={0} style={{ marginBottom: 6, paddingHorizontal: 15 }}>
              {(
                [
                  { key: 'terms', label: say('account.legalTerms'), sub: null, onPress: () => openExternalUrl(LEGAL_URLS.terms), icon: <FileTextIcon color={colors.ink600} size={17} strokeWidth={2} /> },
                  { key: 'privacy', label: say('account.legalPrivacy'), sub: null, onPress: () => openExternalUrl(LEGAL_URLS.privacy), icon: <ShieldIcon color={colors.ink600} size={17} strokeWidth={2} /> },
                  { key: 'contact', label: say('account.contactSupport'), sub: SUPPORT_EMAIL, onPress: () => openExternalUrl(SUPPORT_MAILTO), icon: <MailIcon color={colors.ink600} size={17} strokeWidth={2} /> },
                ] as const
              ).map((row, index, rows) => (
                <Pressable
                  key={row.key}
                  accessibilityRole="link"
                  accessibilityLabel={row.sub ? `${row.label}. ${row.sub}` : row.label}
                  onPress={row.onPress}
                  style={{
                    flexDirection: 'row',
                    alignItems: 'center',
                    gap: 11,
                    paddingVertical: 13,
                    minHeight: 44,
                    borderBottomWidth: index === rows.length - 1 ? 0 : 1,
                    borderBottomColor: colors.lineSoft,
                  }}
                >
                  {row.icon}
                  <View style={{ flex: 1 }}>
                    <Text style={[font('sub', 600), { fontSize: 14, color: colors.ink800 }]}>{row.label}</Text>
                    {row.sub ? (
                      <Text style={[font('meta'), { color: colors.slate400, marginTop: 1 }]}>{row.sub}</Text>
                    ) : null}
                  </View>
                  <ChevronRightIcon color={colors.slate300} size={16} />
                </Pressable>
              ))}
            </Card>
            {/* Diagnostic TECHNIQUE (SPEC_SYSTEME_ERREUR §5.2) — les références des derniers
                échecs API, partageables au support. Distinct de /diagnostic (comptable). */}
            <Card padding={0} style={{ marginBottom: 6, paddingHorizontal: 15 }}>
              <Pressable
                accessibilityRole="button"
                accessibilityLabel={`${say('account.diagnosticRow')}. ${say('account.diagnosticRowSub')}`}
                onPress={() => router.push('/diagnostic-technique')}
                style={({ pressed }) => ({
                  flexDirection: 'row',
                  alignItems: 'center',
                  gap: 11,
                  paddingVertical: 13,
                  minHeight: 44,
                  opacity: pressed ? 0.65 : 1,
                })}
              >
                <Feather name="activity" color={colors.ink600} size={17} />
                <View style={{ flex: 1 }}>
                  <Text style={[font('body', 600), { color: colors.ink800 }]}>
                    {say('account.diagnosticRow')}
                  </Text>
                  <Text style={[font('meta'), { color: colors.slate500, marginTop: 1 }]}>
                    {say('account.diagnosticRowSub')}
                  </Text>
                </View>
                <ChevronRightIcon color={colors.slate300} size={16} />
              </Pressable>
            </Card>
            <Text style={[font('meta'), { color: colors.slate300, marginBottom: 20 }]}>
              {say('account.appVersion', { version: appVersion })}
            </Text>

            {/* Zone dangereuse — suppression de compte (Apple 5.1.1(v)), AUCUNE parité vocale
                (choix délibéré, cf. CloseAccountSheet) : uniquement pour un compte réel authentifié. */}
            {authEnabled ? (
              <>
                <SectionHeader title={say('account.dangerZoneTitle')} />
                <Pressable
                  accessibilityRole="button"
                  accessibilityLabel={`${say('account.deleteAccountRow')}. ${say('account.deleteAccountRowSub')}`}
                  disabled={!deleteAllowed}
                  onPress={() => {
                    if (deleteAllowed) setDeleteSheetOpen(true);
                  }}
                  style={[
                    {
                      flexDirection: 'row',
                      alignItems: 'center',
                      gap: 11,
                      backgroundColor: colors.surface,
                      borderRadius: radius.cardLg,
                      borderWidth: 1,
                      borderColor: semantic.dangerBg,
                      padding: 15,
                      marginTop: 10,
                    },
                    !deleteAllowed ? { opacity: 0.5 } : null,
                  ]}
                >
                  <IconTile tone="danger" size={34} radius={11}>
                    <Feather name="trash-2" size={17} color={semantic.danger} />
                  </IconTile>
                  <View style={{ flex: 1 }}>
                    <Text style={[font('sub', 600), { fontSize: 14.5, color: semantic.danger }]}>
                      {say('account.deleteAccountRow')}
                    </Text>
                    <Text style={[font('meta'), { color: colors.slate400, marginTop: 1 }]}>
                      {say('account.deleteAccountRowSub')}
                    </Text>
                  </View>
                  <ChevronRightIcon color={colors.slate300} size={17} />
                </Pressable>
                <Text style={[font('meta'), { color: colors.slate400, marginTop: 10, lineHeight: 17 }]}>
                  {say('account.gdprNote', { email: SUPPORT_EMAIL })}
                </Text>
                {deleteCompanyName !== null ? (
                  <CloseAccountSheet
                    visible={deleteSheetOpen && deleteAllowed}
                    companyName={deleteCompanyName}
                    personality={personality}
                    onClose={() => setDeleteSheetOpen(false)}
                  />
                ) : null}
              </>
            ) : null}
          </>
        ) : (
          <>
            {subscriptionLoading ? (
              <SubscriptionSkeleton label={say('account.subscriptionLoading')} />
            ) : subscriptionBlockingError ? (
              <ErrorRetry
                message={say('account.subscriptionError')}
                onRetry={refetchSubscription}
                retrying={subscription.isRefetching || subscriptionInvoices.isRefetching}
              />
            ) : !subscriptionReady
              || offer.kind === 'unavailable'
              || view.subscription.invoices === null ? (
              <ErrorRetry
                message={say('account.subscriptionError')}
                onRetry={refetchSubscription}
                retrying={subscription.isRefetching || subscriptionInvoices.isRefetching}
              />
            ) : (
              <>
            {subscriptionStaleError ? (
              <View style={{ marginBottom: 16 }}>
                <ErrorRetry
                  message={say('account.subscriptionError')}
                  onRetry={refetchSubscription}
                  retrying={subscription.isRefetching || subscriptionInvoices.isRefetching}
                />
              </View>
            ) : null}
            {/* Offre courante — la VÉRITÉ produit (accès anticipé), jamais un plan « ACTIVE » inventé */}
            <View style={[{ borderRadius: 20, marginBottom: 18 }, shadowComponentsNative.heroMoney]}>
              <LinearGradient
                colors={heroGradient.colors}
                start={heroGradient.start}
                end={heroGradient.end}
                style={{ borderRadius: 20, padding: 18, overflow: 'hidden' }}
                accessible
                accessibilityLabel={`${say('account.offerLabel')} — ${
                  offer.kind === 'early_access' ? say('account.offerEarlyAccess') : offer.label
                }`}
              >
                <View style={{ flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' }}>
                  <View style={{ flexShrink: 1 }}>
                    <Text style={[font('label'), { color: overlays.white70 }]}>
                      {say('account.offerLabel')}
                    </Text>
                    {/* 24 ad hoc → cran wizardTitle (24/700 display) — l'échelle se protège. */}
                    <Text style={[font('wizardTitle'), { color: colors.surface, marginTop: 2 }]}>
                      {offer.kind === 'early_access' ? say('account.offerEarlyAccess') : offer.label}
                      <Text style={[font('label'), { color: overlays.white70 }]}>
                        {'  '}
                        {formatEURWhole(offer.monthlyCents)}
                        {say('account.offerPerMonth')}
                      </Text>
                    </Text>
                  </View>
                  <View
                    style={{
                      backgroundColor: overlays.successPill,
                      borderRadius: radius.pill,
                      paddingVertical: 5,
                      paddingHorizontal: 10,
                    }}
                  >
                    <Text style={[font('meta'), { color: semantic.successOnDark }]}>
                      {offer.kind === 'early_access' ? say('account.offerOpenPill') : offer.status}
                    </Text>
                  </View>
                </View>
                {offer.kind === 'early_access' ? (
                  <Text style={[font('meta', 500), { color: overlays.white80, marginTop: 8, lineHeight: 18 }]}>
                    {say('account.offerEarlyBody')}
                  </Text>
                ) : null}
              </LinearGradient>
            </View>

            {/* En accès anticipé privé, billingAvailable=false : aucune offre commerciale n'est
                montrée. La grille apparaît seulement quand le serveur confirme Stripe complet. */}
            {view.subscription.plans.length > 0 ? (
              <>
                <SectionHeader title={say('account.sectionPlans')} />
                {view.subscription.plans.map((plan) => {
                  const compared = comparedTier === plan.tier;
                  return (
                  <Card
                    key={plan.tier}
                    padding={16}
                    style={{
                      marginBottom: 11,
                      // Grammaire de sélection (arbitrage) : bordure d'épaisseur CONSTANTE
                      // dont la COULEUR bascule vers theme.ink (fin du saut 0,5 px) + fond
                      // teinté ink ~9 % + CheckIcon — jamais l'indigo de Bob.
                      borderWidth: 1.5,
                      borderColor: compared ? theme.ink : controls.cardBorder,
                      backgroundColor: compared
                        ? mixTint(colors.surface, theme.ink, FILTER_CHIP_TINT_SHARE)
                        : colors.surface,
                    }}
                  >
                    <Pressable
                      onPress={() =>
                        setComparedTier((current) => (current === plan.tier ? null : plan.tier))
                      }
                      accessibilityRole="button"
                      accessibilityState={{ selected: compared }}
                      accessibilityLabel={say('planDiff.compareWith', { plan: plan.label })}
                    >
                      <View style={{ flexDirection: 'row', alignItems: 'baseline', justifyContent: 'space-between', marginBottom: 8 }}>
                        <View style={{ flexDirection: 'row', alignItems: 'center', gap: 7, flexShrink: 1 }}>
                          {compared ? <CheckIcon color={theme.ink} size={15} strokeWidth={2.6} /> : null}
                          <Text style={[font('section'), { color: colors.ink900 }]}>{plan.label}</Text>
                        </View>
                        {/* 20 ad hoc → cran sheetTitle (20/700 display). */}
                        <Text style={[font('sheetTitle'), { color: colors.ink900 }]}>
                          {formatEURWhole(plan.monthlyCents)}
                          <Text style={[font('meta'), { color: colors.slate500 }]}>{say('account.offerPerMonth')}</Text>
                        </Text>
                      </View>
                      <Text style={[font('label', 500), { color: colors.slate500, lineHeight: 21, marginBottom: 12 }]}>
                        {plan.blurb}
                      </Text>
                    </Pressable>
                    <Button
                      title={
                        plan.cta === 'current'
                          ? say('account.planCurrent')
                          : plan.cta === 'checkout'
                            ? say('account.planChoose')
                            : plan.cta === 'manage'
                              ? say('account.planManage')
                              : say('account.planManageStore')
                      }
                      variant={plan.cta === 'current' ? 'secondary' : 'primary'}
                      disabled={
                        plan.cta === 'current'
                        || subscriptionStaleError
                        || startCheckout.isPending
                        || billingPortal.isPending
                      }
                      loading={
                        (plan.cta === 'checkout'
                          && startCheckout.isPending
                          && startCheckout.variables === plan.tier)
                        || (plan.cta === 'manage' && billingPortal.isPending)
                      }
                      onPress={() => {
                        // Échec de checkout/portail → ErrorSheet 2 faces (le hook n'a plus
                        // d'Alert générique ; message serveur honnête + code + corrélation).
                        if (plan.cta === 'checkout') {
                          startCheckout.mutate(plan.tier, {
                            onError: (e) =>
                              showErrorFacts(
                                t('errors.sheetTitle', { personality }),
                                mutationFacts(e, appErrorMessage(e)),
                              ),
                          });
                        } else if (plan.cta === 'manage') {
                          billingPortal.mutate(undefined, {
                            onError: (e) =>
                              showErrorFacts(
                                t('errors.sheetTitle', { personality }),
                                mutationFacts(e, appErrorMessage(e)),
                              ),
                          });
                        } else if (plan.cta === 'store') openStoreSubscriptionManagement();
                      }}
                    />
                  </Card>
                  );
                })}
              </>
            ) : null}

            {/* Diff HONNÊTE du changement d'offre — calculé depuis PLAN_CATALOG (diffPlanChange),
                gains ET pertes au même poids, économie affichée si downgrade. Baseline = le plan
                courant marqué par la vue, sinon free (accès anticipé : rien n'est payé, la
                comparaison montre factuellement ce que l'offre touchée contient). */}
            {(() => {
              if (comparedTier === null) return null;
              const currentTier: PlanTier =
                view.subscription.plans.find((plan) => plan.isCurrent)?.tier ?? 'free';
              const diff = diffPlanChange(currentTier, comparedTier);
              const isDowngrade = TIER_ORDER.indexOf(comparedTier) < TIER_ORDER.indexOf(currentTier);
              return (
                // Le diff surgit SOUS la grille : annoncé aux lecteurs d'écran à l'apparition.
                <View accessibilityLiveRegion="polite">
                <Card padding={16} style={{ marginBottom: 11 }}>
                  {diff.gained.length === 0 && diff.lost.length === 0 ? (
                    <Text style={[font('label', 500), { color: colors.slate500, lineHeight: 21 }]}>
                      {say('planDiff.noChange')}
                    </Text>
                  ) : (
                    <>
                      {diff.gained.length > 0 ? (
                        <>
                          <Text style={[font('section'), { fontSize: 14, color: colors.ink900, marginBottom: 6 }]}>
                            {say('planDiff.gains')}
                          </Text>
                          {diff.gained.map((feature) => (
                            <Text
                              key={feature}
                              style={[font('label', 500), { color: colors.slate500, lineHeight: 21 }]}
                            >
                              {'+ '}
                              {featureLabel(feature)}
                            </Text>
                          ))}
                        </>
                      ) : null}
                      {diff.lost.length > 0 ? (
                        <>
                          <Text
                            style={[
                              font('section'),
                              { fontSize: 14, color: colors.ink900, marginTop: diff.gained.length > 0 ? 12 : 0, marginBottom: 6 },
                            ]}
                          >
                            {say('planDiff.losses')}
                          </Text>
                          {diff.lost.map((feature) => (
                            <Text
                              key={feature}
                              style={[font('label', 500), { color: colors.slate500, lineHeight: 21 }]}
                            >
                              {'− '}
                              {featureLabel(feature)}
                            </Text>
                          ))}
                        </>
                      ) : null}
                    </>
                  )}
                  {diff.monthlyDeltaCents < 0 ? (
                    <Text style={[font('label', 500), { color: colors.ink900, marginTop: 12 }]}>
                      {say('planDiff.savings', { amount: formatEURWhole(-diff.monthlyDeltaCents) })}
                    </Text>
                  ) : null}
                  {isDowngrade ? (
                    <Text style={[font('meta'), { color: colors.slate500, marginTop: 8, lineHeight: 17 }]}>
                      {say('planDiff.downgradeEffective')}
                    </Text>
                  ) : null}
                </Card>
                </View>
              );
            })()}

            {/* Historique autoritatif : [] vient réellement de GET /subscription/invoices.
                Les lignes apparaissent après webhook Stripe vérifié + persistance RLS. */}
            <View style={{ marginTop: 7 }}>
              <SectionHeader title={say('account.sectionSubInvoices')} />
            </View>
            <Card padding={15} style={{ marginBottom: 18 }}>
              {view.subscription.invoices.length === 0 ? (
                <EmptyState
                  body={say(
                    offer.kind === 'early_access'
                      ? 'account.invoicesEmptyEarlyAccess'
                      : 'account.invoicesEmpty',
                  )}
                />
              ) : (
                view.subscription.invoices.map((invoice, index, invoices) => {
                  const targetUrl = invoice.invoicePdfUrl ?? invoice.hostedInvoiceUrl;
                  const issuedDate = new Intl.DateTimeFormat('fr-FR', {
                    day: 'numeric',
                    month: 'long',
                    year: 'numeric',
                  }).format(new Date(invoice.issuedAt));
                  const statusKey: I18nKey =
                    invoice.status === 'paid'
                      ? 'account.invoiceStatusPaid'
                      : invoice.status === 'open'
                        ? 'account.invoiceStatusOpen'
                        : invoice.status === 'void'
                          ? 'account.invoiceStatusVoid'
                          : invoice.status === 'uncollectible'
                            ? 'account.invoiceStatusUncollectible'
                            : 'account.invoiceStatusDraft';
                  return (
                    <Pressable
                      key={invoice.id}
                      accessibilityRole={targetUrl === null ? undefined : 'link'}
                      accessibilityLabel={`${invoice.number ?? say('account.invoiceWithoutNumber')}. ${formatEURWhole(invoice.totalCents)}. ${say(statusKey)}`}
                      disabled={targetUrl === null}
                      onPress={() => {
                        if (targetUrl !== null) openExternalUrl(targetUrl);
                      }}
                      style={{
                        flexDirection: 'row',
                        alignItems: 'center',
                        gap: 12,
                        paddingVertical: 11,
                        borderBottomWidth: index === invoices.length - 1 ? 0 : 1,
                        borderBottomColor: colors.lineSoft,
                      }}
                    >
                      <IconTile tone="b2b" size={34} radius={10}>
                        <FileTextIcon color={semantic.b2b} size={16} strokeWidth={2} />
                      </IconTile>
                      <View style={{ flex: 1 }}>
                        <Text style={[font('sub', 600), { color: colors.ink800 }]}>
                          {invoice.number ?? say('account.invoiceWithoutNumber')}
                        </Text>
                        <Text style={[font('meta'), { color: colors.slate500, marginTop: 1 }]}>
                          {issuedDate} · {say(statusKey)}
                        </Text>
                      </View>
                      <Text style={[font('sub', 700), { color: colors.ink900, fontVariant: ['tabular-nums'] }]}>
                        {formatEURWhole(invoice.totalCents)}
                      </Text>
                      {targetUrl === null ? null : (
                        <ChevronRightIcon color={colors.slate300} size={16} />
                      )}
                    </Pressable>
                  );
                })
              )}
            </Card>

            {/* Services en plus — badge dérivé du réel (@bob/core), sinon « À venir » */}
            <SectionHeader title={say('account.sectionServices')} />
            <Card padding={15}>
              {view.subscription.services.map((service, index) => (
                <View
                  key={service.key}
                  style={{
                    flexDirection: 'row',
                    alignItems: 'center',
                    gap: 12,
                    paddingVertical: 12,
                    borderBottomWidth: index === view.subscription.services.length - 1 ? 0 : 1,
                    borderBottomColor: colors.lineSoft,
                  }}
                >
                  {/* Fin des tons de typologie recyclés : assurance ('particulier') et
                      comptable ('b2g') étaient des mensonges de teinte — les services non
                      financiers passent en tuile 'document' neutre. */}
                  {service.key === 'online_payment' ? (
                    <IconTile tone="success" size={34} radius={10}>
                      <CurrencyIcon color={semantic.success} size={16} strokeWidth={2} />
                    </IconTile>
                  ) : service.key === 'invoice_advance' ? (
                    <IconTile tone="b2b" size={34} radius={10}>
                      <TrendUpIcon color={semantic.b2b} size={16} strokeWidth={2} />
                    </IconTile>
                  ) : service.key === 'insurance' ? (
                    <IconTile tone="document" size={34} radius={10}>
                      <ShieldIcon color={colors.slate500} size={16} strokeWidth={2} />
                    </IconTile>
                  ) : (
                    <IconTile tone="document" size={34} radius={10}>
                      <PeopleIcon color={colors.slate500} size={16} strokeWidth={2} />
                    </IconTile>
                  )}
                  <View style={{ flex: 1 }}>
                    <Text style={[font('body', 600), { color: colors.ink800 }]}>
                      {say(SERVICE_LABEL_KEYS[service.key].title)}
                    </Text>
                    <Text style={[font('meta'), { color: colors.slate500, marginTop: 1 }]}>
                      {say(SERVICE_LABEL_KEYS[service.key].sub)}
                    </Text>
                  </View>
                  <Text
                    style={[
                      font('meta', 700),
                      { color: service.status === 'active' ? semantic.success : colors.slate500 },
                    ]}
                  >
                    {service.status === 'active' ? say('account.serviceActive') : say('account.serviceSoon')}
                  </Text>
                </View>
              ))}
            </Card>
              </>
            )}
          </>
        )}
        </FadeIn>
      </ScrollView>
      {errorSheet}
    </View>
  );
}
