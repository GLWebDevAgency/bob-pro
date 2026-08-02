/**
 * PR-12c — wizard « Nouveau contrat » (écrans §3.3, grammaire S12, kit matière Bob) :
 * 1. Client & site — picker client FILTRÉ b2b/b2g (note pédagogique Chatel pour le reste,
 *    périmètre V1 §2.1) ; site optionnel, sites `open` seulement.
 * 2. Lignes — libellé/quantité/PU HT/TVA (elles composeront la facture annuelle en catégorie
 *    'subscription' — la Σ est VIVANTE, jamais persistée).
 * 3. Conditions — anniversaryDate requise (PEUT être passée : contrats migrés), passages/an,
 *    préavis + LegalHint, tacite ; bloc « Contrat migré ? » : la saisie « Déjà facturé
 *    jusqu'au » est INCLUSIVE et convertie +1 jour vers la borne EXCLUSIVE importCoveredUntil
 *    ([annexe erratum n° 4] — testé dans contract-fiche.logic.test).
 * 4. Revue — total = Σ lignes, période courante CALCULÉE affichée bornes incluses.
 * CTA « Créer le brouillon » : l'ACTIVATION reste un geste distinct (jamais synonymes).
 */
import { useMemo, useState } from 'react';
import { AccessibilityInfo, Pressable, ScrollView, Text, TextInput, View } from 'react-native';
import { useLocalSearchParams, useRouter } from 'expo-router';
import { t } from '@bob/i18n';
import {
  BobSwitch,
  BobSurface,
  Button,
  DeleteIconButton,
  ErrorRetry,
  FadeIn,
  LegalHint,
  SkeletonRow,
  Stepper,
  font,
  useTheme,
} from '@bob/ui';
import { currentPeriod, formatEURWhole, parisDateOnly } from '@bob/core';
import type { ContractLineInput } from '@bob/core';
import { appErrorMessage, useChantiers, useCreateMaintenanceContract, useCustomers } from '../../src/data/hooks';
import { ScreenHeader } from '../../src/components/screen-header';
import { CheckIcon, TrashIcon } from '../../src/components/icons';
import { useBobAwareScrollInsets } from '../../src/components/use-bob-aware-scroll-insets';
import {
  frContractDate,
  importCoveredUntilFromInclusive,
  inclusivePeriodOf,
} from '../../src/components/contract-fiche.logic';

const DATE_ONLY = /^\d{4}-\d{2}-\d{2}$/;

interface DraftLine {
  label: string;
  qty: string;
  unitPriceEur: string;
  vatRate: string;
}

const EMPTY_LINE: DraftLine = { label: '', qty: '1', unitPriceEur: '', vatRate: '20' };

/** Ligne saisie → ContractLineInput (centimes entiers) — null si invalide. */
function parseDraftLine(line: DraftLine): ContractLineInput | null {
  const label = line.label.trim();
  if (label === '') return null;
  const qty = Number(line.qty.replace(',', '.'));
  if (!Number.isFinite(qty) || qty <= 0) return null;
  const eur = Number(line.unitPriceEur.replace(',', '.'));
  if (!Number.isFinite(eur) || eur < 0) return null;
  const vat = Number(line.vatRate.replace(',', '.'));
  if (!Number.isFinite(vat) || vat < 0) return null;
  return {
    label,
    quantity: qty,
    unitPriceHtCents: Math.round(eur * 100),
    vatRate: vat as ContractLineInput['vatRate'],
  };
}

export default function NouveauContrat() {
  const { customerId: presetCustomerId } = useLocalSearchParams<{ customerId?: string }>();
  const { personality, colors, controls, semantic, theme } = useTheme();
  const router = useRouter();
  const scrollInsets = useBobAwareScrollInsets();

  const customers = useCustomers();
  const chantiers = useChantiers();
  const create = useCreateMaintenanceContract();

  const [step, setStep] = useState(0);
  const [customerId, setCustomerId] = useState<string | null>(
    typeof presetCustomerId === 'string' && presetCustomerId.length > 0 ? presetCustomerId : null,
  );
  const [chantierId, setChantierId] = useState<string | null>(null);
  const [label, setLabel] = useState('');
  const [lines, setLines] = useState<DraftLine[]>([{ ...EMPTY_LINE }]);
  const [anniversaryDate, setAnniversaryDate] = useState('');
  const [visitsPerYear, setVisitsPerYear] = useState('2');
  const [noticeDays, setNoticeDays] = useState('30');
  const [tacitRenewal, setTacitRenewal] = useState(true);
  /** Saisie humaine INCLUSIVE — convertie +1 j à la soumission (erratum n° 4). */
  const [billedThroughInclusive, setBilledThroughInclusive] = useState('');
  const [error, setError] = useState<string | null>(null);

  // Périmètre V1 : contrats B2B/B2G uniquement (garde serveur revalidée — le picker FILTRE).
  const professionalCustomers = (customers.data ?? []).filter((customer) => customer.type !== 'b2c');
  const openSites = (chantiers.data ?? []).filter((chantier) => chantier.status === 'open');
  const parsedLines = lines.map(parseDraftLine);
  const validLines = parsedLines.filter((line): line is ContractLineInput => line !== null);
  const totalHtCents = validLines.reduce(
    (sum, line) => sum + Math.round(line.quantity * line.unitPriceHtCents),
    0,
  );
  const today = parisDateOnly();
  const reviewPeriod = useMemo(() => {
    if (!DATE_ONLY.test(anniversaryDate.trim())) return null;
    const period = currentPeriod(
      {
        status: 'active',
        anniversaryDate: anniversaryDate.trim(),
        tacitRenewal,
        importCoveredUntil: null,
        terminationEffectiveDate: null,
      },
      today,
    );
    return period === null ? null : inclusivePeriodOf(period);
  }, [anniversaryDate, tacitRenewal, today]);

  const stepLabels = [
    t('contrat.stepClient', { personality }),
    t('contrat.stepLines', { personality }),
    t('contrat.stepConditions', { personality }),
    t('contrat.stepReview', { personality }),
  ];

  const validateStep = (): string | null => {
    if (step === 0) {
      if (customerId === null) return t('contrat.customerRequired', { personality });
      if (label.trim() === '') return t('contrat.labelRequired', { personality });
      return null;
    }
    if (step === 1) {
      if (validLines.length === 0) return t('contrat.linesRequired', { personality });
      if (validLines.length !== lines.filter((line) => line.label.trim() !== '' || line.unitPriceEur.trim() !== '').length)
        return t('contrat.lineInvalid', { personality });
      return null;
    }
    if (step === 2) {
      if (!DATE_ONLY.test(anniversaryDate.trim())) return t('contrat.anniversaryField', { personality });
      const billed = billedThroughInclusive.trim();
      if (billed !== '' && !DATE_ONLY.test(billed)) return t('contrat.dateInvalid', { personality });
      if (!Number.isInteger(Number(visitsPerYear)) || Number(visitsPerYear) < 0)
        return t('contrat.visitsField', { personality });
      if (!Number.isInteger(Number(noticeDays)) || Number(noticeDays) < 0)
        return t('contrat.noticeField', { personality });
      return null;
    }
    return null;
  };

  const next = (): void => {
    const issue = validateStep();
    if (issue !== null) {
      setError(issue);
      return;
    }
    setError(null);
    setStep((current) => Math.min(current + 1, 3));
  };

  const submit = async (): Promise<void> => {
    if (customerId === null) return;
    // [Erratum n° 4] : la saisie inclusive devient la borne EXCLUSIVE de la colonne.
    const importCoveredUntil = importCoveredUntilFromInclusive(billedThroughInclusive);
    try {
      const created = await create.mutateAsync({
        customerId,
        label: label.trim(),
        anniversaryDate: anniversaryDate.trim(),
        visitsPerYear: Number(visitsPerYear),
        noticeDays: Number(noticeDays),
        tacitRenewal,
        ...(chantierId !== null ? { chantierId } : {}),
        ...(importCoveredUntil !== null ? { importCoveredUntil } : {}),
        lines: validLines,
      });
      AccessibilityInfo.announceForAccessibility(
        t('contrat.createdAnnounce', { personality, params: { label: label.trim() } }),
      );
      router.replace(`/contrat/${created.id}`);
    } catch (submitError) {
      setError(appErrorMessage(submitError));
    }
  };

  const input = (props: {
    value: string;
    onChange: (value: string) => void;
    placeholder: string;
    keyboardType?: 'numeric';
    flex?: number;
  }) => (
    <TextInput
      value={props.value}
      onChangeText={(value) => {
        setError(null);
        props.onChange(value);
      }}
      placeholder={props.placeholder}
      placeholderTextColor={colors.slate400}
      accessibilityLabel={props.placeholder}
      autoCapitalize="none"
      {...(props.keyboardType ? { keyboardType: props.keyboardType } : {})}
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
          ...(props.flex !== undefined ? { flex: props.flex } : {}),
        },
      ]}
    />
  );

  /** Rangée de sélection — ARBITRAGE SÉLECTION (plan DA 01/08) : theme.ink + CheckIcon
   * PARTOUT (le canon vivant de facture/new), jamais le vert (récompense du geste commis)
   * ni l'indigo (canal exclusif de Bob). borderWidth CONSTANT 2 : fin du saut d'1 px. */
  const pickRow = (key: string, picked: boolean, title: string, subtitle: string | null, onPress: () => void) => (
    <Pressable
      key={key}
      accessibilityRole="radio"
      accessibilityState={{ selected: picked }}
      accessibilityLabel={title}
      onPress={onPress}
      style={{
        minHeight: 44,
        paddingVertical: 10,
        paddingHorizontal: 12,
        borderRadius: 12,
        borderWidth: 2,
        borderColor: picked ? theme.ink : controls.cardBorder,
        backgroundColor: colors.surface,
        flexDirection: 'row',
        alignItems: 'center',
        gap: 10,
      }}
    >
      <View style={{ flex: 1 }}>
        <Text style={[font('body', picked ? 700 : 500), { color: colors.ink800 }]}>{title}</Text>
        {subtitle ? <Text style={[font('sub', 500), { color: colors.slate500 }]}>{subtitle}</Text> : null}
      </View>
      {picked ? <CheckIcon color={theme.ink} size={18} strokeWidth={2.4} /> : null}
    </Pressable>
  );

  return (
    <View style={{ flex: 1, backgroundColor: colors.bg }}>
      <ScrollView
        contentContainerStyle={{ paddingBottom: scrollInsets.paddingBottom }}
        scrollIndicatorInsets={{ bottom: scrollInsets.scrollIndicatorBottom }}
        keyboardShouldPersistTaps="handled"
      >
        <ScreenHeader
          backLabel={t('contrat.eyebrow', { personality })}
          onBack={() => router.back()}
          eyebrow={t('contrat.eyebrow', { personality })}
          title={t('contrat.newTitle', { personality })}
        />
        <View style={{ paddingHorizontal: 16, gap: 12 }}>
          <Stepper total={4} current={step} accessibilityLabel={t('contrat.newTitle', { personality })} />

          {/* Lot 4 : titre d'étape en section/700 (le cran du kit, plus l'eyebrow du
              Stepper) + FadeIn entre étapes (remonté via key — fail-closed hérité). */}
          <FadeIn key={step} index={0}>
          <View style={{ gap: 12 }}>
          <Text accessibilityRole="header" style={[font('section'), { color: colors.ink800 }]}>
            {stepLabels[step]}
          </Text>

          {step === 0 ? (
            <View style={{ gap: 8 }}>
              {input({ value: label, onChange: setLabel, placeholder: t('contrat.labelField', { personality }) })}
              <Text style={[font('sub', 500), { color: colors.slate500 }]}>
                {t('contrat.b2cFiltered', { personality })}
              </Text>
              {/* États manquants (correction de comportement ASSUMÉE par le plan — doctrine
                  P0 « une source absente n'est jamais une collection vide ») : un carnet en
                  erreur réseau n'est plus indistinguable d'un carnet sans client pro. */}
              {customers.isPending ? (
                <View style={{ gap: 8 }}>
                  <SkeletonRow />
                  <SkeletonRow />
                  <SkeletonRow />
                </View>
              ) : customers.isError ? (
                <ErrorRetry
                  message={t('contrat.dataError', { personality })}
                  onRetry={() => void customers.refetch()}
                  retrying={customers.isRefetching}
                />
              ) : (
                professionalCustomers.map((customer) =>
                  pickRow(
                    customer.id,
                    customerId === customer.id,
                    customer.name,
                    customer.type === 'b2g' ? 'B2G' : 'B2B',
                    () => {
                      setError(null);
                      setCustomerId(customer.id);
                    },
                  ),
                )
              )}
              <Text style={[font('sub', 700), { color: colors.slate500, letterSpacing: 0.6, marginTop: 8 }]}>
                {t('contrat.siteLabel', { personality }).toUpperCase()}
              </Text>
              {chantiers.isPending ? (
                <View style={{ gap: 8 }}>
                  <SkeletonRow />
                  <SkeletonRow />
                </View>
              ) : chantiers.isError ? (
                <ErrorRetry
                  message={t('contrat.dataError', { personality })}
                  onRetry={() => void chantiers.refetch()}
                  retrying={chantiers.isRefetching}
                />
              ) : (
                <>
                  {pickRow(
                    'site-none',
                    chantierId === null,
                    t('pieceSite.none', { personality, params: { term: 'site' } }),
                    null,
                    () => setChantierId(null),
                  )}
                  {openSites.map((site) =>
                    pickRow(site.id, chantierId === site.id, site.name, null, () => {
                      setError(null);
                      setChantierId(site.id);
                    }),
                  )}
                </>
              )}
            </View>
          ) : null}

          {step === 1 ? (
            <View style={{ gap: 10 }}>
              {lines.map((line, index) => (
                <BobSurface key={index} tone="neutral" emphasis="raised" padding={12}>
                  <View style={{ gap: 8 }}>
                    {input({
                      value: line.label,
                      onChange: (value) =>
                        setLines((current) => current.map((l, i) => (i === index ? { ...l, label: value } : l))),
                      placeholder: t('contrat.lineLabelField', { personality }),
                    })}
                    <View style={{ flexDirection: 'row', gap: 8 }}>
                      {input({
                        value: line.qty,
                        onChange: (value) =>
                          setLines((current) => current.map((l, i) => (i === index ? { ...l, qty: value } : l))),
                        placeholder: t('contrat.lineQtyField', { personality }),
                        keyboardType: 'numeric',
                        flex: 1,
                      })}
                      {input({
                        value: line.unitPriceEur,
                        onChange: (value) =>
                          setLines((current) => current.map((l, i) => (i === index ? { ...l, unitPriceEur: value } : l))),
                        placeholder: t('contrat.linePriceField', { personality }),
                        keyboardType: 'numeric',
                        flex: 1,
                      })}
                      {input({
                        value: line.vatRate,
                        onChange: (value) =>
                          setLines((current) => current.map((l, i) => (i === index ? { ...l, vatRate: value } : l))),
                        placeholder: t('contrat.lineVatField', { personality }),
                        keyboardType: 'numeric',
                        flex: 1,
                      })}
                    </View>
                    {lines.length > 1 ? (
                      /* Lot 4 : le '✕' texte → DeleteIconButton kit (corbeille danger,
                         cible 44, press feedback) — un glyphe muet n'est pas un bouton. */
                      <View style={{ alignSelf: 'flex-end' }}>
                        <DeleteIconButton
                          icon={<TrashIcon color={semantic.danger} size={18} />}
                          accessibilityLabel={t('contrat.removeLineA11y', {
                            personality,
                            params: { label: line.label || String(index + 1) },
                          })}
                          onPress={() => setLines((current) => current.filter((_, i) => i !== index))}
                        />
                      </View>
                    ) : null}
                  </View>
                </BobSurface>
              ))}
              <Button
                title={t('contrat.addLineCta', { personality })}
                variant="secondary"
                onPress={() => setLines((current) => [...current, { ...EMPTY_LINE }])}
              />
              <Text style={[font('body', 700), { color: colors.ink800 }]}>
                {`${t('contrat.totalHtYear', { personality })} : ${formatEURWhole(totalHtCents)}`}
              </Text>
            </View>
          ) : null}

          {step === 2 ? (
            <View style={{ gap: 8 }}>
              {input({
                value: anniversaryDate,
                onChange: setAnniversaryDate,
                placeholder: t('contrat.anniversaryField', { personality }),
              })}
              <Text style={[font('sub', 500), { color: colors.slate500 }]}>
                {t('contrat.anniversaryHint', { personality })}
              </Text>
              <View style={{ flexDirection: 'row', gap: 8 }}>
                {input({
                  value: visitsPerYear,
                  onChange: setVisitsPerYear,
                  placeholder: t('contrat.visitsField', { personality }),
                  keyboardType: 'numeric',
                  flex: 1,
                })}
                {input({
                  value: noticeDays,
                  onChange: setNoticeDays,
                  placeholder: t('contrat.noticeField', { personality }),
                  keyboardType: 'numeric',
                  flex: 1,
                })}
              </View>
              <LegalHint
                label={t('legal.contractNotice.inline', { personality, params: { days: noticeDays || '30' } })}
                lawKey="legal.contractNotice.law"
                whyKey="legal.contractNotice.why"
                source="clause de préavis du contrat"
              />
              <View
                style={{ flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', minHeight: 44 }}
              >
                <Text style={[font('body', 600), { color: colors.ink800 }]}>
                  {t('contrat.tacitField', { personality })}
                </Text>
                {/* Lot 4 : Switch natif (vert plateforme hors tokens) → BobSwitch kit
                    (piste theme.ink — la sélection utilisateur, pas la récompense). */}
                <BobSwitch
                  value={tacitRenewal}
                  onValueChange={setTacitRenewal}
                  accessibilityLabel={t('contrat.tacitField', { personality })}
                />
              </View>
              {/* [Revue P13] contrat migré — saisie INCLUSIVE, convertie +1 j (erratum n° 4). */}
              <BobSurface tone="marine" emphasis="flat">
                <Text style={[font('body', 700), { color: colors.ink800 }]}>
                  {t('contrat.migratedTitle', { personality })}
                </Text>
                <View style={{ marginTop: 8 }}>
                  {input({
                    value: billedThroughInclusive,
                    onChange: setBilledThroughInclusive,
                    placeholder: t('contrat.migratedField', { personality }),
                  })}
                </View>
                <Text style={[font('sub', 500), { color: colors.slate500, marginTop: 6 }]}>
                  {t('contrat.migratedHint', { personality })}
                </Text>
              </BobSurface>
            </View>
          ) : null}

          {step === 3 ? (
            <BobSurface tone="neutral" emphasis="raised">
              <Text style={[font('cardTitle'), { color: colors.ink800 }]}>{label.trim()}</Text>
              <Text style={[font('body', 600), { color: colors.ink800, marginTop: 6 }]}>
                {professionalCustomers.find((customer) => customer.id === customerId)?.name ?? ''}
                {chantierId !== null
                  ? ` · ${openSites.find((site) => site.id === chantierId)?.name ?? ''}`
                  : ''}
              </Text>
              <Text style={[font('body', 600), { color: colors.ink800, marginTop: 6 }]}>
                {`${t('contrat.totalHtYear', { personality })} : ${formatEURWhole(totalHtCents)} · ${t(
                  'contrat.visitsPerYear',
                  { personality, params: { count: visitsPerYear } },
                )}`}
              </Text>
              {reviewPeriod !== null ? (
                <Text style={[font('sub', 600), { color: colors.slate500, marginTop: 6 }]}>
                  {t('contrat.reviewPeriod', {
                    personality,
                    params: {
                      start: frContractDate(reviewPeriod.start),
                      end: frContractDate(reviewPeriod.end),
                    },
                  })}
                </Text>
              ) : null}
              <Text style={[font('sub', 500), { color: colors.slate500, marginTop: 8 }]}>
                {t('contrat.activateHint', { personality })}
              </Text>
            </BobSurface>
          ) : null}
          </View>
          </FadeIn>

          {error ? (
            /* Lot 4 : l'erreur du wizard parle en DANGER avec role alert — un refus en
               slate chuchotait ce qui bloque la création. */
            <Text accessibilityRole="alert" style={[font('sub', 600), { color: semantic.danger }]}>
              {error}
            </Text>
          ) : null}

          <View style={{ flexDirection: 'row', gap: 8 }}>
            {step > 0 ? (
              <View style={{ flex: 1 }}>
                <Button
                  title={t('contrat.backCta', { personality })}
                  variant="secondary"
                  onPress={() => {
                    setError(null);
                    setStep((current) => Math.max(current - 1, 0));
                  }}
                />
              </View>
            ) : null}
            <View style={{ flex: 2 }}>
              {step < 3 ? (
                <Button title={t('contrat.nextCta', { personality })} onPress={next} />
              ) : (
                <Button
                  title={t('contrat.createDraftCta', { personality })}
                  loading={create.isPending}
                  onPress={() => void submit()}
                />
              )}
            </View>
          </View>
        </View>
      </ScrollView>
    </View>
  );
}
