/**
 * FONDATION PAYWALL MOBILE (SPEC_PILIER2_MONETISATION.md) — un seul chemin de vérité pour
 * tous les écrans : le hook d'entitlement TYPÉ (fini les `.includes('str')` épars, une typo
 * dé-gatait silencieusement) et la carte paywall contextuelle pilotée par le DOMAINE
 * (`decidePaywall` @bob/core) + la gouvernance de pression (sourdine locale persistée).
 *
 * Doctrine : jamais d'interruption mid-action (la carte remplace le contenu verrouillé,
 * elle ne surgit pas) ; UN CTA (le déblocage le moins cher) ; le « non » est tenu
 * (2 rejets même source → 14 j de silence, promesse écrite sous le bouton).
 */
import React, { useCallback, useMemo } from 'react';
import { Text, View } from 'react-native';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { useRouter } from 'expo-router';
import {
  decidePaywall,
  decideReactivePaywallPressure,
  PLAN_CATALOG,
  type AddOn,
  type Feature,
  type PaywallDecision,
  type PaywallPressureHistory,
  type PlanTier,
  type SubscriptionStatus,
} from '@bob/core';
import { t, type Personality } from '@bob/i18n';
import { Button, Card } from '@bob/ui';
import { useTheme } from '@bob/ui';
import { useSubscription } from '../data/hooks';

/** Source du paywall — reprise du contrat analytics (@bob/core PaywallSource). */
export type PaywallSurfaceSource =
  | 'voice_live_tap'
  | 'feature_screen'
  | 'plans_screen'
  | 'trial_ending'
  | 'quota_reached';

export interface Entitlement {
  /** Vrai si la capacité est OUVERTE (serveur fait foi via GET /subscription). */
  readonly allowed: boolean;
  /** Décision de déblocage quand allowed=false — null pendant le chargement. */
  readonly decision: PaywallDecision | null;
  /** Chargement en cours : les écrans affichent leur squelette, JAMAIS le paywall
   *  (politique fail-open d'affichage : on ne vend pas sur un écran pas encore sûr). */
  readonly loading: boolean;
}

/** LE hook d'entitlement typé — remplace les `(sub?.features ?? []).includes('x')` épars. */
export function useEntitlement(feature: Feature): Entitlement {
  const subscription = useSubscription();
  return useMemo(() => {
    const view = subscription.data;
    if (view === undefined) return { allowed: false, decision: null, loading: true };
    const tier = (view.tier as PlanTier | undefined) ?? 'free';
    const status = (view.status as SubscriptionStatus | undefined) ?? 'active';
    const addOns = (view.addOns ?? []) as AddOn[];
    if (view.features.includes(feature)) return { allowed: true, decision: null, loading: false };
    const decision = decidePaywall({ feature, tier, addOns, status });
    return { allowed: decision.kind === 'allowed', decision, loading: false };
  }, [subscription.data, feature]);
}

// ── Gouvernance de pression : mémoire LOCALE des rejets, par source ──
const PRESSURE_KEY = (source: string) => `bob.paywall.pressure.${source}`;

interface StoredPressure {
  dismissals: number;
  lastDismissedAt: string | null;
}

async function readPressure(source: string): Promise<StoredPressure> {
  try {
    const raw = await AsyncStorage.getItem(PRESSURE_KEY(source));
    if (raw === null) return { dismissals: 0, lastDismissedAt: null };
    return JSON.parse(raw) as StoredPressure;
  } catch {
    return { dismissals: 0, lastDismissedAt: null };
  }
}

export async function recordPaywallDismissal(source: PaywallSurfaceSource): Promise<void> {
  const current = await readPressure(source);
  const next: StoredPressure = {
    dismissals: current.dismissals + 1,
    lastDismissedAt: new Date().toISOString(),
  };
  try {
    await AsyncStorage.setItem(PRESSURE_KEY(source), JSON.stringify(next));
  } catch {
    // La gouvernance de pression ne casse jamais l'app — au pire on remontre.
  }
}

/** Vrai si la sourdine s'applique (2 rejets même source < 14 j) — décision DOMAINE. */
export async function isPaywallMuted(source: PaywallSurfaceSource): Promise<boolean> {
  const stored = await readPressure(source);
  const history: PaywallPressureHistory = {
    dismissalsForSource: stored.dismissals,
    lastDismissedAt: stored.lastDismissedAt,
    lastVoiceRefusalAt: null, // le refus vocal vit côté session agent (segment suivant)
    lastProactiveUpsellAt: null,
  };
  return decideReactivePaywallPressure(history, new Date().toISOString()).kind === 'muted';
}

const euros = (cents: number): string =>
  `${(cents / 100).toLocaleString('fr-FR', { maximumFractionDigits: cents % 100 === 0 ? 0 : 2 })} €`;

/**
 * Carte paywall CONTEXTUELLE — remplace le contenu verrouillé (jamais une pop-up surprise).
 * Un seul CTA (le chemin le moins cher décidé par le domaine), la promesse de silence écrite.
 */
export function PaywallCard(props: {
  readonly decision: PaywallDecision;
  readonly source: PaywallSurfaceSource;
  readonly personality: Personality;
  /** Accroche contextuelle optionnelle (ex. teaser Bob Live) — sinon le titre générique. */
  readonly teaser?: string;
  readonly onDismissed?: () => void;
}): React.JSX.Element | null {
  const { decision, source, personality } = props;
  const { colors } = useTheme();
  const router = useRouter();

  const dismiss = useCallback((): void => {
    void recordPaywallDismissal(source);
    props.onDismissed?.();
  }, [props, source]);

  if (decision.kind === 'allowed' || decision.kind === 'unavailable') return null;

  const tierLabel = (tier: PlanTier): string => PLAN_CATALOG[tier].label;

  let title: string;
  let body: string | null = null;
  let cta: string | null = null;
  if (decision.kind === 'past_due') {
    title = t('paywall.pastDueTitle', { personality });
    body = t('paywall.pastDueBody', { personality });
    cta = null; // le portail de facturation vit sur /compte — CTA unique ci-dessous
  } else if (decision.kind === 'upgrade') {
    title =
      props.teaser ??
      t('paywall.title', { personality, params: { tier: tierLabel(decision.requiredTier) } });
    body =
      decision.monthlyDeltaCents > 0
        ? t('paywall.deltaAnchor', { personality, params: { delta: euros(decision.monthlyDeltaCents) } })
        : null;
    cta = t('paywall.upgradeCta', {
      personality,
      params: { tier: tierLabel(decision.requiredTier), price: euros(decision.requiredMonthlyCents) },
    });
  } else {
    title = props.teaser ?? t('paywall.title', { personality, params: { tier: '' } });
    cta = t('paywall.addonCta', {
      personality,
      params: { feature: decision.addOn, price: euros(decision.monthlyPriceCents) },
    });
  }

  return (
    <Card>
      <Text style={{ fontSize: 16, fontWeight: '700', color: colors.ink900 }}>{title}</Text>
      {body !== null ? (
        <Text style={{ fontSize: 13, color: colors.slate500, marginTop: 6, lineHeight: 19 }}>{body}</Text>
      ) : null}
      <View style={{ height: 12 }} />
      <Button
        title={cta ?? t('paywall.upgradeCta', { personality, params: { tier: 'Pro', price: euros(3900) } })}
        variant="primary"
        onPress={() => router.push('/compte')}
      />
      <View style={{ height: 8 }} />
      <Button title={t('paywall.dismiss', { personality })} variant="secondary" onPress={dismiss} />
      <Text style={{ fontSize: 11, color: colors.slate500, marginTop: 8 }}>
        {t('paywall.dismissPromise', { personality })}
      </Text>
    </Card>
  );
}
