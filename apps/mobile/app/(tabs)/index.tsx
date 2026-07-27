/**
 * Aujourd'hui — le briefing du jour (claim C10 v1.1 + rattrapage DA pixel-perfect,
 * réf design_handoff_bob_pro/Bob Pro.dc.html). Composition 100 % @bob/ui :
 * AppHeaderNavy (halos radiaux) → FloatingBalanceCard (geste signature) →
 * « À régler aujourd'hui » (PriorityCard ; conformité = carte info lavande, sans checkbox) →
 * « En un coup d'œil » (KpiTile ×4 iconées) → « Vite fait » (QuickAction ×4, dont Catalogue
 * C27 — TODAY_QUICK_ACTIONS) → footer.
 * PAS de FAB sur cet écran : les réglages s'ouvrent via l'avatar (JM) → modale menu profil
 * (design_handoff_bob_pro/Bob Pro.dc.html §PROFILE SHEET) → compte/onboarding/astuces/diagnostic.
 *
 * DONNÉES RÉELLES (amendement A1-C10) : tout vient des queries du BobClient
 * (solde bancaire qualifié, factures, cashflow et priorités) ; les priorités sont dérivées dans @bob/core
 * (deriveTodayPriorities, use case pur testé) — AUCUN repli fixtures silencieux :
 * loading → skeletons · erreur → voix de Bob (today.dataError) sans chiffre inventé ·
 * donnée absente → tuile vide « — » · 0 priorité → today.subtitleNone + section vide propre.
 * Un mode de démonstration explicite reste isolé de cet écran de production.
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
import {
  ActivityIndicator,
  Pressable,
  RefreshControl,
  ScrollView,
  Text,
  View,
  type StyleProp,
  type ViewStyle,
} from 'react-native';
import { useRouter } from 'expo-router';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { Feather } from '@expo/vector-icons';
import { challengeFor } from '@bob/ai';
import { buildQuoteRelance, formatEURWhole, normalizeVoiceText, type TodayPriority } from '@bob/core';
import { useIdentity } from '../../src/data/identity';
import type { InvoiceView } from '@bob/api-client';
import { patterns, shadowNative } from '@bob/tokens';
import { PERSONALITY_LABELS, t } from '@bob/i18n';
import {
  AppHeaderNavy,
  Button,
  Card,
  EmptyState,
  ErrorRetry,
  FadeIn,
  FloatingBalanceCard,
  KpiTile,
  PressableScale,
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
  useCompanyMe,
  useInvoices,
  useLatestBankBalance,
  useNotificationsFeed,
  useTodayPriorities,
} from '../../src/data/hooks';
import { isExpectedMissingBankingInput } from '../../src/data/cashflow-banking-state';
import { Badge } from '../../src/components/ui';
import { useConfirm } from '../../src/components/ConfirmSheet';
import { hasMeaningfulQuoteDraft, useQuoteDraft } from '../../src/quote-draft';
import { combineQueryStates } from '../../src/data/query-state';
import { ProfileMenuSheet } from '../../src/components/profile-menu-sheet';
import { CollectInvoiceButton } from '../../src/components/CollectInvoiceButton';
import { ShareQuoteLinkButton } from '../../src/components/ShareQuoteLinkButton';
import { TODAY_QUICK_ACTIONS } from '../../src/components/today-quick-actions';
import { useBobAwareScrollInsets } from '../../src/components/use-bob-aware-scroll-insets';
import { LatestValueDigestCard } from '../../src/engagement/ValueDigestCard';
import { LatestTrialReportCard } from '../../src/monetization/TrialReportCard';
import {
  usePublishAgentContext,
  type AgentAffordance,
  type AgentContext,
  type AgentEntityRef,
  type AgentSurface,
} from '../../src/agent';
import { useFiscalProfileFlow } from '../../src/fiscal/use-fiscal-profile-flow';
import { useSalesDocumentVoiceAffordance } from '../../src/documents-voice-search';
import { deriveHomeReceivableKpis } from '../../src/home/derive-home-receivable-kpis';
import { deriveCashPositionDisplay } from '../../src/finance/cash-position-view';
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
 * Rappel du slot de brouillon propriétaire persisté en PostgreSQL. Il n'entre pas dans
 * @bob/core TodayPriority : cette carte mobile compose le briefing avec l'unique slot renvoyé
 * par l'API authentifiée, uniquement après hydratation réussie.
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
function HeroPlaceholder({
  loading,
  failed,
  onPress,
}: {
  loading: boolean;
  failed: boolean;
  onPress: () => void;
}) {
  const { personality, colors, controls } = useTheme();
  const hintKey = failed ? 'today.balanceUnavailableHint' : 'today.balanceMissingHint';
  return (
    <PressableScale
      accessibilityRole="button"
      accessibilityLabel={t(hintKey, { personality })}
      onPress={onPress}
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
      {!loading ? (
        <Text style={[font('meta'), { color: colors.slate500, marginTop: 5 }]}>
          {t(hintKey, { personality })}
        </Text>
      ) : null}
    </PressableScale>
  );
}

/** Carte d'une priorité dérivée (@bob/core TodayPriority, + rappel local de brouillon
 * DisplayPriority) — copy @bob/i18n, CTA = parité d'actions Bob. */
function TodayPriorityCard({
  priority,
  invoice,
  onCollected,
}: {
  priority: DisplayPriority;
  /** Facture réelle de la relance (A2-C10) — active « Encaisser » directement sur la carte. */
  invoice?: InvoiceView | undefined;
  onCollected?: (amountCents: number) => void;
}) {
  const { personality, colors, semantic } = useTheme();
  const router = useRouter();
  const quoteDraft = useQuoteDraft();
  const confirm = useConfirm();
  const [draftDeleteBusy, setDraftDeleteBusy] = useState(false);

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
        />
      );
    }
    case 'facture_a_transmettre': {
      // PR-02 « Encaisser » (cas Fly Services : 2 % encaissé, des factures jamais envoyées) :
      // la pièce est ÉMISE mais RIEN ne prouve qu'elle est partie (aucun job d'envoi réussi,
      // aucun dépôt déclaré). La carte s'éteint d'elle-même dès qu'un envoi réussit ou qu'un
      // dépôt est déclaré — état dérivé, jamais un statut inventé. CTA : la fiche facture, où
      // vivent « Envoyer par e-mail » (PR-01) et le guide de dépôt Chorus/portail.
      const name = priority.customerName || priority.docNumber || '';
      const reference = priority.docNumber ? `${priority.docNumber} · ` : '';
      return (
        <PriorityCard
          status="retard"
          title={t('today.prioInvoiceTransmitTitle', { personality, params: { name } })}
          subtitle={`${reference}${formatEURWhole(priority.amountCents)} — ${t(
            'today.prioInvoiceTransmitHint',
            { personality },
          )}`}
          leadingIcon={<Feather name="send" size={13} color={semantic.warning} />}
          badge={
            <Badge
              label={t('today.prioInvoiceTransmitBadge', { personality }).toUpperCase()}
              tone="warning"
            />
          }
          cta={
            <Button
              title={t('today.ctaInvoiceTransmit', { personality })}
              variant="primary"
              size="compact"
              radius={11}
              icon={<Feather name="send" size={15} color={colors.surface} />}
              style={{ alignSelf: 'flex-start' }}
              onPress={() => router.push(`/facture/${priority.invoiceId}`)}
            />
          }
        />
      );
    }
    case 'devis_a_transmettre': {
      // Cas terrain fondateur (2026-07-20) : le devis est bien passé `sent` — son numéro légal
      // est alloué — mais le client n'a pas d'e-mail, donc le serveur n'a RIEN envoyé
      // (deliveryStatus 'skipped'). Un blocage passif devient ici une action proposée, avec les
      // DEUX sorties possibles : réparer la cause (ajouter l'adresse) ou transmettre tout de
      // suite par le canal que l'artisan a déjà (WhatsApp, SMS, copie du lien…).
      // La carte s'éteint d'elle-même dès que le client ouvre le lien (devis → `viewed`).
      const name = priority.customerName || priority.docNumber || '';
      const reference = priority.docNumber ? `${priority.docNumber} · ` : '';
      return (
        <PriorityCard
          status="marine"
          title={t('today.prioTransmitTitle', { personality, params: { name } })}
          subtitle={`${reference}${formatEURWhole(priority.amountCents)} — ${t(
            'today.prioTransmitHint',
            { personality },
          )}`}
          leadingIcon={<Feather name="send" size={13} color={semantic.warning} />}
          badge={
            <Badge
              label={t('today.prioTransmitBadge', { personality }).toUpperCase()}
              tone="warning"
            />
          }
          cta={
            <View style={{ flexDirection: 'row', gap: 8, alignSelf: 'flex-start' }}>
              {/* Réparer la cause : la fiche client existante, formulaire d'édition ouvert
                  (?edit=1) — aucun mini-formulaire parallèle ne dupliquerait ses règles. */}
              <Button
                title={t('today.ctaTransmitAddEmail', { personality })}
                variant="primary"
                size="compact"
                radius={11}
                icon={<Feather name="mail" size={15} color={colors.surface} />}
                onPress={() =>
                  router.push({
                    pathname: '/client/[id]',
                    params: { id: priority.customerId, edit: '1' },
                  })
                }
              />
              {/* Transmettre maintenant : MÊME chemin que « Envoyer le lien » du devis
                  (signature-link + feuille de partage native) — aucun sortant tant que
                  l'utilisateur n'a pas choisi son canal. */}
              <ShareQuoteLinkButton
                quoteId={priority.quoteId}
                quoteNumber={priority.docNumber}
                title={t('today.ctaTransmitShare', { personality })}
                icon={<Feather name="share-2" size={15} color={colors.ink800} />}
              />
            </View>
          }
        />
      );
    }
    case 'devis_a_relancer': {
      // PR-05 — devis sans réponse depuis J+15/J+30 (ancré sur la date d'établissement RÉELLE) :
      // relance MANUELLE pré-rédigée en un tap (buildQuoteRelance, ton cordial) + lien de
      // signature frais — rien ne part tant que le Share n'est pas complété par l'artisan.
      const name = priority.customerName || priority.docNumber || '';
      const reference = priority.docNumber ? `${priority.docNumber} · ` : '';
      return (
        <PriorityCard
          status="marine"
          title={t('today.prioQuoteRelanceTitle', { personality, params: { name } })}
          subtitle={`${reference}${formatEURWhole(priority.amountCents)} — ${t(
            'today.prioQuoteRelanceHint',
            { personality, params: { days: priority.daysSinceIssued } },
          )}`}
          leadingIcon={<ClockIcon color={semantic.warning} size={13} />}
          badge={
            <Badge
              label={t(
                priority.palier === 'j30'
                  ? 'today.prioQuoteRelanceBadgeJ30'
                  : 'today.prioQuoteRelanceBadgeJ15',
                { personality },
              ).toUpperCase()}
              tone="warning"
            />
          }
          cta={
            <ShareQuoteLinkButton
              quoteId={priority.quoteId}
              quoteNumber={priority.docNumber}
              title={t('today.ctaQuoteRelance', { personality })}
              variant="primary"
              icon={<Feather name="send" size={15} color={colors.surface} />}
              buildMessage={(signatureUrl) =>
                buildQuoteRelance({
                  customerName: priority.customerName,
                  docNumber: priority.docNumber ?? '',
                  amountCents: priority.amountCents,
                  daysSinceIssued: priority.daysSinceIssued,
                  personality: PERSONALITY_LABELS[personality],
                  signatureUrl,
                }).body
              }
            />
          }
        />
      );
    }
    case 'bc_manquant': {
      // PR-05 — devis SIGNÉ sans n° de bon de commande alors que le contexte l'exige (client
      // public ou canal chorus/portail) : sans BC, la facture dérivée sera rejetée (RATP CAP).
      // CTA : la fiche devis, où la section « Bon de commande » se remplit (aussi à la voix).
      const name = priority.customerName || priority.docNumber || '';
      const reference = priority.docNumber ? `${priority.docNumber} · ` : '';
      return (
        <PriorityCard
          status="retard"
          title={t('today.prioBcManquantTitle', { personality, params: { name } })}
          subtitle={`${reference}${formatEURWhole(priority.amountCents)} — ${t(
            'today.prioBcManquantHint',
            { personality },
          )}`}
          leadingIcon={<Feather name="file-text" size={13} color={semantic.warning} />}
          badge={
            <Badge
              label={t('today.prioBcManquantBadge', { personality }).toUpperCase()}
              tone="warning"
            />
          }
          cta={
            <Button
              title={t('today.ctaBcManquant', { personality })}
              variant="primary"
              size="compact"
              radius={11}
              icon={<Feather name="edit-3" size={15} color={colors.surface} />}
              style={{ alignSelf: 'flex-start' }}
              onPress={() => router.push(`/devis/${priority.quoteId}`)}
            />
          }
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
          badge={
            <Badge
              label={t('today.prioDraftBadge', { personality }).toUpperCase()}
              tone="warning"
            />
          }
          cta={
            <View
              style={{
                flexDirection: 'row',
                gap: 8,
                alignSelf: 'flex-start',
                alignItems: 'center',
              }}
            >
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
                style={({ pressed }) => ({
                  width: 40,
                  height: 40,
                  borderRadius: 12,
                  alignItems: 'center',
                  justifyContent: 'center',
                  backgroundColor: semantic.dangerBg,
                  opacity: draftDeleteBusy ? 0.5 : pressed ? 0.7 : 1,
                  transform: [{ scale: pressed && !draftDeleteBusy ? 0.94 : 1 }],
                })}
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
  const companyMe = useCompanyMe();
  const { personality, density, colors, semantic } = useTheme();
  const router = useRouter();
  const insets = useSafeAreaInsets();
  const cashflow = useCashflow('realiste', 30);
  const bankBalance = useLatestBankBalance();
  // DEUX nombres, pas un seul : le solde CONSTATÉ (le fait, daté) et la POSITION ESTIMÉE qui y
  // ajoute les mouvements postérieurs. Affiché seul, le constaté figé se lisait comme un bug
  // (« j'encaisse, rien ne bouge »). `null` = rien de plus à montrer → rendu actuel inchangé.
  const cashPosition = useMemo(
    () => deriveCashPositionDisplay({ balance: bankBalance.data, personality }),
    [bankBalance.data, personality],
  );
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
  const bobScrollInsets = useBobAwareScrollInsets({ minimumBottom: 140 });

  const [toast, setToast] = useState<string | null>(null);
  // Modale menu profil (design_handoff_bob_pro/Bob Pro.dc.html §PROFILE SHEET) — l'avatar
  // n'ouvre plus /compte directement, il ouvre CE menu (le flow décrit par le proto).
  const [profileMenuOpen, setProfileMenuOpen] = useState(false);
  // Cold start (voir `appSessionFresh` ci-dessus) — capturé UNE fois, avant que ce composant
  // (ou tout autre écran monté avant lui) ne consomme le flag pour ce processus JS.
  const [isFreshAppSession] = useState(() => {
    const fresh = appSessionFresh;
    appSessionFresh = false;
    return fresh;
  });

  // Rappel du slot BDD propriétaire (C21) : l'état mobile n'est rendu qu'après le GET autoritatif.
  // `pendingResume` (soft-reset côté wizard) prime sur la version hydratée ; aucun cache local ni
  // état vierge transitoire ne peut fabriquer une carte pendant un échec réseau.
  const persistedDraft = quoteDraft.persistence.ready
    ? (quoteDraft.pendingResume ??
      (hasMeaningfulQuoteDraft(quoteDraft.state) && quoteDraft.state.saved !== null
        ? quoteDraft.state
        : null))
    : null;
  const draftAgeMs = persistedDraft?.saved != null ? Date.now() - persistedDraft.saved.at : null;
  const showDraftReminder =
    persistedDraft !== null &&
    (isFreshAppSession || (draftAgeMs !== null && draftAgeMs > DRAFT_REMINDER_MIN_AGE_MS));
  const draftPriority: DraftQuotePriority | null = showDraftReminder
    ? {
        kind: 'devis_brouillon',
        id: 'devis-brouillon-server',
        customerName: persistedDraft.customer?.name ?? null,
      }
    : null;
  // Priorité basse (fin de liste) : un rappel de brouillon n'a jamais à évincer une vraie
  // urgence (relance en retard, facture finale à émettre).
  const allPriorities: DisplayPriority[] = draftPriority
    ? [...today.priorities, draftPriority]
    : today.priorities;

  const displayed = allPriorities.slice(0, DISPLAY_CAP);
  const remaining = displayed.length;
  const todayReady = !today.isLoading && !today.isError;
  // Le contexte « écran d'accueil » inclut trésorerie, solde, fiscalité, notifications et
  // priorités. Bob ne publie donc aucune capacité financière à partir du seul briefing : la
  // photographie complète réellement visible doit avoir répondu, y compris le solde qualifié.
  const homeAgentDataReady =
    todayReady &&
    cashflow.data !== undefined &&
    !cashflow.isError &&
    bankBalance.data !== undefined &&
    !bankBalance.isError &&
    fiscalFlow.profile !== undefined &&
    !fiscalFlow.isError &&
    invoices.data !== undefined &&
    !invoices.isError &&
    companyMe.data !== undefined &&
    !companyMe.isError &&
    !notifications.isLoading &&
    !notifications.isError &&
    notifications.unreadCount !== null &&
    quoteDraft.persistence.ready;
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
      } else if (priority.kind === 'devis_a_transmettre') {
        // Parité voix : ce que l'écran montre, Bob le voit — mêmes entités (devis + client)
        // que les autres priorités actionnables, sous les mêmes capacités quote/customer.read.
        add({
          type: 'quote',
          id: priority.quoteId,
          label: priority.docNumber ? `Devis ${priority.docNumber}` : 'Devis à transmettre',
        });
        add({ type: 'customer', id: priority.customerId, label: priority.customerName });
      }
    }
    return {
      screen: { name: '/(tabs)/index', instanceId: 'today' },
      entities: homeAgentDataReady ? entities : [],
      capabilities: homeAgentDataReady
        ? [
            'screen.read',
            'today.read',
            'cashflow.read',
            'priorities.read',
            'invoice.read',
            'quote.read',
            'customer.read',
          ]
        : [],
    };
  }, [homeAgentDataReady, today.priorities]);

  // ── Parité vocale du rappel de brouillon (« continue mon devis en cours » / « supprime le
  // brouillon ») — refs pour une identité STABLE de l'affordance (même convention que
  // ventes.tsx) ; la suppression reste TOUJOURS derrière la ConfirmSheet, jamais un tap voix
  // unique (verrouillage fondateur — aucune suppression en un seul geste, nulle part).
  const persistedDraftRef = useRef(persistedDraft);
  persistedDraftRef.current = persistedDraft;
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
          if (persistedDraftRef.current === null) return null;
          const n = normalizeVoiceText(utterance);
          if (!/(continue|reprend\w*).{0,15}(devis|brouillon)/.test(n)) return null;
          return () => {
            routerRef.current.push('/devis/new?resume=1');
            return {
              say: t('today.voiceDraftResume', { personality: homePersonalityRef.current }),
            };
          };
        },
      },
      {
        id: 'today.deleteDraft',
        match: (utterance) => {
          const draft = persistedDraftRef.current;
          if (draft === null) return null;
          const n = normalizeVoiceText(utterance);
          if (!/(supprime|efface)\w*.{0,15}(devis|brouillon)/.test(n)) return null;
          return () => {
            const name =
              draft.customer?.name ??
              t('today.prioDraftNoCustomer', { personality: homePersonalityRef.current });
            void (async () => {
              const ok = await confirmRef.current({
                title: t('today.draftDeleteConfirmTitle', {
                  personality: homePersonalityRef.current,
                }),
                message: t('today.draftDeleteConfirmBody', {
                  personality: homePersonalityRef.current,
                  params: { name },
                }),
                challenge: challengeFor(DRAFT_DELETE_RISK, 'confirm_all'),
                destructive: true,
              });
              if (ok) await quoteDraftRef.current.discard();
            })();
            return {
              say: t('today.voiceDraftDeleteOpened', { personality: homePersonalityRef.current }),
            };
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
  // Surface MÉMOÏSÉE : les arguments de ce hook sont des dépendances d'effet (agent-context:177) ;
  // un littéral inline se réidentifie à chaque rendu → republication → nouveau contexte →
  // re-rendu → boucle infinie qui sature le fil JS (écran figé sur l'appareil).
  const homeAgentSurface = useMemo<AgentSurface>(
    () => ({
      affordances: [
        salesDocumentVoiceAffordance,
        ...(homeAgentDataReady ? fiscalFlow.voiceAffordances : []),
        ...draftVoiceAffordances,
      ],
    }),
    [salesDocumentVoiceAffordance, homeAgentDataReady, fiscalFlow.voiceAffordances, draftVoiceAffordances],
  );
  usePublishAgentContext(agentContext, undefined, homeAgentSurface);

  // KPI : les encours viennent directement des factures émises/encaissées persistées. Les
  // anciennes colonnes score/outstanding du client ne sont jamais une autorité financière ici.
  const receivableKpis = useMemo(
    () =>
      invoices.data
        ? deriveHomeReceivableKpis(
            invoices.data.map((invoice) => ({
              id: invoice.id,
              companyId: invoice.companyId,
              kind: invoice.kind,
              status: invoice.status,
              netToPayCents: invoice.totals.netToPay,
              paidCents: invoice.paid,
            })),
          )
        : null,
    [invoices.data],
  );
  const owedCents = receivableKpis?.owedCents;
  const lateCents = receivableKpis?.lateCents;
  // Projection indicative à 30 jours : jamais assimilée à une fin de mois ni au solde observé.
  const projection30Cents = cashflow.data?.available;
  const primaryState = combineQueryStates(companyMe, invoices, today, notifications);
  const expectedBankBalanceMissing =
    bankBalance.isError && isExpectedMissingBankingInput(bankBalance.error);
  const expectedCashflowMissing = cashflow.isError && isExpectedMissingBankingInput(cashflow.error);
  const glanceReady = cashflow.data !== undefined && invoices.data !== undefined;
  const glanceLoading =
    !glanceReady &&
    ((cashflow.isLoading && cashflow.data === undefined) ||
      (invoices.isLoading && invoices.data === undefined));
  const glanceBlockingError =
    (invoices.isError && invoices.data === undefined) ||
    (cashflow.isError && cashflow.data === undefined && !expectedCashflowMissing);
  const glanceMissingBankingInput = expectedCashflowMissing && cashflow.data === undefined;
  const financialDataFailed =
    (bankBalance.isError && !expectedBankBalanceMissing) ||
    (cashflow.isError && !expectedCashflowMissing);
  const dataFailed = primaryState.failed || financialDataFailed || fiscalFlow.isError;
  const refreshing =
    cashflow.isRefetching ||
    bankBalance.isRefetching ||
    today.isRefetching ||
    invoices.isRefetching ||
    notifications.isRefetching ||
    companyMe.isRefetching ||
    fiscalFlow.isRefetching;
  // S8 : le pull-to-refresh ne recharge QUE les queries AFFICHÉES par ce briefing (trésorerie,
  // solde bancaire, factures, fil de notifications) — clients/devis/diagnostic/profil fiscal
  // vivent sur leur politique staleTime + invalidations de mutation. DoD : retour dashboard
  // ≤ 6 GET, sans donnée périmée après mutation (les mutateurs invalident leurs domaines).
  const refreshAll = (): void => {
    void cashflow.refetch();
    void bankBalance.refetch();
    void invoices.refetch();
    notifications.refetchFeed();
  };
  // Le RETRY d'erreur relance TOUT (comportement historique) : une query en échec doit pouvoir
  // se rétablir même hors de la liste affichée (company-me, priorités, profil fiscal…).
  const retryAll = (): void => {
    primaryState.refetchAll();
    void cashflow.refetch();
    void bankBalance.refetch();
    void fiscalFlow.refetch();
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
          hasUnread={notifications.unreadCount !== null && notifications.unreadCount > 0}
          onAvatarPress={() => setProfileMenuOpen(true)}
          onBellPress={() => router.push('/notifications')}
        />

        {bankBalance.data ? (
          <FloatingBalanceCard
            label={
              cashPosition
                ? t('today.balanceEstimatedLabel', { personality })
                : t('today.balanceLabel', { personality })
            }
            // Le héros devient la POSITION dès qu'un mouvement existe ; sans mouvement, l'estimé
            // égalerait le constaté et le rendu historique reste, à l'octet près.
            amountCents={cashPosition ? cashPosition.estimatedCents : bankBalance.data.amountCents}
            // Le FAIT ne disparaît jamais : il descend en voix de Bob, daté, à côté de l'estimé.
            voiceLine={
              cashPosition
                ? t('today.balanceEstimatedVoice', {
                    personality,
                    params: {
                      observed: cashPosition.observedAmount,
                      date: cashPosition.observedDate,
                    },
                  })
                : t('today.balanceObservedHint', { personality })
            }
            chevronIcon={<ChevronRightIcon color={colors.slate400} size={15} strokeWidth={2.4} />}
            voiceIcon={<DepositIcon color={semantic.success} size={16} />}
            onPress={() => router.push('/(tabs)/argent')}
            {...(cashPosition
              ? {
                  badge: {
                    label: cashPosition.movementsLabel,
                    accessibilityHint: t('today.balanceMovementsHint', { personality }),
                    onPress: () => router.push('/(tabs)/argent'),
                  },
                }
              : {})}
          />
        ) : (
          <HeroPlaceholder
            loading={bankBalance.isLoading}
            failed={bankBalance.isError && !expectedBankBalanceMissing}
            onPress={() => router.push('/(tabs)/argent')}
          />
        )}

        <View style={{ paddingHorizontal: 18, paddingTop: 22, gap: 20 }}>
          {dataFailed ? (
            <ErrorRetry
              message={t('today.dataError', { personality })}
              onRetry={retryAll}
              retrying={refreshing}
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
                // Sortie de skeleton : fondu (transform/opacity only — zéro saut de layout).
                <FadeIn index={0} style={{ gap: 11 }}>
                  {displayed.map((p) => (
                    <TodayPriorityCard
                      key={p.id}
                      priority={p}
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
                </FadeIn>
              ) : todayReady ? (
                // 0 priorité : état vide de premier rang — un vrai moment positif (coche success),
                // la voix de Bob, aucune carte fantôme.
                <FadeIn index={0}>
                  <Card>
                    <EmptyState
                      body={t('today.subtitleNone', { personality })}
                      icon={<Feather name="check" size={16} color={semantic.success} />}
                    />
                  </Card>
                </FadeIn>
              ) : null /* erreur : la carte today.dataError ci-dessus parle déjà */
            }
          </View>

          {cockpit ? (
            <View>
              <SectionHeader title={t('today.sectionGlance', { personality })} />
              {glanceLoading ? (
                <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 11 }}>
                  <SkeletonTile />
                  <SkeletonTile />
                  <SkeletonTile />
                  <SkeletonTile />
                </View>
              ) : glanceBlockingError || (!glanceReady && !glanceMissingBankingInput) ? (
                <ErrorRetry
                  message={t('today.dataError', { personality })}
                  onRetry={retryAll}
                  retrying={refreshing}
                />
              ) : glanceMissingBankingInput ? (
                <Card>
                  <EmptyState body={t('today.balanceMissingHint', { personality })} />
                </Card>
              ) : (
                // Même géométrie que la grille de skeletons — le fondu n'ajoute AUCUN saut.
                <FadeIn index={1} style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 11 }}>
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
                      {...(projection30Cents !== undefined
                        ? { amountCents: projection30Cents }
                        : {})}
                      tone="ink"
                      icon={<CalendarIcon color={colors.ink600} />}
                      onPress={() => router.push('/(tabs)/argent')}
                    />
                </FadeIn>
              )}
            </View>
          ) : null}

          {cockpit ? (
            <View>
              <SectionHeader title={t('today.sectionQuick', { personality })} />
              {/* Section statique : entre dans la même cascade sobre que le reste du briefing.
                  5 actions (B1 ajoute la facture directe) : grille qui respire (wrap 3+2)
                  plutôt qu'une rangée écrasée. */}
              <FadeIn index={2} style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 10 }}>
                {TODAY_QUICK_ACTIONS.map((action) => (
                  <QuickAction
                    key={action.id}
                    style={{ flexGrow: 1, flexBasis: '30%' }}
                    label={t(action.labelKey, { personality })}
                    tone={action.tone}
                    icon={<Feather name={action.icon} size={18} color={semantic[action.tone]} />}
                    onPress={() => router.push(action.route)}
                  />
                ))}
              </FadeIn>
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

      <ProfileMenuSheet
        visible={profileMenuOpen}
        onClose={() => setProfileMenuOpen(false)}
        fullName={identity.fullName}
        company={companyMe.data ?? null}
        personality={personality}
        onOpenAccount={() => router.push('/compte')}
        onOpenOnboarding={() => router.push('/onboarding')}
        onOpenDiagnostic={() => router.push('/diagnostic')}
        onTipsReset={() => setToast(t('menu.tipsResetToast', { personality }))}
      />
    </View>
  );
}
