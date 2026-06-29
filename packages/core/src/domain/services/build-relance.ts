import { formatEUR } from '../../format/money';

export type RelanceTone = 'cordial' | 'neutre' | 'ferme' | 'miseendemeure';

export interface RelanceMessage {
  subject: string;
  body: string;
}

export function buildRelance(input: {
  customerName: string;
  docNumber: string;
  amountCents: number;
  daysLate: number;
  tone: RelanceTone;
  personality: 'Pote' | 'Pro' | 'Direct';
}): RelanceMessage {
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
        body: `Madame, Monsieur (${input.customerName}), faute de reglement de la facture ${input.docNumber} (${amount}) echue depuis ${input.daysLate} jours, la presente vaut mise en demeure. Conformement a l'art. L441-10 du code de commerce, des penalites de retard et une indemnite forfaitaire de recouvrement de 40 € sont dues.`,
      };
  }
}
