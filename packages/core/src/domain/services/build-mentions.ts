import { type Company } from '../company/company';
import { type Customer } from '../customer/customer';
import { type LineCategory } from '../billing/shared/line-item';

export type OperationNature = 'biens' | 'services' | 'mixte';

const NATURE_LABEL: Record<OperationNature, string> = {
  biens: 'Livraison de biens',
  services: 'Prestation de services',
  mixte: 'Opérations mixtes (livraison de biens et prestation de services)',
};

/** Nature des opérations à partir des catégories de lignes (mention obligatoire réforme 2026/2027). */
export function operationNatureOf(lines: readonly { category: LineCategory }[]): OperationNature {
  const hasBiens = lines.some((l) => l.category === 'supply');
  const hasServices = lines.some((l) => l.category !== 'supply');
  return hasBiens && hasServices ? 'mixte' : hasBiens ? 'biens' : 'services';
}

export interface BuildMentionsInput {
  company: Company;
  customer: Customer;
  kind: 'quote' | 'invoice';
  asOf: string;
  validUntilDays?: number;
  /** Nature des opérations (obligatoire sur facture dès la réforme). */
  operationNature?: OperationNature;
}

export function buildMentions(input: BuildMentionsInput): string[] {
  const { company, customer, kind } = input;
  const m: string[] = [];
  m.push(`${company.name} — ${company.address.line1}, ${company.address.zip} ${company.address.city}`);
  if (company.rcsOrRm) m.push(company.rcsOrRm);

  // Réforme 2026/2027 : le SIREN du client (assujetti) devient une mention obligatoire en B2B/B2G.
  if (customer.type !== 'b2c' && customer.siren) m.push(`Client — SIREN ${customer.siren}`);
  // Nature des opérations (livraison de biens / prestation de services) — obligatoire sur facture.
  if (kind === 'invoice' && input.operationNature) m.push(`Nature de l'opération : ${NATURE_LABEL[input.operationNature]}`);

  if (company.isVatFranchise()) {
    // Réforme : à compter du 1er sept. 2026, la franchise en base relève du CIBS (Code des impositions
    // sur les biens et services) ; mention « art. 293 B du CGI » tolérée jusqu'au 31/12/2027.
    // NB : l'article CIBS exact est à confirmer sur le décret définitif avant mise en prod.
    const cibs = input.asOf >= '2026-09-01';
    m.push(cibs ? 'TVA non applicable — franchise en base (CIBS)' : 'TVA non applicable, art. 293 B du CGI');
  }
  if (company.requiresAutoliquidation({ type: customer.type, isSubcontractingBtp: customer.isSubcontractingBtp })) {
    m.push('Autoliquidation de la TVA (sous-traitance BTP, art. 283-2 nonies du CGI)');
  }

  m.push(
    'En cas de retard de paiement : penalites au taux legal en vigueur et indemnite forfaitaire de recouvrement de 40 € (art. L441-10 du code de commerce).',
  );

  if (company.isBtp() && company.decennale) {
    const d = company.decennale;
    m.push(`Assurance decennale : ${d.insurer}, police n°${d.policyNo}, couverture ${d.coverage}.`);
  }

  // À COMPLÉTER (réforme) quand les champs existeront au modèle : adresse de livraison si distincte de
  // la facturation, et option « TVA sur les débits » si l'entreprise l'a exercée. Conservation légale
  // des factures émises/reçues = 10 ans (règle d'archivage, hors mention imprimée).

  if (kind === 'quote') {
    m.push('Devis gratuit.');
    if (input.validUntilDays) m.push(`Devis valable ${input.validUntilDays} jours.`);
    m.push('Bon pour accord (date + signature) :');
  }
  return m;
}
