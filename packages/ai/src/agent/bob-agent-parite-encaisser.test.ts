import { describe, it, expect } from 'vitest';
import { ok, err, deriveBusinessReview, type AppError } from '@bob/core';
import { BobAgent } from './bob-agent';
import { ModelRouter } from '../router/model-router';
import { type BobActions } from './actions';

/**
 * Parité « papa vocal » de la vague Encaisser (PR-01..PR-07) — chaque fonction manuelle expose
 * son outil sur le MÊME use case : relance de devis lisible (PR-05), politique de relances
 * (PR-06), carte Encaissement audible (PR-07) et rattrapage du refus « BC obligatoire » (PR-04).
 */

const NOW = '2026-07-27T10:00:00.000Z';

const baseActions: BobActions = {
  computePayout: async () => ok({ payoutCents: 100000, availableCents: 200000 }),
  draftRelance: async () => ok({ subject: 'Relance', body: 'Corps.' }),
  listPayableInvoices: async () =>
    ok([{ id: 'inv-1', number: '2026-014', remainingCents: 132000, customerName: 'Durand SARL' }]),
  listSendableQuotes: async () =>
    ok([
      { id: 'q-durand', number: 'D2026-050', totalTtcCents: 264000, customerName: 'Durand SARL', status: 'sent' },
      { id: 'q-brouillon', number: null, totalTtcCents: 90000, customerName: 'M. Martin', status: 'draft' },
    ]),
  listIssuableInvoices: async () => ok([]),
  listDocuments: async () => ok([]),
  registerPayment: async () => ok({ status: 'paid' }),
  sendQuote: async () => ok({ number: 'D2026-050' }),
  issueInvoice: async () => ok({ number: 'F2026-001' }),
};

const makeAgent = (over: Partial<BobActions> = {}): BobAgent =>
  new BobAgent({
    router: new ModelRouter({ hasClaudeKey: false, hasGlmKey: false }),
    actions: { ...baseActions, ...over },
    runtime: { clock: { now: () => NOW }, ids: { newId: () => 'run-parite' } },
  });

describe('relance_devis (PR-05) — brouillon LISIBLE au même palier que la carte Aujourd’hui', () => {
  it('« relance le devis Durand » : présente le message réel de l’hôte + chip de renvoi (lecture, rien envoyé)', async () => {
    const asked: unknown[] = [];
    const agent = makeAgent({
      draftQuoteRelance: async (input) => {
        asked.push(input);
        return ok({
          relanceable: true,
          palier: 'j15' as const,
          subject: 'Devis D2026-050 — où en êtes-vous ?',
          body: 'Bonjour Durand SARL, je reviens vers vous au sujet du devis D2026-050…',
        });
      },
    });
    const r = await agent.ask('Relance le devis Durand');
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.intent).toBe('relance_devis');
    expect(r.value.kind).toBe('answer'); // lecture pure : AUCUNE confirmation demandée
    expect(r.value.pending).toBeUndefined();
    expect(r.value.card.title).toBe('Devis D2026-050 — où en êtes-vous ?');
    expect(r.value.card.body).toContain('je reviens vers vous');
    // Le geste réel qui suit (renvoi du devis, lien frais) est offert en chip — flux
    // envoyer_devis EXISTANT, confirmé : jamais un envoi improvisé ici.
    expect(r.value.choices?.[0]?.value).toBe('Envoie le devis D2026-050');
    expect(asked).toEqual([{ quoteId: 'q-durand' }]); // le devis « sent » — jamais le brouillon
  });

  it('hors palier : la réponse HONNÊTE du service, aucune relance fabriquée', async () => {
    const agent = makeAgent({
      draftQuoteRelance: async () =>
        ok({ relanceable: false, palier: null, subject: 'Rien à relancer sur ce devis', body: 'Pas encore au palier J+15/J+30.' }),
    });
    const r = await agent.ask('Relance le devis Durand');
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.kind).toBe('answer');
    expect(r.value.card.title).toBe('Rien à relancer sur ce devis');
    expect(r.value.choices).toBeUndefined();
  });

  it('hôte SANS draftQuoteRelance : réponse capacité honnête (jamais un flux factures détourné)', async () => {
    const r = await makeAgent().ask('Relance le devis Durand');
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.intent).toBe('relance_devis');
    expect(r.value.card.body).toContain('fiche du devis');
  });
});

describe('cadence_relances (PR-06) — lecture de la politique + bascule CONFIRMÉE', () => {
  it('« quelle est ma politique de relance ? » : lit la cadence réelle + l’état auto, avec la chip de bascule', async () => {
    const agent = makeAgent({
      getRelanceSettings: async () =>
        ok({
          relanceAutoEnabled: true,
          relancePolicy: { cordialAfterDays: 5, neutreAfterDays: 12, fermeAfterDays: 25, miseEnDemeureAfterDays: 40 },
        }),
      setRelanceAutoEnabled: async (input) => ok({ relanceAutoEnabled: input.enabled, relancePolicy: null }),
    });
    const r = await agent.ask('Quelle est ma politique de relance ?');
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.intent).toBe('cadence_relances');
    expect(r.value.kind).toBe('answer'); // lecture : jamais de confirmation
    expect(r.value.card.body).toContain('cordial J+5');
    expect(r.value.card.body).toContain('mise en demeure J+40');
    expect(r.value.card.body).toContain('ACTIVES');
    expect(r.value.choices?.[0]?.value).toBe('Coupe les relances automatiques');
  });

  it('« coupe les relances automatiques » : mutation PROPOSÉE (plancher), confirmée puis exécutée', async () => {
    const set: unknown[] = [];
    const agent = makeAgent({
      getRelanceSettings: async () => ok({ relanceAutoEnabled: true, relancePolicy: null }),
      setRelanceAutoEnabled: async (input) => {
        set.push(input);
        return ok({ relanceAutoEnabled: input.enabled, relancePolicy: null });
      },
    });
    const r = await agent.ask('Coupe les relances automatiques');
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.kind).toBe('proposed');
    expect(r.value.pending?.tool).toBe('regler_relances_auto');
    expect(r.value.pending?.args).toEqual({ enabled: false });
    expect(set).toEqual([]); // rien basculé avant la confirmation
    const done = await agent.confirm(r.value.pending!);
    expect(done.ok && done.value.kind).toBe('done');
    expect(done.ok && done.value.card.title).toBe('Relances automatiques coupées ✓');
    expect(set).toEqual([{ enabled: false }]);
  });

  it('bascule déjà en place : réponse honnête « déjà réglé », aucune proposition', async () => {
    const agent = makeAgent({
      getRelanceSettings: async () => ok({ relanceAutoEnabled: false, relancePolicy: null }),
      setRelanceAutoEnabled: async (input) => ok({ relanceAutoEnabled: input.enabled, relancePolicy: null }),
    });
    const r = await agent.ask('Coupe les relances automatiques');
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.kind).toBe('answer');
    expect(r.value.card.title).toBe('Déjà réglé ainsi');
  });
});

describe('pilotage (PR-07) — la carte Encaissement devient audible, depuis la MÊME review', () => {
  const emptyReview = deriveBusinessReview({
    entries: [],
    payments: [],
    invoices: [],
    customers: [],
    expenses: [],
    vatRegime: 'reel_normal',
    today: '2026-07-27',
  });

  it('la réponse pilotage lit le taux 90 j, l’encours échu et les émises jamais envoyées + chip d’envoi', async () => {
    const agent = makeAgent({
      sendInvoice: async () =>
        ok({ number: '2026-002', recipient: 'x@y.fr', deliveryStatus: 'queued' as const, jobId: 'j1' }),
      getBusinessReview: async () =>
        ok({
          ...emptyReview,
          collection: {
            collectedRateBps90d: 4200,
            reason: 'ok' as const,
            collectedTtc90dCents: 210000,
            invoicedTtc90dCents: 500000,
            overdueCents: 132000,
            untransmitted: [
              {
                invoiceId: 'inv-2',
                docNumber: '2026-002',
                customerId: 'cus-ratp',
                customerName: 'RATP Infrastructures',
                amountCents: 480000,
              },
            ],
          },
        }),
    });
    const r = await agent.ask('Comment va mon activité ?');
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.intent).toBe('pilotage');
    expect(r.value.card.body).toContain('Encaissement 90 j : 42 %');
    expect(r.value.card.body).toContain('Encours échu');
    expect(r.value.card.body).toContain('1 facture émise sans envoi constaté');
    expect(r.value.card.body).toContain('2026-002 en tête');
    // Le geste qui répare le trou, à portée de voix — commande canonique envoyer_facture.
    expect(r.value.choices?.[0]?.value).toBe('Envoie la facture 2026-002');
  });

  it('fenêtre trop courte : aucun taux fabriqué, aucune ligne d’encaissement mensongère', async () => {
    const agent = makeAgent({ getBusinessReview: async () => ok(emptyReview) });
    const r = await agent.ask('Comment va mon activité ?');
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.card.body).not.toContain('Encaissement 90 j');
    expect(r.value.card.body).not.toContain('sans envoi constaté');
  });
});

describe('emettre_facture (PR-04) — rattrapage du refus « BC obligatoire »', () => {
  const PO_ERROR: AppError = {
    kind: 'domain',
    error: {
      code: 'PURCHASE_ORDER_REQUIRED',
      invoiceId: 'draft-1',
      customerId: 'cus-ratp',
      customerName: 'RATP Infrastructures',
      message:
        'RATP Infrastructures exige un n° de bon de commande : saisis-le sur la facture avant d’émettre — sans lui, la pièce sera rejetée par ton client. Tu peux aussi émettre sans BC en confirmant ce risque (tracé).',
      overridable: true,
    },
  } as AppError;

  const draft = {
    id: 'draft-1',
    number: null,
    totalTtcCents: 480000,
    customerName: 'RATP Infrastructures',
    status: 'draft',
    operationCategoryRequired: false,
  };

  it('le refus à la CONFIRMATION devient le parcours de rattrapage : message verbatim + les 2 chemins', async () => {
    const agent = makeAgent({
      listIssuableInvoices: async () => ok([draft]),
      issueInvoice: async (input) =>
        input.purchaseOrderOverride === true ? ok({ number: 'F2026-002' }) : err(PO_ERROR),
    });
    const proposed = await agent.ask('Émets la facture de la RATP');
    expect(proposed.ok && proposed.value.kind).toBe('proposed');
    if (!proposed.ok || !proposed.value.pending) return;
    const refused = await agent.confirm(proposed.value.pending);
    expect(refused.ok).toBe(true); // jamais une erreur brute : une carte actionnable
    if (!refused.ok) return;
    expect(refused.value.kind).toBe('answer');
    expect(refused.value.card.title).toBe('Bon de commande obligatoire — rien n’a été émis');
    expect(refused.value.card.body).toContain('exige un n° de bon de commande'); // le domaine, verbatim
    expect(refused.value.choices?.map((c) => c.label)).toEqual([
      'Saisir le bon de commande',
      'Émettre sans BC (risque tracé)',
    ]);
    // Le chemin SÛR d'abord (lier_bon_commande), l'override responsabilisé en second.
    expect(refused.value.choices?.[0]?.value).toBe('Ajoute le bon de commande au devis de RATP Infrastructures');
    expect(refused.value.choices?.[1]?.value).toBe('Émets la facture draft-1 sans bon de commande');
  });

  it('la commande d’override RE-PROPOSE avec le risque énoncé, puis émet purchaseOrderOverride:true', async () => {
    const issued: unknown[] = [];
    const agent = makeAgent({
      listIssuableInvoices: async () => ok([draft]),
      issueInvoice: async (input) => {
        issued.push(input);
        return input.purchaseOrderOverride === true ? ok({ number: 'F2026-002' }) : err(PO_ERROR);
      },
    });
    const r = await agent.ask('Émets la facture draft-1 sans bon de commande');
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.kind).toBe('proposed'); // le plancher fiscal impose la confirmation dédiée
    expect(r.value.card.body).toContain('risque d’être rejetée'); // le risque, AVANT le oui
    expect(r.value.pending?.args).toMatchObject({ invoiceId: 'draft-1', purchaseOrderOverride: true });
    expect(issued).toEqual([]);
    const done = await agent.confirm(r.value.pending!);
    expect(done.ok && done.value.kind).toBe('done');
    expect(issued).toEqual([{ invoiceId: 'draft-1', purchaseOrderOverride: true }]);
  });

  it('le refus au flux DIRECT (sans étape de confirmation restante) rend la même carte de rattrapage', async () => {
    const agent = makeAgent({
      listIssuableInvoices: async () => ok([draft]),
      issueInvoice: async () => err(PO_ERROR),
    });
    const proposed = await agent.ask('Émets la facture de la RATP', { autonomy: 'auto' });
    expect(proposed.ok).toBe(true);
    if (!proposed.ok) return;
    // Même en 'auto', le plancher fiscal propose d'abord — la confirmation rejoue ensuite le
    // MÊME rattrapage : les deux chemins rendent la carte actionnable, jamais l'erreur brute.
    if (proposed.value.kind === 'proposed' && proposed.value.pending) {
      const refused = await agent.confirm(proposed.value.pending);
      expect(refused.ok && refused.value.card.title).toBe('Bon de commande obligatoire — rien n’a été émis');
    } else {
      expect(proposed.value.card.title).toBe('Bon de commande obligatoire — rien n’a été émis');
    }
  });
});

describe('envoyer_facture (PR-01) — refus du domaine restitués, cible honnête', () => {
  it('erreur domaine (ex. destinataire manquant) → carte verbatim « Refusé — rien n’a été modifié » à la confirmation', async () => {
    const agent = makeAgent({
      sendInvoice: async () =>
        err({
          kind: 'domain',
          error: { code: 'VALIDATION', field: 'recipient', message: 'Le client n’a pas d’adresse e-mail : complète sa fiche avant l’envoi.' },
        } as AppError),
    });
    const proposed = await agent.ask('Envoie la facture 2026-014');
    expect(proposed.ok && proposed.value.kind).toBe('proposed');
    if (!proposed.ok || !proposed.value.pending) return;
    const refused = await agent.confirm(proposed.value.pending);
    expect(refused.ok).toBe(true);
    if (!refused.ok) return;
    expect(refused.value.card.title).toBe('Refusé — rien n’a été modifié');
    expect(refused.value.card.body).toContain('n’a pas d’adresse e-mail');
  });

  it('aucune facture émise en attente : réponse honnête, jamais une proposition', async () => {
    const agent = makeAgent({
      sendInvoice: async () =>
        ok({ number: 'x', recipient: 'x', deliveryStatus: 'sent' as const, jobId: 'j' }),
      listPayableInvoices: async () => ok([]),
    });
    const r = await agent.ask('Envoie la facture 2026-014');
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.kind).toBe('answer');
    expect(r.value.card.body).toContain('rien à envoyer');
  });
});

describe('envoyer_facture — destinataire dicté (PR-09, contacts multiples)', () => {
  const contacts = [
    { id: 'ct-compta', label: 'Compta', name: 'Mme Lefèvre', email: 'compta@durand.fr' },
    { id: 'ct-valideur', label: 'Valideur', name: 'M. Riva', email: 'valideur@durand.fr' },
    { id: 'ct-gardien', label: 'Gardien', name: 'M. Sans-Mail', email: null },
  ];

  it('« envoie la facture 2026-014 à la compta » : contact RÉSOLU contre le carnet réel, adresse dans la proposition', async () => {
    const sends: unknown[] = [];
    const agent = makeAgent({
      sendInvoice: async (input) => {
        sends.push(input);
        return ok({ number: '2026-014', recipient: 'compta@durand.fr', deliveryStatus: 'queued' as const, jobId: 'j' });
      },
      listInvoiceRecipientContacts: async () => ok(contacts),
    });
    const proposed = await agent.ask('Envoie la facture 2026-014 à la compta');
    expect(proposed.ok).toBe(true);
    if (!proposed.ok) return;
    expect(proposed.value.kind).toBe('proposed');
    expect(proposed.value.pending?.args).toMatchObject({
      invoiceId: 'inv-1',
      recipientEmail: 'compta@durand.fr',
    });
    // Le récap DIT le destinataire choisi (jamais un envoi aveugle).
    expect(proposed.value.pending?.label).toContain('compta@durand.fr');
    expect(sends).toHaveLength(0);
    const done = await agent.confirm(proposed.value.pending!);
    expect(done.ok && done.value.kind).toBe('done');
    expect(sends[0]).toMatchObject({ invoiceId: 'inv-1', recipientEmail: 'compta@durand.fr' });
  });

  it('repli honnête : aucun destinataire dit → e-mail de la fiche client (aucun recipientEmail forcé)', async () => {
    const agent = makeAgent({
      sendInvoice: async () =>
        ok({ number: '2026-014', recipient: 'facturation@durand.fr', deliveryStatus: 'queued' as const, jobId: 'j' }),
      listInvoiceRecipientContacts: async () => ok(contacts),
    });
    const proposed = await agent.ask('Envoie la facture 2026-014');
    expect(proposed.ok).toBe(true);
    if (!proposed.ok) return;
    expect(proposed.value.kind).toBe('proposed');
    expect(proposed.value.pending?.args).not.toHaveProperty('recipientEmail');
  });

  it('sans capacité hôte (carnet indisponible) : comportement PR-01 inchangé', async () => {
    const agent = makeAgent({
      sendInvoice: async () =>
        ok({ number: '2026-014', recipient: 'facturation@durand.fr', deliveryStatus: 'queued' as const, jobId: 'j' }),
    });
    const proposed = await agent.ask('Envoie la facture 2026-014 à la compta');
    expect(proposed.ok).toBe(true);
    if (!proposed.ok) return;
    expect(proposed.value.kind).toBe('proposed');
    expect(proposed.value.pending?.args).not.toHaveProperty('recipientEmail');
  });

  it('un contact SANS e-mail n’est jamais résolu comme destinataire', async () => {
    const agent = makeAgent({
      sendInvoice: async () =>
        ok({ number: '2026-014', recipient: 'facturation@durand.fr', deliveryStatus: 'queued' as const, jobId: 'j' }),
      listInvoiceRecipientContacts: async () => ok(contacts),
    });
    const proposed = await agent.ask('Envoie la facture 2026-014 au gardien');
    expect(proposed.ok).toBe(true);
    if (!proposed.ok) return;
    // « gardien » ne matche aucun contact JOIGNABLE → repli fiche client, jamais une adresse nulle.
    expect(proposed.value.kind).toBe('proposed');
    expect(proposed.value.pending?.args).not.toHaveProperty('recipientEmail');
  });

  it('deux contacts au MÊME rôle (« Compta ») : question posée PUIS résolue par le followUp rôle+nom — jamais une boucle', async () => {
    const twoComptas = [
      { id: 'ct-compta-1', label: 'Compta', name: 'Marie Dupont', email: 'marie@durand.fr' },
      { id: 'ct-compta-2', label: 'Compta', name: 'Jean Ruiz', email: 'jean@durand.fr' },
    ];
    const agent = makeAgent({
      sendInvoice: async () =>
        ok({ number: '2026-014', recipient: 'marie@durand.fr', deliveryStatus: 'queued' as const, jobId: 'j' }),
      listInvoiceRecipientContacts: async () => ok(twoComptas),
    });
    // Tour 1 : « à la compta » couvre les deux contacts → question structurée, jamais un
    // choix silencieux (doctrine du repo : chaque ask est testé).
    const turn1Message = 'Envoie la facture 2026-014 à la compta';
    const turn1 = await agent.ask(turn1Message);
    expect(turn1.ok).toBe(true);
    if (!turn1.ok) return;
    expect(turn1.value.kind).toBe('answer');
    const question = turn1.value.ask?.[0];
    expect(question?.id).toBe('envoyer_facture.destinataire');
    expect(question?.options).toHaveLength(2);
    const marie = question?.options.find((o) => o.label.includes('Marie Dupont'));
    expect(marie?.value).toBe('ct-compta-1');

    // Tour 2 : le followUp VERBATIM (« à Compta Marie Dupont ») redit le rôle ET le nom — la
    // spécificité départage les deux « Compta » : résolution, jamais la même question en boucle.
    const turn2 = await agent.ask(marie!.followUp, {
      history: [
        { role: 'user', text: turn1Message },
        { role: 'bob', text: turn1.value.card.body },
      ],
    });
    expect(turn2.ok).toBe(true);
    if (!turn2.ok) return;
    expect(turn2.value.kind).toBe('proposed');
    expect(turn2.value.pending?.args).toMatchObject({ invoiceId: 'inv-1', recipientEmail: 'marie@durand.fr' });
    expect(turn2.value.pending?.label).toContain('Marie Dupont');
  });
});
