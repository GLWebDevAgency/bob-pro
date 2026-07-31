/**
 * Argent — le vrai état des comptes (claim C11, réfs claims/ref/C11-frame-p1/p2.png + astuce).
 * Composition 100 % @bob/ui : InnerScreenHeader → HeroMoneyCard (« trésorerie mobilisable »,
 * pill sans risque — langage prudent SPEC_EXPERT_FISCAL §V2 pt. 8, jamais « te verser »)
 * → grand-livre « Argent disponible réel » badge LE SOLDE MENT (MoneyRow lead + rangées signées
 * + total) → « Prévision de tréso » (SegmentedControl 7/30/60/90 j × Optimiste/Réaliste/Prudent)
 * → « À surveiller » (factures réellement échues) → « Mise de côté auto » (réserve TVA + charges)
 * → astuce première fois (dismiss persisté SecureStore) → Fab.
 *
 * DONNÉES RÉELLES (A1-C10 généralisé) : tout vient des queries du BobClient —
 * useCashflow(scenario, horizon) pour héros/prévision (série 4 horizons → cashflowBand @bob/core) ;
 * le grand-livre est dérivé dans @bob/core (buildLedgerView, use case pur testé) depuis
 * listInvoices + listExpenses + listAccountingEntries + company/payments/asOf (C-EXP-UI2 :
 * cotisations URSSAF réelles + carte « déclaration pré-calculée » pour une company MICRO —
 * ledger.urssaf) ; la réserve = buildLedgerView().reserve.
 * AUCUN repli fixtures — états premier rang (montée d'exigence 16/07) :
 * · loading → SKELETONS du socle @bob/ui, FIDÈLES à la géométrie finale (héros/ledger/échéancier),
 *   pulse subtil (reduce-motion : statique) ; le message d'erreur n'apparaît JAMAIS pendant le
 *   premier chargement ;
 * · compte NEUF (toutes sources vides) → état VIDE INVITANT (argent.empty*) avec CTA solde/devis,
 *   jamais un désert de « — » ;
 * · erreur réelle → ErrorRetry (retry MANUEL avec état pending visible ; le retry AUTO est borné
 *   par la politique globale query-retry-policy — zéro tunnel) ;
 * · donnée absente ponctuelle → « — » par ligne (cotisations hors micro : aucune source, P23/P34) ;
 * · skeleton → contenu : fondu doux + cascade légère (FadeIn @bob/ui, 40 ms/section,
 *   reduce-motion : apparition immédiate).
 *
 * PARITÉ D'ACTIONS humain ↔ Bob (directive 23:52) : écran en LECTURE SEULE — aucune action
 * mutante. Les navigations empruntent les mêmes points d'entrée que Bob :
 * · « Laisse l'assistant relancer… » → /(tabs)/assistant (prompt → runtime agent, use cases
 *   relance @bob/core — même chemin que la relance C10) ;
 * · Fab → /devis/new (create-quote, le use case que Bob invoque).
 * CTA futures documentées : toggle « Mise de côté auto » (nécessite un use case de provisionnement
 * — TODO C40) · « Tout passer » de l'astuce ne couvre que cet écran tant qu'il n'existe qu'un tip.
 *
 * Zéro hex/rgba : useTheme()/@bob/tokens. Zéro import de src/components/ui (ancien kit).
 */
import { useMemo, useState } from 'react';
import {
  Modal,
  Pressable,
  RefreshControl,
  ScrollView,
  Text,
  View,
  type ViewStyle,
} from 'react-native';
import { useRouter } from 'expo-router';
import { Feather, Ionicons } from '@expo/vector-icons';
import {
  buildLedgerView,
  cashflowBand,
  formatEUR,
  parisDateOnly,
  type CashflowBand,
  type CashflowSeriesPoint,
  type FiscalDeadline,
  type Horizon,
  type Scenario,
} from '@bob/core';
import { patterns, shadowNative } from '@bob/tokens';
import { deriveAgedBalance, type AgedBucketKey } from '@bob/core';
import { t, type I18nKey, type Personality } from '@bob/i18n';
import { usePublishAgentContext, type AgentContext, type AgentSurface } from '../../src/agent';
import { deriveCashPositionDisplay } from '../../src/finance/cash-position-view';
import {
  Avatar,
  Button,
  Card,
  ErrorRetry,
  Fab,
  FadeIn,
  HeroMoneyCard,
  IconTile,
  InnerScreenHeader,
  MoneyRow,
  MoneyText,
  SectionHeader,
  SegmentedControl,
  Skeleton,
  StatusBadge,
  font,
  useReduceMotion,
  useTheme,
} from '@bob/ui';
import {
  useAccountingEntries,
  useCashflow,
  useCompanyMe,
  useCustomers,
  useExpenses,
  useFiscalCalendar,
  useInvoices,
  useLatestBankBalance,
  usePayments,
} from '../../src/data/hooks';
import { useFirstTimeTip } from '../../src/data/tips';
import { useFiscalProfileFlow } from '../../src/fiscal/use-fiscal-profile-flow';
import { useOwnerPayGuidance } from '../../src/fiscal/use-owner-pay-guidance';
import { useBobAwareScrollInsets } from '../../src/components/use-bob-aware-scroll-insets';
import { TabsScrollView } from '../../src/components/bob-tabs-scroll-view';
import { BankBalanceSheet } from '../../src/components/BankBalanceSheet';
import { RetenueSuiviCard } from '../../src/components/RetenueSuiviCard';
import { hasBlockingAuthoritativeDataError } from '../../src/data/authoritative-query-state';
import {
  isBankBalanceQualificationError,
  isCashflowBankingInputMissing,
} from '../../src/data/cashflow-banking-state';

/** Clé SecureStore du coach-mark « première fois » de cet écran. */
const TIP_KEY = 'bob.tips.argent.v1';

const HORIZON_KEYS = ['7', '30', '60', '90'] as const;
type HorizonKey = (typeof HORIZON_KEYS)[number];
const HORIZONS: Record<HorizonKey, Horizon> = { 7: 7, 30: 30, 60: 60, 90: 90 };

const SCENARIO_LABEL: Record<Scenario, I18nKey> = {
  optimiste: 'argent.scenarioOptimiste',
  realiste: 'argent.scenarioRealiste',
  prudent: 'argent.scenarioPrudent',
};

const BAND_LABEL: Record<CashflowBand, I18nKey> = {
  tranquille: 'argent.bandTranquille',
  passe: 'argent.bandPasse',
  creux: 'argent.bandCreux',
  repart: 'argent.bandRepart',
};

/**
 * Héros sans donnée (chargement ou erreur) : MÊME géométrie que la HeroMoneyCard (radius 24,
 * padding 20, label → montant heroNum + pill → caption) — zéro saut quand la donnée arrive,
 * et jamais un montant inventé (A1-C10). Skeletons du socle @bob/ui (pulse, reduce-motion safe).
 */
function HeroPlaceholder({ loading }: { loading: boolean }) {
  const { personality, colors, controls } = useTheme();
  return (
    <View
      style={{
        backgroundColor: colors.surface,
        borderRadius: 24,
        borderWidth: 1,
        borderColor: controls.cardBorder,
        padding: 20,
        ...shadowNative.e2,
      }}
    >
      <Text style={[font('label'), { color: colors.slate400 }]}>
        {t('argent.heroLabel', { personality })}
      </Text>
      {loading ? (
        <>
          <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8, marginTop: 6 }}>
            <Skeleton width="52%" height={34} radius={9} />
            <Skeleton width={92} height={22} radius={999} />
          </View>
          <Skeleton width="74%" height={13} style={{ marginTop: 9 }} />
        </>
      ) : (
        <Text style={{ ...font('heroNum'), color: colors.slate400, marginTop: 4 }}>—</Text>
      )}
    </View>
  );
}

/**
 * Rangée du grand-livre sans donnée : « — » est un état de premier rang — même géométrie
 * que MoneyRow (padding V 9, séparateur patterns.moneyRow.divider), jamais un 0 inventé.
 */
function EmptyMoneyRow({
  label,
  variant = 'default',
  divider = true,
}: {
  label: string;
  variant?: 'default' | 'lead' | 'total';
  divider?: boolean;
}) {
  const { colors } = useTheme();
  const isTotal = variant === 'total';
  const isLead = variant === 'lead';
  return (
    <View
      accessible
      accessibilityLabel={`${label}, —`}
      style={{
        flexDirection: 'row',
        alignItems: 'center',
        justifyContent: 'space-between',
        paddingVertical: 9,
        ...(isTotal ? { paddingTop: 13 } : {}),
        ...(divider ? { borderBottomWidth: 1, borderBottomColor: patterns.moneyRow.divider } : {}),
      }}
    >
      <Text
        numberOfLines={1}
        style={[
          font('body'),
          { fontSize: 14, color: colors.slate500 },
          isLead ? { fontWeight: '600', color: colors.ink800 } : null,
          isTotal ? { fontSize: 15, fontWeight: '700', color: colors.ink800 } : null,
        ]}
      >
        {label}
      </Text>
      <Text
        style={[
          font('cardTitle'),
          { fontSize: isTotal ? 20 : 15, color: colors.slate400, fontVariant: ['tabular-nums'] },
        ]}
      >
        —
      </Text>
    </View>
  );
}

// ── Échéancier fiscal « À venir » (C-EXP-UI1 — deriveFiscalCalendar C-EXP5/5b) ──

const FR_MONTHS_SHORT = [
  'janv.',
  'févr.',
  'mars',
  'avr.',
  'mai',
  'juin',
  'juil.',
  'août',
  'sept.',
  'oct.',
  'nov.',
  'déc.',
] as const;

/** '2026-09-15' → '15 sept.' (+ année si différente de l'année en cours) — présentation pure. */
function frShortDate(dateOnly: string): string {
  const [y, m, d] = dateOnly.split('-');
  if (y === undefined || m === undefined || d === undefined) return dateOnly;
  const month = FR_MONTHS_SHORT[Number(m) - 1] ?? m;
  return y === String(new Date().getFullYear())
    ? `${Number(d)} ${month}`
    : `${Number(d)} ${month} ${y}`;
}

/**
 * Rangée d'échéance fiscale : date FR courte, label, explain à la voix de Bob — JAMAIS de
 * montant (amountHint null en v1, P03/P23 les brancheront). Les échéances 'assumed'
 * (périodicité URSSAF / clôture inconnues) portent un badge discret « à confirmer ».
 */
function FiscalDeadlineRow({
  deadline,
  personality,
  last,
}: {
  deadline: FiscalDeadline;
  personality: Personality;
  last: boolean;
}) {
  const { colors } = useTheme();
  return (
    <View
      accessible
      accessibilityLabel={`${frShortDate(deadline.date)}, ${deadline.label}`}
      style={{
        flexDirection: 'row',
        alignItems: 'flex-start',
        gap: 12,
        paddingVertical: 11,
        ...(last ? {} : { borderBottomWidth: 1, borderBottomColor: colors.lineSoft }),
      }}
    >
      <View style={{ minWidth: 62 }}>
        <Text
          style={[
            font('label', 700),
            { fontSize: 13.5, color: colors.ink800, fontVariant: ['tabular-nums'] },
          ]}
        >
          {frShortDate(deadline.date)}
        </Text>
      </View>
      <View style={{ flex: 1 }}>
        <View style={{ flexDirection: 'row', alignItems: 'center', gap: 7 }}>
          <Text
            numberOfLines={2}
            style={[font('label', 600), { fontSize: 14, color: colors.ink800, flexShrink: 1 }]}
          >
            {deadline.label}
          </Text>
          {deadline.confidence === 'assumed' ? (
            <StatusBadge
              label={t('argent.upcomingAssumed', { personality }).toUpperCase()}
              variant="particulier"
            />
          ) : null}
        </View>
        <Text style={[font('meta'), { color: colors.slate500, marginTop: 2, lineHeight: 16 }]}>
          {deadline.explain}
        </Text>
      </View>
    </View>
  );
}

/** Barre de texte squelettée à hauteur de ligne EXACTE (boxHeight = lineHeight du texte réel) —
 *  la géométrie du row skeleton == celle du row final : zéro saut à l'arrivée des données. */
function SkeletonTextLine({
  width,
  barHeight = 14,
  boxHeight = 20,
}: {
  width: number | `${number}%`;
  barHeight?: number;
  boxHeight?: number;
}) {
  return (
    <View style={{ height: boxHeight, justifyContent: 'center' }}>
      <Skeleton width={width} height={barHeight} />
    </View>
  );
}

/** Skeleton d'une rangée du grand-livre — MÊME gabarit que MoneyRow (padding V 9, séparateur
 *  patterns.moneyRow.divider, lead avec icône 17, total padding-top 13 + montant 20). */
function SkeletonMoneyRow({
  variant = 'default',
  divider = true,
}: {
  variant?: 'default' | 'lead' | 'total';
  divider?: boolean;
}) {
  const isLead = variant === 'lead';
  const isTotal = variant === 'total';
  return (
    <View
      style={{
        flexDirection: 'row',
        alignItems: 'center',
        justifyContent: 'space-between',
        paddingVertical: 9,
        ...(isTotal ? { paddingTop: 13 } : {}),
        ...(divider ? { borderBottomWidth: 1, borderBottomColor: patterns.moneyRow.divider } : {}),
      }}
    >
      <View style={{ flexDirection: 'row', alignItems: 'center', gap: 7 }}>
        {isLead ? <Skeleton width={17} height={17} radius={5} /> : null}
        <SkeletonTextLine width={isLead ? 138 : 118} />
      </View>
      <SkeletonTextLine
        width={isTotal ? 92 : 72}
        barHeight={isTotal ? 18 : 15}
        boxHeight={isTotal ? 27 : 21}
      />
    </View>
  );
}

/** Skeleton d'une échéance fiscale — MÊME gabarit que FiscalDeadlineRow (padding V 11,
 *  colonne date 62, label + explain). */
function SkeletonDeadlineRow({ last = false }: { last?: boolean }) {
  const { colors } = useTheme();
  return (
    <View
      style={{
        flexDirection: 'row',
        alignItems: 'flex-start',
        gap: 12,
        paddingVertical: 11,
        ...(last ? {} : { borderBottomWidth: 1, borderBottomColor: colors.lineSoft }),
      }}
    >
      <View style={{ minWidth: 62 }}>
        <SkeletonTextLine width={50} barHeight={13} boxHeight={18} />
      </View>
      <View style={{ flex: 1, gap: 5 }}>
        <SkeletonTextLine width="58%" barHeight={13} boxHeight={18} />
        <SkeletonTextLine width="84%" barHeight={11} boxHeight={16} />
      </View>
    </View>
  );
}

/**
 * Astuce « première fois » (réf C11-frame-astuce.png) : carte centrée sur scrim,
 * voix de Bob, dismiss persisté. « Tout passer » = même dismiss tant que cet écran
 * porte le seul tip (TODO : registre de tips multi-écrans).
 */
function FirstTimeTip({ visible, onDismiss }: { visible: boolean; onDismiss: () => void }) {
  const { personality, colors, semantic, overlays } = useTheme();
  const reduceMotion = useReduceMotion();
  if (!visible) return null;
  return (
    <Modal
      transparent
      visible
      animationType={reduceMotion ? 'none' : 'fade'}
      statusBarTranslucent
      onRequestClose={onDismiss}
    >
      <View style={{ flex: 1, alignItems: 'center', justifyContent: 'center', padding: 26 }}>
        <Pressable
          accessibilityRole="button"
          accessibilityLabel={t('argent.tipSkip', { personality })}
          onPress={onDismiss}
          style={{
            position: 'absolute',
            top: 0,
            left: 0,
            right: 0,
            bottom: 0,
            backgroundColor: overlays.scrim,
          }}
        />
        <View
          style={{
            width: '100%',
            maxWidth: 318,
            backgroundColor: colors.surface,
            borderRadius: 22,
            paddingTop: 22,
            paddingHorizontal: 20,
            paddingBottom: 18,
            ...shadowNative.e3,
          }}
        >
          <View style={{ flexDirection: 'row', alignItems: 'center', gap: 10, marginBottom: 13 }}>
            <View
              style={{
                width: 38,
                height: 38,
                borderRadius: 13,
                backgroundColor: semantic.ai,
                alignItems: 'center',
                justifyContent: 'center',
              }}
            >
              <Ionicons name="sparkles" size={18} color={colors.surface} />
            </View>
            <View style={{ flex: 1 }}>
              <Text style={[font('eyebrow'), { fontSize: 10.5, color: semantic.ai }]}>
                {t('argent.tipEyebrow', { personality })}
              </Text>
              <Text style={[font('meta'), { color: colors.slate400, marginTop: 1 }]}>
                {t('argent.tipAuthor', { personality })}
              </Text>
            </View>
            <Pressable
              accessibilityRole="button"
              accessibilityLabel={t('argent.tipSkip', { personality })}
              onPress={onDismiss}
              hitSlop={10}
            >
              <Text style={[font('meta'), { color: colors.slate300 }]}>
                {t('argent.tipSkip', { personality })}
              </Text>
            </Pressable>
          </View>
          <Text style={[font('section'), { fontSize: 19, color: colors.ink800 }]}>
            {t('argent.tipTitle', { personality })}
          </Text>
          <Text
            style={[
              font('body'),
              { color: colors.slate500, lineHeight: 21, marginTop: 6, marginBottom: 15 },
            ]}
          >
            {t('argent.tipBody', { personality })}
          </Text>
          <Button
            title={t('argent.tipCta', { personality })}
            variant="primary"
            onPress={onDismiss}
          />
        </View>
      </View>
    </Modal>
  );
}

export default function Argent() {
  const { personality, colors, semantic } = useTheme();
  const bobScrollInsets = useBobAwareScrollInsets({ minimumBottom: 140 });
  const router = useRouter();
  const reduceMotion = useReduceMotion();
  const tip = useFirstTimeTip(TIP_KEY);
  // Press state des cartes navigables (micro-interaction) : opacité toujours, scale subtil
  // seulement hors reduce-motion — le feedback reste perceptible sans mouvement.
  const cardPressed = (pressed: boolean): ViewStyle =>
    pressed
      ? { opacity: 0.88, ...(reduceMotion ? {} : { transform: [{ scale: 0.98 }] }) }
      : {};
  // SPEC_EXPERT_FISCAL §UX FLOW amendement 1/2 : Argent = entrée PRIMAIRE du mini-flow (carte
  // douce sous le héros, visible seulement si ≥1 champ non confirmé) — voix parité stricte.
  const fiscalFlow = useFiscalProfileFlow();
  const [balanceSheetVisible, setBalanceSheetVisible] = useState(false);

  const [scenario, setScenario] = useState<Scenario>('realiste');
  const [horizonKey, setHorizonKey] = useState<HorizonKey>('30');
  const horizon = HORIZONS[horizonKey];

  // Prévision : la série complète des horizons du scénario courant (switch segments instantané,
  // et la note de tranche se dérive de la série entière — cashflowBand @bob/core).
  const cash7 = useCashflow(scenario, 7);
  const cash30 = useCashflow(scenario, 30);
  const cash60 = useCashflow(scenario, 60);
  const cash90 = useCashflow(scenario, 90);
  const forecastByHorizon = { 7: cash7, 30: cash30, 60: cash60, 90: cash90 } as const;
  const forecast = forecastByHorizon[horizon];

  // Héros « trésorerie mobilisable » : payout prudent 30 j (= « sans risque ») ; le « monter
  // à » = optimiste. Langage prudent (jamais « te verser ») — SPEC_EXPERT_FISCAL §V2 pt. 8.
  const heroSafe = useCashflow('prudent', 30);
  const heroUp = useCashflow('optimiste', 30);
  // Phase 1C : le langage (et, pour le micro confirmé, le montant) du héros s'adapte au profil
  // fiscal CONFIRMÉ — porte sur LE MÊME cashflow que celui affiché (prudent/30j), jamais un
  // scénario parallèle. Profil non confirmé → kind 'prudent' → mêmes clés qu'avant (zéro régression).
  const payGuidance = useOwnerPayGuidance(heroSafe.data);
  const guidance = payGuidance.guidance;

  // Grand-livre : les agrégats réels du client, dérivés en use case pur @bob/core.
  const invoices = useInvoices();
  const expenses = useExpenses();
  const entries = useAccountingEntries();
  const customers = useCustomers();
  // Audit correction 3 (timezone Argent) : le grand-livre/URSSAF ET la prévision de trésorerie
  // (useCashflow, cf. get-cashflow.ts) doivent raisonner sur le MÊME « aujourd'hui ». Décision :
  // le jour métier d'un artisan français = jour LOCAL Europe/Paris (même choix que le digest
  // hebdo, digest.service.ts) — ni le fuseau ambiant de l'appareil (dérive en déplacement / mauvaise
  // config), ni l'UTC brut serveur (en décalage ~1-2 h avec Paris juste après minuit local). Source
  // unique : parisDateOnly() (@bob/core, shared-kernel/time.ts), aussi utilisée par GetCashflow
  // côté serveur pour son `asOf`.
  const today = parisDateOnly();

  // C-EXP-UI2 : entrées ADDITIVES de buildLedgerView (C-EXP5c). La fiche société provient
  // exclusivement de GET /company/me ; absente, la ligne reste indisponible sans valeur inventée.
  // Encaissements datés : listPayments (socle E3). Données absentes → null honnête, inchangé.
  const companyMe = useCompanyMe();
  const payments = usePayments();
  const bankBalance = useLatestBankBalance();
  const ledgerCompany = companyMe.data;

  // DEUX nombres : le constaté (fait daté) et la position estimée. `null` = rien de plus à
  // montrer (pas d'observation, projection indisponible, ou aucun mouvement) → rendu inchangé.
  const cashPosition = useMemo(
    () => deriveCashPositionDisplay({ balance: bankBalance.data, personality }),
    [bankBalance.data, personality],
  );
  // Le grand-livre part de la POSITION ESTIMÉE, comme la projection serveur : le laisser sur le
  // solde brut aurait rejoué ICI le bug d'origine (« Disponible prudent » figé après encaissement).
  const ledgerBankBalanceCents = cashPosition?.estimatedCents ?? bankBalance.data?.amountCents;

  const ledger = useMemo(
    () =>
      buildLedgerView({
        invoices: invoices.data,
        expenses: expenses.data,
        accountingEntries: entries.data,
        bankBalanceCents: ledgerBankBalanceCents,
        // Company micro + paiements datés + date du jour → cotisationsCents RÉEL (négatif),
        // « Disponible prudent » teinté d'autant, et ledger.urssaf = la déclaration pré-calculée.
        // TODO C-EXP-UI2 v2 : buildLedgerView ne propage pas encore acre/dateCreation vers
        // deriveUrssafProvision (LedgerCompanyData ne les porte pas) → provision au taux plein
        // pour un bénéficiaire ACRE = sur-provision prudente, jamais l'inverse. À brancher core.
        company: ledgerCompany,
        payments: payments.data,
        asOf: today,
      }),
    [
      invoices.data,
      expenses.data,
      entries.data,
      ledgerBankBalanceCents,
      ledgerCompany,
      payments.data,
      today,
    ],
  );
  const ledgerLoading =
    invoices.isLoading ||
    expenses.isLoading ||
    entries.isLoading ||
    companyMe.isLoading ||
    payments.isLoading ||
    bankBalance.isLoading;

  // La balance âgée dépend de DEUX réponses autoritatives. Une facture chargée sans son client
  // ne doit jamais devenir une ligne sans nom, et un carnet chargé sans les factures ne doit
  // jamais devenir un faux état « aucun retard » pendant le démarrage.
  const agedLoading = invoices.isLoading || customers.isLoading;

  // C-EXP-UI1 : échéancier fiscal 90 j — dates dérivées de la fiche société, aucun montant en v1.
  const fiscal = useFiscalCalendar();

  // E5 : balance âgée clients (deriveAgedBalance @bob/core — même vérité pour Bob).
  const aged = useMemo(
    () =>
      deriveAgedBalance({ invoices: invoices.data ?? [], customers: customers.data ?? [], today }),
    [invoices.data, customers.data, today],
  );

  const overdueCustomers = useMemo(() => {
    const byId = new Map((customers.data ?? []).map((customer) => [customer.id, customer]));
    return aged.byCustomer
      .map((line) => ({
        customer: byId.get(line.customerId),
        overdueCents:
          line.buckets.d1_30 + line.buckets.d31_60 + line.buckets.d61_90 + line.buckets.d90_plus,
        maxDaysLate: line.maxDaysLate,
      }))
      .filter(
        (
          entry,
        ): entry is {
          customer: NonNullable<typeof entry.customer>;
          overdueCents: number;
          maxDaysLate: number;
        } => entry.customer !== undefined && entry.overdueCents > 0,
      )
      .sort((left, right) => right.overdueCents - left.overdueCents);
  }, [aged.byCustomer, customers.data]);

  const series: CashflowSeriesPoint[] = [];
  if (cash7.data) series.push({ horizon: 7, projection: cash7.data });
  if (cash30.data) series.push({ horizon: 30, projection: cash30.data });
  if (cash60.data) series.push({ horizon: 60, projection: cash60.data });
  if (cash90.data) series.push({ horizon: 90, projection: cash90.data });
  const band = cashflowBand(series, horizon);
  const bandTone = band === 'creux' ? semantic.warning : semantic.success;

  // « À surveiller » : factures réellement échues, triées par reste dû échu.
  const risky = overdueCustomers;
  const topRisk = risky[0];

  const balanceNeedsConfirmation =
    bankBalance.isError && isBankBalanceQualificationError(bankBalance.error);
  const cashflowNeedsBalance = [cash7, cash30, cash60, cash90, heroSafe, heroUp].every(
    (query) => query.isError && isCashflowBankingInputMissing(query.error),
  );
  const cashflowHasError =
    cash7.isError ||
    cash30.isError ||
    cash60.isError ||
    cash90.isError ||
    heroSafe.isError ||
    heroUp.isError;
  const hasError =
    (!cashflowNeedsBalance && cashflowHasError) ||
    (bankBalance.isError && !balanceNeedsConfirmation) ||
    invoices.isError ||
    expenses.isError ||
    entries.isError ||
    customers.isError ||
    companyMe.isError ||
    payments.isError ||
    fiscal.isError ||
    fiscalFlow.isError ||
    payGuidance.isError;

  // Un refetch peut échouer tout en laissant une photographie serveur antérieure dans le cache :
  // elle reste une donnée réelle et l'écran l'affiche avec la bannière d'erreur ci-dessous. En
  // revanche, si une source n'a JAMAIS répondu, aucune agrégation partielle/`[]`/zéro ne doit être
  // rendue comme une vérité financière. L'écran devient alors intégralement fail-closed.
  const fatalDataError =
    hasBlockingAuthoritativeDataError([
      { isError: cash7.isError && !isCashflowBankingInputMissing(cash7.error), data: cash7.data },
      {
        isError: cash30.isError && !isCashflowBankingInputMissing(cash30.error),
        data: cash30.data,
      },
      {
        isError: cash60.isError && !isCashflowBankingInputMissing(cash60.error),
        data: cash60.data,
      },
      {
        isError: cash90.isError && !isCashflowBankingInputMissing(cash90.error),
        data: cash90.data,
      },
      {
        isError: heroSafe.isError && !isCashflowBankingInputMissing(heroSafe.error),
        data: heroSafe.data,
      },
      {
        isError: heroUp.isError && !isCashflowBankingInputMissing(heroUp.error),
        data: heroUp.data,
      },
      invoices,
      expenses,
      entries,
      customers,
      companyMe,
      payments,
      fiscal,
      { isError: fiscalFlow.isError, data: fiscalFlow.profile },
    ]) ||
    (bankBalance.isError && bankBalance.data === undefined && !balanceNeedsConfirmation);
  const agentDataReady =
    !fatalDataError &&
    cash7.data !== undefined &&
    cash30.data !== undefined &&
    cash60.data !== undefined &&
    cash90.data !== undefined &&
    heroSafe.data !== undefined &&
    heroUp.data !== undefined &&
    invoices.data !== undefined &&
    expenses.data !== undefined &&
    entries.data !== undefined &&
    customers.data !== undefined &&
    companyMe.data !== undefined &&
    payments.data !== undefined &&
    fiscal.data !== undefined &&
    fiscalFlow.profile !== undefined &&
    (bankBalance.data !== undefined || balanceNeedsConfirmation);

  // Bob voit exactement les clients avec une facture échue affichés à l'écran. Si UNE source
  // indispensable n'a jamais répondu, l'écran est une page de récupération : aucune capacité
  // financière ni affordance fiscale ne doit rester active derrière elle.
  const agentContext = useMemo<AgentContext>(() => {
    const watchlist = overdueCustomers.slice(0, 8);
    return {
      screen: { name: 'argent', instanceId: 'argent' },
      entities: agentDataReady
        ? watchlist.map(({ customer }) => ({
            type: 'customer' as const,
            id: customer.id,
            label: customer.name,
          }))
        : [],
      capabilities: agentDataReady ? ['screen.read', 'cashflow.read', 'customer.read'] : [],
    };
  }, [agentDataReady, overdueCustomers]);
  // Surface MÉMOÏSÉE — mêmes raisons qu'Accueil : un littéral inline ferait boucler le rendu.
  const argentAgentSurface = useMemo<AgentSurface>(
    () => ({ affordances: agentDataReady ? fiscalFlow.voiceAffordances : [] }),
    [agentDataReady, fiscalFlow.voiceAffordances],
  );
  usePublishAgentContext(agentContext, undefined, argentAgentSurface);

  const refetchMainData = (): void => {
    for (const query of [
      cash7,
      cash30,
      cash60,
      cash90,
      heroSafe,
      heroUp,
      invoices,
      expenses,
      entries,
      customers,
      companyMe,
      payments,
      bankBalance,
      fiscal,
    ]) {
      void query.refetch();
    }
    void fiscalFlow.refetch();
  };

  // Audit correction 2 : seul échappatoire manuel de l'écran avant ce correctif — même geste
  // que Aujourd'hui (index.tsx), sur les mêmes queries que refetchMainData (ErrorRetry).
  const refreshing =
    cash7.isRefetching ||
    cash30.isRefetching ||
    cash60.isRefetching ||
    cash90.isRefetching ||
    heroSafe.isRefetching ||
    heroUp.isRefetching ||
    invoices.isRefetching ||
    expenses.isRefetching ||
    entries.isRefetching ||
    customers.isRefetching ||
    companyMe.isRefetching ||
    payments.isRefetching ||
    bankBalance.isRefetching ||
    fiscal.isRefetching ||
    fiscalFlow.isRefetching;

  // Premier chargement : tant qu'UNE source autoritative n'a pas fini son premier fetch,
  // l'écran reste en SKELETONS — le message d'erreur n'apparaît JAMAIS pendant cette phase
  // (grille fondateur : « pourquoi pas de skeletons ? »). isLoading ne couvre que le premier
  // fetch (jamais les refetchs) : aucune source ne peut maintenir cet état indéfiniment.
  const initialSourcesLoading =
    ledgerLoading ||
    agedLoading ||
    cash7.isLoading ||
    cash30.isLoading ||
    cash60.isLoading ||
    cash90.isLoading ||
    heroSafe.isLoading ||
    heroUp.isLoading ||
    fiscal.isLoading ||
    fiscalFlow.isLoading ||
    payGuidance.isLoading;

  // Compte NEUF (post-onboarding) : toutes les sources ont répondu et sont VIDES — l'écran
  // devient une invitation (solde à confirmer, premier devis), jamais un désert de « — ».
  const accountEmpty =
    invoices.data?.length === 0 &&
    expenses.data?.length === 0 &&
    entries.data?.length === 0 &&
    customers.data?.length === 0 &&
    payments.data?.length === 0;
  const showWelcome =
    accountEmpty === true && !initialSourcesLoading && !fatalDataError && !hasError;

  if (fatalDataError && !initialSourcesLoading) {
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
              onRefresh={refetchMainData}
              tintColor={colors.ink800}
              colors={[colors.ink800]}
            />
          }
        >
          <InnerScreenHeader
            eyebrow={t('argent.eyebrow', { personality })}
            title={t('argent.title', { personality })}
            subtitle={t('argent.subtitle', { personality })}
          />
          <View style={{ paddingHorizontal: 18, paddingTop: 16 }}>
            <ErrorRetry
              message={t('argent.dataError', { personality })}
              onRetry={refetchMainData}
              retrying={refreshing}
            />
          </View>
        </ScrollView>
      </View>
    );
  }

  // Phrase conditionnelle du héros : upside réel (optimiste > prudent) + le retardataire réel —
  // RÉSERVÉE au profil non confirmé ('prudent', mêmes clés qu'avant cette phase). Un profil
  // CONFIRMÉ (micro/salarié/TNS) affiche le langage adapté à sa situation à la place (Phase 1C) :
  // mélanger « upside optimiste » et « cotisations mises de côté » diluerait le message honnête.
  const heroCaption =
    (!guidance || guidance.kind === 'prudent') &&
    heroSafe.data &&
    heroUp.data &&
    topRisk &&
    heroUp.data.payout > heroSafe.data.payout
      ? t('argent.heroUpside', {
          personality,
          params: {
            upTo: formatEUR(heroUp.data.payout),
            name: topRisk.customer.name,
            amount: formatEUR(topRisk.overdueCents),
          },
        })
      : guidance
        ? t(guidance.captionKey as I18nKey, { personality, params: guidance.params })
        : t('argent.heroCaption', { personality });

  const horizonOptions = HORIZON_KEYS.map((key) => ({
    key,
    label: t('argent.horizonLabel', { personality, params: { days: key } }),
  }));
  const scenarioOptions = (Object.keys(SCENARIO_LABEL) as Scenario[]).map((key) => ({
    key,
    label: t(SCENARIO_LABEL[key], { personality }),
  }));

  return (
    <View style={{ flex: 1, backgroundColor: colors.bg }}>
      <TabsScrollView
        style={{ flex: 1 }}
        contentContainerStyle={{ paddingBottom: bobScrollInsets.paddingBottom }}
        scrollIndicatorInsets={{ bottom: bobScrollInsets.scrollIndicatorBottom }}
        automaticallyAdjustKeyboardInsets={bobScrollInsets.automaticallyAdjustKeyboardInsets}
        refreshControl={
          <RefreshControl
            refreshing={refreshing}
            onRefresh={refetchMainData}
            tintColor={colors.ink800}
            colors={[colors.ink800]}
          />
        }
      >
        <InnerScreenHeader
          eyebrow={t('argent.eyebrow', { personality })}
          title={t('argent.title', { personality })}
          subtitle={t('argent.subtitle', { personality })}
        />

        <View style={{ paddingHorizontal: 18 }}>
          {/* ── Héros « trésorerie mobilisable » ────────────────────────────── */}
          <View style={{ marginTop: 16 }}>
            {heroSafe.data && !payGuidance.isLoading ? (
              <FadeIn index={0}>
                <HeroMoneyCard
                  label={
                    guidance
                      ? t(guidance.headlineKey as I18nKey, { personality, params: guidance.params })
                      : t('argent.heroLabel', { personality })
                  }
                  amountCents={guidance?.amountCents ?? heroSafe.data.payout}
                  pill={t('argent.heroPill', { personality })}
                  caption={heroCaption}
                />
              </FadeIn>
            ) : (
              <HeroPlaceholder loading={heroSafe.isLoading || payGuidance.isLoading} />
            )}
          </View>

          {/* ── Compte NEUF : invitation (jamais un désert de « — ») — le CTA solde remplace
              la carte « confirme ton solde » (même geste, hiérarchie soignée). ─────────── */}
          {showWelcome ? (
            <FadeIn index={1} style={{ marginTop: 14 }}>
              <Card radius={22} padding={20} elevation="e2">
                <View style={{ flexDirection: 'row', alignItems: 'center', gap: 12 }}>
                  <IconTile tone="success" size={44} radius={14}>
                    <Ionicons name="sparkles" size={20} color={semantic.success} />
                  </IconTile>
                  <View style={{ flex: 1, minWidth: 0 }}>
                    <Text style={[font('section'), { fontSize: 18, color: colors.ink800 }]}>
                      {t('argent.emptyTitle', { personality })}
                    </Text>
                  </View>
                </View>
                <Text
                  style={[
                    font('body'),
                    { color: colors.slate500, lineHeight: 21, marginTop: 10 },
                  ]}
                >
                  {t('argent.emptyBody', { personality })}
                </Text>
                <View style={{ gap: 10, marginTop: 16 }}>
                  {bankBalance.data === undefined ? (
                    <Button
                      title={t('argent.emptyCtaBalance', { personality })}
                      variant="primary"
                      onPress={() => setBalanceSheetVisible(true)}
                    />
                  ) : null}
                  <Button
                    title={t('argent.emptyCtaQuote', { personality })}
                    variant={bankBalance.data === undefined ? 'secondary' : 'primary'}
                    onPress={() => router.push('/devis/new')}
                  />
                </View>
              </Card>
            </FadeIn>
          ) : balanceNeedsConfirmation ? (
            <Card radius={18} padding={15} style={{ marginTop: 14 }}>
              <View style={{ flexDirection: 'row', alignItems: 'flex-start', gap: 11 }}>
                <IconTile tone="b2b" size={36} radius={11}>
                  <Feather name="credit-card" size={17} color={semantic.b2b} />
                </IconTile>
                <View style={{ flex: 1, minWidth: 0 }}>
                  <Text style={[font('cardTitle'), { fontSize: 15, color: colors.ink800 }]}>
                    {t('argent.balanceNeededTitle', { personality })}
                  </Text>
                  <Text
                    style={[font('meta'), { color: colors.slate500, lineHeight: 18, marginTop: 4 }]}
                  >
                    {t('argent.balanceNeededBody', { personality })}
                  </Text>
                  <View style={{ marginTop: 12 }}>
                    <Button
                      title={t('argent.balanceNeededCta', { personality })}
                      variant="primary"
                      onPress={() => setBalanceSheetVisible(true)}
                    />
                  </View>
                </View>
              </View>
            </Card>
          ) : bankBalance.data && cashPosition ? (
            /* ── Position de trésorerie : DEUX nombres ─────────────────────────
               L'estimé est le héros, le CONSTATÉ DATÉ reste juste dessous, et l'écart est
               expliqué ligne par ligne (+entrées / −sorties). C'est exactement ce qui manquait
               au fondateur : le solde figé était honnête, il lui manquait sa moitié estimée. */
            <FadeIn index={1}>
              <Card radius={18} padding={16} style={{ marginTop: 12 }}>
                <View style={{ flexDirection: 'row', alignItems: 'flex-start', gap: 12 }}>
                  <IconTile tone="success" size={38} radius={12}>
                    <Feather name="trending-up" size={17} color={semantic.success} />
                  </IconTile>
                  <View style={{ flex: 1, minWidth: 0 }}>
                    <Text style={[font('eyebrow'), { color: colors.slate400 }]}>
                      {t('argent.positionEstimatedLabel', { personality })}
                    </Text>
                    <View style={{ marginTop: 2 }}>
                      <MoneyText cents={cashPosition.estimatedCents} variant="big" />
                    </View>
                    {/* Le FAIT, daté : il ne disparaît jamais derrière l'estimation. */}
                    <Text
                      style={[font('meta'), { color: colors.slate500, marginTop: 5, lineHeight: 17 }]}
                    >
                      {cashPosition.observedLabel}
                    </Text>
                  </View>
                </View>

                {/* Le détail qui explique l'écart — accessible sans quitter l'écran. */}
                <View
                  style={{
                    marginTop: 12,
                    paddingTop: 11,
                    borderTopWidth: 1,
                    borderTopColor: colors.lineSoft,
                    gap: 6,
                  }}
                >
                  <Text style={[font('meta'), { color: colors.ink600, lineHeight: 17 }]}>
                    {cashPosition.movementsLabel}
                  </Text>
                  <Text style={[font('meta'), { color: colors.slate400, lineHeight: 17 }]}>
                    {t('argent.positionEstimateNote', { personality })}
                  </Text>
                </View>

                <Pressable
                  accessibilityRole="button"
                  accessibilityLabel={t('argent.balanceRefreshCta', { personality })}
                  onPress={() => setBalanceSheetVisible(true)}
                  hitSlop={10}
                  style={{ minHeight: 44, justifyContent: 'center', marginTop: 4 }}
                >
                  <Text style={[font('label', 700), { color: colors.ink600 }]}>
                    {t('argent.balanceRefreshCta', { personality })}
                  </Text>
                </Pressable>
              </Card>
            </FadeIn>
          ) : bankBalance.data ? (
            /* Aucun mouvement depuis l'observation (ou projection indisponible) : l'estimé
               égalerait le constaté — le rendu historique reste, à l'identique. */
            <Card radius={16} padding={13} style={{ marginTop: 12 }}>
              <View style={{ flexDirection: 'row', alignItems: 'center', gap: 10 }}>
                <Feather name="check-circle" size={17} color={semantic.success} />
                <Text style={[font('meta'), { color: colors.slate500, flex: 1 }]}>
                  {t('argent.balanceObserved', { personality })}
                </Text>
                <Pressable
                  accessibilityRole="button"
                  accessibilityLabel={t('argent.balanceRefreshCta', { personality })}
                  onPress={() => setBalanceSheetVisible(true)}
                  hitSlop={10}
                  style={{ minHeight: 44, justifyContent: 'center' }}
                >
                  <Text style={[font('label', 700), { color: colors.ink600 }]}>
                    {t('argent.balanceRefreshCta', { personality })}
                  </Text>
                </Pressable>
              </View>
            </Card>
          ) : null}

          {hasError ? (
            <View style={{ marginTop: 14 }}>
              <ErrorRetry
                message={t('argent.dataError', { personality })}
                onRetry={refetchMainData}
                retrying={refreshing}
              />
            </View>
          ) : null}

          {/* ── Entrée mini-flow profil fiscal (amendement 1/2 : carte douce, jamais
              « exacte »/« 3 questions », visible seulement si ≥1 champ non confirmé) ──── */}
          {fiscalFlow.hasPending ? (
            <Pressable
              accessibilityRole="button"
              accessibilityLabel={`${t('fiscal.entry.title', { personality })}. ${t('fiscal.entry.body', { personality })}`}
              onPress={fiscalFlow.openFlow}
              style={({ pressed }) => [{ marginTop: 14 }, cardPressed(pressed)]}
            >
              <Card radius={18} padding={15}>
                <View style={{ flexDirection: 'row', alignItems: 'center', gap: 11 }}>
                  <IconTile tone="b2g" size={34} radius={11}>
                    <Ionicons name="sparkles" size={16} color={semantic.b2g} />
                  </IconTile>
                  <View style={{ flex: 1, minWidth: 0 }}>
                    <Text style={{ ...font('cardTitle'), fontSize: 14.5, color: colors.ink800 }}>
                      {t('fiscal.entry.title', { personality })}
                    </Text>
                    <Text
                      style={[
                        font('meta'),
                        { color: colors.slate400, marginTop: 2, lineHeight: 16 },
                      ]}
                    >
                      {t('fiscal.entry.body', { personality })}
                    </Text>
                  </View>
                  <Feather name="chevron-right" size={16} color={colors.slate400} />
                </View>
              </Card>
            </Pressable>
          ) : null}

          {/* ── Grand-livre « LE SOLDE MENT » ───────────────────────────────── */}
          <Card radius={22} padding={18} elevation="e2" style={{ marginTop: 14 }}>
            <View
              style={{
                flexDirection: 'row',
                alignItems: 'center',
                justifyContent: 'space-between',
                marginBottom: 6,
              }}
            >
              <Text style={[font('cardTitle'), { color: colors.ink800 }]}>
                {t('argent.ledgerTitle', { personality })}
              </Text>
              <StatusBadge
                label={t('argent.soldeMent', { personality }).toUpperCase()}
                variant="particulier"
              />
            </View>
            {ledgerLoading ? (
              <>
                <SkeletonMoneyRow variant="lead" />
                <SkeletonMoneyRow />
                <SkeletonMoneyRow />
                <SkeletonMoneyRow />
                <SkeletonMoneyRow />
                <SkeletonMoneyRow variant="total" divider={false} />
              </>
            ) : (
              <FadeIn index={1}>
                {ledger.bankCents !== null ? (
                  <MoneyRow
                    label={t('argent.rowBank', { personality })}
                    amountCents={ledger.bankCents}
                    variant="lead"
                    icon={<Feather name="credit-card" size={17} color={colors.ink600} />}
                  />
                ) : (
                  <EmptyMoneyRow label={t('argent.rowBank', { personality })} variant="lead" />
                )}
                {ledger.receivablesCents !== null ? (
                  <MoneyRow
                    label={t('argent.rowReceivables', { personality })}
                    amountCents={ledger.receivablesCents}
                  />
                ) : (
                  <EmptyMoneyRow label={t('argent.rowReceivables', { personality })} />
                )}
                {ledger.chargesCents !== null ? (
                  <MoneyRow
                    label={t('argent.rowCharges', { personality })}
                    amountCents={ledger.chargesCents}
                  />
                ) : (
                  <EmptyMoneyRow label={t('argent.rowCharges', { personality })} />
                )}
                {ledger.vatCents !== null ? (
                  <MoneyRow
                    label={t('argent.rowVat', { personality })}
                    amountCents={ledger.vatCents}
                  />
                ) : (
                  <EmptyMoneyRow label={t('argent.rowVat', { personality })} />
                )}
                {/* Cotisations : provision URSSAF calculée pour une company micro à partir de
                    company+payments+asOf ; les autres situations restent indisponibles. */}
                {ledger.cotisationsCents !== null ? (
                  <MoneyRow
                    label={t('argent.rowCotisations', { personality })}
                    amountCents={ledger.cotisationsCents}
                  />
                ) : (
                  <EmptyMoneyRow label={t('argent.rowCotisations', { personality })} />
                )}
                {ledger.totalCents !== null ? (
                  <MoneyRow
                    label={t('argent.rowTotal', { personality })}
                    amountCents={ledger.totalCents}
                    variant="total"
                    divider={false}
                  />
                ) : (
                  <EmptyMoneyRow
                    label={t('argent.rowTotal', { personality })}
                    variant="total"
                    divider={false}
                  />
                )}
              </FadeIn>
            )}
          </Card>

          {/* ── Déclaration URSSAF pré-calculée (C-EXP-UI2 — doctrine « Bob FAIT ») ──
              Visible seulement quand le moteur a parlé (company micro + paiements datés) :
              période + montant + explain voix Bob (calculés dans @bob/core, jamais ici) +
              échéance. État absent → RIEN (pas de carte vide). */}
          {ledger.urssaf !== null ? (
            <Card radius={20} padding={16} elevation="e2" style={{ marginTop: 14 }}>
              <View
                style={{
                  flexDirection: 'row',
                  alignItems: 'center',
                  justifyContent: 'space-between',
                  gap: 8,
                }}
              >
                <Text
                  numberOfLines={1}
                  style={[
                    font('cardTitle'),
                    { fontSize: 15.5, color: colors.ink800, flexShrink: 1 },
                  ]}
                >
                  {t('argent.urssafTitle', {
                    personality,
                    params: { period: ledger.urssaf.periodLabel },
                  })}
                </Text>
                {/* Hypothèse posée (périodicité inconnue / catégorie dérivée) → même badge
                    honnête que l'échéancier C-EXP-UI1. */}
                {ledger.urssaf.confidence === 'assumed' ? (
                  <StatusBadge
                    label={t('argent.upcomingAssumed', { personality }).toUpperCase()}
                    variant="particulier"
                  />
                ) : null}
              </View>
              <Text
                style={[font('meta'), { fontSize: 11.5, color: colors.slate400, marginTop: 10 }]}
              >
                {t('argent.urssafSetAside', { personality })}
              </Text>
              <View style={{ marginTop: 2 }}>
                <MoneyText cents={ledger.urssaf.provisionCents} variant="big" />
              </View>
              <Text
                style={[font('meta'), { color: colors.slate500, marginTop: 8, lineHeight: 17 }]}
              >
                {ledger.urssaf.explain}
              </Text>
              <Text
                style={[
                  font('label', 600),
                  { fontSize: 12.5, color: colors.ink800, marginTop: 10 },
                ]}
              >
                {t('argent.urssafDeclareBy', {
                  personality,
                  params: { date: frShortDate(ledger.urssaf.declareBy) },
                })}
              </Text>
            </Card>
          ) : null}

          {/* ── B5 — Retenue de garantie à récupérer (loi 71-584) : créance SUIVIE du tenant,
               dérivée des factures émises porteuses — la carte se tait sans retenue. ── */}
          <View style={{ marginTop: 14 }}>
            <RetenueSuiviCard />
          </View>

          {/* ── Prévision de tréso (scénarios × horizons LIVE) ──────────────── */}
          <Card radius={22} padding={16} elevation="e2" style={{ marginTop: 14 }}>
            <Text style={[font('cardTitle'), { color: colors.ink800 }]}>
              {t('argent.forecastTitle', { personality })}
            </Text>
            <View
              style={{
                flexDirection: 'row',
                alignItems: 'baseline',
                gap: 8,
                marginTop: 2,
                minHeight: 28,
              }}
            >
              {forecast.data ? (
                <FadeIn
                  index={2}
                  style={{ flexDirection: 'row', alignItems: 'baseline', gap: 8 }}
                >
                  <MoneyText cents={forecast.data.available} variant="big" color={bandTone} />
                  {band !== null ? (
                    <Text style={[font('meta'), { fontSize: 12.5, color: bandTone }]}>
                      {t(BAND_LABEL[band], { personality })}
                    </Text>
                  ) : null}
                </FadeIn>
              ) : forecast.isLoading ? (
                <Skeleton width="38%" height={21} radius={7} />
              ) : (
                <Text style={{ ...font('bigNum'), color: colors.slate400 }}>—</Text>
              )}
            </View>
            <View style={{ marginTop: 12, marginBottom: 10 }}>
              <SegmentedControl
                options={horizonOptions}
                value={horizonKey}
                onChange={setHorizonKey}
                accessibilityLabel={t('argent.forecastTitle', { personality })}
              />
            </View>
            <SegmentedControl
              options={scenarioOptions}
              value={scenario}
              onChange={setScenario}
              accessibilityLabel={t('argent.forecastTitle', { personality })}
            />
            {forecast.data ? (
              <View
                accessibilityRole="summary"
                style={{
                  marginTop: 12,
                  paddingTop: 11,
                  borderTopWidth: 1,
                  borderTopColor: colors.lineSoft,
                }}
              >
                <Text style={[font('meta'), { color: colors.slate500, lineHeight: 17 }]}>
                  {forecast.data.basis.kind === 'dated_documents'
                    ? t('argent.forecastBasisDated', {
                        personality,
                        params: {
                          date: frShortDate(forecast.data.basis.horizonEnd),
                          rate: forecast.data.basis.receivableCollectionRatePct,
                        },
                      })
                    : t('argent.forecastBasisLegacy', { personality })}
                </Text>
                {forecast.data.basis.kind === 'dated_documents' &&
                forecast.data.basis.receivablesUndatedCents > 0 ? (
                  <Text
                    style={[font('meta'), { color: colors.slate400, lineHeight: 17, marginTop: 4 }]}
                  >
                    {t('argent.forecastUndatedReceivables', {
                      personality,
                      params: { amount: formatEUR(forecast.data.basis.receivablesUndatedCents) },
                    })}
                  </Text>
                ) : null}
                {forecast.data.basis.kind === 'dated_documents' &&
                forecast.data.basis.chargesUndatedIncludedCents > 0 ? (
                  <Text
                    style={[font('meta'), { color: colors.slate400, lineHeight: 17, marginTop: 4 }]}
                  >
                    {t('argent.forecastUndatedCharges', {
                      personality,
                      params: {
                        amount: formatEUR(forecast.data.basis.chargesUndatedIncludedCents),
                      },
                    })}
                  </Text>
                ) : null}
              </View>
            ) : null}
          </Card>

          {/* ── À surveiller (liste risques si données) ─────────────────────── */}
          {agedLoading ? (
            <View style={{ marginTop: 18 }}>
              <SectionHeader title={t('argent.watchTitle', { personality })} />
              <Card>
                <SkeletonMoneyRow divider={false} />
              </Card>
            </View>
          ) : risky.length > 0 ? (
            <View style={{ marginTop: 18 }}>
              <SectionHeader title={t('argent.watchTitle', { personality })} />
              <FadeIn index={3} style={{ gap: 11 }}>
                {risky.slice(0, 3).map(({ customer, overdueCents, maxDaysLate }) => (
                  <Card key={customer.id} radius={18} padding={14}>
                    <View style={{ flexDirection: 'row', alignItems: 'center', gap: 11 }}>
                      <Avatar name={customer.name} size={38} shape="squircle" />
                      <View style={{ flex: 1 }}>
                        <View style={{ flexDirection: 'row', alignItems: 'center', gap: 7 }}>
                          <Text
                            numberOfLines={1}
                            style={[
                              font('button'),
                              { fontSize: 14.5, color: colors.ink800, flexShrink: 1 },
                            ]}
                          >
                            {customer.name}
                          </Text>
                          <StatusBadge
                            label={t('argent.watchLateBadge', { personality }).toUpperCase()}
                            variant="danger"
                          />
                        </View>
                        <Text
                          style={[
                            font('meta'),
                            { fontSize: 12.5, color: colors.slate400, marginTop: 1 },
                          ]}
                        >
                          {t('argent.watchOutstanding', {
                            personality,
                            params: { amount: formatEUR(overdueCents) },
                          })}
                          {maxDaysLate > 0 ? ` · ${maxDaysLate} j` : ''}
                        </Text>
                      </View>
                    </View>
                  </Card>
                ))}
                <Button
                  title={
                    risky.length === 1
                      ? t('argent.ctaRelanceOne', { personality })
                      : t('argent.ctaRelanceMany', { personality, params: { count: risky.length } })
                  }
                  variant="primary"
                  radius={15}
                  icon={<Ionicons name="sparkles" size={16} color={colors.surface} />}
                  // ?prompt=relance : l'assistant pré-remplit ET soumet la demande (C15).
                  onPress={() =>
                    router.push({ pathname: '/(tabs)/assistant', params: { prompt: 'relance' } })
                  }
                />
              </FadeIn>
            </View>
          ) : null}

          {/* ── À mettre de côté (réserve TVA + charges dérivée) ────────────── */}
          <Card
            radius={20}
            padding={16}
            style={{ marginTop: 16, backgroundColor: semantic.successBg }}
          >
            <Text style={[font('cardTitle'), { fontSize: 15.5, color: colors.ink800 }]}>
              {t('argent.reserveTitle', { personality })}
            </Text>
            <Text
              style={[font('label'), { fontWeight: '500', color: colors.slate500, marginTop: 3 }]}
            >
              {t('argent.reserveBody', { personality })}
            </Text>
            <View style={{ flexDirection: 'row', gap: 10, marginTop: 14 }}>
              {(
                [
                  { key: 'argent.reserveVat', cents: ledger.reserve.vatCents },
                  { key: 'argent.reserveCharges', cents: ledger.reserve.chargesCents },
                ] as const
              ).map(({ key, cents }) => (
                <View
                  key={key}
                  style={{
                    flex: 1,
                    backgroundColor: colors.surface,
                    borderRadius: 13,
                    paddingVertical: 11,
                    paddingHorizontal: 12,
                  }}
                >
                  <Text style={[font('meta'), { fontSize: 11.5, color: colors.slate400 }]}>
                    {t(key, { personality })}
                  </Text>
                  {ledgerLoading ? (
                    <View style={{ marginTop: 6 }}>
                      <Skeleton width="55%" height={17} />
                    </View>
                  ) : (
                    <Text
                      style={[
                        font('cardTitle'),
                        {
                          fontSize: 17,
                          color: cents !== null ? semantic.success : colors.slate400,
                          fontVariant: ['tabular-nums'],
                          marginTop: 1,
                        },
                      ]}
                    >
                      {cents !== null ? formatEUR(cents) : '—'}
                    </Text>
                  )}
                </View>
              ))}
            </View>
          </Card>

          {/* ── Balance âgée clients (E5 — deriveAgedBalance @bob/core) ─────── */}
          <View style={{ marginTop: 20 }}>
            <SectionHeader
              title={t('argent.agedTitle', { personality })}
              {...(aged.totalCents !== 0
                ? {
                    action: (
                      <Text
                        style={{
                          ...font('label'),
                          color: colors.ink800,
                          fontVariant: ['tabular-nums'],
                        }}
                      >
                        {formatEUR(aged.totalCents)}
                      </Text>
                    ),
                  }
                : {})}
            />
            {agedLoading ? (
              <Card>
                <Skeleton width="62%" height={15} />
              </Card>
            ) : aged.totalCents === 0 ? (
              <Card>
                <Text style={[font('sub'), { color: colors.slate500, lineHeight: 19 }]}>
                  {t('argent.agedEmpty', { personality })}
                </Text>
              </Card>
            ) : (
              <Card radius={18} padding={0} style={{ paddingHorizontal: 16, paddingVertical: 4 }}>
                {(
                  [
                    ['not_due', 'argent.agedNotDue'],
                    ['d1_30', 'argent.aged1_30'],
                    ['d31_60', 'argent.aged31_60'],
                    ['d61_90', 'argent.aged61_90'],
                    ['d90_plus', 'argent.aged90'],
                    ['unknown', 'argent.agedUnknown'],
                  ] as const satisfies readonly (readonly [AgedBucketKey, I18nKey])[]
                )
                  .filter(([bucket]) => aged.buckets[bucket] !== 0)
                  .map(([bucket, labelKey]) => (
                    <View
                      key={bucket}
                      style={{
                        flexDirection: 'row',
                        alignItems: 'center',
                        justifyContent: 'space-between',
                        gap: 12,
                        paddingVertical: 11,
                        borderBottomWidth: 1,
                        borderBottomColor: colors.lineSoft,
                      }}
                    >
                      <Text
                        style={[
                          font('sub'),
                          { color: bucket === 'd90_plus' ? semantic.dangerVivid : colors.slate500 },
                        ]}
                      >
                        {t(labelKey, { personality })}
                      </Text>
                      <Text
                        style={{
                          ...font('sub', 700),
                          color:
                            bucket === 'not_due' || bucket === 'unknown'
                              ? colors.ink800
                              : bucket === 'd90_plus'
                                ? semantic.dangerVivid
                                : semantic.warning,
                          fontVariant: ['tabular-nums'],
                        }}
                      >
                        {formatEUR(aged.buckets[bucket])}
                      </Text>
                    </View>
                  ))}
                {/* Par client : les 3 plus gros dus, navigation fiche (retard max en badge). */}
                {aged.byCustomer.slice(0, 3).map((line, index, top) => (
                  <Pressable
                    key={line.customerId}
                    accessibilityRole="button"
                    accessibilityLabel={line.customerName}
                    onPress={() => router.push(`/client/${line.customerId}`)}
                    style={({ pressed }) => [
                      {
                        flexDirection: 'row',
                        alignItems: 'center',
                        gap: 10,
                        paddingVertical: 12,
                        borderBottomWidth: index < top.length - 1 ? 1 : 0,
                        borderBottomColor: colors.lineSoft,
                      },
                      cardPressed(pressed),
                    ]}
                  >
                    <Text
                      style={{ ...font('body', 700), fontSize: 14, color: colors.ink800, flex: 1 }}
                      numberOfLines={1}
                    >
                      {line.customerName}
                    </Text>
                    {line.maxDaysLate > 0 ? (
                      <StatusBadge
                        label={t('argent.agedDays', {
                          personality,
                          params: { days: line.maxDaysLate },
                        })}
                        variant={line.maxDaysLate > 90 ? 'danger' : 'particulier'}
                      />
                    ) : null}
                    <Text
                      style={{
                        ...font('sub', 700),
                        color: colors.ink800,
                        fontVariant: ['tabular-nums'],
                      }}
                    >
                      {formatEUR(line.totalCents)}
                    </Text>
                  </Pressable>
                ))}
                {aged.overdueCents > 0 ? (
                  <Text
                    style={[
                      font('meta', 500),
                      { color: colors.slate400, paddingTop: 4, paddingBottom: 10 },
                    ]}
                  >
                    {t('argent.agedOverdue', {
                      personality,
                      params: { amount: formatEUR(aged.overdueCents) },
                    })}
                  </Text>
                ) : null}
              </Card>
            )}
          </View>

          {/* ── À venir — échéancier fiscal (C-EXP-UI1 : dates réelles, jamais de montant) ── */}
          <View style={{ marginTop: 20 }}>
            <SectionHeader title={t('argent.upcomingTitle', { personality })} />
            {fiscal.isLoading ? (
              <Card radius={18} padding={0} style={{ paddingHorizontal: 16, paddingVertical: 4 }}>
                <SkeletonDeadlineRow />
                <SkeletonDeadlineRow last />
              </Card>
            ) : fiscal.isError ? (
              // Bannière discrète : l'échéancier manque, le reste de l'écran reste utilisable.
              <Card>
                <Text style={[font('sub'), { color: colors.slate500, lineHeight: 19 }]}>
                  {t('argent.upcomingError', { personality })}
                </Text>
              </Card>
            ) : (fiscal.data ?? []).length === 0 ? (
              // État vide honnête : rien à l'horizon 90 j (voix Bob), aucune ligne fantôme.
              <Card>
                <Text style={[font('sub'), { color: colors.slate500, lineHeight: 19 }]}>
                  {t('argent.upcomingEmpty', { personality })}
                </Text>
              </Card>
            ) : (
              <FadeIn index={5}>
                <Card radius={18} padding={0} style={{ paddingHorizontal: 16, paddingVertical: 4 }}>
                  {(fiscal.data ?? []).map((deadline, index, all) => (
                    <FiscalDeadlineRow
                      key={deadline.id}
                      deadline={deadline}
                      personality={personality}
                      last={index === all.length - 1}
                    />
                  ))}
                </Card>
              </FadeIn>
            )}
          </View>

          {/* ── Pilotage (BA-3) : CA facturé/encaissé, DSO, tops, SIG — l'activité en clair ── */}
          <Pressable
            accessibilityRole="button"
            accessibilityLabel={t('pilotage.title', { personality })}
            onPress={() => router.push('/pilotage')}
            style={({ pressed }) => [{ marginTop: 20 }, cardPressed(pressed)]}
          >
            <Card>
              <View style={{ flexDirection: 'row', alignItems: 'center', gap: 11 }}>
                <IconTile tone="b2b" size={34} radius={10}>
                  <Feather name="trending-up" size={16} color={semantic.b2b} />
                </IconTile>
                <View style={{ flex: 1, minWidth: 0 }}>
                  <Text style={{ ...font('cardTitle'), color: colors.ink800 }}>
                    {t('pilotage.title', { personality })}
                  </Text>
                  <Text
                    style={[font('meta'), { color: colors.slate400, marginTop: 2 }]}
                    numberOfLines={1}
                  >
                    {t('pilotage.entrySubtitle', { personality })}
                  </Text>
                </View>
                <Feather name="chevron-right" size={16} color={colors.slate400} />
              </View>
            </Card>
          </Pressable>
        </View>
      </TabsScrollView>

      <Fab onPress={() => router.push('/devis/new')} accessibilityLabel="Nouveau devis" />

      <FirstTimeTip visible={tip.visible} onDismiss={tip.dismiss} />
      <BankBalanceSheet
        visible={balanceSheetVisible}
        personality={personality}
        currentAmountCents={bankBalance.data?.amountCents ?? null}
        onClose={() => setBalanceSheetVisible(false)}
      />
      {fiscalFlow.sheets}
    </View>
  );
}
