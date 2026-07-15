import { describe, it, expect, vi } from 'vitest';
import { ok, err, appNotFound, formatEUR, type FiscalDeadline, type OwnerPayGuidance } from '@bob/core';
import { BobAgent } from './bob-agent';
import { ModelRouter } from '../router/model-router';
import { type BobActions } from './actions';
import { type LlmPort } from '../llm/port';

const actions: BobActions = {
  computePayout: async () => ok({ payoutCents: 180000, availableCents: 495000 }),
  draftRelance: async () => ok({ subject: 'Petit rappel', body: 'Bonjour, un petit rappel pour votre facture.' }),
  listPayableInvoices: async () =>
    ok([
      { id: 'inv-1', number: '2026-014', remainingCents: 132000, customerName: 'Durand SARL' },
      { id: 'inv-2', number: '2026-021', remainingCents: 45000, customerName: 'M. Martin' },
    ]),
  listSendableQuotes: async () =>
    ok([
      { id: 'quote-1', number: 'D2026-014', totalTtcCents: 264000, customerName: 'Durand SARL', status: 'draft' },
      { id: 'quote-2', number: 'D2026-021', totalTtcCents: 90000, customerName: 'M. Martin', status: 'sent' },
    ]),
  listIssuableInvoices: async () =>
    ok([{ id: 'draft-inv-1', number: null, totalTtcCents: 264000, customerName: 'Durand SARL', status: 'draft' }]),
  listDocuments: async () =>
    ok([
      {
        id: 'doc-1',
        filename: 'facture-F2026-001.pdf',
        kind: 'invoice_pdf',
        linkedEntityType: 'invoice',
        linkedEntityId: 'inv-1',
        createdAt: '2026-07-01T10:00:00.000Z',
      },
    ]),
  // ASK-2 : deux devis signés facturables — sign-1 prévoit un acompte NON facturé (la
  // question acompte/solde doit se poser), sign-2 a déjà son acompte (finale = évidence).
  listInvoiceableQuotes: async () =>
    ok([
      { id: 'sign-1', number: 'D2026-030', customerName: 'Boulangerie Lefèvre', totalTtcCents: 302500, depositPct: 40, depositInvoiced: false },
      { id: 'sign-2', number: 'D2026-031', customerName: 'Camping Les Pins', totalTtcCents: 120000, depositPct: 30, depositInvoiced: true },
    ]),
  generateInvoice: async () => ok({ invoiceId: 'generated-1' }),
  registerPayment: async () => ok({ status: 'paid' }),
  sendQuote: async () => ok({ number: 'D2026-014' }),
  issueInvoice: async () => ok({ number: 'F2026-001' }),
};
const makeAgent = () => new BobAgent({ router: new ModelRouter({ hasClaudeKey: false, hasGlmKey: false }), actions });

describe('BobAgent (démo)', () => {
  it('payout : montant issu du domaine, lecture directe', async () => {
    const r = await makeAgent().ask('Combien je peux me verser ce mois-ci ?');
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.value.intent).toBe('payout');
      expect(r.value.kind).toBe('answer');
      expect(r.value.card.body).toContain('1');
    }
  });

  it('payout : hôte SANS getOwnerPayGuidance (rétro-compat) → langage prudent historique, computePayout seul appelé', async () => {
    const r = await makeAgent().ask('Combien je peux me verser ?');
    expect(r.ok).toBe(true);
    if (r.ok && r.value.kind === 'answer') {
      expect(r.value.card.body).toContain('trésorerie mobilisable');
      expect(r.value.card.body).toContain('Ta rémunération exacte dépend de ton statut');
    }
  });

  describe('payout — Phase 1C : parité voix ↔ écrans (getOwnerPayGuidance)', () => {
    const withGuidance = (guidance: OwnerPayGuidance, payoutCents = 500000) =>
      new BobAgent({
        router: new ModelRouter({ hasClaudeKey: false, hasGlmKey: false }),
        actions: { ...actions, getOwnerPayGuidance: async () => ok({ guidance, payoutCents }) },
      });

    it('kind prudent (via guidance) : MÊME phrase que le repli historique', async () => {
      const agent = withGuidance(
        { kind: 'prudent', headlineKey: 'argent.heroLabel', captionKey: 'argent.heroCaption', params: { amount: formatEUR(180000) } },
        180000,
      );
      const r = await agent.ask('Combien je peux me verser ?');
      expect(r.ok).toBe(true);
      if (r.ok && r.value.kind === 'answer') {
        expect(r.value.card.body).toBe(
          `Tu as ${formatEUR(180000)} de trésorerie mobilisable sans toucher tes réserves. Ta rémunération exacte dépend de ton statut, je te la précise bientôt.`,
        );
      }
    });

    it('kind micro_retrait_prudent : montant du RETRAIT (amountCents), taux et note ACRE dans le texte', async () => {
      const agent = withGuidance(
        {
          kind: 'micro_retrait_prudent',
          amountCents: 288000,
          headlineKey: 'fiscal.guidance.microRetraitPrudent.headline',
          captionKey: 'fiscal.guidance.microRetraitPrudent.caption',
          params: { amount: formatEUR(288000), ratePct: '21,2', acreNote: ' Note ACRE.' },
        },
        500000,
      );
      const r = await agent.ask('Combien je peux me verser ?');
      expect(r.ok).toBe(true);
      if (r.ok && r.value.kind === 'answer') {
        expect(r.value.card.body).toContain('Tu peux te prendre');
        expect(r.value.card.body).toContain(formatEUR(288000));
        expect(r.value.card.body).toContain('21,2 %');
        expect(r.value.card.body).toContain('Note ACRE.');
        expect(r.value.card.body).not.toContain(formatEUR(500000)); // jamais le payout brut : le retrait prime
      }
    });

    it('kind salaire_a_simuler : montant = payoutCents (INCHANGÉ), jamais un net inventé', async () => {
      const agent = withGuidance(
        {
          kind: 'salaire_a_simuler',
          headlineKey: 'fiscal.guidance.salaireASimuler.headline',
          captionKey: 'fiscal.guidance.salaireASimuler.caption',
          params: { amount: formatEUR(500000) },
        },
        500000,
      );
      const r = await agent.ask('Combien je peux me verser ?');
      expect(r.ok).toBe(true);
      if (r.ok && r.value.kind === 'answer') {
        expect(r.value.card.body).toContain('budget employeur mobilisable');
        expect(r.value.card.body).toContain(formatEUR(500000));
        expect(r.value.card.body).toContain('se simule avec ton profil');
      }
    });

    it('kind prelevement_apres_provisions : montant = payoutCents, mention honnête des provisions TNS', async () => {
      const agent = withGuidance(
        {
          kind: 'prelevement_apres_provisions',
          headlineKey: 'fiscal.guidance.prelevementApresProvisions.headline',
          captionKey: 'fiscal.guidance.prelevementApresProvisions.caption',
          params: { amount: formatEUR(500000) },
        },
        500000,
      );
      const r = await agent.ask('Combien je peux me verser ?');
      expect(r.ok).toBe(true);
      if (r.ok && r.value.kind === 'answer') {
        expect(r.value.card.body).toContain(formatEUR(500000));
        expect(r.value.card.body).toContain('provisions personnelles');
      }
    });

    it('getOwnerPayGuidance en erreur → repli sur computePayout (jamais un échec de l’intent)', async () => {
      const agent = new BobAgent({
        router: new ModelRouter({ hasClaudeKey: false, hasGlmKey: false }),
        actions: {
          ...actions,
          getOwnerPayGuidance: async () => err(appNotFound('fiscal-profile', 'x')),
        },
      });
      const r = await agent.ask('Combien je peux me verser ?');
      expect(r.ok).toBe(true);
      if (r.ok && r.value.kind === 'answer') {
        expect(r.value.card.body).toContain('Ta rémunération exacte dépend de ton statut');
      }
    });
  });

  it('relance : brouillon (lecture)', async () => {
    const r = await makeAgent().ask('Tu peux relancer le client en retard ?');
    expect(r.ok && r.value.intent).toBe('relance');
    expect(r.ok && r.value.kind).toBe('answer');
  });

  it('relance CIBLÉE (C25 ①) : « relance Martin » vise sa facture, sans cible → défaut hôte', async () => {
    const targets: unknown[] = [];
    const spyActions: BobActions = {
      ...actions,
      draftRelance: async (input) => {
        targets.push(input);
        return ok({ subject: 'Relance', body: 'Brouillon.' });
      },
    };
    const agent = new BobAgent({ router: new ModelRouter({ hasClaudeKey: false, hasGlmKey: false }), actions: spyActions });

    const targeted = await agent.ask('Relance Martin pour sa facture');
    expect(targeted.ok && targeted.value.intent).toBe('relance');
    expect(targeted.ok && targeted.value.plan[0]).toContain('2026-021'); // facture de M. Martin

    const generic = await agent.ask('Relance les clients en retard');
    expect(generic.ok && generic.value.kind).toBe('answer');

    // Cible explicite transmise à l'hôte ; demande générique = undefined (défaut : la plus urgente).
    expect(targets).toEqual([{ invoiceId: 'inv-2' }, undefined]);
  });

  it('encaisser par numéro : confirmation TOUJOURS requise (plancher), même en mode par défaut', async () => {
    const r = await makeAgent().ask('encaisse la facture 2026-014');
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.value.intent).toBe('encaisser');
      expect(r.value.kind).toBe('proposed');
      expect(r.value.pending?.args).toMatchObject({ invoiceId: 'inv-1' });
    }
  });

  it('encaisser : résout la facture par nom de client (« est payée ») puis propose (plancher)', async () => {
    const r = await makeAgent().ask('la facture de Durand est payée');
    expect(r.ok && r.value.intent).toBe('encaisser');
    expect(r.ok && r.value.kind).toBe('proposed');
  });

  it('encaisser : mode « tout confirmer » -> propose et attend confirmation', async () => {
    const r = await makeAgent().ask('encaisse la facture 2026-014', { autonomy: 'confirm_all' });
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.value.kind).toBe('proposed');
      expect(r.value.pending?.args).toMatchObject({ invoiceId: 'inv-1', amountCents: 132000 });
    }
  });

  it('confirm : exécute l’action proposée', async () => {
    const agent = makeAgent();
    const p = await agent.ask('encaisse la facture 2026-014', { autonomy: 'confirm_all' });
    expect(p.ok && p.value.pending).toBeTruthy();
    if (p.ok && p.value.pending) {
      const r = await agent.confirm(p.value.pending);
      expect(r.ok && r.value.kind).toBe('done');
    }
  });

  it('encaisser ambigu (aucune référence, plusieurs factures) : demande laquelle', async () => {
    const r = await makeAgent().ask('marque comme payé');
    expect(r.ok && r.value.kind).toBe('answer');
    expect(r.ok && r.value.intent).toBe('encaisser');
  });

  it('ASK-1 : l’ambiguïté émet une question STRUCTURÉE dont le followUp re-résout l’intent', async () => {
    const agent = makeAgent();
    const r = await agent.ask('marque comme payé');
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const question = r.value.ask?.[0];
    expect(question).toBeDefined();
    if (!question) return;
    expect(question.header.length).toBeLessThanOrEqual(12);
    expect(question.options.length).toBeGreaterThanOrEqual(2);
    expect(question.options.length).toBeLessThanOrEqual(4);
    // Chaque option porte sa COMMANDE de suivi — l'UI ne reconstruit jamais une phrase.
    for (const option of question.options) expect(option.followUp.length).toBeGreaterThan(0);
    // La rétro-compatibilité tient : choices reste rempli en parallèle.
    expect(r.value.choices?.length).toBeGreaterThanOrEqual(2);
    // Boucle fermée : répondre par le followUp de la 1re option aboutit à la proposition d'encaissement.
    const followUp = question.options[0]!.followUp;
    const after = await agent.ask(followUp);
    expect(after.ok && after.value.intent).toBe('encaisser');
    expect(after.ok && after.value.kind).toBe('proposed');
  });

  it('ASK-2 : « fais la facture du devis » avec acompte prévu NON facturé → question acompte/solde, boucle fermée', async () => {
    const agent = makeAgent();
    const r = await agent.ask('Fais la facture du devis D2026-030');
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    // La cible est résolue mais le MODE manque : Bob pose la question au lieu de choisir.
    expect(r.value.intent).toBe('generer_facture');
    expect(r.value.kind).toBe('answer');
    const question = r.value.ask?.[0];
    expect(question?.id).toBe('generer_facture.mode');
    expect(question?.options.map((o) => o.value)).toEqual(['deposit', 'final']);
    // Boucle fermée : le followUp « acompte » aboutit à la PROPOSITION (palier fiscal : toujours confirmée).
    const deposit = await agent.ask(question!.options[0]!.followUp);
    expect(deposit.ok && deposit.value.kind).toBe('proposed');
    expect(deposit.ok && deposit.value.pending?.tool).toBe('generer_facture');
    expect(deposit.ok && deposit.value.pending?.args).toMatchObject({ quoteId: 'sign-1', mode: 'deposit' });
  });

  it('ASK-2 : acompte DÉJÀ facturé → la finale est l’évidence, aucune question inutile', async () => {
    const r = await makeAgent().ask('Fais la facture du devis D2026-031');
    expect(r.ok && r.value.kind).toBe('proposed');
    expect(r.ok && r.value.pending?.args).toMatchObject({ quoteId: 'sign-2', mode: 'final' });
    expect(r.ok && (r.value.ask ?? []).length).toBe(0);
  });

  it('ASK-2 : sans cible → question « quel devis ? » avec l’acompte prévu dans la description', async () => {
    const r = await makeAgent().ask('Génère la facture du devis');
    expect(r.ok && r.value.intent).toBe('generer_facture');
    const question = r.ok ? r.value.ask?.[0] : undefined;
    expect(question?.id).toBe('generer_facture.cible');
    expect(question?.options[0]?.description).toContain('acompte 40 % prévu');
  });

  it('envoyer un devis : sortant client -> propose toujours une confirmation', async () => {
    const r = await makeAgent().ask('envoie le devis 2026-014 au client', { autonomy: 'auto' });
    expect(r.ok && r.value.intent).toBe('envoyer_devis');
    expect(r.ok && r.value.kind).toBe('proposed');
    if (r.ok) expect(r.value.pending?.tool).toBe('envoyer_devis');
  });

  it('émettre une facture : pièce légale -> propose toujours une confirmation', async () => {
    const r = await makeAgent().ask('émets la facture Durand', { autonomy: 'auto' });
    expect(r.ok && r.value.intent).toBe('emettre_facture');
    expect(r.ok && r.value.kind).toBe('proposed');
    if (r.ok) expect(r.value.pending?.tool).toBe('emettre_facture');
  });

  it('documents : liste les pièces archivées sans mutation', async () => {
    const r = await makeAgent().ask('montre mes documents archivés');
    expect(r.ok && r.value.intent).toBe('documents');
    expect(r.ok && r.value.kind).toBe('answer');
    if (r.ok) expect(r.value.card.body).toContain('facture-F2026-001.pdf');
  });

  it('échéances fiscales (C-EXP5b) : lecture formatée sobre — date FR, libellé, « à confirmer » sur les hypothèses', async () => {
    const deadlines: FiscalDeadline[] = [
      {
        id: 'cfe-acompte-2026',
        date: '2026-06-15',
        label: 'CFE : acompte (si CFE N-1 ≥ 3 000 €)',
        kind: 'cfe',
        amountHint: null,
        legalRef: 'art. 1679 quinquies CGI',
        confidence: 'assumed',
        explain: "Un acompte de 50 % de CFE n'est dû à cette date que si ta CFE de l'an dernier a atteint 3 000 €.",
      },
      {
        id: 'tva-ca12-2026',
        date: '2026-05-05',
        label: 'TVA : déclaration annuelle CA12',
        kind: 'tva',
        amountHint: null,
        legalRef: 'art. 287, 3 CGI',
        confidence: 'certain',
        explain: 'Ta déclaration annuelle de TVA (CA12) se dépose le deuxième jour ouvré qui suit le 1er mai.',
      },
    ];
    const withFiscal: BobActions = { ...actions, listFiscalDeadlines: async () => ok(deadlines) };
    const agent = new BobAgent({ router: new ModelRouter({ hasClaudeKey: false, hasGlmKey: false }), actions: withFiscal });

    const r = await agent.ask('quelles sont mes prochaines échéances fiscales ?');
    expect(r.ok && r.value.intent).toBe('echeances');
    expect(r.ok && r.value.kind).toBe('answer');
    if (!r.ok) return;
    // Formatage sobre : date + libellé + explication ; « à confirmer » UNIQUEMENT sur les 'assumed'.
    expect(r.value.card.body).toContain('• 15/06/2026 — CFE : acompte (si CFE N-1 ≥ 3 000 €) (à confirmer)');
    expect(r.value.card.body).toContain("Un acompte de 50 % de CFE n'est dû à cette date");
    expect(r.value.card.body).toContain('• 05/05/2026 — TVA : déclaration annuelle CA12\n');
    expect(r.value.card.body).not.toContain('CA12 (à confirmer)');
  });

  it('échéances : hôte SANS la capacité → réponse honnête, jamais un calendrier inventé', async () => {
    const r = await makeAgent().ask('mes échéances fiscales');
    expect(r.ok && r.value.intent).toBe('echeances');
    expect(r.ok && r.value.kind).toBe('answer');
    if (r.ok) expect(r.value.card.body).toContain('pas accès au calendrier fiscal');
  });

  it('abonnement (pilier 2) : essai en cours → réponse factuelle (jours restants, échéance), lecture SEULE', async () => {
    const withSubscription: BobActions = {
      ...actions,
      getSubscriptionStatus: async () =>
        ok({
          plan: 'pro' as const,
          status: 'trialing' as const,
          trialEndsAt: '2026-07-28T09:00:00.000Z',
          trialPhase: 'ending_soon' as const,
          trialDaysLeft: 2,
          currentPeriodEnd: null,
          store: null,
          storeRef: null,
          source: 'db' as const,
        }),
    };
    const agent = new BobAgent({ router: new ModelRouter({ hasClaudeKey: false, hasGlmKey: false }), actions: withSubscription });

    const r = await agent.ask('où en est mon essai ?');
    expect(r.ok && r.value.intent).toBe('abonnement');
    expect(r.ok && r.value.kind).toBe('answer'); // JAMAIS une proposition d'achat vocal (SPEC décision 10)
    if (!r.ok) return;
    expect(r.value.card.body).toContain('Essai Pro en cours');
    expect(r.value.card.body).toContain('2 jours');
    expect(r.value.card.body).toContain('28/07/2026');
  });

  it('abonnement : hôte SANS la capacité → réponse honnête, jamais un état inventé', async () => {
    const r = await makeAgent().ask('où en est mon abonnement ?');
    expect(r.ok && r.value.intent).toBe('abonnement');
    expect(r.ok && r.value.kind).toBe('answer');
    if (r.ok) expect(r.value.card.body).toContain('pas accès à l’état de ton abonnement');
  });

  it('demande inconnue : aide sans rien inventer', async () => {
    const r = await makeAgent().ask('Bonjour Bob');
    expect(r.ok && r.value.intent).toBe('unknown');
  });

  it('émet les phases comprends -> agis pour une action résolue', async () => {
    const phases: string[] = [];
    await makeAgent().ask('encaisse la facture 2026-014', { onPhase: (p) => phases.push(p) });
    expect(phases).toContain('comprends');
    expect(phases).toContain('agis');
  });

  it('demande inconnue : émet comprends mais jamais agis', async () => {
    const phases: string[] = [];
    await makeAgent().ask('Bonjour Bob', { onPhase: (p) => phases.push(p) });
    expect(phases).toEqual(['comprends']);
  });
});

describe('BobAgent — chemin LLM (tool-calling) + fallback', () => {
  const routerWithKey = new ModelRouter({ hasClaudeKey: false, hasGlmKey: true });

  it('confidentialité : une réponse monétaire reste canonique et n atteint jamais naturalize', async () => {
    const generate = vi.fn(async () => ({ text: 'Ne doit jamais être appelée.', model: 'glm' }));
    const llm: LlmPort = {
      id: 'fake',
      async complete() {
        return { text: null, toolCalls: [{ name: 'tresorerie_versement', arguments: {} }], model: 'glm' };
      },
      generate,
      async health() {
        return { healthy: true };
      },
    };
    const result = await new BobAgent({ router: routerWithKey, actions, llm }).ask('je peux me payer combien ?');
    expect(result.ok && result.value.naturalBody).toBeUndefined();
    expect(result.ok && result.value.card.body).toContain('800,00'); // gabarit exact
    expect(generate).not.toHaveBeenCalled();
  });

  it('confidentialité : une réponse métier sans aucun fait numérique n atteint jamais naturalize', async () => {
    const generate = vi.fn(async () => ({ text: 'Ne doit jamais être appelée.', model: 'glm' }));
    const llm: LlmPort = {
      id: 'fake',
      async complete() {
        return { text: null, toolCalls: [{ name: 'documents_liste', arguments: {} }], model: 'glm' };
      },
      generate,
      async health() {
        return { healthy: true };
      },
    };
    const noDocuments: BobActions = { ...actions, listDocuments: async () => ok([]) };

    const result = await new BobAgent({ router: routerWithKey, actions: noDocuments, llm }).ask('montre mes documents');

    expect(result.ok && result.value.intent).toBe('documents');
    expect(result.ok && result.value.card.body).toBe('Aucun document archivé pour le moment.');
    expect(result.ok && result.value.naturalBody).toBeUndefined();
    expect(generate).not.toHaveBeenCalled();
  });

  it('confidentialité : un contexte tenant ferme aussi la naturalisation d une réponse unknown', async () => {
    const generate = vi.fn(async () => ({ text: 'Ne doit jamais être appelée.', model: 'glm' }));
    const llm: LlmPort = {
      id: 'fake',
      async complete() {
        return { text: 'hors outil', toolCalls: [], model: 'glm' };
      },
      generate,
      async health() {
        return { healthy: true };
      },
    };

    const result = await new BobAgent({ router: routerWithKey, actions, llm }).ask('Bonjour Bob', {
      context: {
        screen: { name: '/clients', instanceId: 'clients' },
        entities: [{ type: 'customer', id: 'customer-1', label: 'Durand' }],
        capabilities: ['customer.read'],
      },
    });

    expect(result.ok && result.value.intent).toBe('unknown');
    expect(result.ok && result.value.naturalBody).toBeUndefined();
    expect(generate).not.toHaveBeenCalled();
  });

  it('LIVE-2 : une carte générique non sensible peut encore être naturalisée', async () => {
    const llm: LlmPort = {
      id: 'fake',
      async complete() {
        return { text: 'hors outil', toolCalls: [], model: 'glm' };
      },
      async generate() {
        return { text: 'Je peux t’aider sur ton administratif et ta compta.', model: 'glm' };
      },
      async health() {
        return { healthy: true };
      },
    };
    const result = await new BobAgent({ router: routerWithKey, actions, llm }).ask('Bonjour Bob');
    expect(result.ok && result.value.intent).toBe('unknown');
    expect(result.ok && result.value.naturalBody).toContain('administratif');
  });

  it('LIVE-2 : l’historique de conversation est transmis au classifieur (anaphores)', async () => {
    let seen: number | null = null;
    const llm: LlmPort = {
      id: 'fake',
      async complete(messages) {
        seen = messages.length;
        return { text: null, toolCalls: [{ name: 'tresorerie_versement', arguments: {} }], model: 'glm' };
      },
      async generate() {
        return { text: '', model: 'glm' };
      },
      async health() {
        return { healthy: true };
      },
    };
    await new BobAgent({ router: routerWithKey, actions, llm }).ask('et du coup ?', {
      history: [
        { role: 'user', text: 'je peux me payer combien ?' },
        { role: 'bob', text: 'Tu peux te verser 1 800,00 €.' },
      ],
    });
    expect(seen).toBe(3); // 2 tours d'historique + le message courant
  });

  it('utilise le tool-call du LLM pour router + résoudre la facture', async () => {
    const llm: LlmPort = {
      id: 'fake',
      async complete() {
        return { text: null, toolCalls: [{ name: 'encaisser_facture', arguments: { reference: '2026-014' } }], model: 'glm' };
      },
      async generate() {
        return { text: '', model: 'glm' };
      },
      async health() {
        return { healthy: true };
      },
    };
    const agent = new BobAgent({ router: routerWithKey, actions, llm });
    const r = await agent.ask('tu peux noter que la 14 est réglée', { autonomy: 'auto' });
    expect(r.ok && r.value.intent).toBe('encaisser');
    // Plancher : même en 'auto', le posting d'un paiement se confirme (via un OK rapide).
    expect(r.ok && r.value.kind).toBe('proposed');
  });

  it('garde-fou périmètre : une demande hors-sujet (LLM répond en texte, pas d’outil) -> unknown', async () => {
    const llm: LlmPort = {
      id: 'fake',
      async complete() {
        // Hors périmètre : le LLM ne renvoie aucun appel d'outil (juste du texte, qu'on ignore).
        return { text: 'La capitale du Japon est Tokyo.', toolCalls: [], model: 'glm' };
      },
      async generate() {
        return { text: '', model: 'glm' };
      },
      async health() {
        return { healthy: true };
      },
    };
    const r = await new BobAgent({ router: routerWithKey, actions, llm }).ask('quelle est la capitale du Japon ?');
    expect(r.ok && r.value.intent).toBe('unknown');
    // Le texte libre du LLM n'est jamais affiché : on rend notre message de périmètre.
    if (r.ok) expect(r.value.card.body).not.toContain('Tokyo');
  });

  it('garde-fou périmètre (sans LLM) : hors-sujet -> unknown', async () => {
    const r = await makeAgent().ask('raconte-moi une blague');
    expect(r.ok && r.value.intent).toBe('unknown');
  });

  const llmTwoEncaisse: LlmPort = {
    id: 'fake',
    async complete() {
      return {
        text: null,
        toolCalls: [
          { name: 'encaisser_facture', arguments: { reference: '2026-014' } },
          { name: 'encaisser_facture', arguments: { reference: '2026-021' } },
        ],
        model: 'glm',
      };
    },
    async generate() {
      return { text: '', model: 'glm' };
    },
    async health() {
      return { healthy: true };
    },
  };

  it('plan multi-étapes : 2 encaissements en auto -> plancher, propose le lot à confirmer', async () => {
    const r = await new BobAgent({ router: routerWithKey, actions, llm: llmTwoEncaisse }).ask('encaisse Durand et Martin', {
      autonomy: 'auto',
    });
    expect(r.ok && r.value.kind).toBe('proposed');
    if (r.ok) expect(r.value.pending?.batch?.length).toBe(2);
  });

  it('plan multi-étapes : confirm_all propose le lot, puis confirm l’exécute', async () => {
    const agent = new BobAgent({ router: routerWithKey, actions, llm: llmTwoEncaisse });
    const p = await agent.ask('encaisse Durand et Martin', { autonomy: 'confirm_all' });
    expect(p.ok && p.value.kind).toBe('proposed');
    expect(p.ok && p.value.pending?.batch?.length).toBe(2);
    if (p.ok && p.value.pending) {
      const r = await agent.confirm(p.value.pending);
      expect(r.ok && r.value.kind).toBe('done');
    }
  });

  it('retombe sur la regex si le LLM échoue (jamais bloquant)', async () => {
    const llm: LlmPort = {
      id: 'down',
      async complete() {
        throw new Error('LLM indisponible');
      },
      async generate() {
        throw new Error('down');
      },
      async health() {
        return { healthy: false };
      },
    };
    const agent = new BobAgent({ router: routerWithKey, actions, llm });
    const r = await agent.ask('combien je peux me verser ?');
    expect(r.ok && r.value.intent).toBe('payout');
  });

  it('ne transforme jamais une annulation en fallback regex ni en appel métier tardif', async () => {
    const controller = new AbortController();
    const computePayout = vi.fn(actions.computePayout);
    let providerSignal: AbortSignal | undefined;
    const llm: LlmPort = {
      id: 'slow',
      complete: async (_messages, opts) => {
        providerSignal = opts?.signal;
        return new Promise((_resolve, reject) => {
          opts?.signal?.addEventListener('abort', () => reject(opts.signal?.reason), { once: true });
        });
      },
      generate: async () => ({ text: '', model: 'slow' }),
      health: async () => ({ healthy: true }),
    };
    const agent = new BobAgent({
      router: routerWithKey,
      actions: { ...actions, computePayout },
      llm,
    });

    const running = agent.ask('combien je peux me verser ?', { signal: controller.signal });
    await vi.waitFor(() => expect(providerSignal).toBe(controller.signal));
    controller.abort();

    await expect(running).rejects.toMatchObject({ name: 'AbortError' });
    expect(computePayout).not.toHaveBeenCalled();
  });
});

describe('BobAgent — navigation (Jarvis : ouvrir le bon écran)', () => {
  const agent = () => new BobAgent({ router: new ModelRouter({ hasClaudeKey: false, hasGlmKey: false }), actions });

  it('« scanne ce reçu » -> ouvre le scanner OCR', async () => {
    const r = await agent().ask('hello Bob, scanne ce reçu de fournitures pour le chantier');
    expect(r.ok && r.value.intent).toBe('scan');
    expect(r.ok && r.value.navigate).toBe('/scan-document');
  });

  it('« fais un devis » -> ouvre l’écran de devis', async () => {
    const r = await agent().ask('fais-moi un devis');
    expect(r.ok && r.value.navigate).toBe('/devis/new');
  });

  it('« mes chantiers » -> ouvre les chantiers', async () => {
    const r = await agent().ask('montre mes chantiers');
    expect(r.ok && r.value.navigate).toBe('/chantiers');
  });

  it('« Prêt pour 2026 ? » (chip C15) -> ouvre le diagnostic conformité (C40 ⑦)', async () => {
    const r = await agent().ask('Prêt pour 2026 ?');
    expect(r.ok && r.value.intent).toBe('diagnostic');
    expect(r.ok && r.value.kind).toBe('done');
    expect(r.ok && r.value.navigate).toBe('/diagnostic');
  });
});
