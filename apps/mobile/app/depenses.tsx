/**
 * Dépenses — les charges fournisseurs (E10, décision produit : compagnon du cycle achats
 * E1). Pattern écran poussé (A3-C17) : rangée retour sticky (bg .92) + en-tête compact →
 * HÉROS stats réelles (summarizeExpenses @bob/core : reste à payer / décaissé du mois /
 * TVA déductible du mois) → CTA scan (même flux OCR que Bob) → liste des dépenses
 * (à payer d'abord) avec l'action E4 « Payer » : PayExpense = transition + écriture de
 * décaissement 401/512 au journal de banque, confirmation typée ACCOUNTING (plancher de
 * sécurité identique à l'encaissement). Zéro hex, zéro fixture, états de premier rang.
 */
import { useMemo, useState } from 'react';
import { Pressable, ScrollView, Text, View } from 'react-native';
import { useRouter } from 'expo-router';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { challengeFor } from '@bob/ai';
import { formatEUR, summarizeExpenses, type ExpenseCategory, type ExpenseProps } from '@bob/core';
import { patterns } from '@bob/tokens';
import { t, type I18nKey } from '@bob/i18n';
import {
  Button,
  Card,
  IconTile,
  SectionHeader,
  Skeleton,
  StatusBadge,
  Toast,
  font,
  useTheme,
  type StatusBadgeVariant,
} from '@bob/ui';
import { useExpenses, usePayExpense } from '../src/data/hooks';
import { usePublishAgentContext, type AgentContext } from '../src/agent';
import { useConfirm } from '../src/components/ConfirmSheet';
import { CheckIcon, ChevronLeftIcon, WalletIcon } from '../src/components/icons';

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

function todayISO(d: Date = new Date()): string {
  const m = String(d.getMonth() + 1).padStart(2, '0');
  return `${d.getFullYear()}-${m}-${String(d.getDate()).padStart(2, '0')}`;
}

function formatDate(iso: string): string {
  const [y, m, d] = iso.slice(0, 10).split('-');
  return d && m && y ? `${d}/${m}/${y}` : iso.slice(0, 10);
}

export default function Depenses() {
  const { personality, colors, semantic } = useTheme();
  const insets = useSafeAreaInsets();
  const router = useRouter();
  const expenses = useExpenses();
  const pay = usePayExpense();
  const confirm = useConfirm();
  const [toast, setToast] = useState<string | null>(null);

  const month = todayISO().slice(0, 7);
  const summary = useMemo(() => summarizeExpenses(expenses.data ?? [], { month }), [expenses.data, month]);
  // À payer d'abord (les plus récentes en tête), puis les payées.
  const sorted = useMemo(() => {
    const list = [...(expenses.data ?? [])];
    return list.sort(
      (a, b) =>
        (a.status === 'to_pay' ? 0 : 1) - (b.status === 'to_pay' ? 0 : 1) ||
        b.documentDate.localeCompare(a.documentDate),
    );
  }, [expenses.data]);

  // Bob voit les dépenses AFFICHÉES : « résume cette dépense », « paie celle-ci » (S2).
  const agentContext = useMemo<AgentContext>(
    () => ({
      screen: { name: 'depenses', instanceId: 'depenses' },
      entities: sorted.slice(0, 12).map((e) => ({ type: 'expense' as const, id: e.id, label: e.supplierName })),
      capabilities: ['screen.read', 'expense.read'],
    }),
    [sorted],
  );
  usePublishAgentContext(agentContext);

  const payExpense = (expense: ExpenseProps): void => {
    void (async () => {
      const ok = await confirm({
        title: t('dep.payConfirmTitle', { personality }),
        message: t('dep.payConfirmBody', {
          personality,
          params: { supplier: expense.supplierName, amount: formatEUR(expense.totalTtcCents) },
        }),
        challenge: challengeFor(ACCOUNTING, 'confirm_all', { amountCents: expense.totalTtcCents }),
      });
      if (!ok) return;
      pay.mutate(
        { expenseId: expense.id },
        {
          onSuccess: () =>
            setToast(t('dep.paidToast', { personality, params: { supplier: expense.supplierName } })),
          onError: () => setToast(t('dep.payError', { personality })),
        },
      );
    })();
  };

  return (
    <View style={{ flex: 1, backgroundColor: colors.bg }}>
      <ScrollView
        style={{ flex: 1 }}
        stickyHeaderIndices={[0]}
        showsVerticalScrollIndicator={false}
        contentContainerStyle={{ paddingBottom: insets.bottom + 34 }}
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
            style={{ flexDirection: 'row', alignItems: 'center', gap: 4, alignSelf: 'flex-start', minHeight: 34 }}
          >
            <ChevronLeftIcon color={colors.ink800} size={18} strokeWidth={2.2} />
            <Text style={[font('label', 600), { fontSize: 15, color: colors.ink800 }]}>
              {t('dep.back', { personality })}
            </Text>
          </Pressable>
        </View>

        <View style={{ paddingTop: 2, paddingHorizontal: 20, paddingBottom: 4 }}>
          <Text style={[font('eyebrow'), { color: colors.slate400 }]}>{t('dep.eyebrow', { personality })}</Text>
          <Text style={[font('pageTitle'), { color: colors.ink800, marginTop: 2 }]} accessibilityRole="header">
            {t('dep.title', { personality })}
          </Text>
          <Text style={[font('body'), { color: colors.slate500, marginTop: 3 }]}>
            {t('dep.subtitle', { personality })}
          </Text>
        </View>

        {expenses.isLoading ? (
          <View style={{ paddingTop: 16, paddingHorizontal: 18, gap: 12 }}>
            {/* Héros (Card radius={20} padding={16}) mesurée dans ce fichier : eyebrow + gros
                montant + sous-titre + 2 mini-stats + CTA ≈ 228 de haut, zéro saut à l'arrivée. */}
            <Skeleton height={228} radius={20} />
            <Skeleton height={140} radius={18} />
          </View>
        ) : expenses.isError ? (
          <View style={{ paddingTop: 16, paddingHorizontal: 18 }}>
            <Card>
              <Text accessibilityRole="alert" style={[font('sub'), { color: colors.slate500 }]}>
                {t('dep.dataError', { personality })}
              </Text>
              <View style={{ height: 12 }} />
              <Button
                title={t('dep.retry', { personality })}
                variant="secondary"
                onPress={() => void expenses.refetch()}
              />
            </Card>
          </View>
        ) : (
          <>
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
                <Text style={{ ...font('sub', 500), fontSize: 12.5, color: colors.slate500, marginTop: 2 }}>
                  {summary.toPayCount === 1
                    ? t('dep.toPayCountOne', { personality })
                    : t('dep.toPayCount', { personality, params: { count: summary.toPayCount } })}
                </Text>
                <View style={{ flexDirection: 'row', gap: 10, marginTop: 14 }}>
                  {(
                    [
                      { key: 'dep.paidMonth', cents: summary.paidThisMonthCents, color: colors.ink800 },
                      { key: 'dep.vatMonth', cents: summary.vatDeductibleThisMonthCents, color: semantic.success },
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
                      <Text style={[font('label'), { color: colors.slate400 }]}>{sorted.length}</Text>
                    }
                  />
                </View>
                <View style={{ paddingHorizontal: 18, gap: 11 }}>
                  {sorted.map((expense) => (
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
                          <Text style={{ ...font('cardTitle'), color: colors.ink800 }} numberOfLines={1}>
                            {expense.supplierName}
                          </Text>
                          <Text style={[font('meta'), { color: colors.slate300, marginTop: 2 }]} numberOfLines={1}>
                            {t(CAT_KEY[expense.category], { personality })} · {formatDate(expense.documentDate)}
                          </Text>
                        </View>
                        <View style={{ alignItems: 'flex-end', gap: 6 }}>
                          <Text style={{ ...font('sub', 700), color: colors.ink800, fontVariant: ['tabular-nums'] }}>
                            {formatEUR(expense.totalTtcCents)}
                          </Text>
                          <StatusBadge
                            label={t(expense.status === 'paid' ? 'dep.statusPaid' : 'dep.statusToPay', {
                              personality,
                            })}
                            variant={expense.status === 'paid' ? 'success' : 'particulier'}
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
                            disabled={pay.isPending}
                            style={{ alignSelf: 'flex-start' }}
                            onPress={() => payExpense(expense)}
                            accessibilityLabel={`${t('dep.pay', { personality })} — ${expense.supplierName}`}
                          />
                        </View>
                      ) : null}
                    </Card>
                  ))}
                </View>
              </>
            )}
          </>
        )}
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
