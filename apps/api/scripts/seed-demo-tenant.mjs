#!/usr/bin/env node
/**
 * SEED DE DONNÉES DE TEST — tenant démo (demande fondateur 17/07, compte « Mercier Plomberie »
 * vide depuis le passage BDD-only).
 *
 * Injecte un jeu RÉALISTE et cohérent, STRICTEMENT tenant-scoped, via les USE CASES du
 * BackendService compilé (dist/) — jamais du Prisma brut : numéros légaux, acomptes,
 * plafond netToPay, écritures comptables et RLS (runWithTenant) sont respectés par
 * construction, exactement comme les tests pont-serveur.
 *
 * Contenu : 6 clients (dont Mairie de Sèvres, Boulangerie Lefèvre, SARL Martin Rénovation),
 * 8 prestations catalogue (le catalogue EST server-side : /catalogue/prestations),
 * 11 devis (brouillons / envoyés / signés avec acomptes), 8 factures (payées / partielles /
 * en retard), paiements partiels, 2 chantiers avec notes, 10 dépenses étalées janvier→juillet
 * 2026, 1 solde bancaire confirmé. TOUT en centimes.
 *
 * SÉCURITÉS :
 *  - refuse de tourner si le tenant possède déjà > 2 devis (sauf --force) ;
 *  - AUCUN client seedé ne porte d'e-mail + livraison de notifications neutralisée (stub) :
 *    zéro sortant possible, aujourd'hui comme par les crons futurs ;
 *  - toutes les écritures passent sous runWithTenant(companyId) (GUC RLS) + Principal du
 *    tenant cible : impossible de toucher un autre tenant.
 *
 * PRÉREQUIS (une fois) :
 *   pnpm --filter @bob/core build && pnpm --filter @bob/ai build && pnpm --filter @bob/api build
 *
 * EXÉCUTION (env Railway injecté localement — remplacer <service-api> par le service API) :
 *   railway run --service <service-api> -- node apps/api/scripts/seed-demo-tenant.mjs <COMPANY_ID>
 *   railway run --service <service-api> -- node apps/api/scripts/seed-demo-tenant.mjs <COMPANY_ID> --force
 *
 * Note : les PDF/Factur-X des factures émises sont archivés par l'outbox d'archives ; les
 * jobs créés ici seront traités par l'API déployée (renderer/storage réels) à son prochain
 * cycle — aucun rendu n'est tenté localement.
 */
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const here = path.dirname(fileURLToPath(import.meta.url));

function fail(message) {
  console.error(`seed-demo-tenant: ${message}`);
  process.exit(1);
}

// ——— Arguments ———
const argv = process.argv.slice(2);
const force = argv.includes('--force');
const positional = argv.filter((a) => !a.startsWith('--'));
if (positional.length !== 1) fail('usage: node scripts/seed-demo-tenant.mjs <COMPANY_ID> [--force]');
const companyId = positional[0];
if (!/^[\x21-\x7e][\x20-\x7e]{0,127}$/.test(companyId)) fail('COMPANY_ID invalide.');

// ——— Préconditions d'environnement ———
if (!process.env.DATABASE_URL) fail('DATABASE_URL manquant (lancer via `railway run --service <service-api> -- …`).');
if (!process.env.SIGN_WEB_BASE_URL) fail('SIGN_WEB_BASE_URL manquant (requis par l’envoi de devis).');
if ((process.env.CABINET_INVITATION_TOKEN_ENCRYPTION_KEY ?? '').length < 32)
  fail('CABINET_INVITATION_TOKEN_ENCRYPTION_KEY manquant/court (requis par la construction PrismaPersistence — présent dans l’env Railway du service API).');

require('reflect-metadata');
const distRoot = path.join(here, '..', 'dist');
let BackendService, PrismaPersistence, PrismaService, requestContext;
try {
  ({ BackendService } = require(path.join(distRoot, 'backend.service.js')));
  ({ PrismaPersistence } = require(path.join(distRoot, 'persistence', 'prisma', 'prisma-persistence.js')));
  ({ PrismaService } = require(path.join(distRoot, 'persistence', 'prisma', 'prisma.service.js')));
  ({ requestContext } = require(path.join(distRoot, 'observability', 'logger.js')));
} catch (e) {
  fail(`dist/ introuvable ou incomplet — construire d'abord l'API (voir PRÉREQUIS en tête de script). Cause : ${e.message}`);
}

// ——— Horloge pilotée : dates réalistes étalées janvier → juillet 2026 ———
// ClockPort { now(): ISO, today(): YYYY-MM-DD } — le champ privé `clock` du service est
// remplacé à chaud (propriété JS ordinaire dans dist/) : numéros, échéances et paiements
// portent la date métier voulue, par les use cases eux-mêmes.
const seedClock = {
  current: Date.parse('2026-01-05T09:00:00.000Z'),
  now() {
    return new Date(this.current).toISOString();
  },
  today() {
    return this.now().slice(0, 10);
  },
  at(iso) {
    const t = Date.parse(iso);
    if (Number.isNaN(t)) throw new Error(`date seed invalide: ${iso}`);
    this.current = t;
  },
};

// ——— Assemblage service (même topologie de stubs que les tests pont-serveur) ———
const prisma = new PrismaService();
const persistence = new PrismaPersistence(prisma);
const quietLogger = {
  audit: () => {},
  log: () => {},
  warn: (...a) => console.warn('[warn]', ...a),
  error: (...a) => console.error('[error]', ...a),
};
// Livraison neutralisée : rien n'entre dans l'outbox de notifications, rien ne partira jamais.
const noopNotificationDelivery = {
  enqueue: async (input) => ({ id: 'seed-noop', status: 'pending', notification: input.notification }),
  tryDeliver: async () => true,
};
const noopMetrics = {
  aiRequests: { inc: () => {} },
  aiDuration: { observe: () => {} },
  aiGuardViolations: { inc: () => {} },
};
const service = new BackendService(
  persistence,
  {}, // PaymentGateway — jamais appelé par le seed
  {}, // PdfRenderer — l'archivage réel est fait par l'API déployée (outbox)
  {}, // OCR — jamais appelé
  { setUserCompanyId: async () => {}, deleteUser: async () => {} },
  noopNotificationDelivery,
  noopMetrics,
  quietLogger,
);
service.clock = seedClock;

// ——— Exécution tenant-scoped : Principal + transaction GUC RLS, comme une requête réelle ———
const principal = { userId: 'seed-demo-tenant', companyId };
const inCtx = (fn) => requestContext.run({ correlationId: 'seed-demo-tenant', principal }, fn);
/** Équivalent du TenantPersistenceInterceptor : chaque geste sous runWithTenant(companyId). */
const run = (label, fn) =>
  inCtx(() => persistence.runWithTenant(companyId, fn)).then((r) => unwrapR(label, r));
/** createQuote gère SES transactions (coordinator, @WithoutTenantPersistenceTransaction). */
const runBare = (label, fn) => inCtx(fn).then((r) => unwrapR(label, r));

function unwrapR(label, r) {
  if (r && typeof r === 'object' && 'ok' in r) {
    if (!r.ok) {
      console.error(`ÉCHEC ${label}:`, JSON.stringify(r.error, null, 2));
      process.exit(1);
    }
    return r.value;
  }
  return r;
}

const eur = (cents) => `${(cents / 100).toFixed(2).replace('.', ',')} €`;

async function main() {
  await prisma.$connect();

  // ── Garde 0 : le tenant doit exister — jamais de création implicite d'entreprise.
  const company = await inCtx(() => persistence.runWithTenant(companyId, () => persistence.companies.findById(companyId)));
  if (!company) fail(`aucune entreprise ${companyId} — seed refusé (le tenant doit déjà exister).`);
  console.log(`Tenant cible : ${company.name} (${companyId}), métier ${company.trade}.`);

  // ── Garde idempotence : > 2 devis existants = tenant déjà peuplé.
  const existingQuotes = await run('listQuotes (garde)', () => service.listQuotes());
  if (existingQuotes.length > 2 && !force) {
    fail(`le tenant possède déjà ${existingQuotes.length} devis — seed refusé (relancer avec --force pour assumer un ajout).`);
  }

  // ── Catalogue (server-side : /catalogue/prestations — la note « catalogue local chiffré »
  //    est périmée, il est bien persisté côté API).
  seedClock.at('2026-01-05T09:00:00.000Z');
  const prestations = [
    { label: "Main d'œuvre plomberie (heure)", category: 'labor', unit: 'h', unitPriceHT: 6_500, vatRate: 10 },
    { label: "Main d'œuvre chauffagiste (heure)", category: 'labor', unit: 'h', unitPriceHT: 7_200, vatRate: 10 },
    { label: 'Forfait déplacement zone locale', category: 'travel', unit: 'forfait', unitPriceHT: 4_900, vatRate: 10 },
    { label: 'Chauffe-eau électrique 200 L (fourniture)', category: 'supply', unit: 'u', unitPriceHT: 74_900, vatRate: 10 },
    { label: 'Mitigeur thermostatique douche', category: 'supply', unit: 'u', unitPriceHT: 18_900, vatRate: 10 },
    { label: 'WC suspendu + bâti-support (fourniture)', category: 'supply', unit: 'u', unitPriceHT: 64_900, vatRate: 10 },
    { label: 'Débouchage canalisation (forfait)', category: 'labor', unit: 'forfait', unitPriceHT: 21_000, vatRate: 20 },
    { label: 'Recherche de fuite non destructive (forfait)', category: 'labor', unit: 'forfait', unitPriceHT: 28_500, vatRate: 20 },
  ];
  for (const item of prestations) await run(`catalogue « ${item.label} »`, () => service.createCatalogueItem(item));
  console.log(`Catalogue : ${prestations.length} prestations.`);

  // ── Clients (AUCUN e-mail : zéro envoi possible — canal = lien partageable).
  const mkCustomer = (label, input) => run(`client « ${label} »`, () => service.createCustomer(input));
  const moreau = await mkCustomer('Claire Moreau', {
    type: 'b2c', name: 'Claire Moreau', phone: '06 52 18 74 30',
    address: { line1: '12 rue des Bruyères', zip: '92310', city: 'Sèvres' },
  });
  const dupuis = await mkCustomer('Bernard Dupuis', {
    type: 'b2c', name: 'Bernard Dupuis', phone: '06 71 44 02 89',
    address: { line1: '8 allée des Tilleuls', zip: '92190', city: 'Meudon' },
  });
  const mairie = await mkCustomer('Mairie de Sèvres', {
    type: 'b2g', name: 'Mairie de Sèvres', siren: '219200099', contactName: 'Services techniques',
    phone: '01 41 14 10 10', paymentTermsLabel: 'Mandat administratif — 30 jours',
    address: { line1: '54 Grande Rue', zip: '92310', city: 'Sèvres' },
  });
  const lefevre = await mkCustomer('Boulangerie Lefèvre', {
    type: 'b2b', name: 'Boulangerie Lefèvre', siren: '532871409', contactName: 'Paul Lefèvre',
    phone: '01 46 26 53 08',
    address: { line1: '45 Grande Rue', zip: '92310', city: 'Sèvres' },
  });
  const martin = await mkCustomer('SARL Martin Rénovation', {
    type: 'b2b', name: 'SARL Martin Rénovation', siren: '798452136', contactName: 'Sophie Martin',
    phone: '01 55 48 07 60', isSubcontractingBtp: true,
    address: { line1: '3 avenue de la Division Leclerc', zip: '92320', city: 'Châtillon' },
  });
  const syndic = await mkCustomer('Syndic Foncia Val de Seine', {
    type: 'b2b', name: 'Syndic Foncia Val de Seine', siren: '414092588', contactName: 'M. Ballester',
    phone: '01 41 09 74 00', paymentTermsLabel: '45 jours fin de mois',
    address: { line1: '22 quai du Point du Jour', zip: '92100', city: 'Boulogne-Billancourt' },
  });
  console.log('Clients : 6 (2 particuliers, 3 entreprises, 1 collectivité).');

  // ── Aides devis/factures ———————————————————————————————————————————
  const createQuote = (label, input) => runBare(`devis « ${label} »`, () => service.createQuote(input));
  const sendQuote = (label, quoteId) => run(`envoi devis « ${label} »`, () => service.sendQuote(quoteId));
  const signQuote = (label, quoteId, signerName) =>
    run(`signature devis « ${label} »`, () => service.signQuote({ quoteId, signerName }));
  const invoiceFromQuote = async (label, quoteId, mode) => {
    const generated = await run(`facture (${mode}) « ${label} »`, () => service.generateInvoice({ quoteId, mode }));
    const issued = await run(`émission facture « ${label} »`, () => service.issueInvoice({ invoiceId: generated.invoiceId }));
    return { invoiceId: generated.invoiceId, number: issued.number };
  };
  const payInvoice = async (label, invoiceId, method, fraction = 1) => {
    const invoice = await run(`lecture facture « ${label} »`, () => service.getInvoice(invoiceId));
    const remaining = invoice.totals.netToPay - invoice.paid; // plafond netToPay respecté par le use case
    const amount = Math.max(1, Math.round(remaining * fraction));
    await run(`encaissement « ${label} » (${eur(amount)})`, () =>
      service.registerPayment({ invoiceId, amount, method, idempotencyKey: null }));
    return amount;
  };

  // ── Janvier — chauffe-eau Moreau : devis signé avec acompte, soldé.
  seedClock.at('2026-01-12T09:30:00.000Z');
  const q1 = await createQuote('chauffe-eau Moreau', {
    customerId: moreau.id, depositPct: 30,
    context: { housingOlderThan2y: true },
    lines: [
      { label: 'Chauffe-eau électrique 200 L (fourniture)', category: 'supply', qty: 1, unitPriceHT: 74_900, vatRate: 10 },
      { label: "Main d'œuvre plomberie — dépose et pose", category: 'labor', qty: 3, unit: 'h', unitPriceHT: 6_500, vatRate: 10 },
      { label: 'Forfait déplacement zone locale', category: 'travel', qty: 1, unitPriceHT: 4_900, vatRate: 10 },
    ],
  });
  await sendQuote('chauffe-eau Moreau', q1.quoteId);
  seedClock.at('2026-01-14T10:00:00.000Z');
  await signQuote('chauffe-eau Moreau', q1.quoteId, 'Claire Moreau');
  const q1Deposit = await invoiceFromQuote('acompte chauffe-eau Moreau', q1.quoteId, 'deposit');
  seedClock.at('2026-01-16T14:00:00.000Z');
  await payInvoice('acompte chauffe-eau Moreau', q1Deposit.invoiceId, 'transfer');
  seedClock.at('2026-01-30T16:00:00.000Z');
  const q1Final = await invoiceFromQuote('solde chauffe-eau Moreau', q1.quoteId, 'final');
  seedClock.at('2026-02-02T11:00:00.000Z');
  await payInvoice('solde chauffe-eau Moreau', q1Final.invoiceId, 'card');

  // ── Février — chaufferie école (Mairie) : facturée, payée PARTIELLEMENT, solde en retard.
  seedClock.at('2026-02-03T09:00:00.000Z');
  const q2 = await createQuote('chaufferie école Jean-Jaurès', {
    customerId: mairie.id,
    lines: [
      { label: "Entretien chaufferie école Jean-Jaurès — main d'œuvre", category: 'labor', qty: 12, unit: 'h', unitPriceHT: 7_200, vatRate: 20 },
      { label: 'Pièces et consommables chaufferie', category: 'supply', qty: 1, unitPriceHT: 45_000, vatRate: 20 },
    ],
  });
  await sendQuote('chaufferie école', q2.quoteId);
  seedClock.at('2026-02-10T09:00:00.000Z');
  await signQuote('chaufferie école', q2.quoteId, 'Mairie de Sèvres — Services techniques');
  seedClock.at('2026-02-20T15:00:00.000Z');
  const q2Final = await invoiceFromQuote('chaufferie école', q2.quoteId, 'final');
  seedClock.at('2026-05-15T10:00:00.000Z');
  await payInvoice('chaufferie école (60 %)', q2Final.invoiceId, 'transfer', 0.6);

  // ── Février — Boulangerie Lefèvre : petit chantier facturé et payé.
  seedClock.at('2026-02-17T08:30:00.000Z');
  const q3 = await createQuote('fuite labo Lefèvre', {
    customerId: lefevre.id,
    lines: [
      { label: 'Mitigeur thermostatique — fourniture', category: 'supply', qty: 1, unitPriceHT: 18_900, vatRate: 20 },
      { label: "Main d'œuvre — remplacement et reprise d'étanchéité", category: 'labor', qty: 2, unit: 'h', unitPriceHT: 6_500, vatRate: 20 },
      { label: 'Forfait déplacement zone locale', category: 'travel', qty: 1, unitPriceHT: 4_900, vatRate: 20 },
    ],
  });
  await sendQuote('fuite labo Lefèvre', q3.quoteId);
  seedClock.at('2026-02-18T09:00:00.000Z');
  await signQuote('fuite labo Lefèvre', q3.quoteId, 'Paul Lefèvre');
  seedClock.at('2026-02-25T17:00:00.000Z');
  const q3Final = await invoiceFromQuote('fuite labo Lefèvre', q3.quoteId, 'final');
  seedClock.at('2026-03-03T10:00:00.000Z');
  await payInvoice('fuite labo Lefèvre', q3Final.invoiceId, 'transfer');

  // ── Mars — sous-traitance SARL Martin (autoliquidation TVA 0) : acompte payé,
  //    solde facturé fin mai, partiellement payé, EN RETARD aujourd'hui.
  seedClock.at('2026-03-09T09:00:00.000Z');
  const q4 = await createQuote('sous-traitance Villa Bellevue', {
    customerId: martin.id, depositPct: 30,
    lines: [
      { label: 'Plomberie sanitaire — Villa Bellevue (sous-traitance)', category: 'labor', qty: 40, unit: 'h', unitPriceHT: 6_500, vatRate: 0 },
      { label: 'Fournitures sanitaires chantier', category: 'supply', qty: 1, unitPriceHT: 185_000, vatRate: 0 },
    ],
  });
  await sendQuote('Villa Bellevue', q4.quoteId);
  seedClock.at('2026-03-12T09:00:00.000Z');
  await signQuote('Villa Bellevue', q4.quoteId, 'Sophie Martin');
  const q4Deposit = await invoiceFromQuote('acompte Villa Bellevue', q4.quoteId, 'deposit');
  seedClock.at('2026-03-20T14:30:00.000Z');
  await payInvoice('acompte Villa Bellevue', q4Deposit.invoiceId, 'transfer');
  seedClock.at('2026-05-29T16:00:00.000Z');
  const q4Final = await invoiceFromQuote('solde Villa Bellevue', q4.quoteId, 'final');
  seedClock.at('2026-06-30T10:00:00.000Z');
  await payInvoice('solde Villa Bellevue (20 %)', q4Final.invoiceId, 'transfer', 0.2);

  // ── Avril — salle de bain Dupuis : signé, acompte 40 % payé, chantier EN COURS (pas de solde).
  seedClock.at('2026-04-02T09:00:00.000Z');
  const q5 = await createQuote('salle de bain Dupuis', {
    customerId: dupuis.id, depositPct: 40,
    context: { housingOlderThan2y: true },
    lines: [
      { label: "Main d'œuvre plomberie — rénovation complète", category: 'labor', qty: 24, unit: 'h', unitPriceHT: 6_500, vatRate: 10 },
      { label: 'WC suspendu + bâti-support (fourniture)', category: 'supply', qty: 1, unitPriceHT: 64_900, vatRate: 10 },
      { label: 'Mitigeur thermostatique douche', category: 'supply', qty: 1, unitPriceHT: 18_900, vatRate: 10 },
      { label: 'Receveur, paroi et meuble vasque (fournitures)', category: 'supply', qty: 1, unitPriceHT: 92_000, vatRate: 10 },
    ],
  });
  await sendQuote('salle de bain Dupuis', q5.quoteId);
  seedClock.at('2026-04-06T18:00:00.000Z');
  await signQuote('salle de bain Dupuis', q5.quoteId, 'Bernard Dupuis');
  const q5Deposit = await invoiceFromQuote('acompte salle de bain Dupuis', q5.quoteId, 'deposit');
  seedClock.at('2026-04-09T09:30:00.000Z');
  await payInvoice('acompte salle de bain Dupuis', q5Deposit.invoiceId, 'transfer');

  // ── Devis envoyés, en attente de réponse.
  seedClock.at('2026-04-21T11:00:00.000Z');
  const q6 = await createQuote('débouchage colonne Syndic', {
    customerId: syndic.id,
    lines: [
      { label: 'Débouchage colonne EU bâtiment B (forfait)', category: 'labor', qty: 1, unitPriceHT: 21_000, vatRate: 20 },
      { label: "Main d'œuvre complémentaire", category: 'labor', qty: 2, unit: 'h', unitPriceHT: 6_500, vatRate: 20 },
    ],
  });
  await sendQuote('débouchage colonne Syndic', q6.quoteId);
  seedClock.at('2026-05-12T10:00:00.000Z');
  const q7 = await createQuote('sanitaires gymnase (Mairie)', {
    customerId: mairie.id,
    lines: [
      { label: "Remise aux normes sanitaires gymnase — main d'œuvre", category: 'labor', qty: 48, unit: 'h', unitPriceHT: 7_200, vatRate: 20 },
      { label: 'Appareillages et fournitures sanitaires', category: 'supply', qty: 1, unitPriceHT: 166_800, vatRate: 20 },
    ],
  });
  await sendQuote('sanitaires gymnase', q7.quoteId);

  // ── Juin — dépannage urgent Lefèvre : signé sur place, facturé, IMPAYÉ (retard récent).
  seedClock.at('2026-06-14T08:00:00.000Z');
  const q11 = await createQuote('dépannage urgence fournil', {
    customerId: lefevre.id,
    lines: [
      { label: 'Recherche de fuite non destructive (forfait)', category: 'labor', qty: 1, unitPriceHT: 28_500, vatRate: 20 },
      { label: "Main d'œuvre — réparation alimentation fournil", category: 'labor', qty: 3, unit: 'h', unitPriceHT: 6_500, vatRate: 20 },
    ],
  });
  await sendQuote('dépannage urgence fournil', q11.quoteId);
  await signQuote('dépannage urgence fournil', q11.quoteId, 'Paul Lefèvre');
  await invoiceFromQuote('dépannage urgence fournil', q11.quoteId, 'final');

  // ── Brouillons récents (jamais envoyés).
  seedClock.at('2026-06-08T15:00:00.000Z');
  await createQuote('adoucisseur Moreau (brouillon)', {
    customerId: moreau.id,
    context: { housingOlderThan2y: true },
    lines: [
      { label: "Adoucisseur d'eau — fourniture", category: 'supply', qty: 1, unitPriceHT: 129_000, vatRate: 10 },
      { label: "Main d'œuvre — installation et mise en service", category: 'labor', qty: 6, unit: 'h', unitPriceHT: 6_500, vatRate: 10 },
      { label: 'Forfait déplacement zone locale', category: 'travel', qty: 1, unitPriceHT: 4_900, vatRate: 10 },
    ],
  });
  seedClock.at('2026-07-06T10:00:00.000Z');
  await createQuote('ballon ECS fournil (brouillon)', {
    customerId: lefevre.id,
    lines: [
      { label: 'Ballon ECS 300 L professionnel (fourniture)', category: 'supply', qty: 1, unitPriceHT: 168_000, vatRate: 20 },
      { label: "Main d'œuvre — remplacement", category: 'labor', qty: 5, unit: 'h', unitPriceHT: 6_500, vatRate: 20 },
    ],
  });
  seedClock.at('2026-07-15T17:30:00.000Z');
  await createQuote('robinetterie cuisine Dupuis (brouillon)', {
    customerId: dupuis.id,
    context: { housingOlderThan2y: true },
    lines: [
      { label: 'Mitigeur évier avec douchette — fourniture', category: 'supply', qty: 1, unitPriceHT: 22_400, vatRate: 10 },
      { label: "Main d'œuvre — pose", category: 'labor', qty: 1, unit: 'h', unitPriceHT: 6_500, vatRate: 10 },
    ],
  });
  console.log('Devis : 11 (3 brouillons, 2 envoyés en attente, 6 signés) — 8 factures émises.');

  // ── Chantiers + notes de suivi.
  seedClock.at('2026-02-10T09:30:00.000Z');
  const ch2 = await run('chantier chaufferie école', () =>
    service.createChantier({
      name: 'Chaufferie école Jean-Jaurès — Mairie de Sèvres',
      customerId: mairie.id,
      address: '54 Grande Rue, 92310 Sèvres',
      notes: 'Entretien annuel + remplacement pièces — accès par les services techniques.',
    }));
  seedClock.at('2026-02-20T18:00:00.000Z');
  await run('note chantier chaufferie (1)', () =>
    service.addChantierNote(ch2.id, { text: 'Intervention terminée, rapport transmis aux services techniques.' }));
  seedClock.at('2026-05-15T10:30:00.000Z');
  await run('note chantier chaufferie (2)', () =>
    service.addChantierNote(ch2.id, { text: 'Relance faite pour le solde de la facture — accord de paiement fin mai.' }));

  seedClock.at('2026-04-06T18:30:00.000Z');
  const ch1 = await run('chantier salle de bain Dupuis', () =>
    service.createChantier({
      name: 'Rénovation salle de bain — Dupuis (Meudon)',
      customerId: dupuis.id,
      address: '8 allée des Tilleuls, 92190 Meudon',
      notes: 'Dépose complète, WC suspendu, douche à l’italienne. Acompte 40 % encaissé.',
    }));
  seedClock.at('2026-04-09T10:00:00.000Z');
  await run('note chantier Dupuis (1)', () =>
    service.addChantierNote(ch1.id, { text: 'Acompte reçu — commande des sanitaires passée chez Cedeo.' }));
  seedClock.at('2026-06-18T19:00:00.000Z');
  await run('note chantier Dupuis (2)', () =>
    service.addChantierNote(ch1.id, { text: 'Carrelage terminé. Pose du meuble vasque et de la paroi semaine prochaine.' }));
  console.log('Chantiers : 2, avec notes de suivi.');

  // ── Dépenses (10, janvier → juillet ; payées + à payer dont 1 échue).
  const spend = async (label, when, input, paid) => {
    seedClock.at(when);
    const created = await run(`dépense « ${label} »`, () => service.recordExpense({ source: 'manual', ...input }));
    if (paid) {
      seedClock.at(paid.on);
      await run(`règlement dépense « ${label} »`, () =>
        service.recordExpensePayment({ expenseId: created.id, paidOn: paid.on.slice(0, 10), method: paid.method }));
    }
    return created;
  };
  await spend('Cedeo — chauffe-eau', '2026-01-08T10:00:00.000Z',
    { supplierName: 'Cedeo', documentDate: '2026-01-08', totalTtcCents: 48_260, vatRatePct: 20, category: 'fournitures' },
    { on: '2026-01-08T10:05:00.000Z', method: 'card' });
  await spend('TotalEnergies — carburant', '2026-01-21T18:00:00.000Z',
    { supplierName: 'TotalEnergies', documentDate: '2026-01-21', totalTtcCents: 9_840, vatRatePct: 20, category: 'carburant' },
    { on: '2026-01-21T18:02:00.000Z', method: 'card' });
  await spend('Point.P — matériel', '2026-02-11T09:00:00.000Z',
    { supplierName: 'Point.P', documentDate: '2026-02-11', totalTtcCents: 23_750, vatRatePct: 20, category: 'materiel' },
    { on: '2026-02-11T09:05:00.000Z', method: 'card' });
  await spend('Würth — outillage', '2026-03-10T11:00:00.000Z',
    { supplierName: 'Würth France', documentDate: '2026-03-10', totalTtcCents: 31_420, vatRatePct: 20, category: 'materiel', dueAt: '2026-04-09' },
    { on: '2026-03-15T09:00:00.000Z', method: 'transfer' });
  await spend('Le Relais — repas chantier', '2026-03-28T13:30:00.000Z',
    { supplierName: 'Restaurant Le Relais', documentDate: '2026-03-28', totalTtcCents: 4_380, vatRatePct: 10, category: 'repas' },
    { on: '2026-03-28T13:35:00.000Z', method: 'card' });
  await spend('Cedeo — sanitaires SDB Dupuis', '2026-04-07T10:00:00.000Z',
    { supplierName: 'Cedeo', documentDate: '2026-04-07', totalTtcCents: 187_300, vatRatePct: 20, category: 'fournitures', dueAt: '2026-05-07' },
    { on: '2026-05-05T09:00:00.000Z', method: 'transfer' });
  await spend('TotalEnergies — carburant', '2026-05-19T18:00:00.000Z',
    { supplierName: 'TotalEnergies', documentDate: '2026-05-19', totalTtcCents: 11_260, vatRatePct: 20, category: 'carburant' },
    { on: '2026-05-19T18:02:00.000Z', method: 'card' });
  await spend('Rexel — matériel (ÉCHUE, à payer)', '2026-06-04T09:00:00.000Z',
    { supplierName: 'Rexel', documentDate: '2026-06-04', totalTtcCents: 15_980, vatRatePct: 20, category: 'materiel', dueAt: '2026-07-04' });
  await spend('Électricité Barbier — sous-traitance (à payer)', '2026-06-25T09:00:00.000Z',
    { supplierName: 'Électricité Barbier', documentDate: '2026-06-25', totalTtcCents: 96_000, vatRatePct: 20, category: 'sous_traitance', dueAt: '2026-07-25' });
  await spend('Cedeo — fournitures (à payer)', '2026-07-10T10:00:00.000Z',
    { supplierName: 'Cedeo', documentDate: '2026-07-10', totalTtcCents: 27_640, vatRatePct: 20, category: 'fournitures', dueAt: '2026-08-09' });
  console.log('Dépenses : 10 (7 payées, 3 à payer dont 1 échue).');

  // ── Solde bancaire confirmé À MAINTENANT (fraîcheur réelle → trésorerie complète).
  seedClock.at(new Date().toISOString());
  await run('solde bancaire confirmé', () =>
    service.recordManualBankBalance({ amountCents: 1_872_430, observedAt: seedClock.now() }));
  console.log(`Solde bancaire confirmé : ${eur(1_872_430)}.`);

  // ── Bilan final lisible.
  const [quotes, invoices] = await Promise.all([
    run('bilan devis', () => service.listQuotes()),
    run('bilan factures', () => service.listInvoices()),
  ]);
  console.log('— SEED TERMINÉ —');
  console.log(`Devis: ${quotes.length} | Factures: ${invoices.length}`);
  for (const i of invoices) {
    console.log(`  ${i.number ?? '(brouillon)'} — ${i.kind} ${i.status} — netToPay ${eur(i.totals.netToPay)} payé ${eur(i.paid)}${i.dueAt ? ` (échéance ${i.dueAt})` : ''}`);
  }
  console.log('Note : les PDF/Factur-X seront archivés par l’API déployée (outbox d’archives).');
  await prisma.$disconnect();
}

main().catch(async (e) => {
  console.error('seed-demo-tenant: échec inattendu —', e);
  try { await prisma.$disconnect(); } catch { /* déjà fermé */ }
  process.exit(1);
});
