import { describe, it, expect } from 'vitest';
import { extractFacts, naturalizationViolations, naturalizeReply } from './naturalize';
import { type LlmPort } from '../llm/port';

const fakeLlm = (reply: string): LlmPort => ({
  id: 'fake',
  complete: async () => ({ text: null, toolCalls: [], model: 'fake' }),
  generate: async () => ({ text: reply, model: 'fake' }),
});

const INPUT = {
  title: 'Ton délai d’encaissement',
  body: 'Tes clients te paient en 23 jours en moyenne. Immobilisé chez eux : 1 850,00 €. Facture F-2026-0001.',
  userMessage: 'on me paie en combien de temps ?',
  tone: 'pote' as const,
};

describe('naturalizationViolations — le garde factuel', () => {
  it('reformulation fidèle (montants/pièces identiques, omission tolérée) : aucune violation', () => {
    expect(naturalizationViolations(INPUT.body, 'En gros on te paie en 23 jours, et 1 850,00 € dorment chez tes clients.')).toEqual([]);
    expect(naturalizationViolations(INPUT.body, 'On te paie plutôt vite.')).toEqual([]); // condenser est un droit
  });

  it('montant DÉFORMÉ ou INVENTÉ : violation', () => {
    expect(naturalizationViolations(INPUT.body, 'Environ 1 900,00 € dorment chez tes clients.')).toHaveLength(1);
    expect(naturalizationViolations(INPUT.body, 'Tu pourrais te verser 3 000 € en plus.')).toHaveLength(1);
  });

  it('numéro de pièce inventé : violation ; espaces insécables normalisés', () => {
    expect(naturalizationViolations(INPUT.body, 'Regarde la facture F-2026-0099.')).toHaveLength(1);
    expect(naturalizationViolations('Total 1 850,00 €', 'Ça fait 1 850,00 €.')).toEqual([]);
  });

  it('pourcentage : extrait et comparé', () => {
    expect(extractFacts('acompte de 40 % prévu').has('40%')).toBe(true);
    expect(naturalizationViolations('acompte de 40 %', 'un acompte de 30 % est prévu')).toHaveLength(1);
  });
});

describe('naturalizeReply — fallback inconditionnel', () => {
  it('reformulation valide → texte naturel', async () => {
    const r = await naturalizeReply(fakeLlm('On te paie en 23 jours — et 1 850,00 € dorment encore chez tes clients.'), INPUT);
    expect(r).toContain('23 jours');
  });

  it('violation factuelle → null (le gabarit reste)', async () => {
    expect(await naturalizeReply(fakeLlm('On te doit 9 999,99 € environ.'), INPUT)).toBeNull();
  });

  it('LLM vide, débordant ou en erreur → null', async () => {
    expect(await naturalizeReply(fakeLlm(''), INPUT)).toBeNull();
    expect(await naturalizeReply(fakeLlm('blabla '.repeat(100)), INPUT)).toBeNull();
    const broken: LlmPort = { id: 'x', complete: async () => ({ text: null, toolCalls: [], model: 'x' }), generate: async () => { throw new Error('down'); } };
    expect(await naturalizeReply(broken, INPUT)).toBeNull();
  });
});
