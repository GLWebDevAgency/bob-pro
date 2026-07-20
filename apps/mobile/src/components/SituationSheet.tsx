/**
 * B2 — Feuille premium « Facturer une situation » (devis SIGNÉ). La base est 100 % RÉELLE :
 * marché HT net du devis, cumul déjà facturé (acompte + situations non annulées — mêmes pièces
 * que la frise du détail), reste facturable. Le % se règle aux steppers (±5 grossier, ±1 fin),
 * le montant HT dérivé s'affiche LIVE en MoneyText, la garde du cumul reste au SERVEUR
 * (l'écran ne propose qu'un % atteignable — jamais un 422 fabriqué). Chaque confirmation crée
 * UNE NOUVELLE situation (n° d'ordre suivant) en BROUILLON, émise ensuite sur /facture/[id].
 */
import { useEffect, useMemo, useState } from 'react';
import { Alert, Pressable, Text, View } from 'react-native';
import { router } from 'expo-router';
import { formatEUR } from '@bob/core';
import type { QuoteView } from '@bob/api-client';
import { t } from '@bob/i18n';
import { Button, MoneyText, Sheet, font, useTheme } from '@bob/ui';
import { appErrorMessage, useGenerateInvoice, useInvoices } from '../data/hooks';
import { CheckIcon } from './icons';
import {
  defaultSituationPercent,
  derivePostesFromQuote,
  deriveSituationBasis,
  situationAmountFromPercent,
  situationPercentFromPostes,
  stepSituationPercent,
} from './situation-invoice.logic';

/** Bouton ± compact (44 pt réels) des steppers du pourcentage. */
function StepButton({
  label,
  onPress,
  disabled,
  accessibilityLabel,
}: {
  label: string;
  onPress: () => void;
  disabled: boolean;
  accessibilityLabel: string;
}) {
  const { colors, controls } = useTheme();
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={accessibilityLabel}
      accessibilityState={{ disabled }}
      disabled={disabled}
      onPress={onPress}
      style={({ pressed }) => ({
        minWidth: 48,
        minHeight: 44,
        borderRadius: 12,
        borderWidth: 1,
        borderColor: controls.cardBorder,
        backgroundColor: pressed ? colors.lineSoft : colors.surface,
        alignItems: 'center',
        justifyContent: 'center',
        opacity: disabled ? 0.35 : 1,
        transform: [{ scale: pressed && !disabled ? 0.96 : 1 }],
      })}
    >
      <Text style={[font('body', 700), { color: colors.ink800 }]}>{label}</Text>
    </Pressable>
  );
}

export function SituationSheet({
  visible,
  quote,
  onClose,
}: {
  visible: boolean;
  quote: QuoteView;
  onClose: () => void;
}) {
  const { colors, semantic, personality, controls } = useTheme();
  const invoices = useInvoices();
  const generate = useGenerateInvoice();

  // Base RÉELLE : pièces sœurs du devis (liste déjà en cache — mêmes données que la frise).
  const basis = useMemo(
    () =>
      deriveSituationBasis(
        quote.totals.ht,
        (invoices.data ?? []).filter((invoice) => invoice.parentQuoteId === quote.id),
      ),
    [invoices.data, quote.id, quote.totals.ht],
  );

  const [percent, setPercent] = useState(0);
  // B2 — « proposition par tâches » : les POSTES du devis, quote-parts exactes du marché.
  const [checkedPostes, setCheckedPostes] = useState<ReadonlySet<string>>(new Set());
  const postes = useMemo(
    () => derivePostesFromQuote(quote.lines, basis.marketHtCents),
    [quote.lines, basis.marketHtCents],
  );
  const proposedFromPostes = situationPercentFromPostes(basis, postes, checkedPostes);
  // À chaque OUVERTURE : proposition honnête recalculée depuis la base réelle du moment.
  useEffect(() => {
    if (visible) {
      setPercent(defaultSituationPercent(basis));
      setCheckedPostes(new Set());
    }
    // La base est volontairement relue à l'ouverture uniquement : un refetch pendant le réglage
    // ne doit pas voler le % choisi sous le doigt de l'artisan.
  }, [visible]);

  /** Cocher un poste PROPOSE le % (avancement cumulé − déjà facturé) — jamais imposé :
   *  les steppers restent maîtres, et une sélection déjà couverte s'explique sans forcer. */
  const togglePoste = (posteId: string): void => {
    if (generate.isPending) return;
    const next = new Set(checkedPostes);
    if (next.has(posteId)) next.delete(posteId);
    else next.add(posteId);
    setCheckedPostes(next);
    const proposed = situationPercentFromPostes(basis, postes, next);
    if (next.size > 0 && proposed > 0) setPercent(proposed);
  };

  const clamped = Math.min(Math.max(percent, basis.canInvoice ? 1 : 0), basis.maxPercent);
  const amountCents = situationAmountFromPercent(basis.marketHtCents, clamped);
  const step = (delta: number): void =>
    setPercent((current) => stepSituationPercent(current, delta, basis.maxPercent));

  const submit = async (): Promise<void> => {
    if (generate.isPending || !basis.canInvoice || clamped <= 0) return;
    try {
      const out = await generate.mutateAsync({
        quoteId: quote.id,
        mode: 'situation',
        situation: { percent: clamped },
      });
      onClose();
      router.push(`/facture/${out.invoiceId}`);
    } catch (error) {
      // La garde du cumul (« Cumul… reste facturable N c ») et toute autre erreur serveur
      // s'affichent TELLES QUELLES — jamais un montant réinterprété côté écran.
      Alert.alert('Oups', appErrorMessage(error));
    }
  };

  return (
    <Sheet
      visible={visible}
      onClose={() => {
        if (!generate.isPending) onClose();
      }}
      accessibilityLabel={t('situation.sheetTitle', { personality })}
    >
      <Text
        accessibilityRole="header"
        style={[font('cardTitle'), { color: colors.ink900, lineHeight: 22 }]}
      >
        {t('situation.sheetTitle', { personality })}
        {quote.number ? `  ·  ${quote.number}` : ''}
      </Text>

      {/* Frise du marché déjà facturé — même matière que la frise d'avancement du détail. */}
      <View style={{ marginTop: 14 }}>
        <Text style={[font('meta', 600), { fontSize: 12, color: colors.slate400 }]}>
          {t('situation.progressLabel', { personality }).toUpperCase()}
        </Text>
        <View
          accessibilityRole="progressbar"
          accessibilityValue={{ min: 0, max: 100, now: basis.invoicedPct }}
          style={{
            height: 8,
            borderRadius: 999,
            backgroundColor: colors.lineSoft,
            marginTop: 8,
            overflow: 'hidden',
            flexDirection: 'row',
          }}
        >
          <View
            style={{
              width: `${basis.invoicedPct}%`,
              backgroundColor: semantic.success,
              borderRadius: 999,
            }}
          />
          <View
            style={{
              width: `${Math.min(clamped, 100 - basis.invoicedPct)}%`,
              backgroundColor: semantic.ai,
              borderRadius: 999,
            }}
          />
        </View>
        <View style={{ flexDirection: 'row', justifyContent: 'space-between', marginTop: 6 }}>
          <Text style={[font('meta', 500), { fontSize: 12, color: colors.slate500, flexShrink: 1 }]}>
            {t('situation.alreadyInvoiced', {
              personality,
              params: { amount: formatEUR(basis.invoicedHtCents), pct: basis.invoicedPct },
            })}
          </Text>
          <Text style={[font('meta', 600), { fontSize: 12, color: colors.ink800 }]}>
            {t('situation.remaining', {
              personality,
              params: { amount: formatEUR(basis.remainingHtCents) },
            })}
          </Text>
        </View>
      </View>

      {basis.canInvoice ? (
        <>
          {/* Réglage du % : steppers grossiers/fins, % héros au centre. */}
          <View
            style={{
              flexDirection: 'row',
              alignItems: 'center',
              justifyContent: 'space-between',
              marginTop: 18,
            }}
          >
            <StepButton
              label="−5"
              accessibilityLabel="Moins cinq pour cent"
              disabled={clamped <= 1 || generate.isPending}
              onPress={() => step(-5)}
            />
            <StepButton
              label="−1"
              accessibilityLabel="Moins un pour cent"
              disabled={clamped <= 1 || generate.isPending}
              onPress={() => step(-1)}
            />
            <View style={{ alignItems: 'center', minWidth: 92 }}>
              <Text
                style={[
                  font('bigNum'),
                  { fontSize: 34, color: colors.ink900, fontVariant: ['tabular-nums'] },
                ]}
              >
                {clamped} %
              </Text>
              <Text style={[font('meta', 500), { fontSize: 11.5, color: colors.slate400 }]}>
                {t('situation.pctLabel', { personality, params: { pct: clamped } })}
              </Text>
            </View>
            <StepButton
              label="+1"
              accessibilityLabel="Plus un pour cent"
              disabled={clamped >= basis.maxPercent || generate.isPending}
              onPress={() => step(1)}
            />
            <StepButton
              label="+5"
              accessibilityLabel="Plus cinq pour cent"
              disabled={clamped >= basis.maxPercent || generate.isPending}
              onPress={() => step(5)}
            />
          </View>

          {/* B2 — proposition PAR POSTES : coche les postes terminés du devis, Bob traduit en %
              (avancement cumulé − déjà facturé). Consultatif — les steppers restent maîtres. */}
          {postes.length > 0 ? (
            <View style={{ marginTop: 16 }}>
              <Text style={[font('meta', 600), { fontSize: 12, color: colors.slate400 }]}>
                {t('situation.tasksTitle', { personality }).toUpperCase()}
              </Text>
              <Text style={[font('meta', 500), { fontSize: 12, color: colors.slate400, marginTop: 3 }]}>
                {t('situation.tasksHint', { personality })}
              </Text>
              <View
                style={{
                  marginTop: 8,
                  borderRadius: 14,
                  borderWidth: 1,
                  borderColor: controls.cardBorder,
                  overflow: 'hidden',
                }}
              >
                {postes.map((poste, index) => {
                  const checked = checkedPostes.has(poste.id);
                  return (
                    <Pressable
                      key={poste.id}
                      accessibilityRole="checkbox"
                      accessibilityLabel={poste.label}
                      accessibilityState={{ checked, disabled: generate.isPending }}
                      disabled={generate.isPending}
                      onPress={() => togglePoste(poste.id)}
                      style={({ pressed }) => ({
                        flexDirection: 'row',
                        alignItems: 'center',
                        gap: 10,
                        minHeight: 48,
                        paddingHorizontal: 13,
                        paddingVertical: 9,
                        backgroundColor: pressed
                          ? colors.lineSoft
                          : checked
                            ? semantic.successBg
                            : colors.surface,
                        borderTopWidth: index === 0 ? 0 : 1,
                        borderTopColor: colors.lineSoft,
                      })}
                    >
                      {/* Case à cocher : vide → pleine success (le poste est TERMINÉ). */}
                      <View
                        style={{
                          width: 22,
                          height: 22,
                          borderRadius: 7,
                          borderWidth: 1.5,
                          borderColor: checked ? semantic.success : controls.cardBorder,
                          backgroundColor: checked ? semantic.success : 'transparent',
                          alignItems: 'center',
                          justifyContent: 'center',
                        }}
                      >
                        {checked ? <CheckIcon color={colors.surface} size={13} strokeWidth={3} /> : null}
                      </View>
                      <Text
                        numberOfLines={1}
                        style={[font('sub', checked ? 600 : 500), { flex: 1, color: colors.ink800 }]}
                      >
                        {poste.label}
                      </Text>
                      <Text
                        style={[
                          font('meta', 600),
                          { fontSize: 12.5, color: colors.slate500, fontVariant: ['tabular-nums'] },
                        ]}
                      >
                        {formatEUR(poste.amountHtCents)}
                      </Text>
                    </Pressable>
                  );
                })}
              </View>
              {checkedPostes.size > 0 ? (
                <Text
                  accessibilityLiveRegion="polite"
                  style={[
                    font('meta', 500),
                    {
                      fontSize: 12,
                      color: proposedFromPostes > 0 ? semantic.success : semantic.warning,
                      marginTop: 6,
                    },
                  ]}
                >
                  {proposedFromPostes > 0
                    ? t('situation.tasksApplied', {
                        personality,
                        params: { pct: proposedFromPostes },
                      })
                    : t('situation.tasksAllBilled', { personality })}
                </Text>
              ) : null}
            </View>
          ) : null}

          {/* Montant dérivé LIVE — le chiffre est le héros (tabular-nums MoneyText). */}
          <View
            style={{
              marginTop: 16,
              borderRadius: 14,
              borderWidth: 1,
              borderColor: controls.cardBorder,
              backgroundColor: colors.bg,
              paddingVertical: 13,
              paddingHorizontal: 16,
              flexDirection: 'row',
              alignItems: 'center',
              justifyContent: 'space-between',
            }}
          >
            <Text style={[font('sub'), { color: colors.slate500 }]}>
              {t('situation.amountDerived', { personality })}
            </Text>
            <MoneyText cents={amountCents} variant="big" />
          </View>

          {clamped >= basis.maxPercent ? (
            <Text
              accessibilityLiveRegion="polite"
              style={[font('meta', 500), { fontSize: 12, color: semantic.warning, marginTop: 8 }]}
            >
              {t('situation.overGuard', {
                personality,
                params: { amount: formatEUR(basis.remainingHtCents) },
              })}
            </Text>
          ) : null}

          <Button
            title={t('situation.confirmCta', {
              personality,
              params: { amount: formatEUR(amountCents) },
            })}
            loading={generate.isPending}
            disabled={generate.isPending || clamped <= 0}
            style={{ marginTop: 16 }}
            onPress={() => void submit()}
          />
          <Text style={[font('meta', 500), { fontSize: 12, color: colors.slate400, marginTop: 8 }]}>
            {t('situation.confirmBody', {
              personality,
              params: {
                pct: clamped,
                amount: formatEUR(amountCents),
                number: quote.number ?? '—',
              },
            })}
          </Text>
        </>
      ) : (
        <View
          style={{
            marginTop: 16,
            borderRadius: 14,
            backgroundColor: semantic.successBg,
            paddingVertical: 13,
            paddingHorizontal: 16,
          }}
        >
          <Text style={[font('sub', 600), { color: semantic.success }]}>
            {t('situation.noRemaining', { personality })}
          </Text>
        </View>
      )}
    </Sheet>
  );
}
