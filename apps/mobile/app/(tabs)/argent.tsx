/**
 * Argent — le vrai état des comptes (claim C11, réfs claims/ref/C11-frame-p1/p2.png + astuce).
 * Composition 100 % @bob/ui : InnerScreenHeader → HeroMoneyCard (« te verser », pill sans risque)
 * → grand-livre « Argent disponible réel » badge LE SOLDE MENT (MoneyRow lead + rangées signées
 * + total) → « Prévision de tréso » (SegmentedControl 7/30/60/90 j × Optimiste/Réaliste/Prudent)
 * → « À surveiller » (mauvais payeurs réels) → « Mise de côté auto » (réserve TVA + charges)
 * → astuce première fois (dismiss persisté SecureStore) → Fab.
 *
 * DONNÉES RÉELLES (A1-C10 généralisé) : tout vient des queries du BobClient —
 * useCashflow(scenario, horizon) pour héros/prévision (série 4 horizons → cashflowBand @bob/core) ;
 * le grand-livre est dérivé dans @bob/core (buildLedgerView, use case pur testé) depuis
 * listInvoices + listExpenses + listAccountingEntries ; la réserve = buildLedgerView().reserve.
 * AUCUN repli fixtures : loading → skeletons · erreur → voix de Bob (argent.dataError) sans
 * chiffre inventé · donnée absente → « — » par ligne (cotisations & abonnements : aucune source
 * côté client aujourd'hui → « — », TODO C40).
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
import { Modal, Pressable, ScrollView, Text, View } from 'react-native';
import { useRouter } from 'expo-router';
import { Feather, Ionicons } from '@expo/vector-icons';
import {
  buildLedgerView,
  cashflowBand,
  formatEUR,
  type CashflowBand,
  type CashflowSeriesPoint,
  type FiscalDeadline,
  type Horizon,
  type Scenario,
} from '@bob/core';
import { patterns, shadowNative } from '@bob/tokens';
import { deriveAgedBalance, AGED_BUCKETS, type AgedBucketKey } from '@bob/core';
import { t, type I18nKey, type Personality } from '@bob/i18n';
import {
  Avatar,
  Button,
  Card,
  Fab,
  HeroMoneyCard,
  InnerScreenHeader,
  MoneyRow,
  MoneyText,
  SectionHeader,
  SegmentedControl,
  StatusBadge,
  font,
  useTheme,
} from '@bob/ui';
import {
  useAccountingEntries,
  useCashflow,
  useCustomers,
  useExpenses,
  useFiscalCalendar,
  useInvoices,
} from '../../src/data/hooks';
import { useFirstTimeTip } from '../../src/data/tips';

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

/** Barre de skeleton (chargement) — même gabarit que la donnée qu'elle remplace. */
function SkeletonBar({ width, height = 15 }: { width: `${number}%`; height?: number }) {
  const { colors } = useTheme();
  return <View style={{ height, width, borderRadius: 6, backgroundColor: colors.lineSoft }} />;
}

/**
 * Héros sans donnée (chargement ou erreur) : même géométrie que la HeroMoneyCard
 * (radius 24, padding 20) — jamais un montant inventé (A1-C10).
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
        <View style={{ marginTop: 10 }}>
          <SkeletonBar width="52%" height={34} />
        </View>
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
  return y === String(new Date().getFullYear()) ? `${Number(d)} ${month}` : `${Number(d)} ${month} ${y}`;
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
          style={[font('label', 700), { fontSize: 13.5, color: colors.ink800, fontVariant: ['tabular-nums'] }]}
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

/** Skeleton d'une rangée du grand-livre. */
function SkeletonMoneyRow({ divider = true }: { divider?: boolean }) {
  return (
    <View
      style={{
        flexDirection: 'row',
        alignItems: 'center',
        justifyContent: 'space-between',
        paddingVertical: 12,
        ...(divider ? { borderBottomWidth: 1, borderBottomColor: patterns.moneyRow.divider } : {}),
      }}
    >
      <SkeletonBar width="45%" />
      <SkeletonBar width="20%" />
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
  if (!visible) return null;
  return (
    <Modal transparent visible animationType="fade" statusBarTranslucent onRequestClose={onDismiss}>
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
          <Text style={[font('body'), { color: colors.slate500, lineHeight: 21, marginTop: 6, marginBottom: 15 }]}>
            {t('argent.tipBody', { personality })}
          </Text>
          <Button title={t('argent.tipCta', { personality })} variant="primary" onPress={onDismiss} />
        </View>
      </View>
    </Modal>
  );
}

export default function Argent() {
  const { personality, colors, semantic } = useTheme();
  const router = useRouter();
  const tip = useFirstTimeTip(TIP_KEY);

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

  // Héros « te verser » : payout prudent 30 j (= « sans risque ») ; le « monter à » = optimiste.
  const heroSafe = useCashflow('prudent', 30);
  const heroUp = useCashflow('optimiste', 30);

  // Grand-livre : les agrégats réels du client, dérivés en use case pur @bob/core.
  const invoices = useInvoices();
  const expenses = useExpenses();
  const entries = useAccountingEntries();
  const customers = useCustomers();

  const ledger = useMemo(
    () =>
      buildLedgerView({
        invoices: invoices.data,
        expenses: expenses.data,
        accountingEntries: entries.data,
      }),
    [invoices.data, expenses.data, entries.data],
  );
  const ledgerLoading = invoices.isLoading || expenses.isLoading || entries.isLoading;

  // C-EXP-UI1 : échéancier fiscal 90 j — dates dérivées de la fiche société, aucun montant en v1.
  const fiscal = useFiscalCalendar();

  // E5 : balance âgée clients (deriveAgedBalance @bob/core — même vérité pour Bob).
  const aged = useMemo(() => {
    const d = new Date();
    const today = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
    return deriveAgedBalance({ invoices: invoices.data ?? [], customers: customers.data ?? [], today });
  }, [invoices.data, customers.data]);

  const series: CashflowSeriesPoint[] = [];
  if (cash7.data) series.push({ horizon: 7, projection: cash7.data });
  if (cash30.data) series.push({ horizon: 30, projection: cash30.data });
  if (cash60.data) series.push({ horizon: 60, projection: cash60.data });
  if (cash90.data) series.push({ horizon: 90, projection: cash90.data });
  const band = cashflowBand(series, horizon);
  const bandTone = band === 'creux' ? semantic.warning : semantic.success;

  // « À surveiller » : mauvais payeurs réels (score @bob/core), encours décroissant.
  const risky = (customers.data ?? [])
    .filter((c) => c.scoreBand === 'red' && c.outstanding > 0)
    .sort((a, b) => b.outstanding - a.outstanding);
  const topRisk = risky[0];

  const hasError =
    cash7.isError ||
    cash30.isError ||
    cash60.isError ||
    cash90.isError ||
    heroSafe.isError ||
    heroUp.isError ||
    invoices.isError ||
    expenses.isError ||
    entries.isError ||
    customers.isError;

  // Phrase conditionnelle du héros : upside réel (optimiste > prudent) + le retardataire réel.
  const heroCaption =
    heroSafe.data && heroUp.data && topRisk && heroUp.data.payout > heroSafe.data.payout
      ? t('argent.heroUpside', {
          personality,
          params: {
            upTo: formatEUR(heroUp.data.payout),
            name: topRisk.name,
            amount: formatEUR(topRisk.outstanding),
          },
        })
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
      <ScrollView style={{ flex: 1 }} contentContainerStyle={{ paddingBottom: 140 }}>
        <InnerScreenHeader
          eyebrow={t('argent.eyebrow', { personality })}
          title={t('argent.title', { personality })}
          subtitle={t('argent.subtitle', { personality })}
        />

        <View style={{ paddingHorizontal: 18 }}>
          {/* ── Héros « te verser » ─────────────────────────────────────────── */}
          <View style={{ marginTop: 16 }}>
            {heroSafe.data ? (
              <HeroMoneyCard
                label={t('argent.heroLabel', { personality })}
                amountCents={heroSafe.data.payout}
                pill={t('argent.heroPill', { personality })}
                caption={heroCaption}
              />
            ) : (
              <HeroPlaceholder loading={heroSafe.isLoading} />
            )}
          </View>

          {hasError ? (
            <Card style={{ marginTop: 14 }}>
              <Text style={[font('sub'), { color: colors.slate500 }]}>
                {t('argent.dataError', { personality })}
              </Text>
            </Card>
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
                <SkeletonMoneyRow />
                <SkeletonMoneyRow />
                <SkeletonMoneyRow />
                <SkeletonMoneyRow />
                <SkeletonMoneyRow />
                <SkeletonMoneyRow divider={false} />
              </>
            ) : (
              <>
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
                  <MoneyRow label={t('argent.rowVat', { personality })} amountCents={ledger.vatCents} />
                ) : (
                  <EmptyMoneyRow label={t('argent.rowVat', { personality })} />
                )}
                {/* Cotisations & abonnements : aucune source côté client → « — » (TODO C40). */}
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
              </>
            )}
          </Card>

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
                <>
                  <MoneyText cents={forecast.data.available} variant="big" color={bandTone} />
                  {band !== null ? (
                    <Text style={[font('meta'), { fontSize: 12.5, color: bandTone }]}>
                      {t(BAND_LABEL[band], { personality })}
                    </Text>
                  ) : null}
                </>
              ) : forecast.isLoading ? (
                <SkeletonBar width="38%" height={21} />
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
          </Card>

          {/* ── À surveiller (liste risques si données) ─────────────────────── */}
          {customers.isLoading ? (
            <View style={{ marginTop: 18 }}>
              <SectionHeader title={t('argent.watchTitle', { personality })} />
              <Card>
                <SkeletonMoneyRow divider={false} />
              </Card>
            </View>
          ) : risky.length > 0 ? (
            <View style={{ marginTop: 18 }}>
              <SectionHeader title={t('argent.watchTitle', { personality })} />
              <View style={{ gap: 11 }}>
                {risky.slice(0, 3).map((customer) => (
                  <Card key={customer.id} radius={18} padding={14}>
                    <View style={{ flexDirection: 'row', alignItems: 'center', gap: 11 }}>
                      <Avatar name={customer.name} size={38} shape="squircle" />
                      <View style={{ flex: 1 }}>
                        <View style={{ flexDirection: 'row', alignItems: 'center', gap: 7 }}>
                          <Text
                            numberOfLines={1}
                            style={[font('button'), { fontSize: 14.5, color: colors.ink800, flexShrink: 1 }]}
                          >
                            {customer.name}
                          </Text>
                          <StatusBadge
                            label={t('argent.watchLateBadge', { personality }).toUpperCase()}
                            variant="danger"
                          />
                        </View>
                        <Text style={[font('meta'), { fontSize: 12.5, color: colors.slate400, marginTop: 1 }]}>
                          {t('argent.watchOutstanding', {
                            personality,
                            params: { amount: formatEUR(customer.outstanding) },
                          })}
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
                  onPress={() => router.push({ pathname: '/(tabs)/assistant', params: { prompt: 'relance' } })}
                />
              </View>
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
            <Text style={[font('label'), { fontWeight: '500', color: colors.slate500, marginTop: 3 }]}>
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
                      <SkeletonBar width="55%" height={17} />
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
                      <Text style={{ ...font('label'), color: colors.ink800, fontVariant: ['tabular-nums'] }}>
                        {formatEUR(aged.totalCents)}
                      </Text>
                    ),
                  }
                : {})}
            />
            {ledgerLoading ? (
              <Card>
                <SkeletonBar width="62%" />
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
                    style={{
                      flexDirection: 'row',
                      alignItems: 'center',
                      gap: 10,
                      paddingVertical: 12,
                      borderBottomWidth: index < top.length - 1 ? 1 : 0,
                      borderBottomColor: colors.lineSoft,
                    }}
                  >
                    <Text style={{ ...font('body', 700), fontSize: 14, color: colors.ink800, flex: 1 }} numberOfLines={1}>
                      {line.customerName}
                    </Text>
                    {line.maxDaysLate > 0 ? (
                      <StatusBadge
                        label={t('argent.agedDays', { personality, params: { days: line.maxDaysLate } })}
                        variant={line.maxDaysLate > 90 ? 'danger' : 'particulier'}
                      />
                    ) : null}
                    <Text style={{ ...font('sub', 700), color: colors.ink800, fontVariant: ['tabular-nums'] }}>
                      {formatEUR(line.totalCents)}
                    </Text>
                  </Pressable>
                ))}
                {aged.overdueCents > 0 ? (
                  <Text style={[font('meta', 500), { color: colors.slate400, paddingTop: 4, paddingBottom: 10 }]}>
                    {t('argent.agedOverdue', { personality, params: { amount: formatEUR(aged.overdueCents) } })}
                  </Text>
                ) : null}
              </Card>
            )}
          </View>

          {/* ── À venir — échéancier fiscal (C-EXP-UI1 : dates réelles, jamais de montant) ── */}
          <View style={{ marginTop: 20 }}>
            <SectionHeader title={t('argent.upcomingTitle', { personality })} />
            {fiscal.isLoading ? (
              <Card>
                <SkeletonMoneyRow />
                <SkeletonMoneyRow divider={false} />
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
            )}
          </View>
        </View>
      </ScrollView>

      <Fab onPress={() => router.push('/devis/new')} accessibilityLabel="Nouveau devis" />

      <FirstTimeTip visible={tip.visible} onDismiss={tip.dismiss} />
    </View>
  );
}
