import { describe, it, expect } from 'vitest';
import { ok } from '@bob/core';
import { BobAgent } from './bob-agent';
import { ModelRouter } from '../router/model-router';
import {
  type AgentContract,
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
