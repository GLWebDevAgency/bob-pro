import { describe, it, expect } from 'vitest';
import { buildActionDiff } from './action-diff';

describe('buildActionDiff', () => {
  it('encaisser (solde complet) : reste dû -> 0 et statut Payée', () => {
    const d = buildActionDiff(
      'encaisser_facture',
      { amountCents: 48840 },
      { number: '2026-014', remainingCents: 48840 },
    );
    expect(d).not.toBeNull();
    expect(d!.tool).toBe('encaisser_facture');
    const reste = d!.fields.find((f) => f.label === 'Reste dû');
    expect(reste?.after).toContain('0,00');
    expect(d!.fields.find((f) => f.label === 'Statut')?.after).toBe('Payée');
    expect(d!.title).toContain('2026-014');
    expect(d!.accounting).toEqual([
      { account: '512', label: 'Encaissement 2026-014', debitCents: 48840, creditCents: 0 },
      { account: '411', label: 'Encaissement 2026-014', debitCents: 0, creditCents: 48840 },
    ]);
  });

  it('encaisser (partiel) : reste > 0 -> statut Partielle', () => {
    const d = buildActionDiff(
      'encaisser_facture',
      { amountCents: 20000 },
      { remainingCents: 48840 },
    );
    expect(d!.fields.find((f) => f.label === 'Statut')?.after).toBe('Partielle');
    expect(d!.accounting?.map((l) => l.account)).toEqual(['512', '411']);
  });

  it('encaisser en especes : preview 530 / 411', () => {
    const d = buildActionDiff(
      'encaisser_facture',
      { amountCents: 1000, method: 'cash' },
      { number: 'F-1', remainingCents: 1000 },
    );

    expect(d!.accounting?.map((l) => l.account)).toEqual(['530', '411']);
  });

  it('émettre : brouillon -> émise + numéro et délai réellement choisis', () => {
    const d = buildActionDiff('emettre_facture', { paymentTermsDays: 30 }, {});
    expect(d!.fields[0]!.before).toBe('Brouillon');
    expect(d!.fields[0]!.after).toBe('Émise');
    expect(d!.fields.find((f) => f.label === 'Numéro légal')?.after).toContain('attribué');
    expect(d!.fields.find((f) => f.label === 'Échéance')?.after).toBe('30 jours après émission');
  });

  it('envoyer devis : titre porte le numéro, statut brouillon -> envoyé', () => {
    const d = buildActionDiff('envoyer_devis', {}, { number: 'D2026-1' });
    expect(d!.title).toContain('D2026-1');
    expect(d!.fields[0]!.after).toContain('Envoyé');
  });

  it('outil de lecture / inconnu : pas d’aperçu (null)', () => {
    expect(buildActionDiff('factures_impayees', {}, {})).toBeNull();
    expect(buildActionDiff('inconnu', {}, {})).toBeNull();
  });

  it('émettre : attache l’écriture comptable fournie (débit/crédit)', () => {
    const d = buildActionDiff(
      'emettre_facture',
      {},
      {
        number: 'F2026-001',
        accountingLines: [
          { account: '411', label: 'Client', debitCents: 132000, creditCents: 0 },
          { account: '706', label: 'Prestations', debitCents: 0, creditCents: 110000 },
          { account: '44571', label: 'TVA collectée', debitCents: 0, creditCents: 22000 },
        ],
      },
    );
    expect(d!.accounting).toHaveLength(3);
    expect(d!.accounting!.find((l) => l.account === '411')?.debitCents).toBe(132000);
    // équilibre débit = crédit
    const deb = d!.accounting!.reduce((s, l) => s + l.debitCents, 0);
    const cred = d!.accounting!.reduce((s, l) => s + l.creditCents, 0);
    expect(deb).toBe(cred);
  });

  it('lignes comptables vides (0/0) écartées ; absentes -> pas de champ accounting', () => {
    const withEmpty = buildActionDiff(
      'emettre_facture',
      {},
      {
        accountingLines: [{ account: '411', label: 'x', debitCents: 0, creditCents: 0 }],
      },
    );
    expect(withEmpty!.accounting).toBeUndefined();
    expect(buildActionDiff('emettre_facture', {}, {})!.accounting).toBeUndefined();
  });
});
