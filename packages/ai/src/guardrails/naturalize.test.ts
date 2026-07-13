import { describe, it, expect, vi } from 'vitest';
import { extractFacts, naturalizationViolations, naturalizeReply, shouldNaturalize } from './naturalize';
import { type LlmPort } from '../llm/port';

const fakeLlm = (reply: string): LlmPort => ({
  id: 'fake',
  complete: async () => ({ text: null, toolCalls: [], model: 'fake' }),
  generate: async () => ({ text: reply, model: 'fake' }),
  health: async () => ({ healthy: true }),
});

const INPUT = {
  title: 'Ton délai d’encaissement',
  body: 'Tes clients te paient en 23 jours en moyenne. Immobilisé chez eux : 1 850,00 €. Facture F-2026-0001.',
  userMessage: 'on me paie en combien de temps ?',
  tone: 'pote' as const,
};

const SAFE_INPUT = {
  title: 'Bob',
  body: 'Je peux t’aider avec ton administratif.',
  userMessage: 'que peux-tu faire ?',
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
    const r = await naturalizeReply(fakeLlm('Je peux te filer un coup de main pour ton administratif.'), SAFE_INPUT);
    expect(r).toContain('coup de main');
  });

  it('violation factuelle → null (le gabarit reste)', async () => {
    expect(await naturalizeReply(fakeLlm('Tu peux te verser 9 999,99 €.'), SAFE_INPUT)).toBeNull();
  });

  it('LLM vide, débordant ou en erreur → null', async () => {
    expect(await naturalizeReply(fakeLlm(''), SAFE_INPUT)).toBeNull();
    expect(await naturalizeReply(fakeLlm('blabla '.repeat(100)), SAFE_INPUT)).toBeNull();
    const broken: LlmPort = {
      id: 'x',
      complete: async () => ({ text: null, toolCalls: [], model: 'x' }),
      generate: async () => { throw new Error('down'); },
      health: async () => ({ healthy: false }),
    };
    expect(await naturalizeReply(broken, SAFE_INPUT)).toBeNull();
  });
});

describe('shouldNaturalize — frontière de confidentialité cloud', () => {
  it('garde la naturalisation uniquement pour une carte générique sans faits sensibles', () => {
    expect(shouldNaturalize(SAFE_INPUT)).toBe(true);
    expect(shouldNaturalize(INPUT)).toBe(false); // montant + numéro de pièce
    expect(shouldNaturalize({ ...SAFE_INPUT, body: 'Acompte prévu : 40 %.' })).toBe(false);
    expect(shouldNaturalize({ ...SAFE_INPUT, sensitiveContext: true })).toBe(false);
  });

  it('n’appelle jamais le LLM pour un titre/body monétaire ou numéroté', async () => {
    const generate = vi.fn(async () => ({ text: 'ne doit jamais sortir', model: 'fake' }));
    const llm: LlmPort = {
      id: 'capture',
      complete: async () => ({ text: null, toolCalls: [], model: 'fake' }),
      generate,
      health: async () => ({ healthy: true }),
    };

    expect(await naturalizeReply(llm, INPUT)).toBeNull();
    expect(generate).not.toHaveBeenCalled();
  });

  it('n’appelle jamais le LLM pour un résumé contextuel, même sans chiffre détectable', async () => {
    const generate = vi.fn(async () => ({ text: 'ne doit jamais sortir', model: 'fake' }));
    const llm: LlmPort = {
      id: 'capture',
      complete: async () => ({ text: null, toolCalls: [], model: 'fake' }),
      generate,
      health: async () => ({ healthy: true }),
    };
    const contextual = {
      ...SAFE_INPUT,
      title: 'Facture Martin',
      body: 'Le client est Martin et le statut est brouillon.',
      sensitiveContext: true,
    };

    expect(await naturalizeReply(llm, contextual)).toBeNull();
    expect(generate).not.toHaveBeenCalled();
  });
});
