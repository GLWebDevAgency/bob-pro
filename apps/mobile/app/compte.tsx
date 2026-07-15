/**
 * Mon compte — Profil / Abonnement (claim C26 v2, réf proto dc.html §COMPTE & ABONNEMENT).
 *
 * DOCTRINE HONNÊTETÉ (le cœur du claim) : il n'existe AUCUN billing (pas de Stripe). Depuis C26b,
 * GET /subscription existe et dit cette vérité PAR TENANT (earlyAccess: true, 0 €) — les
 * « Pro · 39 € ACTIVE », factures payées et « Banque connectée » du proto restent du REMPLISSAGE :
 * · offre courante = Accès anticipé · 0 €/mois · toutes les fonctions ouvertes ;
 * · grille Solo 19 / Pro 39 / Business 79 = PLAN_PRICING (constante produit @bob/core),
 *   CTA désactivés « disponible à l'ouverture de la facturation » — rien ne prétend souscrire ;
 * · toucher une offre ≠ la sienne affiche le diff honnête « tu gagnes / tu perds » sous la
 *   grille (diffPlanChange @bob/core, SPEC pilier 2 décision 7) : gains ET pertes au même poids,
 *   économie affichée si downgrade — comparaison factuelle, AUCUNE souscription déclenchée ;
 * · factures d'abonnement = état vide honnête · banque = « À connecter » (aucun bridge) ·
 *   services en plus = badge dérivé du réel (deriveServiceStatus, module TradeConfig) sinon
 *   « À venir ».
 * Toute la dérivation vit dans @bob/core (deriveAccountView, use case pur testé) ; l'écran rend.
 *
 * DONNÉES RÉELLES : identité via useIdentity (JAMAIS « Mercier » en dur — la démo vient du seed),
 * email = session Supabase (useAuth), profil métier via useProfile (client.getProfile),
 * Se déconnecter = signOut réel, « Facturation & modèles » → /reglages-facturation (C27).
 * Erreur profil → bannière voix de Bob SANS bloquer l'écran (la déconnexion reste accessible),
 * la vue se dégrade honnêtement (tradeConfig null → pas de taux TVA inventé, services « À venir »).
 *
 * Écarts assumés vs proto (listés au contrat) : pas de badge ACTIVE ni d'essai 14 j fantôme,
 * pas de « Banque — Crédit Agricole connectée », factures d'abo vides, parrainage/équipe = teasers
 * « à venir » (aucun flux) ; les réglages autonomie/dictée de l'ancien écran ne font pas partie
 * de la structure C26. Zéro hex/rgba : useTheme()/@bob/tokens uniquement.
 */
import { useEffect, useMemo, useState } from 'react';
import { Pressable, RefreshControl, ScrollView, Text, View } from 'react-native';
import { useRouter, useLocalSearchParams } from 'expo-router';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { LinearGradient } from 'expo-linear-gradient';
import { Feather } from '@expo/vector-icons';
import {
  deriveAccountView,
  diffPlanChange,
  formatEURWhole,
  MERCIER_PROPS,
  PLAN_CATALOG,
  TIER_ORDER,
  type AccountConnectionView,
  type AccountServiceKey,
  type AccountView,
  type PaidTier,
  type PlanTier,
} from '@bob/core';
import { t, type I18nKey } from '@bob/i18n';
import { shadowComponentsNative, shadowNative } from '@bob/tokens';
import { featureLabel } from '../src/monetization/feature-labels';
import {
  Avatar,
  Button,
  Card,
  EmptyState,
  ErrorRetry,
  IconTile,
  InnerScreenHeader,
  SectionHeader,
  SegmentedControl,
  Skeleton,
  SkeletonCard,
  SkeletonRow,
  StatusBadge,
  font,
  parseGradient,
  useTheme,
} from '@bob/ui';
import { useIdentity } from '../src/data/identity';
import { useAuth } from '../src/data/auth';
import { useProfile, useSubscription } from '../src/data/hooks';
import { useFiscalProfileFlow } from '../src/fiscal/use-fiscal-profile-flow';
import {
  ChevronLeftIcon,
  ChevronRightIcon,
  CurrencyIcon,
  FileTextIcon,
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
  const { colors, semantic, controls, overlays, radius, grad, personality } = useTheme();
  const insets = useSafeAreaInsets();
  const router = useRouter();
  const identity = useIdentity();
  const { enabled: authEnabled, session, signOut } = useAuth();
  const profile = useProfile();
  const subscription = useSubscription();
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

  const view: AccountView = useMemo(
    () =>
      deriveAccountView({
        identity: {
          firstName: identity.firstName,
          companyName: identity.companyName,
          legalLine: identity.legalLine,
        },
        // Démo = la société du seed @bob/core ; connecté = null tant que GET /company/me n'existe pas.
        company: identity.isDemo ? MERCIER_PROPS : null,
        tradeConfig: profile.data ?? null,
        // GET /subscription RÉEL (C26b) — SubscriptionView ⊂ SubscriptionInfo, passé tel quel.
        // earlyAccess: true (aucun billing) → null pour la vue : deriveAccountView rend l'état
        // accès anticipé honnête (rendu inchangé — garanti par ses tests). Erreur/chargement →
        // null aussi : même état honnête, jamais un plan inventé.
        subscription: subscription.data && !subscription.data.earlyAccess ? subscription.data : null,
      }),
    [identity, profile.data, subscription.data],
  );

  const email = session?.user?.email ?? null;
  const displayName = view.profile.displayName ?? '—';
  const avatarName = [identity.firstName, identity.companyName].filter(Boolean).join(' ') || displayName;
  const subline = email ?? identity.companyName;
  const say = (key: I18nKey, params?: Record<string, string | number>) =>
    t(key, params ? { personality, params } : { personality });

  const heroGradient = parseGradient(grad.hero);
  const offer = view.subscription.offer;

  return (
    <View style={{ flex: 1, backgroundColor: colors.bg }}>
      <View style={{ paddingTop: insets.top + 10, paddingHorizontal: 16 }}>
        <Pressable
          accessibilityRole="button"
          accessibilityLabel={say('account.back')}
          onPress={() => router.back()}
          hitSlop={8}
          style={{ flexDirection: 'row', alignItems: 'center', gap: 4, alignSelf: 'flex-start', minHeight: 44 }}
        >
          <ChevronLeftIcon color={colors.ink800} size={18} strokeWidth={2.2} />
          <Text style={[font('label', 600), { fontSize: 15, color: colors.ink800 }]}>
            {say('account.back')}
          </Text>
        </Pressable>
      </View>

      <InnerScreenHeader
        eyebrow={say('account.eyebrow')}
        title={say('account.title')}
        subtitle={say('account.subtitle')}
      />

      <View style={{ paddingHorizontal: 18, paddingTop: 14 }}>
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
        contentContainerStyle={{ paddingHorizontal: 18, paddingTop: 16, paddingBottom: insets.bottom + 34 }}
        showsVerticalScrollIndicator={false}
        refreshControl={
          <RefreshControl
            refreshing={tab === 'profil' ? profile.isRefetching : subscription.isRefetching}
            onRefresh={() => {
              if (tab === 'profil') void profile.refetch();
              else void subscription.refetch();
            }}
            tintColor={colors.ink800}
            colors={[colors.ink800]}
          />
        }
      >
        {tab === 'profil' ? (
          <>
            {/* Identité — jamais en dur : useIdentity (seed en démo) + email de la session réelle */}
            <View style={{ flexDirection: 'row', alignItems: 'center', gap: 13, marginBottom: 16 }}>
              <Avatar name={avatarName} size={54} />
              <View style={{ flex: 1 }}>
                <Text style={[font('cardTitle'), { fontSize: 17, color: colors.ink900 }]}>
                  {displayName}
                </Text>
                {subline ? (
                  <Text style={[font('sub'), { color: colors.slate400, marginTop: 2 }]}>{subline}</Text>
                ) : null}
              </View>
            </View>

            {profile.isLoading ? (
              <ProfileSkeleton label={say('account.profileLoading')} />
            ) : profile.isError ? (
              <ErrorRetry message={say('account.dataError')} onRetry={() => void profile.refetch()} />
            ) : (
              <>
            <SectionHeader title={say('account.sectionCompany')} />
            <Card padding={15} style={{ marginBottom: 16 }}>
              {view.profile.company ? (
                (
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
                        font('sub', 700),
                        { fontSize: 14, color: colors.ink800, flexShrink: 1, textAlign: 'right' },
                        row.tabular ? { fontVariant: ['tabular-nums'] } : null,
                      ]}
                    >
                      {row.value}
                    </Text>
                  </View>
                ))
              ) : (
                <Text style={[font('sub'), { color: colors.slate500 }]}>{say('account.companyEmpty')}</Text>
              )}
            </Card>

            {/* Facturation & modèles → écran C27 (réel) */}
            <Pressable
              accessibilityRole="button"
              accessibilityLabel={say('account.billingRow')}
              onPress={() => router.push('/reglages-facturation')}
              style={[
                {
                  flexDirection: 'row',
                  alignItems: 'center',
                  gap: 11,
                  backgroundColor: colors.surface,
                  borderRadius: radius.cardLg,
                  borderWidth: 1,
                  borderColor: controls.cardBorder,
                  padding: 15,
                  marginBottom: 16,
                },
                shadowNative.e1,
              ]}
            >
              <IconTile tone="success" size={34} radius={11}>
                <FileTextIcon color={semantic.success} size={18} />
              </IconTile>
              <View style={{ flex: 1 }}>
                <Text style={[font('sub', 600), { fontSize: 14.5, color: colors.ink800 }]}>
                  {say('account.billingRow')}
                </Text>
                <Text style={[font('meta'), { color: colors.slate400, marginTop: 1 }]}>
                  {say('account.billingRowSub')}
                </Text>
              </View>
              <ChevronRightIcon color={colors.slate300} size={17} />
            </Pressable>

            {/* Mon profil fiscal → écran dédié (SPEC_EXPERT_FISCAL §UX FLOW amendement 5) */}
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
              style={[
                {
                  flexDirection: 'row',
                  alignItems: 'center',
                  gap: 11,
                  backgroundColor: colors.surface,
                  borderRadius: radius.cardLg,
                  borderWidth: 1,
                  borderColor: controls.cardBorder,
                  padding: 15,
                  marginBottom: 16,
                },
                shadowNative.e1,
              ]}
            >
              <IconTile tone="b2g" size={34} radius={11}>
                <CurrencyIcon color={semantic.b2g} size={18} />
              </IconTile>
              <View style={{ flex: 1 }}>
                <Text style={[font('sub', 600), { fontSize: 14.5, color: colors.ink800 }]}>{say('fiscal.account.row')}</Text>
                <Text style={[font('meta'), { color: colors.slate400, marginTop: 1 }]}>
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
                  <Text style={[font('sub', 600), { fontSize: 14, color: colors.ink800, flex: 1 }]}>
                    {say(CONNECTION_LABEL_KEYS[conn.key])}
                  </Text>
                  <Text
                    style={[
                      font('label', 700),
                      { fontSize: 12, color: conn.status === 'to_connect' ? semantic.warning : colors.slate400 },
                    ]}
                  >
                    {conn.status === 'to_connect' ? say('account.connToConnect') : say('account.connSoon')}
                  </Text>
                </View>
              ))}
            </Card>

            {/* Parrainage — teaser honnête : aucun flux de parrainage n'existe encore */}
            <Card padding={15} style={{ marginBottom: 16, backgroundColor: semantic.aiBg, borderColor: semantic.aiBg }}>
              <View style={{ flexDirection: 'row', alignItems: 'center', gap: 13 }}>
                <IconTile tone="b2g" size={34} radius={11}>
                  <Feather name="gift" size={18} color={semantic.ai} />
                </IconTile>
                <View style={{ flex: 1 }}>
                  <Text style={[font('sub', 700), { fontSize: 14.5, color: semantic.ai }]}>
                    {say('account.referralTitle')}
                  </Text>
                  <Text style={[font('meta'), { color: semantic.aiInk, marginTop: 1 }]}>
                    {say('account.referralSoon')}
                  </Text>
                </View>
              </View>
            </Card>

            {/* Équipe & rôles — badge BUSINESS (palier requis, constante produit) */}
            <Card padding={15} style={{ marginBottom: 16 }}>
              <View style={{ flexDirection: 'row', alignItems: 'center', gap: 11 }}>
                <IconTile tone="b2b" size={34} radius={11}>
                  <PeopleIcon color={semantic.b2b} size={18} strokeWidth={2} />
                </IconTile>
                <View style={{ flex: 1 }}>
                  <Text style={[font('sub', 600), { fontSize: 14.5, color: colors.ink800 }]}>
                    {say('account.teamRow')}
                  </Text>
                  <Text style={[font('meta'), { color: colors.slate400, marginTop: 1 }]}>
                    {say('account.teamRowSub')}
                  </Text>
                </View>
                <StatusBadge
                  variant="b2g"
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
          </>
        ) : (
          <>
            {subscription.isLoading ? (
              <SubscriptionSkeleton label={say('account.subscriptionLoading')} />
            ) : subscription.isError ? (
              <ErrorRetry
                message={say('account.subscriptionError')}
                onRetry={() => void subscription.refetch()}
              />
            ) : (
              <>
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
                    <Text style={[font('label'), { color: overlays.white66 }]}>
                      {say('account.offerLabel')}
                    </Text>
                    <Text style={[font('bigNum'), { fontSize: 24, color: colors.surface, marginTop: 2 }]}>
                      {offer.kind === 'early_access' ? say('account.offerEarlyAccess') : offer.label}
                      <Text style={[font('label'), { color: overlays.white60 }]}>
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
                    <Text style={[font('meta'), { fontSize: 11, color: semantic.successOnDark }]}>
                      {offer.kind === 'early_access' ? say('account.offerOpenPill') : offer.status}
                    </Text>
                  </View>
                </View>
                {offer.kind === 'early_access' ? (
                  <Text style={[font('sub'), { fontSize: 12.5, color: overlays.white66, marginTop: 8 }]}>
                    {say('account.offerEarlyBody')}
                  </Text>
                ) : null}
              </LinearGradient>
            </View>

            {/* Grille — PLAN_PRICING (constante produit), CTA honnêtes désactivés */}
            <SectionHeader title={say('account.sectionPlans')} />
            {view.subscription.plans.map((plan) => (
              <Pressable
                key={plan.tier}
                onPress={() => setComparedTier((current) => (current === plan.tier ? null : plan.tier))}
                accessibilityRole="button"
                accessibilityLabel={`${plan.label} — ${say('planDiff.gains')} / ${say('planDiff.losses')}`}
              >
                <Card
                  padding={16}
                  style={{
                    marginBottom: 11,
                    ...(comparedTier === plan.tier ? { borderWidth: 1.5, borderColor: colors.ink600 } : {}),
                  }}
                >
                  <View style={{ flexDirection: 'row', alignItems: 'baseline', justifyContent: 'space-between', marginBottom: 8 }}>
                    <Text style={[font('section'), { color: colors.ink900 }]}>{plan.label}</Text>
                    <Text style={[font('bigNum'), { fontSize: 20, color: colors.ink900 }]}>
                      {formatEURWhole(plan.monthlyCents)}
                      <Text style={[font('meta'), { color: colors.slate300 }]}>{say('account.offerPerMonth')}</Text>
                    </Text>
                  </View>
                  <Text style={[font('label', 500), { color: colors.slate500, lineHeight: 21, marginBottom: 12 }]}>
                    {plan.blurb}
                  </Text>
                  <Button
                    title={plan.cta === 'current' ? say('account.planCurrent') : say('account.planCtaUnavailable')}
                    variant="secondary"
                    disabled
                  />
                </Card>
              </Pressable>
            ))}

            {/* Diff HONNÊTE du changement d'offre — calculé depuis PLAN_CATALOG (diffPlanChange),
                gains ET pertes au même poids, économie affichée si downgrade. Baseline = le plan
                courant marqué par la vue, sinon free (accès anticipé : rien n'est payé, la
                comparaison montre factuellement ce que l'offre touchée contient). */}
            {(() => {
              if (comparedTier === null) return null;
              const currentTier: PlanTier =
                view.subscription.plans.find((plan) => plan.cta === 'current')?.tier ?? 'free';
              const diff = diffPlanChange(currentTier, comparedTier);
              const isDowngrade = TIER_ORDER.indexOf(comparedTier) < TIER_ORDER.indexOf(currentTier);
              return (
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
                    <Text style={[font('meta'), { fontSize: 11.5, color: colors.slate500, marginTop: 8, lineHeight: 17 }]}>
                      {say('planDiff.downgradeEffective')}
                    </Text>
                  ) : null}
                </Card>
              );
            })()}

            {/* Factures d'abonnement — état vide HONNÊTE (rien n'est facturé en accès anticipé) */}
            <View style={{ marginTop: 7 }}>
              <SectionHeader title={say('account.sectionSubInvoices')} />
            </View>
            <Card padding={15} style={{ marginBottom: 18 }}>
              {view.subscription.invoices.length === 0 ? (
                <EmptyState body={say('account.invoicesEmpty')} />
              ) : (
                view.subscription.invoices.map((invoice, index) => (
                  <View
                    key={invoice.id}
                    style={{
                      flexDirection: 'row',
                      justifyContent: 'space-between',
                      paddingVertical: 11,
                      borderBottomWidth: index === view.subscription.invoices.length - 1 ? 0 : 1,
                      borderBottomColor: colors.lineSoft,
                    }}
                  >
                    <Text style={[font('sub', 600), { color: colors.ink800 }]}>{invoice.label}</Text>
                    <Text style={[font('sub', 700), { color: colors.ink900, fontVariant: ['tabular-nums'] }]}>
                      {formatEURWhole(invoice.amountCents)}
                    </Text>
                  </View>
                ))
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
                  {service.key === 'online_payment' ? (
                    <IconTile tone="success" size={34} radius={10}>
                      <CurrencyIcon color={semantic.success} size={16} strokeWidth={2} />
                    </IconTile>
                  ) : service.key === 'invoice_advance' ? (
                    <IconTile tone="b2b" size={34} radius={10}>
                      <TrendUpIcon color={semantic.b2b} size={16} strokeWidth={2} />
                    </IconTile>
                  ) : service.key === 'insurance' ? (
                    <IconTile tone="particulier" size={34} radius={10}>
                      <ShieldIcon color={semantic.particulier} size={16} strokeWidth={2} />
                    </IconTile>
                  ) : (
                    <IconTile tone="b2g" size={34} radius={10}>
                      <PeopleIcon color={semantic.b2g} size={16} strokeWidth={2} />
                    </IconTile>
                  )}
                  <View style={{ flex: 1 }}>
                    <Text style={[font('sub', 600), { fontSize: 14, color: colors.ink800 }]}>
                      {say(SERVICE_LABEL_KEYS[service.key].title)}
                    </Text>
                    <Text style={[font('meta'), { color: colors.slate300, marginTop: 1 }]}>
                      {say(SERVICE_LABEL_KEYS[service.key].sub)}
                    </Text>
                  </View>
                  <Text
                    style={[
                      font('label', 700),
                      { fontSize: 12, color: service.status === 'active' ? semantic.success : colors.slate400 },
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
      </ScrollView>
    </View>
  );
}
