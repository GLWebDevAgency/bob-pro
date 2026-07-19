import { describe, expect, it } from 'vitest';
import {
  OFF_PREMISES_PAYMENT_EMBARGO_DAYS,
  RETRACTATION_CONFIRM_FUNCTION_LABEL,
  RETRACTATION_DELAY_DAYS,
  RETRACTATION_EARLY_EXECUTION_LABEL,
  RETRACTATION_WITHDRAW_FUNCTION_LABEL,
  deriveRetractation,
  formatDateOnlyFr,
  formatInstantFrParis,
  isFrenchPublicHoliday,
  offPremisesPaymentEmbargo,
  offPremisesPaymentEmbargoMessage,
  onlineRetractationAvailability,
  retractationAcknowledgmentLines,
  retractationContactGaps,
  retractationDeclarationLines,
  retractationExpiresAt,
  retractationFormLines,
  retractationFreeze,
  retractationFreezeMessage,
  retractationNoticeLines,
} from './retractation';
import { type Signature } from '../billing/shared/signature';

function signature(over: Partial<Signature> = {}): Signature {
  return {
    signerName: 'M. Bernard',
    signedAt: '2026-06-01T10:00:00.000Z',
    method: 'remote_link',
    accepted: true,
    ...over,
  };
}

describe('isFrenchPublicHoliday (calendrier légal L3133-1)', () => {
  it.each([
    ['2026-01-01', true], // jour de l'an
    ['2026-05-01', true], // fête du travail
    ['2026-05-08', true], // victoire 1945
    ['2026-07-14', true], // fête nationale
    ['2026-08-15', true], // Assomption
    ['2026-11-01', true], // Toussaint
    ['2026-11-11', true], // Armistice
    ['2026-12-25', true], // Noël
    ['2026-04-06', true], // lundi de Pâques 2026 (Pâques = 05/04/2026)
    ['2026-05-14', true], // Ascension 2026 (Pâques + 39)
    ['2026-05-25', true], // lundi de Pentecôte 2026 (Pâques + 50)
    ['2027-03-29', true], // lundi de Pâques 2027 (Pâques = 28/03/2027)
    ['2026-06-15', false],
    ['2026-04-05', false], // Pâques (dimanche) n'est pas dans L3133-1 — le dimanche l'écarte déjà
    ['2026-12-26', false], // férié local Alsace-Moselle : hors liste nationale, jamais inventé
  ])('%s → %s', (date, expected) => {
    expect(isFrenchPublicHoliday(date)).toBe(expected);
  });
});

describe('retractationExpiresAt (L221-19 / règlement CEE 1182/71)', () => {
  it('cas nominal : J+14 en semaine — expire à minuit Paris à la FIN du 14e jour', () => {
    // Signé lundi 01/06/2026 à 12h Paris. Jour de conclusion NON compté ; dernier jour =
    // lundi 15/06/2026 (ouvrable) ; expiration = fin du 15/06 = 16/06 00:00 Paris (CEST, UTC+2).
    expect(retractationExpiresAt('2026-06-01T10:00:00.000Z')).toBe('2026-06-15T22:00:00.000Z');
  });

  it('le jour de conclusion ne compte pas, même signé à 23h59 Paris', () => {
    // 01/06/2026 23:59 Paris = 21:59 UTC — même jour Paris, même expiration que ci-dessus.
    expect(retractationExpiresAt('2026-06-01T21:59:00.000Z')).toBe('2026-06-15T22:00:00.000Z');
  });

  it('proche de minuit, le jour PARIS fait foi (pas le jour UTC)', () => {
    // 01/06/2026 23:30 UTC = 02/06/2026 01:30 Paris → conclusion le 02/06, dernier jour 16/06.
    expect(retractationExpiresAt('2026-06-01T23:30:00.000Z')).toBe('2026-06-16T22:00:00.000Z');
  });

  it('dernier jour un samedi → prorogé au premier jour ouvrable (lundi)', () => {
    // Signé samedi 06/06/2026 : J+14 = samedi 20/06 → dimanche 21/06 → lundi 22/06.
    expect(retractationExpiresAt('2026-06-06T10:00:00.000Z')).toBe('2026-06-22T22:00:00.000Z');
  });

  it('dernier jour un dimanche → prorogé au lundi', () => {
    // Signé dimanche 07/06/2026 : J+14 = dimanche 21/06 → lundi 22/06.
    expect(retractationExpiresAt('2026-06-07T10:00:00.000Z')).toBe('2026-06-22T22:00:00.000Z');
  });

  it('dernier jour férié (14 juillet) → prorogé au jour ouvrable suivant', () => {
    // Signé mardi 30/06/2026 : J+14 = mardi 14/07/2026 (férié) → mercredi 15/07.
    expect(retractationExpiresAt('2026-06-30T10:00:00.000Z')).toBe('2026-07-15T22:00:00.000Z');
  });

  it('chaîne férié mobile + week-end : lundi de Pâques → mardi', () => {
    // Signé lundi 23/03/2026 : J+14 = lundi 06/04/2026 (lundi de Pâques) → mardi 07/04.
    expect(retractationExpiresAt('2026-03-23T10:00:00.000Z')).toBe('2026-04-07T22:00:00.000Z');
  });

  it('heure d’hiver : l’expiration tombe à 23:00 UTC (minuit Paris CET)', () => {
    // Signé lundi 05/01/2026 : J+14 = lundi 19/01/2026 (ouvrable) → fin du 19/01 = 20/01 00:00
    // Paris (CET, UTC+1) = 19/01 23:00 UTC.
    expect(retractationExpiresAt('2026-01-05T10:00:00.000Z')).toBe('2026-01-19T23:00:00.000Z');
  });

  it('la constante légale vaut 14 jours (L221-18)', () => {
    expect(RETRACTATION_DELAY_DAYS).toBe(14);
  });
});

describe('deriveRetractation', () => {
  it('devis non signé → null (aucun contrat, aucun délai)', () => {
    expect(deriveRetractation({ customerType: 'b2c', signature: null })).toBeNull();
  });

  it.each(['b2b', 'b2g'] as const)('%s : droit inapplicable, jamais de délai', (customerType) => {
    expect(deriveRetractation({ customerType, signature: signature() })).toEqual({
      applicable: false,
      waived: null,
      expiresAt: null,
    });
  });

  it.each(['remote_link', 'onsite_draw', 'legacy_declared'] as const)(
    'b2c signé via %s → applicable (distance OU hors établissement — présomption app)',
    (method) => {
      const r = deriveRetractation({ customerType: 'b2c', signature: signature({ method }) });
      expect(r).toEqual({
        applicable: true,
        waived: null,
        expiresAt: '2026-06-15T22:00:00.000Z',
      });
    },
  );

  it('b2c avec demande d’exécution anticipée → renonciation tracée et horodatée', () => {
    const r = deriveRetractation({
      customerType: 'b2c',
      signature: signature({ earlyExecution: { requestedAt: '2026-06-01T10:00:00.000Z' } }),
    });
    expect(r?.waived).toEqual({ requestedEarlyExecution: true, at: '2026-06-01T10:00:00.000Z' });
    // La renonciation ne supprime pas le DROIT de rétractation : le délai reste calculé.
    expect(r?.expiresAt).toBe('2026-06-15T22:00:00.000Z');
  });

  it('qualité FIGÉE à la conclusion (signature.customerType) : prime sur la fiche éditée', () => {
    // Contrat conclu avec un CONSOMMATEUR : la fiche passée en b2b après coup ne lève rien.
    const stillApplicable = deriveRetractation({
      customerType: 'b2b',
      signature: signature({ customerType: 'b2c' }),
    });
    expect(stillApplicable?.applicable).toBe(true);
    // Contrat conclu avec un PROFESSIONNEL : la fiche passée en b2c après coup ne crée rien.
    const stillNotApplicable = deriveRetractation({
      customerType: 'b2c',
      signature: signature({ customerType: 'b2b' }),
    });
    expect(stillNotApplicable?.applicable).toBe(false);
  });

  it('signature antérieure au figeage (sans customerType) → fallback honnête sur la fiche', () => {
    expect(deriveRetractation({ customerType: 'b2c', signature: signature() })?.applicable).toBe(true);
  });
});

describe('offPremisesPaymentEmbargo (interdiction de paiement 7 jours, art. L221-10)', () => {
  it('la constante légale vaut 7 jours (L221-10)', () => {
    expect(OFF_PREMISES_PAYMENT_EMBARGO_DAYS).toBe(7);
  });

  it('b2c signé SUR PLACE (hors établissement) → embargo actif pendant 7 jours', () => {
    // Signé lundi 01/06/2026 : jour de conclusion non compté, J+7 = lundi 08/06 (ouvrable),
    // fin = 09/06 00:00 Paris (CEST) = 08/06 22:00 UTC.
    expect(
      offPremisesPaymentEmbargo(
        { customerType: 'b2c', signature: signature({ method: 'onsite_draw' }) },
        '2026-06-02T09:00:00.000Z',
      ),
    ).toEqual({ active: true, expiresAt: '2026-06-08T22:00:00.000Z', availableFrom: '2026-06-09' });
  });

  it('inactif à l’instant EXACT d’expiration, actif une milliseconde avant', () => {
    const input = { customerType: 'b2c' as const, signature: signature({ method: 'onsite_draw' }) };
    expect(offPremisesPaymentEmbargo(input, '2026-06-08T22:00:00.000Z')).toEqual({ active: false });
    expect(offPremisesPaymentEmbargo(input, '2026-06-08T21:59:59.999Z')).toMatchObject({ active: true });
  });

  it('contrat À DISTANCE (remote_link) : L221-10 ne s’applique pas — aucun embargo', () => {
    expect(
      offPremisesPaymentEmbargo(
        { customerType: 'b2c', signature: signature({ method: 'remote_link' }) },
        '2026-06-02T09:00:00.000Z',
      ),
    ).toEqual({ active: false });
  });

  it('legacy_declared (méthode inconnue) → fail-closed : présomption hors établissement', () => {
    expect(
      offPremisesPaymentEmbargo(
        { customerType: 'b2c', signature: signature({ method: 'legacy_declared' }) },
        '2026-06-02T09:00:00.000Z',
      ),
    ).toMatchObject({ active: true });
  });

  it.each(['b2b', 'b2g'] as const)('%s : professionnels hors champ — aucun embargo', (customerType) => {
    expect(
      offPremisesPaymentEmbargo(
        { customerType, signature: signature({ method: 'onsite_draw' }) },
        '2026-06-02T09:00:00.000Z',
      ),
    ).toEqual({ active: false });
  });

  it('qualité figée à la conclusion : b2c à la signature prime sur une fiche passée b2b', () => {
    expect(
      offPremisesPaymentEmbargo(
        { customerType: 'b2b', signature: signature({ method: 'onsite_draw', customerType: 'b2c' }) },
        '2026-06-02T09:00:00.000Z',
      ),
    ).toMatchObject({ active: true });
  });

  it('la demande d’exécution anticipée (L221-25) est SANS EFFET sur l’embargo', () => {
    expect(
      offPremisesPaymentEmbargo(
        {
          customerType: 'b2c',
          signature: signature({
            method: 'onsite_draw',
            earlyExecution: { requestedAt: '2026-06-01T10:00:00.000Z' },
          }),
        },
        '2026-06-02T09:00:00.000Z',
      ),
    ).toMatchObject({ active: true });
  });

  it('devis non signé → aucun contrat, aucun embargo', () => {
    expect(offPremisesPaymentEmbargo({ customerType: 'b2c', signature: null }, '2026-06-02T09:00:00.000Z')).toEqual({
      active: false,
    });
  });

  it('message honnête : pourquoi (L221-10), jusqu’à quand, ce qui reste valable', () => {
    const message = offPremisesPaymentEmbargoMessage('2026-06-09');
    expect(message).toContain('L221-10');
    expect(message).toContain('09/06/2026');
    expect(message).toContain('acompte compris');
    expect(message).toContain('reste');
  });
});

describe('onlineRetractationAvailability (fonctionnalité L221-21/D221-5)', () => {
  const b2c = () => deriveRetractation({ customerType: 'b2c', signature: signature() });

  it('disponible pendant TOUTE la durée du délai', () => {
    expect(onlineRetractationAvailability(b2c(), false, '2026-06-10T09:00:00.000Z')).toEqual({
      available: true,
      expiresAt: '2026-06-15T22:00:00.000Z',
    });
  });

  it('reste disponible MÊME après demande d’exécution anticipée (le droit survit à la demande)', () => {
    const waived = deriveRetractation({
      customerType: 'b2c',
      signature: signature({ earlyExecution: { requestedAt: '2026-06-01T10:00:00.000Z' } }),
    });
    expect(onlineRetractationAvailability(waived, false, '2026-06-10T09:00:00.000Z')).toMatchObject({
      available: true,
    });
  });

  it('indisponible après expiration du délai', () => {
    expect(onlineRetractationAvailability(b2c(), false, '2026-06-15T22:00:00.000Z')).toEqual({
      available: false,
      reason: 'expired',
    });
  });

  it('indisponible si déjà rétracté (une seule rétractation par contrat)', () => {
    expect(onlineRetractationAvailability(b2c(), true, '2026-06-10T09:00:00.000Z')).toEqual({
      available: false,
      reason: 'already_retracted',
    });
  });

  it('indisponible pour un professionnel ou un devis non signé', () => {
    const b2b = deriveRetractation({ customerType: 'b2b', signature: signature() });
    expect(onlineRetractationAvailability(b2b, false, '2026-06-10T09:00:00.000Z')).toEqual({
      available: false,
      reason: 'not_applicable',
    });
    expect(onlineRetractationAvailability(null, false, '2026-06-10T09:00:00.000Z')).toEqual({
      available: false,
      reason: 'not_applicable',
    });
  });

  it('libellés réglementaires exacts (D221-5 : « renoncer au contrat ici » / « confirmer la rétractation »)', () => {
    expect(RETRACTATION_WITHDRAW_FUNCTION_LABEL).toBe('Renoncer au contrat ici');
    expect(RETRACTATION_CONFIRM_FUNCTION_LABEL).toBe('Confirmer la rétractation');
  });
});

describe('déclaration et accusé de réception (D221-5, II et IV)', () => {
  const declaration = {
    declarantName: 'M. Bernard',
    quoteNumber: 'D-2026-0001',
    companyName: 'Mercier Plomberie',
    acknowledgmentEmail: 'bernard@example.fr',
    sentAt: '2026-06-10T12:30:00.000Z',
  };

  it('formatInstantFrParis : date ET heure de Paris (été UTC+2, hiver UTC+1)', () => {
    expect(formatInstantFrParis('2026-06-10T12:30:00.000Z')).toBe('10/06/2026 à 14:30 (heure de Paris)');
    expect(formatInstantFrParis('2026-01-05T12:30:00.000Z')).toBe('05/01/2026 à 13:30 (heure de Paris)');
  });

  it('déclaration : notification dénuée d’ambiguïté + nom + contrat + moyen électronique + date/heure', () => {
    const lines = retractationDeclarationLines(declaration).join('\n');
    expect(lines).toContain('ma rétractation du contrat');
    expect(lines).toContain('D-2026-0001');
    expect(lines).toContain('M. Bernard');
    expect(lines).toContain('bernard@example.fr');
    expect(lines).toContain('10/06/2026 à 14:30 (heure de Paris)');
  });

  it('accusé de réception : contenu de la déclaration + date/heure d’envoi + remboursement L221-24', () => {
    const lines = retractationAcknowledgmentLines(declaration);
    expect(lines[0]).toBe('Accusé de réception de votre rétractation');
    const joined = lines.join('\n');
    expect(joined).toContain('accuse réception');
    expect(joined).toContain('10/06/2026 à 14:30 (heure de Paris)');
    // Le contenu INTÉGRAL de la déclaration est repris (D221-5, IV).
    for (const line of retractationDeclarationLines(declaration)) expect(lines).toContain(line);
    expect(joined).toContain('L221-24');
  });
});

describe('retractationContactGaps (complétude des modèles R221-1/R221-3)', () => {
  const pro = { name: 'Mercier Plomberie', addressLine: '12 rue des Fleurs, 92310 Sèvres' };

  it('profil sans téléphone ni courriel → les deux modèles sont incomplets', () => {
    expect(retractationContactGaps(pro)).toEqual({
      noticeMissing: ['phone', 'email'],
      formMissing: ['email'],
    });
  });

  it('courriel seul → avis incomplet (téléphone requis), formulaire complet', () => {
    expect(retractationContactGaps({ ...pro, email: 'contact@mercier.fr' })).toEqual({
      noticeMissing: ['phone'],
      formMissing: [],
    });
  });

  it('téléphone + courriel → tout est conforme aux modèles en vigueur (décret 2022-424)', () => {
    expect(
      retractationContactGaps({ ...pro, email: 'contact@mercier.fr', phone: '06 12 34 56 78' }),
    ).toEqual({ noticeMissing: [], formMissing: [] });
  });
});

describe('retractationFreeze (gel de la facture finale)', () => {
  const b2c = () => deriveRetractation({ customerType: 'b2c', signature: signature() });

  it('actif pendant le délai : date de déblocage = lendemain du dernier jour (Paris)', () => {
    expect(retractationFreeze(b2c(), '2026-06-10T09:00:00.000Z')).toEqual({
      active: true,
      expiresAt: '2026-06-15T22:00:00.000Z',
      availableFrom: '2026-06-16',
    });
  });

  it('inactif à l’instant EXACT d’expiration (le délai est écoulé)', () => {
    expect(retractationFreeze(b2c(), '2026-06-15T22:00:00.000Z')).toEqual({ active: false });
  });

  it('inactif une milliseconde avant minuit Paris ? Non — encore actif', () => {
    expect(retractationFreeze(b2c(), '2026-06-15T21:59:59.999Z')).toMatchObject({ active: true });
  });

  it('inactif après le délai (devis legacy signés il y a longtemps : jamais re-gelés)', () => {
    expect(retractationFreeze(b2c(), '2026-07-01T00:00:00.000Z')).toEqual({ active: false });
  });

  it('inactif quand l’exécution anticipée a été demandée (L221-25)', () => {
    const waived = deriveRetractation({
      customerType: 'b2c',
      signature: signature({ earlyExecution: { requestedAt: '2026-06-01T10:00:00.000Z' } }),
    });
    expect(retractationFreeze(waived, '2026-06-10T09:00:00.000Z')).toEqual({ active: false });
  });

  it('inactif pour un professionnel et pour un devis non signé', () => {
    const b2b = deriveRetractation({ customerType: 'b2b', signature: signature() });
    expect(retractationFreeze(b2b, '2026-06-10T09:00:00.000Z')).toEqual({ active: false });
    expect(retractationFreeze(null, '2026-06-10T09:00:00.000Z')).toEqual({ active: false });
  });
});

describe('textes réglementaires', () => {
  const pro = {
    name: 'Mercier Plomberie',
    addressLine: '12 rue des Fleurs, 92310 Sèvres',
  };

  it('avis d’information : délai, point de départ (conclusion), modalités et effets', () => {
    const lines = retractationNoticeLines(pro);
    expect(lines[0]).toBe('Droit de rétractation');
    expect(lines.join('\n')).toContain('quatorze jours');
    expect(lines.join('\n')).toContain('quatorze jours après le jour de la conclusion du contrat');
    expect(lines.join('\n')).toContain('Mercier Plomberie, 12 rue des Fleurs, 92310 Sèvres');
    expect(lines.join('\n')).toContain('Effets de rétractation');
    expect(lines.join('\n')).toContain('montant proportionnel');
  });

  it('avis d’information : téléphone/courriel insérés uniquement quand CONNUS', () => {
    const without = retractationNoticeLines(pro).join('\n');
    expect(without).not.toContain('tél.');
    expect(without).not.toContain('courriel');
    const withContact = retractationNoticeLines({
      ...pro,
      phone: '06 12 34 56 78',
      email: 'contact@mercier.fr',
    }).join('\n');
    expect(withContact).toContain('tél. : 06 12 34 56 78');
    expect(withContact).toContain('courriel : contact@mercier.fr');
  });

  it('formulaire détachable : texte EXACT du modèle type (annexe R221-1)', () => {
    const lines = retractationFormLines({ ...pro, email: 'contact@mercier.fr' });
    expect(lines).toEqual([
      'Formulaire de rétractation',
      '(Veuillez compléter et renvoyer le présent formulaire uniquement si vous souhaitez vous rétracter du contrat.)',
      "À l'attention de Mercier Plomberie, 12 rue des Fleurs, 92310 Sèvres, contact@mercier.fr :",
      'Je/Nous (*) vous notifie/notifions (*) par la présente ma/notre (*) rétractation du contrat portant sur la vente du bien (*)/pour la prestation de services (*) ci-dessous :',
      'Commandé le (*)/reçu le (*) :',
      'Nom du (des) consommateur(s) :',
      'Adresse du (des) consommateur(s) :',
      'Signature du (des) consommateur(s) (uniquement en cas de notification du présent formulaire sur papier) :',
      'Date :',
      '(*) Rayez la mention inutile.',
    ]);
  });

  it('formulaire : e-mail absent → jamais inventé', () => {
    expect(retractationFormLines(pro)[2]).toBe(
      "À l'attention de Mercier Plomberie, 12 rue des Fleurs, 92310 Sèvres :",
    );
  });

  it('case d’exécution anticipée : demande expresse + paiement proportionnel + reconnaissance de PERTE DU DROIT après exécution complète (L221-25 al. 1 et L221-28, 1°)', () => {
    expect(RETRACTATION_EARLY_EXECUTION_LABEL).toContain("l'exécution immédiate des travaux");
    expect(RETRACTATION_EARLY_EXECUTION_LABEL).toContain('expressément');
    expect(RETRACTATION_EARLY_EXECUTION_LABEL).toContain('L221-25');
    expect(RETRACTATION_EARLY_EXECUTION_LABEL).toContain('devrai payer');
    // Reconnaissance imposée par L221-25 al. 1 (ord. 2021-1734) : sans elle, L221-28, 1° ne
    // joue pas et le client conserverait son droit MÊME après exécution complète des travaux.
    expect(RETRACTATION_EARLY_EXECUTION_LABEL).toContain('entièrement exécuté');
    expect(RETRACTATION_EARLY_EXECUTION_LABEL).toContain('ne disposerai plus du droit de rétractation');
    expect(RETRACTATION_EARLY_EXECUTION_LABEL).toContain('L221-28');
  });

  it('avis d’information : ligne fonctionnalité en ligne UNIQUEMENT quand un emplacement est fourni (L221-5, 7° ; annexe R221-3, instruction (3), décret 2026-3)', () => {
    const sans = retractationNoticeLines(pro).join('\n');
    expect(sans).not.toContain('Renoncer au contrat ici');
    const avec = retractationNoticeLines(pro, {
      onlineFunctionLocation: 'https://sign.bobpro.fr/retract/pst_1',
    }).join('\n');
    expect(avec).toContain('« Renoncer au contrat ici »');
    expect(avec).toContain('https://sign.bobpro.fr/retract/pst_1');
    expect(avec).toContain('pendant toute la durée du délai');
    expect(avec).toContain('accusé de réception');
    expect(avec).toContain('support durable');
  });

  it('message de gel : honnête — pourquoi, jusqu’à quand, ce qui reste possible', () => {
    const message = retractationFreezeMessage('2026-06-16');
    expect(message).toContain('L221-18');
    expect(message).toContain('16/06/2026');
    expect(message).toContain('acompte');
    expect(formatDateOnlyFr('2026-06-16')).toBe('16/06/2026');
  });
});
