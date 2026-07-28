/**
 * PR-12c — fiche CONTRAT DE MAINTENANCE (écrans §3.1-§3.2, kit matière Bob du train n°2).
 * Chaque badge/CTA est DÉRIVÉ des faits serveur (période arithmétique, couverture par les
 * factures réelles, alerte renouvellement) — l'écran constate, il ne réinterprète jamais :
 *  · les transitions interdites sont des CTA ABSENTS, jamais grisés ;
 *  · « Reconduire » n'est pas un bouton : la reconduction tacite est un FAIT CALCULÉ,
 *    étiqueté « (calculé) » dans l'historique (revue P10) ;
 *  · l'annulation d'une facture annuelle RALLUME le CTA toute seule — l'écran l'explique ;
 *  · « Préparer la facture annuelle » = BROUILLON en un tap (« rien n'est envoyé ») ; si la
 *    TVA re-suggérée diverge du contrat (bascule de régime — amélioration 2), le bloc
 *    « TVA recalculée » affiche l'écart honnêtement AVANT d'ouvrir le brouillon ;
 *  · préavis : LegalHint AFFICHÉ, jamais bloquant (la résiliation subie est actée, tracée).
 */
import { useMemo, useState } from 'react';
import { AccessibilityInfo, Alert, Pressable, RefreshControl, ScrollView, Text, TextInput, View } from 'react-native';
import { useLocalSearchParams, useRouter } from 'expo-router';
import { t } from '@bob/i18n';
import {
  BobSurface,
  Button,
  EmptyState,
  ErrorRetry,
  LegalHint,
  Sheet,
  SkeletonRow,
  StatusBadge,
  font,
  useTheme,
} from '@bob/ui';
import { formatEURWhole, type Totals } from '@bob/core';
import {
  appErrorMessage,
  useActivateMaintenanceContract,
  useChantierEquipments,
  useDeleteDraftMaintenanceContract,
  useMaintenanceContract,
  usePrepareContractAnnualInvoice,
  useTerminateMaintenanceContract,
} from '../../src/data/hooks';
import { ScreenHeader } from '../../src/components/screen-header';
import { useBobAwareScrollInsets } from '../../src/components/use-bob-aware-scroll-insets';
import { useConfirm } from '../../src/components/ConfirmSheet';
import {
  contractHistoryEntries,
  frContractDate,
  inclusivePeriodOf,
} from '../../src/components/contract-fiche.logic';
import { usePublishAgentContext, type AgentContext } from '../../src/agent';

const DATE_ONLY = /^\d{4}-\d{2}-\d{2}$/;

/** Bloc « TVA recalculée » (amélioration 2) — l'écart contrat/brouillon, jamais réécrit en
 * silence. Conservé à l'écran tant que la fiche est ouverte (l'utilisateur choisit d'ouvrir). */
interface VatDivergenceNotice {
  invoiceId: string;
  totals: Totals;
  contractTotals: Totals;
}

export default function FicheContrat() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const { personality, colors, controls, semantic } = useTheme();
  const router = useRouter();
  const scrollInsets = useBobAwareScrollInsets();
  const confirm = useConfirm();

  const query = useMaintenanceContract(id);
  const view = query.data ?? null;
  const contract = view?.contract ?? null;
  // [Amélioration 4] « 3 couverts, dont 1 retiré » — le retrait AFFICHÉ, jamais masqué.
  const siteEquipments = useChantierEquipments(contract?.chantierId ?? '', contract?.chantierId != null);
  const activate = useActivateMaintenanceContract();
  const terminate = useTerminateMaintenanceContract();
  const deleteDraft = useDeleteDraftMaintenanceContract();
  const prepare = usePrepareContractAnnualInvoice();

  const [terminateOpen, setTerminateOpen] = useState(false);
  const [terminateDate, setTerminateDate] = useState('');
  const [terminateNote, setTerminateNote] = useState('');
  const [terminateError, setTerminateError] = useState<string | null>(null);
  const [vatNotice, setVatNotice] = useState<VatDivergenceNotice | null>(null);

  usePublishAgentContext(
    useMemo<AgentContext>(
      () => ({
        screen: { name: '/contrat/[id]', instanceId: `contract:${id}` },
        entities: contract ? [{ type: 'contract' as const, id: contract.id, label: contract.label }] : [],
        capabilities: ['screen.read'],
      }),
      [contract, id],
    ),
  );

  if (query.isPending) {
    return (
      <View style={{ flex: 1, backgroundColor: colors.bg }}>
        <ScreenHeader
          backLabel={t('contrat.eyebrow', { personality })}
          onBack={() => router.back()}
          eyebrow={t('contrat.eyebrow', { personality })}
          title="…"
        />
        <View style={{ paddingHorizontal: 16 }}>
          <BobSurface tone="neutral" emphasis="raised">
            <SkeletonRow />
            <SkeletonRow />
            <SkeletonRow />
          </BobSurface>
        </View>
      </View>
    );
  }
  if (query.isError || view === null || contract === null) {
    return (
      <View style={{ flex: 1, backgroundColor: colors.bg }}>
        <ScreenHeader
          backLabel={t('contrat.eyebrow', { personality })}
          onBack={() => router.back()}
          eyebrow={t('contrat.eyebrow', { personality })}
          title={t('contrat.notFound', { personality })}
        />
        <View style={{ paddingHorizontal: 16 }}>
          {query.isError ? (
            <ErrorRetry message={t('contrat.dataError', { personality })} onRetry={() => void query.refetch()} />
          ) : (
            <EmptyState body={t('contrat.notFound', { personality })} />
          )}
        </View>
      </View>
    );
  }

  const lifecycle = view.lifecycle;
  const expired = lifecycle.expired;
  const badge =
    contract.status === 'draft'
      ? { variant: 'warning' as const, label: t('contrat.badgeDraft', { personality }) }
      : contract.status === 'terminated'
        ? {
            variant: 'neutral' as const,
            label: t('contrat.badgeTerminated', {
              personality,
              params: { date: frContractDate((contract.terminatedAt ?? '').slice(0, 10)) },
            }),
          }
        : expired !== null
          ? {
              variant: 'warning' as const,
              label: t('contrat.badgeExpired', {
                personality,
                params: { date: frContractDate(expired.since) },
              }),
            }
          : { variant: 'success' as const, label: t('contrat.badgeActive', { personality }) };

  const period = view.currentPeriod === null ? null : inclusivePeriodOf(view.currentPeriod);
  const coveredBy = view.currentPeriodCoveredBy;
  const billingDue = view.billingDue;
  const renewal = view.renewalAlert;
  const history = contractHistoryEntries({ contract, renewals: lifecycle.renewals });
  const coveredEquipments = new Set(contract.equipmentIds);
  const retiredCovered = (siteEquipments.data ?? []).filter(
    (equipment) => coveredEquipments.has(equipment.id) && equipment.status === 'retired',
  ).length;

  const handlePrepare = async (): Promise<void> => {
    try {
      const prepared = await prepare.mutateAsync(contract.id);
      AccessibilityInfo.announceForAccessibility(t('contrat.prepareNote', { personality }));
      if (prepared.vatDivergence) {
        // Amélioration 2 : l'écart est DIT avant d'ouvrir le brouillon — jamais en silence.
        setVatNotice({
          invoiceId: prepared.invoiceId,
          totals: prepared.totals,
          contractTotals: prepared.contractTotals,
        });
        return;
      }
      router.push(`/facture/${prepared.invoiceId}`);
    } catch (error) {
      // Refus actionnables du domaine (« déjà couverte par F-… ») restitués tels quels.
      Alert.alert(t('contrat.prepareCta', { personality }), appErrorMessage(error));
    }
  };

  const handleActivate = async (): Promise<void> => {
    const okGo = await confirm({
      title: t('contrat.activateCta', { personality }),
      message: t('contrat.activateHint', { personality }),
      challenge: { kind: 'tap' },
    });
    if (!okGo) return;
    try {
      await activate.mutateAsync({ contractId: contract.id, expectedRevision: contract.revision });
    } catch (error) {
      Alert.alert('Oups', appErrorMessage(error));
    }
  };

  const handleDeleteDraft = async (): Promise<void> => {
    const okGo = await confirm({
      title: t('contrat.deleteDraftCta', { personality }),
      message: contract.label,
      challenge: { kind: 'tap' },
      destructive: true,
    });
    if (!okGo) return;
    try {
      await deleteDraft.mutateAsync({ contractId: contract.id, expectedRevision: contract.revision });
      router.back();
    } catch (error) {
      Alert.alert('Oups', appErrorMessage(error));
    }
  };

  const submitTerminate = async (): Promise<void> => {
    const note = terminateNote.trim();
    if (note === '') {
      setTerminateError(t('contrat.terminateNoteField', { personality }));
      return;
    }
    const date = terminateDate.trim();
    if (date !== '' && !DATE_ONLY.test(date)) {
      setTerminateError(t('contrat.dateInvalid', { personality }));
      return;
    }
    setTerminateError(null);
    try {
      await terminate.mutateAsync({
        contractId: contract.id,
        expectedRevision: contract.revision,
        note,
        ...(date !== '' ? { effectiveDate: date } : {}),
      });
      setTerminateOpen(false);
      setTerminateDate('');
      setTerminateNote('');
    } catch (error) {
      setTerminateError(appErrorMessage(error));
    }
  };

  const sectionTitle = (label: string) => (
    <Text style={[font('sub', 700), { color: colors.slate500, letterSpacing: 0.6, marginTop: 16 }]}>
      {label}
    </Text>
  );

  return (
    <View style={{ flex: 1, backgroundColor: colors.bg }}>
      <ScrollView
        contentContainerStyle={{ paddingBottom: scrollInsets.paddingBottom }}
        scrollIndicatorInsets={{ bottom: scrollInsets.scrollIndicatorBottom }}
        refreshControl={<RefreshControl refreshing={query.isRefetching} onRefresh={() => void query.refetch()} />}
      >
        <ScreenHeader
          backLabel={view.customerName ?? t('contrat.clientLabel', { personality })}
          onBack={() => router.back()}
          eyebrow={t('contrat.eyebrow', { personality })}
          title={contract.label}
        />
        <View style={{ paddingHorizontal: 16, gap: 12 }}>
          {/* Héros — BobSurface marine (matière Bob, jamais la transparence iOS). */}
          <BobSurface tone="marine" emphasis="raised">
            <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 6, alignItems: 'center' }}>
              <StatusBadge variant={badge.variant} label={badge.label} />
              <StatusBadge
                variant="b2b"
                label={t(contract.tacitRenewal ? 'contrat.tacitOn' : 'contrat.tacitOff', { personality })}
              />
            </View>
            <View style={{ gap: 4, marginTop: 10 }}>
              <Pressable
                accessibilityRole="button"
                accessibilityLabel={`${t('contrat.clientLabel', { personality })} : ${view.customerName ?? ''}`}
                onPress={() => router.push(`/client/${contract.customerId}`)}
              >
                <Text style={[font('body', 600), { color: colors.ink800 }]}>
                  {t('contrat.clientLabel', { personality })}  {view.customerName ?? contract.customerId} ›
                </Text>
              </Pressable>
              {contract.chantierId !== null ? (
                <Pressable
                  accessibilityRole="button"
                  accessibilityLabel={`${t('contrat.siteLabel', { personality })} : ${view.chantierNom ?? ''}`}
                  onPress={() => router.push(`/chantier/${contract.chantierId}`)}
                >
                  <Text style={[font('body', 600), { color: colors.ink800 }]}>
                    {t('contrat.siteLabel', { personality })}  {view.chantierNom ?? contract.chantierId} ›
                  </Text>
                </Pressable>
              ) : null}
            </View>
            <Text style={[font('cardTitle'), { color: colors.ink800, marginTop: 10 }]}>
              {t('contrat.totalPerYear', { personality, params: { amount: formatEURWhole(view.annualTotals.ht) } })}
              {'  ·  '}
              {t('contrat.visitsPerYear', { personality, params: { count: String(contract.visitsPerYear) } })}
            </Text>
          </BobSurface>

          {/* Bloc « TVA recalculée » (amélioration 2) — visible tant que l'écart n'est pas lu. */}
          {vatNotice !== null ? (
            <BobSurface tone="warning" emphasis="raised">
              <Text style={[font('cardTitle'), { color: colors.ink800 }]}>
                {t('contrat.vatDivergence', {
                  personality,
                  params: {
                    actual: formatEURWhole(vatNotice.totals.ttc),
                    expected: formatEURWhole(vatNotice.contractTotals.ttc),
                  },
                })}
              </Text>
              <LegalHint
                label={t('legal.contractVat.inline', { personality })}
                lawKey="legal.contractVat.law"
                whyKey="legal.contractVat.why"
                source="art. 293 B et 283-3 CGI"
              />
              <View style={{ alignSelf: 'flex-start', marginTop: 8 }}>
                <Button
                  title={t('contrat.seeDraftCta', { personality })}
                  onPress={() => {
                    const invoiceId = vatNotice.invoiceId;
                    setVatNotice(null);
                    router.push(`/facture/${invoiceId}`);
                  }}
                />
              </View>
            </BobSurface>
          ) : null}

          {/* ÉCHÉANCES — période CALCULÉE, couverture DÉRIVÉE (bornes INCLUSES lisibles). */}
          <BobSurface tone="neutral" emphasis="raised">
            <Text style={[font('sub', 700), { color: colors.slate500, letterSpacing: 0.6 }]}>
              {t('contrat.sectionEcheances', { personality })}
            </Text>
            {period !== null ? (
              <Text style={[font('body', 600), { color: colors.ink800, marginTop: 8 }]}>
                {t('contrat.currentPeriod', {
                  personality,
                  params: { start: frContractDate(period.start), end: frContractDate(period.end) },
                })}
              </Text>
            ) : null}
            {coveredBy !== null ? (
              <Text style={[font('sub', 600), { color: semantic.success, marginTop: 4 }]}>
                {coveredBy.by === 'invoice'
                  ? t('contrat.coveredByInvoice', { personality, params: { number: coveredBy.number ?? '—' } })
                  : t('contrat.coveredByImport', { personality })}
              </Text>
            ) : null}
            {billingDue !== null && billingDue.cancelledCoveringNumber !== null ? (
              <Text style={[font('sub', 600), { color: colors.slate500, marginTop: 4 }]}>
                {t('contrat.rebillHint', {
                  personality,
                  params: { number: billingDue.cancelledCoveringNumber },
                })}
              </Text>
            ) : null}
            {billingDue !== null ? (
              <View style={{ alignSelf: 'flex-start', marginTop: 10 }}>
                <Button
                  title={t('contrat.prepareCta', { personality })}
                  loading={prepare.isPending}
                  onPress={() => void handlePrepare()}
                />
              </View>
            ) : null}
            {billingDue !== null ? (
              <Text style={[font('sub', 500), { color: colors.slate500, marginTop: 6 }]}>
                {t('contrat.prepareNote', { personality })}
              </Text>
            ) : null}
            {contract.status === 'active' && renewal !== null ? (
              <Text style={[font('sub', 600), { color: colors.slate500, marginTop: 8 }]}>
                {t(renewal.tacit ? 'contrat.renewalTacit' : 'contrat.renewalNonTacit', {
                  personality,
                  params: { days: String(renewal.daysUntil) },
                })}
              </Text>
            ) : null}
            {contract.status === 'active' && renewal !== null ? (
              <Text style={[font('sub', 500), { color: colors.slate500, marginTop: 2 }]}>
                {t('contrat.nextAnniversary', {
                  personality,
                  params: { date: frContractDate(renewal.anniversary) },
                })}
              </Text>
            ) : null}
            {lifecycle.terminatedCoverage !== null ? (
              <Text style={[font('sub', 600), { color: colors.slate500, marginTop: 8 }]}>
                {t('contrat.terminatedCoverage', {
                  personality,
                  params: { date: frContractDate(lifecycle.terminatedCoverage.until) },
                })}
              </Text>
            ) : null}
            <View style={{ marginTop: 8 }}>
              <LegalHint
                label={t('legal.contractNotice.inline', {
                  personality,
                  params: { days: String(contract.noticeDays) },
                })}
                lawKey="legal.contractNotice.law"
                whyKey="legal.contractNotice.why"
                source="clause de préavis du contrat"
              />
            </View>
          </BobSurface>

          {/* ÉQUIPEMENTS COUVERTS — le retrait est AFFICHÉ (amélioration 4). */}
          {contract.equipmentIds.length > 0 ? (
            <Pressable
              accessibilityRole="button"
              accessibilityLabel={t('contrat.sectionEquipments', { personality })}
              disabled={contract.chantierId === null}
              onPress={() => {
                if (contract.chantierId !== null) router.push(`/equipements/${contract.chantierId}`);
              }}
            >
              <BobSurface tone="neutral" emphasis="raised">
                <Text style={[font('sub', 700), { color: colors.slate500, letterSpacing: 0.6 }]}>
                  {t('contrat.sectionEquipments', { personality })}
                </Text>
                <Text style={[font('body', 600), { color: colors.ink800, marginTop: 6 }]}>
                  {retiredCovered > 0
                    ? t('contrat.equipmentsCountRetired', {
                        personality,
                        params: {
                          count: String(contract.equipmentIds.length),
                          retired: String(retiredCovered),
                        },
                      })
                    : t('contrat.equipmentsCount', {
                        personality,
                        params: { count: String(contract.equipmentIds.length) },
                      })}
                  {contract.chantierId !== null ? ' ›' : ''}
                </Text>
              </BobSurface>
            </Pressable>
          ) : null}

          {/* LIGNES — Σ vivante, jamais persistée (catégorie 'subscription' à la facture). */}
          {sectionTitle(t('contrat.sectionLines', { personality }))}
          <BobSurface tone="neutral" emphasis="raised" padding={12}>
            {contract.lines.map((line, index) => (
              <View
                key={line.id}
                style={{
                  flexDirection: 'row',
                  justifyContent: 'space-between',
                  paddingVertical: 8,
                  borderTopWidth: index > 0 ? 1 : 0,
                  borderTopColor: colors.lineSoft,
                  gap: 12,
                }}
              >
                <Text style={[font('body'), { color: colors.ink800, flexShrink: 1 }]}>{line.label}</Text>
                <Text style={[font('body', 600), { color: colors.ink800 }]}>
                  {`${line.quantity} × ${formatEURWhole(line.unitPriceHtCents)}`}
                </Text>
              </View>
            ))}
            <View
              style={{
                flexDirection: 'row',
                justifyContent: 'space-between',
                paddingTop: 10,
                borderTopWidth: contract.lines.length > 0 ? 1 : 0,
                borderTopColor: colors.lineSoft,
              }}
            >
              <Text style={[font('body', 700), { color: colors.ink800 }]}>
                {t('contrat.totalHtYear', { personality })}
              </Text>
              <Text style={[font('body', 700), { color: colors.ink800 }]}>
                {formatEURWhole(view.annualTotals.ht)}
              </Text>
            </View>
          </BobSurface>

          {/* HISTORIQUE honnête [P10] — faits stockés + reconductions « (calculé) ». */}
          {history.length > 0 ? (
            <>
              {sectionTitle(t('contrat.sectionHistory', { personality }))}
              <BobSurface tone="neutral" emphasis="raised" padding={12}>
                {history.map((entry, index) => (
                  <View
                    key={`${entry.kind}-${entry.at}-${index}`}
                    style={{
                      paddingVertical: 8,
                      borderTopWidth: index > 0 ? 1 : 0,
                      borderTopColor: colors.lineSoft,
                    }}
                  >
                    <Text style={[font('body'), { color: colors.ink800 }]}>
                      {`${frContractDate(entry.at)} — ${
                        entry.kind === 'activated'
                          ? t('contrat.historyActivated', { personality })
                          : entry.kind === 'renewed'
                            ? t('contrat.historyRenewed', { personality })
                            : t('contrat.historyTerminated', {
                                personality,
                                params: { note: entry.note ?? '—' },
                              })
                      }`}
                    </Text>
                  </View>
                ))}
              </BobSurface>
            </>
          ) : null}

          {/* Gestes d'état — dérivés §3.1 (CTA absents quand la transition est interdite). */}
          {contract.status === 'draft' ? (
            <View style={{ gap: 8 }}>
              <Button
                title={t('contrat.activateCta', { personality })}
                loading={activate.isPending}
                onPress={() => void handleActivate()}
              />
              <Button
                title={t('contrat.deleteDraftCta', { personality })}
                variant="secondary"
                loading={deleteDraft.isPending}
                onPress={() => void handleDeleteDraft()}
              />
            </View>
          ) : null}
          {contract.status === 'active' ? (
            <Button
              title={t('contrat.terminateCta', { personality })}
              variant="secondary"
              onPress={() => {
                setTerminateError(null);
                setTerminateOpen(true);
              }}
            />
          ) : null}
        </View>
      </ScrollView>

      {/* Résilier… — date d'effet DÉFAUT = prochain anniversaire CALCULÉ, motif obligatoire ;
          préavis expliqué (LegalHint), JAMAIS bloquant. */}
      <Sheet
        visible={terminateOpen}
        onClose={() => {
          if (!terminate.isPending) setTerminateOpen(false);
        }}
        accessibilityLabel={t('contrat.terminateTitle', { personality })}
      >
        <Text style={[font('section'), { color: colors.ink800, marginBottom: 10 }]}>
          {t('contrat.terminateTitle', { personality })}
        </Text>
        <View style={{ gap: 8 }}>
          {renewal !== null ? (
            <Text style={[font('sub', 500), { color: colors.slate500 }]}>
              {t('contrat.terminateDateHint', {
                personality,
                params: { date: frContractDate(renewal.anniversary) },
              })}
            </Text>
          ) : null}
          <TextInput
            value={terminateDate}
            onChangeText={(value) => {
              setTerminateError(null);
              setTerminateDate(value);
            }}
            placeholder={t('contrat.terminateDateField', { personality })}
            placeholderTextColor={colors.slate400}
            accessibilityLabel={t('contrat.terminateDateField', { personality })}
            autoCapitalize="none"
            style={[
              font('body'),
              {
                minHeight: 44,
                borderWidth: 1,
                borderColor: controls.cardBorder,
                borderRadius: 12,
                paddingHorizontal: 12,
                color: colors.ink800,
                backgroundColor: colors.surface,
              },
            ]}
          />
          <TextInput
            value={terminateNote}
            onChangeText={(value) => {
              setTerminateError(null);
              setTerminateNote(value);
            }}
            placeholder={t('contrat.terminateNoteField', { personality })}
            placeholderTextColor={colors.slate400}
            accessibilityLabel={t('contrat.terminateNoteField', { personality })}
            multiline
            style={[
              font('body'),
              {
                minHeight: 66,
                borderWidth: 1,
                borderColor: controls.cardBorder,
                borderRadius: 12,
                paddingHorizontal: 12,
                paddingTop: 10,
                color: colors.ink800,
                backgroundColor: colors.surface,
              },
            ]}
          />
          <LegalHint
            label={t('legal.contractNotice.inline', {
              personality,
              params: { days: String(contract.noticeDays) },
            })}
            lawKey="legal.contractNotice.law"
            whyKey="legal.contractNotice.why"
            source="clause de préavis du contrat"
          />
          {terminateError ? (
            <Text accessibilityLiveRegion="polite" style={[font('sub', 500), { color: colors.slate500 }]}>
              {terminateError}
            </Text>
          ) : null}
          <Button
            title={t('contrat.terminateConfirm', { personality })}
            loading={terminate.isPending}
            onPress={() => void submitTerminate()}
          />
        </View>
      </Sheet>
    </View>
  );
}
