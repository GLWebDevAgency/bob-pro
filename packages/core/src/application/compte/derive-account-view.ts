import { type CompanyProps, type VatRegime } from '../../domain/company/company';
import { tradeProfile, type ModuleKey, type TradeConfig } from '../../domain/company/trade-profile';
import {
  PAID_TIERS,
  PLAN_CATALOG,
  PLAN_PRICING,
  type PaidTier,
  type PlanTier,
} from '../../domain/subscription/plan';
import { type SubscriptionStatus } from '../../domain/subscription/subscription';
import { type SubscriptionStore } from '../ports/subscription-repository';

/**
 * Vue « Mon compte » (claim C26 v2) — dérivation PURE identité/entreprise/profil/abonnement → écran.
 *
 * Doctrine HONNÊTETÉ (le cœur du claim) : `subscription === null` signifie « aucune photographie
 * serveur disponible », jamais « accès anticipé ». L'accès anticipé n'est rendu que lorsqu'il est
 * explicitement persisté puis projeté par GET /subscription (`earlyAccess: true`, prix 0). JAMAIS
 * un plan payant « ACTIVE » inventé, jamais de factures d'abonnement fantômes. Les offres payantes
 * ne sont exposées que lorsque le serveur confirme que la facturation live est entièrement
 * configurée ; leurs CTA reflètent alors le canal réellement persisté (checkout, portail Stripe
 * ou gestion Apple/Google).
 */

// ── Entrées (projections minimales, nullables : l'absence est un état de premier rang) ──

export interface AccountIdentityData {
  firstName: string | null;
  companyName: string | null;
  legalLine: string | null;
}

/** Projection RÉELLE de GET /subscription. `null` = source indisponible, sans interprétation. */
export interface SubscriptionInfo {
  tier: PlanTier;
  status: SubscriptionStatus;
  /** Accès anticipé explicitement persisté côté serveur. */
  earlyAccess: boolean;
  /** Prix réellement projeté pour ce tenant, en centimes par mois. */
  priceCents: number;
  /** Canal de facturation persisté ; null avant toute liaison fournisseur. */
  store: SubscriptionStore | null;
  /** Vrai uniquement si le serveur a démarré avec toute la configuration paiement live. */
  billingAvailable: boolean;
  /** Fin de période courante (Instant ISO) — null si inconnue. */
  currentPeriodEnd: string | null;
}

export interface SubscriptionInvoiceInfo {
  stripeInvoiceId: string;
  status: 'draft' | 'open' | 'paid' | 'void' | 'uncollectible';
  currency: 'eur';
  number: string | null;
  totalCents: number;
  issuedAt: string;
  paidAt: string | null;
  hostedInvoiceUrl: string | null;
  invoicePdfUrl: string | null;
}

export interface DeriveAccountViewInput {
  identity: AccountIdentityData | null;
  company: CompanyProps | null;
  /** Profil métier réel (GET /profile) — modules actifs calculés PAR LE SERVEUR selon le tenant. */
  tradeConfig: TradeConfig | null;
  subscription: SubscriptionInfo | null;
  /** null = source indisponible ; [] = vraie réponse serveur vide. */
  subscriptionInvoices: readonly SubscriptionInvoiceInfo[] | null;
}

// ── Sortie ──

export interface AccountCompanyView {
  name: string;
  /** SIRET formaté à la française (3-3-3-5) : « 732 829 320 00074 ». */
  siretFormatted: string;
  /** « EI · Plombier » — forme juridique + libellé métier (TradeConfig serveur en priorité). */
  legalTradeLine: string;
  /** Régime TVA persisté uniquement — aucun taux n'est déduit du métier. */
  vatLine: string;
}

export type AccountConnectionKey = 'bank' | 'payment' | 'accountant';
/** 'to_connect' = le geste existe à terme mais rien n'est branché · 'upcoming' = pas encore de flux. */
export type AccountConnectionStatus = 'to_connect' | 'upcoming';

export interface AccountConnectionView {
  key: AccountConnectionKey;
  status: AccountConnectionStatus;
}

export type AccountServiceKey = 'online_payment' | 'invoice_advance' | 'insurance' | 'accountant';
export type AccountServiceStatus = 'active' | 'upcoming';

export interface AccountServiceView {
  key: AccountServiceKey;
  status: AccountServiceStatus;
}

export type AccountOfferView =
  | { kind: 'unavailable' }
  | { kind: 'early_access'; monthlyCents: 0 }
  | { kind: 'plan'; tier: PlanTier; label: string; monthlyCents: number; status: SubscriptionStatus };

export interface AccountPlanCardView {
  tier: PaidTier;
  label: string;
  monthlyCents: number;
  blurb: string;
  isCurrent: boolean;
  /** Action réellement disponible selon l'ouverture du billing et le canal persisté. */
  cta: 'checkout' | 'manage' | 'store' | 'current';
}

export interface AccountSubscriptionInvoiceView extends SubscriptionInvoiceInfo {
  id: string;
}

export interface AccountView {
  profile: {
    displayName: string | null;
    company: AccountCompanyView | null;
    connections: readonly AccountConnectionView[];
    /** Marqueur produit de la carte « Équipe & rôles » (badge BUSINESS du proto). */
    team: { requiredTier: PlanTier };
  };
  subscription: {
    offer: AccountOfferView;
    plans: readonly AccountPlanCardView[];
    invoices: readonly AccountSubscriptionInvoiceView[] | null;
    services: readonly AccountServiceView[];
  };
}

// ── Constantes produit ──

/** Libellés français des régimes de TVA (affichage fiche entreprise). */
export const VAT_REGIME_LABELS: Readonly<Record<VatRegime, string>> = {
  franchise: 'Franchise en base (293 B)',
  reel_simpl: 'Réel simplifié',
  reel_normal: 'Réel normal',
};

/**
 * Module TradeConfig qui matérialise chaque « service en plus » — AUCUN aujourd'hui (vérifié sur
 * ModuleKey : devis_factures, chantiers, acomptes, situations_travaux, retenue_garantie, cra,
 * frais_refactures, forfaits, abonnements, cession_droits — rien ne couvre paiement CB, avance,
 * assurance ni comptable). Conséquence honnête : tous les badges sont « À venir ». Le jour où un
 * module produit couvre un service, on le mappe ici et le badge devient « Actif » tout seul.
 */
export const ACCOUNT_SERVICE_MODULE: Readonly<Record<AccountServiceKey, ModuleKey | null>> = {
  online_payment: null,
  invoice_advance: null,
  insurance: null,
  accountant: null,
};

const ACCOUNT_SERVICE_KEYS: readonly AccountServiceKey[] = [
  'online_payment',
  'invoice_advance',
  'insurance',
  'accountant',
];

// ── Dérivations pures ──

/** « 73282932000074 » → « 732 829 320 00074 » (groupes 3-3-3-5). Entrée non conforme → inchangée. */
export function formatSiret(siret: string): string {
  const digits = siret.replace(/\s/g, '');
  if (!/^\d{14}$/.test(digits)) return siret;
  return `${digits.slice(0, 3)} ${digits.slice(3, 6)} ${digits.slice(6, 9)} ${digits.slice(9)}`;
}

/**
 * Statut d'un service dérivé du RÉEL : module actif dans le TradeConfig serveur, sinon « À venir ».
 * `moduleKey` null = aucun module produit ne couvre ce service → jamais « Actif » (honnêteté).
 */
export function deriveServiceStatus(
  moduleKey: ModuleKey | null,
  tradeConfig: TradeConfig | null,
): AccountServiceStatus {
  if (moduleKey === null || tradeConfig === null) return 'upcoming';
  return tradeConfig.modules.some((m) => m.key === moduleKey && m.active) ? 'active' : 'upcoming';
}

function deriveCompany(
  company: CompanyProps | null,
  tradeConfig: TradeConfig | null,
): AccountCompanyView | null {
  if (company === null) return null; // jamais une fiche inventée : l'écran affiche l'état vide.
  const tradeLabel = tradeConfig?.label ?? tradeProfile(company.trade).label;
  const regimeLabel = VAT_REGIME_LABELS[company.vatRegime];
  // Le régime vient de la fiche société persistée. Le métier ne permet jamais de
  // déduire un taux : il dépend de la prestation, du client et de son contexte fiscal.
  const vatLine = regimeLabel;
  return {
    name: company.name,
    siretFormatted: formatSiret(company.siret),
    legalTradeLine: `${company.legalForm} · ${tradeLabel}`,
    vatLine,
  };
}

function deriveOffer(subscription: SubscriptionInfo | null): AccountOfferView {
  if (subscription === null) return { kind: 'unavailable' };
  if (subscription.earlyAccess) {
    return { kind: 'early_access', monthlyCents: 0 };
  }
  const plan = PLAN_CATALOG[subscription.tier];
  return {
    kind: 'plan',
    tier: subscription.tier,
    label: plan.label,
    monthlyCents: subscription.priceCents,
    status: subscription.status,
  };
}

function derivePlans(subscription: SubscriptionInfo | null): AccountPlanCardView[] {
  if (subscription === null || !subscription.billingAvailable) return [];
  const currentTier =
    subscription !== null && !subscription.earlyAccess && subscription.status !== 'canceled'
      ? subscription.tier
      : null;
  return PAID_TIERS.map((tier) => {
    const entry = PLAN_PRICING[tier];
    const isCurrent = currentTier === tier;
    return {
      tier,
      label: entry.label,
      monthlyCents: entry.monthlyCents,
      blurb: entry.blurb,
      isCurrent,
      cta:
        subscription.store === 'stripe'
          ? 'manage'
          : subscription.store === 'apple' || subscription.store === 'google'
            ? 'store'
            : isCurrent
              ? 'current'
              : 'checkout',
    };
  });
}

export function deriveAccountView(input: DeriveAccountViewInput): AccountView {
  const { identity, company, tradeConfig, subscription, subscriptionInvoices } = input;
  return {
    profile: {
      displayName: identity?.firstName ?? identity?.companyName ?? null,
      company: deriveCompany(company, tradeConfig),
      connections: [
        // Aucun bridge bancaire n'existe : « À connecter », jamais « Connectée ».
        { key: 'bank', status: 'to_connect' },
        // Pas d'onboarding paiement ni de flux d'invitation comptable : « À venir ».
        { key: 'payment', status: 'upcoming' },
        { key: 'accountant', status: 'upcoming' },
      ],
      team: { requiredTier: 'business' },
    },
    subscription: {
      offer: deriveOffer(subscription),
      plans: derivePlans(subscription),
      invoices:
        subscriptionInvoices === null
          ? null
          : subscriptionInvoices.map((invoice) => ({ ...invoice, id: invoice.stripeInvoiceId })),
      services: ACCOUNT_SERVICE_KEYS.map((key) => ({
        key,
        status: deriveServiceStatus(ACCOUNT_SERVICE_MODULE[key], tradeConfig),
      })),
    },
  };
}
