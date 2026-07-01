import { ScrollView, View, Text, Pressable, Alert } from 'react-native';
import { useLocalSearchParams, useRouter } from 'expo-router';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { Ionicons } from '@expo/vector-icons';
import { formatEUR } from '@bob/core';
import { challengeFor, buildActionDiff } from '@bob/ai';
import { useTheme } from '../../src/theme';
import { useCustomers, useInvoices, useInvoicePaymentLink, useRegisterPayment, appErrorMessage } from '../../src/data/hooks';
import { Card, Badge, ScoreBar, MoneyText, Button, SectionHeader, font } from '../../src/components/ui';
import { useConfirm } from '../../src/components/ConfirmSheet';

const ACCOUNTING = { mutating: true, outbound: false, riskTier: 'accounting' } as const;

export default function ClientDetail() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const { colors, semantic } = useTheme();
  const insets = useSafeAreaInsets();
  const router = useRouter();
  const { data } = useCustomers();
  const { data: invoices } = useInvoices();
  const pay = useInvoicePaymentLink();
  const register = useRegisterPayment();
  const confirm = useConfirm();
  const customer = (data ?? []).find((c) => c.id === id) ?? null;
  const custInvoices = (invoices ?? []).filter((i) => i.customerId === id && i.status !== 'draft');

  const einvoice =
    customer?.type === 'b2g'
      ? { label: 'Public · Chorus Pro', tone: 'b2g' as const }
      : customer?.type === 'b2b'
        ? { label: 'Entreprise · PA', tone: 'b2b' as const }
        : { label: 'Particulier · e-reporting', tone: 'particulier' as const };

  return (
    <ScrollView style={{ flex: 1, backgroundColor: colors.bg }} contentContainerStyle={{ paddingBottom: 40 }}>
      <View style={{ paddingTop: insets.top + 8, paddingHorizontal: 20, paddingBottom: 8 }}>
        <Pressable onPress={() => router.back()} accessibilityRole="button" accessibilityLabel="Retour" style={{ flexDirection: 'row', alignItems: 'center', gap: 4 }}>
          <Ionicons name="chevron-back" size={22} color={colors.ink800} />
          <Text style={[font('body'), { color: colors.ink800 }]}>Clients</Text>
        </Pressable>
      </View>

      {!customer ? (
        <View style={{ padding: 20 }}>
          <Text style={[font('body'), { color: colors.slate500 }]}>Client introuvable.</Text>
        </View>
      ) : (
        <View style={{ padding: 20, gap: 16 }}>
          <View style={{ alignItems: 'center', gap: 8 }}>
            <View style={{ width: 72, height: 72, borderRadius: 22, backgroundColor: colors.ink600, alignItems: 'center', justifyContent: 'center' }}>
              <Text style={[font('pageTitle'), { color: '#fff' }]}>
                {customer.name.split(/\s+/).slice(0, 2).map((w) => w[0]?.toUpperCase() ?? '').join('')}
              </Text>
            </View>
            <Text style={[font('screenH1'), { color: colors.ink900 }]}>{customer.name}</Text>
            <Badge label={einvoice.label} tone={einvoice.tone} />
          </View>

          <Card>
            <Text style={[font('meta'), { color: colors.slate400, marginBottom: 6 }]}>Score de paiement</Text>
            <View style={{ flexDirection: 'row', alignItems: 'center', gap: 12 }}>
              <Text style={[font('bigNum'), { color: colors.ink900 }]}>{customer.score}/100</Text>
              <View style={{ flex: 1 }}>
                <ScoreBar value={customer.score} />
              </View>
            </View>
          </Card>

          <Card>
            <SectionHeader title="Encours" />
            <MoneyText cents={customer.outstanding} variant="big" color={customer.outstanding > 0 ? semantic.danger : semantic.success} />
          </Card>

          {custInvoices.length > 0 ? (
            <Card>
              <SectionHeader title="Factures" />
              {custInvoices.map((inv) => {
                const payable = inv.status === 'issued' || inv.status === 'partially_paid' || inv.status === 'late';
                return (
                  <View key={inv.id} style={{ marginTop: 10 }}>
                    <View style={{ flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center' }}>
                      <Text style={[font('cardTitle'), { color: colors.ink900 }]}>{inv.number ?? '—'}</Text>
                      <Text style={[font('cardTitle'), { color: colors.ink900 }]}>{formatEUR(inv.totals.netToPay)}</Text>
                    </View>
                    <Text style={[font('meta'), { color: colors.slate400 }]}>{inv.status}</Text>
                    {payable ? (
                      <View style={{ marginTop: 8, flexDirection: 'row', gap: 8 }}>
                        <View style={{ flex: 1 }}>
                          <Button
                            title={register.isPending ? '…' : 'Marquer payée'}
                            disabled={register.isPending}
                            onPress={() =>
                              void (async () => {
                                // Assiette = netToPay (le domaine plafonne l'encaissement à netToPay, acompte compris).
                                const remaining = Math.max(0, inv.totals.netToPay - inv.paid);
                                // Plancher de sécurité vérifiable : aperçu avant/après + re-confirmation du montant.
                                const ok = await confirm({
                                  title: 'Enregistrer le paiement',
                                  message: 'Met à jour ta compta (CA, TVA, relances).',
                                  diff: buildActionDiff(
                                    'encaisser_facture',
                                    { amountCents: remaining },
                                    { number: inv.number, remainingCents: remaining },
                                  ),
                                  challenge: challengeFor(ACCOUNTING, 'confirm_all', { amountCents: remaining }),
                                });
                                if (ok)
                                  register.mutate(
                                    {
                                      invoiceId: inv.id,
                                      amount: remaining,
                                      method: 'transfer',
                                      idempotencyKey: `mobile-client:payment:${inv.id}:${inv.paid}:${remaining}:transfer`,
                                    },
                                    { onError: (e) => Alert.alert('Oups', appErrorMessage(e)) },
                                  );
                              })()
                            }
                          />
                        </View>
                        <View style={{ flex: 1 }}>
                          <Button
                            title={pay.isPending ? 'Lien…' : 'Lien de paiement'}
                            variant="secondary"
                            disabled={pay.isPending}
                            onPress={() => pay.mutate(inv.id)}
                          />
                        </View>
                      </View>
                    ) : null}
                  </View>
                );
              })}
            </Card>
          ) : null}

          <Button title="Créer un devis" onPress={() => router.push('/devis/new')} />
        </View>
      )}
    </ScrollView>
  );
}
