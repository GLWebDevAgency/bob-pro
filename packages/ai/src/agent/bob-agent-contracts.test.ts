import { describe, it, expect } from 'vitest';
import { CONTRACT_B2C_REFUSED_MESSAGE, err, ok } from '@bob/core';
import { BobAgent } from './bob-agent';
import { ModelRouter } from '../router/model-router';
import {
  type AgentContract,
  type BillableCustomer,
  type BobActions,
  type PrepareContractAnnualInvoiceActionInput,
} from './actions';

/**
 * PR-12c — parité vocale des CONTRATS (Bloc B §2.7) : statut PARLÉ (faits dérivés dits tels
 * quels), « prépare la facture annuelle de Carrefour » (résolution par NOM — label OU client,
 * patron resolveSpokenEquipment), TESTS D'AMBIGUÏTÉ OBLIGATOIRES (followUps par ID qui
 * convergent — jamais une boucle), et enchaînement composite conditionnel (« si c'est le
 * moment ») : la proposition n'arrive QUE si deriveAnnualBillingDue est vraie, sinon la
 * réponse honnête cite le numéro couvrant.
 */

const NOW = '2026-09-20T10:00:00.000Z';

function contractOf(over: Partial<AgentContract> & Pick<AgentContract, 'id' | 'label'>): AgentContract {
  return {
    status: 'active',
    customerName: null,
    chantierNom: null,
    tacitRenewal: true,
    noticeDays: 30,
    annualTotalHtCents: 160_000,
    currentPeriod: { start: '2025-10-12', end: '2026-10-12' },
    currentPeriodCoveredBy: { by: 'invoice', number: 'F-2026-0791' },
    billingDue: null,
    renewalAlert: { palier: 'j30', anniversary: '2026-10-12', daysUntil: 22, tacit: true },
    expiredSince: null,
    terminatedCoverageUntil: null,
    anniversaryDate: '2025-10-12',
    ...over,
  };
}

/** Contrat en fenêtre −30 j : période suivante due (erratum n° 3 — la fenêtre vit chaque année). */
const BASTILLE_DUE = contractOf({
  id: 'contract-bastille',
  label: 'Entretien fontaines Bastille',
  customerName: 'RATP CAP',
  chantierNom: 'RATP Bastille',
  billingDue: { periodStart: '2026-10-12', periodEnd: '2027-10-12', cancelledCoveringNumber: null },
});

const CARREFOUR_COVERED = contractOf({
  id: 'contract-carrefour',
  label: 'Entretien vitrines',
  customerName: 'Carrefour',
});

const baseActions: BobActions = {
  computePayout: async () => ok({ payoutCents: 0, availableCents: 0 }),
  draftRelance: async () => ok({ subject: 'x', body: 'x' }),
  listPayableInvoices: async () => ok([]),
  listSendableQuotes: async () => ok([]),
  listIssuableInvoices: async () => ok([]),
  listDocuments: async () => ok([]),
  registerPayment: async () => ok({ status: 'paid' }),
  sendQuote: async () => ok({ number: 'D2026-001' }),
  issueInvoice: async () => ok({ number: 'F2026-001' }),
};

const makeAgent = (
  contracts: AgentContract[],
  over: Partial<BobActions> = {},
): BobAgent =>
  new BobAgent({
    router: new ModelRouter({ hasClaudeKey: false, hasGlmKey: false }),
    actions: {
      ...baseActions,
      listMaintenanceContracts: async () => ok(contracts),
      prepareContractAnnualInvoice: async () =>
        ok({
          invoiceId: 'invoice-annual',
          periodStart: '2026-10-12',
          periodEnd: '2027-10-11',
          totalTtcCents: 192_000,
          contractTotalTtcCents: 192_000,
          vatDivergence: false,
        }),
      ...over,
    },
    runtime: { clock: { now: () => NOW }, ids: { newId: () => 'run-contracts' } },
  });

describe('statut_contrat — le statut PARLÉ dit les faits DÉRIVÉS (période, couverture, échéance)', () => {
  it('« le contrat Bastille, ça en est où ? » : période, couverture par F-…, reconduction et préavis', async () => {
    const agent = makeAgent([BASTILLE_DUE, CARREFOUR_COVERED]);
    const r = await agent.ask('Le contrat Bastille, ça en est où ?');
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.intent).toBe('statut_contrat');
    expect(r.value.kind).toBe('answer');
    expect(r.value.card.title).toContain('Entretien fontaines Bastille');
    // Couverture DÉRIVÉE dite avec son numéro réel ; bornes INCLUSES lisibles (11/10/2026).
    expect(r.value.card.body).toContain('F-2026-0791');
    expect(r.value.card.body).toContain('11/10/2026');
    expect(r.value.card.body).toContain('reconduit');
    expect(r.value.card.body).toContain('Préavis : 30 jours');
  });

  it('contrat résilié : « couvert jusqu’au » (borne exclusive → veille affichée)', async () => {
    const agent = makeAgent([
      contractOf({
        id: 'contract-docks',
        label: 'Entretien Docks',
        status: 'terminated',
        currentPeriod: null,
        currentPeriodCoveredBy: null,
        renewalAlert: null,
        terminatedCoverageUntil: '2026-12-01',
      }),
    ]);
    const r = await agent.ask('Statut du contrat Docks ?');
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.kind).toBe('answer');
    expect(r.value.card.body).toContain('Résilié');
    expect(r.value.card.body).toContain('30/11/2026');
  });
});

describe('preparer_facture_annuelle — « prépare la facture annuelle de Carrefour » (résolution par NOM)', () => {
  it('résout par le CLIENT dit, période due → PROPOSITION confirmée (rien ne part avant le geste)', async () => {
    const prepared: PrepareContractAnnualInvoiceActionInput[] = [];
    const agent = makeAgent(
      [
        BASTILLE_DUE,
        contractOf({
          id: 'contract-carrefour-due',
          label: 'Entretien vitrines',
          customerName: 'Carrefour',
          billingDue: {
            periodStart: '2026-10-12',
            periodEnd: '2027-10-12',
            cancelledCoveringNumber: null,
          },
        }),
      ],
      {
        prepareContractAnnualInvoice: async (input) => {
          prepared.push(input);
          return ok({
            invoiceId: 'invoice-annual',
            periodStart: '2026-10-12',
            periodEnd: '2027-10-11',
            totalTtcCents: 192_000,
            contractTotalTtcCents: 192_000,
            vatDivergence: false,
          });
        },
      },
    );
    const r = await agent.ask('Prépare la facture annuelle de Carrefour');
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.intent).toBe('preparer_facture_annuelle');
    // Mutation → confirmation OBLIGATOIRE (safetyFloor) : rien n'est préparé avant le geste.
    expect(r.value.kind).toBe('proposed');
    expect(prepared).toEqual([]);
    expect(r.value.pending?.tool).toBe('preparer_facture_annuelle');
    expect(r.value.pending?.args).toEqual({ contractId: 'contract-carrefour-due' });
    // Le brouillon est annoncé comme BROUILLON — jamais émis, jamais envoyé seul.
    expect(r.value.card.body).toContain('brouillon');
  });

  it('période COUVERTE → réponse honnête avec le numéro couvrant, kind answer, rien de préparé', async () => {
    const prepared: PrepareContractAnnualInvoiceActionInput[] = [];
    const agent = makeAgent([CARREFOUR_COVERED], {
      prepareContractAnnualInvoice: async (input) => {
        prepared.push(input);
        return ok({
          invoiceId: 'never',
          periodStart: '',
          periodEnd: '',
          totalTtcCents: 0,
          contractTotalTtcCents: 0,
          vatDivergence: false,
        });
      },
    });
    const r = await agent.ask('Prépare la facture annuelle de Carrefour');
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.kind).toBe('answer');
    expect(prepared).toEqual([]);
    expect(r.value.card.body).toContain('F-2026-0791');
    expect(r.value.card.body).toContain('Rien n’a été préparé');
  });

  it('AMBIGUÏTÉ : deux contrats du même client → question à followUps par ID, qui CONVERGE au tour suivant', async () => {
    const dueA = contractOf({
      id: 'contract-carrefour-fontaines',
      label: 'Entretien fontaines',
      customerName: 'Carrefour',
      billingDue: { periodStart: '2026-10-12', periodEnd: '2027-10-12', cancelledCoveringNumber: null },
    });
    const dueB = contractOf({
      id: 'contract-carrefour-clims',
      label: 'Entretien clims',
      customerName: 'Carrefour',
      billingDue: { periodStart: '2026-11-01', periodEnd: '2027-11-01', cancelledCoveringNumber: null },
    });
    const agent = makeAgent([dueA, dueB]);
    const first = await agent.ask('Prépare la facture annuelle de Carrefour');
    expect(first.ok).toBe(true);
    if (!first.ok) return;
    // Vraie ambiguïté → QUESTION (jamais un choix silencieux), options réelles.
    expect(first.value.kind).toBe('answer');
    expect(first.value.ask?.[0]?.options.map((option) => option.value).sort()).toEqual(
      ['contract-carrefour-clims', 'contract-carrefour-fontaines'].sort(),
    );
    const followUp = first.value.ask?.[0]?.options.find(
      (option) => option.value === 'contract-carrefour-clims',
    )?.followUp;
    expect(followUp).toBeDefined();
    // Le followUp porte l'ID : le tour suivant résout par byId — la question ne reboucle pas.
    const second = await agent.ask(followUp!);
    expect(second.ok).toBe(true);
    if (!second.ok) return;
    expect(second.value.kind).toBe('proposed');
    expect(second.value.pending?.args).toEqual({ contractId: 'contract-carrefour-clims' });
  });

  it('nom dit mais INTROUVABLE → refus honnête (jamais un contrat inventé), choix réels proposés', async () => {
    const agent = makeAgent([BASTILLE_DUE]);
    const r = await agent.ask('Prépare la facture annuelle du contrat Zanzibar');
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.kind).toBe('answer');
    expect(r.value.card.title).toContain('introuvable');
    expect(r.value.card.body).toContain('zanzibar');
  });

  it('enchaînement COMPOSITE conditionnel : « … et si c’est le moment prépare la facture annuelle » — propose quand c’est dû', async () => {
    const agent = makeAgent([BASTILLE_DUE]);
    const r = await agent.ask(
      'Je sors de Bastille, si c’est le moment prépare la facture annuelle du contrat',
    );
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.intent).toBe('preparer_facture_annuelle');
    expect(r.value.kind).toBe('proposed');
    // La proposition DIT la période dérivée (bornes incluses) avant le geste.
    expect(r.value.card.body).toContain('12/10/2026');
    expect(r.value.card.body).toContain('11/10/2027');
  });

  it('enchaînement COMPOSITE conditionnel : même phrase, période couverte → réponse honnête, rien de préparé', async () => {
    const agent = makeAgent([CARREFOUR_COVERED]);
    const r = await agent.ask(
      'Je sors de chez Carrefour, si c’est le moment prépare la facture annuelle du contrat',
    );
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.kind).toBe('answer');
    expect(r.value.card.body).toContain('F-2026-0791');
    expect(r.value.card.body).toContain('Rien n’a été préparé');
  });
});

describe('contrats_a_renouveler — alertes J-60/J-30 dérivées (interne, jamais un envoi client)', () => {
  it('liste tacites (« se reconduit ») et non-tacites échus (« à renouveler ou résilier »)', async () => {
    const agent = makeAgent([
      BASTILLE_DUE,
      contractOf({
        id: 'contract-echu',
        label: 'Entretien Docks',
        tacitRenewal: false,
        renewalAlert: null,
        expiredSince: '2026-09-01',
        currentPeriod: null,
        currentPeriodCoveredBy: null,
      }),
    ]);
    const r = await agent.ask('Quels contrats à renouveler ?');
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.intent).toBe('contrats_a_renouveler');
    expect(r.value.card.body).toContain('se reconduit dans 22 jours');
    expect(r.value.card.body).toContain('échu le 01/09/2026');
  });

  it('aucun contrat en fenêtre → réponse honnête calme (aucune alerte inventée)', async () => {
    const agent = makeAgent([contractOf({ id: 'c-1', label: 'Entretien', renewalAlert: null })]);
    const r = await agent.ask('Des contrats qui expirent bientôt ?');
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.card.body).toContain('Aucun contrat à renouveler');
  });
});

describe('capacité hôte absente — fail-closed honnête', () => {
  it('sans listMaintenanceContracts : réponse « indisponible », jamais une erreur brute', async () => {
    const agent = new BobAgent({
      router: new ModelRouter({ hasClaudeKey: false, hasGlmKey: false }),
      actions: baseActions,
      runtime: { clock: { now: () => NOW }, ids: { newId: () => 'run-contracts' } },
    });
    const r = await agent.ask('Statut du contrat Bastille ?');
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.kind).toBe('answer');
    expect(r.value.card.body).toContain('Rien n’a été modifié');
  });
});

/**
 * §2.7 — PARITÉ VOCALE DES GESTES DE CONTRAT (création / activation / résiliation) : mêmes use
 * cases que la fiche, consigne composite lue en UNE passe, question ciblée sur le SEUL manque,
 * UNE confirmation groupée qui RÉCITE, refus du domaine restitués VERBATIM, et AMBIGUÏTÉS
 * (clients ou contrats aux noms inclusifs) résolues par des followUps porteurs d'ID qui
 * CONVERGENT au tour suivant — jamais une boucle, jamais un id récité dans la carte.
 */

const RATP: BillableCustomer = { id: 'cus-ratp', name: 'RATP', type: 'b2g' };
const RATP_CAP: BillableCustomer = { id: 'cus-ratp-cap', name: 'RATP CAP', type: 'b2g' };
const GIRARD: BillableCustomer = { id: 'cus-girard', name: 'Girard', type: 'b2c' };

const BASTILLE_SITE = { id: 'site-bastille', nom: 'Bastille', status: 'open' as const };

function lifecycleAgent(over: Partial<BobActions> = {}, contracts: AgentContract[] = []): BobAgent {
  return new BobAgent({
    router: new ModelRouter({ hasClaudeKey: false, hasGlmKey: false }),
    actions: {
      ...baseActions,
      listMaintenanceContracts: async () => ok(contracts),
      listBillableCustomers: async () => ok([RATP, GIRARD]),
      createMaintenanceContract: async () =>
        ok({
          contractId: 'contract-new',
          label: 'Fontaines RATP',
          status: 'draft' as const,
          anniversaryDate: '2026-10-01',
          terminationEffectiveDate: null,
        }),
      activateMaintenanceContract: async () =>
        ok({
          contractId: 'contract-bastille',
          label: 'Entretien fontaines Bastille',
          status: 'active' as const,
          anniversaryDate: '2025-10-12',
          terminationEffectiveDate: null,
        }),
      terminateMaintenanceContract: async () =>
        ok({
          contractId: 'contract-bastille',
          label: 'Entretien fontaines Bastille',
          status: 'terminated' as const,
          anniversaryDate: '2025-10-12',
          terminationEffectiveDate: '2027-06-01',
        }),
      ...over,
    },
    runtime: { clock: { now: () => NOW }, ids: { newId: () => 'run-contracts' } },
  });
}

describe('creer_contrat_maintenance — consigne composite désordonnée lue en UNE passe (§2.7)', () => {
  it('« fais-moi le contrat fontaines RATP, 3 fontaines, 1 200 € par an, ça démarre au 1er octobre, 2 passages » : UNE confirmation groupée qui récite tout', async () => {
    const created: unknown[] = [];
    const agent = lifecycleAgent({
      listFilingDestinations: async () => ok({ chantiers: [BASTILLE_SITE], dossiers: [] }),
      listEquipments: async () =>
        ok([
          { id: 'eq-1', label: 'Fontaine quai A', kind: null, status: 'active', chantierId: 'site-bastille', chantierNom: 'Bastille' },
          { id: 'eq-2', label: 'Fontaine quai B', kind: null, status: 'active', chantierId: 'site-bastille', chantierNom: 'Bastille' },
          { id: 'eq-3', label: 'Fontaine hall', kind: null, status: 'active', chantierId: 'site-bastille', chantierNom: 'Bastille' },
        ]),
      createMaintenanceContract: async (input) => {
        created.push(input);
        return ok({
          contractId: 'contract-new',
          label: input.label,
          status: 'draft' as const,
          anniversaryDate: input.anniversaryDate,
          terminationEffectiveDate: null,
        });
      },
    });
    const r = await agent.ask(
      'Fais-moi le contrat « Fontaines RATP » pour RATP sur le site Bastille, 3 fontaines, 1 200 € par an, ça démarre au 1er octobre, 2 passages',
    );
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.intent).toBe('creer_contrat_maintenance');
    // Mutation → confirmation OBLIGATOIRE : rien n'est créé avant le geste.
    expect(r.value.kind).toBe('proposed');
    expect(created).toEqual([]);
    expect(r.value.pending?.tool).toBe('creer_contrat_maintenance');
    // Le montant à MILLIERS est lu entier (1 200 €, jamais 200 € : la troncature silencieuse
    // ferait naître un contrat au sixième de son prix).
    expect(r.value.pending?.args).toMatchObject({
      customerId: 'cus-ratp',
      label: 'Fontaines RATP',
      chantierId: 'site-bastille',
      anniversaryDate: '2026-10-01',
      visitsPerYear: 2,
      lines: [{ label: 'Fontaines RATP', quantity: 1, unitPriceHtCents: 120_000, vatRate: 20 }],
      equipmentIds: ['eq-1', 'eq-2', 'eq-3'],
    });
    // La confirmation RÉCITE ce qui va être créé, et dit que l'activation reste un geste distinct.
    expect(r.value.card.body).toContain('Fontaines RATP');
    expect(r.value.card.body).toContain('RATP');
    expect(r.value.card.body).toContain('Bastille');
    expect(r.value.card.body).toContain('01/10/2026');
    expect(r.value.card.body).toContain('BROUILLON');
    expect(r.value.card.body).toContain('second geste');
  });

  it('le refus HONNÊTE ne recrache jamais un pronom du geste : « fais-MOI le contrat … »', async () => {
    // Phrase canonique §2.7. Ce que Bob RÉCITE au pro est ce qu'il a entendu de significatif ;
    // « moi » vient de « fais-moi », c'est un mot du GESTE, jamais un nom de client. Un refus
    // qui répond « je ne trouve aucun client « moi fontaines ratp » » a l'air de n'avoir rien
    // compris — et le pro cesse de croire les refus suivants.
    const agent = lifecycleAgent({ listBillableCustomers: async () => ok([GIRARD]) });
    const r = await agent.ask(
      'fais-moi le contrat fontaines RATP, 1 200 € par an, à partir du 01/10/2026',
    );
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.intent).toBe('creer_contrat_maintenance');
    expect(r.value.kind).toBe('answer');
    expect(r.value.card.title).toContain('introuvable');
    expect(r.value.card.body).toContain('fontaines ratp');
    expect(r.value.card.body).not.toContain('moi');
  });

  it('AMBIGUÏTÉ client (noms INCLUSIFS « RATP » / « RATP CAP ») → question à followUps par ID, qui CONVERGE au tour suivant', async () => {
    const created: unknown[] = [];
    const agent = lifecycleAgent({
      listBillableCustomers: async () => ok([RATP, RATP_CAP]),
      createMaintenanceContract: async (input) => {
        created.push(input);
        return ok({
          contractId: 'contract-new',
          label: input.label,
          status: 'draft' as const,
          anniversaryDate: input.anniversaryDate,
          terminationEffectiveDate: null,
        });
      },
    });
    const first = await agent.ask(
      'Fais-moi le contrat « Fontaines RATP CAP » pour RATP CAP à 1 200 € par an, à partir du 01/10/2026',
    );
    expect(first.ok).toBe(true);
    if (!first.ok) return;
    // Vraie ambiguïté → QUESTION (jamais un client deviné), options réelles, rien de créé.
    expect(first.value.kind).toBe('answer');
    expect(created).toEqual([]);
    expect(first.value.ask?.[0]?.options.map((option) => option.value).sort()).toEqual(
      ['cus-ratp', 'cus-ratp-cap'].sort(),
    );
    const followUp = first.value.ask?.[0]?.options.find(
      (option) => option.value === 'cus-ratp-cap',
    )?.followUp;
    expect(followUp).toBeDefined();
    // Le followUp porte l'ID ET REDIT tous les faits énoncés : le tour suivant propose direct.
    const second = await agent.ask(followUp!);
    expect(second.ok).toBe(true);
    if (!second.ok) return;
    expect(second.value.kind).toBe('proposed');
    expect(second.value.pending?.args).toMatchObject({
      customerId: 'cus-ratp-cap',
      label: 'Fontaines RATP CAP',
      anniversaryDate: '2026-10-01',
      lines: [{ unitPriceHtCents: 120_000 }],
    });
  });

  it('client PARTICULIER : le refus du domaine (loi Chatel) est dit VERBATIM, rien n’est créé', async () => {
    const created: unknown[] = [];
    const agent = lifecycleAgent({
      createMaintenanceContract: async (input) => {
        created.push(input);
        return ok({
          contractId: 'x',
          label: input.label,
          status: 'draft' as const,
          anniversaryDate: input.anniversaryDate,
          terminationEffectiveDate: null,
        });
      },
    });
    const r = await agent.ask(
      'Crée le contrat « Entretien chaudière » pour Girard à 300 € par an, à partir du 01/10/2026',
    );
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.kind).toBe('answer');
    expect(created).toEqual([]);
    expect(r.value.card.body).toContain(CONTRACT_B2C_REFUSED_MESSAGE);
    expect(r.value.card.body).toContain('Rien n’a été créé');
  });

  it('question ciblée sur le SEUL manque (le montant annuel) — les faits déjà dits ne sont jamais redemandés', async () => {
    const agent = lifecycleAgent();
    const r = await agent.ask('Crée le contrat « Entretien vitrines » pour RATP à partir du 01/10/2026');
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.kind).toBe('answer');
    expect(r.value.card.title).toContain('Combien par an');
    // La relance REDIT le libellé, le client et la date — un seul manque est demandé.
    expect(r.value.card.body).toContain('Entretien vitrines');
    expect(r.value.card.body).toContain('cus-ratp');
    expect(r.value.card.body).toContain('01/10/2026');
  });

  /**
   * CHEMIN DÉTERMINISTE — l'autre moitié de la preuve (le chemin du MODÈLE est verrouillé dans
   * `registry.test.ts`). Quatre revues ont conclu qu'un extracteur d'énoncés libres ne sera jamais
   * exhaustif : « entretien trimestriel » est une cadence pour l'oreille et un NOM pour le métier,
   * et aucune règle ne tranchera cela à coup sûr. La garde ne tranche pas non plus — elle REFUSE
   * de trancher, et rend la main au pro. C'est ce qu'on vérifie ici : le doute devient une
   * QUESTION, jamais une donnée, et jamais une pièce.
   */
  it('GARDE : un libellé DOUTEUX devient une QUESTION — rien n’est créé, aucun fait déjà dit n’est perdu', async () => {
    const created: unknown[] = [];
    const agent = lifecycleAgent({
      createMaintenanceContract: async (input) => {
        created.push(input);
        return ok({
          contractId: 'contract-new',
          label: input.label,
          status: 'draft' as const,
          anniversaryDate: input.anniversaryDate,
          terminationEffectiveDate: null,
        });
      },
    });
    const r = await agent.ask(
      'Crée le contrat entretien trimestriel pour RATP à 1 200 € par an, à partir du 01/10/2026',
    );
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.intent).toBe('creer_contrat_maintenance');
    // Ni mutation, ni proposition : on ne propose pas une pièce dont on doute du nom.
    expect(r.value.kind).toBe('answer');
    expect(created).toEqual([]);
    expect(r.value.card.title).toContain('Quel nom');
    // Bob CITE ce qu'il a entendu et EXPLIQUE pourquoi ce nom ne peut pas nommer le contrat.
    // Il ne parle PLUS de la facture : la ligne de la facture annuelle ne reprend plus le nom
    // (le domaine compose sa désignation), donc le promettre au pro serait lui mentir.
    expect(r.value.card.body).toContain('Entretien trimestriel');
    expect(r.value.card.body).toContain('contrat');
    expect(r.value.card.body).not.toContain('facture');
    expect(r.value.card.body).toContain('Rien n’a été créé');
    // AUCUN FAIT PERDU : la commande canonique redit le client, le montant et la date.
    expect(r.value.card.body).toContain('cus-ratp');
    expect(r.value.card.body).toContain('1200 €');
    expect(r.value.card.body).toContain('01/10/2026');
    // …et le nom douteux n'est JAMAIS pré-rempli dans la phrase à redire : le recopier le
    // ferait revenir GUILLEMETÉ au tour suivant, donc lu comme « nommé par le pro » — Bob
    // blanchirait sa propre erreur en mettant ses mots dans la bouche du pro.
    expect(r.value.card.body).toContain('{nom}');
    expect(r.value.card.body).not.toContain('« Entretien trimestriel » pour le client');
  });

  /**
   * BOUT-EN-BOUT — LES FORMES DE LA SIXIÈME LECTURE. C'est par ce chemin (`BobAgent.ask`) que la
   * revue a PROUVÉ que la garde-liste-noire proposait encore des mutations au libellé pollué :
   * « Entretien vitrines demain », « … toutes les semaines », « … sans reconduction tacite »,
   * « … 30% à la commande », « … Monsieur Dupont », « … au tarif ». Le test rejoue exactement ce
   * chemin, avec une queue polluée derrière un nom métier parfaitement légitime.
   *
   * L'INVARIANT N'EST PAS « Bob pose une question » — les deux issues sont bonnes : soit un
   * lecteur de fait a BORNÉ le libellé (la queue n'entre pas dans le nom, et la mutation peut
   * être proposée), soit la garde REFUSE et Bob demande le nom. L'invariant est qu'AUCUNE
   * proposition ne porte un libellé qui reprend un mot de la queue : ce libellé s'imprimerait
   * sur la LIGNE de la facture annuelle, et la confirmation vocale ne protège de rien puisqu'elle
   * récite au pro sa propre phrase.
   */
  it('GARDE bout-en-bout : aucune queue polluée n’atteint jamais le libellé PROPOSÉ', async () => {
    const queues: readonly string[] = [
      // Repères de temps — « demain » est la façon la plus COURANTE de dire une date.
      'demain', 'après-demain', 'dans 3 mois', 'sous huit jours', 'd’ici la fin du mois',
      'lundi prochain', 'en janvier', 'à la rentrée',
      // Cadences au FÉMININ, que le détecteur d'hier ne connaissait pas.
      'toutes les semaines', 'toutes les deux semaines', 'chaque mois',
      // Clause — le seul fait qui était lu SANS empan.
      'sans reconduction tacite', 'avec reconduction tacite',
      // Sommes, taux, échéanciers, indexation.
      '30% à la commande', 'TVA 20%', 'payable en 4 fois', 'indexé sur l’indice BT01',
      'au tarif de 1 200 € par an', 'à raison d’une visite par mois',
      // Attribution nue — aucune préposition ne précède la civilité.
      'Monsieur Dupont', 'destiné à Monsieur Dupont',
      // Mutilations que la découpe laisse derrière elle.
      'effectif au 1er octobre',
    ];
    /** Jetons de la queue qu'un libellé propre ne peut pas porter (les mots-outils exceptés). */
    const OUTILS = new Set(['a', 'au', 'de', 'du', 'des', 'la', 'le', 'les', 'en', 'et', 'sur', 'd', 'l']);
    const jetons = (said: string): string[] =>
      said
        .normalize('NFD')
        .replace(/\p{Diacritic}/gu, '')
        .toLowerCase()
        .split(/[^\p{L}\p{N}]+/u)
        .filter((token) => token.length > 0 && !OUTILS.has(token));

    const fuites: string[] = [];
    for (const queue of queues) {
      const created: unknown[] = [];
      const agent = lifecycleAgent({
        createMaintenanceContract: async (input) => {
          created.push(input);
          return ok({
            contractId: 'contract-new',
            label: input.label,
            status: 'draft' as const,
            anniversaryDate: input.anniversaryDate,
            terminationEffectiveDate: null,
          });
        },
      });
      const r = await agent.ask(
        `Crée le contrat entretien vitrines ${queue} pour le client cus-ratp à 1200 € par an, à partir du 01/10/2026`,
      );
      expect(r.ok).toBe(true);
      if (!r.ok) return;
      // Rien n'est jamais créé sans confirmation, quelle que soit l'issue.
      expect(created).toEqual([]);
      const label = (r.value.pending?.args as { label?: string } | undefined)?.label ?? null;
      if (label === null) continue;
      const dansLeNom = new Set(jetons(label));
      const reprises = jetons(queue).filter((token) => dansLeNom.has(token));
      if (reprises.length > 0) fuites.push(`• « ${queue} » ⇒ libellé proposé « ${label} »`);
    }
    expect(fuites.join('\n'), `${fuites.length} queue(s) polluée(s) arrivée(s) au libellé`).toBe('');
  });

  it('GARDE : le nom REDIT par le pro est accepté tel quel et CONVERGE (jamais un cul-de-sac)', async () => {
    const agent = lifecycleAgent();
    // Le pro a NOMMÉ le contrat : « trimestriel » est un mot de son métier, pas une cadence lue.
    const r = await agent.ask(
      'Crée le contrat « Entretien trimestriel » pour le client cus-ratp à 1200 € par an, à partir du 01/10/2026',
    );
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.kind).toBe('proposed');
    expect(r.value.pending?.args).toMatchObject({
      customerId: 'cus-ratp',
      label: 'Entretien trimestriel',
      anniversaryDate: '2026-10-01',
    });
  });

  it('GARDE : un montant glissé PAR INADVERTANCE dans la réponse refuse encore, et Bob l’explique', async () => {
    const created: unknown[] = [];
    const agent = lifecycleAgent({
      createMaintenanceContract: async (input) => {
        created.push(input);
        return ok({
          contractId: 'contract-new',
          label: input.label,
          status: 'draft' as const,
          anniversaryDate: input.anniversaryDate,
          terminationEffectiveDate: null,
        });
      },
    });
    const r = await agent.ask(
      'Crée le contrat « Entretien vitrines à 1.200 € » pour le client cus-ratp à 1200 € par an, à partir du 01/10/2026',
    );
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.kind).toBe('answer');
    expect(created).toEqual([]);
    // SECOND refus : Bob ne redit pas « j'ai entendu », il dit ce qui pose problème.
    expect(r.value.card.body).toContain('ne peut pas devenir le nom du contrat');
    expect(r.value.card.body).toContain('montant');
  });

  it('refus du domaine à l’exécution (site clôturé) restitué VERBATIM — jamais un code brut', async () => {
    const agent = lifecycleAgent({
      createMaintenanceContract: async () =>
        err({
          kind: 'domain',
          error: { code: 'VALIDATION', field: 'chantierId', message: 'Ce site est clôturé — rouvre-le pour y rattacher un contrat.' },
        }),
    });
    // Le plancher de sécurité impose la confirmation MÊME en autonomie « auto » : le refus se
    // constate donc au geste confirmé — et il est restitué verbatim, pas en code brut.
    const proposed = await agent.ask(
      'Crée le contrat « Entretien vitrines » pour RATP à 900 € par an, à partir du 01/10/2026',
      { autonomy: 'auto' },
    );
    expect(proposed.ok).toBe(true);
    if (!proposed.ok) return;
    expect(proposed.value.kind).toBe('proposed');
    const r = await agent.confirm(proposed.value.pending!);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.kind).toBe('answer');
    expect(r.value.intent).toBe('creer_contrat_maintenance');
    expect(r.value.card.body).toContain('Ce site est clôturé — rouvre-le');
  });

  it('capacité hôte absente : réponse honnête, jamais une erreur brute', async () => {
    const agent = new BobAgent({
      router: new ModelRouter({ hasClaudeKey: false, hasGlmKey: false }),
      actions: baseActions,
      runtime: { clock: { now: () => NOW }, ids: { newId: () => 'run-contracts' } },
    });
    const r = await agent.ask('Crée le contrat « Entretien vitrines » pour RATP à 900 € par an');
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.card.body).toContain('Rien n’a été créé');
  });
});

describe('activer_contrat / resilier_contrat — gestes DISTINCTS, préavis expliqué jamais bloquant', () => {
  const DRAFT_A = contractOf({
    id: 'contract-fontaines',
    label: 'Entretien fontaines',
    status: 'draft',
    customerName: 'RATP',
    anniversaryDate: '2026-10-12',
    renewalAlert: null,
  });
  const DRAFT_B = contractOf({
    id: 'contract-fontaines-quai',
    label: 'Entretien fontaines quai',
    status: 'draft',
    customerName: 'RATP',
    anniversaryDate: '2026-11-01',
    renewalAlert: null,
  });

  it('« active le contrat » (un seul brouillon) : confirmation qui DIT ce que l’activation fige', async () => {
    const activated: unknown[] = [];
    const agent = lifecycleAgent(
      {
        activateMaintenanceContract: async (input) => {
          activated.push(input);
          return ok({
            contractId: input.contractId,
            label: 'Entretien fontaines',
            status: 'active' as const,
            anniversaryDate: '2026-10-12',
            terminationEffectiveDate: null,
          });
        },
      },
      [DRAFT_A, BASTILLE_DUE],
    );
    const r = await agent.ask('Active le contrat');
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.intent).toBe('activer_contrat');
    expect(r.value.kind).toBe('proposed');
    expect(activated).toEqual([]);
    expect(r.value.pending?.args).toEqual({ contractId: 'contract-fontaines' });
    expect(r.value.card.body).toContain('12/10/2026');
    expect(r.value.card.body).toContain('figée');
  });

  it('AMBIGUÏTÉ (deux brouillons aux noms INCLUSIFS) → question à followUps par ID, qui CONVERGE', async () => {
    const agent = lifecycleAgent({}, [DRAFT_A, DRAFT_B]);
    const first = await agent.ask('Active le contrat fontaines');
    expect(first.ok).toBe(true);
    if (!first.ok) return;
    expect(first.value.kind).toBe('answer');
    expect(first.value.ask?.[0]?.options.map((option) => option.value).sort()).toEqual(
      ['contract-fontaines', 'contract-fontaines-quai'].sort(),
    );
    const followUp = first.value.ask?.[0]?.options.find(
      (option) => option.value === 'contract-fontaines-quai',
    )?.followUp;
    expect(followUp).toBeDefined();
    const second = await agent.ask(followUp!);
    expect(second.ok).toBe(true);
    if (!second.ok) return;
    expect(second.value.kind).toBe('proposed');
    expect(second.value.pending?.args).toEqual({ contractId: 'contract-fontaines-quai' });
  });

  /**
   * TRACE LÉGALE — la phrase CANONIQUE §2.7 dit QUAND, jamais POURQUOI. Le domaine exige un
   * motif : Bob le DEMANDE (chemin 1) plutôt que d'inscrire l'ordre reçu en motivation de la
   * rupture, puis mute une fois le motif énoncé (chemin 2). Les deux chemins sont testés.
   */
  it('chemin 1 — « Le client résilie au 1er juin » : la date est LUE, le motif est DEMANDÉ, rien n’est muté', async () => {
    const terminated: unknown[] = [];
    const agent = lifecycleAgent(
      {
        terminateMaintenanceContract: async (input) => {
          terminated.push(input);
          return ok({
            contractId: input.contractId,
            label: 'Entretien fontaines Bastille',
            status: 'terminated' as const,
            anniversaryDate: '2025-10-12',
            terminationEffectiveDate: '2027-06-01',
          });
        },
      },
      [BASTILLE_DUE],
    );
    const r = await agent.ask('Le client résilie au 1er juin');
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.intent).toBe('resilier_contrat');
    // Ni mutation, ni confirmation : une question ciblée sur le SEUL manque.
    expect(r.value.kind).toBe('answer');
    expect(r.value.pending).toBeUndefined();
    expect(terminated).toEqual([]);
    expect(r.value.card.title).toContain('Pourquoi cette résiliation');
    expect(r.value.card.body).toContain('Rien n’a été modifié');
    // Le contrat est déjà RÉSOLU et la date déjà LUE — aucun fait énoncé n'est redemandé : la
    // redite proposée les reporte tous, seul le motif reste à dire.
    expect(r.value.card.body).toContain('Entretien fontaines Bastille');
    expect(r.value.card.body).toContain('Résilie le contrat contract-bastille au 01/06/2027');
    expect(r.value.card.body).toContain('motif');
  });

  it('chemin 2 — le motif énoncé fait la trace : date lue conservée, préavis DIT, mutation proposée', async () => {
    const terminated: unknown[] = [];
    const agent = lifecycleAgent(
      {
        terminateMaintenanceContract: async (input) => {
          terminated.push(input);
          return ok({
            contractId: input.contractId,
            label: 'Entretien fontaines Bastille',
            status: 'terminated' as const,
            anniversaryDate: '2025-10-12',
            terminationEffectiveDate: '2027-06-01',
          });
        },
      },
      [BASTILLE_DUE],
    );
    const r = await agent.ask(
      'Résilie le contrat contract-bastille au 01/06/2027 — motif : le client déménage',
    );
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.intent).toBe('resilier_contrat');
    expect(r.value.kind).toBe('proposed');
    expect(terminated).toEqual([]);
    expect(r.value.pending?.args).toEqual({
      contractId: 'contract-bastille',
      note: 'le client déménage',
      effectiveDate: '2027-06-01',
    });
    // La trace est le MOTIF énoncé, jamais la phrase de commande.
    expect((r.value.pending?.args as { note: string }).note).not.toContain('Résilie');
    // Préavis AFFICHÉ, jamais bloquant (pédagogie légale au point de décision).
    expect(r.value.card.body).toContain('Préavis contractuel : 30 jours');
    expect(r.value.card.body).toContain('jamais bloquant');
    expect(r.value.card.body).toContain('01/06/2027');
  });

  it('sans date dite : la date d’effet reste celle que le DOMAINE calcule, et elle est RÉCITÉE après le geste', async () => {
    const terminated: { effectiveDate?: string | null }[] = [];
    const agent = lifecycleAgent(
      {
        terminateMaintenanceContract: async (input) => {
          terminated.push(input);
          return ok({
            contractId: input.contractId,
            label: 'Entretien fontaines Bastille',
            status: 'terminated' as const,
            anniversaryDate: '2025-10-12',
            terminationEffectiveDate: '2027-06-01',
          });
        },
      },
      [BASTILLE_DUE],
    );
    const proposed = await agent.ask('Résilie le contrat Bastille — motif : le client déménage');
    expect(proposed.ok).toBe(true);
    if (!proposed.ok) return;
    expect(proposed.value.kind).toBe('proposed');
    // Aucune date dite ⇒ aucune date envoyée : le domaine calcule le prochain anniversaire.
    expect(proposed.value.pending?.args).toEqual({
      contractId: 'contract-bastille',
      note: 'le client déménage',
    });
    expect(proposed.value.card.body).toContain('prochaine échéance');
    const r = await agent.confirm(proposed.value.pending!);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.kind).toBe('done');
    expect(terminated).toEqual([{ contractId: 'contract-bastille', note: 'le client déménage' }]);
  });

  it('aucun contrat actif : refus honnête, rien n’est modifié', async () => {
    const agent = lifecycleAgent({}, [DRAFT_A]);
    const r = await agent.ask('Résilie le contrat');
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.kind).toBe('answer');
    expect(r.value.card.body).toContain('Rien n’a été modifié');
  });
});
