/**
 * Notifications — la cloche C10 enfin câblée (claim C25, réf dc.html §showNotifs + §showRelances).
 *
 * DONNÉES RÉELLES, une seule vérité : useNotificationsFeed (hooks) compose les queries partagées
 * (factures + clients + diagnostic) et projette via @bob/core — deriveRelancePlan (relances dues
 * et planifiées, ton escaladé par ancienneté, message buildRelance) + deriveUpcomingDues
 * (échéances ≤ 7 j) + todayCompanyFromDiagnostic (conformité e-invoicing). L'écran ne calcule
 * AUCUNE règle ; aucun repli fixtures : pas de données → état vide de premier rang (voix Bob).
 *
 * PARITÉ D'ACTIONS (directive 23:52) : « Relancer » → /(tabs)/assistant?prompt=relance — le MÊME
 * point d'entrée que l'agent (relance_brouillon, désormais ciblable C25 ①) ; « Voir la pièce » →
 * /facture/[id] (C16) ; conformité → /diagnostic (C23).
 *
 * Écarts assumés vs proto (honnêteté avant pixel) :
 * · « Tout marquer lu » et le toggle « Relances automatiques » : AUCUNE persistance/endpoint côté
 *   serveur (constaté apps/api) → pas de bouton fantôme ; la carte relances auto est informative
 *   (le cron serveur EST actif : RelanceService 6 h) et la file affichée est le plan réel ;
 * · pas de flux « Bob a relancé / paiement reçu » : aucun endpoint de lecture des
 *   notification_jobs — items dérivés de l'état réel uniquement (relances, échéances, conformité) ;
 * · la cadence (J+3/10/20/30, DEFAULT_RELANCE_POLICY) est portée par @bob/core, pas éditable ici
 *   tant que le serveur n'expose pas de réglage (écran cadence du proto non construit).
 */
import { Pressable, ScrollView, Text, View } from 'react-native';
import { useRouter } from 'expo-router';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import {
  formatEURWhole,
  type RelancePlanEntry,
  type RelanceTone,
  type UpcomingDueEntry,
} from '@bob/core';
import { PERSONALITY_LABELS, t, type I18nKey, type Personality } from '@bob/i18n';
import {
  Avatar,
  Button,
  Card,
  IconTile,
  InnerScreenHeader,
  SectionHeader,
  StatusBadge,
  font,
  useTheme,
  type StatusBadgeVariant,
} from '@bob/ui';
import { useNotificationsFeed } from '../src/data/hooks';
import {
  CalendarIcon,
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

// ── Cartes ────────────────────────────────────────────────────────────────────

/** Relance DUE : ton badgé + reste dû + actions (voir la pièce / relancer via l'assistant). */
function DueRelanceCard({ entry, personality }: { entry: RelancePlanEntry; personality: Personality }) {
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
          icon={<SendIcon color={colors.surface} size={14} />}
          // ?prompt=relance : l'assistant pré-remplit ET soumet (C15) — même use case que Bob.
          onPress={() => router.push({ pathname: '/(tabs)/assistant', params: { prompt: 'relance' } })}
        />
      </View>
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
  // La copy des messages du plan suit l'humeur de Bob (PERSONALITY_LABELS : ids i18n → domaine).
  const feed = useNotificationsFeed(PERSONALITY_LABELS[personality]);

  const ready = !feed.isLoading && !feed.isError;
  const planCount = feed.due.length + feed.scheduled.length;
  /** « clients en file » (réf : « Actives · 2 clients en file ») — clients uniques du plan réel. */
  const queuedCustomers = new Set([...feed.due, ...feed.scheduled].map((e) => e.customerId)).size;
  const hasNews = feed.count > 0 || feed.scheduled.length > 0;

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
            {feed.due.length > 0 ? (
              <View>
                <SectionHeader title={t('notif.sectionDue', { personality })} />
                <View style={{ gap: 10 }}>
                  {feed.due.map((entry) => (
                    <DueRelanceCard key={entry.invoiceId} entry={entry} personality={personality} />
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
    </View>
  );
}
