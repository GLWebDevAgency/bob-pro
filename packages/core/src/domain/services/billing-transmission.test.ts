import { describe, expect, it } from 'vitest';
import { deriveTransmissionGuide } from './billing-transmission';

/**
 * Guide de TRANSMISSION dérivé du canal de facturation — fonction PURE, honnête :
 * `done` n'est true/false que quand l'app peut VÉRIFIER le prérequis, null sinon.
 */

const customerComplete = { siren: '552100554', email: 'compta@client.fr' };

describe('deriveTransmissionGuide — email (défaut)', () => {
  it('canal absent = email par défaut, e-mail présent vérifié', () => {
    const guide = deriveTransmissionGuide({
      billingChannel: null,
      customer: customerComplete,
      invoice: { purchaseOrderNumber: null },
    });
    expect(guide.channel).toBe('email');
    expect(guide.checklist.some((i) => i.label.includes('compta@client.fr') && i.done === true)).toBe(true);
  });

  it('e-mail manquant : étape honnêtement NON faite, jamais inventée', () => {
    const guide = deriveTransmissionGuide({
      billingChannel: { type: 'email' },
      customer: { siren: null, email: null },
      invoice: { purchaseOrderNumber: null },
    });
    expect(guide.checklist.some((i) => i.done === false && i.label.includes('non renseigné'))).toBe(true);
  });
});

describe('deriveTransmissionGuide — chorus (checklist Factur-X + SIRET + engagement B8)', () => {
  it('tous prérequis réunis : Factur-X true, SIREN true, engagement true, code service affiché', () => {
    const guide = deriveTransmissionGuide({
      billingChannel: { type: 'chorus', chorusServiceCode: 'SERV-42' },
      customer: customerComplete,
      invoice: { purchaseOrderNumber: 'ENG-2026-001' },
    });
    expect(guide.channel).toBe('chorus');
    expect(guide.chorusServiceCode).toBe('SERV-42');
    const doneFlags = guide.checklist.map((i) => i.done);
    // Factur-X (toujours dispo), SIREN, engagement, code service vérifiés ; le dépôt lui-même
    // reste hors de portée de l'app (null honnête).
    expect(doneFlags).toEqual([true, true, true, true, null]);
  });

  it('prérequis manquants : SIREN/engagement/code service honnêtement false', () => {
    const guide = deriveTransmissionGuide({
      billingChannel: { type: 'chorus' },
      customer: { siren: null, email: null },
      invoice: { purchaseOrderNumber: null },
    });
    expect(guide.chorusServiceCode).toBeNull();
    expect(guide.checklist.map((i) => i.done)).toEqual([true, false, false, false, null]);
  });
});

describe('deriveTransmissionGuide — portail (mémo nom/URL)', () => {
  it('nom + URL déclarés : mémo complet', () => {
    const guide = deriveTransmissionGuide({
      billingChannel: { type: 'portail', portailNom: 'Portail Vinci', portailUrl: 'https://f.vinci.com' },
      customer: customerComplete,
      invoice: { purchaseOrderNumber: null },
    });
    expect(guide.channel).toBe('portail');
    expect(guide.portail).toEqual({ nom: 'Portail Vinci', url: 'https://f.vinci.com' });
    expect(guide.checklist.some((i) => i.label.includes('Portail Vinci') && i.label.includes('https://f.vinci.com'))).toBe(true);
  });

  it('mémo incomplet : libellé générique, jamais un nom inventé', () => {
    const guide = deriveTransmissionGuide({
      billingChannel: { type: 'portail' },
      customer: customerComplete,
      invoice: { purchaseOrderNumber: null },
    });
    expect(guide.portail).toEqual({ nom: null, url: null });
    expect(guide.checklist.some((i) => i.label.includes('le portail fournisseur du client'))).toBe(true);
  });
});
