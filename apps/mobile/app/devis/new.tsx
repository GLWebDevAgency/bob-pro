import { useState } from 'react';
import { ScrollView, View, Text, Pressable } from 'react-native';
import { useRouter } from 'expo-router';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { Ionicons } from '@expo/vector-icons';
import { formatEUR, type CreateQuoteInput } from '@bob/core';
import { useTheme } from '../../src/theme';
import {
  useCustomers,
  useCreateQuote,
  useSendQuote,
  useSignQuote,
  useGenerateInvoice,
  useIssueInvoice,
  useRegisterPayment,
} from '../../src/data/hooks';
import { Card, Button, Chip, MoneyText, Badge, SectionHeader, font } from '../../src/components/ui';

const PRESET_LINES = [
  { label: 'Chauffe-eau 200 L', category: 'supply' as const, qty: 1, unitPriceHT: 80000, vatRate: 10 as const },
  { label: "Main d'oeuvre (pose)", category: 'labor' as const, qty: 1, unitPriceHT: 68000, vatRate: 10 as const },
];

type Step = 'compose' | 'sent' | 'signed' | 'invoiced' | 'paid';

export default function DevisNew() {
  const { colors, semantic } = useTheme();
  const insets = useSafeAreaInsets();
  const router = useRouter();
  const { data: customers } = useCustomers();

  const [customerId, setCustomerId] = useState<string | null>(null);
  const [deposit, setDeposit] = useState(true);
  const [step, setStep] = useState<Step>('compose');
  const [quoteId, setQuoteId] = useState<string | null>(null);
  const [invoiceId, setInvoiceId] = useState<string | null>(null);
  const [number, setNumber] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const createQuote = useCreateQuote();
  const sendQuote = useSendQuote();
  const signQuote = useSignQuote();
  const generateInvoice = useGenerateInvoice();
  const issueInvoice = useIssueInvoice();
  const registerPayment = useRegisterPayment();

  const busy =
    createQuote.isPending ||
    sendQuote.isPending ||
    signQuote.isPending ||
    generateInvoice.isPending ||
    issueInvoice.isPending ||
    registerPayment.isPending;

  const ttc = PRESET_LINES.reduce((s, l) => s + Math.round(l.qty * l.unitPriceHT * (1 + l.vatRate / 100)), 0);
  const net = deposit ? Math.round(ttc * 0.3) : ttc;
  const customer = (customers ?? []).find((c) => c.id === customerId) ?? null;

  const handle = async (fn: () => Promise<void>): Promise<void> => {
    setError(null);
    try {
      await fn();
    } catch (e) {
      setError(e && typeof e === 'object' ? JSON.stringify(e) : 'Une erreur est survenue.');
    }
  };

  const onSend = () =>
    handle(async () => {
      if (!customerId) return;
      const input: Omit<CreateQuoteInput, 'companyId'> = {
        customerId,
        lines: [...PRESET_LINES],
        context: { housingOlderThan2y: true },
        ...(deposit ? { depositPct: 30 } : {}),
      };
      const created = await createQuote.mutateAsync(input);
      setQuoteId(created.quoteId);
      const sent = await sendQuote.mutateAsync(created.quoteId);
      setNumber(sent.number);
      setStep('sent');
    });

  const onSign = () =>
    handle(async () => {
      if (!quoteId) return;
      await signQuote.mutateAsync({ quoteId, signerName: customer?.name ?? 'Client' });
      setStep('signed');
    });

  const onInvoice = () =>
    handle(async () => {
      if (!quoteId) return;
      const gen = await generateInvoice.mutateAsync({ quoteId });
      setInvoiceId(gen.invoiceId);
      const issued = await issueInvoice.mutateAsync(gen.invoiceId);
      setNumber(issued.number);
      setStep('invoiced');
    });

  const onPay = () =>
    handle(async () => {
      if (!invoiceId) return;
      await registerPayment.mutateAsync({ invoiceId, amount: net, method: 'transfer' });
      setStep('paid');
    });

  return (
    <View style={{ flex: 1, backgroundColor: colors.bg, paddingTop: insets.top + 8 }}>
      <View style={{ flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', paddingHorizontal: 20, paddingBottom: 8 }}>
        <Text style={[font('screenH1'), { color: colors.ink900 }]}>Nouveau devis</Text>
        <Pressable onPress={() => router.back()} accessibilityRole="button" accessibilityLabel="Fermer">
          <Ionicons name="close" size={26} color={colors.slate500} />
        </Pressable>
      </View>

      <ScrollView contentContainerStyle={{ padding: 20, gap: 16 }}>
        {error ? (
          <Card style={{ borderColor: semantic.danger }}>
            <Text style={[font('sub'), { color: semantic.danger }]}>{error}</Text>
          </Card>
        ) : null}

        {step === 'compose' ? (
          <>
            <View>
              <SectionHeader title="Client" />
              <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 8 }}>
                {(customers ?? []).map((c) => (
                  <Chip key={c.id} label={c.name} active={customerId === c.id} onPress={() => setCustomerId(c.id)} />
                ))}
              </View>
            </View>

            <Card>
              <SectionHeader title="Lignes" />
              {PRESET_LINES.map((l) => (
                <View key={l.label} style={{ flexDirection: 'row', justifyContent: 'space-between', paddingVertical: 6 }}>
                  <Text style={[font('body'), { color: colors.ink800, flex: 1 }]}>{l.label}</Text>
                  <MoneyText cents={l.unitPriceHT} />
                </View>
              ))}
              <View style={{ height: 1, backgroundColor: colors.lineSoft, marginVertical: 10 }} />
              <View style={{ flexDirection: 'row', justifyContent: 'space-between' }}>
                <Text style={[font('cardTitle'), { color: colors.ink900 }]}>Total TTC (TVA 10 %)</Text>
                <MoneyText cents={ttc} variant="big" />
              </View>
              <View style={{ marginTop: 12, flexDirection: 'row', alignItems: 'center', gap: 10 }}>
                <Chip label="Acompte 30 %" active={deposit} onPress={() => setDeposit((d) => !d)} />
                {deposit ? <Text style={[font('sub'), { color: colors.slate500 }]}>Net à payer : {formatEUR(net)}</Text> : null}
              </View>
              <View style={{ marginTop: 10 }}>
                <Badge label="Mentions légales ajoutées" tone="success" />
              </View>
            </Card>

            <Button title="Envoyer pour signature" onPress={onSend} disabled={!customerId || busy} loading={busy} />
          </>
        ) : null}

        {step === 'sent' ? (
          <Card>
            <Badge label={`Devis ${number ?? ''} envoyé`} tone="b2b" />
            <Text style={[font('body'), { color: colors.ink800, marginTop: 12 }]}>
              Envoyé à {customer?.name}. Bob relance sous 3 jours sans réponse.
            </Text>
            <View style={{ height: 16 }} />
            <Button title="Ouvrir la signature (sur place)" onPress={onSign} disabled={busy} loading={busy} />
          </Card>
        ) : null}

        {step === 'signed' ? (
          <Card>
            <View style={{ alignItems: 'center', gap: 8 }}>
              <Ionicons name="checkmark-circle" size={48} color={semantic.success} />
              <Text style={[font('cardTitle'), { color: colors.ink900 }]}>Devis signé</Text>
              <Text style={[font('sub'), { color: colors.slate500, textAlign: 'center' }]}>
                Bob génère la {deposit ? "facture d'acompte" : 'facture'} conforme.
              </Text>
            </View>
            <View style={{ height: 16 }} />
            <Button title={deposit ? "Générer la facture d'acompte" : 'Générer la facture'} onPress={onInvoice} disabled={busy} loading={busy} />
          </Card>
        ) : null}

        {step === 'invoiced' ? (
          <Card>
            <Badge label={`Facture ${number ?? ''}`} tone="b2g" />
            <View style={{ flexDirection: 'row', justifyContent: 'space-between', marginTop: 12 }}>
              <Text style={[font('cardTitle'), { color: colors.ink900 }]}>Net à encaisser</Text>
              <MoneyText cents={net} variant="big" />
            </View>
            <View style={{ height: 16 }} />
            <Button title="Encaisser" onPress={onPay} disabled={busy} loading={busy} />
          </Card>
        ) : null}

        {step === 'paid' ? (
          <Card style={{ backgroundColor: semantic.successBg, borderColor: semantic.success }}>
            <View style={{ alignItems: 'center', gap: 8 }}>
              <Ionicons name="cash-outline" size={48} color={semantic.success} />
              <Text style={[font('screenH1'), { color: semantic.success }]}>Payé !</Text>
              <MoneyText cents={net} variant="big" color={semantic.success} />
            </View>
            <View style={{ height: 16 }} />
            <Button title="Terminer" variant="secondary" onPress={() => router.back()} />
          </Card>
        ) : null}
      </ScrollView>
    </View>
  );
}
