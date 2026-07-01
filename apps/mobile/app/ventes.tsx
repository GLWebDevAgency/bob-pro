import { useRef, useState, type ReactNode } from 'react';
import { ScrollView, View, Text, Pressable, Alert } from 'react-native';
import { useRouter } from 'expo-router';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { Ionicons } from '@expo/vector-icons';
import { formatEUR } from '@bob/core';
import type { QuoteView, InvoiceView } from '@bob/api-client';
import { useTheme } from '../src/theme';
import {
  useCustomers,
  useQuotes,
  useInvoices,
  useSendQuote,
  useSignQuote,
  useRefuseQuote,
  useGenerateInvoice,
  useIssueInvoice,
  useRegisterPayment,
  useInvoicePaymentLink,
  appErrorMessage,
} from '../src/data/hooks';
import { Card, Badge, Button, MoneyText, SectionHeader, font } from '../src/components/ui';

type QuoteStatus = QuoteView['status'];
type InvoiceStatus = InvoiceView['status'];
type Tone = 'b2b' | 'b2g' | 'particulier' | 'success' | 'warning' | 'danger' | 'ai';

// Statut -> pastille (label FR + ton DA). Record exhaustif : ajouter un statut oblige à le mapper.
const QUOTE_BADGE: Record<QuoteStatus, { label: string; tone: Tone }> = {
  draft: { label: 'Brouillon', tone: 'warning' },
  sent: { label: 'Envoyé', tone: 'b2b' },
  viewed: { label: 'Vu', tone: 'b2b' },
  signed: { label: 'Signé', tone: 'success' },
  refused: { label: 'Refusé', tone: 'danger' },
  expired: { label: 'Expiré', tone: 'danger' },
};
const INVOICE_BADGE: Record<InvoiceStatus, { label: string; tone: Tone }> = {
  draft: { label: 'Brouillon', tone: 'warning' },
  issued: { label: 'Émise', tone: 'b2b' },
  partially_paid: { label: 'Partielle', tone: 'warning' },
  paid: { label: 'Payée', tone: 'success' },
  late: { label: 'En retard', tone: 'danger' },
  cancelled: { label: 'Annulée', tone: 'danger' },
};

// Actionnable en premier : les brouillons/à traiter remontent, le terminé descend.
const QUOTE_ORDER: Record<QuoteStatus, number> = { draft: 0, sent: 1, viewed: 1, signed: 2, refused: 4, expired: 4 };
const INVOICE_ORDER: Record<InvoiceStatus, number> = { draft: 0, late: 1, issued: 2, partially_paid: 2, paid: 4, cancelled: 4 };

export default function Ventes() {
  const { colors, semantic } = useTheme();
  const insets = useSafeAreaInsets();
  const router = useRouter();

  const customers = useCustomers();
  const quotes = useQuotes();
  const invoices = useInvoices();

  const sendQuote = useSendQuote();
  const signQuote = useSignQuote();
  const refuseQuote = useRefuseQuote();
  const generateInvoice = useGenerateInvoice();
  const issueInvoice = useIssueInvoice();
  const registerPayment = useRegisterPayment();
  const paymentLink = useInvoicePaymentLink();

  // Une seule action à la fois : clé = `${docId}:${verbe}`. `busy` (state) pilote le spinner/disabled ;
  // `lock` (ref) est le verrou autoritaire — il bloque un 2e tap dans la même frame, avant tout re-render
  // (sinon un `Générer la facture` tapé 2× créerait 2 factures).
  const [busy, setBusy] = useState<string | null>(null);
  const lock = useRef(false);
  // Génération de facture = one-shot par devis : après un succès on masque l'action pour empêcher
  // les factures en double (le domaine ne fait pas encore transiter le devis ni ne déduplique).
  const [invoiced, setInvoiced] = useState<Set<string>>(new Set());

  const nameOf = (customerId: string) => (customers.data ?? []).find((c) => c.id === customerId)?.name ?? 'Client';

  const run = async (key: string, fn: () => Promise<unknown>): Promise<void> => {
    if (lock.current) return; // action déjà en cours
    lock.current = true;
    setBusy(key);
    try {
      await fn();
    } catch (e) {
      Alert.alert('Oups', appErrorMessage(e));
    } finally {
      lock.current = false;
      setBusy(null);
    }
  };

  // Plancher de sécurité manuel : confirmation explicite avant une action sensible (miroir du safety floor de Bob).
  // `destructive` (rouge iOS) réservé aux actions vraiment destructrices (refus) — sinon le signal se dilue.
  const confirmThen = (title: string, message: string, onOk: () => void, destructive = false): void =>
    Alert.alert(title, message, [
      { text: 'Annuler', style: 'cancel' },
      { text: 'Confirmer', style: destructive ? 'destructive' : 'default', onPress: onOk },
    ]);

  const loading = quotes.isLoading || invoices.isLoading;
  const errored = quotes.isError || invoices.isError;

  const sortedQuotes = [...(quotes.data ?? [])].sort((a, b) => QUOTE_ORDER[a.status] - QUOTE_ORDER[b.status]);
  const sortedInvoices = [...(invoices.data ?? [])].sort((a, b) => INVOICE_ORDER[a.status] - INVOICE_ORDER[b.status]);

  // ── Actions contextuelles selon le statut ──────────────────────────────
  const quoteActions = (q: QuoteView): ReactNode => {
    if (q.status === 'draft') {
      return (
        <Button
          title="Envoyer"
          loading={busy === `${q.id}:send`}
          disabled={!!busy}
          onPress={() =>
            confirmThen('Envoyer le devis', `Le devis part chez ${nameOf(q.customerId)}. Continuer ?`, () =>
              void run(`${q.id}:send`, () => sendQuote.mutateAsync(q.id)),
            )
          }
        />
      );
    }
    if (q.status === 'sent' || q.status === 'viewed') {
      return (
        <View style={{ flexDirection: 'row', gap: 8 }}>
          <View style={{ flex: 1 }}>
            <Button
              title="Signer sur place"
              loading={busy === `${q.id}:sign`}
              disabled={!!busy}
              onPress={() =>
                confirmThen('Signature sur place', 'Le client signe le devis maintenant. Confirmer ?', () =>
                  void run(`${q.id}:sign`, () => signQuote.mutateAsync({ quoteId: q.id, signerName: nameOf(q.customerId) })),
                )
              }
            />
          </View>
          <View style={{ flex: 1 }}>
            <Button
              title="Refuser"
              variant="danger"
              loading={busy === `${q.id}:refuse`}
              disabled={!!busy}
              onPress={() =>
                confirmThen(
                  'Refuser le devis',
                  'Marquer ce devis comme refusé par le client ?',
                  () => void run(`${q.id}:refuse`, () => refuseQuote.mutateAsync(q.id)),
                  true,
                )
              }
            />
          </View>
        </View>
      );
    }
    if (q.status === 'signed') {
      if (invoiced.has(q.id)) {
        return <Badge label="Facture générée" tone="success" />;
      }
      return (
        <Button
          title="Générer la facture"
          loading={busy === `${q.id}:gen`}
          disabled={!!busy}
          onPress={() =>
            void run(`${q.id}:gen`, async () => {
              await generateInvoice.mutateAsync({ quoteId: q.id });
              setInvoiced((s) => new Set(s).add(q.id)); // one-shot : plus de re-génération dans cette session
            })
          }
        />
      );
    }
    return null; // refused / expired : rien à faire
  };

  const invoiceActions = (inv: InvoiceView): ReactNode => {
    if (inv.status === 'draft') {
      return (
        <Button
          title="Émettre"
          loading={busy === `${inv.id}:issue`}
          disabled={!!busy}
          onPress={() =>
            confirmThen(
              'Émettre la facture',
              'Action définitive : numéro légal attribué et transmission e-invoicing. Émettre ?',
              () => void run(`${inv.id}:issue`, () => issueInvoice.mutateAsync(inv.id)),
            )
          }
        />
      );
    }
    if (inv.status === 'issued' || inv.status === 'partially_paid' || inv.status === 'late') {
      const remaining = Math.max(0, inv.totals.ttc - inv.paid);
      return (
        <View style={{ flexDirection: 'row', gap: 8 }}>
          {remaining > 0 ? (
            <View style={{ flex: 1 }}>
              <Button
                title="Marquer payée"
                loading={busy === `${inv.id}:pay`}
                disabled={!!busy}
                onPress={() =>
                  confirmThen(
                    'Enregistrer le paiement',
                    `Encaisser ${formatEUR(remaining)} met à jour ta compta (CA, TVA, relances). Confirmer ?`,
                    () =>
                      void run(`${inv.id}:pay`, () =>
                        registerPayment.mutateAsync({
                          invoiceId: inv.id,
                          amount: remaining,
                          method: 'transfer',
                          idempotencyKey: `mobile-ventes:payment:${inv.id}:${inv.paid}:${remaining}:transfer`,
                        }),
                      ),
                  )
                }
              />
            </View>
          ) : null}
          <View style={{ flex: 1 }}>
            {/* Le hook gère déjà erreur (Alert) + ouverture de l'URL — on n'enveloppe PAS dans run() (sinon double Alert). */}
            <Button
              title="Lien de paiement"
              variant="secondary"
              loading={paymentLink.isPending}
              disabled={!!busy || paymentLink.isPending}
              onPress={() => {
                if (lock.current) return;
                paymentLink.mutate(inv.id);
              }}
            />
          </View>
        </View>
      );
    }
    return null; // paid / cancelled : rien à faire
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
        <Text style={[font('screenH1'), { color: colors.ink900, marginTop: 6 }]}>Devis &amp; Factures</Text>
      </View>

      <ScrollView contentContainerStyle={{ padding: 20, paddingTop: 8, gap: 20, paddingBottom: 40 }}>
        {loading ? (
          <Card>
            <Text style={[font('body'), { color: colors.slate500 }]}>Chargement…</Text>
          </Card>
        ) : errored ? (
          <Card style={{ borderColor: semantic.danger }}>
            <Text
              accessibilityRole="alert"
              accessibilityLiveRegion="assertive"
              style={[font('sub'), { color: semantic.danger }]}
            >
              Impossible de charger tes documents.
            </Text>
            <View style={{ height: 12 }} />
            <Button
              title="Réessayer"
              variant="secondary"
              onPress={() => {
                void quotes.refetch();
                void invoices.refetch();
              }}
            />
          </Card>
        ) : (
          <>
            <View>
              <SectionHeader title="Devis" />
              {sortedQuotes.length === 0 ? (
                <Card>
                  <Text style={[font('body'), { color: colors.slate500 }]}>Aucun devis pour l&apos;instant.</Text>
                </Card>
              ) : (
                <View style={{ gap: 10 }}>
                  {sortedQuotes.map((q) => {
                    const badge = QUOTE_BADGE[q.status];
                    const actions = quoteActions(q);
                    return (
                      <Card key={q.id}>
                        <View style={{ flexDirection: 'row', justifyContent: 'space-between', alignItems: 'flex-start' }}>
                          <View style={{ flex: 1, paddingRight: 12 }}>
                            <Text style={[font('cardTitle'), { color: colors.ink900 }]}>{q.number ?? 'Brouillon'}</Text>
                            <Text style={[font('meta'), { color: colors.slate400, marginTop: 2 }]}>{nameOf(q.customerId)}</Text>
                          </View>
                          <View style={{ alignItems: 'flex-end', gap: 6 }}>
                            <MoneyText cents={q.totals.ttc} />
                            <Badge label={badge.label} tone={badge.tone} />
                          </View>
                        </View>
                        {actions ? <View style={{ marginTop: 12 }}>{actions}</View> : null}
                      </Card>
                    );
                  })}
                </View>
              )}
            </View>

            <View>
              <SectionHeader title="Factures" />
              {sortedInvoices.length === 0 ? (
                <Card>
                  <Text style={[font('body'), { color: colors.slate500 }]}>Aucune facture pour l&apos;instant.</Text>
                </Card>
              ) : (
                <View style={{ gap: 10 }}>
                  {sortedInvoices.map((inv) => {
                    const badge = INVOICE_BADGE[inv.status];
                    const actions = invoiceActions(inv);
                    const remaining = Math.max(0, inv.totals.ttc - inv.paid);
                    const partiallyPaid = inv.paid > 0 && remaining > 0;
                    return (
                      <Card key={inv.id}>
                        <View style={{ flexDirection: 'row', justifyContent: 'space-between', alignItems: 'flex-start' }}>
                          <View style={{ flex: 1, paddingRight: 12 }}>
                            <Text style={[font('cardTitle'), { color: colors.ink900 }]}>{inv.number ?? 'Brouillon'}</Text>
                            <Text style={[font('meta'), { color: colors.slate400, marginTop: 2 }]}>{nameOf(inv.customerId)}</Text>
                          </View>
                          <View style={{ alignItems: 'flex-end', gap: 6 }}>
                            <MoneyText cents={inv.totals.ttc} />
                            {partiallyPaid ? (
                              <Text style={[font('meta'), { color: colors.slate500 }]}>Reste {formatEUR(remaining)}</Text>
                            ) : null}
                            <Badge label={badge.label} tone={badge.tone} />
                          </View>
                        </View>
                        {actions ? <View style={{ marginTop: 12 }}>{actions}</View> : null}
                      </Card>
                    );
                  })}
                </View>
              )}
            </View>
          </>
        )}
      </ScrollView>
    </View>
  );
}
