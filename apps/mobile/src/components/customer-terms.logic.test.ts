import { describe, expect, it } from 'vitest';
import {
  billingChannelTypeOf,
  buildBillingChannel,
  describeBillingChannel,
  describePaymentTerms,
  dueLineForInvoice,
  parseTermsDaysInput,
  previewDueDate,
  termsCeilingExceeded,
} from './customer-terms.logic';

describe('customer-terms.logic — conditions de paiement (B4)', () => {
  it('décrit les conditions : jours nets, fin de mois, ou défaut société', () => {
    expect(describePaymentTerms(null, 'pote')).toBe('Ce client suit ton réglage société.');
    expect(describePaymentTerms({ days: 30, endOfMonth: false, label: '30 j' }, 'pote')).toBe(
      '30 jours',
    );
    expect(describePaymentTerms({ days: 45, endOfMonth: true, label: '45 fdm' }, 'direct')).toBe(
      '45 j fin de mois',
    );
  });

  it('parse la saisie du délai : entier 0..365 uniquement', () => {
    expect(parseTermsDaysInput('45')).toBe(45);
    expect(parseTermsDaysInput('0')).toBe(0);
    expect(parseTermsDaysInput('366')).toBeNull();
    expect(parseTermsDaysInput('-5')).toBeNull();
    expect(parseTermsDaysInput('4,5')).toBeNull();
    expect(parseTermsDaysInput('')).toBeNull();
  });

  it('plafond L441-10 : 60 j nets / 45 j fin de mois pour un pro — b2c jamais concerné', () => {
    expect(termsCeilingExceeded('b2b', 60, false)).toBe(false);
    expect(termsCeilingExceeded('b2b', 61, false)).toBe(true);
    expect(termsCeilingExceeded('b2g', 45, true)).toBe(false);
    expect(termsCeilingExceeded('b2b', 46, true)).toBe(true);
    expect(termsCeilingExceeded('b2c', 120, false)).toBe(false);
  });

  it('échéance affichée à l’émission : date serveur + libellé dérivé des conditions', () => {
    expect(
      dueLineForInvoice('2026-09-12', { days: 45, endOfMonth: true, label: '45 fdm' }, 'pote'),
    ).toBe('Échéance : 12/09/2026 — 45 jours fin de mois');
    expect(dueLineForInvoice('2026-09-12', null, 'pote')).toBe('Échéance : 12/09/2026');
    expect(dueLineForInvoice(null, null, 'pote')).toBeNull();
    expect(dueLineForInvoice('pas-une-date', null, 'pote')).toBeNull();
  });

  it('aperçu live de l’échéance : report fin de mois appliqué (règle domaine PaymentTerms)', () => {
    expect(previewDueDate(30, false, '2026-07-19')).toBe('18/08/2026');
    expect(previewDueDate(45, true, '2026-07-19')).toBe('30/09/2026');
    expect(previewDueDate(0, false, '2026-07-19')).toBeNull();
  });
});

describe('customer-terms.logic — canal de facturation', () => {
  it('canal effectif : absent/null = email (défaut honnête)', () => {
    expect(billingChannelTypeOf(null)).toBe('email');
    expect(billingChannelTypeOf(undefined)).toBe('email');
    expect(billingChannelTypeOf({ type: 'chorus' })).toBe('chorus');
  });

  it('décrit le canal avec son mémo (code service / nom de portail)', () => {
    expect(describeBillingChannel(null, 'pote')).toBe('Par e-mail');
    expect(
      describeBillingChannel({ type: 'chorus', chorusServiceCode: 'SERV-42' }, 'pote'),
    ).toBe('Chorus Pro · SERV-42');
    expect(
      describeBillingChannel({ type: 'portail', portailNom: 'Coupa Vinci' }, 'direct'),
    ).toBe('Portail · Coupa Vinci');
  });

  it('normalise le formulaire : champs annexes UNIQUEMENT pour leur type, trims appliqués', () => {
    expect(
      buildBillingChannel({ type: 'email', chorusServiceCode: 'X', portailNom: 'Y', portailUrl: 'Z' }),
    ).toEqual({ type: 'email' });
    expect(
      buildBillingChannel({ type: 'chorus', chorusServiceCode: ' SERV-42 ', portailNom: '', portailUrl: '' }),
    ).toEqual({ type: 'chorus', chorusServiceCode: 'SERV-42' });
    expect(
      buildBillingChannel({ type: 'portail', chorusServiceCode: '', portailNom: ' Coupa ', portailUrl: ' https://coupa.example ' }),
    ).toEqual({ type: 'portail', portailNom: 'Coupa', portailUrl: 'https://coupa.example' });
    expect(
      buildBillingChannel({ type: 'chorus', chorusServiceCode: '  ', portailNom: '', portailUrl: '' }),
    ).toEqual({ type: 'chorus' });
  });
});
