/**
 * Pilotage (BA-3) — la revue business de l'indépendant : mois en cours (facturé HT vs
 * encaissé TTC à isopérimètre), tendance mois clos + cumul annuel, série mensuelle, DSO,
 * top clients, top postes de dépense, cascade SIG avec ratios. TOUT dérive de
 * deriveBusinessReview (@bob/core) — mêmes chiffres que Bob (getBusinessReview, parité).
 * Pattern écran poussé (A3-C17) : rangée retour sticky + InnerScreenHeader. Honnêteté
 * d'affichage : jamais de % plein-mois sur le mois courant, « — » plutôt qu'un % trompeur,
 * états null assumés (DSO sous 3 mois d'historique). Zéro hex, i18n pilotage.* ×3 humeurs.
 */
import { useMemo, type ReactNode } from 'react';
import { Pressable, ScrollView, Text, View } from 'react-native';
import { useRouter } from 'expo-router';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import {
  deriveBusinessReview,
  formatEUR,
  type BusinessReview,
  type ExpenseCategory,
} from '@bob/core';
import { patterns } from '@bob/tokens';
import { t, type I18nKey } from '@bob/i18n';
import {
  Card,
  EmptyState,
  ErrorRetry,
  InnerScreenHeader,
  SectionHeader,
  SkeletonCard,
  StatusBadge,
  font,
  useTheme,
} from '@bob/ui';
import {
  useAccountingEntries,
  useCompany,
  useCustomers,
  useExpenses,
  useInvoices,
  usePayments,
} from '../src/data/hooks';
import { PaywallCard, useEntitlement } from '../src/monetization/paywall';
import { combineQueryStates } from '../src/data/query-state';
import { usePublishAgentContext, type AgentContext } from '../src/agent';
import { ChevronLeftIcon } from '../src/components/icons';

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

const CAT_KEY: Record<ExpenseCategory, I18nKey> = {
  fournitures: 'dep.catFournitures',
  materiel: 'dep.catMateriel',
  carburant: 'dep.catCarburant',
  repas: 'dep.catRepas',
  sous_traitance: 'dep.catSousTraitance',
  autre: 'dep.catAutre',
};

const pad = (n: number): string => String(n).padStart(2, '0');

/** Date du jour locale (YYYY-MM-DD) — même convention que l'écran Clôture. */
function todayLocal(d: Date = new Date()): string {
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

/** « mai 2026 » depuis une clé AAAA-MM. */
function monthLabel(month: string): string {
  return `${MONTHS[Number(month.slice(5, 7)) - 1]} ${month.slice(0, 4)}`;
}

/** bps signés → « +12,3 » / « −8,1 » (le % est porté par le libellé). */
function pctFromBps(bps: number): string {
  const abs = (Math.abs(bps) / 100).toFixed(1).replace('.', ',');
  return `${bps >= 0 ? '+' : '−'}${abs}`;
}

export default function Pilotage() {
  const { personality, colors, semantic } = useTheme();
  const insets = useSafeAreaInsets();
  const router = useRouter();
  // Entitlement TYPÉ (fondation paywall) — même feature que le gating historique de l'écran.
  const entitlement = useEntitlement('accounting_operations');
  const entries = useAccountingEntries();
  const payments = usePayments();
  const invoices = useInvoices();
  const customers = useCustomers();
  const expenses = useExpenses();
  const company = useCompany();
  const entitled = entitlement.allowed;

  // P1 (audit 14/07) : failed se lit TOUJOURS avec loading — ne jamais confondre un échec
  // réseau avec une absence de données (le pilotage prendrait alors l'air d'un cabinet vide).
  const queryState = combineQueryStates(entries, payments, invoices, customers, expenses, company);

  // Une seule vérité : le MÊME use case pur que Bob (getBusinessReview) — parité garantie.
  const review: BusinessReview | null = useMemo(() => {
    if (queryState.loading) return null;
    return deriveBusinessReview({
      entries: (entries.data ?? []).map((e) => ({ entryDate: e.entryDate, sourceType: e.sourceType, lines: e.lines })),
      payments: (payments.data ?? []).map((p) => ({ amountCents: p.amountCents, receivedAt: p.receivedAt })),
      invoices: (invoices.data ?? []).map((i) => ({
        kind: i.kind,
        status: i.status,
        totals: i.totals,
        paid: i.paid,
        dueAt: i.dueAt,
        customerId: i.customerId,
      })),
      customers: (customers.data ?? []).map((c) => ({ id: c.id, name: c.name })),
      expenses: (expenses.data ?? []).map((e) => ({
        category: e.category,
        totalTtcCents: e.totalTtcCents,
        vatCents: e.vatCents,
        documentDate: e.documentDate,
        status: e.status,
      })),
      vatRegime: company.data?.vatRegime ?? null,
      today: todayLocal(),
    });
  }, [queryState.loading, entries.data, payments.data, invoices.data, customers.data, expenses.data, company.data]);

  // Bob voit les top clients AFFICHÉS : « parle-moi de ce client », « résume l'écran ».
  // Le paywall est une frontière de visibilité : aucune entité ni capability client ne fuit
  // tant que l'offre ne rend pas réellement le pilotage à l'écran.
  const agentContext = useMemo<AgentContext>(
    () => ({
      screen: { name: 'pilotage', instanceId: 'pilotage' },
      entities: entitled
        ? (review?.topClients.lines ?? []).slice(0, 5).map((line) => ({
            type: 'customer' as const,
            id: line.customerId,
            label: line.customerName,
          }))
        : [],
      capabilities: entitled ? ['screen.read', 'customer.read'] : ['screen.read'],
    }),
    [entitled, review],
  );
  usePublishAgentContext(agentContext);

  const section = (title: I18nKey, body: ReactNode, hint?: I18nKey): ReactNode => (
    <View>
      <SectionHeader title={t(title, { personality })} />
      {body}
      {hint ? (
        <Text style={[font('meta'), { color: colors.slate400, marginTop: 6, lineHeight: 16 }]}>{t(hint, { personality })}</Text>
      ) : null}
    </View>
  );

  /** Ligne « libellé …… montant » (+ % du CA optionnel) pour la cascade SIG. */
  function SigRow({ label, cents, bpsOfCa, strong, topBorder }: { label: string; cents: number; bpsOfCa?: number | null; strong?: boolean; topBorder?: boolean }) {
    return (
      <View
        style={{
          flexDirection: 'row',
          justifyContent: 'space-between',
          alignItems: 'baseline',
          gap: 8,
          paddingVertical: strong ? 8 : 6,
          borderTopWidth: topBorder ? 1 : 0,
          borderTopColor: colors.lineSoft,
        }}
      >
        <Text style={[strong ? font('cardTitle') : font('sub'), { color: colors.ink800, flexShrink: 1 }]}>{label}</Text>
        <View style={{ alignItems: 'flex-end' }}>
          <Text
            style={[
              strong ? font('cardTitle') : font('sub'),
              {
                // Agrégats clés (CA/VA/EBE/Résultat) : succès/danger — les autres lignes
                // (charges, impôts…) restent en ton neutre/warning discret.
                color: strong
                  ? cents >= 0
                    ? semantic.success
                    : semantic.danger
                  : cents >= 0
                    ? colors.ink900
                    : semantic.warning,
                fontVariant: ['tabular-nums'],
              },
            ]}
          >
            {cents < 0 ? '−' : ''}
            {formatEUR(Math.abs(cents))}
          </Text>
          {bpsOfCa !== undefined && bpsOfCa !== null ? (
            <Text style={[font('meta'), { color: colors.slate400 }]}>
              {t('pilotage.ratioOfCa', { personality, params: { pct: (bpsOfCa / 100).toFixed(1).replace('.', ',') } })}
            </Text>
          ) : null}
        </View>
      </View>
    );
  }

  /** Barres mensuelles (facturé/encaissé) — View pures, normalisées au max de la fenêtre. */
  function SeriesBars({ data, currentMonth }: { data: BusinessReview['series']; currentMonth: string }) {
    const window = data.slice(-6);
    const max = Math.max(1, ...window.map((p) => Math.max(p.invoicedHtCents, p.collectedTtcCents)));
    return (
      <Card>
        {window.map((point, index) => {
          const isCurrent = point.month === currentMonth;
          return (
            <View
              key={point.month}
              accessible
              accessibilityLabel={`${monthLabel(point.month)}. ${t('pilotage.invoicedLabel', { personality })} ${formatEUR(point.invoicedHtCents)}. ${t('pilotage.collectedLabel', { personality })} ${formatEUR(point.collectedTtcCents)}.`}
              style={{ marginTop: index === 0 ? 0 : 10 }}
            >
              <View style={{ flexDirection: 'row', justifyContent: 'space-between', marginBottom: 4 }}>
                <Text style={[isCurrent ? font('meta', 700) : font('meta'), { color: isCurrent ? colors.ink900 : colors.slate500 }]}>
                  {monthLabel(point.month)}
                </Text>
                <Text style={{ ...font('meta'), color: colors.slate400, fontVariant: ['tabular-nums'] }}>
                  {formatEUR(point.invoicedHtCents)} · {formatEUR(point.collectedTtcCents)}
                </Text>
              </View>
              <View style={{ gap: 3 }}>
                {/* Facturé (ink600) / encaissé (success) — contraste net, plus deux bleus proches. */}
                <View style={{ height: 7, borderRadius: 4, backgroundColor: colors.lineSoft, overflow: 'hidden' }}>
                  <View
                    style={{
                      height: '100%',
                      width: `${Math.round((Math.max(0, point.invoicedHtCents) / max) * 100)}%`,
                      borderRadius: 4,
                      backgroundColor: colors.ink600,
                    }}
                  />
                </View>
                <View style={{ height: 7, borderRadius: 4, backgroundColor: colors.lineSoft, overflow: 'hidden' }}>
                  <View
                    style={{
                      height: '100%',
                      width: `${Math.round((Math.max(0, point.collectedTtcCents) / max) * 100)}%`,
                      borderRadius: 4,
                      backgroundColor: semantic.success,
                    }}
                  />
                </View>
              </View>
            </View>
          );
        })}
        <View style={{ flexDirection: 'row', gap: 14, marginTop: 12 }}>
          {(
            [
              { color: colors.ink600, label: t('pilotage.invoicedLabel', { personality }) },
              { color: semantic.success, label: t('pilotage.collectedLabel', { personality }) },
            ] as const
          ).map((legend) => (
            <View key={legend.label} style={{ flexDirection: 'row', alignItems: 'center', gap: 5 }}>
              <View style={{ width: 8, height: 8, borderRadius: 4, backgroundColor: legend.color }} />
              <Text style={[font('meta'), { color: colors.slate400 }]}>{legend.label}</Text>
            </View>
          ))}
        </View>
      </Card>
    );
  }

  /** Part client colorée selon le risque de concentration — cohérent avec l'alerte existante. */
  function shareRiskColor(shareBps: number | null): string {
    if (shareBps === null) return colors.slate400;
    if (shareBps >= 5000) return semantic.danger;
    // Même seuil que deriveBusinessReview (30 %) : l'alerte texte et la couleur ne divergent pas.
    if (shareBps >= 3000) return semantic.warning;
    return colors.slate500;
  }

  /** Rangée de classement (top clients / top dépenses). progressPct/progressColor : barre de
   * proportion optionnelle (utilisée pour la part des top clients, cohérente avec metaColor). */
  function RankRow({
    label,
    amountCents,
    meta,
    metaColor,
    divider,
    warn,
    progressPct,
    progressColor,
  }: {
    label: string;
    amountCents: number;
    meta?: string | null;
    metaColor?: string;
    divider: boolean;
    warn?: boolean;
    progressPct?: number | null;
    progressColor?: string;
  }) {
    return (
      <View
        accessible
        accessibilityLabel={`${label}. ${formatEUR(amountCents)}${meta ? `. ${meta}` : ''}`}
        style={{
          paddingVertical: 10,
          borderBottomWidth: divider ? 1 : 0,
          borderBottomColor: colors.lineSoft,
        }}
      >
        <View style={{ flexDirection: 'row', alignItems: 'center', gap: 10 }}>
          <Text style={[font('sub'), { color: warn ? semantic.warning : colors.ink800, flex: 1 }]} numberOfLines={1}>
            {label}
          </Text>
          {meta ? (
            <Text style={[metaColor ? font('meta', 700) : font('meta'), { color: metaColor ?? colors.slate400 }]}>{meta}</Text>
          ) : null}
          <Text
            style={{
              ...font('sub', 700),
              color: amountCents >= 0 ? colors.ink900 : semantic.warning,
              fontVariant: ['tabular-nums'],
            }}
          >
            {amountCents < 0 ? '−' : ''}
            {formatEUR(Math.abs(amountCents))}
          </Text>
        </View>
        {progressPct !== null && progressPct !== undefined ? (
          <View style={{ height: 4, borderRadius: 2, backgroundColor: colors.lineSoft, overflow: 'hidden', marginTop: 6 }}>
            <View
              style={{
                height: '100%',
                width: `${Math.min(100, Math.max(0, progressPct))}%`,
                borderRadius: 2,
                backgroundColor: progressColor ?? colors.slate400,
              }}
            />
          </View>
        ) : null}
      </View>
    );
  }

  const body = (r: BusinessReview): ReactNode => {
    if (r.coverage.firstMonth === null) {
      return (
        <Card>
          <Text style={[font('sub'), { color: colors.slate500, lineHeight: 19 }]}>{t('pilotage.empty', { personality })}</Text>
        </Card>
      );
    }
    const cur = r.currentMonth;
    const trend = r.lastClosedComparison;
    return (
      <>
        {/* Mois en cours — isopérimètre, jamais de % plein-mois */}
        {section(
          'pilotage.sectionMonth',
          <Card>
            <View style={{ flexDirection: 'row', justifyContent: 'space-between', alignItems: 'flex-start' }}>
              <View style={{ flex: 1, minWidth: 0 }}>
                <View style={{ flexDirection: 'row', alignItems: 'center', gap: 6 }}>
                  <View style={{ width: 6, height: 6, borderRadius: 3, backgroundColor: colors.ink600 }} />
                  <Text style={[font('meta'), { color: colors.slate400 }]}>
                    {t('pilotage.invoicedLabel', { personality })} · {t('pilotage.atDay', { personality, params: { day: String(cur.atDay) } })}
                  </Text>
                </View>
                {/* Facturé : montant neutre (ink900) — la bonne nouvelle du mois, c'est l'encaissé. */}
                <Text style={{ ...font('bigNum'), fontSize: 26, color: colors.ink900, marginTop: 2, fontVariant: ['tabular-nums'] }}>
                  {formatEUR(cur.invoicedHtCents)}
                </Text>
                <Text style={[font('meta'), { color: colors.slate400, marginTop: 2 }]}>{t('pilotage.invoicedHint', { personality })}</Text>
              </View>
              {cur.invoicedDeltaBps !== null ? (
                <StatusBadge label={`${pctFromBps(cur.invoicedDeltaBps)} %`} variant={cur.invoicedDeltaBps >= 0 ? 'success' : 'danger'} />
              ) : null}
            </View>
            {cur.invoicedDeltaBps !== null ? (
              <Text style={[font('meta'), { color: colors.slate400, marginTop: 4 }]}>{t('pilotage.isoCompare', { personality })}</Text>
            ) : null}
            <View style={{ height: 1, backgroundColor: colors.lineSoft, marginVertical: 10 }} />
            <View style={{ flexDirection: 'row', justifyContent: 'space-between', alignItems: 'baseline' }}>
              <View style={{ flex: 1, minWidth: 0 }}>
                <View style={{ flexDirection: 'row', alignItems: 'center', gap: 6 }}>
                  <View style={{ width: 6, height: 6, borderRadius: 3, backgroundColor: semantic.success }} />
                  <Text style={[font('meta'), { color: colors.slate400 }]}>{t('pilotage.collectedLabel', { personality })}</Text>
                </View>
                <Text style={[font('meta'), { color: colors.slate400, marginTop: 2 }]}>{t('pilotage.collectedHint', { personality })}</Text>
              </View>
              {/* Encaissé : la bonne nouvelle du mois — success + pastille de fond discrète. */}
              <View style={{ backgroundColor: semantic.successBg, borderRadius: 8, paddingHorizontal: 8, paddingVertical: 3 }}>
                <Text style={{ ...font('cardTitle'), fontSize: 18, color: semantic.success, fontVariant: ['tabular-nums'] }}>
                  {formatEUR(cur.collectedTtcCents)}
                </Text>
              </View>
            </View>
          </Card>,
        )}

        {/* Tendance — mois clos + cumul annuel gated par la couverture */}
        {section(
          'pilotage.sectionTrend',
          <Card>
            {trend ? (
              <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8 }}>
                <View style={{ flex: 1, minWidth: 0 }}>
                  <Text style={[font('sub'), { color: colors.ink800 }]}>
                    {t('pilotage.trendMonths', {
                      personality,
                      params: { month: monthLabel(trend.month), prev: monthLabel(trend.previousMonth) },
                    })}
                  </Text>
                  {/* Fond très léger selon le signe (successBg/warningBg) + flèche préfixe. */}
                  <View
                    style={{
                      alignSelf: 'flex-start',
                      marginTop: 2,
                      backgroundColor: trend.deltaCents >= 0 ? semantic.successBg : semantic.warningBg,
                      borderRadius: 8,
                      paddingHorizontal: 8,
                      paddingVertical: 3,
                    }}
                  >
                    <Text style={{ ...font('cardTitle'), color: trend.deltaCents >= 0 ? semantic.success : semantic.warning, fontVariant: ['tabular-nums'] }}>
                      {trend.deltaCents >= 0 ? '▲ +' : '▼ −'}
                      {formatEUR(Math.abs(trend.deltaCents))}
                    </Text>
                  </View>
                </View>
                {trend.deltaBps !== null ? (
                  <StatusBadge label={`${pctFromBps(trend.deltaBps)} %`} variant={trend.deltaBps >= 0 ? 'success' : 'danger'} />
                ) : (
                  <Text style={[font('sub'), { color: colors.slate400 }]}>—</Text>
                )}
              </View>
            ) : (
              <Text style={[font('sub'), { color: colors.slate500, lineHeight: 19 }]}>{t('pilotage.trendTooEarly', { personality })}</Text>
            )}
            {r.ytd ? (
              <>
                <View style={{ height: 1, backgroundColor: colors.lineSoft, marginVertical: 10 }} />
                <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8 }}>
                  <View style={{ flex: 1, minWidth: 0 }}>
                    <Text style={[font('sub'), { color: colors.ink800 }]}>{t('pilotage.ytdLabel', { personality })}</Text>
                    <Text style={{ ...font('cardTitle'), color: colors.ink900, marginTop: 2, fontVariant: ['tabular-nums'] }}>
                      {formatEUR(r.ytd.invoicedHtCents)}
                    </Text>
                    <Text style={[font('meta'), { color: colors.slate400, marginTop: 2 }]}>
                      {t('pilotage.ytdPrev', { personality, params: { amount: formatEUR(r.ytd.previousYearInvoicedHtCents) } })}
                    </Text>
                  </View>
                  {r.ytd.deltaBps !== null ? (
                    <StatusBadge label={`${pctFromBps(r.ytd.deltaBps)} %`} variant={r.ytd.deltaBps >= 0 ? 'success' : 'danger'} />
                  ) : null}
                </View>
              </>
            ) : null}
          </Card>,
        )}

        {/* Série mensuelle */}
        {r.series.length >= 2 ? section('pilotage.sectionSeries', <SeriesBars data={r.series} currentMonth={r.currentMonth.month} />) : null}

        {/* DSO */}
        {section(
          'pilotage.sectionDso',
          <Card>
            {r.dso.days === null ? (
              <Text style={[font('sub'), { color: colors.slate500, lineHeight: 19 }]}>
                {t(r.dso.reason === 'insufficient_history' ? 'pilotage.dsoNoHistory' : 'pilotage.dsoNoInvoicing', { personality })}
              </Text>
            ) : r.dso.days === 0 ? (
              <Text style={[font('sub'), { color: semantic.success, lineHeight: 19 }]}>{t('pilotage.dsoAllCollected', { personality })}</Text>
            ) : (
              <>
                <Text style={{ ...font('bigNum'), fontSize: 26, color: colors.ink900, fontVariant: ['tabular-nums'] }}>
                  {t('pilotage.dsoDays', { personality, params: { days: String(r.dso.days) } })}
                </Text>
                <Text style={[font('meta'), { color: colors.slate400, marginTop: 3, lineHeight: 17 }]}>{t('pilotage.dsoHint', { personality })}</Text>
                <Text style={[font('sub'), { color: colors.ink800, marginTop: 8 }]}>
                  {t('pilotage.dsoLocked', { personality, params: { amount: formatEUR(r.dso.receivablesCents) } })}
                </Text>
              </>
            )}
          </Card>,
        )}

        {/* Top clients */}
        {section(
          'pilotage.sectionTopClients',
          <Card>
            {r.topClients.lines.length === 0 ? (
              <Text style={[font('sub'), { color: colors.slate500 }]}>{t('pilotage.noClients', { personality })}</Text>
            ) : (
              <>
                {r.topClients.lines.map((line, index) => (
                  <RankRow
                    key={line.customerId}
                    label={`${index + 1}. ${line.customerName}`}
                    amountCents={line.invoicedTtc12mCents}
                    meta={line.shareBps !== null ? `${Math.round(line.shareBps / 100)} %` : null}
                    metaColor={shareRiskColor(line.shareBps)}
                    progressPct={line.shareBps !== null ? line.shareBps / 100 : null}
                    progressColor={shareRiskColor(line.shareBps)}
                    divider={index < r.topClients.lines.length - 1 || r.topClients.othersCount > 0 || r.topClients.creditNetCount > 0}
                  />
                ))}
                {r.topClients.othersCount > 0 ? (
                  <RankRow
                    label={t('pilotage.othersClients', { personality, params: { count: String(r.topClients.othersCount) } })}
                    amountCents={r.topClients.othersCents}
                    divider={r.topClients.creditNetCount > 0}
                  />
                ) : null}
                {r.topClients.creditNetCount > 0 ? (
                  <RankRow
                    label={t('pilotage.creditNet', { personality, params: { count: String(r.topClients.creditNetCount) } })}
                    amountCents={r.topClients.creditNetCents}
                    divider={false}
                  />
                ) : null}
                {r.topClients.concentrationAlert && r.topClients.lines[0] && r.topClients.top1ShareBps !== null ? (
                  <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8, marginTop: 8, paddingTop: 10, borderTopWidth: 1, borderTopColor: colors.lineSoft }}>
                    <StatusBadge label="!" variant="particulier" />
                    <Text style={[font('meta'), { color: colors.slate500, flex: 1, lineHeight: 17 }]}>
                      {t('pilotage.concentration', {
                        personality,
                        params: {
                          name: r.topClients.lines[0].customerName,
                          share: String(Math.round(r.topClients.top1ShareBps / 100)),
                        },
                      })}
                    </Text>
                  </View>
                ) : null}
              </>
            )}
          </Card>,
          'pilotage.topClientsHint',
        )}

        {/* Top dépenses */}
        {section(
          'pilotage.sectionTopExpenses',
          <Card>
            {r.topExpenses.lines.length === 0 ? (
              <Text style={[font('sub'), { color: colors.slate500 }]}>{t('pilotage.noExpenses', { personality })}</Text>
            ) : (
              r.topExpenses.lines.map((line, index) => (
                <RankRow
                  key={line.category}
                  label={t(CAT_KEY[line.category], { personality })}
                  amountCents={line.chargeCents}
                  meta={line.deltaBps !== null ? `${pctFromBps(line.deltaBps)} %` : null}
                  divider={index < r.topExpenses.lines.length - 1}
                />
              ))
            )}
          </Card>,
          'pilotage.topExpensesHint',
        )}

        {/* Cascade SIG + ratios */}
        {section(
          'pilotage.sectionSig',
          <Card>
            <SigRow label={t('pilotage.sigCa', { personality })} cents={r.ratios.caCents} strong />
            {r.sig.margeCommercialeActive ? (
              <SigRow label={t('pilotage.sigMarge', { personality })} cents={r.sig.margeCommercialeCents} bpsOfCa={r.ratios.margeMateriauxBps} />
            ) : null}
            <SigRow label={t('pilotage.sigConso', { personality })} cents={-r.sig.consommationsCents} bpsOfCa={r.ratios.chargesExternesBps} />
            <SigRow label={t('pilotage.sigVa', { personality })} cents={r.sig.valeurAjouteeCents} strong topBorder />
            {r.sig.impotsTaxesCents !== 0 ? <SigRow label={t('pilotage.sigImpots', { personality })} cents={-r.sig.impotsTaxesCents} /> : null}
            {r.sig.chargesPersonnelCents !== 0 ? (
              <SigRow label={t('pilotage.sigPersonnel', { personality })} cents={-r.sig.chargesPersonnelCents} bpsOfCa={r.ratios.personnelVaBps} />
            ) : null}
            <SigRow label={t('pilotage.sigEbe', { personality })} cents={r.sig.ebeCents} bpsOfCa={r.ratios.ebeBps} strong topBorder />
            <Text style={[font('meta'), { color: colors.slate400, marginTop: 2, lineHeight: 16 }]}>{t('pilotage.sigEbeHint', { personality })}</Text>
            <SigRow label={t('pilotage.sigRex', { personality })} cents={r.sig.resultatExploitationCents} bpsOfCa={r.ratios.rexBps} strong topBorder />
            <Text style={[font('meta'), { color: colors.slate400, marginTop: 8 }]}>{t('pilotage.sigPeriod', { personality })}</Text>
          </Card>,
        )}

        <Text style={[font('meta'), { color: colors.slate400, textAlign: 'center' }]}>
          {t('pilotage.coverage', { personality, params: { month: monthLabel(r.coverage.firstMonth) } })}
        </Text>
      </>
    );
  };

  return (
    <View style={{ flex: 1, backgroundColor: colors.bg }}>
      <ScrollView
        style={{ flex: 1 }}
        stickyHeaderIndices={[0]}
        showsVerticalScrollIndicator={false}
        contentContainerStyle={{ paddingBottom: insets.bottom + 34 }}
      >
        <View
          style={{
            paddingTop: insets.top + 10,
            paddingHorizontal: 16,
            paddingBottom: 8,
            backgroundColor: patterns.bottomTabBar.fade[1],
          }}
        >
          <Pressable
            accessibilityRole="button"
            accessibilityLabel={t('pilotage.back', { personality })}
            onPress={() => router.back()}
            hitSlop={8}
            style={{ flexDirection: 'row', alignItems: 'center', gap: 4, alignSelf: 'flex-start', minHeight: 34 }}
          >
            <ChevronLeftIcon color={colors.ink800} size={18} strokeWidth={2.2} />
            <Text style={[font('label', 600), { fontSize: 15, color: colors.ink800 }]}>{t('pilotage.back', { personality })}</Text>
          </Pressable>
        </View>

        <InnerScreenHeader
          eyebrow={t('pilotage.eyebrow', { personality })}
          title={t('pilotage.title', { personality })}
          subtitle={t('pilotage.subtitle', { personality })}
        />

        <View style={{ paddingHorizontal: 18, paddingTop: 14, gap: 14 }}>
          {/* Abonnement ou données en chargement → squelettes, JAMAIS le paywall ;
              l'échec données est prioritaire sur `review === null` pour garantir le retry ;
              verrouillé → carte contextuelle du domaine (même emplacement que le contenu) ;
              decision 'unavailable' (aucun catalogue ne vend la capacité) → PaywallCard rend
              null PAR CONSTRUCTION (paywall.tsx) : repli EmptyState pour ne jamais laisser
              l'écran vide (P2 audit 14/07). */}
          {entitlement.loading ? (
            // 6 Cards réelles (mois en cours, tendance, DSO, top clients, top dépenses,
            // cascade SIG) — hauteurs calées sur leur gabarit final (zéro saut de layout).
            // La série mensuelle (conditionnelle, ≥2 mois d'historique) n'est pas squelettée.
            <>
              <SkeletonCard height={150} contentLines={4} />
              <SkeletonCard height={140} contentLines={4} />
              <SkeletonCard height={104} contentLines={3} />
              <SkeletonCard height={260} contentLines={5} />
              <SkeletonCard height={220} contentLines={5} />
              <SkeletonCard height={230} contentLines={5} />
            </>
          ) : !entitled ? (
            entitlement.decision !== null ? (
              entitlement.decision.kind === 'unavailable' ? (
                <Card>
                  <EmptyState
                    title={t('pilotage.paywallTitle', { personality })}
                    body={t('pilotage.paywallBody', { personality })}
                  />
                </Card>
              ) : (
                <PaywallCard
                  decision={entitlement.decision}
                  source="feature_screen"
                  personality={personality}
                  onDismissed={() => router.back()}
                />
              )
            ) : null
          ) : queryState.failed ? (
            // P1 (audit 14/07) : un échec réseau n'est JAMAIS confondu avec une absence de
            // données — vérifié AVANT le calcul/rendu de review (jamais un « rien à afficher »
            // qui masquerait le fait que le fetch a raté).
            <ErrorRetry message={t('today.dataError', { personality })} onRetry={queryState.refetchAll} />
          ) : queryState.loading || review === null ? (
            // L'échec est testé AVANT `review === null` : sinon un premier chargement en
            // erreur laisse `review` nul et affiche un skeleton éternel au lieu du retry.
            <>
              <SkeletonCard height={150} contentLines={4} />
              <SkeletonCard height={140} contentLines={4} />
              <SkeletonCard height={104} contentLines={3} />
              <SkeletonCard height={260} contentLines={5} />
              <SkeletonCard height={220} contentLines={5} />
              <SkeletonCard height={230} contentLines={5} />
            </>
          ) : review !== null ? (
            body(review)
          ) : null}
        </View>
      </ScrollView>
    </View>
  );
}
