import { describe, it, expect } from 'vitest';
import { buildActionDiff } from './action-diff';

describe('buildActionDiff', () => {
  it('encaisser (solde complet) : reste dû -> 0 et statut Payée', () => {
    const d = buildActionDiff('encaisser_facture', { amountCents: 48840 }, { number: '2026-014', remainingCents: 48840 });
    expect(d).not.toBeNull();
    expect(d!.tool).toBe('encaisser_facture');
    const reste = d!.fields.find((f) => f.label === 'Reste dû');
    expect(reste?.after).toContain('0,00');
    expect(d!.fields.find((f) => f.label === 'Statut')?.after).toBe('Payée');
    expect(d!.title).toContain('2026-014');
  });

  it('encaisser (partiel) : reste > 0 -> statut Partielle', () => {
    const d = buildActionDiff('encaisser_facture', { amountCents: 20000 }, { remainingCents: 48840 });
    expect(d!.fields.find((f) => f.label === 'Statut')?.after).toBe('Partielle');
  });

  it('émettre : brouillon -> émise + numéro attribué', () => {
    const d = buildActionDiff('emettre_facture', {}, {});
    expect(d!.fields[0]!.before).toBe('Brouillon');
    expect(d!.fields[0]!.after).toBe('Émise');
    expect(d!.fields.find((f) => f.label === 'Numéro légal')?.after).toContain('attribué');
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
});
