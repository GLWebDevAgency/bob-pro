import { describe, expect, it } from 'vitest';
import { embargoPromptOf, shouldAdviseRemoteSignature } from './embargo-prompt';

const embargoError = {
  kind: 'domain',
  error: {
    code: 'OFF_PREMISES_PAYMENT_EMBARGO',
    quoteId: 'q1',
    expiresAt: '2026-06-08T22:00:00.000Z',
    availableFrom: '2026-06-09',
    message: 'Client particulier signé à domicile… (art. L221-10).',
    overridable: true,
    overrideRisk: 'Encaisser avant le 09/06/2026 expose à la nullité du contrat (art. L242-1)…',
  },
};

describe('embargoPromptOf', () => {
  it('traduit le refus L221-10 en invite structurée (dates FR, risque, affordance)', () => {
    const prompt = embargoPromptOf(embargoError, 'deposit');
    expect(prompt).toEqual({
      mode: 'deposit',
      message: 'Client particulier signé à domicile… (art. L221-10).',
      availableFrom: '2026-06-09',
      availableFromFr: '09/06/2026',
      overrideRisk:
        'Encaisser avant le 09/06/2026 expose à la nullité du contrat (art. L242-1)…',
      overridable: true,
    });
  });

  it('toute autre erreur → null (le chemin d’alerte générique reste inchangé)', () => {
    expect(embargoPromptOf({ kind: 'not_found' }, 'deposit')).toBeNull();
    expect(
      embargoPromptOf(
        { kind: 'domain', error: { code: 'RETRACTATION_PERIOD_ACTIVE' } },
        'final',
      ),
    ).toBeNull();
    expect(embargoPromptOf(null, 'deposit')).toBeNull();
    expect(embargoPromptOf('boom', 'deposit')).toBeNull();
  });

  it('fail-closed : date absente ou difforme → pas d’invite (jamais une date inventée)', () => {
    expect(
      embargoPromptOf(
        { kind: 'domain', error: { code: 'OFF_PREMISES_PAYMENT_EMBARGO' } },
        'deposit',
      ),
    ).toBeNull();
    expect(
      embargoPromptOf(
        {
          kind: 'domain',
          error: { code: 'OFF_PREMISES_PAYMENT_EMBARGO', availableFrom: '09/06/2026' },
        },
        'deposit',
      ),
    ).toBeNull();
  });

  it('serveur antérieur sans overridable/overrideRisk → invite sans affordance d’override', () => {
    const prompt = embargoPromptOf(
      {
        kind: 'domain',
        error: {
          code: 'OFF_PREMISES_PAYMENT_EMBARGO',
          availableFrom: '2026-06-09',
          message: 'msg',
        },
      },
      'final',
    );
    expect(prompt).toMatchObject({ overridable: false, overrideRisk: null });
  });
});

describe('shouldAdviseRemoteSignature (conseil du canal, item 4)', () => {
  it('B2C non urgent → conseil ; urgent ou pro → jamais', () => {
    expect(
      shouldAdviseRemoteSignature({ customerType: 'b2c', urgentRepairRequested: false }),
    ).toBe(true);
    expect(
      shouldAdviseRemoteSignature({ customerType: 'b2c', urgentRepairRequested: true }),
    ).toBe(false);
    expect(
      shouldAdviseRemoteSignature({ customerType: 'b2b', urgentRepairRequested: false }),
    ).toBe(false);
    expect(
      shouldAdviseRemoteSignature({ customerType: null, urgentRepairRequested: false }),
    ).toBe(false);
    expect(
      shouldAdviseRemoteSignature({ customerType: undefined, urgentRepairRequested: false }),
    ).toBe(false);
  });
});
