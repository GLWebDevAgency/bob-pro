/**
 * deriveBalanceConfirmationState — le scénario du fondateur EN LITTÉRAUX (les payloads 503
 * exacts de BANK_BALANCE_FRESHNESS_POLICY_V1), et la discrimination stricte des causes :
 * qualification = confirmation en premier plan · vrai incident = état d'erreur, inchangé.
 */
import { describe, expect, it } from 'vitest';
import { deriveBalanceConfirmationState } from './balance-confirmation-state';

/** Le refus EXACT servi par l'API sur /bank-balance ET /cashflow quand le solde a > 24 h. */
const STALE_503 = { kind: 'unavailable', service: 'bank-balance-stale' } as const;
/** Le refus « jamais confirmé » du GET solde (premier lancement). */
const UNCONFIRMED_404 = { kind: 'not_found', entity: 'bank_balance_snapshot' } as const;
/** Le refus cashflow « aucune source bancaire » (autre entrée attendue). */
const CASHFLOW_SOURCE_503 = { kind: 'unavailable', service: 'cashflow-banking-source' } as const;

const failed = (error: unknown) => ({ failed: true, error });
const ok = { failed: false, error: undefined };

describe('deriveBalanceConfirmationState — scénario du fondateur', () => {
  it('solde 503 stale + les 6 cashflow 503 stale ⇒ CONFIRMATION EN PREMIER PLAN, raison « stale »', () => {
    const state = deriveBalanceConfirmationState({
      balance: failed(STALE_503),
      cashflow: [
        failed(STALE_503),
        failed(STALE_503),
        failed(STALE_503),
        failed(STALE_503),
        failed(STALE_503),
        failed(STALE_503),
      ],
    });
    expect(state).toEqual({
      balanceNeedsConfirmation: true,
      reason: 'stale',
      cashflowOnlyAwaitsBalance: true,
      confirmationIsPrimary: true,
    });
  });

  it('solde 404 jamais confirmé + cashflow « cashflow-banking-source » ⇒ premier plan, raison « unconfirmed »', () => {
    const state = deriveBalanceConfirmationState({
      balance: failed(UNCONFIRMED_404),
      cashflow: [failed(CASHFLOW_SOURCE_503), ok, ok],
    });
    expect(state.balanceNeedsConfirmation).toBe(true);
    expect(state.reason).toBe('unconfirmed');
    expect(state.confirmationIsPrimary).toBe(true);
  });

  it('VRAI incident cashflow (kind hors qualification) ⇒ PAS de premier plan — l’état d’erreur garde la main', () => {
    const state = deriveBalanceConfirmationState({
      balance: failed(STALE_503),
      cashflow: [failed(STALE_503), failed({ kind: 'unavailable', service: 'database' })],
    });
    expect(state.balanceNeedsConfirmation).toBe(true); // la carte de confirmation reste possible…
    expect(state.cashflowOnlyAwaitsBalance).toBe(false); // …mais un incident se cache derrière
    expect(state.confirmationIsPrimary).toBe(false);
  });

  it('VRAI incident du GET solde (500 non typé) ⇒ aucune confirmation fabriquée', () => {
    const state = deriveBalanceConfirmationState({
      balance: failed(new TypeError('fetch failed')),
      cashflow: [ok],
    });
    expect(state).toEqual({
      balanceNeedsConfirmation: false,
      reason: null,
      cashflowOnlyAwaitsBalance: true,
      confirmationIsPrimary: false,
    });
  });

  it('solde OK + cashflow OK ⇒ rien à confirmer (nominal)', () => {
    const state = deriveBalanceConfirmationState({ balance: ok, cashflow: [ok, ok] });
    expect(state.confirmationIsPrimary).toBe(false);
    expect(state.balanceNeedsConfirmation).toBe(false);
    expect(state.reason).toBeNull();
  });

  it('solde stale mais cashflow encore SANS échec (données en cache) ⇒ premier plan possible côté dérivation', () => {
    // La composition d'écran garde le héros s'il a des données — la dérivation, elle, dit
    // seulement : « la seule cause d'indisponibilité est la confirmation ».
    const state = deriveBalanceConfirmationState({ balance: failed(STALE_503), cashflow: [ok] });
    expect(state.confirmationIsPrimary).toBe(true);
  });
});
