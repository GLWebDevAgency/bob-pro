import { describe, expect, it } from 'vitest';
import {
  buildMissionLetter,
  MISSION_LETTER_DISCLAIMER,
  MissionLetterInputError,
  renderMissionLetterPlainText,
  type MissionLetterInput,
} from './mission-letter';

function input(overrides: Partial<MissionLetterInput> = {}): MissionLetterInput {
  return {
    generatedOn: '2026-07-11',
    reference: 'LDM-2026-014',
    cabinet: {
      name: 'Cabinet Dupont Expertise',
      charteredAccountantName: 'Claire Dupont',
      orderRegistration: 'Tableau de Paris, n° 123456',
      address: '10 rue de la Paix, 75002 Paris',
      email: 'rgpd@dupont-expertise.fr',
    },
    client: {
      name: 'Mercier Plomberie',
      legalForm: 'EURL',
      siren: '732829320',
      activity: 'Travaux de plomberie',
      address: '2 rue des Artisans, 92000 Nanterre',
      representativeName: 'Paul Mercier',
    },
    missions: ['bookkeeping', 'review', 'annual_accounts', 'tax_returns'],
    fees: {
      kind: 'fixed',
      amountExcludingTaxCents: 24_000,
      frequency: 'monthly',
      paymentTerms: 'Prélèvement le 5 de chaque mois, payable à réception.',
      revisionTerms: 'Révision annuelle après information et accord écrit du client.',
      expensesPolicy: 'Débours refacturés au coût réel sur justificatif.',
    },
    duration: {
      startsOn: '2026-08-01',
      term: 'fixed',
      endsOn: '2027-07-31',
      renewal: 'tacit',
      noticeMonths: 3,
      terminationTerms: 'Résiliation par écrit permettant d’établir la date de réception.',
    },
    workingArrangements: {
      documentsDue: 'Au plus tard le 10 du mois suivant.',
      exchangeChannel: 'Portail sécurisé du cabinet.',
      deliveryCommitment: 'Calendrier déclaratif confirmé au démarrage de la mission.',
    },
    mediation: {
      mediatorName: 'Médiateur indiqué par le cabinet',
      contact: '1 rue de la Médiation, 75000 Paris',
      website: 'https://mediateur.example',
    },
    dataProtection: {
      role: 'to_be_determined',
      privacyContact: 'rgpd@dupont-expertise.fr',
      recipients: 'Équipe habilitée du cabinet et prestataires listés en annexe.',
      retentionPolicy: 'Durées légales et professionnelles précisées en annexe.',
      transferPolicy: 'Aucun transfert prévu ; tout changement sera documenté.',
    },
    signature: { place: 'Paris', signedOn: null },
    ...overrides,
  };
}

describe('buildMissionLetter', () => {
  it('génère les missions, obligations, honoraires, durée, médiation/RGPD et deux signatures', () => {
    const document = buildMissionLetter(input());

    expect(document.disclaimer).toBe(MISSION_LETTER_DISCLAIMER);
    expect(document.sections.map((section) => section.id)).toEqual([
      'object',
      'scope',
      'arrangements',
      'client_obligations',
      'cabinet_obligations',
      'fees',
      'duration',
      'confidentiality',
      'mediation',
      'data_protection',
      'acceptance',
    ]);
    expect(document.sections.find((section) => section.id === 'scope')?.items).toEqual(
      expect.arrayContaining([
        expect.stringContaining('Tenue de la comptabilité'),
        expect.stringContaining('Établissement des comptes annuels'),
        expect.stringContaining('Déclarations fiscales'),
      ]),
    );
    expect(
      document.sections.find((section) => section.id === 'client_obligations')?.items.join(' '),
    ).toContain('informations et justificatifs complets');
    expect(
      document.sections.find((section) => section.id === 'cabinet_obligations')?.items.join(' '),
    ).toContain('secret professionnel');
    expect(
      document.sections.find((section) => section.id === 'fees')?.paragraphs.join(' '),
    ).toContain('240,00 € HT par mois');
    expect(
      document.sections.find((section) => section.id === 'duration')?.paragraphs.join(' '),
    ).toContain('Préavis convenu : 3 mois');
    expect(
      document.sections.find((section) => section.id === 'mediation')?.paragraphs.join(' '),
    ).toContain('Médiateur indiqué par le cabinet');
    expect(
      document.sections.find((section) => section.id === 'data_protection')?.paragraphs.join(' '),
    ).toContain('réclamation auprès de la CNIL');
    expect(document.signatures.map((signature) => signature.party)).toEqual(['cabinet', 'client']);
    expect(
      document.signatures.every((signature) => signature.approvalMention === 'Bon pour accord'),
    ).toBe(true);
  });

  it('couvre aussi une tarification horaire et une durée indéterminée sans reconduction', () => {
    const document = buildMissionLetter(
      input({
        fees: {
          kind: 'hourly',
          hourlyRateExcludingTaxCents: 12_000,
          estimatedHours: 18.5,
          paymentTerms: 'Facturation mensuelle des temps réalisés.',
          revisionTerms: 'Taux révisable uniquement après accord écrit.',
          expensesPolicy: 'Aucun débours sans accord préalable.',
        },
        duration: {
          startsOn: '2026-08-01',
          term: 'indefinite',
          endsOn: null,
          renewal: 'none',
          noticeMonths: 1,
          terminationTerms: 'Notification écrite par chaque partie.',
        },
      }),
    );

    expect(document.sections.find((section) => section.id === 'fees')?.paragraphs[0]).toContain(
      '120,00 € HT par heure, sur une estimation de 18.5 heure(s)',
    );
    expect(document.sections.find((section) => section.id === 'duration')?.paragraphs).toEqual(
      expect.arrayContaining([
        expect.stringContaining('durée indéterminée'),
        "Aucune reconduction tacite n'est prévue.",
      ]),
    );
  });

  it('rend les limitations de médiation et RGPD visibles quand les informations manquent', () => {
    const complete = input();
    const {
      mediation: _mediation,
      dataProtection: _dataProtection,
      workingArrangements: _workingArrangements,
      ...withoutOptionalDetails
    } = complete;
    const document = buildMissionLetter(withoutOptionalDetails);
    const text = renderMissionLetterPlainText(document);

    expect(text).toContain('à compléter et vérifier avant signature');
    expect(text).toContain('client professionnel ne doit pas être présumée');
    expect(text).toContain('doit être qualifié traitement par traitement');
    expect(text).toContain('[durées ou critères de conservation à compléter]');
    expect(text.startsWith('LETTRE DE MISSION')).toBe(true);
    expect(text.split(MISSION_LETTER_DISCLAIMER)).toHaveLength(3);
  });

  it('neutralise les balises fournies par un utilisateur et ne génère aucun HTML', () => {
    const document = buildMissionLetter(
      input({
        cabinet: {
          ...input().cabinet,
          name: '<img src=x onerror=alert(1)> Cabinet',
        },
        client: {
          ...input().client,
          activity: '<script>alert("x")</script>',
        },
      }),
    );
    const text = renderMissionLetterPlainText(document);

    expect(text).not.toContain('<img');
    expect(text).not.toContain('<script');
    expect(text).not.toContain('</script>');
    expect(text).toContain('‹img src=x onerror=alert(1)›');
    expect(text).toContain('‹script›alert("x")‹/script›');
  });

  it('impose le disclaimer sans accepter de surcharge depuis les données du formulaire', () => {
    const document = buildMissionLetter(input({ reference: 'Référence libre' }));
    const text = renderMissionLetterPlainText(document);

    expect(document.disclaimer).toBe(
      'Modèle indicatif à adapter et faire valider — ne constitue pas un conseil juridique.',
    );
    expect(text).toContain(document.disclaimer);
  });
});

describe('validation de la lettre de mission', () => {
  it('refuse une lettre sans mission', () => {
    expect(() => buildMissionLetter(input({ missions: [] }))).toThrowError(MissionLetterInputError);
    expect(() => buildMissionLetter(input({ missions: [] }))).toThrowError(/Au moins une mission/);
  });

  it('refuse les missions dupliquées, un SIREN incomplet et des honoraires non positifs', () => {
    expect(() => buildMissionLetter(input({ missions: ['review', 'review'] }))).toThrowError(
      /qu’une fois/,
    );
    expect(() =>
      buildMissionLetter(input({ client: { ...input().client, siren: '1234' } })),
    ).toThrowError(/neuf chiffres/);
    expect(() =>
      buildMissionLetter(
        input({
          fees: {
            kind: 'fixed',
            amountExcludingTaxCents: 0,
            frequency: 'monthly',
            paymentTerms: 'À réception.',
            revisionTerms: 'Après accord écrit.',
            expensesPolicy: 'Au coût réel.',
          },
        }),
      ),
    ).toThrowError(/forfait HT doit être positif/);
  });

  it('refuse une période déterminée sans fin ou chronologiquement impossible', () => {
    expect(() =>
      buildMissionLetter(input({ duration: { ...input().duration, endsOn: null } })),
    ).toThrowError(/exige une date de fin/);
    expect(() =>
      buildMissionLetter(input({ duration: { ...input().duration, endsOn: '2026-07-31' } })),
    ).toThrowError(/doit suivre la date de début/);
    expect(() =>
      buildMissionLetter(
        input({
          duration: {
            startsOn: '2026-08-01',
            term: 'indefinite',
            endsOn: null,
            renewal: 'tacit',
            noticeMonths: 1,
            terminationTerms: 'Notification écrite.',
          },
        }),
      ),
    ).toThrowError(/ne peut pas être renouvelée tacitement/);
  });
});
