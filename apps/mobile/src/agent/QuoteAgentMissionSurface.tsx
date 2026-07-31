import {
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import {
  AccessibilityInfo,
  ActivityIndicator,
  Pressable,
  Text,
  TextInput,
  View,
} from 'react-native';
import {
  CATALOGUE_CATEGORIES,
  MAX_BILLING_LINES,
  formatEUR,
  normalizeAgentMissionQuoteLineCandidate,
  normalizeAgentMissionQuoteLinePatch,
  type AgentMissionQuoteLineCandidateV1,
  type AgentMissionQuoteLinePatchV1,
  type AgentMissionQuoteLineRequiredFact,
  type CatalogueCategory,
  type LineCategory,
} from '@bob/core';
import { t, type I18nKey, type Personality } from '@bob/i18n';
import { space } from '@bob/tokens';
import {
  Button,
  Card,
  Chip,
  MoneyText,
  font,
  useTheme,
} from '@bob/ui';
import type {
  AgentMissionRuntimeActions,
  AgentMissionRuntimeCall,
} from './agent-mission-runtime';
import type {
  QuoteScreenMissionBindingState,
} from './quote-screen-mission-coordinator';
import {
  QuoteLineMissionCoordinator,
  type QuoteLineMissionFrame,
} from './quote-line-mission-coordinator';

type ReadyV2 = Extract<
  QuoteScreenMissionBindingState,
  { readonly phase: 'ready'; readonly protocolVersion: 2 }
>;

type QuoteLineActions = Pick<
  AgentMissionRuntimeActions,
  | 'stageQuoteLines'
  | 'decideQuoteCatalogueChoice'
  | 'patchQuoteLine'
  | 'cancelPendingQuoteLine'
  | 'decideQuoteLineProposal'
>;

const CATEGORY_KEYS: Readonly<Record<CatalogueCategory, I18nKey>> = {
  labor: 'voix.catLabor',
  supply: 'voix.catSupply',
  travel: 'voix.catTravel',
  subscription: 'voix.catSubscription',
};

const LINE_CATEGORY_KEYS: Readonly<Record<LineCategory, I18nKey>> = {
  labor: 'piece.catLabor',
  supply: 'piece.catSupply',
  travel: 'piece.catTravel',
  disbursement: 'piece.catDisbursement',
  subscription: 'piece.catSubscription',
};

const FACT_KEYS: Readonly<Record<AgentMissionQuoteLineRequiredFact, I18nKey>> = {
  service_reference: 'devis.mission.line.fact.service',
  category: 'devis.mission.line.fact.category',
  quantity: 'devis.mission.line.fact.quantity',
  unit: 'devis.mission.line.fact.unit',
  unit_price: 'devis.mission.line.fact.price',
  vat_rate: 'devis.mission.line.fact.vat',
  housing_older_than_2y: 'devis.mission.line.fact.housingAge',
  energy_renovation: 'devis.mission.line.fact.energy',
};

const EDITABLE_FACTS = Object.freeze([
  'service_reference',
  'category',
  'quantity',
  'unit',
  'unit_price',
  'vat_rate',
  'housing_older_than_2y',
  'energy_renovation',
] as const satisfies readonly AgentMissionQuoteLineRequiredFact[]);

function decimal(value: string): string {
  return value.trim().replace(',', '.');
}

function patchFor(
  field: AgentMissionQuoteLineRequiredFact,
  value: string,
): AgentMissionQuoteLinePatchV1 | null {
  const normalized = value.trim();
  if (field === 'service_reference') {
    return normalized === '' ? null : { field, value: normalized };
  }
  if (field === 'category') {
    return CATALOGUE_CATEGORIES.includes(normalized as CatalogueCategory)
      ? { field, value: normalized as CatalogueCategory }
      : null;
  }
  if (field === 'quantity') {
    return normalized === '' ? null : { field, decimal: decimal(normalized) };
  }
  if (field === 'unit') {
    return normalized === '' ? null : { field, value: normalized };
  }
  if (field === 'unit_price') {
    return normalized === ''
      ? null
      : {
          field,
          decimal: decimal(normalized),
          currency: 'EUR',
          basis: 'per_unit',
        };
  }
  if (field === 'vat_rate') {
    return (['0', '2.1', '5.5', '10', '20'] as const)
      .includes(normalized as '0')
      ? {
          field,
          value: normalized as '0' | '2.1' | '5.5' | '10' | '20',
        }
      : null;
  }
  if (normalized === 'true' || normalized === 'false') {
    return { field, value: normalized === 'true' };
  }
  return null;
}

function manualCandidate(input: {
  readonly service: string;
  readonly quantity: string;
  readonly unit: string;
  readonly price: string;
}): AgentMissionQuoteLineCandidateV1 {
  const normalizedPrice = decimal(input.price);
  return {
    serviceReference: input.service.trim() || null,
    categoryHint: null,
    quantityDecimal: decimal(input.quantity) || null,
    unitReference: input.unit.trim() || null,
    unitPriceDecimal: normalizedPrice || null,
    currency: normalizedPrice === '' ? null : 'EUR',
    priceBasis: normalizedPrice === '' ? null : 'per_unit',
    vatRateHint: null,
  };
}

function inputKeyboard(
  field: AgentMissionQuoteLineRequiredFact,
): 'default' | 'decimal-pad' {
  return field === 'quantity' || field === 'unit_price'
    ? 'decimal-pad'
    : 'default';
}

function quoteDiffSummary(
  snapshot: {
    readonly lineCount: number;
    readonly totalHtCents: number;
  },
  personality: Personality,
): string {
  return t(
    snapshot.lineCount === 1
      ? 'devis.mission.line.diffSummaryOne'
      : 'devis.mission.line.diffSummaryMany',
    {
      personality,
      params: {
        count: snapshot.lineCount,
        total: formatEUR(snapshot.totalHtCents),
      },
    },
  );
}

export interface QuoteAgentMissionSurfaceProps {
  readonly state: ReadyV2;
  readonly expectedScreenInstanceId: string;
  readonly actions: QuoteLineActions;
  readonly coordinator: QuoteLineMissionCoordinator;
  readonly personality: Personality;
  readonly confirmedLines: readonly {
    readonly label: string;
    readonly category: LineCategory;
    readonly qty: number;
    readonly unit?: string;
    readonly unitPriceHT: number;
    readonly vatRate: number;
  }[];
  readonly onAuthoritativeRefresh: () => void;
  readonly onAbandonMission: () => Promise<'abandoned' | 'dismissed' | 'failed'>;
}

/**
 * Surface jumelle de Bob Live : chaque choix tactile appelle le même contrat de mission V2 que la
 * voix. Aucun état local n'est présenté comme une donnée du devis avant le commit serveur.
 */
export function QuoteAgentMissionSurface({
  state,
  expectedScreenInstanceId,
  actions,
  coordinator,
  personality,
  confirmedLines,
  onAuthoritativeRefresh,
  onAbandonMission,
}: QuoteAgentMissionSurfaceProps) {
  const { colors, semantic, controls, radius } = useTheme();
  const [busy, setBusy] = useState(false);
  const [failureKind, setFailureKind] =
    useState<'action' | 'abandon' | null>(null);
  const [abandoning, setAbandoning] = useState(false);
  const [service, setService] = useState('');
  const [quantity, setQuantity] = useState('1');
  const [unit, setUnit] = useState('');
  const [price, setPrice] = useState('');
  const [editField, setEditField] =
    useState<AgentMissionQuoteLineRequiredFact>('unit_price');
  const [factValue, setFactValue] = useState('');
  const interactionInFlight = useRef(false);
  const retryTask = useRef<(() => Promise<AgentMissionRuntimeCall<unknown>>) | null>(
    null,
  );
  const announcedAuthority = useRef<string | null>(null);
  const personalityRef = useRef(personality);
  personalityRef.current = personality;
  const frame = useMemo<QuoteLineMissionFrame>(() => ({
    mission: state.mission,
    presentation: state.presentation,
    expectedScreenInstanceId,
  }), [expectedScreenInstanceId, state.mission, state.presentation]);
  const authorityKey = [
    state.mission.id,
    state.mission.revision,
    state.presentation.pendingLine?.pendingLineId ?? '',
    state.presentation.decision?.decisionId ?? '',
    state.presentation.proposal?.proposalId ?? '',
  ].join(':');

  useEffect(() => {
    setFactValue('');
    setFailureKind(null);
    retryTask.current = null;
    if (announcedAuthority.current !== null) {
      void AccessibilityInfo.announceForAccessibility(
        t('devis.mission.line.stateUpdated', {
          personality: personalityRef.current,
        }),
      );
    }
    announcedAuthority.current = authorityKey;
  }, [authorityKey]);

  const run = async (
    task: () => Promise<AgentMissionRuntimeCall<unknown>>,
    onSuccess?: () => void,
  ): Promise<void> => {
    if (interactionInFlight.current) return;
    interactionInFlight.current = true;
    setBusy(true);
    setFailureKind(null);
    try {
      const result = await task();
      if (result.status === 'completed') {
        retryTask.current = null;
        onSuccess?.();
        setFactValue('');
        onAuthoritativeRefresh();
        return;
      }
      if (
        result.status === 'stale'
        || result.status === 'context_unconfirmed'
        || (
          result.status === 'failed'
          && result.error.kind === 'conflict'
        )
      ) {
        retryTask.current = null;
        onAuthoritativeRefresh();
        return;
      }
      retryTask.current = task;
      setFailureKind('action');
    } catch {
      retryTask.current = task;
      setFailureKind('action');
    } finally {
      interactionInFlight.current = false;
      setBusy(false);
    }
  };

  const answerField = state.presentation.requiredFact ?? editField;
  const answerPatch = patchFor(answerField, factValue);
  const answerPatchValid =
    answerPatch !== null && normalizeAgentMissionQuoteLinePatch(answerPatch).ok;
  const showFactEditor =
    state.presentation.requiredFact !== null
    || (
      state.mission.phase === 'awaiting_line_details'
      && state.presentation.pendingLine !== null
    );
  const catalogueDecision = state.presentation.decision?.kind === 'catalogue'
    ? state.presentation.decision
    : null;
  const proposalDecision =
    state.presentation.decision?.kind === 'line_confirmation'
      ? state.presentation.decision
      : null;
  const proposal = state.presentation.proposal;
  const stagedCandidate = manualCandidate({ service, quantity, unit, price });
  const stagedCandidateValid =
    normalizeAgentMissionQuoteLineCandidate(stagedCandidate).ok;
  const draftLineLimitReached =
    confirmedLines.length >= MAX_BILLING_LINES;
  const interactionLocked = busy || abandoning;
  const requestAbandon = (): void => {
    if (interactionInFlight.current) return;
    interactionInFlight.current = true;
    setAbandoning(true);
    void onAbandonMission().then(
      (outcome) => {
        if (outcome === 'failed') {
          retryTask.current = null;
          setFailureKind('abandon');
        }
      },
      () => {
        retryTask.current = null;
        setFailureKind('abandon');
      },
    ).finally(() => {
      interactionInFlight.current = false;
      setAbandoning(false);
    });
  };

  return (
    <View
      accessibilityLiveRegion="polite"
      style={{ gap: space[5] }}
    >
      <Card
        radius={radius.cardLg}
        padding={space[7]}
        style={{ borderWidth: 1, borderColor: semantic.ai }}
      >
        <View style={{ flexDirection: 'row', alignItems: 'center', gap: space[4] }}>
          <View
            style={{
              width: 10,
              height: 10,
              borderRadius: 5,
              backgroundColor: semantic.ai,
            }}
          />
          <View style={{ flex: 1 }}>
            <Text
              accessibilityRole="header"
              style={[font('cardTitle'), { color: colors.ink900 }]}
            >
              {t('devis.mission.line.title', { personality })}
            </Text>
            <Text style={[font('sub'), { color: colors.slate500, marginTop: 2 }]}>
              {t('devis.mission.line.liveHint', { personality })}
            </Text>
          </View>
          {busy ? (
            <ActivityIndicator
              accessibilityLabel={t('devis.mission.line.busy', { personality })}
              accessibilityRole="progressbar"
              color={semantic.ai}
            />
          ) : null}
        </View>
        <Pressable
          accessibilityRole="button"
          accessibilityLabel={t('devis.mission.line.abandonAction', { personality })}
          accessibilityHint={t('devis.mission.line.abandonHint', { personality })}
          accessibilityState={{ disabled: interactionLocked }}
          disabled={interactionLocked}
          onPress={requestAbandon}
          style={({ pressed }) => ({
            minHeight: 44,
            alignSelf: 'flex-start',
            justifyContent: 'center',
            marginTop: space[4],
            opacity: pressed ? 0.72 : 1,
          })}
        >
          <Text style={[font('label', 700), { color: semantic.danger }]}>
            {t(
              abandoning
                ? 'devis.mission.line.abandoning'
                : 'devis.mission.line.abandonAction',
              { personality },
            )}
          </Text>
        </Pressable>
      </Card>

      <Card radius={radius.cardLg} padding={space[7]}>
        <Text
          accessibilityRole="header"
          style={[font('cardTitle'), { color: colors.ink900 }]}
        >
          {t('devis.mission.line.confirmedTitle', { personality })}
        </Text>
        {confirmedLines.length === 0 ? (
          <Text style={[font('sub'), { color: colors.slate500, marginTop: 6 }]}>
            {t('devis.mission.line.confirmedEmpty', { personality })}
          </Text>
        ) : (
          <View style={{ marginTop: 6 }}>
            {confirmedLines.map((line, index) => (
              <View
                key={`${line.label}:${index}`}
                style={{
                  minHeight: 48,
                  flexDirection: 'row',
                  alignItems: 'center',
                  gap: 10,
                  borderBottomWidth: index === confirmedLines.length - 1 ? 0 : 1,
                  borderBottomColor: colors.lineSoft,
                  paddingVertical: 8,
                }}
              >
                <View style={{ flex: 1 }}>
                  <Text style={[font('label', 700), { color: colors.ink900 }]}>
                    {line.label}
                  </Text>
                  <Text style={[font('meta'), { color: colors.slate500, marginTop: 2 }]}>
                    {t(LINE_CATEGORY_KEYS[line.category], { personality })}
                    {' · '}
                    {line.qty}
                    {line.unit === undefined ? '' : ` ${line.unit}`}
                    {' × '}
                    {formatEUR(line.unitPriceHT)}
                    {' · '}
                    {t('devis.mission.line.vatValue', {
                      personality,
                      params: { rate: line.vatRate },
                    })}
                  </Text>
                </View>
                <MoneyText cents={Math.round(line.qty * line.unitPriceHT)} />
              </View>
            ))}
          </View>
        )}
      </Card>

      {catalogueDecision !== null ? (
        <Card radius={radius.cardLg} padding={space[7]}>
          <Text
            accessibilityRole="header"
            style={[font('cardTitle'), { color: colors.ink900 }]}
          >
            {t('devis.mission.line.catalogueTitle', { personality })}
          </Text>
          <Text style={[font('sub'), { color: colors.slate500, marginTop: 4 }]}>
            {t('devis.mission.line.catalogueBody', { personality })}
          </Text>
          <View style={{ gap: space[3], marginTop: space[5] }}>
            {state.presentation.catalogueChoices.map((choice, index) => {
              const unavailable = t('devis.mission.line.notSpecified', { personality });
              const category = choice.category === null
                ? unavailable
                : t(CATEGORY_KEYS[choice.category], { personality });
              const price = choice.unitPriceCents === null
                ? unavailable
                : formatEUR(choice.unitPriceCents);
              const unitLabel = choice.unit === null ? unavailable : choice.unit;
              const vat = choice.vatRate === null
                ? unavailable
                : t('devis.mission.line.vatValue', {
                    personality,
                    params: { rate: choice.vatRate },
                  });
              const details = t('devis.mission.line.catalogueChoiceDetails', {
                personality,
                params: { category, price, unit: unitLabel, vat },
              });
              return (
                <Pressable
                  key={choice.choiceId}
                  accessibilityRole="button"
                  accessibilityLabel={
                    choice.available && choice.label !== null
                      ? t('devis.mission.line.catalogueChoiceA11y', {
                          personality,
                          params: {
                            ordinal: index + 1,
                            label: choice.label,
                            details,
                          },
                        })
                      : t('devis.mission.line.catalogueUnavailable', { personality })
                  }
                  accessibilityState={{
                    disabled: interactionLocked || !choice.available,
                  }}
                  disabled={interactionLocked || !choice.available}
                  onPress={() => {
                    void run(() => coordinator.chooseCatalogue(
                      frame,
                      choice.choiceId,
                      actions,
                    ));
                  }}
                  style={({ pressed }) => ({
                    minHeight: 56,
                    borderWidth: 1,
                    borderColor: controls.cardBorder,
                    borderRadius: radius.squircle,
                    paddingHorizontal: space[6],
                    paddingVertical: space[4],
                    opacity: !choice.available ? 0.48 : pressed ? 0.72 : 1,
                    flexDirection: 'row',
                    alignItems: 'center',
                    gap: space[4],
                  })}
                >
                  <View
                    accessible={false}
                    style={{
                      width: 28,
                      height: 28,
                      borderRadius: 14,
                      alignItems: 'center',
                      justifyContent: 'center',
                      backgroundColor: semantic.aiBg,
                    }}
                  >
                    <Text style={[font('meta', 700), { color: semantic.aiInk }]}>
                      {index + 1}
                    </Text>
                  </View>
                  <View style={{ flex: 1 }}>
                    <Text style={[font('label', 700), { color: colors.ink900 }]}>
                      {choice.label
                        ?? t('devis.mission.line.catalogueUnavailable', { personality })}
                    </Text>
                    {choice.available ? (
                      <Text
                        style={[font('meta'), { color: colors.slate500, marginTop: 2 }]}
                      >
                        {details}
                      </Text>
                    ) : null}
                  </View>
                </Pressable>
              );
            })}
            {state.presentation.freeLineChoiceId !== null ? (
              <Button
                title={t('devis.mission.line.catalogueFree', { personality })}
                variant="secondary"
                disabled={interactionLocked}
                onPress={() => {
                  const choiceId = state.presentation.freeLineChoiceId;
                  if (choiceId === null) return;
                  void run(() => coordinator.chooseCatalogue(
                    frame,
                    choiceId,
                    actions,
                  ));
                }}
              />
            ) : null}
          </View>
        </Card>
      ) : null}

      {proposalDecision !== null
        && proposal !== null
        && state.presentation.proposalStatus.kind === 'available' ? (
        <Card radius={radius.cardLg} padding={space[7]}>
          <Text
            accessibilityRole="header"
            style={[font('cardTitle'), { color: colors.ink900 }]}
          >
            {t('devis.mission.line.proposalTitle', { personality })}
          </Text>
          <Text style={[font('label', 700), { color: colors.ink900, marginTop: 10 }]}>
            {proposal.line.label}
          </Text>
          <Text style={[font('sub'), { color: colors.slate500, marginTop: 3 }]}>
            {t(LINE_CATEGORY_KEYS[proposal.line.category], { personality })}
            {' · '}
            {proposal.line.qty}
            {proposal.line.unit === undefined ? '' : ` ${proposal.line.unit}`}
            {' × '}
            {formatEUR(proposal.line.unitPriceHT)}
            {' · '}
            {t('devis.mission.line.vatValue', {
              personality,
              params: { rate: proposal.line.vatRate },
            })}
          </Text>
          {proposal.catalogue !== null ? (
            <Text style={[font('meta'), { color: semantic.aiInk, marginTop: 6 }]}>
              {t('devis.mission.line.catalogueSource', {
                personality,
                params: { label: proposal.catalogue.label },
              })}
            </Text>
          ) : null}
          <View
            accessibilityRole="summary"
            accessibilityLabel={t('devis.mission.line.diffAccessibility', {
              personality,
              params: {
                before: quoteDiffSummary(proposal.diff.before, personality),
                after: quoteDiffSummary(proposal.diff.after, personality),
              },
            })}
            style={{
              marginTop: space[5],
              borderWidth: 1,
              borderColor: controls.cardBorder,
              borderRadius: radius.squircle,
              padding: space[5],
              gap: space[4],
            }}
          >
            <Text style={[font('label', 700), { color: colors.ink900 }]}>
              {t('devis.mission.line.diffTitle', { personality })}
            </Text>
            <View style={{ flexDirection: 'row', gap: space[4] }}>
              {([
                [
                  'devis.mission.line.diffBefore',
                  proposal.diff.before,
                  colors.slate500,
                ],
                [
                  'devis.mission.line.diffAfter',
                  proposal.diff.after,
                  semantic.aiInk,
                ],
              ] as const).map(([labelKey, snapshot, color]) => (
                <View key={labelKey} style={{ flex: 1, gap: space[2] }}>
                  <Text style={[font('meta', 700), { color }]}>
                    {t(labelKey, { personality })}
                  </Text>
                  <Text style={[font('sub'), { color: colors.ink900 }]}>
                    {quoteDiffSummary(snapshot, personality)}
                  </Text>
                </View>
              ))}
            </View>
          </View>
          <View style={{ gap: 8, marginTop: 14 }}>
            <Button
              title={t('devis.mission.line.confirm', { personality })}
              variant="aiSolid"
              disabled={interactionLocked}
              onPress={() => {
                void run(() => coordinator.decideProposal(
                  frame,
                  'confirm_line',
                  actions,
                ));
              }}
            />
            <Button
              title={t('devis.mission.line.modify', { personality })}
              variant="secondary"
              disabled={interactionLocked}
              onPress={() => {
                void run(() => coordinator.decideProposal(
                  frame,
                  'edit_line',
                  actions,
                ));
              }}
            />
            <Pressable
              accessibilityRole="button"
              accessibilityLabel={t('devis.mission.line.cancel', { personality })}
              accessibilityState={{ disabled: interactionLocked }}
              disabled={interactionLocked}
              onPress={() => {
                void run(() => coordinator.decideProposal(
                  frame,
                  'cancel_line',
                  actions,
                ));
              }}
              style={{
                minHeight: 44,
                alignItems: 'center',
                justifyContent: 'center',
              }}
            >
              <Text style={[font('label', 700), { color: colors.slate500 }]}>
                {t('devis.mission.line.cancel', { personality })}
              </Text>
            </Pressable>
          </View>
        </Card>
      ) : null}

      {proposalDecision !== null
        && state.presentation.proposalStatus.kind === 'stale' ? (
          <Card
            radius={radius.cardLg}
            padding={space[7]}
            style={{ borderWidth: 1, borderColor: semantic.warning }}
          >
            <Text
              accessibilityRole="header"
              style={[font('cardTitle'), { color: colors.ink900 }]}
            >
              {t('devis.mission.line.staleTitle', { personality })}
            </Text>
            <Text
              accessibilityRole="alert"
              accessibilityLiveRegion="polite"
              style={[font('sub'), { color: colors.slate500, marginTop: 5 }]}
            >
              {t(
                state.presentation.proposalStatus.reason === 'catalogue_changed'
                  ? 'devis.mission.line.staleCatalogue'
                  : 'devis.mission.line.staleVat',
                { personality },
              )}
            </Text>
            <View style={{ gap: 8, marginTop: 14 }}>
              <Button
                title={t('devis.mission.line.modify', { personality })}
                variant="aiSolid"
                disabled={interactionLocked}
                onPress={() => {
                  void run(() => coordinator.decideProposal(
                    frame,
                    'edit_line',
                    actions,
                  ));
                }}
              />
              <Button
                title={t('devis.mission.line.cancel', { personality })}
                variant="secondary"
                disabled={interactionLocked}
                onPress={() => {
                  void run(() => coordinator.decideProposal(
                    frame,
                    'cancel_line',
                    actions,
                  ));
                }}
              />
            </View>
          </Card>
        ) : null}

      {showFactEditor ? (
        <Card radius={radius.cardLg} padding={space[7]}>
          <Text
            accessibilityRole="header"
            style={[font('cardTitle'), { color: colors.ink900 }]}
          >
            {t(
              state.presentation.requiredFact === null
                ? 'devis.mission.line.modifyTitle'
                : 'devis.mission.line.factTitle',
              { personality },
            )}
          </Text>
          {state.presentation.requiredFact === null ? (
            <View
              accessible={false}
              accessibilityRole="radiogroup"
              style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 7, marginTop: 12 }}
            >
              {EDITABLE_FACTS.map((field) => (
                <Chip
                  key={field}
                  label={t(FACT_KEYS[field], { personality })}
                  active={editField === field}
                  accessibilityRole="radio"
                  disabled={interactionLocked}
                  onPress={() => {
                    if (interactionInFlight.current) return;
                    setEditField(field);
                    setFactValue('');
                  }}
                />
              ))}
            </View>
          ) : (
            <Text style={[font('sub'), { color: colors.slate500, marginTop: 5 }]}>
              {t(FACT_KEYS[state.presentation.requiredFact], { personality })}
            </Text>
          )}

          {answerField === 'category' ? (
            <View
              accessible={false}
              accessibilityRole="radiogroup"
              style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 8, marginTop: 12 }}
            >
              {CATALOGUE_CATEGORIES.map((category) => (
                <Chip
                  key={category}
                  label={t(CATEGORY_KEYS[category], { personality })}
                  active={factValue === category}
                  accessibilityRole="radio"
                  disabled={interactionLocked}
                  onPress={() => {
                    if (interactionInFlight.current) return;
                    setFactValue(category);
                  }}
                />
              ))}
            </View>
          ) : answerField === 'vat_rate' ? (
            <View
              accessible={false}
              accessibilityRole="radiogroup"
              style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 8, marginTop: 12 }}
            >
              {(['0', '2.1', '5.5', '10', '20'] as const).map((rate) => (
                <Chip
                  key={rate}
                  label={`${rate} %`}
                  active={factValue === rate}
                  accessibilityRole="radio"
                  disabled={interactionLocked}
                  onPress={() => {
                    if (interactionInFlight.current) return;
                    setFactValue(rate);
                  }}
                />
              ))}
            </View>
          ) : answerField === 'housing_older_than_2y'
            || answerField === 'energy_renovation' ? (
              <View
                accessible={false}
                accessibilityRole="radiogroup"
                style={{ flexDirection: 'row', gap: 8, marginTop: 12 }}
              >
                {(['true', 'false'] as const).map((value) => (
                  <View key={value} style={{ flex: 1 }}>
                    <Button
                      title={t(
                        value === 'true'
                          ? 'devis.mission.line.yes'
                          : 'devis.mission.line.no',
                        { personality },
                      )}
                      variant={factValue === value ? 'primary' : 'secondary'}
                      accessibilityRole="radio"
                      accessibilityState={{ checked: factValue === value }}
                      disabled={interactionLocked}
                      onPress={() => {
                        if (interactionInFlight.current) return;
                        setFactValue(value);
                      }}
                    />
                  </View>
                ))}
              </View>
            ) : (
              <TextInput
                value={factValue}
                onChangeText={(value) => {
                  if (interactionInFlight.current) return;
                  setFactValue(value);
                }}
                editable={!interactionLocked}
                keyboardType={inputKeyboard(answerField)}
                accessibilityLabel={t(FACT_KEYS[answerField], { personality })}
                accessibilityState={{ disabled: interactionLocked }}
                placeholder={t(FACT_KEYS[answerField], { personality })}
                placeholderTextColor={colors.slate400}
                style={[
                  font('body'),
                  {
                    minHeight: 48,
                    borderWidth: 1,
                    borderColor: controls.cardBorder,
                    borderRadius: 12,
                    color: colors.ink900,
                    paddingHorizontal: 12,
                    marginTop: 12,
                  },
                ]}
              />
            )}
          <View style={{ gap: 8, marginTop: 12 }}>
            <Button
              title={t('devis.mission.line.submit', { personality })}
              variant="aiSolid"
              disabled={interactionLocked || !answerPatchValid}
              onPress={() => {
                if (answerPatch === null || !answerPatchValid) return;
                void run(() => coordinator.patch(
                  frame,
                  state.presentation.requiredFact === null
                    ? 'explicit_correction'
                    : 'answer_required_fact',
                  answerPatch,
                  actions,
                ));
              }}
            />
            <Button
              title={t('devis.mission.line.cancel', { personality })}
              variant="secondary"
              disabled={interactionLocked}
              onPress={() => {
                void run(() => coordinator.cancelPending(frame, actions));
              }}
            />
          </View>
        </Card>
      ) : null}

      {state.mission.phase === 'awaiting_lines'
        && state.presentation.pendingLine === null
        && draftLineLimitReached ? (
          <Card
            radius={radius.cardLg}
            padding={space[7]}
            style={{ borderWidth: 1, borderColor: semantic.warning }}
          >
            <Text
              accessibilityRole="header"
              style={[font('cardTitle'), { color: colors.ink900 }]}
            >
              {t('devis.mission.line.limitTitle', { personality })}
            </Text>
            <Text
              accessibilityRole="alert"
              accessibilityLiveRegion="polite"
              style={[font('sub'), { color: colors.slate500, marginTop: space[2] }]}
            >
              {t('devis.mission.line.limitBody', {
                personality,
                params: { count: MAX_BILLING_LINES },
              })}
            </Text>
            <View style={{ marginTop: space[5] }}>
              <Button
                title={t('devis.mission.line.abandonAction', { personality })}
                variant="secondary"
                disabled={interactionLocked}
                onPress={requestAbandon}
              />
            </View>
          </Card>
        ) : null}

      {state.mission.phase === 'awaiting_lines'
        && state.presentation.pendingLine === null
        && !draftLineLimitReached ? (
          <Card radius={radius.cardLg} padding={space[7]}>
            <Text
              accessibilityRole="header"
              style={[font('cardTitle'), { color: colors.ink900 }]}
            >
              {t('devis.mission.line.manualTitle', { personality })}
            </Text>
            <Text
              style={[font('label', 700), { color: colors.ink800, marginTop: space[5] }]}
            >
              {t('devis.mission.line.service', { personality })}
            </Text>
            <TextInput
              value={service}
              onChangeText={(value) => {
                if (interactionInFlight.current) return;
                setService(value);
              }}
              editable={!interactionLocked}
              accessibilityLabel={t('devis.mission.line.service', { personality })}
              accessibilityState={{ disabled: interactionLocked }}
              placeholder={t('devis.mission.line.service', { personality })}
              placeholderTextColor={colors.slate400}
              style={[
                font('body'),
                {
                  minHeight: 48,
                  borderWidth: 1,
                  borderColor: controls.cardBorder,
                  borderRadius: 12,
                  color: colors.ink900,
                  paddingHorizontal: 12,
                  marginTop: space[2],
                },
              ]}
            />
            <View style={{ flexDirection: 'row', gap: space[3], marginTop: space[4] }}>
              {([
                [quantity, setQuantity, 'devis.mission.line.quantity', 'decimal-pad'],
                [unit, setUnit, 'devis.mission.line.unit', 'default'],
              ] as const).map(([value, setValue, key, keyboardType]) => (
                <View key={key} style={{ flex: 1 }}>
                  <Text style={[font('label', 700), { color: colors.ink800 }]}>
                    {t(key, { personality })}
                  </Text>
                  <TextInput
                    value={value}
                    onChangeText={(nextValue) => {
                      if (interactionInFlight.current) return;
                      setValue(nextValue);
                    }}
                    editable={!interactionLocked}
                    keyboardType={keyboardType}
                    accessibilityLabel={t(key, { personality })}
                    accessibilityState={{ disabled: interactionLocked }}
                    placeholder={t(key, { personality })}
                    placeholderTextColor={colors.slate400}
                    style={[
                      font('body'),
                      {
                        minHeight: 48,
                        borderWidth: 1,
                        borderColor: controls.cardBorder,
                        borderRadius: radius.squircle,
                        color: colors.ink900,
                        paddingHorizontal: space[5],
                        marginTop: space[2],
                      },
                    ]}
                  />
                </View>
              ))}
            </View>
            <View style={{ marginTop: space[4] }}>
              <Text style={[font('label', 700), { color: colors.ink800 }]}>
                {t('devis.mission.line.price', { personality })}
              </Text>
              <TextInput
                value={price}
                onChangeText={(value) => {
                  if (interactionInFlight.current) return;
                  setPrice(value);
                }}
                editable={!interactionLocked}
                keyboardType="decimal-pad"
                accessibilityLabel={t('devis.mission.line.price', { personality })}
                accessibilityState={{ disabled: interactionLocked }}
                placeholder={t('devis.mission.line.price', { personality })}
                placeholderTextColor={colors.slate400}
                style={[
                  font('body'),
                  {
                    minHeight: 48,
                    borderWidth: 1,
                    borderColor: controls.cardBorder,
                    borderRadius: radius.squircle,
                    color: colors.ink900,
                    paddingHorizontal: space[5],
                    marginTop: space[2],
                  },
                ]}
              />
            </View>
            <View style={{ marginTop: 12 }}>
              <Button
                title={t('devis.mission.line.add', { personality })}
                variant="aiSolid"
                disabled={interactionLocked || !stagedCandidateValid}
                onPress={() => {
                  if (!stagedCandidateValid) return;
                  void run(
                    () => coordinator.stage(frame, [stagedCandidate], actions),
                    () => {
                      setService('');
                      setQuantity('1');
                      setUnit('');
                      setPrice('');
                    },
                  );
                }}
              />
            </View>
          </Card>
        ) : null}

      {state.mission.phase === 'awaiting_lines'
        && state.presentation.pendingLine !== null ? (
          <Card
            radius={radius.cardLg}
            padding={space[7]}
            style={{ borderWidth: 1, borderColor: semantic.ai }}
          >
            <Text
              accessibilityRole="header"
              style={[font('cardTitle'), { color: colors.ink900 }]}
            >
              {t('devis.mission.line.finishingTitle', { personality })}
            </Text>
            <Text
              accessibilityLiveRegion="polite"
              style={[font('sub'), { color: colors.slate500, marginTop: space[2] }]}
            >
              {t('devis.mission.line.finishingBody', { personality })}
            </Text>
            <ActivityIndicator
              accessibilityRole="progressbar"
              accessibilityLabel={t('devis.mission.line.finishingTitle', { personality })}
              color={semantic.ai}
              style={{ marginTop: space[5] }}
            />
          </Card>
        ) : null}

      {failureKind !== null ? (
        <Card
          radius={radius.cardLg}
          padding={space[7]}
          style={{ borderWidth: 1, borderColor: semantic.danger }}
        >
          <Text
            accessibilityRole="alert"
            style={[font('sub'), { color: colors.ink900, lineHeight: 20 }]}
          >
            {t(
              failureKind === 'abandon'
                ? 'devis.mission.line.abandonError'
                : 'devis.mission.line.error',
              { personality },
            )}
          </Text>
          {failureKind === 'action' && retryTask.current !== null ? (
            <View style={{ marginTop: space[5] }}>
              <Button
                title={t('devis.mission.line.retry', { personality })}
                variant="secondary"
                disabled={interactionLocked}
                onPress={() => {
                  const task = retryTask.current;
                  if (task === null) return;
                  void run(task);
                }}
              />
            </View>
          ) : null}
        </Card>
      ) : null}
    </View>
  );
}
