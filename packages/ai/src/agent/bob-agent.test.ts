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
    ok([{ id: 'draft-inv-1', number: null, totalTtcCents: 264000, customerName: 'Durand SARL', status: 'draft', operationCategoryRequired: false }]),
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

  it('ASK-2 : acompte professionnel indisponible → explication réelle, aucune proposition morte', async () => {
    const generateInvoice = vi.fn(actions.generateInvoice);
    const agent = new BobAgent({
      router: new ModelRouter({ hasClaudeKey: false, hasGlmKey: false }),
      actions: {
        ...actions,
        listInvoiceableQuotes: async () =>
          ok([
            {
              id: 'sign-pro',
              number: 'D2026-099',
              customerName: 'Durand SARL',
              totalTtcCents: 480000,
              depositPct: 30,
              depositInvoiced: false,
              depositAvailable: false,
              depositUnavailableReason: 'Parcours professionnel en attente de certification EXTENDED.',
            },
          ]),
        generateInvoice,
      },
    });

    const explicit = await agent.ask("Fais la facture d'acompte du devis D2026-099");
    expect(explicit.ok && explicit.value.kind).toBe('answer');
    expect(explicit.ok && explicit.value.card.body).toContain('EXTENDED');
    expect(explicit.ok && explicit.value.pending).toBeUndefined();

    const ambiguous = await agent.ask('Fais la facture du devis D2026-099');
    expect(ambiguous.ok && ambiguous.value.kind).toBe('answer');
    expect(ambiguous.ok && ambiguous.value.choices?.map((choice) => choice.label)).toEqual([
      'Facture finale',
    ]);
    expect(generateInvoice).not.toHaveBeenCalled();
  });

  it('ASK-2 : sans cible → question « quel devis ? » avec l’acompte prévu dans la description', async () => {
    const r = await makeAgent().ask('Génère la facture du devis');
    expect(r.ok && r.value.intent).toBe('generer_facture');
    const question = r.ok ? r.value.ask?.[0] : undefined;
    expect(question?.id).toBe('generer_facture.cible');
    expect(question?.options[0]?.description).toContain('acompte 40 % prévu');
  });

  // A3 — gel de rétractation B2C (art. L221-18 s. c. conso) : Bob explique le gel avec la
  // date de déblocage au lieu de proposer une finale vouée au refus du domaine.
  describe('A3 — generer_facture pendant le délai de rétractation B2C', () => {
    const gelActions = (quote: Record<string, unknown>) => ({
      ...actions,
      listInvoiceableQuotes: async () =>
        ok([
          {
            id: 'sign-b2c',
            number: 'D2026-032',
            customerName: 'Mme Petit',
            totalTtcCents: 480000,
            depositPct: 30,
            depositInvoiced: false,
            finalBlockedUntil: '2026-08-04',
            ...quote,
          } as never,
        ]),
    });
    const agentWith = (quote: Record<string, unknown> = {}) =>
      new BobAgent({ router: new ModelRouter({ hasClaudeKey: false, hasGlmKey: false }), actions: gelActions(quote) });

    it('finale demandée explicitement → réponse honnête (pourquoi, date, acompte possible), rien de généré', async () => {
      const r = await agentWith().ask('Fais la facture finale du devis D2026-032');
      expect(r.ok).toBe(true);
      if (!r.ok) return;
      expect(r.value.intent).toBe('generer_facture');
      expect(r.value.kind).toBe('answer');
      expect(r.value.card.body).toContain('rétractation');
      expect(r.value.card.body).toContain('04/08/2026');
      expect(r.value.card.body).toContain('L221-18');
      // L'acompte prévu (jamais gelé) reste proposé en un geste.
      expect(r.value.choices?.[0]?.value).toBe("Fais la facture d'acompte du devis D2026-032");
      expect(r.value.pending).toBeUndefined();
    });

    it('sans mode précisé → le gel est expliqué D’ABORD, jamais la question acompte/solde avec une finale bloquée', async () => {
      const r = await agentWith().ask('Fais la facture du devis D2026-032');
      expect(r.ok && r.value.kind).toBe('answer');
      expect(r.ok && (r.value.ask ?? []).length).toBe(0);
      expect(r.ok && r.value.card.body).toContain('04/08/2026');
    });

    it('l’acompte d’un devis gelé reste facturable → proposition normale (le gel ne vise que la finale)', async () => {
      const r = await agentWith().ask("Fais la facture d'acompte du devis D2026-032");
      expect(r.ok && r.value.kind).toBe('proposed');
      expect(r.ok && r.value.pending?.args).toMatchObject({ quoteId: 'sign-b2c', mode: 'deposit' });
    });

    it('devis gelé SANS acompte prévu → gel expliqué, aucune fausse alternative proposée', async () => {
      const r = await agentWith({ depositPct: null }).ask('Fais la facture finale du devis D2026-032');
      expect(r.ok && r.value.kind).toBe('answer');
      expect(r.ok && (r.value.choices ?? []).length).toBe(0);
    });

    it('aucun gel (finalBlockedUntil absent — hôte historique) → flow inchangé, question acompte/solde', async () => {
      const r = await agentWith({ finalBlockedUntil: undefined }).ask('Fais la facture du devis D2026-032');
      expect(r.ok && r.value.kind).toBe('answer');
      expect(r.ok && r.value.ask?.[0]?.id).toBe('generer_facture.mode');
    });
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

  describe('émettre une facture — qualification BT-23 voix ↔ choix manuel', () => {
    const ambiguousActions = (issueInvoice = vi.fn(actions.issueInvoice)): BobActions => ({
      ...actions,
      issueInvoice,
      listIssuableInvoices: async () => ok([{
        id: 'draft-mixed-1',
        number: null,
        totalTtcCents: 264000,
        customerName: 'Durand SARL',
        status: 'draft',
        operationCategoryRequired: true,
      }]),
    });

    it('pose une question fermée avec trois faits réels et ne lance aucune mutation', async () => {
      const issueInvoice = vi.fn(actions.issueInvoice);
      const agent = new BobAgent({
        router: new ModelRouter({ hasClaudeKey: false, hasGlmKey: false }),
        actions: ambiguousActions(issueInvoice),
      });

      const result = await agent.ask('émets la facture Durand');

      expect(result.ok && result.value.kind).toBe('answer');
      expect(result.ok && result.value.ask?.[0]?.id).toBe('emettre_facture.operationCategory');
      expect(result.ok && result.value.ask?.[0]?.options.map((option) => option.value)).toEqual([
        'services',
        'goods',
        'mixed',
      ]);
      expect(issueInvoice).not.toHaveBeenCalled();
    });

    it('un choix tapé devient le fait explicite de la proposition, jamais un code inventé', async () => {
      const agent = new BobAgent({
        router: new ModelRouter({ hasClaudeKey: false, hasGlmKey: false }),
        actions: ambiguousActions(),
      });
      const question = await agent.ask('émets la facture Durand');
      if (!question.ok) throw new Error('question');
      const followUp = question.value.ask?.[0]?.options[0]?.followUp;
      if (!followUp) throw new Error('follow-up');

      const proposed = await agent.ask(followUp);

      expect(proposed.ok && proposed.value.kind).toBe('proposed');
      expect(proposed.ok && proposed.value.pending?.args).toEqual({
        invoiceId: 'draft-mixed-1',
        operationCategory: 'services',
      });
    });

    it.each([
      ['le premier', 'services'],
      ['le deuxième', 'goods'],
      ['le troisième', 'mixed'],
    ] as const)('comprend « %s » uniquement dans la continuité immédiate BT-23', async (answer, expected) => {
      const agent = new BobAgent({
        router: new ModelRouter({ hasClaudeKey: false, hasGlmKey: false }),
        actions: ambiguousActions(),
      });
      const initial = await agent.ask('émets la facture Durand');
      if (!initial.ok) throw new Error('question');

      const proposed = await agent.ask(answer, {
        history: [
          { role: 'user', text: 'émets la facture Durand' },
          { role: 'bob', text: initial.value.card.body },
        ],
      });

      expect(proposed.ok && proposed.value.kind).toBe('proposed');
      expect(proposed.ok && proposed.value.pending?.args).toMatchObject({
        operationCategory: expected,
      });
    });

    it('une réponse contradictoire repose la question sans valeur par défaut', async () => {
      const agent = new BobAgent({
        router: new ModelRouter({ hasClaudeKey: false, hasGlmKey: false }),
        actions: ambiguousActions(),
      });
      const result = await agent.ask(
        'émets la facture Durand : prestation principale et vente principale',
      );

      expect(result.ok && result.value.kind).toBe('answer');
      expect(result.ok && result.value.ask?.[0]?.id).toBe('emettre_facture.operationCategory');
    });

    it('une course au confirm redevient la même question structurée', async () => {
      const issueInvoice = vi.fn(async () => err({
        kind: 'domain' as const,
        error: {
          code: 'VALIDATION' as const,
          field: 'operationCategory',
          message: 'Nature requise.',
        },
      }));
      const agent = new BobAgent({
        router: new ModelRouter({ hasClaudeKey: false, hasGlmKey: false }),
        actions: { ...actions, issueInvoice },
      });
      const proposal = await agent.ask('émets la facture Durand');
      if (!proposal.ok || !proposal.value.pending) throw new Error('proposal');

      const result = await agent.confirm(proposal.value.pending);

      expect(result.ok && result.value.kind).toBe('answer');
      expect(result.ok && result.value.ask?.[0]?.id).toBe('emettre_facture.operationCategory');
      expect(issueInvoice).toHaveBeenCalledTimes(1);
    });
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

  it('abonnement : accès anticipé persisté (store=none) → gratuité factuelle', async () => {
    const withSubscription: BobActions = {
      ...actions,
      getSubscriptionStatus: async () =>
        ok({
          plan: 'business' as const,
          status: 'active' as const,
          trialEndsAt: null,
          trialPhase: null,
          trialDaysLeft: null,
          currentPeriodEnd: null,
          store: 'none' as const,
          storeRef: null,
          source: 'db' as const,
        }),
    };
    const agent = new BobAgent({ router: new ModelRouter({ hasClaudeKey: false, hasGlmKey: false }), actions: withSubscription });

    const r = await agent.ask('où en est mon abonnement ?');
    expect(r.ok && r.value.intent).toBe('abonnement');
    expect(r.ok && r.value.kind).toBe('answer');
    if (!r.ok) return;
    expect(r.value.card.body).toContain('accès anticipé');
    expect(r.value.card.body).toContain('rien ne t’est facturé');
    expect(r.value.card.body).not.toContain('essai');
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

  it('lot : une émission ambiguë conserve le fait BT-23 explicite dans le batch', async () => {
    const llm: LlmPort = {
      id: 'fake-bt23-batch',
      async complete() {
        return {
          text: null,
          toolCalls: [
            { name: 'emettre_facture', arguments: { reference: 'Durand' } },
            { name: 'tresorerie_versement', arguments: {} },
          ],
          model: 'glm',
        };
      },
      async generate() { return { text: '', model: 'glm' }; },
      async health() { return { healthy: true }; },
    };
    const agent = new BobAgent({
      router: routerWithKey,
      llm,
      actions: {
        ...actions,
        listIssuableInvoices: async () => ok([{
          id: 'draft-mixed-1',
          number: null,
          totalTtcCents: 264000,
          customerName: 'Durand SARL',
          status: 'draft',
          operationCategoryRequired: true,
        }]),
      },
    });

    const result = await agent.ask(
      'émets la facture Durand, nature de l’opération : services, puis calcule ma trésorerie',
    );

    expect(result.ok && result.value.kind).toBe('proposed');
    expect(result.ok && result.value.pending?.batch?.[0]?.args).toEqual({
      invoiceId: 'draft-mixed-1',
      operationCategory: 'services',
    });
  });

  it('lot : deux émissions ambiguës refusent une catégorie globale silencieuse', async () => {
    const llm: LlmPort = {
      id: 'fake-bt23-double-batch',
      async complete() {
        return {
          text: null,
          toolCalls: [
            { name: 'emettre_facture', arguments: { reference: 'Durand' } },
            { name: 'emettre_facture', arguments: { reference: 'Martin' } },
          ],
          model: 'glm',
        };
      },
      async generate() { return { text: '', model: 'glm' }; },
      async health() { return { healthy: true }; },
    };
    const agent = new BobAgent({
      router: routerWithKey,
      llm,
      actions: {
        ...actions,
        listIssuableInvoices: async () => ok([
          {
            id: 'draft-mixed-1', number: null, totalTtcCents: 264000,
            customerName: 'Durand SARL', status: 'draft', operationCategoryRequired: true,
          },
          {
            id: 'draft-mixed-2', number: null, totalTtcCents: 90000,
            customerName: 'Martin SARL', status: 'draft', operationCategoryRequired: true,
          },
        ]),
      },
    });

    const result = await agent.ask(
      'émets les factures Durand et Martin, prestation principale',
    );

    expect(result.ok && result.value.kind).toBe('answer');
    expect(result.ok && result.value.ask?.[0]?.id).toBe(
      'plan.emettre_facture.operationCategory',
    );
    expect(result.ok && result.value.card.body).toContain('Rien n’a été exécuté');
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

  it('« ouvre mon catalogue » -> ouvre le catalogue de prestations (C27)', async () => {
    const r = await agent().ask('ouvre mon catalogue');
    expect(r.ok && r.value.intent).toBe('voir_catalogue');
    expect(r.ok && r.value.kind).toBe('done');
    expect(r.ok && r.value.navigate).toBe('/catalogue');
  });

  it('« Prêt pour 2026 ? » (chip C15) -> ouvre le diagnostic conformité (C40 ⑦)', async () => {
    const r = await agent().ask('Prêt pour 2026 ?');
    expect(r.ok && r.value.intent).toBe('diagnostic');
    expect(r.ok && r.value.kind).toBe('done');
    expect(r.ok && r.value.navigate).toBe('/diagnostic');
  });
});

describe('BobAgent — enregistrement vocal d’un règlement fournisseur', () => {
  function paymentAgent(calls: unknown[] = [], now = '2026-07-04T10:00:00.000Z') {
    const paymentActions: BobActions = {
      ...actions,
      listUnpaidExpenses: async () => ok([
        { id: 'expense-cedeo', supplierName: 'Cedeo', totalTtcCents: 34200, documentDate: '2026-07-01' },
      ]),
      recordExpensePayment: async (input) => {
        calls.push(input);
        return ok({ status: 'paid', alreadyRecorded: false, paymentEntryId: 'expense:expense-cedeo:paid' });
      },
    };
    return new BobAgent({
      router: new ModelRouter({ hasClaudeKey: false, hasGlmKey: false }),
      actions: paymentActions,
      runtime: {
        clock: { now: () => now },
        ids: { newId: () => 'run-payment-1' },
      },
    });
  }

  it('ne propose rien tant que date et moyen réels manquent', async () => {
    const calls: unknown[] = [];
    const agent = paymentAgent(calls);
    const date = await agent.ask('J’ai payé la dépense Cedeo');
    expect(date.ok && date.value.kind).toBe('answer');
    expect(date.ok && date.value.card.title).toContain('date');
    expect(date.ok && date.value.ask?.[0]?.id).toBe('payer_depense.date');
    expect(calls).toHaveLength(0);

    const method = await agent.ask('J’ai payé la dépense expense-cedeo hier');
    expect(method.ok && method.value.kind).toBe('answer');
    expect(method.ok && method.value.ask?.[0]?.id).toBe('payer_depense.methode');
    expect(calls).toHaveLength(0);
  });

  it('une phrase complète produit une proposition comptable, jamais un faux virement', async () => {
    const calls: unknown[] = [];
    const agent = paymentAgent(calls);
    const result = await agent.ask(
      'J’ai payé la dépense Cedeo le 03/07/2026 par virement référence VIR-0042',
      { autonomy: 'auto' },
    );
    expect(result.ok && result.value.kind).toBe('proposed');
    if (!result.ok || result.value.kind !== 'proposed') return;
    expect(result.value.pending?.tool).toBe('enregistrer_reglement_depense');
    expect(result.value.pending?.args).toEqual({
      expenseId: 'expense-cedeo',
      paidOn: '2026-07-03',
      method: 'transfer',
      reference: 'VIR-0042',
    });
    expect(result.value.card.body).toContain('n’initie aucun virement');
    expect(calls).toHaveLength(0);
    if (!result.value.pending) return;
    await agent.confirm(result.value.pending);
    expect(calls).toEqual([result.value.pending.args]);
  });

  it('enchaîne naturellement « hier » puis « par carte » grâce au contexte récent', async () => {
    const agent = paymentAgent();
    const afterDate = await agent.ask('hier', {
      history: [
        { role: 'user', text: 'J’ai payé la dépense Cedeo' },
        { role: 'bob', text: 'Quelle date de règlement ?' },
      ],
    });
    expect(afterDate.ok && afterDate.value.ask?.[0]?.id).toBe('payer_depense.methode');

    const afterMethod = await agent.ask('par carte', {
      history: [
        { role: 'user', text: 'J’ai payé la dépense Cedeo' },
        { role: 'bob', text: 'Quelle date de règlement ?' },
        { role: 'user', text: 'hier' },
        { role: 'bob', text: 'Quel moyen de règlement ?' },
      ],
    });
    expect(afterMethod.ok && afterMethod.value.kind).toBe('proposed');
    expect(afterMethod.ok && afterMethod.value.pending?.args).toMatchObject({
      expenseId: 'expense-cedeo',
      paidOn: '2026-07-03',
      method: 'card',
    });
  });

  it('une date future est expliquée et ne produit aucune proposition', async () => {
    const result = await paymentAgent().ask('J’ai payé la dépense Cedeo le 05/07/2026 par carte');
    expect(result.ok && result.value.kind).toBe('answer');
    expect(result.ok && result.value.card.title).toContain('future');
    expect(result.ok && result.value.pending).toBeUndefined();
  });

  it('« aujourd’hui » suit le jour métier Paris, pas le jour UTC du serveur', async () => {
    const result = await paymentAgent([], '2026-07-03T22:30:00.000Z').ask(
      'J’ai payé la dépense Cedeo aujourd’hui par carte',
    );
    expect(result.ok && result.value.pending?.args).toMatchObject({ paidOn: '2026-07-04' });
  });

  it('ligne historique sans preuve : Bob informe et oriente vers la régularisation, jamais une erreur sèche', async () => {
    const legacyActions: BobActions = {
      ...actions,
      listUnpaidExpenses: async () => ok([
        { id: 'expense-brico', supplierName: 'Brico Dépôt', totalTtcCents: 9860, documentDate: '2026-06-03' },
      ]),
      recordExpensePayment: async () => ({
        ok: false,
        error: {
          kind: 'conflict',
          entity: 'expense_payment_legacy',
          reason: 'Cette dépense date d’avant le suivi des preuves de paiement.',
        },
      }),
    };
    const agent = new BobAgent({
      router: new ModelRouter({ hasClaudeKey: false, hasGlmKey: false }),
      actions: legacyActions,
      runtime: { clock: { now: () => '2026-07-04T10:00:00.000Z' }, ids: { newId: () => 'run-legacy-1' } },
    });
    const proposed = await agent.ask('J’ai payé la dépense Brico Dépôt le 03/07/2026 par carte');
    expect(proposed.ok && proposed.value.kind).toBe('proposed');
    if (!proposed.ok || !proposed.value.pending) return;
    const confirmed = await agent.confirm(proposed.value.pending);
    expect(confirmed.ok).toBe(true);
    if (!confirmed.ok) return;
    expect(confirmed.value.kind).toBe('answer');
    expect(confirmed.value.card.title).toBe('Dépense à régulariser');
    expect(confirmed.value.card.body).toContain('régulariser');
    expect(confirmed.value.card.body).toContain('Dépenses');
    expect(confirmed.value.card.body).toContain('Rien n’a été modifié');
  });
});

describe('valider_document — parité vocale avec le bouton « Confirmer » de « À valider »', () => {
  const acknowledged: unknown[] = [];
  const docActions = (over: Partial<BobActions> = {}): BobActions => ({
    ...actions,
    listDocuments: async () =>
      ok([
        {
          id: 'doc-aldi',
          filename: 'scan-93813.jpg',
          kind: 'expense_receipt',
          linkedEntityType: null,
          linkedEntityId: null,
          createdAt: '2026-07-15T09:00:00.000Z',
          displayName: 'Ticket Aldi — 23,90 €',
          origin: 'ocr',
          folderId: 'folder-achats',
          reviewedAt: null,
        },
        {
          id: 'doc-cedeo',
          filename: 'scan-93814.jpg',
          kind: 'expense_receipt',
          linkedEntityType: null,
          linkedEntityId: null,
          createdAt: '2026-07-15T10:00:00.000Z',
          displayName: 'Facture Cedeo — 184,90 €',
          origin: 'ocr',
          folderId: null,
          reviewedAt: null,
        },
      ]),
    acknowledgeDocument: async (input) => {
      acknowledged.push(input);
      return ok({ documentId: input.documentId, reviewedAt: '2026-07-15T11:00:00.000Z' });
    },
    ...over,
  });
  const agentWith = (over: Partial<BobActions> = {}) =>
    new BobAgent({ router: new ModelRouter({ hasClaudeKey: false, hasGlmKey: false }), actions: docActions(over) });

  it('cible le document par son libellé intelligent et PROPOSE (plancher : latch sans annulation), même en auto', async () => {
    acknowledged.length = 0;
    const agent = agentWith();
    const r = await agent.ask('C’est bon, valide le ticket Aldi', { autonomy: 'auto' });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.intent).toBe('valider_document');
    expect(r.value.kind).toBe('proposed');
    expect(r.value.pending).toMatchObject({ tool: 'valider_document', args: { documentId: 'doc-aldi' } });
    // Rien n'est validé avant le consentement.
    expect(acknowledged).toEqual([]);
    // La confirmation exécute le MÊME use case (délégation à l'hôte).
    const done = await agent.confirm(r.value.pending!);
    expect(done.ok && done.value.kind).toBe('done');
    expect(acknowledged).toEqual([{ documentId: 'doc-aldi' }]);
  });

  it('refuse honnêtement un document non rangé (pièce orpheline sinon) — rien n’est modifié', async () => {
    acknowledged.length = 0;
    const r = await agentWith().ask('Valide le document Cedeo');
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.kind).toBe('answer');
    expect(r.value.card.title).toBe('À ranger d’abord');
    expect(acknowledged).toEqual([]);
  });

  it('sans cible identifiable : liste la file « À valider » et demande, sans jamais valider à l’aveugle', async () => {
    acknowledged.length = 0;
    const r = await agentWith().ask('Valide le ticket');
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.kind).toBe('answer');
    expect(r.value.card.title).toBe('Quel document ?');
    expect(r.value.choices?.length).toBe(2);
    expect(acknowledged).toEqual([]);
  });

  it('hôte sans la capacité (rétro-compat) : réponse honnête, aucune validation inventée', async () => {
    const r = await new BobAgent({
      router: new ModelRouter({ hasClaudeKey: false, hasGlmKey: false }),
      actions,
    }).ask('Valide le ticket Aldi');
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.kind).toBe('answer');
    expect(r.value.card.body).toContain('Rien n’a été modifié');
  });

  it('file vide (tout validé ou hôte sans reviewedAt/origin) : réponse « rien à valider »', async () => {
    const r = await agentWith({
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
    }).ask('Valide le ticket Aldi');
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.kind).toBe('answer');
    expect(r.value.card.title).toBe('Rien à valider');
  });
});

describe('classer_document — parité vocale avec le geste « Classer là » (LOT 5)', () => {
  const filed: unknown[] = [];
  const classerActions = (over: Partial<BobActions> = {}): BobActions => ({
    ...actions,
    listDocuments: async () =>
      ok([
        {
          id: 'doc-aldi',
          filename: 'scan-93813.jpg',
          kind: 'expense_receipt',
          linkedEntityType: null,
          linkedEntityId: null,
          createdAt: '2026-07-15T09:00:00.000Z',
          displayName: 'Ticket Aldi — 23,90 €',
          origin: 'ocr',
          folderId: null,
          reviewedAt: null,
        },
        {
          id: 'doc-cedeo',
          filename: 'scan-93814.jpg',
          kind: 'expense_receipt',
          linkedEntityType: null,
          linkedEntityId: null,
          createdAt: '2026-07-15T10:00:00.000Z',
          displayName: 'Facture Cedeo — 184,90 €',
          origin: 'ocr',
          folderId: null,
          reviewedAt: null,
        },
      ]),
    listFilingDestinations: async () =>
      ok({
        chantiers: [
          { id: 'chantier-durand', nom: 'Maison Durand' },
          { id: 'chantier-bernard', nom: 'Rénovation Bernard' },
        ],
        dossiers: [
          { id: 'folder-achats', nom: 'Achats', systemKey: 'purchases' },
          { id: 'folder-frais', nom: 'Frais généraux', systemKey: null },
        ],
      }),
    fileDocument: async (input) => {
      filed.push(input);
      return ok({
        documentId: input.documentId,
        folderId: input.destination.kind === 'folder' ? input.destination.folderId : 'folder-chantiers',
        linkedEntityType: input.destination.kind === 'chantier' ? 'chantier' : null,
        linkedEntityId: input.destination.kind === 'chantier' ? input.destination.chantierId : null,
        displayName: 'Ticket Aldi — 23,90 €',
      });
    },
    ...over,
  });
  const agentWith = (over: Partial<BobActions> = {}) =>
    new BobAgent({ router: new ModelRouter({ hasClaudeKey: false, hasGlmKey: false }), actions: classerActions(over) });

  it('« range le ticket Aldi dans le chantier Durand » : cible réelle + PROPOSE (plancher), même en auto', async () => {
    filed.length = 0;
    const agent = agentWith();
    const r = await agent.ask('Range le ticket Aldi dans le chantier Durand', { autonomy: 'auto' });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.intent).toBe('classer_document');
    expect(r.value.kind).toBe('proposed');
    expect(r.value.pending).toMatchObject({
      tool: 'classer_document',
      args: { documentId: 'doc-aldi', destination: { kind: 'chantier', chantierId: 'chantier-durand' } },
    });
    // Rien n'est classé avant le consentement.
    expect(filed).toEqual([]);
    const done = await agent.confirm(r.value.pending!);
    expect(done.ok && done.value.kind).toBe('done');
    expect(filed).toEqual([
      { documentId: 'doc-aldi', destination: { kind: 'chantier', chantierId: 'chantier-durand' } },
    ]);
  });

  it('« classe la facture Cedeo dans frais généraux » : dossier par nom, insensible aux accents', async () => {
    filed.length = 0;
    const r = await agentWith().ask('Classe la facture Cedeo dans frais generaux');
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.kind).toBe('proposed');
    expect(r.value.pending).toMatchObject({
      args: { documentId: 'doc-cedeo', destination: { kind: 'folder', folderId: 'folder-frais' } },
    });
  });

  it('destination introuvable : refus HONNÊTE, jamais un id inventé, rien modifié', async () => {
    filed.length = 0;
    const r = await agentWith().ask('Range le ticket Aldi dans le chantier Xylophone');
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.kind).toBe('answer');
    expect(r.value.card.title).toBe('Destination introuvable');
    expect(r.value.card.body).toContain('Rien n’a été modifié');
    expect(filed).toEqual([]);
  });

  it('document résolu mais destination absente : question avec les destinations RÉELLES', async () => {
    filed.length = 0;
    const r = await agentWith().ask('Range le ticket Aldi');
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.kind).toBe('answer');
    expect(r.value.card.title).toBe('Où le classer ?');
    expect(r.value.ask?.[0]?.options.length).toBeGreaterThan(0);
    // Le followUp est VERBATIM : l'UI ne reconstruit jamais la commande.
    expect(r.value.ask?.[0]?.options[0]?.followUp).toContain('Classe le document doc-aldi');
    expect(filed).toEqual([]);
  });

  it('document ambigu : question, jamais un classement à l’aveugle', async () => {
    filed.length = 0;
    const r = await agentWith().ask('Classe le scan dans Achats');
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.kind).toBe('answer');
    expect(r.value.card.title).toBe('Quel document ?');
    // La destination déjà résolue survit dans le followUp de chaque option.
    expect(r.value.ask?.[0]?.options[0]?.followUp).toContain('dans le dossier Achats');
    expect(filed).toEqual([]);
  });

  it('hôte sans la capacité (rétro-compat) : réponse honnête, rien modifié', async () => {
    const r = await new BobAgent({
      router: new ModelRouter({ hasClaudeKey: false, hasGlmKey: false }),
      actions,
    }).ask('Range le ticket Aldi dans Achats');
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.kind).toBe('answer');
    expect(r.value.card.body).toContain('Rien n’a été modifié');
  });
});

describe('renommer_document — RenameDocument, nom humain prioritaire (LOT 5)', () => {
  const renamed: unknown[] = [];
  const renameActions = (over: Partial<BobActions> = {}): BobActions => ({
    ...actions,
    listDocuments: async () =>
      ok([
        {
          id: 'doc-aldi',
          filename: 'scan-93813.jpg',
          kind: 'expense_receipt',
          linkedEntityType: null,
          linkedEntityId: null,
          createdAt: '2026-07-15T09:00:00.000Z',
          displayName: 'Ticket Aldi — 23,90 €',
          origin: 'ocr',
          folderId: 'folder-achats',
          reviewedAt: null,
        },
      ]),
    renameDocument: async (input) => {
      renamed.push(input);
      return ok({ documentId: input.documentId, displayName: input.displayName });
    },
    ...over,
  });
  const agentWith = (over: Partial<BobActions> = {}) =>
    new BobAgent({ router: new ModelRouter({ hasClaudeKey: false, hasGlmKey: false }), actions: renameActions(over) });

  it('« renomme le ticket Aldi en … » : cible + nouveau nom, PROPOSE (plancher) puis exécute', async () => {
    renamed.length = 0;
    const agent = agentWith();
    const r = await agent.ask('Renomme le ticket Aldi en Facture matériaux salle de bain', { autonomy: 'auto' });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.intent).toBe('renommer_document');
    expect(r.value.kind).toBe('proposed');
    expect(r.value.pending).toMatchObject({
      tool: 'renommer_document',
      args: { documentId: 'doc-aldi', displayName: 'Facture matériaux salle de bain' },
    });
    expect(renamed).toEqual([]);
    const done = await agent.confirm(r.value.pending!);
    expect(done.ok && done.value.kind).toBe('done');
    expect(renamed).toEqual([{ documentId: 'doc-aldi', displayName: 'Facture matériaux salle de bain' }]);
  });

  it('« renomme-le … » : anaphore levée par l’historique court', async () => {
    renamed.length = 0;
    const r = await agentWith().ask('Renomme-le Facture matériaux salle de bain', {
      history: [
        { role: 'user', text: 'C’est bon, valide le ticket Aldi' },
        { role: 'bob', text: 'Validation à confirmer' },
      ],
    });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.kind).toBe('proposed');
    expect(r.value.pending).toMatchObject({
      args: { documentId: 'doc-aldi', displayName: 'Facture matériaux salle de bain' },
    });
  });

  it('cible dite sans nouveau nom : demande le nom, rien modifié', async () => {
    renamed.length = 0;
    const r = await agentWith().ask('Renomme le ticket Aldi');
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.kind).toBe('answer');
    expect(r.value.card.title).toContain('Renommer');
    expect(r.value.card.body).toContain('Rien n’a été modifié');
    expect(renamed).toEqual([]);
  });

  it('hôte sans la capacité : réponse honnête', async () => {
    const r = await new BobAgent({
      router: new ModelRouter({ hasClaudeKey: false, hasGlmKey: false }),
      actions,
    }).ask('Renomme le ticket Aldi en Facture Aldi');
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.kind).toBe('answer');
    expect(r.value.card.body).toContain('Rien n’a été modifié');
  });
});

describe('chercher_document — recherche réelle + navigation (LOT 5)', () => {
  const searched: unknown[] = [];
  const searchActions = (over: Partial<BobActions> = {}): BobActions => ({
    ...actions,
    searchDocuments: async (input) => {
      searched.push(input);
      return ok({
        hits: [
          {
            source: 'invoice' as const,
            id: 'inv-77',
            number: '2026-031',
            customerName: 'Durand SARL',
            status: 'issued',
            date: '2026-03-12',
            totalTtcCents: 132000,
            matchedLineLabel: 'Radiateur acier',
          },
          {
            source: 'quote' as const,
            id: 'quote-12',
            number: 'D2026-040',
            customerName: 'M. Martin',
            status: 'sent',
            date: null,
            totalTtcCents: 90000,
            matchedLineLabel: null,
          },
        ],
        totalCount: 2,
      });
    },
    ...over,
  });
  const agentWith = (over: Partial<BobActions> = {}) =>
    new BobAgent({ router: new ModelRouter({ hasClaudeKey: false, hasGlmKey: false }), actions: searchActions(over) });

  it('« retrouve la facture du radiateur » : résultats réels + navigation vers le plus pertinent', async () => {
    searched.length = 0;
    const r = await agentWith().ask('Retrouve la facture du radiateur');
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.intent).toBe('chercher_document');
    expect(r.value.kind).toBe('done');
    expect(r.value.pending).toBeUndefined(); // lecture pure : jamais de mutation
    expect(r.value.navigate).toBe('/facture/inv-77');
    expect(r.value.card.body).toContain('Facture 2026-031 — Durand SARL');
    expect(r.value.card.body).toContain('Radiateur acier');
    // Le geste et le bruit sont neutralisés : la requête = les mots significatifs.
    expect(searched).toEqual([{ query: 'radiateur', scope: 'invoice' }]);
  });

  it('aucun résultat : réponse honnête, jamais une pièce inventée', async () => {
    const r = await agentWith({
      searchDocuments: async () => ok({ hits: [], totalCount: 0 }),
    }).ask('Retrouve la facture du zeppelin');
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.kind).toBe('answer');
    expect(r.value.card.title).toBe('Rien trouvé');
    expect(r.value.navigate).toBeUndefined();
  });

  it('requête vide sans période : demande une précision, aucune recherche lancée', async () => {
    searched.length = 0;
    const r = await agentWith().ask('Retrouve la facture');
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.kind).toBe('answer');
    expect(r.value.card.title).toBe('Que faut-il retrouver ?');
    expect(searched).toEqual([]);
  });

  it('hôte sans la capacité : réponse honnête', async () => {
    const r = await new BobAgent({
      router: new ModelRouter({ hasClaudeKey: false, hasGlmKey: false }),
      actions,
    }).ask('Retrouve la facture du radiateur');
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.kind).toBe('answer');
    expect(r.value.card.body).toContain('recherche');
  });
});

describe('lier_bon_commande — B8 : numéro d’engagement grands comptes attaché au devis', () => {
  const linked: unknown[] = [];
  const poActions = (over: Partial<BobActions> = {}): BobActions => ({
    ...actions,
    // Devis EN COURS du tenant : deux signés facturables (RATP prioritaire, Durand porte déjà
    // un bon de commande) + un envoyé en attente (RATP) + un brouillon (hors jeu).
    listInvoiceableQuotes: async () =>
      ok([
        { id: 'sign-ratp', number: 'D2026-040', customerName: 'RATP', totalTtcCents: 1250000, depositPct: null, depositInvoiced: false, purchaseOrder: null },
        { id: 'sign-durand', number: 'D2026-041', customerName: 'Durand SARL', totalTtcCents: 302500, depositPct: null, depositInvoiced: false, purchaseOrder: { number: 'ANC-99', receivedAt: null, documentId: null } },
      ]),
    listSendableQuotes: async () =>
      ok([
        { id: 'sent-ratp', number: 'D2026-050', customerName: 'RATP', totalTtcCents: 90000, status: 'sent' },
        { id: 'draft-martin', number: null, customerName: 'M. Martin', totalTtcCents: 10000, status: 'draft' },
      ]),
    attachPurchaseOrderToQuote: async (input) => {
      linked.push(input);
      return ok({
        quoteId: input.quoteId,
        quoteNumber: input.quoteId === 'sign-ratp' ? 'D2026-040' : 'D2026-041',
        revision: 3,
        purchaseOrderNumber: input.number,
        invoiceable: true,
      });
    },
    ...over,
  });
  const agentWith = (over: Partial<BobActions> = {}) =>
    new BobAgent({ router: new ModelRouter({ hasClaudeKey: false, hasGlmKey: false }), actions: poActions(over) });

  it('« la RATP m’a envoyé un bon de commande n° 4500123 » : cible le devis SIGNÉ du client (priorité sur l’envoyé) et PROPOSE, même en auto (plancher)', async () => {
    linked.length = 0;
    const agent = agentWith();
    const r = await agent.ask('La RATP m’a envoyé un bon de commande n° 4500123', { autonomy: 'auto' });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.intent).toBe('lier_bon_commande');
    expect(r.value.kind).toBe('proposed');
    expect(r.value.pending).toMatchObject({
      tool: 'lier_bon_commande',
      args: { quoteId: 'sign-ratp', number: '4500123' },
    });
    expect(r.value.card.body).toContain('repris automatiquement sur la facture');
    // Rien n'est lié avant le consentement.
    expect(linked).toEqual([]);
    // La confirmation exécute le MÊME use case (délégation à l'hôte) — puis l'ENCHAÎNEMENT :
    // Bob propose la facture, en délégant VERBATIM au flow generer_facture_devis existant.
    const done = await agent.confirm(r.value.pending!);
    expect(done.ok && done.value.kind).toBe('done');
    if (!done.ok) return;
    expect(linked).toEqual([{ quoteId: 'sign-ratp', number: '4500123' }]);
    expect(done.value.card.title).toBe('Bon de commande lié ✓');
    expect(done.value.card.body).toContain('Je crée la facture du devis D2026-040 avec ce bon de commande ?');
    expect(done.value.choices?.[0]?.value).toBe('Fais la facture du devis D2026-040');
  });

  it('« ajoute le bon de commande BC-2207 au devis de Durand » : extraction BC- + annonce du REMPLACEMENT du numéro déjà noté', async () => {
    linked.length = 0;
    const r = await agentWith().ask('Ajoute le bon de commande BC-2207 au devis de Durand');
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.kind).toBe('proposed');
    expect(r.value.pending).toMatchObject({
      tool: 'lier_bon_commande',
      args: { quoteId: 'sign-durand', number: 'BC-2207' },
    });
    expect(r.value.card.body).toContain('Il remplace le n° ANC-99');
    expect(linked).toEqual([]);
  });

  it('« Ajoute le bon de commande au devis n° D2026-040 » : le numéro DU DEVIS n’est JAMAIS promu numéro d’engagement — Bob demande le numéro du BC', async () => {
    linked.length = 0;
    const agent = agentWith();
    const r = await agent.ask('Ajoute le bon de commande au devis n° D2026-040');
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    // Le devis reste CIBLÉ par son numéro (non consommé) et le numéro du BC est DEMANDÉ.
    expect(r.value.kind).toBe('answer');
    expect(r.value.card.title).toBe('Quel numéro ?');
    expect(r.value.card.body).toContain('de RATP pour le devis D2026-040');
    // Variante « numéro » : même garde-fou que « n° ».
    const v = await agent.ask('Ajoute le bon de commande au devis numéro D2026-040');
    expect(v.ok && v.value.card.title).toBe('Quel numéro ?');
    expect(linked).toEqual([]);
  });

  it('numéro d’engagement COURT (« n° 40 ») : la référence du devis qui le contient (D2026-040) reste ciblable — retrait en jeton entier', async () => {
    linked.length = 0;
    const r = await agentWith().ask('Ajoute le bon de commande n° 40 au devis D2026-040');
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.kind).toBe('proposed');
    expect(r.value.pending).toMatchObject({
      tool: 'lier_bon_commande',
      args: { quoteId: 'sign-ratp', number: '40' },
    });
    expect(linked).toEqual([]);
  });

  it('plusieurs devis en cours pour le client : ASK avec les devis EN CLAIR, followUps verbatim — jamais un choix silencieux', async () => {
    linked.length = 0;
    const r = await agentWith({
      listInvoiceableQuotes: async () =>
        ok([
          { id: 'sign-ratp-1', number: 'D2026-040', customerName: 'RATP', totalTtcCents: 1250000, depositPct: null, depositInvoiced: false, purchaseOrder: null },
          { id: 'sign-ratp-2', number: 'D2026-041', customerName: 'RATP', totalTtcCents: 302500, depositPct: 30, depositInvoiced: false, purchaseOrder: null },
        ]),
    }).ask('La RATP m’a répondu pour le dernier devis avec un bon de commande');
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.kind).toBe('answer');
    expect(r.value.card.body).toContain('RATP a 2 devis en cours');
    expect(r.value.card.body).toContain('Lequel a reçu le bon de commande ?');
    expect(r.value.ask?.[0]?.id).toBe('lier_bon_commande.cible');
    expect(r.value.ask?.[0]?.options).toHaveLength(2);
    // Numéro pas encore dit : le followUp garde le parcours (le numéro sera demandé ensuite).
    expect(r.value.ask?.[0]?.options[0]?.followUp).toBe('Le bon de commande est pour le devis sign-ratp-1');
    expect(linked).toEqual([]);
  });

  it('numéro absent : Bob le DEMANDE (jamais inventé), puis la réponse courte reste dans le parcours (continuité par historique)', async () => {
    linked.length = 0;
    const agent = agentWith();
    const first = await agent.ask('La RATP m’a répondu pour le dernier devis avec un bon de commande');
    expect(first.ok).toBe(true);
    if (!first.ok) return;
    expect(first.value.kind).toBe('answer');
    expect(first.value.card.title).toBe('Quel numéro ?');
    expect(first.value.card.body).toContain('numéro du bon de commande de RATP pour le devis D2026-040');
    // Réponse courte au tour suivant : la continuité relit l'historique (client + question Bob).
    const second = await agent.ask('C’est le n° 4500123', {
      history: [
        { role: 'user', text: 'La RATP m’a répondu pour le dernier devis avec un bon de commande' },
        { role: 'bob', text: first.value.card.body },
      ],
    });
    expect(second.ok).toBe(true);
    if (!second.ok) return;
    expect(second.value.kind).toBe('proposed');
    expect(second.value.pending).toMatchObject({
      tool: 'lier_bon_commande',
      args: { quoteId: 'sign-ratp', number: '4500123' },
    });
    expect(linked).toEqual([]);
  });

  it('client inconnu des devis en cours : refus honnête, rien n’est modifié', async () => {
    linked.length = 0;
    const r = await agentWith().ask('La Mairie de Vitry m’a envoyé un bon de commande n° 88');
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.kind).toBe('answer');
    expect(r.value.card.title).toBe('Client introuvable');
    expect(r.value.card.body).toContain('Je ne trouve pas de devis en cours pour');
    expect(r.value.card.body).toContain('Mairie');
    expect(linked).toEqual([]);
  });

  it('bon de commande SCANNÉ mentionné : réponse honnête — l’outil vocal lie le NUMÉRO, le document se rattache au picker', async () => {
    const r = await agentWith().ask('La RATP m’a envoyé un bon de commande n° 4500123, je l’ai scanné');
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.kind).toBe('proposed');
    expect(r.value.card.body).toContain('ici je lie le numéro');
  });

  it('enchaînement : « oui » après « Bon de commande lié ✓ » DÉLÈGUE au flow generer_facture_devis existant (commande canonique verbatim)', async () => {
    const r = await agentWith().ask('Oui', {
      history: [
        { role: 'user', text: 'La RATP m’a envoyé un bon de commande n° 4500123' },
        {
          role: 'bob',
          text: 'Lier le bon de commande n° 4500123 au devis D2026-040 de RATP (12 500,00 €) — c’est noté.\nJe crée la facture du devis D2026-040 avec ce bon de commande ? Elle reprendra le numéro d’engagement automatiquement.',
        },
      ],
    });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.intent).toBe('generer_facture');
    expect(r.value.kind).toBe('proposed');
    expect(r.value.pending).toMatchObject({ tool: 'generer_facture', args: { quoteId: 'sign-ratp', mode: 'final' } });
  });

  it('enchaînement : « non » clôt proprement — le lien reste fait, aucune facture créée', async () => {
    const r = await agentWith().ask('Non merci', {
      history: [
        { role: 'user', text: 'La RATP m’a envoyé un bon de commande n° 4500123' },
        {
          role: 'bob',
          text: 'Je crée la facture du devis D2026-040 avec ce bon de commande ? Elle reprendra le numéro d’engagement automatiquement.',
        },
      ],
    });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.kind).toBe('answer');
    expect(r.value.intent).toBe('lier_bon_commande');
    expect(r.value.card.body).toContain('Je ne crée pas la facture');
  });

  it('parse au plancher du domaine : un numéro > 60 caractères est refusé par makePurchaseOrderRef (autorité unique)', async () => {
    linked.length = 0;
    const agent = agentWith();
    const r = await agent.confirm({
      tool: 'lier_bon_commande',
      args: { quoteId: 'sign-ratp', number: 'X'.repeat(61) },
      label: 'Lier un bon de commande invalide',
    });
    expect(r.ok).toBe(false);
    expect(linked).toEqual([]);
  });

  it('hôte sans la capacité (rétro-compat) : réponse honnête, rien n’est modifié', async () => {
    const r = await new BobAgent({
      router: new ModelRouter({ hasClaudeKey: false, hasGlmKey: false }),
      actions,
    }).ask('Ajoute le bon de commande n° 4500123 au devis Durand');
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.kind).toBe('answer');
    expect(r.value.card.body).toContain('Rien n’a été modifié');
  });

  it('aucun devis en cours : réponse honnête (un bon de commande se lie à un devis envoyé ou signé)', async () => {
    const r = await agentWith({
      listInvoiceableQuotes: async () => ok([]),
      listSendableQuotes: async () => ok([]),
    }).ask('La RATP m’a envoyé un bon de commande n° 4500123');
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.kind).toBe('answer');
    expect(r.value.card.title).toBe('Aucun devis en cours');
  });
});

describe('documents_liste enrichi — file « à confirmer » dans la réponse (LOT 5)', () => {
  const docsWithPending: BobActions = {
    ...actions,
    listDocuments: async () =>
      ok([
        {
          id: 'doc-aldi',
          filename: 'scan-93813.jpg',
          kind: 'expense_receipt',
          linkedEntityType: null,
          linkedEntityId: null,
          createdAt: '2026-07-15T09:00:00.000Z',
          displayName: 'Ticket Aldi — 23,90 €',
          origin: 'ocr',
          folderId: 'folder-achats',
          reviewedAt: null,
        },
        {
          id: 'doc-1',
          filename: 'facture-F2026-001.pdf',
          kind: 'invoice_pdf',
          linkedEntityType: 'invoice',
          linkedEntityId: 'inv-1',
          createdAt: '2026-07-01T10:00:00.000Z',
          displayName: 'Facture F2026-001',
          origin: 'generated',
          folderId: 'folder-ventes',
          reviewedAt: '2026-07-01T10:00:00.000Z',
        },
      ]),
    listFilingDestinations: async () =>
      ok({
        chantiers: [],
        dossiers: [{ id: 'folder-achats', nom: 'Achats', systemKey: 'purchases' }],
      }),
  };

  it('annonce la file à confirmer avec le libellé intelligent et le dossier réel, et propose la validation', async () => {
    const agent = new BobAgent({ router: new ModelRouter({ hasClaudeKey: false, hasGlmKey: false }), actions: docsWithPending });
    const r = await agent.ask('Montre mes documents archivés');
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.intent).toBe('documents');
    expect(r.value.kind).toBe('answer');
    expect(r.value.card.body).toContain('Tu as 1 document à confirmer');
    expect(r.value.card.body).toContain('« Ticket Aldi — 23,90 € » rangé dans Achats');
    expect(r.value.card.body).toContain('je te les montre ?');
    // La liste archivée historique reste présente sous l'annonce.
    expect(r.value.card.body).toContain('facture-F2026-001.pdf');
    // Le followUp verbatim déclenche le flux valider_document (plancher préservé côté outil).
    expect(r.value.ask?.[0]?.options[0]?.followUp).toBe('Valide le document doc-aldi');
  });

  it('sans file à confirmer (hôte historique) : réponse INCHANGÉE', async () => {
    const agent = new BobAgent({ router: new ModelRouter({ hasClaudeKey: false, hasGlmKey: false }), actions });
    const r = await agent.ask('Montre mes documents archivés');
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.card.body).not.toContain('à confirmer');
    expect(r.value.ask).toBeUndefined();
    expect(r.value.card.body).toContain('facture-F2026-001.pdf');
  });
});

describe('BobAgent — découvrabilité (S9 : aide + catalogue par domaines)', () => {
  it('« tu sais faire quoi ? » → run aide : catalogue par domaines, aucune action, pas d’écartement', async () => {
    const r = await makeAgent().ask('Tu sais faire quoi ?');
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.intent).toBe('aide');
    expect(r.value.kind).toBe('answer');
    expect(r.value.pending).toBeUndefined();
    expect(r.value.navigate).toBeUndefined();
    // Les quatre domaines, chacun avec au moins un exemple parlé.
    expect(r.value.card.body).toContain('Facturation');
    expect(r.value.card.body).toContain('Dépenses');
    expect(r.value.card.body).toContain('Fiscal');
    expect(r.value.card.body).toContain('Pilotage');
    expect(r.value.card.body).toContain('crée une facture pour Martin');
    // Un mode d'emploi, pas un refus : la phrase d'écartement hors-périmètre n'apparaît pas.
    expect(r.value.card.body).not.toContain('hors de ce périmètre');
  });

  it('« aide » seul suit le même chemin catalogue (jamais unknown)', async () => {
    const r = await makeAgent().ask('aide');
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.intent).toBe('aide');
    expect(r.value.card.body).toContain('Pilotage');
  });

  it('hors-périmètre : l’écartement unknown embarque désormais le MÊME catalogue', async () => {
    const r = await makeAgent().ask('raconte-moi une blague');
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.intent).toBe('unknown');
    expect(r.value.card.body).toContain('hors de ce périmètre');
    expect(r.value.card.body).toContain('Facturation');
    expect(r.value.card.body).toContain('Dépenses');
    expect(r.value.card.body).toContain('Fiscal');
    expect(r.value.card.body).toContain('Pilotage');
  });

  it('le catalogue aide reste VERBATIM : jamais naturalisé par le LLM', async () => {
    const generate = vi.fn(async () => ({ text: 'Ne doit jamais être appelée.', model: 'glm' }));
    const llm: LlmPort = {
      id: 'fake',
      async complete() {
        return { text: null, toolCalls: [{ name: 'aide_capacites', arguments: {} }], model: 'glm' };
      },
      generate,
      async health() {
        return { healthy: true };
      },
    };
    const agent = new BobAgent({ router: new ModelRouter({ hasClaudeKey: false, hasGlmKey: true }), actions, llm });
    const r = await agent.ask('comment tu peux m’aider ?');
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.intent).toBe('aide');
    expect(r.value.naturalBody).toBeUndefined();
    expect(generate).not.toHaveBeenCalled();
  });
});

// —— M2 — envoyer_relance : « relance Durand » = brouillon RÉEL présenté puis ENVOI confirmé ——
describe('relance (M2) — envoi réel via sendRelance, confirmation TOUJOURS', () => {
  const withSend = (over: Partial<BobActions> = {}) => {
    const sent: unknown[] = [];
    const agent = new BobAgent({
      router: new ModelRouter({ hasClaudeKey: false, hasGlmKey: false }),
      actions: {
        ...actions,
        draftRelance: async (input) =>
          ok({ subject: `Relance facture ${input?.invoiceId ?? 'urgente'}`, body: 'Bonjour, votre facture est en retard.' }),
        sendRelance: async (input) => {
          sent.push(input);
          return ok({ jobId: 'job-1', status: 'done', tone: 'ferme' });
        },
        ...over,
      },
    });
    return { agent, sent };
  };

  it('« relance Durand » : présente le TEXTE réel du service puis PROPOSE l’envoi (jamais envoyé sans confirmation)', async () => {
    const { agent, sent } = withSend();
    const r = await agent.ask('Relance Durand');
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.intent).toBe('relance');
    expect(r.value.kind).toBe('proposed');
    expect(r.value.pending?.tool).toBe('envoyer_relance');
    expect(r.value.pending?.args).toEqual({ invoiceId: 'inv-1' });
    // Le brouillon présenté est le texte RÉEL de l'hôte — verbatim dans la carte de consentement.
    expect(r.value.card.body).toContain('Relance facture inv-1');
    expect(r.value.card.body).toContain('votre facture est en retard');
    expect(r.value.card.body).toContain('2026-014');
    expect(sent).toEqual([]); // rien n'est parti avant confirm()
  });

  it('confirm() exécute l’envoi réel et rend la carte « Relance envoyée ✓ »', async () => {
    const { agent, sent } = withSend();
    const proposed = await agent.ask('Relance la facture 2026-021');
    expect(proposed.ok && proposed.value.kind).toBe('proposed');
    if (!proposed.ok || !proposed.value.pending) return;
    const done = await agent.confirm(proposed.value.pending);
    expect(done.ok).toBe(true);
    if (!done.ok) return;
    expect(done.value.kind).toBe('done');
    expect(done.value.intent).toBe('relance');
    expect(done.value.card.title).toBe('Relance envoyée ✓');
    expect(sent).toEqual([{ invoiceId: 'inv-2' }]);
  });

  it('ambiguïté → question avec les FACTURES RÉELLES (followUps verbatim), rien exécuté', async () => {
    const { agent, sent } = withSend();
    const r = await agent.ask('Relance les clients en retard');
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.kind).toBe('answer');
    expect(r.value.ask?.[0]?.options.map((o) => o.value)).toEqual(['2026-014', '2026-021']);
    expect(r.value.ask?.[0]?.options[0]?.followUp).toBe('Relance la facture 2026-014');
    expect(sent).toEqual([]);
  });

  it('zéro impayé → réponse honnête avec l’état réel de l’hôte, jamais une proposition', async () => {
    const { agent, sent } = withSend({
      listPayableInvoices: async () => ok([]),
      draftRelance: async () => ok({ subject: 'Rien à relancer', body: 'Aucune facture en retard — tout est réglé. 🎉' }),
    });
    const r = await agent.ask('Relance Durand');
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.kind).toBe('answer');
    expect(r.value.card.body).toContain('Aucune facture en retard');
    expect(sent).toEqual([]);
  });

  it('cible encaissable mais PAS en retard (plan muet) → réponse honnête, aucun envoi proposé', async () => {
    const { agent, sent } = withSend({
      draftRelance: async () =>
        ok({ subject: 'Rien à relancer pour cette cible', body: 'Aucun retard sur cette cible — pas encore échue.' }),
    });
    const r = await agent.ask('Relance Durand');
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.kind).toBe('answer');
    expect(r.value.card.title).toBe('Rien à relancer pour cette cible');
    expect(sent).toEqual([]);
  });

  it('« prépare/montre » ou hôte SANS sendRelance → brouillon seul (comportement historique intact)', async () => {
    const { agent, sent } = withSend();
    const draft = await agent.ask('Prépare la relance de Durand');
    expect(draft.ok && draft.value.kind).toBe('answer');
    expect(sent).toEqual([]);
    // Hôte legacy sans capacité d'envoi : brouillon, comme avant M2.
    const legacy = await makeAgent().ask('Relance Durand');
    expect(legacy.ok && legacy.value.kind).toBe('answer');
  });
});

// —— M4 — dépense dictée : « j'ai dépensé 89 € chez Leroy Merlin en carte » ——
describe('depense_dictee (M4) — création vocale via scan_depense, questions structurées', () => {
  const makeDictated = (over: Partial<BobActions> = {}) => {
    const recorded: unknown[] = [];
    const agent = new BobAgent({
      router: new ModelRouter({ hasClaudeKey: false, hasGlmKey: false }),
      actions: {
        ...actions,
        recordExpense: async (input) => {
          recorded.push(input);
          return ok({ id: 'exp-new' });
        },
        listFilingDestinations: async () =>
          ok({ chantiers: [{ id: 'ch-1', nom: 'Durand' }, { id: 'ch-2', nom: 'Sèvres' }], dossiers: [] }),
        ...over,
      },
      runtime: { clock: { now: () => '2026-07-19T10:00:00.000Z' }, ids: { newId: () => 'run-m4' } },
    });
    return { agent, recorded };
  };

  it('dictée complète → PROPOSE la dépense née payée (plancher comptable), rien créé avant confirmation', async () => {
    const { agent, recorded } = makeDictated();
    const r = await agent.ask('J’ai dépensé 89 € chez Leroy Merlin par carte (catégorie matériel)');
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.intent).toBe('depense_dictee');
    expect(r.value.kind).toBe('proposed');
    expect(r.value.pending?.tool).toBe('scan_depense');
    expect(r.value.pending?.args).toEqual({
      supplierName: 'Leroy Merlin',
      totalTtcCents: 8900,
      category: 'materiel',
      documentDate: '2026-07-19', // défaut : aujourd'hui (horloge runtime), jamais inventé ailleurs
      payment: { paidOn: '2026-07-19', method: 'card' },
    });
    expect(recorded).toEqual([]);
    const done = await agent.confirm(r.value.pending!);
    expect(done.ok && done.value.kind).toBe('done');
    expect(recorded).toEqual([r.value.pending!.args]);
  });

  it('« 45 € de gasoil ce matin » : catégorie carburant déduite, fournisseur manquant → question (rien créé)', async () => {
    const { agent, recorded } = makeDictated();
    const r = await agent.ask('45 € de gasoil ce matin');
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.intent).toBe('depense_dictee');
    expect(r.value.kind).toBe('answer');
    expect(r.value.card.title).toBe('Chez quel fournisseur ?');
    expect(recorded).toEqual([]);
  });

  it('continuité : la réponse « chez Total » complète la dictée, puis le moyen manquant → ASK structuré', async () => {
    const { agent } = makeDictated();
    const history = [
      { role: 'user' as const, text: '45 € de gasoil ce matin' },
      { role: 'bob' as const, text: 'Il me manque le fournisseur de cette dépense de 45 €.' },
    ];
    const r = await agent.ask('chez Total', { history });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.intent).toBe('depense_dictee');
    expect(r.value.ask?.[0]?.id).toBe('depense_dictee.moyen');
    // Les followUps sont des commandes canoniques COMPLÈTES (l'UI ne reconstruit jamais).
    const followUp = r.value.ask?.[0]?.options.find((o) => o.value === 'card')?.followUp ?? '';
    expect(followUp).toContain('J’ai dépensé 45 € chez Total par carte');
    expect(followUp).toContain('carburant');
  });

  it('chantier dit et RÉEL → dépense née imputée ; chantier INCONNU → refus honnête, rien créé', async () => {
    const { agent, recorded } = makeDictated();
    const linked = await agent.ask('J’ai dépensé 89 € chez Leroy Merlin par carte (catégorie matériel) pour le chantier Durand');
    expect(linked.ok).toBe(true);
    if (!linked.ok) return;
    expect(linked.value.kind).toBe('proposed');
    expect(linked.value.pending?.args).toMatchObject({ chantierId: 'ch-1' });

    const unknown = await agent.ask('J’ai dépensé 89 € chez Leroy Merlin par carte (catégorie matériel) pour le chantier Zanzibar');
    expect(unknown.ok).toBe(true);
    if (!unknown.ok) return;
    expect(unknown.value.kind).toBe('answer');
    expect(unknown.value.card.title).toBe('Chantier introuvable');
    expect(recorded).toEqual([]);
  });

  it('hôte sans recordExpense → réponse honnête ; « scanne ce ticket » reste la navigation scanner', async () => {
    const agent = makeAgent(); // actions de base : pas de recordExpense
    const r = await agent.ask('J’ai dépensé 89 € chez Leroy Merlin par carte');
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.kind).toBe('answer');
    expect(r.value.card.body).toContain('Rien n’a été créé');

    const scan = await makeAgent().ask('Scanne ce ticket');
    expect(scan.ok && scan.value.navigate).toBe('/scan-document');
  });
});

// —— M3 — lier_depense_chantier : « mets la dépense Aldi sur le chantier Durand » ——
describe('lier_depense_chantier (M3) — imputation confirmée, résolution par jetons réels', () => {
  const makeAssign = (over: Partial<BobActions> = {}) => {
    const assigned: unknown[] = [];
    const agent = new BobAgent({
      router: new ModelRouter({ hasClaudeKey: false, hasGlmKey: false }),
      actions: {
        ...actions,
        listRecentExpenses: async () =>
          ok([
            { id: 'exp-1', supplierName: 'Aldi', totalTtcCents: 4500, documentDate: '2026-07-18', chantierId: null },
            { id: 'exp-2', supplierName: 'Leroy Merlin', totalTtcCents: 8900, documentDate: '2026-07-15', chantierId: 'ch-2' },
          ]),
        listFilingDestinations: async () =>
          ok({ chantiers: [{ id: 'ch-1', nom: 'Durand' }, { id: 'ch-2', nom: 'Sèvres' }], dossiers: [] }),
        assignExpenseChantier: async (input) => {
          assigned.push(input);
          return ok({ chantierId: input.chantierId, changed: true });
        },
        ...over,
      },
    });
    return { agent, assigned };
  };

  it('résolution dépense (fournisseur) + chantier (nom réel) → PROPOSE, exécute au confirm()', async () => {
    const { agent, assigned } = makeAssign();
    const r = await agent.ask('Mets la dépense Aldi sur le chantier Durand');
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.intent).toBe('lier_depense_chantier');
    expect(r.value.kind).toBe('proposed');
    expect(r.value.pending?.tool).toBe('lier_depense_chantier');
    expect(r.value.pending?.args).toEqual({ expenseId: 'exp-1', chantierId: 'ch-1' });
    expect(assigned).toEqual([]);
    const done = await agent.confirm(r.value.pending!);
    expect(done.ok && done.value.kind).toBe('done');
    expect(assigned).toEqual([{ expenseId: 'exp-1', chantierId: 'ch-1' }]);
  });

  it('ré-imputation vers un AUTRE chantier : la carte annonce le remplacement', async () => {
    const { agent } = makeAssign();
    const r = await agent.ask('Mets la dépense Leroy Merlin sur le chantier Durand');
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.kind).toBe('proposed');
    expect(r.value.card.body).toContain('Elle quitte le chantier Sèvres');
  });

  it('déjà imputée à CE chantier → réponse honnête, aucune proposition', async () => {
    const { agent, assigned } = makeAssign();
    const r = await agent.ask('Mets la dépense Leroy Merlin sur le chantier Sèvres');
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.kind).toBe('answer');
    expect(r.value.card.title).toBe('Déjà imputée');
    expect(assigned).toEqual([]);
  });

  it('dépense ambiguë → question avec les dépenses RÉELLES ; chantier inconnu → refus honnête', async () => {
    const { agent, assigned } = makeAssign({
      listRecentExpenses: async () =>
        ok([
          { id: 'exp-1', supplierName: 'Aldi', totalTtcCents: 4500, documentDate: '2026-07-18', chantierId: null },
          { id: 'exp-3', supplierName: 'Aldi', totalTtcCents: 1200, documentDate: '2026-07-10', chantierId: null },
        ]),
    });
    const ambiguous = await agent.ask('Mets la dépense Aldi sur le chantier Durand');
    expect(ambiguous.ok).toBe(true);
    if (!ambiguous.ok) return;
    expect(ambiguous.value.kind).toBe('answer');
    expect(ambiguous.value.ask?.[0]?.id).toBe('lier_depense_chantier.depense');
    expect(ambiguous.value.ask?.[0]?.options[0]?.followUp).toBe('Mets la dépense exp-1 sur le chantier ch-1');

    const unknown = await agent.ask('Mets la dépense Aldi de 45 € sur le chantier Zanzibar');
    expect(unknown.ok).toBe(true);
    if (!unknown.ok) return;
    expect(unknown.value.card.title).toBe('Chantier introuvable');
    expect(assigned).toEqual([]);
  });

  it('le montant dit raffine les homonymes (« la dépense Aldi de 12 € »)', async () => {
    const { agent } = makeAssign({
      listRecentExpenses: async () =>
        ok([
          { id: 'exp-1', supplierName: 'Aldi', totalTtcCents: 4500, documentDate: '2026-07-18', chantierId: null },
          { id: 'exp-3', supplierName: 'Aldi', totalTtcCents: 1200, documentDate: '2026-07-10', chantierId: null },
        ]),
    });
    const r = await agent.ask('Mets la dépense Aldi de 12 € sur le chantier Durand');
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.kind).toBe('proposed');
    expect(r.value.pending?.args).toEqual({ expenseId: 'exp-3', chantierId: 'ch-1' });
  });

  it('hôte sans la capacité → réponse honnête, rien modifié', async () => {
    const r = await makeAgent().ask('Mets la dépense Aldi sur le chantier Durand');
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.kind).toBe('answer');
    expect(r.value.card.body).toContain('Rien n’a été modifié');
  });
});

// —— Polissage classer_document : la garde domaine DOCUMENT_ALREADY_LINKED parle humain ——
describe('classer_document — DOCUMENT_ALREADY_LINKED : réponse honnête, jamais le message technique', () => {
  const alreadyLinkedError = {
    kind: 'domain' as const,
    error: {
      code: 'DOCUMENT_ALREADY_LINKED' as const,
      documentId: 'doc-9',
      existing: { linkedEntityType: 'chantier', linkedEntityId: 'ch-2' },
      requested: { linkedEntityType: 'chantier', linkedEntityId: 'ch-1' },
      message: 'Ce document est déjà rattaché à chantier/ch-2 ; rattachement demandé : chantier/ch-1. Délier d’abord le lien existant.',
    },
  };
  // NonNullable : sous exactOptionalPropertyTypes, passer explicitement `fileDocument: undefined`
  // n'est pas assignable à la propriété OPTIONNELLE de BobActions — et aucun appelant ne le fait.
  const docActions = (fileDocument: NonNullable<BobActions['fileDocument']>): BobActions => ({
    ...actions,
    listDocuments: async () =>
      ok([
        {
          id: 'doc-9',
          filename: 'ticket-aldi.jpg',
          kind: 'receipt',
          linkedEntityType: 'chantier',
          linkedEntityId: 'ch-2',
          createdAt: '2026-07-01T10:00:00.000Z',
          displayName: 'Ticket Aldi',
          origin: 'ocr',
          folderId: 'folder-1',
          reviewedAt: null,
        },
      ]),
    listFilingDestinations: async () =>
      ok({ chantiers: [{ id: 'ch-1', nom: 'Durand' }, { id: 'ch-2', nom: 'Sèvres' }], dossiers: [] }),
    fileDocument,
  });

  it('confirm() sur un document déjà lié → carte honnête (le lien existant nommé), pas d’erreur brute', async () => {
    const agent = new BobAgent({
      router: new ModelRouter({ hasClaudeKey: false, hasGlmKey: false }),
      actions: docActions(async () => ({ ok: false, error: alreadyLinkedError })),
    });
    const proposed = await agent.ask('Classe le ticket Aldi dans le chantier Durand');
    expect(proposed.ok && proposed.value.kind).toBe('proposed');
    if (!proposed.ok || !proposed.value.pending) return;
    const r = await agent.confirm(proposed.value.pending);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.kind).toBe('answer');
    expect(r.value.card.title).toBe('Déjà lié — je ne touche à rien');
    expect(r.value.card.body).toContain('déjà lié au chantier');
    expect(r.value.card.body).toContain('je ne l’écrase pas');
    expect(r.value.card.body).not.toContain('DOCUMENT_ALREADY_LINKED');
  });

  it('toute autre erreur de classement reste une erreur (pas de fausse douceur)', async () => {
    const agent = new BobAgent({
      router: new ModelRouter({ hasClaudeKey: false, hasGlmKey: false }),
      actions: docActions(async () => ({ ok: false, error: { kind: 'dependency', port: 'documents', cause: 'x' } })),
    });
    const proposed = await agent.ask('Classe le ticket Aldi dans le chantier Durand');
    if (!proposed.ok || !proposed.value.pending) return;
    const r = await agent.confirm(proposed.value.pending);
    expect(r.ok).toBe(false);
  });
});
