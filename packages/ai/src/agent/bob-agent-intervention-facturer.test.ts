import { describe, it, expect } from 'vitest';
import { ok } from '@bob/core';
import { BobAgent } from './bob-agent';
import { ModelRouter } from '../router/model-router';
import {
  type AgentIntervention,
  type BobActions,
  type CompleteInterventionActionInput,
  type InterventionActionInput,
} from './actions';
import { detectIntent } from './intent';

/**
 * [Vérification finale 29/07 — L'IMPASSE §8 SUR LA BRANCHE JUMELLE « FACTURER »]
 *
 * Le finding 5 a fermé l'impasse pour « j'ai fini …, et ENVOIE la fiche » en subordonnant
 * `envoyer_fiche_passage` à l'absence d'annonce de fin. `facturer_intervention` est déclaré
 * JUSTE APRÈS, lui aussi AVANT `terminer_intervention`, et n'avait PAS reçu la garde : toute
 * consigne composite « c'est terminé, facture ce passage » partait à la FACTURATION d'un
 * passage encore `in_progress` — donc hors périmètre — et Bob répondait « Aucun passage
 * concerné », une affirmation FAUSSE qui oriente l'artisan à l'opposé du geste manquant.
 * Le passage restait `in_progress` POUR TOUJOURS, et le résumé dicté dans le même geste était
 * PERDU.
 *
 * Ce fichier est la contre-preuve : la complétion doit primer, comme pour l'envoi, et Bob doit
 * ANNONCER le brouillon sans jamais le fusionner (la facturation garde SA propre confirmation).
 */

const NOW = '2026-08-04T10:00:00.000Z';

/** Un SEUL passage en cours : aucune ambiguïté ne peut expliquer un échec. */
const EN_COURS: AgentIntervention[] = [
  {
    id: 'itv-ratp-encours',
    kind: 'Visite d’entretien',
    status: 'in_progress',
    chantierId: 'site-bastille',
    chantierNom: 'RATP Bastille',
    customerNom: 'RATP CAP',
    plannedAt: '2026-08-04T08:00:00.000Z',
    contractId: null,
    reportDocumentId: null,
    billedInvoiceId: null,
    billedInvoiceStatus: null,
    revision: 2,
  },
];

/** Passage DÉJÀ terminé : c'est lui, et lui seul, qui se facture. */
const TERMINE: AgentIntervention = {
  id: 'itv-docks-terminee',
  kind: 'Détartrage',
  status: 'completed',
  chantierId: 'site-docks',
  chantierNom: 'Docks Rouen',
  customerNom: 'Docks SAS',
  plannedAt: '2026-08-03T08:00:00.000Z',
  contractId: null,
  reportDocumentId: null,
  billedInvoiceId: null,
  billedInvoiceStatus: null,
  revision: 3,
};

interface Journal {
  readonly completed: CompleteInterventionActionInput[];
  readonly billed: InterventionActionInput[];
  readonly agent: BobAgent;
  etat(): AgentIntervention[];
}

function makeJournal(depart: AgentIntervention[] = EN_COURS): Journal {
  const completed: CompleteInterventionActionInput[] = [];
  const billed: InterventionActionInput[] = [];
  let etat = depart;
  const actions: BobActions = {
    computePayout: async () => ok({ payoutCents: 0, availableCents: 0 }),
    draftRelance: async () => ok({ subject: 'x', body: 'x' }),
    listPayableInvoices: async () => ok([]),
    listSendableQuotes: async () => ok([]),
    listIssuableInvoices: async () => ok([]),
    listDocuments: async () => ok([]),
    registerPayment: async () => ok({ status: 'paid' }),
    sendQuote: async () => ok({ number: 'D2026-001' }),
    issueInvoice: async () => ok({ number: 'F2026-001' }),
    listInterventions: async () => ok(etat),
    completeIntervention: async (input) => {
      completed.push(input);
      etat = etat.map((intervention) =>
        intervention.id === input.interventionId
          ? { ...intervention, status: 'completed' as const, revision: intervention.revision + 1 }
          : intervention,
      );
      return ok({
        interventionId: input.interventionId,
        status: 'completed',
        kind: 'Visite d’entretien',
        chantierNom: 'RATP Bastille',
      });
    },
    prepareInterventionInvoice: async (input) => {
      billed.push(input);
      return ok({ interventionId: input.interventionId, invoiceId: 'inv-1', totalTtcCents: 24000 });
    },
  };
  return {
    completed,
    billed,
    agent: new BobAgent({
      router: new ModelRouter({ hasClaudeKey: false, hasGlmKey: false }),
      actions,
      runtime: { clock: { now: () => NOW }, ids: { newId: () => 'run-facturer' } },
    }),
    etat: () => etat,
  };
}

/** Les SIX formes relevées par la revue : toutes annoncent la fin ET demandent la facture. */
const CONSIGNES_COMPOSITES = [
  'C’est terminé, facture ce passage',
  'J’ai fini chez RATP, facture cette intervention',
  'On a fini, envoie le compte rendu et facture ce passage',
  'Le passage est terminé, facture ce passage',
  'C’est fini, facture cette visite',
  'J’ai fini, note-le : joint refait, et facture ce passage',
] as const;

describe('IMPASSE §8, branche « facturer » — la complétion prime, comme pour l’envoi', () => {
  it('les SIX formes composites routent vers la COMPLÉTION (jamais vers un brouillon impossible)', () => {
    const routes = CONSIGNES_COMPOSITES.map((c) => `${detectIntent(c)} ← « ${c} »`);
    expect(routes.join('\n')).toBe(
      CONSIGNES_COMPOSITES.map((c) => `terminer_intervention ← « ${c} »`).join('\n'),
    );
  });

  it('les formes ADJECTIVALES restent une facturation (la garde ne vole pas le geste)', () => {
    // « terminé hier » DÉCRIT le passage, il n'annonce aucune fin — exactement comme
    // « envoie la fiche du passage terminé hier » reste un envoi (finding 5).
    expect(detectIntent('Facture le passage terminé hier chez RATP')).toBe('facturer_intervention');
    expect(detectIntent('Facture cette intervention terminée la semaine dernière')).toBe(
      'facturer_intervention',
    );
    expect(detectIntent('Facture cette intervention')).toBe('facturer_intervention');
    // Une facture SANS passage démonstratif reste une facture directe (B1).
    expect(detectIntent('Facture 380 € à Mme Girard')).toBe('facture_directe');
  });

  it('BOUT EN BOUT : « c’est terminé, facture ce passage » ne finit JAMAIS en impasse', async () => {
    const journal = makeJournal();
    const r = await journal.agent.ask('C’est terminé, facture ce passage');
    expect(r.ok).toBe(true);
    if (!r.ok) return;

    // La MUTATION de complétion est proposée d'abord : sinon le passage reste `in_progress`
    // POUR TOUJOURS et rien n'aboutit — l'impasse §8, à l'identique.
    expect(r.value.kind).toBe('proposed');
    expect(r.value.pending?.tool).toBe('terminer_intervention');
    expect(r.value.card?.title).not.toBe('Aucun passage concerné');
    // Bob ANNONCE le brouillon sans le fusionner : la facturation garde SA confirmation.
    expect(r.value.card?.body).toContain('brouillon');
    expect(journal.billed).toHaveLength(0);

    const confirme = await journal.agent.confirm(r.value.pending!);
    expect(confirme.ok).toBe(true);
    expect(journal.completed.map((c) => c.interventionId)).toEqual(['itv-ratp-encours']);
    expect(journal.etat()[0]!.status).toBe('completed');
    // Rien n'est facturé dans le même geste.
    expect(journal.billed).toHaveLength(0);

    // Le brouillon annoncé aboutit ENSUITE, sur son propre geste : l'impasse n'existe plus.
    const brouillon = await journal.agent.ask('Facture ce passage de RATP Bastille');
    expect(brouillon.ok).toBe(true);
    if (!brouillon.ok) return;
    expect(brouillon.value.kind).toBe('proposed');
    expect(brouillon.value.pending?.tool).toBe('facturer_intervention');
    const pret = await journal.agent.confirm(brouillon.value.pending!);
    expect(pret.ok).toBe(true);
    expect(journal.billed).toEqual([{ interventionId: 'itv-ratp-encours' }]);
  });

  it('le résumé dicté dans le MÊME geste n’est plus PERDU', async () => {
    const journal = makeJournal();
    const r = await journal.agent.ask('J’ai fini, note-le : joint refait, et facture ce passage');
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.pending?.tool).toBe('terminer_intervention');
    expect(r.value.pending?.args).toMatchObject({
      interventionId: 'itv-ratp-encours',
      summary: 'joint refait',
    });
    const confirme = await journal.agent.confirm(r.value.pending!);
    expect(confirme.ok).toBe(true);
    expect(journal.completed).toEqual([
      { interventionId: 'itv-ratp-encours', summary: 'joint refait' },
    ]);
  });

  it('une facturation SEULE reste une facturation (aucun sur-refus sur un passage terminé)', async () => {
    const journal = makeJournal([TERMINE]);
    const r = await journal.agent.ask('Facture ce passage des Docks Rouen');
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.kind).toBe('proposed');
    expect(r.value.pending?.tool).toBe('facturer_intervention');
    expect(r.value.card?.body).toContain('BROUILLON');
    const confirme = await journal.agent.confirm(r.value.pending!);
    expect(confirme.ok).toBe(true);
    expect(journal.billed).toEqual([{ interventionId: 'itv-docks-terminee' }]);
    expect(journal.completed).toHaveLength(0);
  });
});
