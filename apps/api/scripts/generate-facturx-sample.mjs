// Génère un échantillon Factur-X (PDF hybride + XML CII) pour la validation de conformité en CI
// (Mustang/veraPDF/Schematron EN 16931). Usage : node scripts/generate-facturx-sample.mjs [dossier]
// Pré-requis : fermeture @bob/api buildée + builders de certification @bob/core/testing
// (`pnpm --filter "@bob/api..." build && pnpm --filter @bob/core build:testing`).
import { mkdirSync, writeFileSync } from 'node:fs';
import {
  Invoice,
  DocNumber,
  PaymentTerms,
  FACTURX_EN16931_PROFILE,
  facturXDataFromInvoice,
  buildFacturXBasicXml,
  validateFacturXEn16931,
} from '@bob/core';
import { seedCompany } from '@bob/core/testing';
import { PdfRenderer } from '../dist/documents/pdf-renderer.js';

const unwrap = (r, label) => {
  if (!r || r.ok !== true) {
    console.error(`Échec ${label} :`, r && r.error);
    process.exit(1);
  }
  return r.value;
};

const company = seedCompany();
const inv = unwrap(Invoice.composeStandalone({ id: 'sample', companyId: company.id, customerId: 'cust' }), 'composeStandalone');
inv.addLine({ id: 'l1', label: 'Pose chaudière', category: 'labor', qty: 1, unitPriceHT: 120000, vatRate: 20 });
inv.addLine({ id: 'l2', label: 'Joint', category: 'supply', qty: 2, unitPriceHT: 1500, vatRate: 10 });
inv.assignNumber(DocNumber.format('F', 2026, 1), '2026-06-29T10:00:00Z');
const terms = unwrap(PaymentTerms.of({ days: 30, endOfMonth: false, label: '30 jours' }), 'PaymentTerms');
unwrap(inv.issue({
  mentions: [
    'TVA sur les débits',
    'Escompte pour paiement anticipé : néant.',
    'Pénalités de retard : taux BCE + 10 points (art. L441-10 du code de commerce). Indemnité forfaitaire de recouvrement : 40 € (art. D441-5 du code de commerce).',
  ],
  terms,
  issuedAt: '2026-06-29',
  at: '2026-06-29T10:00:00Z',
  vatTreatment: 'standard',
  frenchBillingMode: 'S1',
}), 'issue');

// Échantillon B2B strict France : toutes les valeurs viennent d'un vrai contrat de données
// (aucun endpoint ou SIREN sentinelle ajouté après sérialisation).
const buyer = {
  name: 'Client Échantillon',
  siren: '821503646',
  tvaIntracom: 'FR37821503646',
  email: 'facturation@client.example',
  type: 'b2b',
  isInternational: false,
  isSubcontractingBtp: false,
  address: { line1: '10 rue de Rivoli', zip: '75004', city: 'Paris' },
};
const data = facturXDataFromInvoice(inv, company, buyer);

const validation = validateFacturXEn16931(data);
if (!validation.valid) {
  console.error('Échantillon non conforme EN 16931 :', validation.violations);
  process.exit(1);
}
const xml = buildFacturXBasicXml(data);
if (!xml.includes(`<ram:ID>${FACTURX_EN16931_PROFILE}</ram:ID>`)) {
  console.error('Le générateur n’émet pas le BT-24 Factur-X EN16931 attendu.');
  process.exit(1);
}

const t = inv.totals();
const pdfData = {
  number: data.number,
  companyName: company.name,
  companyAddress: `${company.address.line1}, ${company.address.zip} ${company.address.city}`,
  companyRcsOrRm: company.rcsOrRm ?? null,
  customerName: buyer.name,
  customerAddress: `${buyer.address.line1}, ${buyer.address.zip} ${buyer.address.city}`,
  issuedAt: inv.issuedAt,
  dueAt: inv.dueAt,
  kind: inv.kind,
  lines: inv.lines.map((l) => ({ label: l.label, qty: l.qty, unitPriceHT: l.unitPriceHT, vatRate: l.vatRate })),
  totals: { ht: t.ht, vat: t.vat, ttc: t.ttc, netToPay: t.netToPay },
  mentions: [...inv.mentions],
  // Présentation explicite, comme pour tout rendu runtime. Le harnais ne doit pas dépendre
  // d'un ancien fallback implicite qui masquerait une rupture du contrat InvoicePdfData.
  billingPresentation: { accentColor: 'navy', rib: null, insurance: null },
};
const bytes = await new PdfRenderer().renderInvoice(pdfData, { xml });

const out = process.argv[2] ?? 'facturx-sample';
mkdirSync(out, { recursive: true });
writeFileSync(`${out}/factur-x.xml`, xml);
writeFileSync(`${out}/facture-x.pdf`, Buffer.from(bytes));
console.log(
  `Échantillon Factur-X EN16931 généré dans ${out}/ (prévalidation Bob verte, ${bytes.length} octets PDF ; certification indépendante à suivre).`,
);
