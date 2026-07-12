import { describe, it, expect } from 'vitest';
import { parseVoiceChoice, speakableQuestion } from './voice-choice';
import { type AgentQuestionOption } from '../agent/bob-agent';

const OPTIONS: AgentQuestionOption[] = [
  { value: 'D-2026-0002', label: 'D-2026-0002', description: 'SARL Martin Rénovation · 1 628,00 €', followUp: 'Fais la facture du devis D-2026-0002' },
  { value: 'D-2026-0005', label: 'D-2026-0005', description: 'Boulangerie Lefèvre · 3 025,00 € — acompte 40 % prévu', followUp: 'Fais la facture du devis D-2026-0005' },
];

describe('parseVoiceChoice (LIVE-1) — fail-safe : univoque ou rien', () => {
  it('ordinaux parlés : « le deuxième », « la première », « le dernier »', () => {
    expect(parseVoiceChoice('le deuxième', OPTIONS)).toBe(1);
    expect(parseVoiceChoice('La première s’il te plaît', OPTIONS)).toBe(0);
    expect(parseVoiceChoice('prends le dernier', OPTIONS)).toBe(1);
  });

  it('nom du client (dans la description) : « celui de la boulangerie », « Lefèvre », « Martin »', () => {
    expect(parseVoiceChoice('celui de la boulangerie', OPTIONS)).toBe(1);
    expect(parseVoiceChoice('Lefèvre', OPTIONS)).toBe(1);
    expect(parseVoiceChoice('le devis de Martin', OPTIONS)).toBe(0);
  });

  it('numéro de pièce dit à la voix : « le 0005 », zéros de tête tolérés', () => {
    expect(parseVoiceChoice('le 0005', OPTIONS)).toBe(1);
    expect(parseVoiceChoice('prends le 2026-0002', OPTIONS)).toBe(0);
  });

  it('ambigu ou hors sujet → null, JAMAIS de devinette', () => {
    expect(parseVoiceChoice('euh je sais pas', OPTIONS)).toBeNull();
    expect(parseVoiceChoice('le devis', OPTIONS)).toBeNull(); // mot non discriminant
    // « rénovation » matche Martin (Rénovation) ET rien d'autre → univoque ; mais un mot
    // présent dans DEUX options doit rendre null :
    const twins: AgentQuestionOption[] = [
      { value: 'a', label: 'Facture Dupont', followUp: 'a' },
      { value: 'b', label: 'Avoir Dupont', followUp: 'b' },
    ];
    expect(parseVoiceChoice('Dupont', twins)).toBeNull();
    expect(parseVoiceChoice('l’avoir de Dupont', twins)).toBe(1);
  });

  it('acompte vs finale (ASK-2 mode) : les labels portent le choix', () => {
    const mode: AgentQuestionOption[] = [
      { value: 'deposit', label: "Facture d'acompte (40 %)", description: 'À encaisser maintenant', followUp: 'x' },
      { value: 'final', label: 'Facture finale', description: 'Tout le chantier en une fois', followUp: 'y' },
    ];
    expect(parseVoiceChoice("fais l'acompte", mode)).toBe(0);
    expect(parseVoiceChoice('la finale', mode)).toBe(1);
    expect(parseVoiceChoice('vas-y', mode)).toBeNull();
  });
});

describe('speakableQuestion', () => {
  it('lit la question + options numérotées courtes (labels seuls) + consigne', () => {
    const s = speakableQuestion({
      id: 'q', question: 'Quel devis signé veux-tu facturer ?', header: 'Devis', options: OPTIONS,
    });
    expect(s).toContain('Quel devis signé veux-tu facturer ?');
    expect(s).toContain('1 : D-2026-0002');
    expect(s).toContain('2 : D-2026-0005');
    expect(s).toContain('touchez l’écran');
    expect(s).not.toContain('1 628'); // les montants restent à l'écran
  });
});
