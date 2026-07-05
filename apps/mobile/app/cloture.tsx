import { useMemo } from 'react';
import { ScrollView, View, Text, Pressable, Alert } from 'react-native';
import { useRouter, type Href } from 'expo-router';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { Ionicons } from '@expo/vector-icons';
import { deriveTrialBalance, deriveIncomeStatement, deriveBalanceSheet, formatEUR } from '@bob/core';
import { useTheme } from '../src/theme';
import { useAccountingEntries, useInvoices, useQuotes, useSubscription, useExportFec, appErrorMessage } from '../src/data/hooks';
import { useDocuments } from '../src/data/documents';
import { shareFec } from '../src/lib/share-fec';
import { Card, Badge, Button, SectionHeader, font } from '../src/components/ui';

/** Un point de clôture : libellé, compte, où agir. count=0 => réglé. */
interface CheckItem {
  label: string;
  count: number;
  route: Href;
}

function moisCourant(): { key: string; label: string } {
  const d = new Date();
  return { key: d.toISOString().slice(0, 7), label: d.toLocaleDateString('fr-FR', { month: 'long', year: 'numeric' }) };
}

export default function Cloture() {
  const { colors, semantic } = useTheme();
  const insets = useSafeAreaInsets();
  const router = useRouter();
  const { data: sub } = useSubscription();
  const invoices = useInvoices();
  const quotes = useQuotes();
  const documents = useDocuments();
  const entries = useAccountingEntries();
  const exportFec = useExportFec();
  const entitled = (sub?.features ?? []).includes('accounting_operations');

  // CLOTURE-1 : balance générale + résultat provisoire (deriveTrialBalance @bob/core —
  // LE document que l'expert associé ouvre en premier ; même dérivation pour Bob).
  const balance = useMemo(() => deriveTrialBalance(entries.data ?? []), [entries.data]);
  // CDR-1 : compte de résultat normé (cascade exploitation/financier/exceptionnel/net) —
  // mapping PCG vérifié adversarialement ; décompose le résultat sans jamais le changer.
  const income = useMemo(() => deriveIncomeStatement(entries.data ?? []), [entries.data]);
  // BILAN-1 : bilan simplifié (actif/passif) — classement PCG vérifié, résultat affecté
  // aux capitaux propres ; l'invariant actif = passif prouve la cohérence du dossier.
  const bilan = useMemo(() => deriveBalanceSheet(entries.data ?? []), [entries.data]);

  const mois = moisCourant();
  const inv = invoices.data ?? [];
  const qs = quotes.data ?? [];
  const docs = documents.data ?? [];
  const loading = invoices.isLoading || quotes.isLoading || documents.isLoading;

  // Anomalies (état à date) — actionnables.
  const draftInvoices = inv.filter((i) => i.status === 'draft');
  const lateInvoices = inv.filter((i) => i.status === 'late');
  const partialInvoices = inv.filter((i) => i.status === 'partially_paid');
  const signedNotInvoiced = qs.filter((q) => q.status === 'signed' && !inv.some((i) => i.parentQuoteId === q.id));

  // Pièces manquantes : factures émises sans PDF archivé.
  const invoicePdfIds = new Set(docs.filter((d) => d.kind === 'invoice_pdf' && d.linkedEntityId).map((d) => d.linkedEntityId));
  const issued = inv.filter((i) => i.status !== 'draft' && i.status !== 'cancelled');
  const missingPdf = issued.filter((i) => !invoicePdfIds.has(i.id));

  const anomalies: CheckItem[] = [
    { label: 'Devis signés à facturer', count: signedNotInvoiced.length, route: '/ventes' },
    { label: 'Factures à émettre (brouillons)', count: draftInvoices.length, route: '/ventes' },
    { label: 'Factures en retard', count: lateInvoices.length, route: '/ventes' },
    { label: 'Factures partiellement payées', count: partialInvoices.length, route: '/ventes' },
  ];
  const pieces: CheckItem[] = [
    { label: 'Factures émises sans PDF archivé', count: missingPdf.length, route: '/documents' },
  ];
  const anomaliesTotal = anomalies.reduce((s, i) => s + i.count, 0);
  const piecesTotal = pieces.reduce((s, i) => s + i.count, 0);
  const allClear = anomaliesTotal === 0 && piecesTotal === 0;

  // Période FEC = le mois courant (de YYYY-MM-01 au dernier jour du mois).
  const pad = (n: number) => String(n).padStart(2, '0');
  const [yy, mm] = mois.key.split('-').map(Number);
  const fecFrom = `${mois.key}-01`;
  const fecTo = `${mois.key}-${pad(new Date(yy ?? 2026, mm ?? 1, 0).getDate())}`;

  const onExportFec = async (): Promise<void> => {
    try {
      const res = await exportFec.mutateAsync({ from: fecFrom, to: fecTo });
      // E9/CLOTURE-1 : shareFec est LA source unique — octets ISO 8859-15 (arrêté du
      // 29/07/2013), fini l'écriture UTF-8 legacy qui contredisait le mimeType.
      const shared = await shareFec(res);
      if (shared === 'unavailable')
        Alert.alert('Export FEC', `${res.filename} généré (${res.entryCount} écriture${res.entryCount > 1 ? 's' : ''}).`);
      if (res.warnings.length) Alert.alert('Avertissements FEC', res.warnings.join('\n'));
    } catch (e) {
      Alert.alert('Oups', appErrorMessage(e));
    }
  };

  const Row = ({ item }: { item: CheckItem }) => {
    const done = item.count === 0;
    return (
      <Pressable
        onPress={item.count > 0 ? () => router.push(item.route) : undefined}
        accessibilityRole={item.count > 0 ? 'button' : undefined}
        accessibilityLabel={`${item.label} : ${item.count}`}
        style={{ flexDirection: 'row', alignItems: 'center', gap: 10, paddingVertical: 10 }}
      >
        <Ionicons
          name={done ? 'checkmark-circle' : 'alert-circle'}
          size={20}
          color={done ? semantic.success : semantic.warning}
        />
        <Text style={[font('body'), { color: colors.ink800, flex: 1 }]}>{item.label}</Text>
        <Badge label={String(item.count)} tone={done ? 'success' : 'warning'} />
        {item.count > 0 ? <Ionicons name="chevron-forward" size={18} color={colors.slate400} /> : null}
      </Pressable>
    );
  };

  return (
    <View style={{ flex: 1, backgroundColor: colors.bg }}>
      <View style={{ paddingTop: insets.top + 8, paddingHorizontal: 20, paddingBottom: 8 }}>
        <Pressable
          onPress={() => router.back()}
          accessibilityRole="button"
          accessibilityLabel="Retour"
          style={{ flexDirection: 'row', alignItems: 'center', gap: 4 }}
        >
          <Ionicons name="chevron-back" size={22} color={colors.ink800} />
          <Text style={[font('body'), { color: colors.ink800 }]}>Accueil</Text>
        </Pressable>
        <Text style={[font('screenH1'), { color: colors.ink900, marginTop: 6 }]}>Clôture — {mois.label}</Text>
      </View>

      <ScrollView contentContainerStyle={{ padding: 20, paddingTop: 8, gap: 16, paddingBottom: 40 }}>
        {!entitled ? (
          <Card>
            <Text style={[font('cardTitle'), { color: colors.ink900 }]}>Clôture assistée — offre Pro</Text>
            <Text style={[font('sub'), { color: colors.slate500, marginTop: 6 }]}>
              La préparation du mois pour le comptable (anomalies, pièces manquantes, export) fait partie de l’offre Operations.
            </Text>
            <View style={{ height: 12 }} />
            <Button title="Voir les offres" variant="secondary" onPress={() => router.push('/compte')} />
          </Card>
        ) : loading ? (
          <Card>
            <Text style={[font('body'), { color: colors.slate500 }]}>Bob prépare ton mois…</Text>
          </Card>
        ) : (
          <>
            <Card style={allClear ? { backgroundColor: semantic.successBg, borderColor: semantic.success } : undefined}>
              {allClear ? (
                <View style={{ flexDirection: 'row', alignItems: 'center', gap: 10 }}>
                  <Ionicons name="checkmark-circle" size={28} color={semantic.success} />
                  <Text style={[font('cardTitle'), { color: semantic.success, flex: 1 }]}>Tout est prêt pour le comptable.</Text>
                </View>
              ) : (
                <>
                  <Text style={[font('cardTitle'), { color: colors.ink900 }]}>Bob a préparé ton mois.</Text>
                  <Text style={[font('body'), { color: colors.ink800, marginTop: 6 }]}>
                    Il reste <Text style={{ color: semantic.warning }}>{anomaliesTotal} point{anomaliesTotal > 1 ? 's' : ''} à arbitrer</Text>
                    {' · '}
                    <Text style={{ color: semantic.warning }}>{piecesTotal} pièce{piecesTotal > 1 ? 's' : ''} manquante{piecesTotal > 1 ? 's' : ''}</Text>.
                  </Text>
                </>
              )}
            </Card>

            <View>
              <SectionHeader title="À arbitrer" />
              <Card>
                {anomalies.map((item, i) => (
                  <View key={item.label}>
                    {i > 0 ? <View style={{ height: 1, backgroundColor: colors.lineSoft }} /> : null}
                    <Row item={item} />
                  </View>
                ))}
              </Card>
            </View>

            <View>
              <SectionHeader title="Pièces" />
              <Card>
                {pieces.map((item, i) => (
                  <View key={item.label}>
                    {i > 0 ? <View style={{ height: 1, backgroundColor: colors.lineSoft }} /> : null}
                    <Row item={item} />
                  </View>
                ))}
              </Card>
            </View>

            {/* CLOTURE-1 : le dossier chiffré — résultat provisoire + balance générale. */}
            {balance.rows.length > 0 ? (
              <View>
                <SectionHeader title="Balance générale" />
                <Card>
                  <View style={{ flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' }}>
                    <View style={{ flex: 1, paddingRight: 12 }}>
                      <Text style={[font('meta'), { color: colors.slate400 }]}>Résultat provisoire</Text>
                      <Text
                        style={[
                          font('screenH1'),
                          {
                            color: balance.resultCents >= 0 ? semantic.success : semantic.warning,
                            fontVariant: ['tabular-nums'],
                            marginTop: 2,
                          },
                        ]}
                      >
                        {balance.resultCents >= 0 ? '+' : '−'}{formatEUR(Math.abs(balance.resultCents))}
                      </Text>
                      <Text style={[font('meta'), { color: colors.slate400, marginTop: 2 }]}>
                        Produits {formatEUR(balance.revenueCents)} − charges {formatEUR(balance.chargesCents)}
                      </Text>
                    </View>
                    <Badge
                      label={balance.balanced ? 'Équilibrée' : 'Déséquilibrée'}
                      tone={balance.balanced ? 'success' : 'danger'}
                    />
                  </View>
                  <View style={{ height: 1, backgroundColor: colors.lineSoft, marginVertical: 10 }} />
                  {balance.rows.map((row) => (
                    <View
                      key={row.account}
                      accessible
                      accessibilityLabel={`Compte ${row.account}, solde ${formatEUR(row.balanceCents)}`}
                      style={{ flexDirection: 'row', alignItems: 'center', paddingVertical: 6 }}
                    >
                      <Text style={[font('sub'), { color: colors.ink800, width: 62, fontVariant: ['tabular-nums'] }]}>
                        {row.account}
                      </Text>
                      <Text style={[font('meta'), { color: colors.slate400, flex: 1, textAlign: 'right', fontVariant: ['tabular-nums'] }]}>
                        D {formatEUR(row.debitCents)}
                      </Text>
                      <Text style={[font('meta'), { color: colors.slate400, flex: 1, textAlign: 'right', fontVariant: ['tabular-nums'] }]}>
                        C {formatEUR(row.creditCents)}
                      </Text>
                      <Text
                        style={[
                          font('sub'),
                          {
                            color: row.balanceCents >= 0 ? colors.ink900 : colors.slate500,
                            width: 92,
                            textAlign: 'right',
                            fontWeight: '700',
                            fontVariant: ['tabular-nums'],
                          },
                        ]}
                      >
                        {formatEUR(row.balanceCents)}
                      </Text>
                    </View>
                  ))}
                  <View style={{ height: 1, backgroundColor: colors.lineSoft, marginVertical: 8 }} />
                  <View style={{ flexDirection: 'row', justifyContent: 'space-between' }}>
                    <Text style={[font('meta'), { color: colors.slate400 }]}>Totaux</Text>
                    <Text style={[font('meta'), { color: colors.slate500, fontVariant: ['tabular-nums'] }]}>
                      D {formatEUR(balance.totalDebitCents)} · C {formatEUR(balance.totalCreditCents)}
                    </Text>
                  </View>
                </Card>
              </View>
            ) : null}

            {/* CDR-1 : compte de résultat normé — la cascade que l'expert associé attend. */}
            {balance.rows.length > 0 ? (
              <View>
                <SectionHeader title="Compte de résultat" />
                <Card>
                  {(
                    [
                      { label: 'Produits d’exploitation', cents: income.exploitationProduitsCents },
                      { label: 'Charges d’exploitation', cents: -income.exploitationChargesCents },
                      { label: 'Résultat d’exploitation', cents: income.resultatExploitationCents, strong: true },
                      ...(income.financierProduitsCents !== 0 || income.financierChargesCents !== 0
                        ? [{ label: 'Résultat financier', cents: income.resultatFinancierCents, strong: true }]
                        : []),
                      ...(income.resultatExceptionnelCents !== 0
                        ? [{ label: 'Résultat exceptionnel', cents: income.resultatExceptionnelCents, strong: true }]
                        : []),
                    ] as { label: string; cents: number; strong?: boolean }[]
                  ).map((r) => (
                    <View
                      key={r.label}
                      style={{
                        flexDirection: 'row',
                        justifyContent: 'space-between',
                        alignItems: 'center',
                        paddingVertical: r.strong ? 8 : 6,
                        borderTopWidth: r.strong ? 1 : 0,
                        borderTopColor: colors.lineSoft,
                      }}
                    >
                      <Text style={[r.strong ? font('cardTitle') : font('body'), { color: colors.ink800 }]}>
                        {r.label}
                      </Text>
                      <Text
                        style={[
                          r.strong ? font('cardTitle') : font('body'),
                          {
                            color: r.cents >= 0 ? colors.ink900 : semantic.warning,
                            fontVariant: ['tabular-nums'],
                          },
                        ]}
                      >
                        {r.cents >= 0 ? '' : '−'}{formatEUR(Math.abs(r.cents))}
                      </Text>
                    </View>
                  ))}
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
                    <Text style={[font('cardTitle'), { color: colors.ink900 }]}>Résultat net</Text>
                    <Text
                      style={[
                        font('screenH1'),
                        {
                          color: income.resultatNetCents >= 0 ? semantic.success : semantic.warning,
                          fontVariant: ['tabular-nums'],
                        },
                      ]}
                    >
                      {income.resultatNetCents >= 0 ? '+' : '−'}{formatEUR(Math.abs(income.resultatNetCents))}
                    </Text>
                  </View>
                  {income.impotBeneficesCents !== 0 ? (
                    <Text style={[font('meta'), { color: colors.slate400, marginTop: 6 }]}>
                      Après impôt sur les bénéfices de {formatEUR(income.impotBeneficesCents)}.
                    </Text>
                  ) : null}
                </Card>
              </View>
            ) : null}

            {/* BILAN-1 : le bilan que l'expert associé signe — actif / passif équilibrés. */}
            {balance.rows.length > 0 ? (
              <View>
                <SectionHeader title="Bilan" />
                <Card>
                  <View style={{ flexDirection: 'row', gap: 14 }}>
                    {(
                      [
                        {
                          titre: 'Actif',
                          total: bilan.actif.totalCents,
                          postes: [
                            { label: 'Immobilisations', cents: bilan.actif.immobilisationsNettesCents },
                            { label: 'Stocks', cents: bilan.actif.stocksCents },
                            { label: 'Créances', cents: bilan.actif.creancesCents },
                            { label: 'Disponibilités', cents: bilan.actif.disponibilitesCents },
                          ],
                        },
                        {
                          titre: 'Passif',
                          total: bilan.passif.totalCents,
                          postes: [
                            { label: 'Capitaux propres', cents: bilan.passif.capitauxPropresCents },
                            { label: 'Résultat', cents: bilan.passif.resultatNetCents },
                            { label: 'Provisions', cents: bilan.passif.provisionsCents },
                            { label: 'Emprunts', cents: bilan.passif.empruntsCents },
                            { label: 'Dettes', cents: bilan.passif.dettesCents },
                            { label: 'Découvert', cents: bilan.passif.decouvertCents },
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
                              <Text
                                style={[
                                  font('meta'),
                                  {
                                    color: p.cents >= 0 ? colors.ink800 : semantic.warning,
                                    fontVariant: ['tabular-nums'],
                                  },
                                ]}
                              >
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
                          <Text style={[font('sub'), { color: colors.ink900, fontWeight: '700' }]}>Total</Text>
                          <Text style={[font('sub'), { color: colors.ink900, fontWeight: '700', fontVariant: ['tabular-nums'] }]}>
                            {formatEUR(col.total)}
                          </Text>
                        </View>
                      </View>
                    ))}
                  </View>
                  <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8, marginTop: 12 }}>
                    <Ionicons
                      name={bilan.balanced ? 'checkmark-circle' : 'alert-circle'}
                      size={18}
                      color={bilan.balanced ? semantic.success : semantic.warning}
                    />
                    <Text style={[font('meta'), { color: bilan.balanced ? semantic.success : semantic.warning, flex: 1 }]}>
                      {bilan.balanced
                        ? 'Actif = passif : ton bilan est équilibré.'
                        : `Écart de ${formatEUR(Math.abs(bilan.ecartCents))} — Bob vérifie le journal.`}
                    </Text>
                  </View>
                </Card>
              </View>
            ) : null}

            <View>
              <SectionHeader title="Export cabinet" />
              <Button
                title={exportFec.isPending ? 'Génération du FEC…' : 'Exporter pour le comptable (FEC)'}
                variant="secondary"
                disabled={exportFec.isPending}
                onPress={() => void onExportFec()}
              />
              <Text style={[font('meta'), { color: colors.slate400, marginTop: 8, textAlign: 'center' }]}>
                Fichier des écritures conforme (FEC) — {mois.label}.
              </Text>
            </View>
          </>
        )}
      </ScrollView>
    </View>
  );
}
