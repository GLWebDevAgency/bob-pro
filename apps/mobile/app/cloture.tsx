/**
 * Clôture — préparer le mois pour le comptable (refonte @bob/ui, CLOTURE-UI). Pattern écran
 * poussé (A3-C17) : rangée retour sticky (bg .92) + InnerScreenHeader → carte de synthèse
 * (tout prêt / points à arbitrer) → « À arbitrer » + « Pièces » (checklist actionnable, mêmes
 * points d'entrée que Bob) → ÉTATS DE SYNTHÈSE (balance générale + compte de résultat CDR-1 +
 * bilan BILAN-1, dérivés @bob/core, cohérents par construction) → « Envoyer au comptable »
 * (dossier DOSSIER-1 + FEC). Paywall accounting_operations conservé. Zéro hex, zéro fixture,
 * i18n cloture.* ×3 humeurs.
 */
import { useMemo, useState, type ReactNode } from 'react';
import { Alert, Pressable, ScrollView, Text, View } from 'react-native';
import { useRouter, type Href } from 'expo-router';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { Feather } from '@expo/vector-icons';
import {
  buildClosingDossier,
  deriveBalanceSheet,
  deriveIncomeStatement,
  deriveTrialBalance,
  formatEUR,
} from '@bob/core';
import { patterns } from '@bob/tokens';
import { t, type I18nKey } from '@bob/i18n';
import {
  Button,
  Card,
  IconTile,
  InnerScreenHeader,
  SectionHeader,
  StatusBadge,
  Toast,
  font,
  useTheme,
} from '@bob/ui';
import {
  useAccountingEntries,
  useCompany,
  useExportFec,
  useInvoices,
  useQuotes,
  useSubscription,
  appErrorMessage,
} from '../src/data/hooks';
import { useDocuments } from '../src/data/documents';
import { shareFec } from '../src/lib/share-fec';
import { shareTextFile } from '../src/lib/share-text';
import {
  ChartIcon,
  CheckIcon,
  ChevronLeftIcon,
  ChevronRightIcon,
  ClipboardCheckIcon,
  FileIcon,
  SendIcon,
} from '../src/components/icons';

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

const pad = (n: number): string => String(n).padStart(2, '0');

/** Mois courant (clé AAAA-MM + libellé « juillet 2026 ») — sans Intl, comme formatEUR. */
function moisCourant(d: Date = new Date()): { key: string; label: string } {
  return { key: `${d.getFullYear()}-${pad(d.getMonth() + 1)}`, label: `${MONTHS[d.getMonth()]} ${d.getFullYear()}` };
}

interface CheckItem {
  key: string;
  labelKey: I18nKey;
  count: number;
  route: Href;
}

function SkeletonBlock({ height }: { height: number }) {
  const { colors } = useTheme();
  return <View style={{ height, borderRadius: 18, backgroundColor: colors.lineSoft }} />;
}

export default function Cloture() {
  const { personality, colors, semantic, controls } = useTheme();
  const insets = useSafeAreaInsets();
  const router = useRouter();
  const { data: sub } = useSubscription();
  const invoices = useInvoices();
  const quotes = useQuotes();
  const documents = useDocuments();
  const entries = useAccountingEntries();
  const company = useCompany();
  const exportFec = useExportFec();
  const entitled = (sub?.features ?? []).includes('accounting_operations');
  const [sendingDossier, setSendingDossier] = useState(false);
  const [toast, setToast] = useState<string | null>(null);

  // États de synthèse dérivés @bob/core — cohérents par construction (résultat identique).
  const balance = useMemo(() => deriveTrialBalance(entries.data ?? []), [entries.data]);
  const income = useMemo(() => deriveIncomeStatement(entries.data ?? []), [entries.data]);
  const bilan = useMemo(() => deriveBalanceSheet(entries.data ?? []), [entries.data]);

  const mois = moisCourant();
  const inv = invoices.data ?? [];
  const qs = quotes.data ?? [];
  const docs = documents.data ?? [];
  const loading = invoices.isLoading || quotes.isLoading || documents.isLoading || entries.isLoading;

  const signedNotInvoiced = qs.filter((q) => q.status === 'signed' && !inv.some((i) => i.parentQuoteId === q.id));
  const invoicePdfIds = new Set(docs.filter((d) => d.kind === 'invoice_pdf' && d.linkedEntityId).map((d) => d.linkedEntityId));
  const missingPdf = inv
    .filter((i) => i.status !== 'draft' && i.status !== 'cancelled')
    .filter((i) => !invoicePdfIds.has(i.id));

  const anomalies: CheckItem[] = [
    { key: 'signed', labelKey: 'cloture.itemSignedNotInvoiced', count: signedNotInvoiced.length, route: '/ventes' },
    { key: 'drafts', labelKey: 'cloture.itemDrafts', count: inv.filter((i) => i.status === 'draft').length, route: '/ventes' },
    { key: 'late', labelKey: 'cloture.itemLate', count: inv.filter((i) => i.status === 'late').length, route: '/ventes' },
    { key: 'partial', labelKey: 'cloture.itemPartial', count: inv.filter((i) => i.status === 'partially_paid').length, route: '/ventes' },
  ];
  const pieces: CheckItem[] = [
    { key: 'pdf', labelKey: 'cloture.itemMissingPdf', count: missingPdf.length, route: '/documents' },
  ];
  const anomaliesTotal = anomalies.reduce((s, i) => s + i.count, 0);
  const piecesTotal = pieces.reduce((s, i) => s + i.count, 0);
  const allClear = anomaliesTotal === 0 && piecesTotal === 0;

  const [yy, mm] = mois.key.split('-').map(Number);
  const fecFrom = `${mois.key}-01`;
  const fecTo = `${mois.key}-${pad(new Date(yy ?? 2026, mm ?? 1, 0).getDate())}`;

  const onExportFec = async (): Promise<void> => {
    try {
      const res = await exportFec.mutateAsync({ from: fecFrom, to: fecTo });
      const shared = await shareFec(res); // E9 : octets ISO 8859-15 (arrêté 29/07/2013)
      if (shared === 'unavailable') setToast(t('cloture.fecGenerated', { personality, params: { filename: res.filename } }));
      if (res.warnings.length) Alert.alert('Avertissements FEC', res.warnings.join('\n'));
    } catch (e) {
      Alert.alert('Oups', appErrorMessage(e));
    }
  };

  const onSendDossier = async (): Promise<void> => {
    setSendingDossier(true);
    try {
      const now = new Date();
      const dossier = buildClosingDossier({
        company: { name: company.data?.name ?? 'Mon entreprise', siren: company.data?.siren ?? '—' },
        period: { from: fecFrom, to: fecTo },
        generatedOn: `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`,
        entries: (entries.data ?? []).map((e) => ({ lines: e.lines })),
      });
      const shared = await shareTextFile(dossier);
      if (shared === 'unavailable') setToast(t('cloture.dossierPrepared', { personality, params: { filename: dossier.filename } }));
    } catch (e) {
      Alert.alert('Oups', appErrorMessage(e));
    } finally {
      setSendingDossier(false);
    }
  };

  /** Rangée de checklist : pastille statut + libellé + compteur + chevron (si à traiter). */
  function CheckRow({ item, divider }: { item: CheckItem; divider: boolean }) {
    const done = item.count === 0;
    return (
      <Pressable
        accessibilityRole={item.count > 0 ? 'button' : undefined}
        accessibilityLabel={`${t(item.labelKey, { personality })} : ${item.count}`}
        onPress={item.count > 0 ? () => router.push(item.route) : undefined}
        style={{
          flexDirection: 'row',
          alignItems: 'center',
          gap: 11,
          paddingVertical: 11,
          borderBottomWidth: divider ? 1 : 0,
          borderBottomColor: colors.lineSoft,
        }}
      >
        <IconTile tone={done ? 'success' : 'particulier'} size={30} radius={9}>
          {done ? (
            <CheckIcon color={semantic.success} size={14} />
          ) : (
            <Feather name="alert-triangle" size={14} color={semantic.particulier} />
          )}
        </IconTile>
        <Text style={[font('sub'), { color: colors.ink800, flex: 1 }]}>{t(item.labelKey, { personality })}</Text>
        <StatusBadge label={String(item.count)} variant={done ? 'success' : 'particulier'} />
        {item.count > 0 ? <ChevronRightIcon color={controls.chevron} size={14} strokeWidth={2} /> : null}
      </Pressable>
    );
  }

  /** Ligne « libellé …… montant » teintée par signe (états de synthèse). */
  function AmountRow({ label, cents, strong, topBorder }: { label: string; cents: number; strong?: boolean; topBorder?: boolean }) {
    return (
      <View
        style={{
          flexDirection: 'row',
          justifyContent: 'space-between',
          alignItems: 'center',
          paddingVertical: strong ? 8 : 6,
          borderTopWidth: topBorder ? 1 : 0,
          borderTopColor: colors.lineSoft,
        }}
      >
        <Text style={[strong ? font('cardTitle') : font('sub'), { color: colors.ink800 }]}>{label}</Text>
        <Text
          style={[
            strong ? font('cardTitle') : font('sub'),
            { color: cents >= 0 ? colors.ink900 : semantic.warning, fontVariant: ['tabular-nums'] },
          ]}
        >
          {cents < 0 ? '−' : ''}
          {formatEUR(Math.abs(cents))}
        </Text>
      </View>
    );
  }

  const section = (title: I18nKey, body: ReactNode): ReactNode => (
    <View>
      <SectionHeader title={t(title, { personality })} />
      {body}
    </View>
  );

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
            accessibilityLabel={t('cloture.back', { personality })}
            onPress={() => router.back()}
            hitSlop={8}
            style={{ flexDirection: 'row', alignItems: 'center', gap: 4, alignSelf: 'flex-start', minHeight: 34 }}
          >
            <ChevronLeftIcon color={colors.ink800} size={18} strokeWidth={2.2} />
            <Text style={[font('label', 600), { fontSize: 15, color: colors.ink800 }]}>{t('cloture.back', { personality })}</Text>
          </Pressable>
        </View>

        <InnerScreenHeader
          eyebrow={t('cloture.eyebrow', { personality })}
          title={t('cloture.title', { personality })}
          subtitle={t('cloture.subtitle', { personality, params: { month: mois.label } })}
        />

        <View style={{ paddingHorizontal: 18, paddingTop: 14, gap: 14 }}>
          {!entitled ? (
            <Card>
              <Text style={[font('cardTitle'), { color: colors.ink900 }]}>{t('cloture.paywallTitle', { personality })}</Text>
              <Text style={[font('sub'), { color: colors.slate500, marginTop: 6, lineHeight: 19 }]}>
                {t('cloture.paywallBody', { personality })}
              </Text>
              <View style={{ height: 12 }} />
              <Button title={t('cloture.paywallCta', { personality })} variant="secondary" onPress={() => router.push('/compte')} />
            </Card>
          ) : loading ? (
            <>
              <SkeletonBlock height={80} />
              <SkeletonBlock height={140} />
              <SkeletonBlock height={160} />
            </>
          ) : (
            <>
              {/* Synthèse — tout prêt ou points restants */}
              <Card>
                <View style={{ flexDirection: 'row', alignItems: 'flex-start', gap: 11 }}>
                  <IconTile tone={allClear ? 'success' : 'particulier'} size={34} radius={10}>
                    {allClear ? (
                      <ClipboardCheckIcon color={semantic.success} />
                    ) : (
                      <Feather name="alert-triangle" size={16} color={semantic.particulier} />
                    )}
                  </IconTile>
                  <View style={{ flex: 1, minWidth: 0 }}>
                    <Text style={{ ...font('body', 700), fontSize: 14, color: colors.ink800 }}>
                      {t(allClear ? 'cloture.allClear' : 'cloture.readyTitle', { personality })}
                    </Text>
                    {!allClear ? (
                      <Text style={{ ...font('sub', 500), fontSize: 12.5, color: colors.slate500, marginTop: 3, lineHeight: 18 }}>
                        {anomaliesTotal > 0
                          ? anomaliesTotal === 1
                            ? t('cloture.remainArbitrerOne', { personality })
                            : t('cloture.remainArbitrer', { personality, params: { count: anomaliesTotal } })
                          : ''}
                        {anomaliesTotal > 0 && piecesTotal > 0 ? ' · ' : ''}
                        {piecesTotal > 0
                          ? piecesTotal === 1
                            ? t('cloture.remainPiecesOne', { personality })
                            : t('cloture.remainPieces', { personality, params: { count: piecesTotal } })
                          : ''}
                      </Text>
                    ) : null}
                  </View>
                </View>
              </Card>

              {section(
                'cloture.sectionArbitrer',
                <Card>
                  {anomalies.map((item, i) => (
                    <CheckRow key={item.key} item={item} divider={i < anomalies.length - 1} />
                  ))}
                </Card>,
              )}

              {section(
                'cloture.sectionPieces',
                <Card>
                  {pieces.map((item, i) => (
                    <CheckRow key={item.key} item={item} divider={i < pieces.length - 1} />
                  ))}
                </Card>,
              )}

              {balance.rows.length > 0 ? (
                <>
                  {/* Balance générale */}
                  {section(
                    'cloture.sectionBalance',
                    <Card>
                      <View style={{ flexDirection: 'row', alignItems: 'flex-start', justifyContent: 'space-between', gap: 10 }}>
                        <View style={{ flex: 1 }}>
                          <Text style={[font('meta'), { color: colors.slate400 }]}>{t('cloture.resultProvisoire', { personality })}</Text>
                          <Text
                            style={{
                              ...font('bigNum'),
                              fontSize: 24,
                              color: balance.resultCents >= 0 ? semantic.success : semantic.warning,
                              marginTop: 2,
                              fontVariant: ['tabular-nums'],
                            }}
                          >
                            {balance.resultCents >= 0 ? '+' : '−'}
                            {formatEUR(Math.abs(balance.resultCents))}
                          </Text>
                          <Text style={[font('meta'), { color: colors.slate400, marginTop: 2 }]}>
                            {t('cloture.produitsCharges', {
                              personality,
                              params: { produits: formatEUR(balance.revenueCents), charges: formatEUR(balance.chargesCents) },
                            })}
                          </Text>
                        </View>
                        <StatusBadge
                          label={t(balance.balanced ? 'cloture.balanced' : 'cloture.unbalanced', { personality })}
                          variant={balance.balanced ? 'success' : 'danger'}
                        />
                      </View>
                      <View style={{ height: 1, backgroundColor: colors.lineSoft, marginVertical: 10 }} />
                      {balance.rows.map((row) => (
                        <View
                          key={row.account}
                          accessible
                          accessibilityLabel={`Compte ${row.account}, solde ${formatEUR(row.balanceCents)}`}
                          style={{ flexDirection: 'row', alignItems: 'center', paddingVertical: 5 }}
                        >
                          <Text style={[font('sub'), { color: colors.ink800, width: 60, fontVariant: ['tabular-nums'] }]}>
                            {row.account}
                          </Text>
                          <Text style={{ ...font('meta'), color: colors.slate400, flex: 1, textAlign: 'right', fontVariant: ['tabular-nums'] }}>
                            D {formatEUR(row.debitCents)}
                          </Text>
                          <Text style={{ ...font('meta'), color: colors.slate400, flex: 1, textAlign: 'right', fontVariant: ['tabular-nums'] }}>
                            C {formatEUR(row.creditCents)}
                          </Text>
                          <Text
                            style={{
                              ...font('sub', 700),
                              color: row.balanceCents >= 0 ? colors.ink900 : colors.slate500,
                              width: 92,
                              textAlign: 'right',
                              fontVariant: ['tabular-nums'],
                            }}
                          >
                            {formatEUR(row.balanceCents)}
                          </Text>
                        </View>
                      ))}
                      <View style={{ height: 1, backgroundColor: colors.lineSoft, marginVertical: 8 }} />
                      <View style={{ flexDirection: 'row', justifyContent: 'space-between' }}>
                        <Text style={[font('meta'), { color: colors.slate400 }]}>{t('cloture.totauxLabel', { personality })}</Text>
                        <Text style={{ ...font('meta'), color: colors.slate500, fontVariant: ['tabular-nums'] }}>
                          {t('cloture.totaux', {
                            personality,
                            params: { debit: formatEUR(balance.totalDebitCents), credit: formatEUR(balance.totalCreditCents) },
                          })}
                        </Text>
                      </View>
                    </Card>,
                  )}

                  {/* Compte de résultat (cascade CDR-1) */}
                  {section(
                    'cloture.sectionResult',
                    <Card>
                      <AmountRow label={t('cloture.prodExpl', { personality })} cents={income.exploitationProduitsCents} />
                      <AmountRow label={t('cloture.chargesExpl', { personality })} cents={-income.exploitationChargesCents} />
                      <AmountRow label={t('cloture.resExpl', { personality })} cents={income.resultatExploitationCents} strong topBorder />
                      {income.financierProduitsCents !== 0 || income.financierChargesCents !== 0 ? (
                        <AmountRow label={t('cloture.resFin', { personality })} cents={income.resultatFinancierCents} strong topBorder />
                      ) : null}
                      {income.resultatExceptionnelCents !== 0 ? (
                        <AmountRow label={t('cloture.resExc', { personality })} cents={income.resultatExceptionnelCents} strong topBorder />
                      ) : null}
                      <View
                        style={{
                          flexDirection: 'row',
                          justifyContent: 'space-between',
                          alignItems: 'center',
                          marginTop: 8,
                          paddingTop: 10,
                          borderTopWidth: 2,
                          borderTopColor: income.resultatNetCents >= 0 ? semantic.success : semantic.warning,
                        }}
                      >
                        <Text style={[font('cardTitle'), { color: colors.ink900 }]}>{t('cloture.resNet', { personality })}</Text>
                        <Text
                          style={{
                            ...font('bigNum'),
                            fontSize: 21,
                            color: income.resultatNetCents >= 0 ? semantic.success : semantic.warning,
                            fontVariant: ['tabular-nums'],
                          }}
                        >
                          {income.resultatNetCents >= 0 ? '+' : '−'}
                          {formatEUR(Math.abs(income.resultatNetCents))}
                        </Text>
                      </View>
                      {income.impotBeneficesCents !== 0 ? (
                        <Text style={[font('meta'), { color: colors.slate400, marginTop: 6 }]}>
                          {t('cloture.apresImpot', { personality, params: { amount: formatEUR(income.impotBeneficesCents) } })}
                        </Text>
                      ) : null}
                    </Card>,
                  )}

                  {/* Bilan (BILAN-1) */}
                  {section(
                    'cloture.sectionBilan',
                    <Card>
                      <View style={{ flexDirection: 'row', gap: 14 }}>
                        {(
                          [
                            {
                              titre: t('cloture.actif', { personality }),
                              total: bilan.actif.totalCents,
                              postes: [
                                { label: t('cloture.immo', { personality }), cents: bilan.actif.immobilisationsNettesCents },
                                { label: t('cloture.stocks', { personality }), cents: bilan.actif.stocksCents },
                                { label: t('cloture.creances', { personality }), cents: bilan.actif.creancesCents },
                                { label: t('cloture.dispo', { personality }), cents: bilan.actif.disponibilitesCents },
                              ],
                            },
                            {
                              titre: t('cloture.passif', { personality }),
                              total: bilan.passif.totalCents,
                              postes: [
                                { label: t('cloture.capitaux', { personality }), cents: bilan.passif.capitauxPropresCents },
                                { label: t('cloture.resultat', { personality }), cents: bilan.passif.resultatNetCents },
                                { label: t('cloture.provisions', { personality }), cents: bilan.passif.provisionsCents },
                                { label: t('cloture.emprunts', { personality }), cents: bilan.passif.empruntsCents },
                                { label: t('cloture.dettes', { personality }), cents: bilan.passif.dettesCents },
                                { label: t('cloture.decouvert', { personality }), cents: bilan.passif.decouvertCents },
                              ],
                            },
                          ] as { titre: string; total: number; postes: { label: string; cents: number }[] }[]
                        ).map((col) => (
                          <View key={col.titre} style={{ flex: 1 }}>
                            <Text style={[font('meta'), { color: colors.slate400, marginBottom: 4 }]}>{col.titre}</Text>
                            {col.postes
                              .filter((p) => p.cents !== 0)
                              .map((p) => (
                                <View
                                  key={p.label}
                                  style={{ flexDirection: 'row', justifyContent: 'space-between', paddingVertical: 4, gap: 6 }}
                                >
                                  <Text style={[font('meta'), { color: colors.slate500, flexShrink: 1 }]} numberOfLines={1}>
                                    {p.label}
                                  </Text>
                                  <Text style={{ ...font('meta'), color: p.cents >= 0 ? colors.ink800 : semantic.warning, fontVariant: ['tabular-nums'] }}>
                                    {formatEUR(p.cents)}
                                  </Text>
                                </View>
                              ))}
                            <View
                              style={{
                                flexDirection: 'row',
                                justifyContent: 'space-between',
                                marginTop: 6,
                                paddingTop: 6,
                                borderTopWidth: 1,
                                borderTopColor: colors.lineSoft,
                              }}
                            >
                              <Text style={{ ...font('sub', 700), color: colors.ink900 }}>{t('cloture.total', { personality })}</Text>
                              <Text style={{ ...font('sub', 700), color: colors.ink900, fontVariant: ['tabular-nums'] }}>
                                {formatEUR(col.total)}
                              </Text>
                            </View>
                          </View>
                        ))}
                      </View>
                      <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8, marginTop: 12 }}>
                        <Feather
                          name={bilan.balanced ? 'check-circle' : 'alert-circle'}
                          size={16}
                          color={bilan.balanced ? semantic.success : semantic.warning}
                        />
                        <Text style={[font('meta'), { color: bilan.balanced ? semantic.success : semantic.warning, flex: 1 }]}>
                          {bilan.balanced
                            ? t('cloture.bilanBalanced', { personality })
                            : t('cloture.bilanEcart', { personality, params: { amount: formatEUR(Math.abs(bilan.ecartCents)) } })}
                        </Text>
                      </View>
                    </Card>,
                  )}
                </>
              ) : null}

              {/* Envoyer au comptable — dossier (primaire) + FEC (secondaire) */}
              {section(
                'cloture.sectionExport',
                <>
                  {balance.rows.length > 0 ? (
                    <Pressable
                      accessibilityRole="button"
                      accessibilityLabel={t('cloture.sendDossier', { personality })}
                      disabled={sendingDossier}
                      onPress={() => void onSendDossier()}
                      style={({ pressed }) => [
                        {
                          flexDirection: 'row',
                          alignItems: 'center',
                          justifyContent: 'center',
                          gap: 9,
                          backgroundColor: semantic.success,
                          borderRadius: 14,
                          paddingVertical: 14,
                          minHeight: 44,
                          opacity: sendingDossier ? 0.6 : pressed ? 0.9 : 1,
                        },
                      ]}
                    >
                      <SendIcon color={colors.surface} size={17} />
                      <Text style={{ ...font('body', 700), fontSize: 14.5, color: colors.surface }}>
                        {t(sendingDossier ? 'cloture.sendingDossier' : 'cloture.sendDossier', { personality })}
                      </Text>
                    </Pressable>
                  ) : null}
                  <View style={{ height: balance.rows.length > 0 ? 10 : 0 }} />
                  <Pressable
                    accessibilityRole="button"
                    accessibilityLabel={t('cloture.exportFec', { personality })}
                    disabled={exportFec.isPending}
                    onPress={() => void onExportFec()}
                    style={({ pressed }) => [
                      {
                        flexDirection: 'row',
                        alignItems: 'center',
                        justifyContent: 'center',
                        gap: 9,
                        backgroundColor: colors.surface,
                        borderWidth: 1,
                        borderColor: controls.buttonSecondaryBorder,
                        borderRadius: 14,
                        paddingVertical: 14,
                        minHeight: 44,
                        opacity: exportFec.isPending ? 0.6 : pressed ? 0.9 : 1,
                      },
                    ]}
                  >
                    <FileIcon color={colors.ink600} size={16} />
                    <Text style={{ ...font('body', 700), fontSize: 14.5, color: colors.ink600 }}>
                      {t(exportFec.isPending ? 'cloture.exportingFec' : 'cloture.exportFec', { personality })}
                    </Text>
                  </Pressable>
                  <Text style={[font('meta'), { color: colors.slate400, marginTop: 8, textAlign: 'center', lineHeight: 16 }]}>
                    {t('cloture.exportHelper', { personality })}
                  </Text>
                </>,
              )}

              {/* Accès au grand-livre complet */}
              <Pressable
                accessibilityRole="button"
                accessibilityLabel={t('compta.title', { personality })}
                onPress={() => router.push('/comptabilite')}
              >
                <Card>
                  <View style={{ flexDirection: 'row', alignItems: 'center', gap: 11 }}>
                    <IconTile tone="b2b" size={34} radius={10}>
                      <ChartIcon color={semantic.b2b} />
                    </IconTile>
                    <Text style={{ ...font('cardTitle'), color: colors.ink800, flex: 1 }}>{t('compta.title', { personality })}</Text>
                    <ChevronRightIcon color={controls.chevron} size={14} strokeWidth={2} />
                  </View>
                </Card>
              </Pressable>
            </>
          )}
        </View>
      </ScrollView>

      <Toast
        message={toast ?? ''}
        visible={toast !== null}
        onHide={() => setToast(null)}
        icon={<CheckIcon color={colors.surface} />}
      />
    </View>
  );
}
