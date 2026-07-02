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
  type Horizon,
  type Scenario,
} from '@bob/core';
import { patterns, shadowNative } from '@bob/tokens';
import { t, type I18nKey } from '@bob/i18n';
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
                  onPress={() => router.push('/(tabs)/assistant')}
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
        </View>
      </ScrollView>

      <Fab onPress={() => router.push('/devis/new')} accessibilityLabel="Nouveau devis" />

      <FirstTimeTip visible={tip.visible} onDismiss={tip.dismiss} />
    </View>
  );
}
