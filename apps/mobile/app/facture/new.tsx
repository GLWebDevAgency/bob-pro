/**
 * B1 — FACTURE DIRECTE sans devis signé (dépannage urgent B2C qualifié A3bis, régie TJM × jours,
 * syndic/B2B) : wizard ALLÉGÉ client → prestations → récap, piloté par la machine PURE
 * facture-directe-model (testée node — l'écran ne détient aucune règle). La création passe par
 * composeStandaloneInvoice (POST /invoices → BROUILLON) puis l'émission par issueInvoice sur
 * /facture/[id] — aucun chemin parallèle d'émission.
 *
 * Doctrine :
 *  • client PARTICULIER → question d'urgence OBLIGATOIRE (LegalHint A3bis, formulation
 *    bénéfice) ; « non » = état bloquant honnête + CTA vers le devis (le contrat) ;
 *  • client PRO ÉTRANGER → blocage B7 explicatif (LegalHint), jamais un crash ni une TVA
 *    française fausse ;
 *  • remises B3 : par ligne (discrète, % ou €) et globale au récap — l'avant/après s'affiche
 *    (HT brut barré subtil, remise en vert success), mention L441-9 imprimée par le serveur ;
 *  • TVA : UN taux confirmé pour toute la pièce (revalidé serveur via suggestVatRate).
 * Zéro hex : tout vient de useTheme()/@bob/tokens. Réutilise les composants du wizard devis
 * (@bob/ui Stepper/Chip/Card/MoneyText/LegalHint/StatusBadge) — pas un nouveau système.
 */
import { useMemo, useRef, useState } from 'react';
import {
  KeyboardAvoidingView,
  Platform,
  ScrollView,
  Text,
  TextInput,
  View,
} from 'react-native';
import { useRouter } from 'expo-router';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { challengeFor } from '@bob/ai';
import {
  formatEUR,
  searchCatalogue,
  type CataloguePrestation,
  type Discount,
  type LineCategory,
  type LineInput,
  type VatRate,
} from '@bob/core';
import { shadowNative } from '@bob/tokens';
import { t, type I18nKey } from '@bob/i18n';
import {
  Avatar,
  Button,
  Card,
  Chip,
  EmptyState,
  ErrorRetry,
  FadeIn,
  LegalHint,
  MoneyText,
  PressableScale,
  SkeletonRow,
  StatusBadge,
  Stepper,
  font,
  useTheme,
  type StatusBadgeVariant,
} from '@bob/ui';
import {
  appErrorMessage,
  useCompanyMe,
  useComposeStandaloneInvoice,
  useCustomers,
} from '../../src/data/hooks';
import { useCatalogue } from '../../src/data/catalogue';
import { useConfirm } from '../../src/components/ConfirmSheet';
import { CheckIcon, ChevronLeftIcon, CloseIcon } from '../../src/components/icons';
import {
  FACTURE_DIRECTE_CATEGORIES,
  FACTURE_DIRECTE_STEPS,
  addLine,
  buildComposePayload,
  isInternationalProBlocked,
  nextStep,
  parseDiscountInput,
  previousStep,
  removeLine,
  selectCustomer,
  setGlobalDiscount,
  setUrgentOnSiteRepair,
  setVat,
  startFactureDirecte,
  totalsOf,
  type FactureDirecteGuardError,
  type FactureDirecteState,
} from '../../src/facture-directe/facture-directe-model';

/** La création d'un BROUILLON est réversible (deleteDraftInvoice) — jamais un acte fiscal. */
const REVERSIBLE = { mutating: true, outbound: false, riskTier: 'reversible' } as const;

const STEP_KEYS: readonly I18nKey[] = ['fd.stepClient', 'fd.stepLines', 'fd.stepRecap'];

const CUSTOMER_TONE: Record<'b2c' | 'b2b' | 'b2g', StatusBadgeVariant> = {
  b2c: 'particulier',
  b2b: 'b2b',
  b2g: 'b2g',
};
const CUSTOMER_BADGE: Record<'b2c' | 'b2b' | 'b2g', I18nKey> = {
  b2c: 'clients.badgeB2c',
  b2b: 'clients.badgeB2b',
  b2g: 'clients.badgeB2g',
};
const CAT_KEY: Record<LineCategory, I18nKey> = {
  labor: 'voix.catLabor',
  supply: 'voix.catSupply',
  travel: 'voix.catTravel',
  disbursement: 'voix.catSupply',
  subscription: 'voix.catSupply',
};

/** Mêmes couples taux+contexte que le wizard devis (le serveur revalide via suggestVatRate). */
const VAT_CHOICES: readonly {
  key: string;
  labelKey: I18nKey;
  rate: VatRate;
  context: { housingOlderThan2y: boolean; energyRenovation: boolean };
}[] = [
  { key: 'standard', labelKey: 'devis.vatStandard', rate: 20, context: { housingOlderThan2y: false, energyRenovation: false } },
  { key: 'housing', labelKey: 'devis.vatHousing', rate: 10, context: { housingOlderThan2y: true, energyRenovation: false } },
  { key: 'energy', labelKey: 'devis.vatEnergy', rate: 5.5, context: { housingOlderThan2y: true, energyRenovation: true } },
];
const FRANCHISE_CHOICES: typeof VAT_CHOICES = [
  { key: 'franchise', labelKey: 'devis.vatFranchise', rate: 0, context: { housingOlderThan2y: false, energyRenovation: false } },
];

const GUARD_KEY: Record<FactureDirecteGuardError['code'], I18nKey> = {
  customer_required: 'fd.guardClient',
  international_pro_blocked: 'fd.intlBlockedTitle',
  urgent_answer_required: 'fd.urgentQuestion',
  urgent_required_for_b2c: 'fd.urgentRequiredBody',
  lines_required: 'fd.guardLines',
  vat_required: 'fd.vatRequired',
  discount_invalid: 'discount.invalid',
  flow_finished: 'fd.guardLines',
};

const parsePositive = (value: string): number | null => {
  const n = Number(value.trim().replace(',', '.'));
  return Number.isFinite(n) && n > 0 ? n : null;
};

export default function FactureDirecteNew() {
  const { colors, semantic, controls, radius, theme, personality } = useTheme();
  const insets = useSafeAreaInsets();
  const router = useRouter();
  const confirm = useConfirm();
  const customers = useCustomers();
  const company = useCompanyMe();
  const catalogue = useCatalogue();
  const compose = useComposeStandaloneInvoice();

  const [state, setState] = useState<FactureDirecteState>(startFactureDirecte);
  const [guardMsg, setGuardMsg] = useState<string | null>(null);
  const [serverError, setServerError] = useState<string | null>(null);

  // Saisie de ligne (présentation pure — la validation vit dans le modèle/le domaine).
  const [lineLabel, setLineLabel] = useState('');
  const [lineQty, setLineQty] = useState('1');
  const [linePrice, setLinePrice] = useState('');
  const [lineCat, setLineCat] = useState<LineCategory>('labor');
  const [lineDiscKind, setLineDiscKind] = useState<'percent' | 'amount'>('percent');
  const [lineDiscRaw, setLineDiscRaw] = useState('');
  const [lineDiscError, setLineDiscError] = useState(false);
  // Remise globale du récap.
  const [globalDiscKind, setGlobalDiscKind] = useState<'percent' | 'amount'>('percent');
  const [globalDiscRaw, setGlobalDiscRaw] = useState('');
  const [globalDiscError, setGlobalDiscError] = useState(false);
  const submitInFlight = useRef(false);

  const stepIndex = FACTURE_DIRECTE_STEPS.indexOf(state.step);
  const isVatFranchise = company.data?.vatRegime === 'franchise';
  const vatChoices = company.data === undefined ? [] : isVatFranchise ? FRANCHISE_CHOICES : VAT_CHOICES;
  const totals = totalsOf(state);
  const customerBlocked = isInternationalProBlocked(state.customer);

  const say = (error: FactureDirecteGuardError): void =>
    setGuardMsg(t(GUARD_KEY[error.code], { personality }));

  const goNext = (): void => {
    const advanced = nextStep(state);
    if (!advanced.ok) {
      say(advanced.error);
      return;
    }
    setGuardMsg(null);
    setState(advanced.value);
  };
  const goBack = (): void => {
    setGuardMsg(null);
    setState((current) => previousStep(current));
  };

  // Suggestions catalogue (C27) au fil de la saisie — proposer n'impose jamais.
  const suggestions = useMemo<CataloguePrestation[]>(() => {
    const q = lineLabel.trim();
    if (q.length < 2) return [];
    const exact = q.toLowerCase();
    return searchCatalogue(catalogue.prestations, q)
      .filter((p) => p.label.toLowerCase() !== exact)
      .slice(0, 3);
  }, [catalogue.prestations, lineLabel]);

  const lineQtyValue = parsePositive(lineQty);
  const linePriceValue = parsePositive(linePrice);
  const lineValid =
    lineLabel.trim() !== '' && lineQtyValue !== null && linePriceValue !== null && state.vatRate !== null;

  const submitLine = (): void => {
    if (!lineValid || lineQtyValue === null || linePriceValue === null || state.vatRate === null) return;
    const baseCents = Math.round(lineQtyValue * Math.round(linePriceValue * 100));
    const parsedDiscount = parseDiscountInput(lineDiscKind, lineDiscRaw, baseCents);
    if (!parsedDiscount.ok) {
      setLineDiscError(true);
      return;
    }
    const line: LineInput = {
      label: lineLabel.trim(),
      category: lineCat,
      qty: lineQtyValue,
      unitPriceHT: Math.round(linePriceValue * 100),
      vatRate: state.vatRate,
      ...(parsedDiscount.discount !== null ? { discount: parsedDiscount.discount } : {}),
    };
    const added = addLine(state, line);
    if (!added.ok) {
      say(added.error);
      return;
    }
    setState(added.value);
    setGuardMsg(null);
    setLineLabel('');
    setLineQty('1');
    setLinePrice('');
    setLineDiscRaw('');
    setLineDiscError(false);
  };

  const applyGlobalDiscount = (raw: string, kind: 'percent' | 'amount'): void => {
    setGlobalDiscRaw(raw);
    setGlobalDiscKind(kind);
    const netAfterLines = totalsOf({ ...state, globalDiscount: null }).ht;
    const parsed = parseDiscountInput(kind, raw, netAfterLines);
    if (!parsed.ok) {
      setGlobalDiscError(true);
      return;
    }
    const applied = setGlobalDiscount(state, parsed.discount);
    if (!applied.ok) {
      setGlobalDiscError(true);
      return;
    }
    setGlobalDiscError(false);
    setState(applied.value);
  };

  const submit = async (): Promise<void> => {
    if (submitInFlight.current) return;
    const payload = buildComposePayload(state);
    if (payload === null || state.customer === null) {
      setGuardMsg(t('fd.guardClient', { personality }));
      return;
    }
    submitInFlight.current = true;
    try {
      const ok = await confirm({
        title: t('fd.confirmTitle', { personality }),
        message: t('fd.confirmBody', {
          personality,
          params: { name: state.customer.name, amount: formatEUR(totals.ttc) },
        }),
        challenge: challengeFor(REVERSIBLE, 'confirm_all'),
      });
      if (!ok) return;
      setServerError(null);
      const out = await compose.mutateAsync(payload);
      router.replace(`/facture/${out.invoiceId}`);
    } catch (error) {
      // 422 serveur (urgence A3bis, garde B7, TVA revalidée…) affiché TEL QUEL — état honnête.
      setServerError(appErrorMessage(error));
    } finally {
      submitInFlight.current = false;
    }
  };

  const discountBadge = (discount: Discount): string =>
    discount.type === 'percent'
      ? `−${String(discount.value).replace('.', ',')} %`
      : `−${formatEUR(discount.cents)}`;

  const fieldStyle = {
    minHeight: 44,
    borderWidth: 1,
    borderColor: colors.lineSoft,
    borderRadius: 12,
    paddingHorizontal: 13,
    paddingVertical: 11,
    color: colors.ink800,
  } as const;

  return (
    <View style={{ flex: 1, backgroundColor: colors.bg }}>
      <KeyboardAvoidingView style={{ flex: 1 }} {...(Platform.OS === 'ios' ? { behavior: 'padding' as const } : {})}>
        {/* En-tête : retour · badge « Facture directe » · fermer */}
        <View
          style={{
            paddingTop: insets.top + 10,
            paddingHorizontal: 18,
            flexDirection: 'row',
            alignItems: 'center',
            justifyContent: 'space-between',
          }}
        >
          {stepIndex > 0 ? (
            <PressableScale
              accessibilityRole="button"
              accessibilityLabel={t('devis.back', { personality })}
              onPress={goBack}
              hitSlop={6}
              style={{ flexDirection: 'row', alignItems: 'center', gap: 4, minHeight: 44, minWidth: 44 }}
            >
              <ChevronLeftIcon color={colors.ink600} size={18} strokeWidth={2.2} />
              <Text style={[font('label', 600), { fontSize: 15, color: colors.ink600 }]}>
                {t('devis.back', { personality })}
              </Text>
            </PressableScale>
          ) : (
            <Text style={[font('eyebrow'), { color: colors.slate400 }]}>
              {t('fd.title', { personality })}
            </Text>
          )}
          <View style={{ flexDirection: 'row', alignItems: 'center', gap: 10 }}>
            <StatusBadge label={t('fd.badge', { personality })} variant="b2b" />
            <PressableScale
              accessibilityRole="button"
              accessibilityLabel={t('devis.close', { personality })}
              onPress={() => router.back()}
              hitSlop={6}
              style={{
                width: 34,
                height: 34,
                minWidth: 34,
                minHeight: 34,
                borderRadius: 17,
                backgroundColor: controls.segmentedTrack,
                alignItems: 'center',
                justifyContent: 'center',
              }}
            >
              <CloseIcon color={colors.slate500} size={16} />
            </PressableScale>
          </View>
        </View>

        <View style={{ paddingHorizontal: 18, paddingTop: 12, paddingBottom: 4 }}>
          <Stepper
            total={FACTURE_DIRECTE_STEPS.length}
            current={stepIndex}
            labels={STEP_KEYS.map((key) => t(key, { personality }))}
            accessibilityLabel={t('fd.title', { personality })}
          />
        </View>

        <ScrollView
          style={{ flex: 1 }}
          contentContainerStyle={{ paddingHorizontal: 18, paddingTop: 8, paddingBottom: 24, gap: 12 }}
          keyboardShouldPersistTaps="handled"
        >
          {/* ── Étape 1 — client (liste réelle, gardes A3bis + B7) ── */}
          {state.step === 'client' ? (
            <>
              {/* FadeIn en cascade à l'entrée de l'étape — même langage motion que
                  Aujourd'hui/Ventes (au montage seulement, reduce-motion respecté). */}
              <FadeIn index={0} style={{ gap: 12 }}>
                <Text style={[font('screenH1'), { fontSize: 24, color: colors.ink900 }]}>
                  {t('devis.clientTitle', { personality })}
                </Text>
                <Text style={[font('sub'), { color: colors.slate500, marginBottom: 4 }]}>
                  {t('fd.intro', { personality })}
                </Text>
              </FadeIn>
              {customers.isLoading ? (
                <>
                  <SkeletonRow avatar="circle" lines={2} trailing="pill" />
                  <SkeletonRow avatar="circle" lines={2} trailing="pill" />
                  <SkeletonRow avatar="circle" lines={2} trailing="pill" />
                </>
              ) : customers.isError ? (
                <ErrorRetry
                  message={t('devis.dataError', { personality })}
                  onRetry={() => void customers.refetch()}
                  retrying={customers.isRefetching}
                />
              ) : (customers.data ?? []).length === 0 ? (
                <Card>
                  <EmptyState body={t('devis.noCustomers', { personality })} />
                </Card>
              ) : (
                (customers.data ?? []).map((c, cardIndex) => {
                  const selected = state.customer?.id === c.id;
                  return (
                    <FadeIn key={c.id} index={Math.min(cardIndex + 1, 8)}>
                      {/* PressableScale : LE press feedback standard des surfaces (scale 0.98,
                          reduce-motion respecté) — une carte client répond au doigt. */}
                      <PressableScale
                        onPress={() => {
                          setGuardMsg(null);
                          setState((current) =>
                            selectCustomer(current, {
                              id: c.id,
                              name: c.name,
                              type: c.type,
                              isInternational: c.isInternational === true,
                            }),
                          );
                        }}
                        accessibilityRole="radio"
                        accessibilityLabel={c.name}
                        accessibilityState={{ selected }}
                        style={{
                          flexDirection: 'row',
                          alignItems: 'center',
                          gap: 12,
                          minHeight: 44,
                          backgroundColor: colors.surface,
                          borderRadius: radius.cardLg,
                          borderWidth: selected ? 2 : 1,
                          borderColor: selected ? theme.ink : controls.cardBorder,
                          paddingVertical: 13,
                          paddingHorizontal: 14,
                          ...shadowNative.e1,
                        }}
                      >
                        <Avatar name={c.name} size={42} tone={CUSTOMER_TONE[c.type]} />
                        <View style={{ flex: 1 }}>
                          <Text style={[font('cardTitle'), { fontSize: 15.5, color: colors.ink900 }]}>{c.name}</Text>
                          {c.siren !== null ? (
                            <Text style={[font('meta'), { fontSize: 12.5, color: colors.slate400, marginTop: 1 }]}>
                              {t('fiche.sirenLabel', { personality, params: { siren: c.siren } })}
                            </Text>
                          ) : null}
                        </View>
                        <StatusBadge label={t(CUSTOMER_BADGE[c.type], { personality })} variant={CUSTOMER_TONE[c.type]} />
                        {selected ? <CheckIcon color={theme.ink} size={18} strokeWidth={2.4} /> : null}
                      </PressableScale>
                    </FadeIn>
                  );
                })
              )}

              {/* B7 — pro étranger : état BLOQUANT honnête (LegalHint), jamais un crash. */}
              {customerBlocked ? (
                <FadeIn index={0}>
                <Card radius={18} padding={16} style={{ borderColor: semantic.danger }}>
                  <Text style={[font('cardTitle'), { fontSize: 15.5, color: colors.ink900, marginBottom: 6 }]}>
                    {t('fd.intlBlockedTitle', { personality })}
                  </Text>
                  <Text style={[font('sub'), { color: colors.slate500, lineHeight: 19, marginBottom: 8 }]}>
                    {t('fd.intlBlockedBody', { personality })}
                  </Text>
                  <LegalHint
                    label={t('legal.intl.inline', { personality })}
                    lawKey="legal.intl.law"
                    whyKey="legal.intl.why"
                    source="art. 259, 262 et 283, 3 du CGI ; directive 2006/112/CE"
                  />
                </Card>
                </FadeIn>
              ) : null}

              {/* A3bis — particulier : la question d'urgence fonde (ou non) la facture directe. */}
              {state.customer?.type === 'b2c' && !customerBlocked ? (
                <FadeIn index={0}>
                <Card radius={18} padding={16}>
                  <Text style={[font('cardTitle'), { fontSize: 15.5, color: colors.ink900, marginBottom: 10 }]}>
                    {t('fd.urgentQuestion', { personality })}
                  </Text>
                  <View style={{ flexDirection: 'row', gap: 8, marginBottom: 10 }}>
                    <Chip
                      label={t('fd.urgentYes', { personality })}
                      active={state.urgentOnSiteRepair === true}
                      onPress={() => {
                        setGuardMsg(null);
                        setState((current) => setUrgentOnSiteRepair(current, true));
                      }}
                    />
                    <Chip
                      label={t('fd.urgentNo', { personality })}
                      active={state.urgentOnSiteRepair === false}
                      onPress={() => setState((current) => setUrgentOnSiteRepair(current, false))}
                    />
                  </View>
                  <LegalHint
                    label={t('legal.fdUrgent.inline', { personality })}
                    lawKey="legal.fdUrgent.law"
                    whyKey="legal.fdUrgent.why"
                    source="art. L221-28, 8° et L221-10 du code de la consommation"
                  />
                  {state.urgentOnSiteRepair === false ? (
                    // « Non » = état bloquant HONNÊTE : le devis signé est le contrat.
                    <View
                      style={{
                        marginTop: 10,
                        borderRadius: 12,
                        backgroundColor: semantic.warningBg,
                        padding: 12,
                        gap: 10,
                      }}
                    >
                      <Text style={[font('sub'), { color: colors.ink800, lineHeight: 19 }]}>
                        {t('fd.urgentRequiredBody', { personality })}
                      </Text>
                      <Button
                        title={t('devis.title', { personality })}
                        variant="secondary"
                        size="compact"
                        onPress={() => router.replace('/devis/new')}
                      />
                    </View>
                  ) : null}
                </Card>
                </FadeIn>
              ) : null}
            </>
          ) : null}

          {/* ── Étape 2 — prestations (TVA une pour toutes + remise de ligne discrète) ── */}
          {state.step === 'lignes' ? (
            <>
              <FadeIn index={0}>
                <Text style={[font('screenH1'), { fontSize: 24, color: colors.ink900 }]}>
                  {t('fd.stepLines', { personality })}
                </Text>
              </FadeIn>

              {/* Taux unique de la pièce — mêmes couples ET mêmes états 4-niveaux que le
                  wizard devis (devis/new.tsx) : skeleton pendant /company/me, erreur honnête
                  + retry en échec — jamais une rangée de chips vide sans explication. */}
              {company.isError ? (
                <FadeIn index={1}>
                  <ErrorRetry
                    message={t('devis.vatProfileUnavailable', { personality })}
                    onRetry={() => void company.refetch()}
                    retrying={company.isRefetching}
                  />
                </FadeIn>
              ) : company.isLoading ? (
                <FadeIn index={1}>
                  <SkeletonRow avatar={false} lines={1} trailing="pill" />
                </FadeIn>
              ) : (
                <FadeIn index={1} style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 8 }}>
                  {vatChoices.map((choice) => (
                    <Chip
                      key={choice.key}
                      label={t(choice.labelKey, { personality })}
                      active={state.vatRate === choice.rate}
                      onPress={() => {
                        setGuardMsg(null);
                        setState((current) => setVat(current, choice.rate, choice.context));
                      }}
                    />
                  ))}
                </FadeIn>
              )}

              {/* Lignes déjà ajoutées : net après remise, avant/après élégant. */}
              {state.lines.map((line, index) => {
                const gross = Math.round(line.qty * line.unitPriceHT);
                const net =
                  gross -
                  (line.discount
                    ? line.discount.type === 'percent'
                      ? Math.round((gross * line.discount.value) / 100)
                      : Math.min(line.discount.cents, gross)
                    : 0);
                return (
                  // FadeIn au montage : une ligne ajoutée APPARAÎT (jamais un pop sec) —
                  // un refetch/re-render ne rejoue rien (contrat FadeIn).
                  <FadeIn key={`${line.label}-${index}`} index={0}>
                  <Card radius={16} padding={13}>
                    <View style={{ flexDirection: 'row', alignItems: 'center', gap: 10 }}>
                      <View style={{ flex: 1 }}>
                        <Text style={[font('cardTitle'), { fontSize: 14.5, color: colors.ink900 }]}>
                          {line.label}
                        </Text>
                        <Text style={[font('meta'), { fontSize: 12.5, color: colors.slate400, marginTop: 2 }]}>
                          {`${line.qty} × ${formatEUR(line.unitPriceHT)} · ${t(CAT_KEY[line.category], { personality })}`}
                        </Text>
                        {line.discount ? (
                          <View style={{ flexDirection: 'row', alignItems: 'center', gap: 6, marginTop: 3 }}>
                            <Text
                              style={[
                                font('meta', 500),
                                { fontSize: 12, color: colors.slate300, textDecorationLine: 'line-through', fontVariant: ['tabular-nums'] },
                              ]}
                            >
                              {formatEUR(gross)}
                            </Text>
                            <Text style={[font('meta', 700), { fontSize: 12, color: semantic.success }]}>
                              {discountBadge(line.discount)}
                            </Text>
                          </View>
                        ) : null}
                      </View>
                      <MoneyText cents={net} />
                      {/* Même famille visuelle que le retrait de ligne du wizard devis
                          (rond segmentedTrack), avec le press feedback standard ; cible
                          tactile effective ≥ 44 pt (32 + hitSlop 8). */}
                      <PressableScale
                        accessibilityRole="button"
                        accessibilityLabel={t('devis.removeLine', { personality, params: { label: line.label } })}
                        hitSlop={8}
                        onPress={() => setState((current) => removeLine(current, index))}
                        style={{
                          width: 32,
                          height: 32,
                          minWidth: 32,
                          minHeight: 32,
                          borderRadius: 16,
                          backgroundColor: controls.segmentedTrack,
                          alignItems: 'center',
                          justifyContent: 'center',
                        }}
                      >
                        <CloseIcon color={colors.slate400} size={14} strokeWidth={2.4} />
                      </PressableScale>
                    </View>
                  </Card>
                  </FadeIn>
                );
              })}

              {/* Saisie d'une ligne — libellé, qté, PU, catégorie + remise DISCRÈTE (% ou €). */}
              <FadeIn index={2}>
              <Card radius={18} padding={16}>
                <TextInput
                  value={lineLabel}
                  onChangeText={setLineLabel}
                  placeholder={t('devis.lineLabelPlaceholder', { personality })}
                  placeholderTextColor={colors.slate300}
                  accessibilityLabel={t('devis.lineLabelPlaceholder', { personality })}
                  style={[font('body'), fieldStyle]}
                />
                {suggestions.length > 0 ? (
                  <View style={{ marginTop: 6, gap: 2 }}>
                    {suggestions.map((p) => (
                      // Press feedback standard + cible ≥ 44 pt (le minHeight 40 régressait
                      // sous le plancher tactile du système).
                      <PressableScale
                        key={p.id}
                        accessibilityRole="button"
                        accessibilityLabel={p.label}
                        onPress={() => {
                          setLineLabel(p.label);
                          setLinePrice((p.unitPriceHT / 100).toFixed(2).replace('.', ','));
                          setLineCat(p.category);
                        }}
                        style={{ minHeight: 44, justifyContent: 'center', paddingHorizontal: 6 }}
                      >
                        <Text style={[font('sub'), { color: colors.ink800 }]}>
                          {p.label} · {formatEUR(p.unitPriceHT)}
                        </Text>
                      </PressableScale>
                    ))}
                  </View>
                ) : null}
                <View style={{ flexDirection: 'row', gap: 8, marginTop: 8 }}>
                  <TextInput
                    value={lineQty}
                    onChangeText={setLineQty}
                    keyboardType="decimal-pad"
                    placeholder="1"
                    placeholderTextColor={colors.slate300}
                    accessibilityLabel={t('devis.qtyLabel', { personality })}
                    style={[font('body'), fieldStyle, { flex: 1 }]}
                  />
                  <TextInput
                    value={linePrice}
                    onChangeText={setLinePrice}
                    keyboardType="decimal-pad"
                    placeholder="0,00"
                    placeholderTextColor={colors.slate300}
                    accessibilityLabel={t('devis.unitPriceLabel', { personality })}
                    style={[font('body'), fieldStyle, { flex: 2 }]}
                  />
                </View>
                <View style={{ flexDirection: 'row', gap: 8, marginTop: 8 }}>
                  {FACTURE_DIRECTE_CATEGORIES.map((category) => (
                    <Chip
                      key={category}
                      label={t(CAT_KEY[category], { personality })}
                      active={lineCat === category}
                      onPress={() => setLineCat(category)}
                    />
                  ))}
                </View>
                {/* Remise de ligne DISCRÈTE : petite rangée % / € + valeur — jamais imposante. */}
                <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8, marginTop: 10 }}>
                  <Text style={[font('label', 700), { fontSize: 12, color: colors.slate400 }]}>
                    {t('discount.lineLabel', { personality }).toUpperCase()}
                  </Text>
                  <Chip
                    label={t('discount.typePercent', { personality })}
                    active={lineDiscKind === 'percent'}
                    onPress={() => {
                      setLineDiscKind('percent');
                      setLineDiscError(false);
                    }}
                  />
                  <Chip
                    label={t('discount.typeAmount', { personality })}
                    active={lineDiscKind === 'amount'}
                    onPress={() => {
                      setLineDiscKind('amount');
                      setLineDiscError(false);
                    }}
                  />
                  <TextInput
                    value={lineDiscRaw}
                    onChangeText={(v) => {
                      setLineDiscRaw(v);
                      setLineDiscError(false);
                    }}
                    keyboardType="decimal-pad"
                    placeholder={t('discount.linePlaceholder', { personality })}
                    placeholderTextColor={colors.slate300}
                    accessibilityLabel={t('discount.lineLabel', { personality })}
                    style={[
                      font('body'),
                      fieldStyle,
                      { flex: 1, borderColor: lineDiscError ? semantic.danger : colors.lineSoft },
                    ]}
                  />
                </View>
                {lineDiscError ? (
                  <Text accessibilityRole="alert" style={[font('meta', 500), { fontSize: 12, color: semantic.danger, marginTop: 6 }]}>
                    {t('discount.invalid', { personality })}
                  </Text>
                ) : null}
                <Button
                  title={t('devis.addLine', { personality })}
                  variant="secondary"
                  disabled={!lineValid}
                  style={{ marginTop: 12 }}
                  onPress={submitLine}
                />
              </Card>
              </FadeIn>
            </>
          ) : null}

          {/* ── Étape 3 — récap : avant/après remise + badge + confirmation ── */}
          {state.step === 'recap' ? (
            <>
              <FadeIn index={0}>
                <Text style={[font('screenH1'), { fontSize: 24, color: colors.ink900 }]}>
                  {t('fd.recapTitle', { personality })}
                </Text>
              </FadeIn>
              {state.customer ? (
                <FadeIn index={1}>
                <Card radius={18} padding={16}>
                  <View style={{ flexDirection: 'row', alignItems: 'center', gap: 12 }}>
                    <Avatar name={state.customer.name} size={42} tone={CUSTOMER_TONE[state.customer.type]} />
                    <View style={{ flex: 1 }}>
                      <Text style={[font('cardTitle'), { fontSize: 15.5, color: colors.ink900 }]}>
                        {state.customer.name}
                      </Text>
                      <View style={{ flexDirection: 'row', gap: 6, marginTop: 4 }}>
                        <StatusBadge
                          label={t(CUSTOMER_BADGE[state.customer.type], { personality })}
                          variant={CUSTOMER_TONE[state.customer.type]}
                        />
                        <StatusBadge label={t('fd.badge', { personality })} variant="b2b" />
                      </View>
                    </View>
                  </View>
                  {state.customer.type === 'b2c' && state.urgentOnSiteRepair === true ? (
                    <View style={{ marginTop: 10 }}>
                      <LegalHint
                        label={t('legal.fdUrgent.inline', { personality })}
                        lawKey="legal.fdUrgent.law"
                        whyKey="legal.fdUrgent.why"
                        source="art. L221-28, 8° et L221-10 du code de la consommation"
                      />
                    </View>
                  ) : null}
                </Card>
                </FadeIn>
              ) : null}

              <FadeIn index={2}>
              <Card radius={18} padding={16}>
                {state.lines.map((line, index) => (
                  <View
                    key={`${line.label}-${index}`}
                    style={{
                      flexDirection: 'row',
                      justifyContent: 'space-between',
                      paddingVertical: 6,
                      borderBottomWidth: index === state.lines.length - 1 ? 0 : 1,
                      borderBottomColor: colors.lineSoft,
                    }}
                  >
                    <Text numberOfLines={1} style={[font('sub'), { color: colors.ink800, flex: 1, paddingRight: 10 }]}>
                      {line.label}
                      {line.discount ? (
                        <Text style={[font('meta', 700), { fontSize: 12, color: semantic.success }]}>
                          {'  '}{discountBadge(line.discount)}
                        </Text>
                      ) : null}
                    </Text>
                    <Text style={{ ...font('sub', 600), color: colors.ink800, fontVariant: ['tabular-nums'] }}>
                      {formatEUR(Math.round(line.qty * line.unitPriceHT))}
                    </Text>
                  </View>
                ))}

                {/* Remise globale — « je t'arrondis à… » au moment du récap. */}
                <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8, marginTop: 12 }}>
                  <Text style={[font('label', 700), { fontSize: 12, color: colors.slate400, flex: 1 }]}>
                    {t('discount.globalTitle', { personality }).toUpperCase()}
                  </Text>
                  <Chip
                    label={t('discount.typePercent', { personality })}
                    active={globalDiscKind === 'percent'}
                    onPress={() => applyGlobalDiscount(globalDiscRaw, 'percent')}
                  />
                  <Chip
                    label={t('discount.typeAmount', { personality })}
                    active={globalDiscKind === 'amount'}
                    onPress={() => applyGlobalDiscount(globalDiscRaw, 'amount')}
                  />
                  <TextInput
                    value={globalDiscRaw}
                    onChangeText={(v) => applyGlobalDiscount(v, globalDiscKind)}
                    keyboardType="decimal-pad"
                    placeholder={t('discount.linePlaceholder', { personality })}
                    placeholderTextColor={colors.slate300}
                    accessibilityLabel={t('discount.globalTitle', { personality })}
                    style={[
                      font('body'),
                      fieldStyle,
                      { width: 88, borderColor: globalDiscError ? semantic.danger : colors.lineSoft },
                    ]}
                  />
                </View>
                {globalDiscError ? (
                  <Text accessibilityRole="alert" style={[font('meta', 500), { fontSize: 12, color: semantic.danger, marginTop: 6 }]}>
                    {t('discount.invalid', { personality })}
                  </Text>
                ) : (
                  <Text style={[font('meta', 500), { fontSize: 12, color: colors.slate400, marginTop: 6 }]}>
                    {t('discount.globalHint', { personality })}
                  </Text>
                )}

                {/* Totaux avant/après : HT brut barré subtil, remise en vert success. */}
                <View style={{ marginTop: 12, paddingTop: 10, borderTopWidth: 1, borderTopColor: colors.lineSoft }}>
                  {(totals.discountCents ?? 0) > 0 ? (
                    <>
                      <View style={{ flexDirection: 'row', justifyContent: 'space-between', paddingVertical: 3 }}>
                        <Text style={[font('sub'), { color: colors.slate500 }]}>
                          {t('discount.recapGross', { personality })}
                        </Text>
                        <Text
                          style={{
                            ...font('sub', 500),
                            color: colors.slate300,
                            textDecorationLine: 'line-through',
                            fontVariant: ['tabular-nums'],
                          }}
                        >
                          {formatEUR(totals.grossHt ?? totals.ht)}
                        </Text>
                      </View>
                      <View style={{ flexDirection: 'row', justifyContent: 'space-between', paddingVertical: 3 }}>
                        <Text style={[font('sub'), { color: colors.slate500 }]}>
                          {t('discount.recapSaved', { personality })}
                        </Text>
                        <Text style={{ ...font('sub', 700), color: semantic.success, fontVariant: ['tabular-nums'] }}>
                          −{formatEUR(totals.discountCents ?? 0)}
                        </Text>
                      </View>
                    </>
                  ) : null}
                  <View style={{ flexDirection: 'row', justifyContent: 'space-between', paddingVertical: 3 }}>
                    <Text style={[font('sub'), { color: colors.slate500 }]}>{t('piece.totalHt', { personality })}</Text>
                    <Text style={{ ...font('sub', 600), color: colors.ink800, fontVariant: ['tabular-nums'] }}>
                      {formatEUR(totals.ht)}
                    </Text>
                  </View>
                  <View style={{ flexDirection: 'row', justifyContent: 'space-between', paddingVertical: 3 }}>
                    <Text style={[font('sub'), { color: colors.slate500 }]}>{t('piece.totalVat', { personality })}</Text>
                    <Text style={{ ...font('sub', 600), color: colors.ink800, fontVariant: ['tabular-nums'] }}>
                      {formatEUR(totals.vat)}
                    </Text>
                  </View>
                  <View
                    style={{
                      flexDirection: 'row',
                      alignItems: 'center',
                      justifyContent: 'space-between',
                      marginTop: 6,
                      paddingTop: 9,
                      borderTopWidth: 1,
                      borderTopColor: colors.lineSoft,
                    }}
                  >
                    <Text style={{ ...font('body', 700), fontSize: 15, color: colors.ink800 }}>
                      {t('piece.totalTtc', { personality })}
                    </Text>
                    <MoneyText cents={totals.ttc} variant="big" />
                  </View>
                </View>
              </Card>
              </FadeIn>

              {serverError ? (
                <Text accessibilityRole="alert" style={[font('sub'), { color: semantic.danger }]}>
                  {serverError}
                </Text>
              ) : null}
            </>
          ) : null}

          {guardMsg ? (
            <Text accessibilityRole="alert" accessibilityLiveRegion="polite" style={[font('sub'), { color: semantic.danger }]}>
              {guardMsg}
            </Text>
          ) : null}
        </ScrollView>

        {/* Barre d'action sticky : Continuer / Créer la facture. */}
        <View
          style={{
            paddingHorizontal: 18,
            paddingTop: 10,
            paddingBottom: insets.bottom + 12,
            borderTopWidth: 1,
            borderTopColor: colors.lineSoft,
            backgroundColor: colors.surface,
          }}
        >
          {state.step === 'recap' ? (
            <Button
              title={t('fd.createCta', { personality })}
              loading={compose.isPending}
              disabled={compose.isPending}
              onPress={() => void submit()}
            />
          ) : (
            <Button title={t('devis.next', { personality })} onPress={goNext} />
          )}
        </View>
      </KeyboardAvoidingView>
    </View>
  );
}
