import { frSpokenNumbersToDigits, normalizeVoiceText, type AcreInfo, type FiscalProfileFieldPatch } from '@bob/core';
import { t, type Personality } from '@bob/i18n';
import { formatMonthYear, parseSpokenMonthYear } from './fiscal-dates';
import { findLegalRegimeCombo, type LegalRegimeCombo } from './legal-regime-combos';
import { LEGAL_REGIME_COMBO_LABEL_KEY } from './fiscal-i18n-keys';

/**
 * VOIX DU PROFIL FISCAL (SPEC_EXPERT_FISCAL.md amendement 7 : « la voix ne mute JAMAIS
 * directement : proposition opaque + diff + confirmation »). Ce module ne fait qu'INTERPRÉTER —
 * `matchFiscalVoiceUtterance` retourne une PROPOSITION (jamais une écriture), à charge de l'appelant
 * d'ouvrir la bottom sheet de confirmation pré-remplie et de laisser le TAP déclencher la mutation
 * (parseFiscalProfileFieldPatch, @bob/core, revalide déjà la forme — même garde-fou que l'HTTP).
 */
export interface FiscalVoiceLegalRegimeProposal {
  readonly kind: 'legal_regime';
  readonly combo: LegalRegimeCombo;
  readonly say: string;
}
export interface FiscalVoiceFieldProposal {
  readonly kind: 'field';
  readonly patch: FiscalProfileFieldPatch;
  readonly say: string;
}
export type FiscalVoiceProposal = FiscalVoiceLegalRegimeProposal | FiscalVoiceFieldProposal;

const AFFIRMATION = /\b(je suis|j ai|je fais|je reste)\b/;
/** Écarte les questions (« c'est quoi… », « est-ce que… ») — un énoncé interrogatif n'est jamais
 * une déclaration de statut, même s'il nomme une forme juridique. */
const QUESTION = /\b(quoi|quel|quelle|comment|pourquoi|combien|difference|differences|est ce que)\b/;

function matchLegalRegimeUtterance(n: string, personality: Personality): FiscalVoiceLegalRegimeProposal | null {
  let combo: LegalRegimeCombo | undefined;
  if (/\b(micro entreprise|micro entrepreneur|auto entrepreneur|autoentrepreneur|micro)\b/.test(n)) {
    combo = findLegalRegimeCombo('micro', 'micro');
  } else if (/\bsasu\b/.test(n)) {
    combo = findLegalRegimeCombo('SASU', 'is');
  } else if (/\bsarl\b/.test(n)) {
    combo = findLegalRegimeCombo('SARL', 'is');
  } else if (/\bsas\b/.test(n)) {
    combo = findLegalRegimeCombo('SAS', 'is');
  } else if (/\beurl\b/.test(n)) {
    const wantsIs = /\b(a l is|impot sur les societes)\b/.test(n);
    combo = findLegalRegimeCombo('EURL', wantsIs ? 'is' : 'reel_ir');
  } else if (/\bentreprise individuelle\b|\bei\b/.test(n)) {
    combo = findLegalRegimeCombo('EI', 'reel_ir');
  }
  if (!combo) return null;
  if (!AFFIRMATION.test(n) || QUESTION.test(n)) return null; // filtre grossier : déclaration attendue.

  const label = t(LEGAL_REGIME_COMBO_LABEL_KEY[combo.id]!, { personality });
  return {
    kind: 'legal_regime',
    combo,
    say: t('fiscal.voice.confirmLegalRegime', { personality, params: { label } }),
  };
}

function matchAcreUtterance(n: string, personality: Personality): FiscalVoiceFieldProposal | null {
  if (!/\bacre\b/.test(n)) return null;
  const negated = /\b(pas|aucune|jamais)\b[^.]{0,15}\bacre\b/.test(n) || /\bacre\b[^.]{0,15}\bpas\b/.test(n);
  if (negated) {
    return {
      kind: 'field',
      patch: { field: 'acre', value: { granted: false } },
      say: t('fiscal.voice.confirmAcreNotGranted', { personality }),
    };
  }

  const digits = frSpokenNumbersToDigits(n);
  const date = parseSpokenMonthYear(digits);
  const value: AcreInfo = date ? { granted: true, startDate: date } : { granted: true };
  const say = date
    ? t('fiscal.voice.confirmAcreGranted', { personality, params: { date: formatMonthYear(date) } })
    : t('fiscal.voice.confirmAcreGrantedNoDate', { personality });
  return { kind: 'field', patch: { field: 'acre', value }, say };
}

function matchVersementLiberatoireUtterance(n: string, personality: Personality): FiscalVoiceFieldProposal | null {
  if (!/\bversement liberatoire\b/.test(n)) return null;
  const negated =
    /\b(pas|aucun|sans)\b[^.]{0,25}\bversement liberatoire\b/.test(n) ||
    /\bversement liberatoire\b[^.]{0,15}\bpas\b/.test(n);
  if (negated) {
    return {
      kind: 'field',
      patch: { field: 'versementLiberatoire', value: false },
      say: t('fiscal.voice.confirmVlNo', { personality }),
    };
  }
  return {
    kind: 'field',
    patch: { field: 'versementLiberatoire', value: true },
    say: t('fiscal.voice.confirmVlYes', { personality }),
  };
}

/**
 * Interprète UN énoncé libre (déjà transcrit STT) en proposition de profil fiscal, ou `null` si
 * rien de reconnu (l'appelant laisse alors la main au cerveau générique de l'agent). Teste
 * legalRegime AVANT acre/VL : « je suis en micro » ne doit jamais être confondu avec une mention
 * d'ACRE/VL qui suivrait dans la même phrase.
 */
export function matchFiscalVoiceUtterance(utterance: string, personality: Personality): FiscalVoiceProposal | null {
  const n = normalizeVoiceText(utterance);
  return (
    matchLegalRegimeUtterance(n, personality) ??
    matchAcreUtterance(n, personality) ??
    matchVersementLiberatoireUtterance(n, personality)
  );
}
