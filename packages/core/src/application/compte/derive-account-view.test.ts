import { describe, it, expect } from 'vitest';
import { resolveTradeConfig } from '../../domain/company/trade-profile';
import { PAID_TIERS, PLAN_CATALOG, PLAN_PRICING } from '../../domain/subscription/plan';
import { type CompanyProps } from '../../domain/company/company';
import {
  ACCOUNT_SERVICE_MODULE,
  deriveAccountView,
  deriveServiceStatus,
  formatSiret,
  type SubscriptionInfo,
} from './derive-account-view';

const mercierLike: CompanyProps = {
  id: 'company-1',
  name: 'Mercier Plomberie',
  legalForm: 'EI',
  siren: '732829320',
  siret: '73282932000074',
  trade: 'plombier',
  vatRegime: 'reel_simpl',
  address: { line1: '12 rue des Artisans', zip: '92000', city: 'Nanterre' },
};

const plombierBusiness = resolveTradeConfig('plombier', 'business');

const emptyInput = { identity: null, company: null, tradeConfig: null, subscription: null };

describe('application/compte/deriveAccountView (C26 — doctrine honnêteté)', () => {
  it('subscription null → accès anticipé 0 €/mois, JAMAIS un plan payant « actif » inventé', () => {
    const view = deriveAccountView({ ...emptyInput, tradeConfig: plombierBusiness });
    expect(view.subscription.offer).toEqual({ kind: 'early_access', monthlyCents: 0 });
    for (const plan of view.subscription.plans) {
      expect(plan.isCurrent).toBe(false);
      expect(plan.cta).toBe('preview'); // aucun CTA ne prétend souscrire
    }
  });

  it('grille = constante produit PLAN_PRICING (Solo 19 / Pro 39 / Business 79, source PLAN_CATALOG)', () => {
    const view = deriveAccountView(emptyInput);
    expect(view.subscription.plans.map((p) => p.tier)).toEqual([...PAID_TIERS]);
    expect(view.subscription.plans.map((p) => p.monthlyCents)).toEqual([1900, 3900, 7900]);
    for (const plan of view.subscription.plans) {
      expect(plan.label).toBe(PLAN_CATALOG[plan.tier].label);
      expect(plan.monthlyCents).toBe(PLAN_PRICING[plan.tier].monthlyCents);
      expect(plan.blurb).toBe(PLAN_PRICING[plan.tier].blurb);
    }
  });

  it("factures d'abonnement = état vide honnête (rien n'est facturé pendant l'accès anticipé)", () => {
    expect(deriveAccountView(emptyInput).subscription.invoices).toEqual([]);
  });

  it('badge service dérivé du module TradeConfig : actif ↔ module actif, sinon « À venir »', () => {
    // Mécanisme : un module ACTIF du profil serveur active le badge…
    expect(deriveServiceStatus('acomptes', plombierBusiness)).toBe('active');
    // …un module présent mais NON débloqué au palier ne l'active pas…
    const plombierFree = resolveTradeConfig('plombier', 'free');
    expect(deriveServiceStatus('situations_travaux', plombierFree)).toBe('upcoming');
    // …et sans mapping ou sans profil, jamais « Actif ».
    expect(deriveServiceStatus(null, plombierBusiness)).toBe('upcoming');
    expect(deriveServiceStatus('acomptes', null)).toBe('upcoming');
  });

  it('aujourd’hui AUCUN module produit ne couvre un service → tous « À venir », même profil complet', () => {
    // Honnêteté : le mapping produit est vide tant que rien de réel ne matérialise ces services.
    expect(Object.values(ACCOUNT_SERVICE_MODULE).every((m) => m === null)).toBe(true);
    const view = deriveAccountView({ ...emptyInput, tradeConfig: plombierBusiness });
    expect(view.subscription.services.map((s) => s.key)).toEqual([
      'online_payment',
      'invoice_advance',
      'insurance',
      'accountant',
    ]);
    for (const service of view.subscription.services) expect(service.status).toBe('upcoming');
  });

  it('connexions honnêtes : banque « à connecter » (aucun bridge), paiement/comptable « à venir »', () => {
    const view = deriveAccountView(emptyInput);
    expect(view.profile.connections).toEqual([
      { key: 'bank', status: 'to_connect' },
      { key: 'payment', status: 'upcoming' },
      { key: 'accountant', status: 'upcoming' },
    ]);
    expect(view.profile.team.requiredTier).toBe('business');
  });

  it('fiche entreprise : SIRET, forme, métier et régime réel sans taux inventé', () => {
    const view = deriveAccountView({
      ...emptyInput,
      company: mercierLike,
      tradeConfig: plombierBusiness,
    });
    expect(view.profile.company).toEqual({
      name: 'Mercier Plomberie',
      siretFormatted: '732 829 320 00074',
      legalTradeLine: 'EI · Plombier',
      vatLine: 'Réel simplifié',
    });
  });

  it('franchise 293 B : régime affiché SANS taux (on ne facture pas la TVA)', () => {
    const view = deriveAccountView({
      ...emptyInput,
      company: { ...mercierLike, vatRegime: 'franchise' },
      tradeConfig: plombierBusiness,
    });
    expect(view.profile.company?.vatLine).toBe('Franchise en base (293 B)');
  });

  it('company null → fiche null (jamais inventée) ; identité null → displayName null', () => {
    const view = deriveAccountView(emptyInput);
    expect(view.profile.company).toBeNull();
    expect(view.profile.displayName).toBeNull();
  });

  it('identité : prénom en priorité, sinon raison sociale', () => {
    const withFirst = deriveAccountView({
      ...emptyInput,
      identity: { firstName: 'Julien', companyName: 'Mercier Plomberie', legalLine: null },
    });
    expect(withFirst.profile.displayName).toBe('Julien');
    const companyOnly = deriveAccountView({
      ...emptyInput,
      identity: { firstName: null, companyName: 'Mercier Plomberie', legalLine: null },
    });
    expect(companyOnly.profile.displayName).toBe('Mercier Plomberie');
  });

  it('C26b (futur) : SubscriptionInfo réel → offre du serveur, palier courant marqué, autres en preview', () => {
    const sub: SubscriptionInfo = { tier: 'pro', status: 'active', currentPeriodEnd: null };
    const view = deriveAccountView({ ...emptyInput, subscription: sub });
    expect(view.subscription.offer).toEqual({
      kind: 'plan',
      tier: 'pro',
      label: 'Pro',
      monthlyCents: 3900,
      status: 'active',
    });
    const pro = view.subscription.plans.find((p) => p.tier === 'pro');
    expect(pro?.isCurrent).toBe(true);
    expect(pro?.cta).toBe('current');
    for (const other of view.subscription.plans.filter((p) => p.tier !== 'pro')) {
      expect(other.cta).toBe('preview'); // pas de billing → pas de bouton « changer »
    }
  });

  it('abonnement résilié → retour à la vérité accès anticipé (pas de plan fantôme)', () => {
    const sub: SubscriptionInfo = { tier: 'business', status: 'canceled', currentPeriodEnd: null };
    const view = deriveAccountView({ ...emptyInput, subscription: sub });
    expect(view.subscription.offer.kind).toBe('early_access');
    expect(view.subscription.plans.every((p) => !p.isCurrent)).toBe(true);
  });

  it('formatSiret : 14 chiffres → 3-3-3-5 ; entrée non conforme inchangée', () => {
    expect(formatSiret('73282932000074')).toBe('732 829 320 00074');
    expect(formatSiret('732 829 320 00074')).toBe('732 829 320 00074');
    expect(formatSiret('123')).toBe('123');
  });
});
