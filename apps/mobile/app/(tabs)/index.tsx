/**
 * Aujourd'hui — le briefing du jour (claim C10, réfs claims/ref/C10-frame-p1/p2.png).
 * Composition 100 % @bob/ui : AppHeaderNavy → FloatingBalanceCard (geste signature) →
 * « À régler aujourd'hui » (PriorityCard ×3, TODAY_FIXTURE) → « En un coup d'œil »
 * (KpiTile ×4) → « Vite fait » (QuickAction ×4) → footer voix de Bob → Fab.
 * Données : hooks réels (useCashflow/useCustomers) avec repli fixtures @bob/core quand
 * loading/error/absent. Densité Zen : masque « En un coup d'œil » + « Vite fait ».
 * Zéro hex/rgba : tout vient de useTheme() (token-lint).
 */
import { useState } from 'react';
import { ScrollView, Text, View, type StyleProp, type ViewStyle } from 'react-native';
import { useRouter } from 'expo-router';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { Feather } from '@expo/vector-icons';
import { CASH_SNAPSHOT, CUSTOMER_PROPS, MERCIER_PROPS, TODAY_FIXTURE, formatEUR } from '@bob/core';
import { t } from '@bob/i18n';
import {
  AppHeaderNavy,
  Button,
  Card,
  Fab,
  FloatingBalanceCard,
  KpiTile,
  PriorityCard,
  QuickAction,
  SectionHeader,
  StatusBadge,
  font,
  useTheme,
} from '@bob/ui';
import { useCashflow, useCustomers } from '../../src/data/hooks';

// TODO C24 (auth) : identité réelle de l'artisan — le proto est Julien, Mercier Plomberie.
const USER = { firstName: 'Julien', initials: 'JM' } as const;

/** « Te verser ~2 000 € » du proto — repli quand useCashflow n'a pas encore répondu. */
const FALLBACK_PAYOUT_CENTS = 200000;

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

export default function Aujourdhui() {
  const { personality, density, colors, semantic } = useTheme();
  const router = useRouter();
  const insets = useSafeAreaInsets();
  const cashflow = useCashflow('realiste', 30);
  const customers = useCustomers();

  // « Fait » togglable local — le moteur de tâches arrive avec C25 (relances).
  const [done, setDone] = useState<Record<string, boolean>>({});
  const toggle = (id: string) => () => setDone((d) => ({ ...d, [id]: !d[id] }));

  const [prioRelance, prioFacture, prioConformite] = TODAY_FIXTURE.priorities;
  const remaining = TODAY_FIXTURE.priorities.filter((p) => !done[p.id]).length;

  // Données réelles sinon repli fixtures (@bob/core) — l'écran ne montre jamais de trou.
  const dispoCents = cashflow.data?.available ?? TODAY_FIXTURE.dispoCents;
  const payoutCents = cashflow.data?.payout ?? FALLBACK_PAYOUT_CENTS;
  const eomCents = cashflow.data?.available ?? TODAY_FIXTURE.cashByHorizon[30].cents;
  const owedRows = customers.data
    ? customers.data.map((c) => ({ outstanding: c.outstanding, late: c.scoreBand === 'red' }))
    : CUSTOMER_PROPS.map((c) => ({ outstanding: c.outstanding, late: c.avgDelayDays > 7 }));
  const owedCents = owedRows.reduce((sum, c) => sum + c.outstanding, 0);
  const lateCents = owedRows.reduce((sum, c) => sum + (c.late ? c.outstanding : 0), 0);
  const vatCents = CASH_SNAPSHOT.vatDue; // pas encore d'endpoint TVA — snapshot du proto
  const glanceLoading = cashflow.isLoading || customers.isLoading;
  const hasError = cashflow.isError || customers.isError;

  const checkIcon = <Feather name="check" size={14} color={semantic.success} />;
  const cockpit = density !== 'Zen';

  return (
    <View style={{ flex: 1, backgroundColor: colors.bg }}>
      <ScrollView style={{ flex: 1 }} contentContainerStyle={{ paddingBottom: 140 }}>
        <AppHeaderNavy
          {...(insets.top > 0 ? { safeTop: insets.top } : {})}
          dateLabel={todayLabel()}
          companyName={MERCIER_PROPS.name}
          initials={USER.initials}
          title={t('bob.greeting', { personality, params: { name: USER.firstName } })}
          subtitle={
            remaining === 0
              ? t('today.subtitleNone', { personality })
              : t('today.subtitle', { personality, params: { count: remaining } })
          }
          bellIcon={<Feather name="bell" size={18} color={colors.surface} />}
          hasUnread
          onAvatarPress={() => router.push('/compte')}
          onBellPress={() => undefined} // TODO C25 — écran Notifications
        />

        <FloatingBalanceCard
          label={t('today.balanceLabel', { personality })}
          amountCents={dispoCents}
          voiceLine={t('today.payoutHint', { personality, params: { amount: formatEUR(payoutCents) } })}
          chevronIcon={<Feather name="chevron-right" size={16} color={colors.slate500} />}
          voiceIcon={<Feather name="download" size={15} color={semantic.success} />}
          onPress={() => router.push('/(tabs)/argent')}
        />

        <View style={{ paddingHorizontal: 20, paddingTop: 24, gap: 24 }}>
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
              action={
                <Text style={[font('meta'), { color: colors.slate400 }]}>
                  {t('today.remaining', { personality, params: { count: remaining } })}
                </Text>
              }
            />
            <View style={{ gap: 12 }}>
              <PriorityCard
                status="retard"
                title={prioRelance.title}
                subtitle={`${prioRelance.docNumber} · ${formatEUR(prioRelance.amountCents)} — ${t(
                  'today.prioLateHint',
                  { personality, params: { days: prioRelance.daysLate } },
                )}`}
                badge={
                  <StatusBadge
                    label={t('today.prioLateBadge', {
                      personality,
                      params: { days: prioRelance.daysLate },
                    }).toUpperCase()}
                    variant="danger"
                  />
                }
                cta={
                  <Button
                    title={t('today.ctaRelance', { personality })}
                    variant="primary"
                    icon={<Feather name="send" size={15} color={colors.surface} />}
                    style={{ alignSelf: 'flex-start' }}
                    onPress={() => router.push('/(tabs)/assistant')}
                  />
                }
                done={!!done[prioRelance.id]}
                onToggle={toggle(prioRelance.id)}
                checkIcon={checkIcon}
              />
              <PriorityCard
                status="marine"
                title={`${prioFacture.title} — ${prioFacture.customerName}`}
                subtitle={t('today.prioFinalHint', {
                  personality,
                  params: { amount: formatEUR(prioFacture.amountCents) },
                })}
                badge={
                  <StatusBadge
                    label={t('today.prioAcceptedBadge', { personality }).toUpperCase()}
                    variant="b2b"
                  />
                }
                cta={
                  <Button
                    title={t('today.ctaFinalInvoice', { personality })}
                    variant="primary"
                    icon={<Feather name="file-text" size={15} color={colors.surface} />}
                    style={{ alignSelf: 'flex-start' }}
                    onPress={() => router.push('/ventes')}
                  />
                }
                done={!!done[prioFacture.id]}
                onToggle={toggle(prioFacture.id)}
                checkIcon={checkIcon}
              />
              <PriorityCard
                status="conformite"
                title={prioConformite.title}
                subtitle={t('today.prioConformiteHint', { personality })}
                badge={<StatusBadge label={prioConformite.badge.toUpperCase()} variant="b2g" />}
                cta={
                  <Button
                    title={prioConformite.cta}
                    variant="ai"
                    style={{ alignSelf: 'flex-start' }}
                    onPress={() => router.push('/diagnostic')}
                  />
                }
                done={!!done[prioConformite.id]}
                onToggle={toggle(prioConformite.id)}
                checkIcon={checkIcon}
              />
            </View>
          </View>

          {cockpit ? (
            <View>
              <SectionHeader title={t('today.sectionGlance', { personality })} />
              <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 10 }}>
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
                      amountCents={owedCents}
                      tone="success"
                      icon={<Feather name="trending-up" size={14} color={semantic.success} />}
                      onPress={() => router.push('/(tabs)/clients')}
                    />
                    <KpiTile
                      style={KPI_TILE}
                      label={t('today.kpiLate', { personality })}
                      amountCents={lateCents}
                      tone="danger"
                      icon={<Feather name="clock" size={14} color={semantic.dangerVivid} />}
                      onPress={() => router.push('/(tabs)/clients')}
                    />
                    <KpiTile
                      style={KPI_TILE}
                      label={t('today.kpiVat', { personality })}
                      amountCents={vatCents}
                      tone="warning"
                      icon={<Feather name="dollar-sign" size={14} color={semantic.warning} />}
                      onPress={() => router.push('/(tabs)/argent')}
                    />
                    <KpiTile
                      style={KPI_TILE}
                      label={t('today.kpiEom', { personality })}
                      amountCents={eomCents}
                      tone="ink"
                      icon={<Feather name="calendar" size={14} color={colors.slate400} />}
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
              <View style={{ flexDirection: 'row', gap: 8 }}>
                <QuickAction
                  style={{ flex: 1 }}
                  label={t('today.quickVoice', { personality })}
                  tone="success"
                  icon={<Feather name="mic" size={18} color={semantic.success} />}
                  onPress={() => router.push('/(tabs)/assistant')} // TODO C20 — facture à la voix
                />
                <QuickAction
                  style={{ flex: 1 }}
                  label={t('today.quickQuote', { personality })}
                  tone="b2b"
                  icon={<Feather name="file-text" size={18} color={semantic.b2b} />}
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

          <Text style={[font('sub'), { color: colors.slate400, textAlign: 'center' }]}>
            {t('today.footer', { personality })}
          </Text>
        </View>
      </ScrollView>

      <Fab onPress={() => router.push('/devis/new')} accessibilityLabel="Nouveau devis" />
    </View>
  );
}
