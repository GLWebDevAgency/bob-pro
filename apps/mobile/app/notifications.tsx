/**
 * Notifications — la cloche C10 enfin câblée (claim C25 v2, réf dc.html §showNotifs + §showRelances).
 *
 * DONNÉES RÉELLES, une seule vérité : useNotificationsFeed (hooks) compose
 * · le FIL SERVEUR (GET /notifications — jobs réels : relances envoyées/en retry ; lu/non-lu
 *   PERSISTÉS via POST /notifications/:id/read ; le LocalBobClient dérive en démo) ;
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
 * · « Tout marquer lu » : le lu se pose item par item (endpoint unitaire) — pas de bouton global
 *   tant que le serveur n'expose pas de batch ;
 * · l'écran cadence éditable du proto n'existe pas (pas de réglage serveur) — la mise en demeure
 *   n'est JAMAIS envoyée par le cron : elle attend le geste confirmé ici (relance.medWarning).
 */
import { useState } from 'react';
import { Pressable, ScrollView, Text, View } from 'react-native';
import { useRouter, type Href } from 'expo-router';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import {
  formatEUR,
  formatEURWhole,
  type RelancePlanEntry,
  type RelanceTone,
  type UpcomingDueEntry,
} from '@bob/core';
import type { NotificationView } from '@bob/api-client';
import { PERSONALITY_LABELS, t, type I18nKey, type Personality } from '@bob/i18n';
import {
  Avatar,
  Button,
  Card,
  IconTile,
  InnerScreenHeader,
  SectionHeader,
  StatusBadge,
  Toast,
  font,
  useTheme,
  type StatusBadgeVariant,
} from '@bob/ui';
import { useMarkNotificationRead, useNotificationsFeed, useSendRelance } from '../src/data/hooks';
import { useConfirm } from '../src/components/ConfirmSheet';
import {
  CalendarIcon,
  CheckIcon,
  ChevronLeftIcon,
  ChevronRightIcon,
  SendIcon,
  ShieldIcon,
} from '../src/components/icons';

// ── Ton → pastel/badge (réf §showRelances : cordial ambre, ferme/mise en demeure rouge) ──
const TONE_BADGE: Record<RelanceTone, StatusBadgeVariant> = {
  cordial: 'particulier',
  neutre: 'b2b',
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

function toneColor(tone: RelanceTone, semantic: { particulier: string; b2b: string; danger: string }): string {
  return TONE_BADGE[tone] === 'danger' ? semantic.danger : TONE_BADGE[tone] === 'b2b' ? semantic.b2b : semantic.particulier;
}

// ── Expertise par facture échue (C-EXP-UI1 — données du moteur, ZÉRO calcul ici) ──

/** Pastille de prescription par palier d'urgence (P04 derivePrescription) — couleurs sémantiques. */
function prescriptionDisplay(
  prescription: NonNullable<RelancePlanEntry['prescription']>,
  personality: Personality,
  palette: { success: string; warning: string; danger: string; far: string },
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
        dot: palette.warning,
        color: palette.warning,
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
          danger: semantic.danger,
          far: colors.slate400,
        })
      : null;
  if (penaltiesLine === null && chrono === null) return null;

  return (
    <View style={{ marginTop: 8, gap: 4 }}>
      {penaltiesLine !== null ? (
        <Text style={[font('meta', 600), { color: semantic.warning, fontVariant: ['tabular-nums'] }]}>
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
          <SendIcon color={toneColor(entry.tone, semantic)} size={16} />
        </IconTile>
        <View style={{ flex: 1 }}>
          <Text style={[font('label', 600), { fontSize: 14, color: colors.ink800 }]}>
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
      <View style={{ flexDirection: 'row', gap: 8, marginTop: 13 }}>
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
  return (
    <Card padding={13}>
      <Pressable
        accessibilityRole="button"
        accessibilityLabel={item.title}
        accessibilityState={{ selected: item.readAt === null }}
        onPress={() => onPress(item)}
        style={{ flexDirection: 'row', alignItems: 'center', gap: 12 }}
      >
        <IconTile tone={item.status === 'failed' ? 'danger' : 'b2g'} size={34} radius={11}>
          <SendIcon color={item.status === 'failed' ? semantic.danger : semantic.b2g} size={16} />
        </IconTile>
        <View style={{ flex: 1 }}>
          <Text
            numberOfLines={1}
            style={[font('label', item.readAt === null ? 700 : 600), { fontSize: 14, color: colors.ink800 }]}
          >
            {item.title}
          </Text>
          <Text style={[font('meta'), { color: statusColor, marginTop: 2 }]}>
            {`${t(statusKey, { personality })} · ${frDate(item.createdAt.slice(0, 10))}`}
          </Text>
        </View>
        {item.readAt === null ? (
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
  return (
    <Card padding={13}>
      <Pressable
        accessibilityRole="button"
        accessibilityLabel={t('notif.itemDueTitle', { personality, params: { name } })}
        onPress={() => router.push(`/facture/${entry.invoiceId}`)}
        style={{ flexDirection: 'row', alignItems: 'center', gap: 12 }}
      >
        <IconTile tone="particulier" size={34} radius={11}>
          <CalendarIcon color={semantic.particulier} size={16} />
        </IconTile>
        <View style={{ flex: 1 }}>
          <Text style={[font('label', 600), { fontSize: 14, color: colors.ink800 }]}>
            {t('notif.itemDueTitle', { personality, params: { name } })}
          </Text>
          <Text style={[font('meta'), { color: colors.slate500, marginTop: 2 }]}>
            {t(subKey, {
              personality,
              params: { doc, amount: formatEURWhole(entry.amountCents), days: entry.inDays },
            })}
          </Text>
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
          <Text style={[font('label', 600), { fontSize: 14, color: colors.ink800 }]}>{name}</Text>
          <Text style={[font('meta', 600), { color: toneColor(entry.tone, semantic), marginTop: 2 }]}>{line}</Text>
        </View>
        <Text style={[font('label', 700), { fontSize: 14, color: colors.ink800, fontVariant: ['tabular-nums'] }]}>
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
  const { colors } = useTheme();
  return (
    <Card>
      <View style={{ flexDirection: 'row', gap: 12, alignItems: 'center' }}>
        <View style={{ width: 34, height: 34, borderRadius: 11, backgroundColor: colors.lineSoft }} />
        <View style={{ flex: 1, gap: 7 }}>
          <View style={{ height: 14, width: '52%', borderRadius: 6, backgroundColor: colors.lineSoft }} />
          <View style={{ height: 11, width: '74%', borderRadius: 6, backgroundColor: colors.lineSoft }} />
        </View>
      </View>
    </Card>
  );
}

export default function Notifications() {
  const { colors, semantic, personality } = useTheme();
  const insets = useSafeAreaInsets();
  const router = useRouter();
  const confirm = useConfirm();
  // La copy des messages du plan suit l'humeur de Bob (PERSONALITY_LABELS : ids i18n → domaine).
  const feed = useNotificationsFeed(PERSONALITY_LABELS[personality]);
  const markRead = useMarkNotificationRead();
  const sendRelance = useSendRelance();
  const [toast, setToast] = useState<string | null>(null);

  const ready = !feed.isLoading && !feed.isError;
  const planCount = feed.due.length + feed.scheduled.length;
  /** « clients en file » (réf : « Actives · 2 clients en file ») — clients uniques du plan réel. */
  const queuedCustomers = new Set([...feed.due, ...feed.scheduled].map((e) => e.customerId)).size;
  const hasNews = feed.count > 0 || feed.scheduled.length > 0 || feed.items.length > 0;

  /** Item du fil : lu persisté (serveur) + deep link vers la pièce si la notif en porte un. */
  const openFeedItem = (item: NotificationView): void => {
    if (item.readAt === null) markRead.mutate(item.id);
    if (item.route !== null) router.push(item.route as Href);
  };

  /** ENVOI RÉEL confirmé (C25 ② — action sortante, mise en demeure jamais sans validation). */
  const relanceNow = async (entry: RelancePlanEntry): Promise<void> => {
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
    sendRelance.mutate(entry.invoiceId, {
      onSuccess: () => setToast(t('relance.sentToast', { personality, params: { name } })),
      onError: () => setToast(t('relance.sendError', { personality })),
    });
  };

  return (
    <View style={{ flex: 1, backgroundColor: colors.bg }}>
      <View style={{ paddingTop: insets.top + 10, paddingHorizontal: 16 }}>
        <Pressable
          accessibilityRole="button"
          accessibilityLabel={t('notif.back', { personality })}
          onPress={() => router.back()}
          hitSlop={8}
          style={{ flexDirection: 'row', alignItems: 'center', gap: 4, alignSelf: 'flex-start', minHeight: 34 }}
        >
          <ChevronLeftIcon color={colors.ink800} size={18} strokeWidth={2.2} />
          <Text style={[font('label', 600), { fontSize: 15, color: colors.ink800 }]}>
            {t('notif.back', { personality })}
          </Text>
        </Pressable>
      </View>

      <InnerScreenHeader
        eyebrow={t('notif.eyebrow', { personality })}
        title={t('notif.title', { personality })}
        subtitle={t('notif.subtitle', { personality })}
      />

      <ScrollView
        style={{ flex: 1 }}
        contentContainerStyle={{ paddingHorizontal: 18, paddingTop: 14, paddingBottom: insets.bottom + 34 }}
        showsVerticalScrollIndicator={false}
      >
        {feed.isLoading ? (
          <View style={{ gap: 10 }}>
            <SkeletonNotif />
            <SkeletonNotif />
            <SkeletonNotif />
          </View>
        ) : feed.isError ? (
          <Card>
            <Text
              accessibilityRole="alert"
              accessibilityLiveRegion="assertive"
              style={[font('sub'), { color: colors.slate500 }]}
            >
              {t('notif.dataError', { personality })}
            </Text>
            <View style={{ marginTop: 12 }}>
              <Button
                title={t('notif.retry', { personality })}
                variant="secondary"
                size="compact"
                radius={11}
                onPress={feed.refetch}
                style={{ alignSelf: 'flex-start' }}
              />
            </View>
          </Card>
        ) : !hasNews ? (
          // 0 notification : état vide de premier rang — la voix de Bob, aucune carte fantôme.
          <Card>
            <Text style={[font('sub'), { color: colors.slate500 }]}>{t('notif.empty', { personality })}</Text>
          </Card>
        ) : (
          <View style={{ gap: 20 }}>
            {feed.items.length > 0 ? (
              <View>
                <SectionHeader title={t('notif.sectionFeed', { personality })} />
                <View style={{ gap: 10 }}>
                  {feed.items.map((item) => (
                    <FeedItemCard key={item.id} item={item} personality={personality} onPress={openFeedItem} />
                  ))}
                </View>
              </View>
            ) : null}

            {feed.due.length > 0 ? (
              <View>
                <SectionHeader title={t('notif.sectionDue', { personality })} />
                <View style={{ gap: 10 }}>
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
                <View style={{ gap: 10 }}>
                  {feed.upcoming.map((entry) => (
                    <UpcomingDueCard key={entry.invoiceId} entry={entry} personality={personality} />
                  ))}
                </View>
              </View>
            ) : null}

            {feed.conformite ? (
              <Card padding={13}>
                <Pressable
                  accessibilityRole="button"
                  accessibilityLabel={t('notif.conformiteTitle', { personality })}
                  onPress={() => router.push('/diagnostic')}
                  style={{ flexDirection: 'row', alignItems: 'center', gap: 12 }}
                >
                  <IconTile tone="b2g" size={34} radius={11}>
                    <ShieldIcon color={semantic.b2g} size={16} strokeWidth={2} />
                  </IconTile>
                  <View style={{ flex: 1 }}>
                    <Text style={[font('label', 600), { fontSize: 14, color: colors.ink800 }]}>
                      {t('notif.conformiteTitle', { personality })}
                    </Text>
                    <Text style={[font('meta'), { color: colors.slate500, marginTop: 2 }]}>
                      {t('notif.conformiteSub', { personality })}
                    </Text>
                  </View>
                  <ChevronRightIcon color={colors.slate400} size={15} />
                </Pressable>
              </Card>
            ) : null}

            {planCount > 0 ? (
              <View>
                <SectionHeader title={t('notif.sectionScheduled', { personality })} />
                <View style={{ gap: 10 }}>
                  {/* Relances auto : INFORMATIF (cron serveur réel, aucun réglage exposé → pas de toggle fantôme). */}
                  <Card padding={13}>
                    <View style={{ flexDirection: 'row', alignItems: 'center', gap: 12 }}>
                      <IconTile tone="b2g" size={34} radius={11}>
                        <SendIcon color={semantic.b2g} size={16} />
                      </IconTile>
                      <View style={{ flex: 1 }}>
                        <Text style={[font('label', 700), { fontSize: 14.5, color: colors.ink800 }]}>
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
                  {/* Garde-fou du proto : la mise en demeure n'est jamais envoyée sans validation. */}
                  <View
                    style={{
                      flexDirection: 'row',
                      gap: 8,
                      alignItems: 'flex-start',
                      backgroundColor: semantic.dangerBg,
                      borderRadius: 12,
                      paddingVertical: 11,
                      paddingHorizontal: 13,
                    }}
                  >
                    <Text style={[font('meta', 600), { color: semantic.danger, flex: 1, lineHeight: 17 }]}>
                      {t('relance.medWarning', { personality })}
                    </Text>
                  </View>
                </View>
              </View>
            ) : null}

            {ready && feed.count === 0 ? (
              <Text style={[font('meta', 500), { color: colors.slate300, textAlign: 'center', paddingTop: 4 }]}>
                {t('notif.empty', { personality })}
              </Text>
            ) : null}
          </View>
        )}
      </ScrollView>

      <Toast
        message={toast ?? ''}
        visible={toast !== null}
        onHide={() => setToast(null)}
        icon={<CheckIcon color={colors.surface} size={15} />}
      />
    </View>
  );
}
