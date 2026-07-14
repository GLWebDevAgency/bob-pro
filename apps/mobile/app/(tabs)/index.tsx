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
 * · facture finale   → /devis/[quoteId] (le devis concerné — QuoteActions y appelle generate-invoice-from-quote,
 *                      le use case que Bob invoque) ;
 * · diagnostic       → /diagnostic (getDiagnostic — même query que Bob) ;
 * · « Vite fait »    : voix → session Bob globale contextuelle · devis → /devis/new ·
 *                      scan → /scan-document · encaisser → /ventes (register-payment).
 *
 * Densité Zen : masque « En un coup d'œil » + « Vite fait ». Zéro hex/rgba : useTheme()/@bob/tokens.
 */
import { useMemo, useState } from 'react';
import { RefreshControl, ScrollView, Text, View, type StyleProp, type ViewStyle } from 'react-native';
import { useRouter } from 'expo-router';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { Feather } from '@expo/vector-icons';
import { formatEURWhole, type TodayPriority } from '@bob/core';
import { useIdentity } from '../../src/data/identity';
import type { InvoiceView } from '@bob/api-client';
import { patterns, shadowNative } from '@bob/tokens';
import { t } from '@bob/i18n';
import {
  AppHeaderNavy,
  Button,
  Card,
  EmptyState,
  ErrorRetry,
  FloatingBalanceCard,
  KpiTile,
  PriorityCard,
  QuickAction,
  SectionHeader,
  Skeleton,
  StatusBadge,
  Toast,
  font,
  useTheme,
} from '@bob/ui';
import {
  useCashflow,
  useCustomers,
  useInvoices,
  useNotificationsFeed,
  useTodayPriorities,
} from '../../src/data/hooks';
import { combineQueryStates } from '../../src/data/query-state';
import { CollectInvoiceButton } from '../../src/components/CollectInvoiceButton';
import { LatestValueDigestCard } from '../../src/engagement/ValueDigestCard';
import { usePublishAgentContext, type AgentContext, type AgentEntityRef } from '../../src/agent';
import {
  CalendarIcon,
  ChevronRightIcon,
  ClockIcon,
  CurrencyIcon,
  DepositIcon,
  ShieldIcon,
  TrendUpIcon,
} from '../../src/components/icons';

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
  return (
    <Card style={KPI_TILE}>
      <Skeleton height={12} width="55%" radius={6} />
      <Skeleton height={21} width="70%" radius={6} style={{ marginTop: 10 }} />
    </Card>
  );
}

/** Skeleton d'une carte priorité (même gabarit qu'une PriorityCard au repos). */
function SkeletonPriority() {
  return (
    <Card>
      <Skeleton height={20} width="38%" radius={10} />
      <Skeleton height={15} width="80%" radius={6} style={{ marginTop: 12 }} />
      <Skeleton height={15} width="62%" radius={6} style={{ marginTop: 8 }} />
      <Skeleton height={34} width="42%" radius={12} style={{ marginTop: 14 }} />
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
        <Skeleton height={31} width="46%" radius={8} style={{ marginTop: 6 }} />
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
  invoice,
  onCollected,
}: {
  priority: TodayPriority;
  done: boolean;
  onToggle: () => void;
  /** Facture réelle de la relance (A2-C10) — active « Encaisser » directement sur la carte. */
  invoice?: InvoiceView | undefined;
  onCollected?: (amountCents: number) => void;
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
          subtitle={`${reference}${formatEURWhole(priority.amountCents)} — ${t(
            'today.prioLateHint',
            {
              personality,
              params: { days: priority.daysLate },
            },
          )}`}
          badge={
            <StatusBadge
              label={t('today.prioLateBadge', {
                personality,
                params: { days: priority.daysLate },
              }).toUpperCase()}
              variant="danger"
            />
          }
          cta={
            <View style={{ flexDirection: 'row', gap: 8, alignSelf: 'flex-start' }}>
              <Button
                title={t('today.ctaRelance', { personality })}
                variant="primary"
                size="compact"
                radius={11}
                icon={<Feather name="send" size={15} color={colors.surface} />}
                // ?prompt=relance : l'assistant pré-remplit ET soumet la demande (C15).
                onPress={() =>
                  router.push({ pathname: '/(tabs)/assistant', params: { prompt: 'relance' } })
                }
              />
              {/* A2-C10 : encaisser SANS quitter le briefing — mêmes invariants que InvoiceActions
                  (assiette netToPay, confirmation ACCOUNTING, idempotence). */}
              {invoice ? (
                <CollectInvoiceButton
                  invoice={invoice}
                  title={t('today.ctaCollect', { personality })}
                  {...(onCollected ? { onDone: onCollected } : {})}
                />
              ) : null}
            </View>
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
            <StatusBadge
              label={t('today.prioAcceptedBadge', { personality }).toUpperCase()}
              variant="b2b"
            />
          }
          cta={
            <Button
              title={t('today.ctaFinalInvoice', { personality })}
              variant="primary"
              size="compact"
              radius={11}
              icon={<Feather name="file-plus" size={15} color={colors.surface} />}
              style={{ alignSelf: 'flex-start' }}
              onPress={() => router.push(`/devis/${priority.quoteId}`)}
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
            <StatusBadge
              label={t('today.prioConformiteBadge', { personality }).toUpperCase()}
              variant="b2g"
            />
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
  const identity = useIdentity();
  const { personality, density, colors, semantic } = useTheme();
  const router = useRouter();
  const insets = useSafeAreaInsets();
  const cashflow = useCashflow('realiste', 30);
  const customers = useCustomers();
  const today = useTodayPriorities();
  // A2-C10 : mêmes queries que useTodayPriorities (cache partagé, coût nul) — la carte
  // relance a besoin de la facture RÉELLE pour encaisser avec les invariants du domaine.
  const invoices = useInvoices();
  // C25 : fil de notifications réel (queries partagées avec /notifications — coût nul en plus).
  const notifications = useNotificationsFeed();

  // « Fait » togglable local — le moteur de tâches arrive avec C25 (relances).
  const [done, setDone] = useState<Record<string, boolean>>({});
  const toggle = (id: string) => () => setDone((d) => ({ ...d, [id]: !d[id] }));
  const [toast, setToast] = useState<string | null>(null);

  const displayed = today.priorities.slice(0, DISPLAY_CAP);
  const remaining = displayed.filter((p) => !done[p.id]).length;
  const todayReady = !today.isLoading && !today.isError;
  const agentContext = useMemo<AgentContext>(() => {
    const entities: AgentEntityRef[] = [];
    const seen = new Set<string>();
    const add = (entity: AgentEntityRef): void => {
      const key = `${entity.type}:${entity.id}`;
      if (seen.has(key)) return;
      seen.add(key);
      entities.push(entity);
    };
    for (const priority of today.priorities.slice(0, DISPLAY_CAP)) {
      if (priority.kind === 'relance') {
        add({
          type: 'invoice',
          id: priority.invoiceId,
          label: priority.docNumber ? `Facture ${priority.docNumber}` : 'Facture à relancer',
        });
        add({ type: 'customer', id: priority.customerId, label: priority.customerName });
      } else if (priority.kind === 'facture_finale') {
        add({
          type: 'quote',
          id: priority.quoteId,
          label: priority.docNumber ? `Devis ${priority.docNumber}` : 'Devis signé',
        });
        add({ type: 'customer', id: priority.customerId, label: priority.customerName });
      }
    }
    return {
      screen: { name: '/(tabs)/index', instanceId: 'today' },
      entities,
      capabilities: [
        'screen.read',
        'today.read',
        'cashflow.read',
        'priorities.read',
        'invoice.read',
        'quote.read',
        'customer.read',
      ],
    };
  }, [today.priorities]);
  usePublishAgentContext(agentContext);

  // KPI : uniquement des agrégats dérivés des queries réelles — sinon tuile vide « — ».
  const owedCents = customers.data?.reduce((sum, c) => sum + c.outstanding, 0);
  const lateCents = customers.data?.reduce(
    (sum, c) => sum + (c.scoreBand === 'red' ? c.outstanding : 0),
    0,
  );
  const eomCents = cashflow.data?.available; // horizon 30 j réaliste = fin de mois
  const glanceLoading = cashflow.isLoading || customers.isLoading;
  const primaryState = combineQueryStates(cashflow, customers, today);
  const refreshing =
    cashflow.isRefetching ||
    customers.isRefetching ||
    today.isRefetching ||
    invoices.isRefetching ||
    notifications.isRefetching;
  const refreshAll = (): void => {
    primaryState.refetchAll();
    void invoices.refetch();
    void notifications.refetch();
  };

  const cockpit = density !== 'Zen';

  return (
    <View style={{ flex: 1, backgroundColor: colors.bg }}>
      <ScrollView
        style={{ flex: 1 }}
        contentContainerStyle={{ paddingBottom: 140 }}
        refreshControl={
          <RefreshControl
            refreshing={refreshing}
            onRefresh={refreshAll}
            tintColor={colors.ink800}
            colors={[colors.ink800]}
          />
        }
      >
        <AppHeaderNavy
          {...(insets.top > 0 ? { safeTop: insets.top } : {})}
          dateLabel={todayLabel()}
          companyName={identity.companyName ?? ''}
          initials={identity.initials}
          title={
            identity.firstName
              ? t('bob.greeting', { personality, params: { name: identity.firstName } })
              : t('bob.tagline', { personality })
          }
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
          // C25 v2 : pastille = NON-LUS du fil SERVEUR (GET /notifications, lu/non-lu persistés) —
          // même query que l'écran /notifications, jamais un point rouge inventé.
          hasUnread={notifications.unreadCount > 0}
          onAvatarPress={() => router.push('/compte')}
          onBellPress={() => router.push('/notifications')}
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
          {primaryState.failed ? (
            <ErrorRetry
              message={t('today.dataError', { personality })}
              onRetry={primaryState.refetchAll}
            />
          ) : null}

          {/* Digest « le lundi de Bob » (SPEC pilier 2) — la notification weekly-digest ramène
              ICI ; invisible tant que useLatestValueDigest() rend null (serveur pas branché). */}
          <LatestValueDigestCard />

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
            {
              today.isLoading ? (
                <View style={{ gap: 11 }}>
                  <SkeletonPriority />
                  <SkeletonPriority />
                </View>
              ) : displayed.length > 0 ? (
                <View style={{ gap: 11 }}>
                  {displayed.map((p) => (
                    <TodayPriorityCard
                      key={p.id}
                      priority={p}
                      done={!!done[p.id]}
                      onToggle={toggle(p.id)}
                      invoice={
                        p.kind === 'relance'
                          ? (invoices.data ?? []).find((i) => i.id === p.invoiceId)
                          : undefined
                      }
                      onCollected={(cents) =>
                        setToast(
                          t('today.collectDone', {
                            personality,
                            params: { amount: formatEURWhole(cents) },
                          }),
                        )
                      }
                    />
                  ))}
                </View>
              ) : todayReady ? (
                // 0 priorité : état vide de premier rang — la voix de Bob, aucune carte fantôme.
                <Card>
                  <EmptyState body={t('today.subtitleNone', { personality })} />
                </Card>
              ) : null /* erreur : la carte today.dataError ci-dessus parle déjà */
            }
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
                    {/* TVA à provisionner (A3-C10) : le MÊME chiffre que celui qui ampute la
                        dispo du héros (CashflowProjection.vatDue) — jamais un chiffre parallèle. */}
                    <KpiTile
                      style={KPI_TILE}
                      label={t('today.kpiVat', { personality })}
                      {...(cashflow.data ? { amountCents: cashflow.data.vatDue } : {})}
                      tone="warning"
                      icon={<CurrencyIcon color={semantic.warning} />}
                      onPress={() => router.push('/comptabilite')}
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
                  tone="ai"
                  icon={<Feather name="mic" size={18} color={semantic.ai} />}
                  // C20 conservé : « À la voix » = flux complet de facture dictée. Le hub Bob
                  // global (bouton flottant) reste lecture seule tant que S2 n'exécute pas de
                  // proposition depuis l'overlay — sinon la dictée finirait en cul-de-sac.
                  onPress={() => router.push('/voix')}
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

      <Toast
        message={toast ?? ''}
        visible={toast !== null}
        onHide={() => setToast(null)}
        icon={<Feather name="check" size={16} color={colors.surface} />}
      />
    </View>
  );
}
