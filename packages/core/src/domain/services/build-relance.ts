import { formatEUR } from '../../format/money';
import { type CustomerType } from '../customer/customer';

export type RelanceTone = 'cordial' | 'neutre' | 'ferme' | 'miseendemeure';

export interface RelanceMessage {
  subject: string;
  body: string;
}

export interface BuildRelanceInput {
  customerName: string;
  docNumber: string;
  amountCents: number;
  daysLate: number;
  tone: RelanceTone;
  personality: 'Pote' | 'Pro' | 'Direct';
  /**
   * Type de client — pilote le RÉGIME JURIDIQUE de la mise en demeure (P01, C-EXP1) :
   * · b2b — art. L441-10 C. com : pénalités de retard + indemnité forfaitaire 40 € (débiteurs
   *   professionnels uniquement) ;
   * · b2c — code civil : mise en demeure art. 1344, intérêts moratoires au TAUX LÉGAL à compter
   *   de la mise en demeure (art. 1344-1 et 1231-6) — JAMAIS de 40 €, JAMAIS de L441-10 ;
   * · b2g — code de la commande publique : intérêts moratoires au taux BCE majoré de 8 points
   *   + indemnité forfaitaire 40 €, dus de plein droit (art. L2192-12 et L2192-13 CCP).
   */
  customerType: CustomerType;
  /**
   * Pénalités CHIFFRÉES (P12, C-EXP2 vA — sortie de computeLatePenalties) : fournies, la mise
   * en demeure B2B/B2G les ÉNONCE (« à ce jour, X de pénalités et 40 € d'indemnité, soit un
   * total de Y ») ; absentes, le texte actuel est inchangé (compat ascendante). IGNORÉES en
   * b2c : aucune pénalité de plein droit — la MED fait COURIR les intérêts, elle ne peut pas
   * en réclamer (art. 1344-1 C. civ), et jamais de 40 € (D441-5 vise les professionnels).
   */
  penalties?: {
    /** Intérêts/pénalités de retard courus à ce jour, en centimes. */
    interestCents: number;
    /** Indemnité forfaitaire de recouvrement en centimes (D441-5 / L2192-13 : 4000). */
    fixedIndemnityCents: number;
  };
}

/**
 * Mise en demeure conforme au régime du débiteur — les paliers cordial/neutre/ferme sont communs
 * (aucune référence légale), seul le dernier palier cite les textes applicables au type de client.
 * Pénalités fournies (P12) : la MED B2B/B2G devient CHIFFRÉE — fini « l'argent dû de plein droit,
 * abandonné » ; sans montants fournis, textes historiques inchangés.
 */
function miseEnDemeureBody(input: BuildRelanceInput, amount: string): string {
  const opening = `Madame, Monsieur (${input.customerName}), faute de reglement de la facture ${input.docNumber} (${amount}) echue depuis ${input.daysLate} jours`;
  const p = input.penalties;
  const total = p !== undefined ? formatEUR(input.amountCents + p.interestCents + p.fixedIndemnityCents) : '';
  switch (input.customerType) {
    case 'b2c':
      // Jamais de chiffres réclamés ici : la MED est le point de DÉPART des intérêts (1344-1).
      return `${opening}, la presente vaut mise en demeure au sens de l'art. 1344 du code civil. A defaut de reglement, des interets moratoires au taux legal courront a compter de la presente mise en demeure (art. 1344-1 et 1231-6 du code civil).`;
    case 'b2g': {
      const base = `${opening}, la presente vaut mise en demeure. Conformement aux art. L2192-12 et L2192-13 du code de la commande publique, des interets moratoires au taux de la BCE majore de 8 points et une indemnite forfaitaire de recouvrement de 40 € sont dus de plein droit`;
      if (p === undefined) return `${base}.`;
      return `${base} : a ce jour, ${formatEUR(p.interestCents)} d'interets moratoires et ${formatEUR(p.fixedIndemnityCents)} d'indemnite forfaitaire, soit un total de ${total}.`;
    }
    case 'b2b': {
      const base = `${opening}, la presente vaut mise en demeure. Conformement a l'art. L441-10 du code de commerce, des penalites de retard et une indemnite forfaitaire de recouvrement de 40 € sont dues`;
      if (p === undefined) return `${base}.`;
      return `${base} : a ce jour, ${formatEUR(p.interestCents)} de penalites de retard et ${formatEUR(p.fixedIndemnityCents)} d'indemnite forfaitaire (art. D441-5 du code de commerce), soit un total de ${total}.`;
    }
  }
}

export function buildRelance(input: BuildRelanceInput): RelanceMessage {
  const amount = formatEUR(input.amountCents);
  const tu = input.personality === 'Pote';
  const subjectBase = `Facture ${input.docNumber}`;
  switch (input.tone) {
    case 'cordial':
      return {
        subject: `${subjectBase} — petit rappel`,
        body: tu
          ? `Salut ${input.customerName}, petit rappel pour ta facture ${input.docNumber} de ${amount}. Quand tu peux ! Merci.`
          : `Bonjour ${input.customerName}, nous vous rappelons la facture ${input.docNumber} d'un montant de ${amount}. Cordialement.`,
      };
    case 'neutre':
      return {
        subject: `${subjectBase} — relance`,
        body: `Bonjour ${input.customerName}, la facture ${input.docNumber} (${amount}) reste impayee a ce jour (${input.daysLate} jours). Merci de proceder au reglement.`,
      };
    case 'ferme':
      return {
        subject: `${subjectBase} — relance ferme`,
        body: `Bonjour ${input.customerName}, malgre nos relances, la facture ${input.docNumber} (${amount}) demeure impayee depuis ${input.daysLate} jours. Un reglement sous 8 jours est imperatif.`,
      };
    case 'miseendemeure':
      return {
        subject: `Mise en demeure — ${subjectBase}`,
        body: miseEnDemeureBody(input, amount),
      };
  }
}
