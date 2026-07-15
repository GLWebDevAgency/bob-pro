import { describe, expect, it } from 'vitest';
import { matchFiscalVoiceUtterance } from './fiscal-voice';

describe('matchFiscalVoiceUtterance', () => {
  it('« je suis en micro » propose le couple micro/micro', () => {
    const p = matchFiscalVoiceUtterance('Bob, je suis en micro', 'pote');
    expect(p).toMatchObject({ kind: 'legal_regime', combo: { legalForm: 'micro', taxRegime: 'micro' } });
    expect(p?.say.length).toBeGreaterThan(0);
  });

  it('« je suis en SASU » propose SASU/is', () => {
    const p = matchFiscalVoiceUtterance('je suis en SASU', 'pro');
    expect(p).toMatchObject({ kind: 'legal_regime', combo: { legalForm: 'SASU', taxRegime: 'is' } });
  });

  it('« je suis en EURL à l’IS » propose EURL/is (branche distincte de EURL/IR par défaut)', () => {
    const defaultCase = matchFiscalVoiceUtterance('je suis en EURL', 'pote');
    expect(defaultCase).toMatchObject({ combo: { legalForm: 'EURL', taxRegime: 'reel_ir' } });

    const isCase = matchFiscalVoiceUtterance('je suis en EURL à l’IS', 'pote');
    expect(isCase).toMatchObject({ combo: { legalForm: 'EURL', taxRegime: 'is' } });
  });

  it('une simple question ne déclenche PAS de proposition (garde-fou affirmation)', () => {
    expect(matchFiscalVoiceUtterance('c’est quoi la différence entre SASU et SARL ?', 'pote')).toBeNull();
  });

  it('« j’ai l’ACRE depuis mars 2026 » propose acre granted avec date', () => {
    const p = matchFiscalVoiceUtterance('j’ai l’ACRE depuis mars 2026', 'pote');
    expect(p).toMatchObject({ kind: 'field', patch: { field: 'acre', value: { granted: true, startDate: '2026-03-01' } } });
  });

  it('« j’ai l’ACRE » sans date propose granted sans startDate', () => {
    const p = matchFiscalVoiceUtterance('j’ai l’ACRE', 'pote');
    expect(p).toMatchObject({ kind: 'field', patch: { field: 'acre', value: { granted: true } } });
    expect((p as { patch: { value: { startDate?: string } } }).patch.value.startDate).toBeUndefined();
  });

  it('« je n’ai pas l’ACRE » propose granted: false', () => {
    const p = matchFiscalVoiceUtterance('je n’ai pas l’ACRE', 'pote');
    expect(p).toMatchObject({ kind: 'field', patch: { field: 'acre', value: { granted: false } } });
  });

  it('« j’ai le versement libératoire » propose true', () => {
    const p = matchFiscalVoiceUtterance('j’ai le versement libératoire', 'pote');
    expect(p).toMatchObject({ kind: 'field', patch: { field: 'versementLiberatoire', value: true } });
  });

  it('« je n’ai pas le versement libératoire » propose false', () => {
    const p = matchFiscalVoiceUtterance('je n’ai pas le versement libératoire', 'pote');
    expect(p).toMatchObject({ kind: 'field', patch: { field: 'versementLiberatoire', value: false } });
  });

  it('énoncé hors-sujet : aucune proposition', () => {
    expect(matchFiscalVoiceUtterance('envoie la facture à Camping Les Pins', 'pote')).toBeNull();
  });
});
