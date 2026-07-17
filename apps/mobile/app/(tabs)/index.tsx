/**
 * Aujourd'hui — le briefing du jour (claim C10 v1.1 + rattrapage DA pixel-perfect,
 * réf design_handoff_bob_pro/Bob Pro.dc.html). Composition 100 % @bob/ui :
 * AppHeaderNavy (halos radiaux) → FloatingBalanceCard (geste signature) →
 * « À régler aujourd'hui » (PriorityCard ; conformité = carte info lavande, sans checkbox) →
 * « En un coup d'œil » (KpiTile ×4 iconées) → « Vite fait » (QuickAction ×4, dont Catalogue
 * C27 — TODAY_QUICK_ACTIONS) → footer.
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
 * · « Vite fait »    : devis → /devis/new · scan → /scan-document · encaisser → /ventes.
 *                      La voix possède une seule entrée universelle : l'orbe Bob globale.
 *
 * Densité Zen : masque « En un coup d'œil » + « Vite fait ». Zéro hex/rgba : useTheme()/@bob/tokens.
 */
import { useMemo, useRef, useState } from 'react';
import { ActivityIndicator, Pressable, RefreshControl, ScrollView, Text, View, type StyleProp, type ViewStyle } from 'react-native';
import { useRouter } from 'expo-router';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { Feather } from '@expo/vector-icons';
import { challengeFor } from '@bob/ai';
import { formatEURWhole, normalizeVoiceText, type TodayPriority } from '@bob/core';
import { useIdentity } from '../../src/data/identity';
import type { InvoiceView } from '@bob/api-client';
import { patterns, shadowNative } from '@bob/tokens';
import { t, type I18nKey } from '@bob/i18n';
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
import { Badge } from '../../src/components/ui';
import { useConfirm } from '../../src/components/ConfirmSheet';
import { hasMeaningfulQuoteDraft, useQuoteDraft } from '../../src/quote-draft';
import { combineQueryStates } from '../../src/data/query-state';
import { CollectInvoiceButton } from '../../src/components/CollectInvoiceButton';
import { TODAY_QUICK_ACTIONS } from '../../src/components/today-quick-actions';
import { useBobAwareScrollInsets } from '../../src/components/use-bob-aware-scroll-insets';
import { LatestValueDigestCard } from '../../src/engagement/ValueDigestCard';
import { LatestTrialReportCard } from '../../src/monetization/TrialReportCard';
import {
  usePublishAgentContext,
  type AgentAffordance,
  type AgentContext,
  type AgentEntityRef,
} from '../../src/agent';
import { useFiscalProfileFlow } from '../../src/fiscal/use-fiscal-profile-flow';
import { useOwnerPayGuidance } from '../../src/fiscal/use-owner-pay-guidance';
import { useSalesDocumentVoiceAffordance } from '../../src/documents-voice-search';
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

/**
 * Rappel de brouillon de devis (C21 redécoupe 2026-07-17) — CLIENT-SIDE UNIQUEMENT : le
 * brouillon vit en local (SecureStore, voir apps/mobile/src/quote-draft), jamais côté serveur.
 * Il n'entre donc PAS dans @bob/core TodayPriority (dérivé de données serveur) — cette carte
 * est composée ICI, dans le rendu du Home, en fusionnant `today.priorities` (serveur) avec cet
 * unique rappel local (le stockage est un slot UNIQUE : au plus un brouillon à la fois).
 */
interface DraftQuotePriority {
  readonly kind: 'devis_brouillon';
  readonly id: string;
  readonly customerName: string | null;
}
type DisplayPriority = TodayPriority | DraftQuotePriority;

/** Sobriété (fondateur 2026-07-17) : jamais pendant que la personne travaille dessus — un
 * brouillon tout juste enregistré ne remonte qu'après ~1 h, ou dès la réouverture de l'app. */
const DRAFT_REMINDER_MIN_AGE_MS = 60 * 60 * 1000;

// Suppression d'un brouillon = geste réversible-fort (même palier que le trash « brouillon »
// des factures, InvoiceActions) — TOUJOURS derrière une ConfirmSheet, jamais un tap unique.
const DRAFT_DELETE_RISK = { mutating: true, outbound: false, riskTier: 'reversible' } as const;

/** Vrai UNE SEULE fois par processus JS (cold start) — approxime « l'app vient d'être rouverte »
 * sans dépendre d'AppState : un changement d'onglet ne relance jamais le module. */
let appSessionFresh = true;

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

/** Carte d'une priorité dérivée (@bob/core TodayPriority, + rappel local de brouillon
 * DisplayPriority) — copy @bob/i18n, CTA = parité d'actions Bob. */
function TodayPriorityCard({
  priority,
  done,
  onToggle,
  invoice,
  onCollected,
}: {
  priority: DisplayPriority;
  done: boolean;
  onToggle: () => void;
  /** Facture réelle de la relance (A2-C10) — active « Encaisser » directement sur la carte. */
  invoice?: InvoiceView | undefined;
  onCollected?: (amountCents: number) => void;
}) {
  const { personality, colors, semantic } = useTheme();
  const router = useRouter();
  const quoteDraft = useQuoteDraft();
  const confirm = useConfirm();
  const [draftDeleteBusy, setDraftDeleteBusy] = useState(false);
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
    case 'devis_brouillon': {
      // Rappel local (jamais côté serveur) : jamais de checkbox — puce warning, CTA Continuer +
      // corbeille. Suppression TOUJOURS derrière une ConfirmSheet, même depuis cette carte
      // (verrouillage fondateur : aucune suppression en un seul tap, nulle part).
      const name = priority.customerName ?? t('today.prioDraftNoCustomer', { personality });
      return (
        <PriorityCard
          status="brouillon"
          title={t('today.prioDraftTitle', { personality, params: { name } })}
          subtitle={t('today.prioDraftHint', { personality })}
          leadingIcon={<Feather name="file-text" size={13} color={semantic.warning} />}
          badge={<Badge label={t('today.prioDraftBadge', { personality }).toUpperCase()} tone="warning" />}
          cta={
            <View style={{ flexDirection: 'row', gap: 8, alignSelf: 'flex-start', alignItems: 'center' }}>
              <Button
                title={t('today.ctaDraftResume', { personality })}
                variant="primary"
                size="compact"
                radius={11}
                icon={<Feather name="edit-3" size={15} color={colors.surface} />}
                onPress={() => router.push('/devis/new?resume=1')}
              />
              <Pressable
                accessibilityRole="button"
                accessibilityLabel={t('today.ctaDraftDelete', { personality })}
                disabled={draftDeleteBusy}
                hitSlop={4}
                onPress={() =>
                  void (async () => {
                    const ok = await confirm({
                      title: t('today.draftDeleteConfirmTitle', { personality }),
                      message: t('today.draftDeleteConfirmBody', { personality, params: { name } }),
                      challenge: challengeFor(DRAFT_DELETE_RISK, 'confirm_all'),
                      destructive: true,
                    });
                    if (!ok) return;
                    setDraftDeleteBusy(true);
                    try {
                      await quoteDraft.discard();
                    } finally {
                      setDraftDeleteBusy(false);
                    }
                  })()
                }
                style={{
                  width: 40,
                  height: 40,
                  borderRadius: 12,
                  alignItems: 'center',
                  justifyContent: 'center',
                  backgroundColor: semantic.dangerBg,
                  opacity: draftDeleteBusy ? 0.5 : 1,
                }}
              >
                {draftDeleteBusy ? (
                  <ActivityIndicator size="small" color={semantic.danger} />
                ) : (
                  <Feather name="trash-2" size={16} color={semantic.danger} />
                )}
              </Pressable>
            </View>
          }
        />
      );
    }
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
  const quoteDraft = useQuoteDraft();
  // A2-C10 : mêmes queries que useTodayPriorities (cache partagé, coût nul) — la carte
  // relance a besoin de la facture RÉELLE pour encaisser avec les invariants du domaine.
  const invoices = useInvoices();
  // C25 : fil de notifications réel (queries partagées avec /notifications — coût nul en plus).
  const notifications = useNotificationsFeed();
  // SPEC_EXPERT_FISCAL amendement 2 : Home = simple badge de fiabilité sur le montant, PAS de
  // 2ᵉ carte — le badge et la voix ouvrent le MÊME mini-flow que la carte d'Argent.
  const fiscalFlow = useFiscalProfileFlow();
  // Phase 1C : today.payoutHint s'adapte au profil fiscal CONFIRMÉ (même moteur que le héros
  // Argent, porte sur LE MÊME cashflow réaliste/30j que celui affiché ici) — la pastille de
  // fiabilité 1B (fiscalFlow.hasPending, badge ci-dessous) reste inchangée.
  const payGuidance = useOwnerPayGuidance(cashflow.data);
  const guidance = payGuidance.guidance;
  const bobScrollInsets = useBobAwareScrollInsets({ minimumBottom: 140 });

  // « Fait » togglable local — le moteur de tâches arrive avec C25 (relances).
  const [done, setDone] = useState<Record<string, boolean>>({});
  const toggle = (id: string) => () => setDone((d) => ({ ...d, [id]: !d[id] }));
  const [toast, setToast] = useState<string | null>(null);
  // Cold start (voir `appSessionFresh` ci-dessus) — capturé UNE fois, avant que ce composant
  // (ou tout autre écran monté avant lui) ne consomme le flag pour ce processus JS.
  const [isFreshAppSession] = useState(() => {
    const fresh = appSessionFresh;
    appSessionFresh = false;
    return fresh;
  });

  // Rappel de brouillon (C21 redécoupe) : composé CÔTÉ MOBILE, jamais remonté au serveur — le
  // stockage local est un slot UNIQUE (voir apps/mobile/src/quote-draft), donc au plus UNE carte.
  // `pendingResume` (soft-reset côté wizard) prime sur l'état live ; sinon, un brouillon jamais
  // rouvert cette session (démarrage à froid direct sur le Home) reste visible via `state`.
  const localDraft =
    quoteDraft.pendingResume ??
    (hasMeaningfulQuoteDraft(quoteDraft.state) && quoteDraft.state.saved !== null
      ? quoteDraft.state
      : null);
  const draftAgeMs = localDraft?.saved != null ? Date.now() - localDraft.saved.at : null;
  const showDraftReminder =
    localDraft !== null &&
    (isFreshAppSession || (draftAgeMs !== null && draftAgeMs > DRAFT_REMINDER_MIN_AGE_MS));
  const draftPriority: DraftQuotePriority | null = showDraftReminder
    ? { kind: 'devis_brouillon', id: 'devis-brouillon-local', customerName: localDraft.customer?.name ?? null }
    : null;
  // Priorité basse (fin de liste) : un rappel de brouillon n'a jamais à évincer une vraie
  // urgence (relance en retard, facture finale à émettre).
  const allPriorities: DisplayPriority[] = draftPriority
    ? [...today.priorities, draftPriority]
    : today.priorities;

  const displayed = allPriorities.slice(0, DISPLAY_CAP);
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

  // ── Parité vocale du rappel de brouillon (« continue mon devis en cours » / « supprime le
  // brouillon ») — refs pour une identité STABLE de l'affordance (même convention que
  // ventes.tsx) ; la suppression reste TOUJOURS derrière la ConfirmSheet, jamais un tap voix
  // unique (verrouillage fondateur — aucune suppression en un seul geste, nulle part).
  const localDraftRef = useRef(localDraft);
  localDraftRef.current = localDraft;
  const routerRef = useRef(router);
  routerRef.current = router;
  const confirm = useConfirm();
  const confirmRef = useRef(confirm);
  confirmRef.current = confirm;
  const quoteDraftRef = useRef(quoteDraft);
  quoteDraftRef.current = quoteDraft;
  const homePersonalityRef = useRef(personality);
  homePersonalityRef.current = personality;
  const draftVoiceAffordances = useMemo<readonly AgentAffordance[]>(
    () => [
      {
        id: 'today.resumeDraft',
        match: (utterance) => {
          if (localDraftRef.current === null) return null;
          const n = normalizeVoiceText(utterance);
          if (!/(continue|reprend\w*).{0,15}(devis|brouillon)/.test(n)) return null;
          return () => {
            routerRef.current.push('/devis/new?resume=1');
            return { say: t('today.voiceDraftResume', { personality: homePersonalityRef.current }) };
          };
        },
      },
      {
        id: 'today.deleteDraft',
        match: (utterance) => {
          const draft = localDraftRef.current;
          if (draft === null) return null;
          const n = normalizeVoiceText(utterance);
          if (!/(supprime|efface)\w*.{0,15}(devis|brouillon)/.test(n)) return null;
          return () => {
            const name = draft.customer?.name ?? t('today.prioDraftNoCustomer', { personality: homePersonalityRef.current });
            void (async () => {
              const ok = await confirmRef.current({
                title: t('today.draftDeleteConfirmTitle', { personality: homePersonalityRef.current }),
                message: t('today.draftDeleteConfirmBody', {
                  personality: homePersonalityRef.current,
                  params: { name },
                }),
                challenge: challengeFor(DRAFT_DELETE_RISK, 'confirm_all'),
                destructive: true,
              });
              if (ok) await quoteDraftRef.current.discard();
            })();
            return { say: t('today.voiceDraftDeleteOpened', { personality: homePersonalityRef.current }) };
          };
        },
      },
    ],
    [],
  );
  // B9 — même affordance globale que ventes.tsx (« retrouve les devis de Mairie de Sèvres du
  // mois dernier ») : Accueil est la seconde porte d'entrée voulue par le fondateur, la logique
  // vit une seule fois dans apps/mobile/src/documents-voice-search.ts.
  const salesDocumentVoiceAffordance = useSalesDocumentVoiceAffordance(personality);
  usePublishAgentContext(agentContext, {}, {
    affordances: [salesDocumentVoiceAffordance, ...fiscalFlow.voiceAffordances, ...draftVoiceAffordances],
  });

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
        contentContainerStyle={{ paddingBottom: bobScrollInsets.paddingBottom }}
        scrollIndicatorInsets={{ bottom: bobScrollInsets.scrollIndicatorBottom }}
        automaticallyAdjustKeyboardInsets={bobScrollInsets.automaticallyAdjustKeyboardInsets}
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
            // Phase 1C : kind 'prudent' (profil non confirmé) garde LA MÊME clé qu'avant cette
            // phase (zéro régression) ; un profil confirmé bascule sur la phrase adaptée à sa
            // situation (guidance.captionKey, mêmes params que le héros Argent — parité).
            voiceLine={
              guidance && guidance.kind !== 'prudent'
                ? t(guidance.captionKey as I18nKey, { personality, params: guidance.params })
                : t('today.payoutHint', {
                    personality,
                    params: { amount: formatEURWhole(cashflow.data.payout) },
                  })
            }
            chevronIcon={<ChevronRightIcon color={colors.slate400} size={15} strokeWidth={2.4} />}
            voiceIcon={<DepositIcon color={semantic.success} size={16} />}
            onPress={() => router.push('/(tabs)/argent')}
            {...(fiscalFlow.hasPending
              ? {
                  badge: {
                    label: t('fiscal.badge.label', { personality }),
                    accessibilityHint: t('fiscal.badge.accessibilityHint', { personality }),
                    onPress: fiscalFlow.openFlow,
                  },
                }
              : {})}
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

          {/* Bilan de fin d'essai (SPEC pilier 2, décision 2) — n'existe qu'au TERME de l'essai
              (ending_soon/expired) : chiffres réels du tenant + UN CTA vers l'écran Compte. */}
          <LatestTrialReportCard />

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
                {TODAY_QUICK_ACTIONS.map((action) => (
                  <QuickAction
                    key={action.id}
                    style={{ flex: 1 }}
                    label={t(action.labelKey, { personality })}
                    tone={action.tone}
                    icon={(
                      <Feather
                        name={action.icon}
                        size={18}
                        color={semantic[action.tone]}
                      />
                    )}
                    onPress={() => router.push(action.route)}
                  />
                ))}
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
      {fiscalFlow.sheets}
    </View>
  );
}
