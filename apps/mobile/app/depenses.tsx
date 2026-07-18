/**
 * Dépenses — les charges fournisseurs (E10, décision produit : compagnon du cycle achats
 * E1). Pattern écran poussé (A3-C17) : rangée retour sticky (bg .92) + en-tête compact →
 * HÉROS stats réelles (summarizeExpenses @bob/core : reste à payer / décaissé du mois /
 * TVA déductible du mois) → CTA scan (même flux OCR que Bob) → liste des dépenses
 * (à payer d'abord) avec l'action E4 « Enregistrer comme payée » : preuve explicite + transition
 * + écriture de décaissement 401/512 au journal de banque, confirmation typée ACCOUNTING (plancher de
 * sécurité identique à l'encaissement). Zéro hex, zéro fixture, états de premier rang.
 */
import { useEffect, useMemo, useRef, useState } from 'react';
import { Pressable, ScrollView, Text, View } from 'react-native';
import { useRouter } from 'expo-router';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { challengeFor } from '@bob/ai';
import {
  formatEUR,
  isLegacyUnverifiedExpensePayment,
  parisDateOnly,
  summarizeExpenses,
  type ExpenseCategory,
  type ExpensePaymentEvidenceInput,
  type ExpenseProps,
  type PaymentMethod,
} from '@bob/core';
import { patterns } from '@bob/tokens';
import { t, type I18nKey } from '@bob/i18n';
import {
  Button,
  Card,
  ErrorRetry,
  IconTile,
  SectionHeader,
  Skeleton,
  StatusBadge,
  Toast,
  font,
  useTheme,
  type StatusBadgeVariant,
} from '@bob/ui';
import { useExpenses, usePayExpense, useRegularizeExpensePayment } from '../src/data/hooks';
import { usePublishAgentContext, type AgentContext } from '../src/agent';
import { useConfirm } from '../src/components/ConfirmSheet';
import {
  ExpensePaymentSheet,
  type ExpensePaymentSheetMode,
} from '../src/components/ExpensePaymentSheet';
import { CheckIcon, ChevronLeftIcon, WalletIcon } from '../src/components/icons';
import { useBobAwareScrollInsets } from '../src/components/use-bob-aware-scroll-insets';
import { displayExpensePaymentDate } from '../src/finance/expense-payment-form';
import { hasBlockingAuthoritativeDataError } from '../src/data/authoritative-query-state';

const CAT_KEY: Record<ExpenseCategory, I18nKey> = {
  fournitures: 'dep.catFournitures',
  materiel: 'dep.catMateriel',
  carburant: 'dep.catCarburant',
  repas: 'dep.catRepas',
  sous_traitance: 'dep.catSousTraitance',
  autre: 'dep.catAutre',
};

const CAT_TONE: Record<ExpenseCategory, StatusBadgeVariant> = {
  fournitures: 'success',
  materiel: 'b2b',
  carburant: 'particulier',
  repas: 'particulier',
  sous_traitance: 'b2g',
  autre: 'b2g',
};

/** Même palier de confirmation que l'encaissement : une écriture au journal se confirme. */
const ACCOUNTING = { mutating: true, outbound: false, riskTier: 'accounting' } as const;

function formatDate(iso: string): string {
  const [y, m, d] = iso.slice(0, 10).split('-');
  return d && m && y ? `${d}/${m}/${y}` : iso.slice(0, 10);
}

export default function Depenses() {
  const { personality, colors, semantic } = useTheme();
  const insets = useSafeAreaInsets();
  const bobScrollInsets = useBobAwareScrollInsets({ minimumBottom: insets.bottom + 34 });
  const router = useRouter();
  const expenses = useExpenses();
  const pay = usePayExpense();
  const regularize = useRegularizeExpensePayment();
  const confirm = useConfirm();
  const [toast, setToast] = useState<string | null>(null);
  const [paymentSheetExpense, setPaymentSheetExpense] = useState<ExpenseProps | null>(null);
  // `record` = règlement d'une dépense à payer ; `regularize` = justification d'une ligne
  // historique payée sans preuve (même formulaire, endpoint dédié).
  const [paymentSheetMode, setPaymentSheetMode] = useState<ExpensePaymentSheetMode>('record');
  const [paymentDraft, setPaymentDraft] = useState<{
    expense: ExpenseProps;
    evidence: ExpensePaymentEvidenceInput;
  } | null>(null);
  const [paymentFormError, setPaymentFormError] = useState<string | null>(null);
  const paymentConfirmTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const dataReady = expenses.data !== undefined;
  const blockingError = hasBlockingAuthoritativeDataError([expenses]);
  const staleError = dataReady && expenses.isError;
  const dataFresh = dataReady && !staleError;
  const dataFreshRef = useRef(dataFresh);
  dataFreshRef.current = dataFresh;
  const expensesRef = useRef(expenses.data);
  expensesRef.current = expenses.data;

  const month = parisDateOnly().slice(0, 7);
  const summary = useMemo(
    () => expenses.data === undefined ? null : summarizeExpenses(expenses.data, { month }),
    [expenses.data, month],
  );
  // À payer d'abord (les plus récentes en tête), puis les payées.
  const sorted = useMemo(() => {
    if (expenses.data === undefined) return [];
    const list = [...expenses.data];
    return list.sort(
      (a, b) =>
        (a.status === 'to_pay' ? 0 : 1) - (b.status === 'to_pay' ? 0 : 1) ||
        b.documentDate.localeCompare(a.documentDate),
    );
  }, [expenses.data]);

  // Bob voit les dépenses AFFICHÉES. Le runtime peut enregistrer un paiement déjà réalisé,
  // jamais prétendre initier un virement sans rail bancaire.
  const agentContext = useMemo<AgentContext>(
    () => {
      const contextReady = dataFresh;
      return {
        screen: { name: 'depenses', instanceId: 'depenses' },
        entities: contextReady
          ? sorted
              .slice(0, 12)
              .map((e) => ({ type: 'expense' as const, id: e.id, label: e.supplierName }))
          : [],
        capabilities: contextReady ? ['screen.read', 'expense.read'] : [],
      };
    },
    [dataFresh, sorted],
  );
  usePublishAgentContext(agentContext);

  useEffect(
    () => () => {
      if (paymentConfirmTimer.current !== null) clearTimeout(paymentConfirmTimer.current);
    },
    [],
  );

  useEffect(() => {
    if (dataFresh) return;
    if (paymentConfirmTimer.current !== null) {
      clearTimeout(paymentConfirmTimer.current);
      paymentConfirmTimer.current = null;
    }
    setPaymentSheetExpense(null);
    setPaymentDraft(null);
    setPaymentFormError(null);
  }, [dataFresh]);

  const paymentMethodLabel = (method: PaymentMethod): string =>
    t(
      method === 'card'
        ? 'dep.paymentMethodCard'
        : method === 'transfer'
          ? 'dep.paymentMethodTransfer'
          : 'dep.paymentMethodCash',
      { personality },
    );

  const openPaymentSheet = (expense: ExpenseProps, mode: ExpensePaymentSheetMode = 'record'): void => {
    if (!dataFresh) return;
    setPaymentDraft(null);
    setPaymentFormError(null);
    setPaymentSheetMode(mode);
    setPaymentSheetExpense(expense);
  };

  const submitPaymentEvidence = (
    expense: ExpenseProps,
    evidence: ExpensePaymentEvidenceInput,
    mode: ExpensePaymentSheetMode,
  ): void => {
    if (!dataFresh) return;
    const regularizing = mode === 'regularize';
    setPaymentDraft({ expense, evidence });
    setPaymentFormError(null);
    setPaymentSheetExpense(null);
    if (paymentConfirmTimer.current !== null) clearTimeout(paymentConfirmTimer.current);
    // La Sheet partagée termine sa sortie avant d'ouvrir la confirmation comptable : une seule
    // modale native à la fois, notamment sur iOS.
    paymentConfirmTimer.current = setTimeout(() => {
      paymentConfirmTimer.current = null;
      void (async () => {
      const ok = await confirm({
        title: t(regularizing ? 'dep.regularizeConfirmTitle' : 'dep.payConfirmTitle', { personality }),
        message: t(regularizing ? 'dep.regularizeConfirmBody' : 'dep.payConfirmBody', {
          personality,
          params: {
            supplier: expense.supplierName,
            amount: formatEUR(expense.totalTtcCents),
            date: displayExpensePaymentDate(evidence.paidOn),
            method: paymentMethodLabel(evidence.method),
            reference: evidence.reference ? ` Référence : ${evidence.reference}.` : '',
          },
        }),
        challenge: challengeFor(ACCOUNTING, 'confirm_all', { amountCents: expense.totalTtcCents }),
      });
      if (!ok) {
        if (dataFreshRef.current) {
          setPaymentSheetMode(mode);
          setPaymentSheetExpense(expense);
        }
        return;
      }
      const currentExpense = expensesRef.current?.find((candidate) => candidate.id === expense.id);
      const stillActionable = regularizing
        ? currentExpense !== undefined && isLegacyUnverifiedExpensePayment(currentExpense)
        : currentExpense?.status === 'to_pay';
      if (!dataFreshRef.current || !stillActionable) {
        setToast(t('dep.dataError', { personality }));
        void expenses.refetch();
        return;
      }
      const callbacks = {
        onSuccess: () => {
          setPaymentDraft(null);
          setToast(
            t(regularizing ? 'dep.regularizedToast' : 'dep.paidToast', {
              personality,
              params: { supplier: expense.supplierName },
            }),
          );
        },
        onError: () => {
          setPaymentFormError(
            t(regularizing ? 'dep.regularizeError' : 'dep.payError', { personality }),
          );
          if (dataFreshRef.current) {
            setPaymentSheetMode(mode);
            setPaymentSheetExpense(expense);
          }
        },
      };
      if (regularizing) regularize.mutate({ expenseId: expense.id, ...evidence }, callbacks);
      else pay.mutate({ expenseId: expense.id, ...evidence }, callbacks);
      })();
    }, 240);
  };

  return (
    <View style={{ flex: 1, backgroundColor: colors.bg }}>
      <ScrollView
        style={{ flex: 1 }}
        stickyHeaderIndices={[0]}
        showsVerticalScrollIndicator={false}
        contentContainerStyle={{ paddingBottom: bobScrollInsets.paddingBottom }}
        automaticallyAdjustKeyboardInsets={bobScrollInsets.automaticallyAdjustKeyboardInsets}
        scrollIndicatorInsets={{ bottom: bobScrollInsets.scrollIndicatorBottom }}
      >
        {/* Rangée retour sticky (pattern A3-C17). */}
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
            accessibilityLabel={t('dep.back', { personality })}
            onPress={() => router.back()}
            hitSlop={8}
            style={{
              flexDirection: 'row',
              alignItems: 'center',
              gap: 4,
              alignSelf: 'flex-start',
              minHeight: 34,
            }}
          >
            <ChevronLeftIcon color={colors.ink800} size={18} strokeWidth={2.2} />
            <Text style={[font('label', 600), { fontSize: 15, color: colors.ink800 }]}>
              {t('dep.back', { personality })}
            </Text>
          </Pressable>
        </View>

        <View style={{ paddingTop: 2, paddingHorizontal: 20, paddingBottom: 4 }}>
          <Text style={[font('eyebrow'), { color: colors.slate400 }]}>
            {t('dep.eyebrow', { personality })}
          </Text>
          <Text
            style={[font('pageTitle'), { color: colors.ink800, marginTop: 2 }]}
            accessibilityRole="header"
          >
            {t('dep.title', { personality })}
          </Text>
          <Text style={[font('body'), { color: colors.slate500, marginTop: 3 }]}>
            {t('dep.subtitle', { personality })}
          </Text>
        </View>

        {!dataReady && !blockingError ? (
          <View style={{ paddingTop: 16, paddingHorizontal: 18, gap: 12 }}>
            {/* Héros (Card radius={20} padding={16}) mesurée dans ce fichier : eyebrow + gros
                montant + sous-titre + 2 mini-stats + CTA ≈ 228 de haut, zéro saut à l'arrivée. */}
            <Skeleton height={228} radius={20} />
            <Skeleton height={140} radius={18} />
          </View>
        ) : blockingError ? (
          <View style={{ paddingTop: 16, paddingHorizontal: 18 }}>
            <ErrorRetry
              message={t('dep.dataError', { personality })}
              onRetry={() => void expenses.refetch()}
              retrying={expenses.isRefetching}
            />
          </View>
        ) : summary === null ? null : (
          <>
            {staleError ? (
              <View style={{ paddingTop: 16, paddingHorizontal: 18 }}>
                <ErrorRetry
                  message={t('dep.dataError', { personality })}
                  onRetry={() => void expenses.refetch()}
                  retrying={expenses.isRefetching}
                />
              </View>
            ) : null}
            {/* HÉROS : reste à payer (la dette fournisseurs vivante) + mois + TVA. */}
            <View style={{ paddingTop: 16, paddingHorizontal: 18 }}>
              <Card radius={20} padding={16}>
                <Text style={[font('eyebrow'), { color: colors.slate400 }]}>
                  {t('dep.toPay', { personality })}
                </Text>
                <Text
                  style={{
                    ...font('bigNum'),
                    fontSize: 27,
                    color: summary.toPayCents > 0 ? semantic.warning : colors.ink900,
                    marginTop: 3,
                    fontVariant: ['tabular-nums'],
                  }}
                >
                  {formatEUR(summary.toPayCents)}
                </Text>
                <Text
                  style={{
                    ...font('sub', 500),
                    fontSize: 12.5,
                    color: colors.slate500,
                    marginTop: 2,
                  }}
                >
                  {summary.toPayCount === 1
                    ? t('dep.toPayCountOne', { personality })
                    : t('dep.toPayCount', { personality, params: { count: summary.toPayCount } })}
                </Text>
                <View style={{ flexDirection: 'row', gap: 10, marginTop: 14 }}>
                  {(
                    [
                      {
                        key: 'dep.paidMonth',
                        cents: summary.paidThisMonthCents,
                        color: colors.ink800,
                      },
                      {
                        key: 'dep.vatMonth',
                        cents: summary.vatDeductibleThisMonthCents,
                        color: semantic.success,
                      },
                    ] as const
                  ).map(({ key, cents, color }) => (
                    <View
                      key={key}
                      style={{
                        flex: 1,
                        backgroundColor: colors.lineSoft,
                        borderRadius: 13,
                        paddingVertical: 11,
                        paddingHorizontal: 12,
                      }}
                    >
                      <Text style={[font('meta'), { fontSize: 11.5, color: colors.slate400 }]}>
                        {t(key, { personality })}
                      </Text>
                      <Text
                        style={{
                          ...font('cardTitle'),
                          fontSize: 16,
                          color,
                          marginTop: 1,
                          fontVariant: ['tabular-nums'],
                        }}
                      >
                        {formatEUR(cents)}
                      </Text>
                    </View>
                  ))}
                </View>
                <View style={{ height: 12 }} />
                <Button
                  title={t('dep.scanCta', { personality })}
                  variant="secondary"
                  onPress={() => router.push('/scan-document')}
                />
              </Card>
            </View>

            {sorted.length === 0 ? (
              <View style={{ paddingTop: 12, paddingHorizontal: 18 }}>
                <Card>
                  <Text style={[font('sub'), { color: colors.slate500, lineHeight: 19 }]}>
                    {t('dep.empty', { personality })}
                  </Text>
                </Card>
              </View>
            ) : (
              <>
                <View style={{ paddingTop: 22, paddingHorizontal: 20 }}>
                  <SectionHeader
                    title={t('dep.sectionList', { personality })}
                    action={
                      <Text style={[font('label'), { color: colors.slate400 }]}>
                        {sorted.length}
                      </Text>
                    }
                  />
                </View>
                <View style={{ paddingHorizontal: 18, gap: 11 }}>
                  {sorted.map((expense) => {
                    // Ligne HISTORIQUE payée sans preuve (migration lane preuves) : badge
                    // distinct porteur de sens + action de régularisation — jamais le même
                    // « Payée » qu'une ligne justifiée.
                    const legacyUnverified = isLegacyUnverifiedExpensePayment(expense);
                    return (
                    <Card key={expense.id} padding={15}>
                      <View style={{ flexDirection: 'row', alignItems: 'flex-start', gap: 11 }}>
                        <IconTile tone={CAT_TONE[expense.category]} size={34} radius={10}>
                          <WalletIcon
                            color={
                              CAT_TONE[expense.category] === 'success'
                                ? semantic.success
                                : CAT_TONE[expense.category] === 'b2b'
                                  ? semantic.b2b
                                  : CAT_TONE[expense.category] === 'b2g'
                                    ? semantic.b2g
                                    : semantic.particulier
                            }
                            size={17}
                            strokeWidth={2}
                          />
                        </IconTile>
                        <View style={{ flex: 1, minWidth: 0 }}>
                          <Text
                            style={{ ...font('cardTitle'), color: colors.ink800 }}
                            numberOfLines={1}
                          >
                            {expense.supplierName}
                          </Text>
                          <Text
                            style={[font('meta'), { color: colors.slate300, marginTop: 2 }]}
                            numberOfLines={1}
                          >
                            {t(CAT_KEY[expense.category], { personality })} ·{' '}
                            {formatDate(expense.documentDate)}
                          </Text>
                        </View>
                        <View style={{ alignItems: 'flex-end', gap: 6 }}>
                          <Text
                            style={{
                              ...font('sub', 700),
                              color: colors.ink800,
                              fontVariant: ['tabular-nums'],
                            }}
                          >
                            {formatEUR(expense.totalTtcCents)}
                          </Text>
                          <StatusBadge
                            label={t(
                              legacyUnverified
                                ? 'dep.statusPaidLegacy'
                                : expense.status === 'paid'
                                  ? 'dep.statusPaid'
                                  : 'dep.statusToPay',
                              {
                                personality,
                              },
                            )}
                            variant={
                              legacyUnverified
                                ? 'warning'
                                : expense.status === 'paid'
                                  ? 'success'
                                  : 'particulier'
                            }
                          />
                        </View>
                      </View>
                      {expense.status === 'to_pay' ? (
                        <View
                          style={{
                            marginTop: 12,
                            paddingTop: 12,
                            borderTopWidth: 1,
                            borderTopColor: colors.lineSoft,
                          }}
                        >
                          <Button
                            title={t('dep.pay', { personality })}
                            variant="primary"
                            size="compact"
                            radius={11}
                            loading={pay.isPending && pay.variables?.expenseId === expense.id}
                            disabled={pay.isPending || !dataFresh}
                            style={{ alignSelf: 'flex-start' }}
                            onPress={() => openPaymentSheet(expense)}
                            accessibilityLabel={`${t('dep.pay', { personality })} — ${expense.supplierName}`}
                          />
                        </View>
                      ) : legacyUnverified ? (
                        <View
                          style={{
                            marginTop: 12,
                            paddingTop: 12,
                            borderTopWidth: 1,
                            borderTopColor: colors.lineSoft,
                          }}
                        >
                          <Button
                            title={t('dep.regularize', { personality })}
                            variant="secondary"
                            size="compact"
                            radius={11}
                            loading={
                              regularize.isPending
                              && regularize.variables?.expenseId === expense.id
                            }
                            disabled={regularize.isPending || !dataFresh}
                            style={{ alignSelf: 'flex-start' }}
                            onPress={() => openPaymentSheet(expense, 'regularize')}
                            accessibilityLabel={`${t('dep.regularize', { personality })} — ${expense.supplierName}`}
                          />
                        </View>
                      ) : null}
                    </Card>
                    );
                  })}
                </View>
              </>
            )}
          </>
        )}
      </ScrollView>

      <ExpensePaymentSheet
        visible={paymentSheetExpense !== null && dataFresh}
        personality={personality}
        supplierName={paymentSheetExpense?.supplierName ?? null}
        mode={paymentSheetMode}
        initialEvidence={
          paymentSheetExpense && paymentDraft?.expense.id === paymentSheetExpense.id
            ? paymentDraft.evidence
            : null
        }
        error={paymentFormError}
        onClose={() => {
          setPaymentSheetExpense(null);
          setPaymentDraft(null);
          setPaymentFormError(null);
        }}
        onSubmit={(evidence) => {
          if (paymentSheetExpense && dataFresh)
            submitPaymentEvidence(paymentSheetExpense, evidence, paymentSheetMode);
        }}
      />

      <Toast
        message={toast ?? ''}
        visible={toast !== null}
        onHide={() => setToast(null)}
        icon={<CheckIcon color={colors.surface} />}
      />
    </View>
  );
}
