import { describe, expect, it } from 'vitest';
import { auditRealtimeUtterance, realtimeConsentDecision } from './agent-bridge';

const TOOL_RESULTS = [
  { callId: '1', ok: true, payload: 'Facture 2026-014 — reste dû 415,80 €, échéance 20/07/2026, acompte 30 %' },
];

describe('auditRealtimeUtterance — condition 1 : aucun montant improvisé à l’oral', () => {
  it('un énoncé fidèle aux faits d’outils passe (l’omission est un droit)', () => {
    const v = auditRealtimeUtterance('Il te reste 415,80 € à encaisser sur la 2026-014.', TOOL_RESULTS);
    expect(v.ok).toBe(true);
    expect(v.correction).toBeNull();
  });

  it('un montant INVENTÉ ou DÉFORMÉ déclenche violation + correction préparée', () => {
    const v = auditRealtimeUtterance('Il te reste 451,80 € à encaisser.', TOOL_RESULTS);
    expect(v.ok).toBe(false);
    expect(v.violations).toContain('451,80€');
    expect(v.correction).toContain('Correction');
  });

  it('un pourcentage étranger aux outils est aussi une violation', () => {
    const v = auditRealtimeUtterance('Ton acompte est de 45 %.', TOOL_RESULTS);
    expect(v.ok).toBe(false);
  });

  it('sans fait chiffré prononcé, jamais de faux positif', () => {
    expect(auditRealtimeUtterance('Je te prépare ça tout de suite.', TOOL_RESULTS).ok).toBe(true);
    expect(auditRealtimeUtterance('Bonjour !', []).ok).toBe(true);
  });
});

describe('realtimeConsentDecision — condition 2 : le modèle ne consent jamais seul', () => {
  it('proposition en attente : « oui je confirme » applique, « non annule » rejette — verbatim, parseur déterministe', () => {
    expect(realtimeConsentDecision('oui je confirme', true)).toEqual({ kind: 'apply' });
    expect(realtimeConsentDecision('non, annule', true)).toEqual({ kind: 'reject' });
  });

  it('ambigu ou négation → pass (rien ne s’exécute, la conversation continue)', () => {
    expect(realtimeConsentDecision('euh peut-être', true)).toEqual({ kind: 'pass' });
    expect(realtimeConsentDecision('ne confirme pas', true)).toEqual({ kind: 'pass' });
  });

  it('sans proposition en attente, tout passe au flux normal', () => {
    expect(realtimeConsentDecision('oui je confirme', false)).toEqual({ kind: 'pass' });
  });
});
