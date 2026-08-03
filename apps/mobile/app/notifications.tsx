/**
 * Notifications — la cloche C10 enfin câblée (claim C25 v2, réf dc.html §showNotifs + §showRelances).
 *
 * DONNÉES RÉELLES, une seule vérité : useNotificationsFeed (hooks) compose
 * · le FIL SERVEUR (GET /notifications — jobs réels : relances envoyées/en retry ; lu/non-lu
 *   PERSISTÉS via POST /notifications/:id/read) ;
 * · les agrégats @bob/core sur les queries partagées — deriveRelancePlan (relances dues et
 *   planifiées, ton escaladé par ancienneté) + deriveUpcomingDues (échéances ≤ 7 j) +
 *   todayCompanyFromDiagnostic (conformité e-invoicing).
 * L'écran ne calcule AUCUNE règle ; aucun repli fixtures : pas de données → état vide (voix Bob).
 *
 * PARITÉ D'ACTIONS (directive 23:52) : « Relancer » = ENVOI RÉEL confirmé → client.sendRelance
 * (POST /invoices/:id/relance) — le MÊME endpoint que l'outil agent envoyer_relance ; tap d'un
 * item du fil → lu + deep link (route posée par le serveur) ; « Voir la pièce » → /facture/[id]
 * (C16) ; conformité → /diagnostic (C23).
 *
 * Écarts assumés vs proto (honnêteté avant pixel) :
 * · toggle « Relances automatiques » : aucun réglage serveur → carte informative (le cron EST
 *   actif : RelanceService 6 h, politique DEFAULT_RELANCE_POLICY du core), pas de switch fantôme ;
 * · « Tout marquer lu » utilise un preview + cutoff serveur puis une commande atomique : les
 *   notifications arrivées pendant la confirmation restent non lues ;
 * · l'écran cadence éditable du proto n'existe pas (pas de réglage serveur) — la mise en demeure
 *   n'est JAMAIS envoyée par le cron : elle attend le geste confirmé ici (relance.medWarning).
 */
import { useCallback, useState, useMemo, useRef } from 'react';
import { AccessibilityInfo, Pressable, RefreshControl, ScrollView, Text, View } from 'react-native';
import { useFocusEffect, useRouter, type Href } from 'expo-router';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import {
  formatEUR,
  formatEURWhole,
  type RelancePlanEntry,
  type RelanceTone,
  type UpcomingDueEntry,
} from '@bob/core';
import { bobErrorCode, type NotificationView } from '@bob/api-client';
import { spacing } from '@bob/tokens';
import { PERSONALITY_LABELS, t, type I18nKey, type Personality } from '@bob/i18n';
import {
  Avatar,
  BackHeader,
  Button,
  Card,
  EmptyState,
  ErrorRetry,
  IconTile,
  SectionHeader,
  Skeleton,
  SkeletonRow,
  StaggeredList,
  StatusBadge,
  StatusStrip,
  Toast,
  font,
  useErrorSheet,
  useTheme,
  type ErrorSheetFacts,
  type StatusBadgeVariant,
  type ToastTone,
} from '@bob/ui';
import {
  useMarkNotificationRead,
  useMarkNotificationsReadThrough,
  useNotificationsFeed,
  useSendRelance,
  useUnreadNotificationsPreview,
} from '../src/data/hooks';
import { usePushPermissionConsent, type PushPermissionConsent } from '../src/data/push';
import { parseAllowlistedPushRoute } from '../src/data/push-permission-events';
import { usePublishAgentContext, type AgentContext } from '../src/agent';
import { useConfirm } from '../src/components/ConfirmSheet';
import { useBobAwareScrollInsets } from '../src/components/use-bob-aware-scroll-insets';
import {
  CalendarIcon,
  ChevronRightIcon,
  SendIcon,
  ShieldIcon,
} from '../src/components/icons';

// ── Ton → pastel/badge. Les tons de TYPOLOGIE CLIENT ne se recyclent jamais (arbitrage
// TONS RECYCLÉS) : cordial = 'warning' (même pixel ambre que l'ancien alias 'particulier'),
// neutre = 'neutral' (état calme, plus jamais « B2B ») — ferme/MED restent danger. ──
const TONE_BADGE: Record<RelanceTone, StatusBadgeVariant> = {
  cordial: 'warning',
  neutre: 'neutral',
  ferme: 'danger',
  miseendemeure: 'danger',
};

const TONE_LABEL: Record<RelanceTone, I18nKey> = {
  cordial: 'relance.toneCordial',
  neutre: 'relance.toneNeutre',
  ferme: 'relance.toneFerme',
  miseendemeure: 'relance.toneMed',
};

/** '2026-07-15' → '15/07/2026' (échéances d'escalade) — même règle que l'écran diagnostic. */
function frDate(dateOnly: string): string {
  const [y, m, d] = dateOnly.split('-');
  return y !== undefined && m !== undefined && d !== undefined ? `${d}/${m}/${y}` : dateOnly;
}

/** Référence visible d'une pièce — jamais un id interne nu si un numéro existe. */
function displayDoc(docNumber: string | null, invoiceId: string): string {
  return docNumber ?? invoiceId;
}

/** Preuve minimale du contenu confirmé : une même facture dont le montant, le retard ou le ton
 * a changé doit repasser par la modale, même si son identifiant est identique. */
function relanceProof(entry: RelancePlanEntry): string {
  return [entry.invoiceId, entry.amountCents, entry.daysLate, entry.tone, entry.docNumber ?? ''].join('|');
}

/** Teinte de l'ICÔNE d'une relance (pastille pastel, ≥3:1 graphique — jamais du texte). */
function toneIconColor(
  tone: RelanceTone,
  palette: { warning: string; danger: string; neutral: string },
): string {
  const variant = TONE_BADGE[tone];
  return variant === 'danger' ? palette.danger : variant === 'neutral' ? palette.neutral : palette.warning;
}

/** Encre TEXTE d'une relance — l'ambre s'écrit warningInk (AA petit texte), le neutre slate. */
function toneTextColor(
  tone: RelanceTone,
  palette: { warningInk: string; danger: string; neutral: string },
): string {
  const variant = TONE_BADGE[tone];
  return variant === 'danger' ? palette.danger : variant === 'neutral' ? palette.neutral : palette.warningInk;
}

// ── Expertise par facture échue (C-EXP-UI1 — données du moteur, ZÉRO calcul ici) ──

/** Pastille de prescription par palier d'urgence (P04 derivePrescription) — couleurs sémantiques. */
function prescriptionDisplay(
  prescription: NonNullable<RelancePlanEntry['prescription']>,
  personality: Personality,
  palette: { success: string; warning: string; warningInk: string; danger: string; far: string },
): { dot: string; color: string; weight: 500 | 600 | 700; text: string } {
  const date = frDate(prescription.deadline);
  switch (prescription.urgency) {
    case 'prescrite':
      // État grave : la créance est morte juridiquement — plus aucun recours.
      return {
        dot: palette.danger,
        color: palette.danger,
        weight: 700,
        text: t('relance.prescriptionDead', { personality, params: { date } }),
      };
    case 'urgente':
      return {
        dot: palette.danger,
        color: palette.danger,
        weight: 600,
        text: t('relance.prescriptionLost', { personality, params: { date } }),
      };
    case 'a_surveiller':
      return {
        // La pastille (graphique ≥3:1) garde l'ambre vif ; le TEXTE passe en warningInk —
        // l'ambre nu sur blanc ≈ 3,4:1 échouait l'AA petit texte (audit 03/08).
        dot: palette.warning,
        color: palette.warningInk,
        weight: 600,
        text: t('relance.prescriptionLost', { personality, params: { date } }),
      };
    case 'lointaine':
      // Discret : l'échéance est loin, on informe sans alarmer.
      return {
        dot: palette.success,
        color: palette.far,
        weight: 500,
        text: t('relance.prescriptionFar', { personality, params: { date } }),
      };
  }
}

/**
 * Sous-bloc expertise d'une facture échue (C-EXP-UI1) — tout vient de deriveRelancePlan :
 * · pénalités courues P12 (« +0,62 €/jour · 27,71 € courus ») — b2b/b2g seulement : en b2c
 *   sans mise en demeure les montants sont à 0 de plein droit → rien d'affiché ;
 * · chrono de prescription P04 (pastille par urgence + deadline JJ/MM/AAAA).
 * Rien à afficher (données manquantes → null côté moteur) → le bloc disparaît, jamais inventé.
 */
function ExpertiseMeta({ entry, personality }: { entry: RelancePlanEntry; personality: Personality }) {
  const { colors, semantic } = useTheme();
  const { penalties, prescription } = entry;

  const penaltiesLine =
    penalties !== null && (penalties.interestCents > 0 || penalties.dailyCents > 0)
      ? t('relance.penaltiesLine', {
          personality,
          params: { daily: formatEUR(penalties.dailyCents), accrued: formatEUR(penalties.interestCents) },
        })
      : null;
  const chrono =
    prescription !== null
      ? prescriptionDisplay(prescription, personality, {
          success: semantic.success,
          warning: semantic.warning,
          warningInk: semantic.warningInk,
          danger: semantic.danger,
          far: colors.slate400,
        })
      : null;
  if (penaltiesLine === null && chrono === null) return null;

  return (
    <View style={{ marginTop: 8, gap: 4 }}>
      {penaltiesLine !== null ? (
        // warningInk : les pénalités juridiques en petit texte sur blanc — AA 5,25:1.
        <Text style={[font('meta', 600), { color: semantic.warningInk, fontVariant: ['tabular-nums'] }]}>
          {penaltiesLine}
        </Text>
      ) : null}
      {chrono !== null ? (
        <View style={{ flexDirection: 'row', alignItems: 'center', gap: 6 }}>
          <View style={{ width: 7, height: 7, borderRadius: 3.5, backgroundColor: chrono.dot }} />
          <Text style={[font('meta', chrono.weight), { color: chrono.color, flex: 1, lineHeight: 16 }]}>
            {chrono.text}
          </Text>
        </View>
      ) : null}
    </View>
  );
}

// ── Cartes ────────────────────────────────────────────────────────────────────

/** Relance DUE : ton badgé + reste dû + actions — voir la pièce, ou ENVOI RÉEL confirmé (C25 v2 :
 * même endpoint POST /invoices/:id/relance que l'outil agent envoyer_relance, parité d'actions). */
function DueRelanceCard({
  entry,
  personality,
  sending,
  onRelance,
}: {
  entry: RelancePlanEntry;
  personality: Personality;
  sending: boolean;
  onRelance: (entry: RelancePlanEntry) => void;
}) {
  const { colors, semantic } = useTheme();
  const router = useRouter();
  const doc = displayDoc(entry.docNumber, entry.invoiceId);
  const name = entry.customerName || doc;
  const subKey: I18nKey = entry.daysLate === 1 ? 'notif.itemRelanceSubOne' : 'notif.itemRelanceSub';
  return (
    <Card>
      <View style={{ flexDirection: 'row', alignItems: 'flex-start', gap: 12 }}>
        <IconTile tone={TONE_BADGE[entry.tone]} size={34} radius={11}>
          <SendIcon
            color={toneIconColor(entry.tone, {
              warning: semantic.warning,
              danger: semantic.danger,
              neutral: colors.slate500,
            })}
            size={16}
          />
        </IconTile>
        <View style={{ flex: 1 }}>
          <Text style={[font('body', 600), { color: colors.ink800 }]}>
            {t('notif.itemRelanceTitle', { personality, params: { name } })}
          </Text>
          <Text style={[font('meta'), { color: colors.slate500, marginTop: 2 }]}>
            {t(subKey, {
              personality,
              params: { doc, amount: formatEURWhole(entry.amountCents), days: entry.daysLate },
            })}
          </Text>
        </View>
        <StatusBadge label={t(TONE_LABEL[entry.tone], { personality }).toUpperCase()} variant={TONE_BADGE[entry.tone]} />
      </View>
      {/* C-EXP-UI1 : pénalités courues + chrono de prescription — chiffrés par le moteur. */}
      <ExpertiseMeta entry={entry} personality={personality} />
      <View style={{ flexDirection: 'row', gap: 8, marginTop: spacing.intraGap }}>
        <Button
          title={t('notif.actionView', { personality })}
          variant="secondary"
          size="compact"
          radius={11}
          onPress={() => router.push(`/facture/${entry.invoiceId}`)}
        />
        <Button
          title={t('notif.actionRelance', { personality })}
          variant="primary"
          size="compact"
          radius={11}
          loading={sending}
          icon={<SendIcon color={colors.surface} size={14} />}
          // Envoi RÉEL après confirmation explicite (sortant ; mise en demeure possible).
          onPress={() => onRelance(entry)}
        />
      </View>
    </Card>
  );
}

/** Item du fil serveur (GET /notifications) — pastille non-lu, statut d'envoi, tap = lu + route. */
function FeedItemCard({
  item,
  personality,
  onPress,
}: {
  item: NotificationView;
  personality: Personality;
  onPress: (item: NotificationView) => void;
}) {
  const { colors, semantic, controls } = useTheme();
  const statusKey: I18nKey =
    item.status === 'done' ? 'notif.feedDone' : item.status === 'failed' ? 'notif.feedFailed' : 'notif.feedPending';
  const statusColor = item.status === 'failed' ? semantic.danger : colors.slate500;
  const statusLine = `${t(statusKey, { personality })} · ${frDate(item.createdAt.slice(0, 10))}`;
  const unread = item.readAt === null;
  return (
    <Card padding={13}>
      <Pressable
        accessibilityRole="button"
        // Papa vocal : l'item se comprend à l'oreille — titre, statut, date, et « non lue »
        // en TEXTE (accessibilityState.selected détourné faisait annoncer « sélectionné »).
        accessibilityLabel={`${item.title}, ${statusLine}${
          unread ? `, ${t('notif.a11yUnread', { personality })}` : ''
        }`}
        onPress={() => onPress(item)}
        style={({ pressed }) => ({
          flexDirection: 'row',
          alignItems: 'center',
          gap: 12,
          opacity: pressed ? 0.65 : 1,
        })}
      >
        {/* Le fil, c'est BOB qui a agi (relances du cron) : canal indigo déclaré 'ai' —
            jamais l'alias b2g (même pixel, contrat de sens différent). */}
        <IconTile tone={item.status === 'failed' ? 'danger' : 'ai'} size={34} radius={11}>
          <SendIcon color={item.status === 'failed' ? semantic.danger : semantic.ai} size={16} />
        </IconTile>
        <View style={{ flex: 1 }}>
          <Text
            numberOfLines={1}
            style={[font('body', unread ? 700 : 600), { color: colors.ink800 }]}
          >
            {item.title}
          </Text>
          <Text style={[font('meta'), { color: statusColor, marginTop: 2 }]}>{statusLine}</Text>
        </View>
        {unread ? (
          <View style={{ width: 8, height: 8, borderRadius: 4, backgroundColor: semantic.ai }} />
        ) : (
          <ChevronRightIcon color={controls.chevron} size={15} />
        )}
      </Pressable>
    </Card>
  );
}

/** Échéance proche : facture pas encore en retard — un tap ouvre la pièce (C16). */
function UpcomingDueCard({ entry, personality }: { entry: UpcomingDueEntry; personality: Personality }) {
  const { colors, semantic, controls } = useTheme();
  const router = useRouter();
  const doc = displayDoc(entry.docNumber, entry.invoiceId);
  const name = entry.customerName || doc;
  const subKey: I18nKey = entry.inDays === 0 ? 'notif.itemDueToday' : 'notif.itemDueSub';
  const subLine = t(subKey, {
    personality,
    params: { doc, amount: formatEURWhole(entry.amountCents), days: entry.inDays },
  });
  return (
    <Card padding={13}>
      <Pressable
        accessibilityRole="button"
        // Papa vocal : titre + pièce + montant + échéance dans la même annonce.
        accessibilityLabel={`${t('notif.itemDueTitle', { personality, params: { name } })}, ${subLine}`}
        onPress={() => router.push(`/facture/${entry.invoiceId}`)}
        style={({ pressed }) => ({
          flexDirection: 'row',
          alignItems: 'center',
          gap: 12,
          opacity: pressed ? 0.65 : 1,
        })}
      >
        <IconTile tone="particulier" size={34} radius={11}>
          <CalendarIcon color={semantic.particulier} size={16} />
        </IconTile>
        <View style={{ flex: 1 }}>
          <Text style={[font('body', 600), { color: colors.ink800 }]}>
            {t('notif.itemDueTitle', { personality, params: { name } })}
          </Text>
          <Text style={[font('meta'), { color: colors.slate500, marginTop: 2 }]}>{subLine}</Text>
        </View>
        <ChevronRightIcon color={controls.chevron} size={15} />
      </Pressable>
    </Card>
  );
}

/** Relance planifiée (premier palier pas encore atteint) — avatar + prochain ton daté + reste dû. */
function ScheduledRelanceRow({ entry, personality }: { entry: RelancePlanEntry; personality: Personality }) {
  const { colors, semantic } = useTheme();
  const doc = displayDoc(entry.docNumber, entry.invoiceId);
  const name = entry.customerName || doc;
  const line =
    entry.nextEscalationAt !== null
      ? t('relance.scheduledLine', {
          personality,
          params: { tone: t(TONE_LABEL[entry.tone], { personality }), date: frDate(entry.nextEscalationAt) },
        })
      : t(TONE_LABEL[entry.tone], { personality });
  return (
    <Card padding={13}>
      <View style={{ flexDirection: 'row', alignItems: 'center', gap: 12 }}>
        <Avatar name={name} size={40} />
        <View style={{ flex: 1 }}>
          <Text style={[font('body', 600), { color: colors.ink800 }]}>{name}</Text>
          <Text
            style={[
              font('meta', 600),
              {
                // Texte petit sur blanc : l'ambre s'écrit warningInk (AA), le graphique garde
                // l'ambre vif ailleurs (pastilles/points).
                color: toneTextColor(entry.tone, {
                  warningInk: semantic.warningInk,
                  danger: semantic.danger,
                  neutral: colors.slate500,
                }),
                marginTop: 2,
              },
            ]}
          >
            {line}
          </Text>
        </View>
        <Text style={[font('body', 700), { color: colors.ink800, fontVariant: ['tabular-nums'] }]}>
          {formatEURWhole(entry.amountCents)}
        </Text>
      </View>
      {/* C-EXP-UI1 : une facture planifiée est DÉJÀ échue — pénalités/prescription visibles aussi. */}
      <ExpertiseMeta entry={entry} personality={personality} />
    </Card>
  );
}

/** Skeleton d'une carte de notification (états du contrat — jamais un contenu inventé). */
function SkeletonNotif() {
  return (
    <Card>
      <SkeletonRow avatar="square" avatarSize={34} trailing="pill" />
      <View style={{ gap: 6, marginTop: 4 }}>
        <Skeleton height={11} width="66%" radius={6} />
        <Skeleton height={11} width="52%" radius={6} />
      </View>
      <View style={{ flexDirection: 'row', gap: 8, marginTop: spacing.intraGap }}>
        <Skeleton height={34} width={86} radius={11} />
        <Skeleton height={34} width={96} radius={11} />
      </View>
    </Card>
  );
}

function NotificationsSkeleton() {
  return (
    <View style={{ gap: spacing.itemGap }}>
      <View style={{ flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', minHeight: 28 }}>
        <Skeleton height={17} width="38%" radius={8} />
        <Skeleton height={28} width={92} radius={11} />
      </View>
      <SkeletonNotif />
      <SkeletonNotif />
    </View>
  );
}

/**
 * Pré-permission contextuelle : explique la valeur avant le prompt natif, sans modal ni
 * interruption. Après un refus, la carte devient compacte et l'écran reste intégralement
 * utilisable. Un refus définitif ne mène aux réglages qu'après un nouveau tap explicite.
 */
function PushConsentCard({
  consent,
  personality,
  onToast,
}: {
  consent: PushPermissionConsent;
  personality: Personality;
  // Tone du feedback : success (activé), danger (échec réel) — les messages de RÉASSURANCE
  // (« ton fil reste disponible ici ») restent SANS glyphe : ni coche mensongère, ni croix.
  onToast: (message: string, tone?: ToastTone) => void;
}) {
  const { colors, semantic } = useTheme();
  const { surface, state } = consent;
  if (surface === 'hidden') return null;

  const copy: {
    title: I18nKey;
    body: I18nKey;
    action: I18nKey;
  } =
    surface === 'primer'
      ? { title: 'notif.pushPrimerTitle', body: 'notif.pushPrimerBody', action: 'notif.pushPrimerAction' }
      : surface === 'dismissed'
        ? { title: 'notif.pushDismissedTitle', body: 'notif.pushDismissedBody', action: 'notif.pushPrimerAction' }
        : surface === 'provisional'
          ? {
              title: 'notif.pushProvisionalTitle',
              body: 'notif.pushProvisionalBody',
              action: state.canAskAgain === false ? 'notif.pushSettingsAction' : 'notif.pushProvisionalAction',
            }
          : surface === 'recovery'
            ? {
                title: 'notif.pushUnavailableTitle',
                body: 'notif.pushUnavailableBody',
                action: state.authorization === 'blocked' ? 'notif.pushSettingsAction' : 'notif.pushRetryAction',
              }
            : {
                title: 'notif.pushDeniedTitle',
                body: 'notif.pushDeniedBody',
                action: surface === 'settings' ? 'notif.pushSettingsAction' : 'notif.pushPrimerAction',
              };

  const busy = state.operation !== 'idle';
  const primary = async (): Promise<void> => {
    const outcome =
      surface === 'settings' ||
      (surface === 'provisional' && state.canAskAgain === false) ||
      (surface === 'recovery' && state.authorization === 'blocked')
        ? await consent.openSettingsFromUser()
        : surface === 'recovery'
          ? await consent.retryFromUser()
          : await consent.requestFromUser();

    if (outcome === 'registered' || outcome === 'granted') {
      onToast(t('notif.pushEnabledToast', { personality }), 'success');
    } else if (outcome === 'denied' || outcome === 'blocked') {
      onToast(t('notif.pushDeniedToast', { personality }));
    } else if (outcome === 'unavailable') {
      onToast(t('notif.pushErrorToast', { personality }), 'danger');
    } else if (outcome === 'refreshed') {
      AccessibilityInfo.announceForAccessibility(
        `${t('notif.pushPrimerTitle', { personality })}. ${t('notif.pushPrimerBody', { personality })}`,
      );
    }
  };

  const later = async (): Promise<void> => {
    await consent.dismissPrimer();
    onToast(t('notif.pushDeniedToast', { personality }));
  };

  return (
    <Card
      elevation={surface === 'primer' ? 'e2' : 'e1'}
      padding={surface === 'primer' ? 16 : 13}
      style={surface === 'primer' ? { borderColor: semantic.ai } : undefined}
    >
      <View style={{ flexDirection: 'row', alignItems: 'flex-start', gap: 12 }}>
        {/* C'est BOB qui préviendra : canal indigo déclaré 'ai' (l'alias b2g est banni) ;
            'recovery' garde l'ambre d'attention. */}
        <IconTile tone={surface === 'recovery' ? 'particulier' : 'ai'} size={34} radius={11}>
          <SendIcon color={surface === 'recovery' ? semantic.particulier : semantic.ai} size={16} />
        </IconTile>
        <View style={{ flex: 1, gap: 3 }}>
          {surface === 'primer' ? (
            <Text style={[font('eyebrow'), { color: semantic.ai }]}>
              {t('notif.pushPrimerEyebrow', { personality })}
            </Text>
          ) : null}
          <Text accessibilityLiveRegion="polite" style={[font('body', 700), { color: colors.ink800 }]}>
            {t(copy.title, { personality })}
          </Text>
          <Text selectable accessibilityLiveRegion="polite" style={[font('sub'), { color: colors.slate500, lineHeight: 20 }]}>
            {t(copy.body, { personality })}
          </Text>
        </View>
      </View>

      <View style={{ gap: 8, marginTop: 14 }}>
        <Button
          title={t(copy.action, { personality })}
          variant={surface === 'primer' ? 'primary' : 'secondary'}
          size={surface === 'primer' ? 'regular' : 'compact'}
          style={surface === 'primer' ? undefined : { alignSelf: 'flex-start' }}
          loading={busy}
          disabled={busy}
          onPress={() => void primary()}
        />
        {surface === 'primer' ? (
          <Button
            title={t('notif.pushPrimerLater', { personality })}
            variant="secondary"
            disabled={busy}
            onPress={() => void later()}
          />
        ) : null}
      </View>
    </Card>
  );
}

export default function Notifications() {
  const { colors, semantic, controls, personality } = useTheme();
  const insets = useSafeAreaInsets();
  const bobScrollInsets = useBobAwareScrollInsets({ minimumBottom: insets.bottom + 34 });
  const router = useRouter();
  const confirm = useConfirm();
  // La copy des messages du plan suit l'humeur de Bob (PERSONALITY_LABELS : ids i18n → domaine).
  const feed = useNotificationsFeed(PERSONALITY_LABELS[personality]);
  const markRead = useMarkNotificationRead();
  const unreadPreview = useUnreadNotificationsPreview();
  const markAllRead = useMarkNotificationsReadThrough();
  const sendRelance = useSendRelance();
  const pushConsent = usePushPermissionConsent();
  // Toast typé par TONE (grammaire d'erreur Lot 0) : coche verte = succès, croix danger =
  // échec, sans tone = information neutre — la coche unique mentait sur les échecs.
  const [toast, setToast] = useState<{ readonly message: string; readonly tone?: ToastTone } | null>(
    null,
  );
  const notify = useCallback(
    (message: string, tone?: ToastTone) => setToast(tone === undefined ? { message } : { message, tone }),
    [],
  );
  // Échecs de MUTATION appelables au support (envoi de relance, tout-marquer-lu) → ErrorSheet
  // kit 2 faces avec code court + corrélation, jamais un simple toast.
  const { showErrorFacts, errorSheet } = useErrorSheet();
  const mutationFacts = useCallback((e: unknown, message: string): ErrorSheetFacts => {
    const err = (e ?? {}) as { code?: string; correlationId?: string; kind?: string };
    return {
      message,
      code: err.code ?? bobErrorCode(e),
      ...(err.correlationId !== undefined ? { correlationId: err.correlationId } : {}),
      ...(err.kind !== undefined ? { kind: err.kind } : {}),
      at: new Date().toISOString(),
    };
  }, []);
  const serverSnapshotReady = feed.unreadCount !== null;
  const blockingError = feed.isError && !serverSnapshotReady;
  const feedFresh = serverSnapshotReady && !feed.isLoading && !feed.isError;
  const staleFeed = serverSnapshotReady && feed.isError;
  const feedFreshRef = useRef(feedFresh);
  feedFreshRef.current = feedFresh;
  const dueRelanceProofsRef = useRef<ReadonlyMap<string, string>>(new Map());
  dueRelanceProofsRef.current = new Map(
    feed.due.map((entry) => [entry.invoiceId, relanceProof(entry)] as const),
  );

  // Retour depuis les réglages iOS/Android : relire le statut, sans jamais rouvrir le prompt.
  useFocusEffect(
    useCallback(() => {
      void pushConsent.refreshSilently();
    }, [pushConsent.refreshSilently]),
  );

  // Bob voit le fil ET les factures du plan réellement affiché. Il peut ainsi lire les
  // notifications, puis cibler honnêtement « relance la facture F-… » sans repli silencieux.
  const agentContext = useMemo<AgentContext>(() => {
    if (!feedFresh) {
      return {
        screen: { name: 'notifications', instanceId: 'notifications' },
        entities: [],
        capabilities: [],
      };
    }
    const entities: AgentContext['entities'][number][] = feed.items.slice(0, 12).map((item) => ({
      type: 'notification',
      id: item.id,
      label: item.title,
    }));
    const seenInvoices = new Set<string>();
    for (const entry of [...feed.due, ...feed.scheduled]) {
      if (entities.length >= 20 || seenInvoices.has(entry.invoiceId)) continue;
      seenInvoices.add(entry.invoiceId);
      entities.push({
        type: 'invoice',
        id: entry.invoiceId,
        label: entry.docNumber ? `Facture ${entry.docNumber}` : `Facture de ${entry.customerName}`,
      });
    }
    return {
      screen: { name: 'notifications', instanceId: 'notifications' },
      entities,
      capabilities: ['screen.read', 'notification.read', 'invoice.read'],
    };
  }, [feed.due, feed.items, feed.scheduled, feedFresh]);
  usePublishAgentContext(agentContext);

  const planCount = feed.due.length + feed.scheduled.length;
  /** « clients en file » (réf : « Actives · 2 clients en file ») — clients uniques du plan réel. */
  const queuedCustomers = new Set([...feed.due, ...feed.scheduled].map((e) => e.customerId)).size;
  const hasNews = feed.count > 0 || feed.scheduled.length > 0 || feed.items.length > 0;

  /** Item du fil : lu persisté (serveur) + deep link vers la pièce si la notif en porte un. */
  const openFeedItem = (item: NotificationView): void => {
    if (feedFresh && item.readAt === null) {
      markRead.mutate(item.id, {
        onError: () => notify(t('notif.markReadError', { personality }), 'danger'),
      });
    }
    const route = parseAllowlistedPushRoute(item.route);
    if (route !== null) router.push(route as Href);
  };

  /** Parité manuel ↔ Bob : preview serveur frais, consentement, puis même commande read-through. */
  const markAllNotificationsRead = async (): Promise<void> => {
    if (!feedFreshRef.current) return;
    const refreshed = await unreadPreview.refetch();
    const preview = refreshed.data;
    if (refreshed.isError || preview === undefined) {
      // Échec de LECTURE (preview) : éphémère retryable → toast danger.
      notify(t('notif.markAllError', { personality }), 'danger');
      return;
    }
    if (preview.unreadCount === 0) {
      notify(t('notif.markAllNoop', { personality }));
      return;
    }
    const confirmBodyKey: I18nKey =
      preview.unreadCount === 1 ? 'notif.markAllConfirmBodyOne' : 'notif.markAllConfirmBody';
    const accepted = await confirm({
      title: t('notif.markAllConfirmTitle', { personality }),
      message: t(confirmBodyKey, {
        personality,
        params: { count: preview.unreadCount },
      }),
      challenge: { kind: 'tap' },
    });
    if (!accepted || !feedFreshRef.current) return;
    markAllRead.mutate(preview.throughCreatedAt, {
      onSuccess: (result) => {
        const successKey: I18nKey =
          result.updatedCount === 0
            ? 'notif.markAllNoop'
            : result.updatedCount === 1
              ? 'notif.markAllSuccessOne'
              : 'notif.markAllSuccess';
        notify(
          t(successKey, {
            personality,
            params: { count: result.updatedCount },
          }),
          result.updatedCount === 0 ? undefined : 'success',
        );
      },
      // Échec de la COMMANDE : appelable au support → ErrorSheet 2 faces (corrélation).
      onError: (e) =>
        showErrorFacts(
          t('errors.sheetTitle', { personality }),
          mutationFacts(e, t('notif.markAllError', { personality })),
        ),
    });
  };

  /** ENVOI RÉEL confirmé (C25 ② — action sortante, mise en demeure jamais sans validation). */
  const relanceNow = async (entry: RelancePlanEntry): Promise<void> => {
    if (!feedFreshRef.current) return;
    const name = entry.customerName || displayDoc(entry.docNumber, entry.invoiceId);
    const body = t('relance.confirmBody', {
      personality,
      params: { name, amount: formatEURWhole(entry.amountCents) },
    });
    const message =
      entry.tone === 'miseendemeure' ? `${body}\n${t('relance.confirmMedNote', { personality })}` : body;
    const okToSend = await confirm({
      title: t('relance.confirmTitle', { personality }),
      message,
      challenge: { kind: 'tap' },
      destructive: entry.tone === 'miseendemeure',
    });
    if (!okToSend) return;
    if (
      !feedFreshRef.current
      || dueRelanceProofsRef.current.get(entry.invoiceId) !== relanceProof(entry)
    ) {
      notify(t('notif.dataError', { personality }), 'danger');
      feed.refetch();
      return;
    }
    sendRelance.mutate(entry.invoiceId, {
      onSuccess: (result) =>
        notify(
          t(result.status === 'done' ? 'relance.sentToast' : 'relance.queuedToast', {
            personality,
            params: { name },
          }),
          'success',
        ),
      // Un envoi de relance raté = L'échec appelable au support (envoi réel sortant).
      onError: (e) =>
        showErrorFacts(
          t('errors.sheetTitle', { personality }),
          mutationFacts(e, t('relance.sendError', { personality })),
        ),
    });
  };

  return (
    <View style={{ flex: 1, backgroundColor: colors.bg }}>
      {/* BackHeader kit — dernier écran hors lane à réimplémenter le duo back-row +
          InnerScreenHeader (sur-espace retour→titre absorbé par le composant promu). */}
      <BackHeader
        backLabel={t('notif.back', { personality })}
        onBack={() => router.back()}
        eyebrow={t('notif.eyebrow', { personality })}
        title={t('notif.title', { personality })}
        subtitle={t('notif.subtitle', { personality })}
      />

      <ScrollView
        style={{ flex: 1 }}
        contentContainerStyle={{
          paddingHorizontal: spacing.gutter,
          paddingTop: 14,
          paddingBottom: bobScrollInsets.paddingBottom,
          gap: spacing.intraGap,
        }}
        automaticallyAdjustKeyboardInsets={bobScrollInsets.automaticallyAdjustKeyboardInsets}
        scrollIndicatorInsets={{ bottom: bobScrollInsets.scrollIndicatorBottom }}
        showsVerticalScrollIndicator={false}
        refreshControl={
          <RefreshControl
            refreshing={feed.isRefetching}
            onRefresh={feed.refetch}
            tintColor={colors.ink800}
            colors={[colors.ink800]}
          />
        }
      >
        {pushConsent.surface === 'primer' ? (
          <PushConsentCard consent={pushConsent} personality={personality} onToast={notify} />
        ) : null}
        {!serverSnapshotReady && !blockingError ? (
          <NotificationsSkeleton />
        ) : blockingError ? (
          <ErrorRetry
            message={t('notif.dataError', { personality })}
            onRetry={feed.refetch}
            retrying={feed.isRefetching}
          />
        ) : feed.isLoading ? (
          <NotificationsSkeleton />
        ) : staleFeed ? (
          <View style={{ gap: spacing.intraGap }}>
            <ErrorRetry
              message={t('notif.dataError', { personality })}
              onRetry={feed.refetch}
              retrying={feed.isRefetching}
            />
            {feed.items.length > 0 ? (
              <View>
                <SectionHeader title={t('notif.sectionFeed', { personality })} />
                <View style={{ gap: spacing.itemGap }}>
                  {feed.items.map((item) => (
                    <FeedItemCard key={item.id} item={item} personality={personality} onPress={openFeedItem} />
                  ))}
                </View>
              </View>
            ) : null}
          </View>
        ) : !hasNews ? (
          // 0 notification : état vide de premier rang — la voix de Bob, aucune carte fantôme.
          <Card>
            <EmptyState body={t('notif.empty', { personality })} />
          </Card>
        ) : (
          <View style={{ gap: spacing.sectionGap }}>
            {/* Cascade d'entrée fail-closed (signature des écrans frères) : chaque section fond
                en entrant AU premier rendu du contenu — éteinte par construction sous
                reduce-motion (FadeIn kit), jamais rejouée par un refetch. */}
            <StaggeredList>
            {feed.items.length > 0 ? (
              <View>
                <SectionHeader
                  title={t('notif.sectionFeed', { personality })}
                  action={
                    feedFresh
                    && !unreadPreview.isError
                    && unreadPreview.data !== undefined
                    && unreadPreview.data.unreadCount > 0 ? (
                      <Button
                        title={t('notif.markAllAction', { personality })}
                        accessibilityLabel={t('notif.markAllActionA11y', {
                          personality,
                          params: { count: unreadPreview.data.unreadCount },
                        })}
                        variant="secondary"
                        size="compact"
                        radius={11}
                        loading={unreadPreview.isFetching || markAllRead.isPending}
                        onPress={() => void markAllNotificationsRead()}
                      />
                    ) : undefined
                  }
                />
                <View style={{ gap: spacing.itemGap }}>
                  {feed.items.map((item) => (
                    <FeedItemCard key={item.id} item={item} personality={personality} onPress={openFeedItem} />
                  ))}
                </View>
              </View>
            ) : null}

            {feed.due.length > 0 ? (
              <View>
                <SectionHeader title={t('notif.sectionDue', { personality })} />
                <View style={{ gap: spacing.itemGap }}>
                  {feed.due.map((entry) => (
                    <DueRelanceCard
                      key={entry.invoiceId}
                      entry={entry}
                      personality={personality}
                      sending={sendRelance.isPending && sendRelance.variables === entry.invoiceId}
                      onRelance={(e) => void relanceNow(e)}
                    />
                  ))}
                </View>
              </View>
            ) : null}

            {feed.upcoming.length > 0 ? (
              <View>
                <SectionHeader title={t('notif.sectionUpcoming', { personality })} />
                <View style={{ gap: spacing.itemGap }}>
                  {feed.upcoming.map((entry) => (
                    <UpcomingDueCard key={entry.invoiceId} entry={entry} personality={personality} />
                  ))}
                </View>
              </View>
            ) : null}

            {feed.conformite ? (
              <Card padding={13}>
                {/* Conformité reste 'b2g' (Chorus Pro, légitime) — mais la carte répond au
                    doigt comme ses sœurs (elle était morte au toucher) et le chevron est
                    celui des contrôles. */}
                <Pressable
                  accessibilityRole="button"
                  accessibilityLabel={`${t('notif.conformiteTitle', { personality })}. ${t('notif.conformiteSub', { personality })}`}
                  onPress={() => router.push('/diagnostic')}
                  style={({ pressed }) => ({
                    flexDirection: 'row',
                    alignItems: 'center',
                    gap: 12,
                    opacity: pressed ? 0.65 : 1,
                  })}
                >
                  <IconTile tone="b2g" size={34} radius={11}>
                    <ShieldIcon color={semantic.b2g} size={16} strokeWidth={2} />
                  </IconTile>
                  <View style={{ flex: 1 }}>
                    <Text style={[font('body', 600), { color: colors.ink800 }]}>
                      {t('notif.conformiteTitle', { personality })}
                    </Text>
                    <Text style={[font('meta'), { color: colors.slate500, marginTop: 2 }]}>
                      {t('notif.conformiteSub', { personality })}
                    </Text>
                  </View>
                  <ChevronRightIcon color={controls.chevron} size={15} />
                </Pressable>
              </Card>
            ) : null}

            {planCount > 0 ? (
              <View>
                <SectionHeader title={t('notif.sectionScheduled', { personality })} />
                <View style={{ gap: spacing.itemGap }}>
                  {/* Relances auto : INFORMATIF (cron serveur réel, aucun réglage exposé → pas
                      de toggle fantôme). C'est BOB qui relance : canal indigo déclaré 'ai'. */}
                  <Card padding={13}>
                    <View style={{ flexDirection: 'row', alignItems: 'center', gap: 12 }}>
                      <IconTile tone="ai" size={34} radius={11}>
                        <SendIcon color={semantic.ai} size={16} />
                      </IconTile>
                      <View style={{ flex: 1 }}>
                        <Text style={[font('body', 700), { color: colors.ink800 }]}>
                          {t('relance.autoTitle', { personality })}
                        </Text>
                        <Text style={[font('meta'), { color: colors.slate500, marginTop: 1 }]}>
                          {queuedCustomers === 1
                            ? t('relance.queueOne', { personality })
                            : t('relance.queue', { personality, params: { count: queuedCustomers } })}
                        </Text>
                      </View>
                    </View>
                  </Card>
                  {feed.scheduled.map((entry) => (
                    <ScheduledRelanceRow key={entry.invoiceId} entry={entry} personality={personality} />
                  ))}
                  {/* Garde-fou du proto — StatusStrip kit tone danger : l'encre foncée AA
                      (surfaceTint.light.danger.ink) remplace le danger nu 4,1:1 sur dangerBg. */}
                  <StatusStrip tone="danger" label={t('relance.medWarning', { personality })} />
                </View>
              </View>
            ) : null}
            </StaggeredList>
          </View>
        )}
        {/* Après un refus ou « plus tard », l'affordance reste récupérable mais quitte le haut
            de page : aucun nag répété, seulement un réglage passif en fin de fil. */}
        {pushConsent.surface !== 'hidden' && pushConsent.surface !== 'primer' ? (
          <PushConsentCard consent={pushConsent} personality={personality} onToast={notify} />
        ) : null}
      </ScrollView>

      {/* Le TONE dessine le glyphe (coche verte / croix danger on-dark) — fin de l'icône
          CheckIcon codée en dur qui mettait une coche de succès sur les échecs. */}
      <Toast
        message={toast?.message ?? ''}
        visible={toast !== null}
        onHide={() => setToast(null)}
        {...(toast?.tone !== undefined ? { tone: toast.tone } : {})}
      />
      {errorSheet}
    </View>
  );
}
