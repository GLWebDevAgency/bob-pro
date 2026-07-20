import { describe, expect, it } from 'vitest';
import {
  addLine,
  buildComposePayload,
  guardAdvance,
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
  type FactureDirecteCustomer,
  type FactureDirecteState,
} from './facture-directe-model';
import type { LineInput } from '@bob/core';

const B2B: FactureDirecteCustomer = { id: 'c1', name: 'Syndic Azur', type: 'b2b', isInternational: false };
const B2C: FactureDirecteCustomer = { id: 'c2', name: 'Mme Diallo', type: 'b2c', isInternational: false };
const INTL_PRO: FactureDirecteCustomer = { id: 'c3', name: 'GmbH Bau', type: 'b2b', isInternational: true };
const INTL_B2C: FactureDirecteCustomer = { id: 'c4', name: 'M. Rossi', type: 'b2c', isInternational: true };

const LINE: LineInput = { label: 'Dépannage fuite', category: 'labor', qty: 2, unitPriceHT: 6_000, vatRate: 10 };

function readyState(customer: FactureDirecteCustomer = B2B): FactureDirecteState {
  let state = selectCustomer(startFactureDirecte(), customer);
  if (customer.type === 'b2c') state = setUrgentOnSiteRepair(state, true);
  const advanced = nextStep(state);
  if (!advanced.ok) throw new Error(`garde client inattendue: ${advanced.error.code}`);
  state = setVat(advanced.value, 10, { housingOlderThan2y: true, energyRenovation: false });
  const withLine = addLine(state, LINE);
  if (!withLine.ok) throw new Error('ajout de ligne inattendu');
  return withLine.value;
}

describe('facture-directe-model — machine du wizard allégé (B1)', () => {
  it('démarre vierge à l’étape client, sans urgence déduite', () => {
    const state = startFactureDirecte();
    expect(state.step).toBe('client');
    expect(state.urgentOnSiteRepair).toBeNull();
    expect(guardAdvance(state)).toEqual({ ok: false, error: { code: 'customer_required' } });
  });

  it('B7 — bloque un professionnel étranger (fail-closed, jamais une TVA française fausse)', () => {
    expect(isInternationalProBlocked(INTL_PRO)).toBe(true);
    expect(isInternationalProBlocked(INTL_B2C)).toBe(false); // le B2C étranger n’est pas visé
    expect(isInternationalProBlocked(B2B)).toBe(false);
    const state = selectCustomer(startFactureDirecte(), INTL_PRO);
    expect(nextStep(state)).toEqual({ ok: false, error: { code: 'international_pro_blocked' } });
    expect(buildComposePayload({ ...readyState(), customer: INTL_PRO })).toBeNull();
  });

  it('A3bis — particulier : la question d’urgence est OBLIGATOIRE, « non » bloque honnêtement', () => {
    const state = selectCustomer(startFactureDirecte(), B2C);
    expect(nextStep(state)).toEqual({ ok: false, error: { code: 'urgent_answer_required' } });
    const refused = setUrgentOnSiteRepair(state, false);
    expect(nextStep(refused)).toEqual({ ok: false, error: { code: 'urgent_required_for_b2c' } });
    const urgent = setUrgentOnSiteRepair(state, true);
    expect(nextStep(urgent).ok).toBe(true);
  });

  it('changer de client RÉINITIALISE la qualification d’urgence (jamais un flag orphelin)', () => {
    const urgent = setUrgentOnSiteRepair(selectCustomer(startFactureDirecte(), B2C), true);
    const switched = selectCustomer(urgent, B2B);
    expect(switched.urgentOnSiteRepair).toBeNull();
  });

  it('étape lignes : au moins une ligne ET un taux confirmé', () => {
    let state = selectCustomer(startFactureDirecte(), B2B);
    const advanced = nextStep(state);
    expect(advanced.ok).toBe(true);
    if (!advanced.ok) return;
    state = advanced.value;
    expect(nextStep(state)).toEqual({ ok: false, error: { code: 'lines_required' } });
    const withLine = addLine(state, LINE);
    expect(withLine.ok).toBe(true);
    if (!withLine.ok) return;
    expect(nextStep(withLine.value)).toEqual({ ok: false, error: { code: 'vat_required' } });
  });

  it('re-confirmer le taux réaligne TOUTES les lignes (une pièce = un taux)', () => {
    const state = setVat(readyState(), 20, { housingOlderThan2y: false, energyRenovation: false });
    expect(state.lines.every((line) => line.vatRate === 20)).toBe(true);
  });

  it('B3 — remise de ligne plafonnée à sa base ; remise globale plafonnée au HT net de lignes', () => {
    const state = readyState();
    const over = addLine(state, { ...LINE, discount: { type: 'amount', cents: 999_999 } });
    expect(over.ok).toBe(false);
    if (!over.ok) expect(over.error.code).toBe('discount_invalid');
    const okLine = addLine(state, { ...LINE, discount: { type: 'percent', value: 10 } });
    expect(okLine.ok).toBe(true);
    const overGlobal = setGlobalDiscount(state, { type: 'amount', cents: 999_999 });
    expect(overGlobal.ok).toBe(false);
    const okGlobal = setGlobalDiscount(state, { type: 'amount', cents: 2_000 });
    expect(okGlobal.ok).toBe(true);
  });

  it('B3 — totaux LIVE : remise globale déduite de l’assiette (grossHt/discountCents exposés)', () => {
    const withGlobal = setGlobalDiscount(readyState(), { type: 'percent', value: 10 });
    expect(withGlobal.ok).toBe(true);
    if (!withGlobal.ok) return;
    const totals = totalsOf(withGlobal.value);
    expect(totals.grossHt).toBe(12_000);
    expect(totals.discountCents).toBe(1_200);
    expect(totals.ht).toBe(10_800);
    expect(totals.vat).toBe(1_080);
    expect(totals.ttc).toBe(11_880);
  });

  it('payload : b2c urgent ⇒ urgentOnSiteRepair TRUE strict ; pro ⇒ champ ABSENT', () => {
    const pro = buildComposePayload(readyState(B2B));
    expect(pro).not.toBeNull();
    expect(pro && 'urgentOnSiteRepair' in pro).toBe(false);
    const b2c = buildComposePayload(readyState(B2C));
    expect(b2c?.urgentOnSiteRepair).toBe(true);
    // energyRenovation seul (sans logement > 2 ans) ne part jamais true — combinaison sans sens.
    expect(pro?.context).toEqual({ housingOlderThan2y: true, energyRenovation: false });
  });

  it('parseDiscountInput : vide = aucune remise ; virgule FR ; refus au-delà de la base', () => {
    expect(parseDiscountInput('percent', '', 10_000)).toEqual({ ok: true, discount: null });
    expect(parseDiscountInput('percent', '12,5', 10_000)).toEqual({
      ok: true,
      discount: { type: 'percent', value: 12.5 },
    });
    expect(parseDiscountInput('amount', '25', 10_000)).toEqual({
      ok: true,
      discount: { type: 'amount', cents: 2_500 },
    });
    expect(parseDiscountInput('amount', '150', 10_000).ok).toBe(false);
    expect(parseDiscountInput('percent', '120', 10_000).ok).toBe(false);
    expect(parseDiscountInput('percent', 'abc', 10_000).ok).toBe(false);
  });

  it('navigation : previousStep revient sans détruire la saisie ; recap est terminal', () => {
    const atLines = readyState();
    const back = previousStep(atLines);
    expect(back.step).toBe('client');
    expect(back.lines).toHaveLength(1);
    const atRecap = nextStep(atLines);
    expect(atRecap.ok).toBe(true);
    if (!atRecap.ok) return;
    expect(atRecap.value.step).toBe('recap');
    expect(nextStep(atRecap.value)).toEqual({ ok: false, error: { code: 'flow_finished' } });
    expect(removeLine(atRecap.value, 5)).toBe(atRecap.value);
  });
});
