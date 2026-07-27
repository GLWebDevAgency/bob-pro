import { describe, it, expect, vi } from 'vitest';
import {
  ok,
  err,
  appDomain,
  formatEUR,
  INTERNATIONAL_PRO_EMISSION_BLOCK_MESSAGE,
  STANDALONE_B2C_REQUIRES_URGENT_REPAIR_MESSAGE,
} from '@bob/core';
import { BobAgent } from './bob-agent';
import { ModelRouter } from '../router/model-router';
import { type BobActions, type BillableCustomer, type InvoiceableQuote } from './actions';

/**
 * B1/B2/B4 — PARITÉ VOCALE de la facturation terrain :
 *  • facture_directe : « facture 380 € à Mme Girard pour le dépannage » (ComposeStandalone) ;
 *  • facturer_situation : « facture une situation de 40 % sur le chantier Durand » ;
 *  • definir_conditions_paiement : « Durand paie à 45 jours fin de mois ».
 * Doctrine testée : lignes dictées + questions structurées pour ce qui manque (jamais un défaut
 * inventé, jamais un taux de TVA deviné), plancher fiscal (confirmation même en 'auto'), et
 * gardes du domaine restituées VERBATIM (pro étranger B6, urgence b2c A3bis, cumul B2, L441-10).
 */

const CUSTOMERS: BillableCustomer[] = [
  { id: 'cus-girard', name: 'Mme Girard', type: 'b2c' },
  { id: 'cus-durand', name: 'Durand SARL', type: 'b2b' },
  { id: 'cus-mairie', name: 'Mairie de Vitry', type: 'b2g' },
];

const SIGNED_QUOTE: InvoiceableQuote = {
  id: 'sign-1',
  number: 'D-2026-0031',
  customerName: 'Durand SARL',
  totalTtcCents: 1_200_000,
  depositPct: null,
  depositInvoiced: false,
  finalBlockedUntil: null,
  retenueGarantiePct: 5,
};

function makeActions(over: Partial<BobActions> = {}): BobActions {
  return {
    computePayout: async () => ok({ payoutCents: 0, availableCents: 0 }),
    draftRelance: async () => ok({ subject: 's', body: 'b' }),
    listPayableInvoices: async () => ok([]),
    listSendableQuotes: async () => ok([]),
    listIssuableInvoices: async () => ok([]),
    listDocuments: async () => ok([]),
    registerPayment: async () => ok({ status: 'paid' }),
    sendQuote: async () => ok({ number: 'D-1' }),
    issueInvoice: async () => ok({ number: 'F-1' }),
    ...over,
  };
}

const agentWith = (over: Partial<BobActions> = {}): BobAgent =>
  new BobAgent({ router: new ModelRouter({ hasClaudeKey: false, hasGlmKey: false }), actions: makeActions(over) });

describe('facture_directe — B1 : facture SANS devis signé, dictée à la voix', () => {
  it('dictée COMPLÈTE b2b (« facture 500 € HT à Durand pour la maintenance… TVA 20 % ») : propose (plancher fiscal), rien n’est créé avant confirmation', async () => {
    const compose = vi.fn(async () => ok({ invoiceId: 'inv-1', totalTtcCents: 60000, netToPayCents: 60000 }));
    const agent = agentWith({
      listBillableCustomers: async () => ok(CUSTOMERS),
      composeStandaloneInvoice: compose,
    });
    const r = await agent.ask('Facture 500 € HT à Durand pour la maintenance de la chaufferie (TVA 20 %)', {
      autonomy: 'auto',
    });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.intent).toBe('facture_directe');
    expect(r.value.kind).toBe('proposed');
    expect(r.value.pending?.tool).toBe('facture_directe');
    expect(r.value.pending?.args).toMatchObject({
      customerId: 'cus-durand',
      lines: [
        { label: 'Maintenance de la chaufferie', category: 'labor', qty: 1, unitPriceHT: 50000, vatRate: 20 },
      ],
    });
    // Client professionnel : jamais de qualification d'urgence fabriquée.
    expect(r.value.pending?.args).not.toHaveProperty('urgentOnSiteRepair');
    expect(compose).not.toHaveBeenCalled();
    expect(r.value.spokenPrompt).toBeTruthy();
  });

  it('confirm() exécute le MÊME use case et annonce le TOTAL DU DOMAINE (jamais recalculé)', async () => {
    const compose = vi.fn(async () => ok({ invoiceId: 'inv-1', totalTtcCents: 60000, netToPayCents: 60000 }));
    const agent = agentWith({
      listBillableCustomers: async () => ok(CUSTOMERS),
      composeStandaloneInvoice: compose,
    });
    const proposed = await agent.ask('Facture 500 € HT à Durand pour la maintenance de la chaufferie (TVA 20 %)');
    expect(proposed.ok).toBe(true);
    if (!proposed.ok || !proposed.value.pending) return;
    const done = await agent.confirm(proposed.value.pending);
    expect(done.ok).toBe(true);
    if (!done.ok) return;
    expect(done.value.kind).toBe('done');
    expect(done.value.intent).toBe('facture_directe');
    expect(done.value.card.title).toBe('Facture directe créée ✓');
    expect(done.value.card.body).toContain(formatEUR(60000));
    expect(compose).toHaveBeenCalledWith(
      expect.objectContaining({
        customerId: 'cus-durand',
        lines: [expect.objectContaining({ unitPriceHT: 50000, vatRate: 20 })],
      }),
    );
  });

  it('PR-08 — site dicté (« chez Carrefour Vitry ») : résolu contre la LISTE RÉELLE, chantierId dans la proposition', async () => {
    const compose = vi.fn(async () => ok({ invoiceId: 'inv-1', totalTtcCents: 60000, netToPayCents: 60000 }));
    const agent = agentWith({
      listBillableCustomers: async () => ok(CUSTOMERS),
      composeStandaloneInvoice: compose,
      listFilingDestinations: async () =>
        ok({
          chantiers: [
            { id: 'site-carrefour-vitry', nom: 'Carrefour Vitry' },
            { id: 'site-docks-rouen', nom: 'Docks Rouen' },
          ],
          dossiers: [],
        }),
    });
    const r = await agent.ask(
      'Facture 500 € HT à Durand pour la maintenance des fontaines chez Carrefour Vitry (TVA 20 %)',
      { autonomy: 'auto' },
    );
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.kind).toBe('proposed');
    // Le site RÉSOLU (jamais un id récité) accompagne l'intention ; le récap le DIT.
    expect(r.value.pending?.args).toMatchObject({
      customerId: 'cus-durand',
      chantierId: 'site-carrefour-vitry',
    });
    expect(r.value.pending?.label).toContain('Carrefour Vitry');
    expect(compose).not.toHaveBeenCalled();
  });

  it('PR-08 — site NOMMÉ mais introuvable dans la liste réelle : refus honnête, rien n’est créé', async () => {
    const compose = vi.fn(async () => ok({ invoiceId: 'inv-1', totalTtcCents: 60000, netToPayCents: 60000 }));
    const agent = agentWith({
      listBillableCustomers: async () => ok(CUSTOMERS),
      composeStandaloneInvoice: compose,
      listFilingDestinations: async () => ok({ chantiers: [{ id: 'site-a', nom: 'Docks Rouen' }], dossiers: [] }),
    });
    const r = await agent.ask(
      'Facture 500 € HT à Durand pour la maintenance sur le site Bastille (TVA 20 %)',
    );
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.kind).toBe('answer');
    expect(r.value.card.title).toBe('Site introuvable');
    expect(compose).not.toHaveBeenCalled();
  });

  it('PR-08 — sans capacité hôte listFilingDestinations : comportement antérieur inchangé (pièce hors site)', async () => {
    const compose = vi.fn(async () => ok({ invoiceId: 'inv-1', totalTtcCents: 60000, netToPayCents: 60000 }));
    const agent = agentWith({
      listBillableCustomers: async () => ok(CUSTOMERS),
      composeStandaloneInvoice: compose,
    });
    const r = await agent.ask('Facture 500 € HT à Durand pour la maintenance de la chaufferie (TVA 20 %)');
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.kind).toBe('proposed');
    expect(r.value.pending?.args).not.toHaveProperty('chantierId');
  });

  it('PR-08 — le mot « chantier » du LIBELLÉ facturé ne désigne jamais un site : proposition, pas de refus', async () => {
    // Régression revue adversariale P1 : « nettoyage de fin de chantier » + ≥1 chantier ouvert
    // dont le nom ne matche pas → main proposait la facture, jamais « Site introuvable ».
    const agent = agentWith({
      listBillableCustomers: async () => ok(CUSTOMERS),
      composeStandaloneInvoice: async () => ok({ invoiceId: 'inv-1', totalTtcCents: 60000, netToPayCents: 60000 }),
      listFilingDestinations: async () => ok({ chantiers: [{ id: 'site-a', nom: 'Docks Rouen' }], dossiers: [] }),
    });
    const r = await agent.ask('Facture 500 € HT à Durand pour le nettoyage de fin de chantier (TVA 20 %)');
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.kind).toBe('proposed');
    expect(r.value.pending?.args).not.toHaveProperty('chantierId');
  });

  it('PR-08 — « intervention sur site » (vocabulaire maintenance) sans nom : pièce hors site, jamais un refus', async () => {
    const agent = agentWith({
      listBillableCustomers: async () => ok(CUSTOMERS),
      composeStandaloneInvoice: async () => ok({ invoiceId: 'inv-1', totalTtcCents: 60000, netToPayCents: 60000 }),
      listFilingDestinations: async () => ok({ chantiers: [{ id: 'site-a', nom: 'Docks Rouen' }], dossiers: [] }),
    });
    const r = await agent.ask('Facture 500 € HT à Durand pour l’intervention sur site (TVA 20 %)');
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.kind).toBe('proposed');
    expect(r.value.pending?.args).not.toHaveProperty('chantierId');
  });

  it('PR-08 — « Site introuvable » est ACTIONNABLE : sites ouverts en options + « Continuer sans site » parsé', async () => {
    const compose = vi.fn(async () => ok({ invoiceId: 'inv-1', totalTtcCents: 60000, netToPayCents: 60000 }));
    const agent = agentWith({
      listBillableCustomers: async () => ok(CUSTOMERS),
      composeStandaloneInvoice: compose,
      listFilingDestinations: async () => ok({ chantiers: [{ id: 'site-a', nom: 'Docks Rouen' }], dossiers: [] }),
    });
    const turn1Message = 'Facture 500 € HT à Durand pour la maintenance sur le site Bastille (TVA 20 %)';
    const turn1 = await agent.ask(turn1Message);
    expect(turn1.ok).toBe(true);
    if (!turn1.ok) return;
    expect(turn1.value.card.title).toBe('Site introuvable');
    expect(turn1.value.card.body).toContain('bastille');
    // Chemins de sortie RÉELS : un site ouvert, ou continuer sans site (marqueur parsé).
    const siteChip = turn1.value.choices?.find((c) => c.label === 'Site Docks Rouen');
    const bypass = turn1.value.choices?.find((c) => c.label === 'Continuer sans site');
    expect(siteChip).toBeDefined();
    expect(bypass).toBeDefined();
    expect(bypass?.value).toContain('— sans site');
    expect(turn1.value.ask?.[0]?.id).toBe('facture_directe.site_introuvable');

    // Enchaînement followUp→résolution : le bypass ABOUTIT malgré l'historique qui nomme
    // encore « site Bastille » (l'impasse de la revue) — pièce proposée HORS site.
    const turn2 = await agent.ask(bypass!.value, {
      history: [
        { role: 'user', text: turn1Message },
        { role: 'bob', text: turn1.value.card.body },
      ],
    });
    expect(turn2.ok).toBe(true);
    if (!turn2.ok) return;
    expect(turn2.value.kind).toBe('proposed');
    expect(turn2.value.pending?.args).not.toHaveProperty('chantierId');
    expect(compose).not.toHaveBeenCalled();
  });

  it('PR-08 — ambiguïté RÉELLE (« sur le site RATP », deux sites RATP) : question posée PUIS résolue par le followUp (jamais une boucle)', async () => {
    const agent = agentWith({
      listBillableCustomers: async () => ok(CUSTOMERS),
      composeStandaloneInvoice: async () => ok({ invoiceId: 'inv-1', totalTtcCents: 60000, netToPayCents: 60000 }),
      listFilingDestinations: async () =>
        ok({
          chantiers: [
            { id: 'site-ratp-bastille', nom: 'RATP Bastille' },
            { id: 'site-ratp-vitry', nom: 'RATP Vitry' },
          ],
          dossiers: [],
        }),
    });
    const turn1Message = 'Facture 500 € HT à Durand pour la maintenance des escaliers sur le site RATP (TVA 20 %)';
    const turn1 = await agent.ask(turn1Message);
    expect(turn1.ok).toBe(true);
    if (!turn1.ok) return;
    expect(turn1.value.kind).toBe('answer');
    const question = turn1.value.ask?.[0];
    expect(question?.id).toBe('facture_directe.site');
    expect(question?.options).toHaveLength(2);
    const bastille = question?.options.find((o) => o.label === 'RATP Bastille');
    expect(bastille?.value).toBe('site-ratp-bastille');

    // Tour 2 : le followUp VERBATIM, avec l'historique complet (qui contient encore « site
    // RATP ») — la queue scopée ne rematche QUE le site choisi : résolution, pas de re-question.
    const turn2 = await agent.ask(bastille!.followUp, {
      history: [
        { role: 'user', text: turn1Message },
        { role: 'bob', text: turn1.value.card.body },
      ],
    });
    expect(turn2.ok).toBe(true);
    if (!turn2.ok) return;
    expect(turn2.value.kind).toBe('proposed');
    expect(turn2.value.pending?.args).toMatchObject({ customerId: 'cus-durand', chantierId: 'site-ratp-bastille' });
    expect(turn2.value.pending?.label).toContain('RATP Bastille');
  });

  it('PR-08 — sites en INCLUSION de nom (« Carrefour » / « Carrefour Vitry ») : le nom exact dit l’emporte, aucune question', async () => {
    const destinations = {
      chantiers: [
        { id: 'site-carrefour', nom: 'Carrefour' },
        { id: 'site-carrefour-vitry', nom: 'Carrefour Vitry' },
      ],
      dossiers: [],
    };
    const agent = agentWith({
      listBillableCustomers: async () => ok(CUSTOMERS),
      composeStandaloneInvoice: async () => ok({ invoiceId: 'inv-1', totalTtcCents: 60000, netToPayCents: 60000 }),
      listFilingDestinations: async () => ok(destinations),
    });
    // Le nom LONG dit en entier ⇒ le plus spécifique, sans re-demander (la question
    // rebouclerait : les deux noms rematcheraient à chaque tour).
    const long = await agent.ask('Facture 500 € HT à Durand pour le nettoyage des vitrines sur le site Carrefour Vitry (TVA 20 %)');
    expect(long.ok).toBe(true);
    if (!long.ok) return;
    expect(long.value.kind).toBe('proposed');
    expect(long.value.pending?.args).toMatchObject({ chantierId: 'site-carrefour-vitry' });

    // Le nom COURT seul ⇒ le site court, jamais le long par contagion.
    const short = await agent.ask('Facture 500 € HT à Durand pour le nettoyage des vitrines sur le site Carrefour (TVA 20 %)');
    expect(short.ok).toBe(true);
    if (!short.ok) return;
    expect(short.value.kind).toBe('proposed');
    expect(short.value.pending?.args).toMatchObject({ chantierId: 'site-carrefour' });
  });

  it('client b2c SANS urgence dite : question structurée A3bis (jamais un fait fabriqué)', async () => {
    const compose = vi.fn(async () => ok({ invoiceId: 'x', totalTtcCents: 1, netToPayCents: 1 }));
    const agent = agentWith({
      listBillableCustomers: async () => ok(CUSTOMERS),
      composeStandaloneInvoice: compose,
    });
    const r = await agent.ask(
      'Facture 380 € TTC à Mme Girard pour le dépannage de la chaudière (TVA 10 %, logement de plus de 2 ans)',
    );
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.kind).toBe('answer');
    expect(r.value.ask?.[0]?.id).toBe('facture_directe.urgence');
    const oui = r.value.ask?.[0]?.options.find((o) => o.value === 'oui');
    expect(oui?.followUp).toContain('intervention urgente demandée par le client');
    expect(compose).not.toHaveBeenCalled();
  });

  it('b2c URGENCE CONFIRMÉE (followUp verbatim) : propose avec urgentOnSiteRepair + conversion TTC→HT au taux confirmé', async () => {
    const agent = agentWith({
      listBillableCustomers: async () => ok(CUSTOMERS),
      composeStandaloneInvoice: async () => ok({ invoiceId: 'x', totalTtcCents: 38000, netToPayCents: 38000 }),
    });
    const r = await agent.ask(
      'Facture 380 € TTC à Mme Girard pour dépannage de la chaudière (TVA 10 %, logement de plus de 2 ans, intervention urgente demandée par le client)',
    );
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.kind).toBe('proposed');
    expect(r.value.pending?.args).toMatchObject({
      customerId: 'cus-girard',
      urgentOnSiteRepair: true,
      context: { housingOlderThan2y: true },
      lines: [
        // 380 € TTC dits à 10 % → base HT arrondie ; le TTC exact reste calculé par le domaine.
        expect.objectContaining({ unitPriceHT: Math.round(38000 / 1.1), vatRate: 10 }),
      ],
    });
  });

  it('b2c SANS urgence (refus assumé) : le MESSAGE DU DOMAINE verbatim, aucune création, le devis proposé en repli', async () => {
    const compose = vi.fn(async () => ok({ invoiceId: 'x', totalTtcCents: 1, netToPayCents: 1 }));
    const agent = agentWith({
      listBillableCustomers: async () => ok(CUSTOMERS),
      composeStandaloneInvoice: compose,
    });
    const r = await agent.ask(
      'Facture 380 € TTC à Mme Girard pour dépannage de la chaudière (TVA 10 %, logement de plus de 2 ans) — sans urgence',
    );
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.kind).toBe('answer');
    expect(r.value.card.body).toBe(STANDALONE_B2C_REQUIRES_URGENT_REPAIR_MESSAGE);
    expect(r.value.choices?.[0]?.value).toBe('Fais un devis pour Mme Girard');
    expect(compose).not.toHaveBeenCalled();
  });

  it('TVA non dite : question structurée (20/10/5,5) — un taux fiscal ne se devine JAMAIS', async () => {
    const agent = agentWith({
      listBillableCustomers: async () => ok(CUSTOMERS),
      composeStandaloneInvoice: async () => ok({ invoiceId: 'x', totalTtcCents: 1, netToPayCents: 1 }),
    });
    const r = await agent.ask('Facture 500 € HT à Durand pour la maintenance de la chaufferie');
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.kind).toBe('answer');
    expect(r.value.ask?.[0]?.id).toBe('facture_directe.tva');
    expect(r.value.ask?.[0]?.options.map((o) => o.value)).toEqual(['20', '10', '5.5']);
    // Le taux réduit embarque son ÉLIGIBILITÉ dans la commande de suivi (jamais fabriquée après coup).
    const dix = r.value.ask?.[0]?.options.find((o) => o.value === '10');
    expect(dix?.followUp).toContain('TVA 10 %');
    expect(dix?.followUp).toContain('logement de plus de 2 ans');
  });

  it('base non dite (« 500 € » nu) : question HT ou TTC — jamais une base devinée', async () => {
    const agent = agentWith({
      listBillableCustomers: async () => ok(CUSTOMERS),
      composeStandaloneInvoice: async () => ok({ invoiceId: 'x', totalTtcCents: 1, netToPayCents: 1 }),
    });
    const r = await agent.ask('Facture 500 € à Durand pour la maintenance de la chaufferie (TVA 20 %)');
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.kind).toBe('answer');
    expect(r.value.ask?.[0]?.id).toBe('facture_directe.base');
    expect(r.value.ask?.[0]?.options.find((o) => o.value === 'ht')?.followUp).toContain('500 € HT');
  });

  it('remise dictée (« avec 10 % de remise ») : portée en globalDiscount du domaine, annoncée avant confirmation', async () => {
    const agent = agentWith({
      listBillableCustomers: async () => ok(CUSTOMERS),
      composeStandaloneInvoice: async () => ok({ invoiceId: 'x', totalTtcCents: 1, netToPayCents: 1 }),
    });
    const r = await agent.ask('Facture 1000 € HT à Durand pour la pose de cloisons (TVA 20 %, avec 10 % de remise)');
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.kind).toBe('proposed');
    expect(r.value.pending?.args).toMatchObject({ globalDiscount: { type: 'percent', value: 10 } });
    expect(r.value.card.body).toContain('remise 10 %');
  });

  it('client INCONNU du carnet : refus honnête, rien n’est créé (jamais un id inventé)', async () => {
    const compose = vi.fn(async () => ok({ invoiceId: 'x', totalTtcCents: 1, netToPayCents: 1 }));
    const agent = agentWith({
      listBillableCustomers: async () => ok(CUSTOMERS),
      composeStandaloneInvoice: compose,
    });
    const r = await agent.ask('Facture 300 € HT à Machin pour le nettoyage (TVA 20 %)');
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.kind).toBe('answer');
    expect(r.value.card.title).toBe('Client introuvable');
    expect(compose).not.toHaveBeenCalled();
  });

  it('clients AMBIGUS (deux « Durand ») : question structurée, jamais un choix silencieux', async () => {
    const agent = agentWith({
      listBillableCustomers: async () =>
        ok([...CUSTOMERS, { id: 'cus-durand2', name: 'M. Durand', type: 'b2c' as const }]),
      composeStandaloneInvoice: async () => ok({ invoiceId: 'x', totalTtcCents: 1, netToPayCents: 1 }),
    });
    const r = await agent.ask('Facture 500 € HT à Durand pour la maintenance (TVA 20 %)');
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.kind).toBe('answer');
    expect(r.value.ask?.[0]?.id).toBe('facture_directe.client');
    expect(r.value.ask?.[0]?.options).toHaveLength(2);
  });

  it('garde B6 (pro étranger) au moment de la CONFIRMATION : le message du domaine, verbatim — mêmes mots que l’UI', async () => {
    const agent = agentWith({
      listBillableCustomers: async () => ok(CUSTOMERS),
      composeStandaloneInvoice: async () =>
        err(
          appDomain({
            code: 'VALIDATION',
            field: 'customer',
            message: INTERNATIONAL_PRO_EMISSION_BLOCK_MESSAGE,
          }),
        ),
    });
    const proposed = await agent.ask('Facture 500 € HT à Durand pour la maintenance de la chaufferie (TVA 20 %)');
    expect(proposed.ok).toBe(true);
    if (!proposed.ok || !proposed.value.pending) return;
    const confirmed = await agent.confirm(proposed.value.pending);
    expect(confirmed.ok).toBe(true);
    if (!confirmed.ok) return;
    expect(confirmed.value.kind).toBe('answer');
    expect(confirmed.value.card.title).toBe('Refusé — rien n’a été modifié');
    expect(confirmed.value.card.body).toBe(INTERNATIONAL_PRO_EMISSION_BLOCK_MESSAGE);
  });

  it('hôte SANS composeStandaloneInvoice (rétro-compat) : réponse honnête, aucun outil proposé', async () => {
    const agent = agentWith({ listBillableCustomers: async () => ok(CUSTOMERS) });
    const r = await agent.ask('Facture 500 € HT à Durand pour la maintenance (TVA 20 %)');
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.kind).toBe('answer');
    expect(r.value.card.body).toContain('Rien n’a été créé');
  });

  it('continuité du parcours : après la question du montant, « 500 € HT » + historique reprend la MÊME facture directe', async () => {
    const agent = agentWith({
      listBillableCustomers: async () => ok(CUSTOMERS),
      composeStandaloneInvoice: async () => ok({ invoiceId: 'x', totalTtcCents: 1, netToPayCents: 1 }),
    });
    const first = await agent.ask('Fais une facture directe à Durand pour la maintenance de la chaufferie (TVA 20 %)');
    expect(first.ok).toBe(true);
    if (!first.ok) return;
    expect(first.value.card.title).toBe('Quel montant ?');
    const followUp = await agent.ask('500 € HT', {
      history: [
        { role: 'user', text: 'Fais une facture directe à Durand pour la maintenance de la chaufferie (TVA 20 %)' },
        { role: 'bob', text: first.value.card.body },
      ],
    });
    expect(followUp.ok).toBe(true);
    if (!followUp.ok) return;
    expect(followUp.value.intent).toBe('facture_directe');
    expect(followUp.value.kind).toBe('proposed');
    expect(followUp.value.pending?.args).toMatchObject({
      customerId: 'cus-durand',
      lines: [expect.objectContaining({ unitPriceHT: 50000, vatRate: 20 })],
    });
  });
});

describe('facturer_situation — B2 : situation de travaux d’un devis signé', () => {
  it('« facture une situation de 40 % sur le chantier Durand » : résout le devis signé, propose (plancher fiscal), annonce la retenue B5', async () => {
    const generateInvoice = vi.fn(async () => ok({ invoiceId: 'sit-1' }));
    const agent = agentWith({
      listInvoiceableQuotes: async () => ok([SIGNED_QUOTE]),
      generateInvoice,
    });
    const r = await agent.ask('Facture une situation de 40 % sur le chantier Durand', { autonomy: 'auto' });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.intent).toBe('facturer_situation');
    expect(r.value.kind).toBe('proposed');
    expect(r.value.pending?.tool).toBe('facturer_situation');
    expect(r.value.pending?.args).toEqual({ quoteId: 'sign-1', situation: { percent: 40 } });
    // B5 — retenue de garantie annoncée AVANT consentement, même substance que la mention UI.
    expect(r.value.card.body).toContain('retenue de garantie de 5 %');
    expect(r.value.card.body).toContain('loi n° 71-584');
    expect(generateInvoice).not.toHaveBeenCalled();
  });

  it('confirm() délègue au MÊME generateInvoice (mode situation) — carte « Situation générée ✓ »', async () => {
    const generateInvoice = vi.fn(async () => ok({ invoiceId: 'sit-1' }));
    const agent = agentWith({
      listInvoiceableQuotes: async () => ok([SIGNED_QUOTE]),
      generateInvoice,
    });
    const proposed = await agent.ask('Facture une situation de 40 % sur le chantier Durand');
    expect(proposed.ok).toBe(true);
    if (!proposed.ok || !proposed.value.pending) return;
    const done = await agent.confirm(proposed.value.pending);
    expect(done.ok).toBe(true);
    if (!done.ok) return;
    expect(done.value.kind).toBe('done');
    expect(done.value.card.title).toBe('Situation générée ✓');
    expect(generateInvoice).toHaveBeenCalledWith({
      quoteId: 'sign-1',
      mode: 'situation',
      situation: { percent: 40 },
    });
  });

  it('montant HT dicté (« 4500 € HT ») : situation en centimes HT — jamais promu référence de devis', async () => {
    const agent = agentWith({
      listInvoiceableQuotes: async () => ok([SIGNED_QUOTE]),
      generateInvoice: async () => ok({ invoiceId: 'sit-1' }),
    });
    const r = await agent.ask('Facture une situation de 4500 € HT sur le devis D-2026-0031');
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.kind).toBe('proposed');
    expect(r.value.pending?.args).toEqual({ quoteId: 'sign-1', situation: { amountHtCents: 450000 } });
  });

  it('montant TTC dicté : refus honnête (les situations se stipulent en HT), rien n’est créé', async () => {
    const generateInvoice = vi.fn(async () => ok({ invoiceId: 'sit-1' }));
    const agent = agentWith({
      listInvoiceableQuotes: async () => ok([SIGNED_QUOTE]),
      generateInvoice,
    });
    const r = await agent.ask('Facture une situation de 4500 € TTC sur le devis Durand');
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.kind).toBe('answer');
    expect(r.value.card.title).toBe('Montant HT requis');
    expect(generateInvoice).not.toHaveBeenCalled();
  });

  it('sans montant : le % PROPOSÉ des tâches du chantier (consultatif) — jamais imposé, jamais exécuté seul', async () => {
    const agent = agentWith({
      listInvoiceableQuotes: async () => ok([SIGNED_QUOTE]),
      generateInvoice: async () => ok({ invoiceId: 'sit-1' }),
      proposeSituationAdvancement: async () => ok({ percent: 60, doneCount: 3, totalCount: 5 }),
    });
    const r = await agent.ask('Facture une situation sur le devis Durand');
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.kind).toBe('answer');
    expect(r.value.card.body).toContain('60 %');
    expect(r.value.card.body).toContain('3/5');
    expect(r.value.choices?.[0]?.value).toBe('Facture une situation de 60 % sur le devis D-2026-0031');
  });

  it('sans montant NI proposition (aucune tâche — null honnête) : question d’avancement, jamais un % inventé', async () => {
    const agent = agentWith({
      listInvoiceableQuotes: async () => ok([SIGNED_QUOTE]),
      generateInvoice: async () => ok({ invoiceId: 'sit-1' }),
      proposeSituationAdvancement: async () => ok(null),
    });
    const r = await agent.ask('Facture une situation sur le devis Durand');
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.kind).toBe('answer');
    expect(r.value.card.title).toBe('Quel avancement pour cette situation ?');
    expect(r.value.choices).toBeUndefined();
  });

  it('gel de rétractation A3 (b2c) : annonce HONNÊTE — la situation attend, comme la finale (message source unique)', async () => {
    const generateInvoice = vi.fn(async () => ok({ invoiceId: 'sit-1' }));
    const agent = agentWith({
      listInvoiceableQuotes: async () => ok([{ ...SIGNED_QUOTE, finalBlockedUntil: '2026-06-15' }]),
      generateInvoice,
    });
    const r = await agent.ask('Facture une situation de 40 % sur le devis Durand');
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.kind).toBe('answer');
    expect(r.value.card.title).toBe('Situation : pas encore possible');
    expect(r.value.card.body).toContain('rétractation');
    expect(generateInvoice).not.toHaveBeenCalled();
  });

  it('garde de CUMUL au moment de la confirmation : le message du domaine, VERBATIM — mêmes mots que l’UI', async () => {
    const cumulMessage =
      'Cumul acompte + situations supérieur au marché : déjà engagé 1100000 c sur 1200000 c TTC — reste facturable 100000 c.';
    const agent = agentWith({
      listInvoiceableQuotes: async () => ok([SIGNED_QUOTE]),
      generateInvoice: async () =>
        err(appDomain({ code: 'VALIDATION', field: 'situation', message: cumulMessage })),
    });
    const proposed = await agent.ask('Facture une situation de 40 % sur le devis Durand');
    expect(proposed.ok).toBe(true);
    if (!proposed.ok || !proposed.value.pending) return;
    const confirmed = await agent.confirm(proposed.value.pending);
    expect(confirmed.ok).toBe(true);
    if (!confirmed.ok) return;
    expect(confirmed.value.kind).toBe('answer');
    expect(confirmed.value.card.title).toBe('Refusé — rien n’a été modifié');
    expect(confirmed.value.card.body).toBe(cumulMessage);
  });

  it('plusieurs devis signés SANS cible dite : question structurée (jamais un choix silencieux)', async () => {
    const agent = agentWith({
      listInvoiceableQuotes: async () =>
        ok([
          SIGNED_QUOTE,
          { ...SIGNED_QUOTE, id: 'sign-2', number: 'D-2026-0032', customerName: 'Camping Les Pins' },
        ]),
      generateInvoice: async () => ok({ invoiceId: 'sit-1' }),
    });
    const r = await agent.ask('Facture une situation de 40 %');
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.kind).toBe('answer');
    expect(r.value.ask?.[0]?.id).toBe('facturer_situation.cible');
    expect(r.value.ask?.[0]?.options.length).toBeGreaterThanOrEqual(2);
    // Le followUp reprend la commande canonique — le tour suivant reparse tout.
    expect(r.value.ask?.[0]?.options[0]?.followUp).toBe('Facture une situation sur le devis D-2026-0031');
  });
});

describe('definir_conditions_paiement — B4 : « Durand paie à 45 jours fin de mois »', () => {
  it('propose (plancher de consentement) puis confirme via le MÊME chemin UpdateCustomer', async () => {
    const setTerms = vi.fn(async () =>
      ok({ customerId: 'cus-durand', customerName: 'Durand SARL', days: 45, endOfMonth: true, label: '45 jours fin de mois' }),
    );
    const agent = agentWith({
      listBillableCustomers: async () => ok(CUSTOMERS),
      setCustomerPaymentTerms: setTerms,
    });
    const r = await agent.ask('Durand paie à 45 jours fin de mois', { autonomy: 'auto' });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.intent).toBe('conditions_paiement');
    expect(r.value.kind).toBe('proposed');
    expect(r.value.pending?.tool).toBe('definir_conditions_paiement');
    expect(r.value.pending?.args).toEqual({
      customerId: 'cus-durand',
      days: 45,
      endOfMonth: true,
      label: '45 jours fin de mois',
    });
    expect(setTerms).not.toHaveBeenCalled();

    const done = await agent.confirm(r.value.pending!);
    expect(done.ok).toBe(true);
    if (!done.ok) return;
    expect(done.value.kind).toBe('done');
    expect(done.value.card.title).toBe('Conditions enregistrées ✓');
    expect(setTerms).toHaveBeenCalledWith({
      customerId: 'cus-durand',
      days: 45,
      endOfMonth: true,
      label: '45 jours fin de mois',
    });
  });

  it('plafond légal L441-10 (pro, 90 jours) : refus AVANT proposition, message du domaine + maxima légaux en choix', async () => {
    const setTerms = vi.fn(async () =>
      ok({ customerId: 'cus-durand', customerName: 'Durand SARL', days: 90, endOfMonth: false, label: 'x' }),
    );
    const agent = agentWith({
      listBillableCustomers: async () => ok(CUSTOMERS),
      setCustomerPaymentTerms: setTerms,
    });
    const r = await agent.ask('Durand paie à 90 jours');
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.kind).toBe('answer');
    expect(r.value.card.title).toBe('Refusé — rien n’a été modifié');
    expect(r.value.card.body).toContain('60 jours');
    expect(r.value.card.body).toContain('L441-10');
    expect(r.value.choices?.map((c) => c.value)).toContain('Le client Durand SARL paie à 60 jours');
    expect(setTerms).not.toHaveBeenCalled();
  });

  it('client PARTICULIER (b2c) : L441-10 ne s’applique pas — 90 jours proposables', async () => {
    const agent = agentWith({
      listBillableCustomers: async () => ok(CUSTOMERS),
      setCustomerPaymentTerms: async () =>
        ok({ customerId: 'cus-girard', customerName: 'Mme Girard', days: 90, endOfMonth: false, label: 'Paiement à 90 jours' }),
    });
    const r = await agent.ask('Mme Girard paie à 90 jours');
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.kind).toBe('proposed');
    expect(r.value.pending?.args).toMatchObject({ customerId: 'cus-girard', days: 90, endOfMonth: false });
  });

  it('acheteur PUBLIC (b2g) au-delà de 30 jours : conseil honnête R2192-10 dans la proposition (jamais un blocage inventé)', async () => {
    const agent = agentWith({
      listBillableCustomers: async () => ok(CUSTOMERS),
      setCustomerPaymentTerms: async () =>
        ok({ customerId: 'cus-mairie', customerName: 'Mairie de Vitry', days: 45, endOfMonth: false, label: 'Paiement à 45 jours' }),
    });
    const r = await agent.ask('La Mairie de Vitry paie à 45 jours');
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.kind).toBe('proposed');
    expect(r.value.card.body).toContain('R2192-10');
  });

  it('délai manquant : question honnête, rien n’est modifié', async () => {
    const setTerms = vi.fn(async () =>
      ok({ customerId: 'cus-durand', customerName: 'Durand SARL', days: 30, endOfMonth: false, label: 'x' }),
    );
    const agent = agentWith({
      listBillableCustomers: async () => ok(CUSTOMERS),
      setCustomerPaymentTerms: setTerms,
    });
    const r = await agent.ask('Change les conditions de paiement de Durand');
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.kind).toBe('answer');
    expect(r.value.card.title).toBe('Quel délai ?');
    expect(setTerms).not.toHaveBeenCalled();
  });

  it('client non reconnu : question avec les clients RÉELS en options (followUp = commande canonique)', async () => {
    const agent = agentWith({
      listBillableCustomers: async () => ok(CUSTOMERS),
      setCustomerPaymentTerms: async () =>
        ok({ customerId: 'x', customerName: 'x', days: 30, endOfMonth: false, label: 'x' }),
    });
    const r = await agent.ask('Bidule paie à 30 jours');
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.kind).toBe('answer');
    expect(r.value.card.title).toBe('Quel client ?');
    expect(r.value.choices?.map((c) => c.value)).toContain('Le client Durand SARL paie à 30 jours');
  });

  it('hôte SANS setCustomerPaymentTerms (rétro-compat) : réponse honnête, rien n’est proposé', async () => {
    const agent = agentWith({ listBillableCustomers: async () => ok(CUSTOMERS) });
    const r = await agent.ask('Durand paie à 45 jours fin de mois');
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.kind).toBe('answer');
    expect(r.value.card.body).toContain('Rien n’a été modifié');
  });
});
