/**
 * Aujourd'hui — le briefing du jour (claim C10 v1.1 + rattrapage DA pixel-perfect,
 * réf design_handoff_bob_pro/Bob Pro.dc.html). Composition 100 % @bob/ui :
 * AppHeaderNavy (halos radiaux) → FloatingBalanceCard (geste signature) →
 * « À régler aujourd'hui » (PriorityCard ; conformité = carte info lavande, sans checkbox) →
 * « En un coup d'œil » (KpiTile ×4 iconées) → « Vite fait » (QuickAction ×4) → footer.
 * PAS de FAB sur cet écran : les réglages s'ouvrent via l'avatar (JM) → profil.
 *
 * DONNÉES RÉELLES (amendement A1-C10) : tout vient des queries du BobClient
 * (useCashflow/useCustomers/useTodayPriorities) ; les priorités sont dérivées dans @bob/core
 * (deriveTodayPriorities, use case pur testé) — AUCUN repli fixtures silencieux :
 * loading → skeletons · erreur → voix de Bob (today.dataError) sans chiffre inventé ·
 * donnée absente → tuile vide « — » · 0 priorité → today.subtitleNone + section vide propre.
 * Le mode démo légitime = le client démo (LocalBobClient), jamais l'écran.
 *
 * PARITÉ D'ACTIONS humain ↔ Bob (directive 23:52) : chaque CTA emprunte le MÊME point
 * d'entrée que l'action équivalente de Bob — aucun chemin parallèle construit ici :
 * · relance          → /(tabs)/assistant (prompt assistant → runtime agent, use cases relance @bob/core) ;
 * · facture finale   → /ventes (écran ventes → generate-invoice-from-quote, le use case que Bob invoque) ;
 * · diagnostic       → /diagnostic (getDiagnostic — même query que Bob) ;
 * · « Vite fait »    : voix → /voix (C20 — flux facture à la voix) · devis → /devis/new ·
 *                      scan → /scan-document · encaisser → /ventes (register-payment).
 *
 * Densité Zen : masque « En un coup d'œil » + « Vite fait ». Zéro hex/rgba : useTheme()/@bob/tokens.
 */
import { useState } from 'react';
import { ScrollView, Text, View, type StyleProp, type ViewStyle } from 'react-native';
import { useRouter } from 'expo-router';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { Feather } from '@expo/vector-icons';
import { MERCIER_PROPS, formatEURWhole, type TodayPriority } from '@bob/core';
import { patterns, shadowNative } from '@bob/tokens';
import { t } from '@bob/i18n';
import {
  AppHeaderNavy,
  Button,
  Card,
  FloatingBalanceCard,
  KpiTile,
  PriorityCard,
  QuickAction,
  SectionHeader,
  StatusBadge,
  font,
  useTheme,
} from '@bob/ui';
import { useCashflow, useCustomers, useTodayPriorities } from '../../src/data/hooks';
import {
  CalendarIcon,
  ChevronRightIcon,
  ClockIcon,
  CurrencyIcon,
  DepositIcon,
  ShieldIcon,
  TrendUpIcon,
} from '../../src/components/icons';

// TODO C24 (auth) : identité réelle de l'artisan — le proto est Julien, Mercier Plomberie.
const USER = { firstName: 'Julien', initials: 'JM' } as const;

/** Cap d'affichage du briefing (le tri est fait par @bob/core ; l'UI ne montre que le dessus de la pile). */
const DISPLAY_CAP = 3;

const DAYS = ['Dimanche', 'Lundi', 'Mardi', 'Mercredi', 'Jeudi', 'Vendredi', 'Samedi'] as const;
const MONTHS = [
  'janvier',
  'février',
  'mars',
  'avril',
  'mai',
  'juin',
  'juillet',
  'août',
  'septembre',
  'octobre',
  'novembre',
  'décembre',
] as const;

/** Date du jour pour l'eyebrow (« Jeudi 2 juillet ») — sans Intl, comme formatEUR. */
function todayLabel(d: Date = new Date()): string {
  return `${DAYS[d.getDay()] ?? ''} ${d.getDate()} ${MONTHS[d.getMonth()] ?? ''}`;
}

const KPI_TILE: StyleProp<ViewStyle> = { flexBasis: '47%', flexGrow: 1 };
const HERO = patterns.floatingBalanceCard;

/** Skeleton d'une tuile KPI pendant le chargement initial (états du contrat C10). */
function SkeletonTile() {
  const { colors } = useTheme();
  return (
    <Card style={KPI_TILE}>
      <View style={{ height: 12, width: '55%', borderRadius: 6, backgroundColor: colors.lineSoft }} />
      <View
        style={{ height: 21, width: '70%', borderRadius: 6, backgroundColor: colors.lineSoft, marginTop: 10 }}
      />
    </Card>
  );
}

/** Skeleton d'une carte priorité (même gabarit qu'une PriorityCard au repos). */
function SkeletonPriority() {
  const { colors } = useTheme();
  return (
    <Card>
      <View style={{ height: 20, width: '38%', borderRadius: 10, backgroundColor: colors.lineSoft }} />
      <View style={{ height: 15, width: '80%', borderRadius: 6, backgroundColor: colors.lineSoft, marginTop: 12 }} />
      <View style={{ height: 15, width: '62%', borderRadius: 6, backgroundColor: colors.lineSoft, marginTop: 8 }} />
      <View style={{ height: 34, width: '42%', borderRadius: 12, backgroundColor: colors.lineSoft, marginTop: 14 }} />
    </Card>
  );
}

/**
 * Héros « Dispo réel » sans donnée (chargement ou hors-ligne) : même géométrie que la
 * FloatingBalanceCard (recette @bob/tokens patterns.floatingBalanceCard) — jamais un montant inventé.
 */
function HeroPlaceholder({ loading }: { loading: boolean }) {
  const { personality, colors, controls } = useTheme();
  return (
    <View
      style={{
        marginTop: HERO.overlap,
        marginHorizontal: HERO.sideInset,
        backgroundColor: colors.surface,
        borderRadius: HERO.radius,
        borderWidth: 1,
        borderColor: controls.cardBorder,
        paddingTop: HERO.padding[0],
        paddingHorizontal: HERO.padding[1],
        paddingBottom: HERO.padding[2],
        minHeight: 44,
        ...shadowNative.e3,
      }}
    >
      <Text style={[font('eyebrow'), { color: colors.slate400 }]}>
        {t('today.balanceLabel', { personality })}
      </Text>
      {loading ? (
        <View style={{ height: 31, width: '46%', borderRadius: 8, backgroundColor: colors.lineSoft, marginTop: 6 }} />
      ) : (
        <Text
          style={{
            ...font('bigNum'),
            fontSize: HERO.numberSize,
            letterSpacing: HERO.numberTracking,
            color: colors.slate400,
            marginTop: 3,
          }}
        >
          —
        </Text>
      )}
    </View>
  );
}

/** Carte d'une priorité dérivée (@bob/core TodayPriority) — copy @bob/i18n, CTA = parité d'actions Bob. */
function TodayPriorityCard({
  priority,
  done,
  onToggle,
}: {
  priority: TodayPriority;
  done: boolean;
  onToggle: () => void;
}) {
  const { personality, colors, semantic } = useTheme();
  const router = useRouter();
  const checkIcon = <Feather name="check" size={14} color={semantic.success} />;
  const common = { done, onToggle, checkIcon } as const;

  switch (priority.kind) {
    case 'relance': {
      const name = priority.customerName || priority.docNumber || '';
      const reference = priority.docNumber ? `${priority.docNumber} · ` : '';
      return (
        <PriorityCard
          status="retard"
          title={t('today.prioRelanceTitle', { personality, params: { name } })}
          subtitle={`${reference}${formatEURWhole(priority.amountCents)} — ${t('today.prioLateHint', {
            personality,
            params: { days: priority.daysLate },
          })}`}
          badge={
            <StatusBadge
              label={t('today.prioLateBadge', { personality, params: { days: priority.daysLate } }).toUpperCase()}
              variant="danger"
            />
          }
          cta={
            <Button
              title={t('today.ctaRelance', { personality })}
              variant="primary"
              size="compact"
              radius={11}
              icon={<Feather name="send" size={15} color={colors.surface} />}
              style={{ alignSelf: 'flex-start' }}
              // ?prompt=relance : l'assistant pré-remplit ET soumet la demande (C15).
              onPress={() => router.push({ pathname: '/(tabs)/assistant', params: { prompt: 'relance' } })}
            />
          }
          {...common}
        />
      );
    }
    case 'facture_finale': {
      const name = priority.customerName || priority.docNumber || '';
      return (
        <PriorityCard
          status="marine"
          title={t('today.prioFinalTitle', { personality, params: { name } })}
          subtitle={t('today.prioFinalHint', {
            personality,
            params: { amount: formatEURWhole(priority.amountCents) },
          })}
          badge={
            <StatusBadge label={t('today.prioAcceptedBadge', { personality }).toUpperCase()} variant="b2b" />
          }
          cta={
            <Button
              title={t('today.ctaFinalInvoice', { personality })}
              variant="primary"
              size="compact"
              radius={11}
              icon={<Feather name="file-plus" size={15} color={colors.surface} />}
              style={{ alignSelf: 'flex-start' }}
              onPress={() => router.push('/ventes')}
            />
          }
          {...common}
        />
      );
    }
    case 'conformite':
      // Carte INFO (réf) : jamais de checkbox — puce bouclier, fond lavande, CTA chevron.
      return (
        <PriorityCard
          status="conformite"
          title={t('today.prioConformiteTitle', { personality })}
          subtitle={t('today.prioConformiteHint', { personality })}
          leadingIcon={<ShieldIcon color={semantic.b2g} />}
          badge={
            <StatusBadge label={t('today.prioConformiteBadge', { personality }).toUpperCase()} variant="b2g" />
          }
          cta={
            <Button
              title={t('today.ctaDiagnostic', { personality })}
              variant="ai"
              size="compact"
              radius={11}
              trailingIcon={<ChevronRightIcon color={colors.surface} size={15} strokeWidth={2.2} />}
              style={{ alignSelf: 'flex-start' }}
              onPress={() => router.push('/diagnostic')}
            />
          }
        />
      );
  }
}

export default function Aujourdhui() {
  const { personality, density, colors, semantic } = useTheme();
  const router = useRouter();
  const insets = useSafeAreaInsets();
  const cashflow = useCashflow('realiste', 30);
  const customers = useCustomers();
  const today = useTodayPriorities();

  // « Fait » togglable local — le moteur de tâches arrive avec C25 (relances).
  const [done, setDone] = useState<Record<string, boolean>>({});
  const toggle = (id: string) => () => setDone((d) => ({ ...d, [id]: !d[id] }));

  const displayed = today.priorities.slice(0, DISPLAY_CAP);
  const remaining = displayed.filter((p) => !done[p.id]).length;
  const todayReady = !today.isLoading && !today.isError;

  // KPI : uniquement des agrégats dérivés des queries réelles — sinon tuile vide « — ».
  const owedCents = customers.data?.reduce((sum, c) => sum + c.outstanding, 0);
  const lateCents = customers.data?.reduce((sum, c) => sum + (c.scoreBand === 'red' ? c.outstanding : 0), 0);
  const eomCents = cashflow.data?.available; // horizon 30 j réaliste = fin de mois
  const glanceLoading = cashflow.isLoading || customers.isLoading;
  const hasError = cashflow.isError || customers.isError || today.isError;

  const cockpit = density !== 'Zen';

  return (
    <View style={{ flex: 1, backgroundColor: colors.bg }}>
      <ScrollView style={{ flex: 1 }} contentContainerStyle={{ paddingBottom: 140 }}>
        <AppHeaderNavy
          {...(insets.top > 0 ? { safeTop: insets.top } : {})}
          dateLabel={todayLabel()}
          companyName={MERCIER_PROPS.name} // TODO C24 — société réelle du compte connecté
          initials={USER.initials}
          title={t('bob.greeting', { personality, params: { name: USER.firstName } })}
          subtitle={
            !todayReady
              ? '' // pas de compte inventé pendant le chargement / en erreur
              : remaining === 0
                ? t('today.subtitleNone', { personality })
                : remaining === 1
                  ? t('today.subtitleOne', { personality })
                  : t('today.subtitle', { personality, params: { count: remaining } })
          }
          bellIcon={<Feather name="bell" size={20} color={colors.surface} />}
          hasUnread
          onAvatarPress={() => router.push('/compte')}
          onBellPress={() => undefined} // TODO C25 — écran Notifications
        />

        {cashflow.data ? (
          <FloatingBalanceCard
            label={t('today.balanceLabel', { personality })}
            amountCents={cashflow.data.available}
            voiceLine={t('today.payoutHint', {
              personality,
              params: { amount: formatEURWhole(cashflow.data.payout) },
            })}
            chevronIcon={<ChevronRightIcon color={colors.slate400} size={15} strokeWidth={2.4} />}
            voiceIcon={<DepositIcon color={semantic.success} size={16} />}
            onPress={() => router.push('/(tabs)/argent')}
          />
        ) : (
          <HeroPlaceholder loading={cashflow.isLoading} />
        )}

        <View style={{ paddingHorizontal: 18, paddingTop: 22, gap: 20 }}>
          {hasError ? (
            <Card>
              <Text style={[font('sub'), { color: colors.slate500 }]}>
                {t('today.dataError', { personality })}
              </Text>
            </Card>
          ) : null}

          <View>
            <SectionHeader
              title={t('today.sectionToday', { personality })}
              {...(displayed.length > 0
                ? {
                    action: (
                      <Text style={[font('label'), { color: colors.slate400 }]}>
                        {remaining === 1
                          ? t('today.remainingOne', { personality })
                          : t('today.remaining', { personality, params: { count: remaining } })}
                      </Text>
                    ),
                  }
                : {})}
            />
            {today.isLoading ? (
              <View style={{ gap: 11 }}>
                <SkeletonPriority />
                <SkeletonPriority />
              </View>
            ) : displayed.length > 0 ? (
              <View style={{ gap: 11 }}>
                {displayed.map((p) => (
                  <TodayPriorityCard key={p.id} priority={p} done={!!done[p.id]} onToggle={toggle(p.id)} />
                ))}
              </View>
            ) : todayReady ? (
              // 0 priorité : état vide de premier rang — la voix de Bob, aucune carte fantôme.
              <Card>
                <Text style={[font('sub'), { color: colors.slate500 }]}>
                  {t('today.subtitleNone', { personality })}
                </Text>
              </Card>
            ) : null /* erreur : la carte today.dataError ci-dessus parle déjà */}
          </View>

          {cockpit ? (
            <View>
              <SectionHeader title={t('today.sectionGlance', { personality })} />
              <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 11 }}>
                {glanceLoading ? (
                  <>
                    <SkeletonTile />
                    <SkeletonTile />
                    <SkeletonTile />
                    <SkeletonTile />
                  </>
                ) : (
                  <>
                    <KpiTile
                      style={KPI_TILE}
                      label={t('today.kpiOwed', { personality })}
                      {...(owedCents !== undefined ? { amountCents: owedCents } : {})}
                      tone="success"
                      icon={<TrendUpIcon color={semantic.success} />}
                      onPress={() => router.push('/(tabs)/clients')}
                    />
                    <KpiTile
                      style={KPI_TILE}
                      label={t('today.kpiLate', { personality })}
                      {...(lateCents !== undefined ? { amountCents: lateCents } : {})}
                      tone="danger"
                      icon={<ClockIcon color={semantic.dangerVivid} />}
                      onPress={() => router.push('/(tabs)/clients')}
                    />
                    {/* TVA : pas encore d'endpoint côté client → « — » (jamais un chiffre fixture). */}
                    <KpiTile
                      style={KPI_TILE}
                      label={t('today.kpiVat', { personality })}
                      tone="warning"
                      icon={<CurrencyIcon color={semantic.warning} />}
                    />
                    <KpiTile
                      style={KPI_TILE}
                      label={t('today.kpiEom', { personality })}
                      {...(eomCents !== undefined ? { amountCents: eomCents } : {})}
                      tone="ink"
                      icon={<CalendarIcon color={colors.ink600} />}
                      onPress={() => router.push('/(tabs)/argent')}
                    />
                  </>
                )}
              </View>
            </View>
          ) : null}

          {cockpit ? (
            <View>
              <SectionHeader title={t('today.sectionQuick', { personality })} />
              <View style={{ flexDirection: 'row', gap: 10 }}>
                <QuickAction
                  style={{ flex: 1 }}
                  label={t('today.quickVoice', { personality })}
                  tone="success"
                  icon={<Feather name="mic" size={18} color={semantic.success} />}
                  onPress={() => router.push('/voix')} // C20 — flux facture à la voix
                />
                <QuickAction
                  style={{ flex: 1 }}
                  label={t('today.quickQuote', { personality })}
                  tone="b2b"
                  icon={<Feather name="file" size={18} color={semantic.b2b} />}
                  onPress={() => router.push('/devis/new')}
                />
                <QuickAction
                  style={{ flex: 1 }}
                  label={t('today.quickScan', { personality })}
                  tone="ai"
                  icon={<Feather name="camera" size={18} color={semantic.ai} />}
                  onPress={() => router.push('/scan-document')}
                />
                <QuickAction
                  style={{ flex: 1 }}
                  label={t('today.quickCollect', { personality })}
                  tone="warning"
                  icon={<Feather name="credit-card" size={18} color={semantic.warning} />}
                  onPress={() => router.push('/ventes')}
                />
              </View>
            </View>
          ) : null}

          <Text
            style={[
              font('meta', 500),
              { color: colors.slate300, textAlign: 'center', paddingTop: 6, paddingBottom: 8 },
            ]}
          >
            {t('today.footer', { personality })}
          </Text>
        </View>
      </ScrollView>
    </View>
  );
}
