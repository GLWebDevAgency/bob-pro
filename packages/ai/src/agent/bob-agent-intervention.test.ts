import { describe, it, expect } from 'vitest';
import { ok, err } from '@bob/core';
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
 * PR-15c/PR-16 — PARITÉ VOCALE §3.7 de la fiche de passage : « démarre l'intervention chez
 * Carrefour », « c'est terminé, fais signer », « envoie la fiche de passage », « facture cette
 * intervention » passent par les MÊMES use cases que l'écran. Tests d'AMBIGUÏTÉ obligatoires
 * (les followUps portent l'id et CONVERGENT au tour suivant — jamais de boucle), confirmations
 * à toutes les mutations, sortant JAMAIS fusionné, enchaînement composite.
 */

const NOW = '2026-08-04T10:00:00.000Z';

const INTERVENTIONS: AgentIntervention[] = [
  {
    id: 'itv-carrefour-1',
    kind: 'Visite d’entretien',
    status: 'scheduled',
    chantierId: 'site-carrefour',
    chantierNom: 'Carrefour',
    customerNom: 'Carrefour SA',
    plannedAt: '2026-08-04T07:00:00.000Z',
    contractId: null,
    reportDocumentId: null,
    billedInvoiceId: null,
    billedInvoiceStatus: null,
    revision: 1,
  },
  {
    id: 'itv-carrefour-2',
    kind: 'Dépannage fontaine',
    status: 'scheduled',
    chantierId: 'site-carrefour',
    chantierNom: 'Carrefour',
    customerNom: 'Carrefour SA',
    plannedAt: '2026-08-04T13:00:00.000Z',
    contractId: null,
    reportDocumentId: null,
    billedInvoiceId: null,
    billedInvoiceStatus: null,
    revision: 1,
  },
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
  {
    id: 'itv-ratp-terminee',
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
  },
  {
    id: 'itv-contrat',
    kind: 'Visite contractuelle',
    status: 'signed',
    chantierId: 'site-contrat',
    chantierNom: 'Tour Montparnasse',
    customerNom: 'Gestion Tour',
    plannedAt: '2026-08-02T08:00:00.000Z',
    // SEUL discriminant d'une visite contractuelle (direction 6) — jamais `kind`.
    contractId: 'contract-1',
    reportDocumentId: 'doc-1',
    billedInvoiceId: null,
    billedInvoiceStatus: null,
    revision: 4,
  },
];

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
  listInterventions: async () => ok(INTERVENTIONS),
};

const makeAgent = (over: Partial<BobActions> = {}): BobAgent =>
  new BobAgent({
    router: new ModelRouter({ hasClaudeKey: false, hasGlmKey: false }),
    actions: { ...baseActions, ...over },
    runtime: { clock: { now: () => NOW }, ids: { newId: () => 'run-intervention' } },
  });

describe('intents §3.7 — les quatre phrases normatives sont reconnues sans voler les autres', () => {
  it('reconnaît les gestes de la fiche', () => {
    expect(detectIntent('Démarre l’intervention chez Carrefour')).toBe('commencer_intervention');
    // Consigne COMPOSITE : on termine d'abord (la signature exige `completed`), Bob annonce
    // la suite sans la fusionner — le geste de signature reste le sien.
    expect(detectIntent('C’est terminé, fais signer')).toBe('terminer_intervention');
    expect(detectIntent('Fais signer le client')).toBe('faire_signer_intervention');
    expect(detectIntent('Envoie la fiche de passage')).toBe('envoyer_fiche_passage');
    expect(detectIntent('Facture cette intervention')).toBe('facturer_intervention');
  });

  it('ne vole ni l’envoi de facture, ni la facture directe, ni la clôture', () => {
    expect(detectIntent('Envoie la facture 2026-014')).not.toBe('envoyer_fiche_passage');
    expect(detectIntent('Facture 380 € TTC à Mme Girard pour le dépannage')).not.toBe(
      'facturer_intervention',
    );
    expect(detectIntent('C’est prêt à signer ?')).not.toBe('faire_signer_intervention');
    expect(detectIntent('Prépare la clôture du mois')).not.toBe('terminer_intervention');
  });

  it('la négation n’enclenche jamais un geste', () => {
    expect(detectIntent('N’envoie pas la fiche de passage')).not.toBe('envoyer_fiche_passage');
    expect(detectIntent('Ne démarre pas l’intervention')).not.toBe('commencer_intervention');
  });
});

describe('commencer_intervention — « démarre l’intervention chez Carrefour »', () => {
  it('AMBIGUÏTÉ : deux passages planifiés sur le site → question ciblée, followUps par ID, RIEN ne bouge', async () => {
    const started: InterventionActionInput[] = [];
    const agent = makeAgent({
      startIntervention: async (input) => {
        started.push(input);
        return ok({ interventionId: input.interventionId, status: 'in_progress', kind: 'x', chantierNom: 'y' });
      },
    });
    const r = await agent.ask('Démarre l’intervention chez Carrefour');
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.kind).toBe('answer');
    expect(r.value.card?.title).toBe('Quel passage ?');
    expect(started).toHaveLength(0);
    const followUps = r.value.ask?.[0]?.options.map((option) => option.followUp) ?? [];
    expect(followUps).toContain("Démarre l'intervention itv-carrefour-1");
    expect(followUps).toContain("Démarre l'intervention itv-carrefour-2");
  });

  it('CONVERGENCE : le followUp par ID résout au tour suivant et PROPOSE (mutation confirmée)', async () => {
    const started: InterventionActionInput[] = [];
    const agent = makeAgent({
      startIntervention: async (input) => {
        started.push(input);
        return ok({
          interventionId: input.interventionId,
          status: 'in_progress',
          kind: 'Visite d’entretien',
          chantierNom: 'Carrefour',
        });
      },
    });
    const r = await agent.ask("Démarre l'intervention itv-carrefour-1");
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.kind).toBe('proposed');
    expect(r.value.pending?.tool).toBe('commencer_intervention');
    expect(r.value.pending?.args).toMatchObject({ interventionId: 'itv-carrefour-1' });
    // Aucune mutation avant confirmation.
    expect(started).toHaveLength(0);

    const confirmed = await agent.confirm(r.value.pending!);
    expect(confirmed.ok).toBe(true);
    expect(started).toEqual([{ interventionId: 'itv-carrefour-1' }]);
  });

  it('un passage déjà en cours n’est jamais re-démarré : l’état RÉEL décide', async () => {
    const agent = makeAgent({
      startIntervention: async (input) =>
        ok({ interventionId: input.interventionId, status: 'in_progress', kind: 'x', chantierNom: 'y' }),
    });
    const r = await agent.ask('Démarre l’intervention chez RATP Bastille');
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    // Aucune fiche `scheduled` sur ce site → refus honnête, jamais un geste inventé. Le passage
    // EXISTE : Bob dit son état RÉEL et le chemin réel, jamais « aucun passage concerné ».
    expect(r.value.kind).toBe('answer');
    expect(r.value.card?.title).toBe('Rien à faire sur ce passage');
    expect(r.value.card?.body).toContain('déjà en cours');
    expect(r.value.card?.body).toContain('c’est terminé');
  });
});

describe('terminer_intervention — « c’est terminé » + résumé dicté dans le MÊME geste', () => {
  it('résout le seul passage en cours, extrait le résumé, UNE confirmation groupée', async () => {
    const completed: CompleteInterventionActionInput[] = [];
    const agent = makeAgent({
      completeIntervention: async (input) => {
        completed.push(input);
        return ok({
          interventionId: input.interventionId,
          status: 'completed',
          kind: 'Visite d’entretien',
          chantierNom: 'RATP Bastille',
        });
      },
    });
    const r = await agent.ask(
      'C’est terminé chez RATP, la pression était basse mais c’est réglé, note-le : détartrage complet fait',
    );
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.kind).toBe('proposed');
    expect(r.value.pending?.args).toMatchObject({ interventionId: 'itv-ratp-encours' });
    expect((r.value.pending?.args as { summary?: string }).summary).toContain('détartrage complet');
    expect(completed).toHaveLength(0);

    const confirmed = await agent.confirm(r.value.pending!);
    expect(confirmed.ok).toBe(true);
    expect(completed[0]).toMatchObject({ interventionId: 'itv-ratp-encours' });
  });
});

describe('faire_signer_intervention — le tracé ne se DICTE jamais', () => {
  it('ouvre le pad de signature (micro suspendu) et dit la valeur probante', async () => {
    const agent = makeAgent();
    const r = await agent.ask('Fais signer le client');
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.kind).toBe('answer');
    expect(r.value.navigate).toContain('itv-ratp-terminee');
    expect(r.value.card?.body).toContain('elle ne se dicte pas');
    expect(r.value.card?.body).toContain('eIDAS');
  });
});

describe('envoyer_fiche_passage — SORTANT : sa confirmation est TOUJOURS la sienne', () => {
  it('propose l’envoi, ne part qu’après confirmation, cite le destinataire réel', async () => {
    const sent: InterventionActionInput[] = [];
    const agent = makeAgent({
      sendInterventionReport: async (input) => {
        sent.push(input);
        return ok({
          interventionId: input.interventionId,
          recipient: 'contact@docks.example',
          deliveryStatus: 'queued',
        });
      },
    });
    const r = await agent.ask('Envoie la fiche de passage des Docks Rouen');
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.kind).toBe('proposed');
    expect(r.value.card?.title).toBe('Envoi à confirmer');
    expect(r.value.card?.body).toContain('RIEN n’est parti');
    expect(sent).toHaveLength(0);

    const confirmed = await agent.confirm(r.value.pending!);
    expect(confirmed.ok).toBe(true);
    if (!confirmed.ok) return;
    // L'envoi n'a lieu QU'APRÈS la confirmation, et par le MÊME use case que le bouton.
    expect(sent).toEqual([{ interventionId: 'itv-ratp-terminee' }]);
    expect(confirmed.value.card?.body).toContain('Envoyer la fiche de passage');
  });

  it('refus du domaine restitué VERBATIM (fiche non générée) — rien n’est parti', async () => {
    const agent = makeAgent({
      sendInterventionReport: async () =>
        err({
          kind: 'validation',
          issues: [
            {
              field: 'reportDocumentId',
              message: 'La fiche de passage n’est pas encore générée : génère l’aperçu, puis envoie.',
            },
          ],
        }),
    });
    const proposed = await agent.ask('Envoie la fiche de passage des Docks Rouen');
    expect(proposed.ok).toBe(true);
    if (!proposed.ok) return;
    const confirmed = await agent.confirm(proposed.value.pending!);
    // Le refus REMONTE (jamais avalé, jamais un faux succès) et cite le chemin actionnable.
    expect(confirmed.ok).toBe(false);
    if (confirmed.ok) return;
    expect(JSON.stringify(confirmed.error)).toContain('pas encore générée');
  });
});

describe('facturer_intervention — brouillon pré-rempli, jamais une émission', () => {
  it('propose le BROUILLON et le dit clairement (rien n’est émis, rien n’est envoyé)', async () => {
    const drafted: InterventionActionInput[] = [];
    const agent = makeAgent({
      prepareInterventionInvoice: async (input) => {
        drafted.push(input);
        return ok({ interventionId: input.interventionId, invoiceId: 'inv-1', totalTtcCents: 24000 });
      },
    });
    const r = await agent.ask('Facture cette intervention des Docks Rouen');
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.kind).toBe('proposed');
    expect(r.value.card?.body).toContain('BROUILLON');
    expect(drafted).toHaveLength(0);
    const confirmed = await agent.confirm(r.value.pending!);
    expect(confirmed.ok).toBe(true);
    if (!confirmed.ok) return;
    expect(drafted).toEqual([{ interventionId: 'itv-ratp-terminee' }]);
    expect(confirmed.value.card?.body).toContain('brouillon de facture');
  });

  it('facture ANNULÉE (avoir) : le geste se RALLUME à la voix comme au doigt (parité)', async () => {
    const drafted: InterventionActionInput[] = [];
    const agent = makeAgent({
      listInterventions: async () =>
        ok(
          INTERVENTIONS.map((intervention) =>
            intervention.id === 'itv-ratp-terminee'
              ? { ...intervention, billedInvoiceId: 'inv-annulee', billedInvoiceStatus: 'cancelled' }
              : intervention,
          ),
        ),
      prepareInterventionInvoice: async (input) => {
        drafted.push(input);
        return ok({ interventionId: input.interventionId, invoiceId: 'inv-2', totalTtcCents: 24000 });
      },
    });
    const r = await agent.ask('Facture cette intervention des Docks Rouen');
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    // Jamais « Aucun passage à facturer » : l'extinction se fait par l'état RÉEL de la pièce.
    expect(r.value.kind).toBe('proposed');
    expect(r.value.card?.body).not.toContain('Aucun passage');
    const confirmed = await agent.confirm(r.value.pending!);
    expect(confirmed.ok).toBe(true);
    expect(drafted).toEqual([{ interventionId: 'itv-ratp-terminee' }]);
  });

  it('facture VIVANTE : le passage reste hors périmètre (aucune double facturation)', async () => {
    const agent = makeAgent({
      listInterventions: async () =>
        ok(
          INTERVENTIONS.map((intervention) =>
            intervention.id === 'itv-ratp-terminee'
              ? { ...intervention, billedInvoiceId: 'inv-vivante', billedInvoiceStatus: 'draft' }
              : intervention,
          ),
        ),
      prepareInterventionInvoice: async (input) =>
        ok({ interventionId: input.interventionId, invoiceId: 'x', totalTtcCents: 0 }),
    });
    const r = await agent.ask('Facture cette intervention des Docks Rouen');
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.kind).toBe('answer');
    // Le passage EXISTE : Bob dit POURQUOI il ne le facture pas (pièce vivante), jamais une
    // absence inventée qui orienterait l'artisan à l'opposé du fait réel.
    expect(r.value.card?.title).toBe('Rien à faire sur ce passage');
    expect(r.value.card?.body).toContain('déjà couvert par une facture');
  });

  it('une VISITE CONTRACTUELLE ne se facture jamais à part (discriminant contractId)', async () => {
    const agent = makeAgent({
      listInterventions: async () => ok(INTERVENTIONS.filter((i) => i.contractId !== null)),
      prepareInterventionInvoice: async (input) =>
        ok({ interventionId: input.interventionId, invoiceId: 'x', totalTtcCents: 0 }),
    });
    const r = await agent.ask('Facture cette intervention de la Tour Montparnasse');
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.kind).toBe('answer');
    expect(r.value.card?.body).toContain('facture annuelle du contrat');
  });
});

describe('ENCHAÎNEMENT COMPOSITE §3.7 — « j’ai fini chez RATP… envoie la fiche »', () => {
  it('termine (confirmation groupée) PUIS envoie (confirmation PROPRE) — jamais fusionnées', async () => {
    const completed: CompleteInterventionActionInput[] = [];
    const sent: InterventionActionInput[] = [];
    let etat: AgentIntervention[] = INTERVENTIONS;
    const agent = makeAgent({
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
      sendInterventionReport: async (input) => {
        sent.push(input);
        return ok({
          interventionId: input.interventionId,
          recipient: 'compta@ratp.example',
          deliveryStatus: 'queued',
        });
      },
    });

    // 1. Le passage se termine — mutation LOCALE du flux, une seule confirmation.
    const fin = await agent.ask('J’ai fini chez RATP Bastille, note-le : détartrage complet');
    expect(fin.ok).toBe(true);
    if (!fin.ok) return;
    expect(fin.value.kind).toBe('proposed');
    await agent.confirm(fin.value.pending!);
    expect(completed).toHaveLength(1);
    // Rien n'est parti dans le même geste : le sortant n'est JAMAIS fusionné.
    expect(sent).toHaveLength(0);

    // 2. L'envoi est un geste SÉPARÉ, avec SA confirmation.
    const envoi = await agent.ask('Envoie la fiche de passage de RATP Bastille');
    expect(envoi.ok).toBe(true);
    if (!envoi.ok) return;
    expect(envoi.value.kind).toBe('proposed');
    expect(sent).toHaveLength(0);
    const confirme = await agent.confirm(envoi.value.pending!);
    expect(confirme.ok).toBe(true);
    expect(sent).toEqual([{ interventionId: 'itv-ratp-encours' }]);
  });

  /**
   * [Revue adversariale 28/07 — finding 5] `envoyer_fiche_passage` était testé AVANT
   * `terminer_intervention` : toute consigne portant « fini/terminé » ET « envoie … fiche »
   * partait à l'ENVOI — or la fiche n'est ni terminée ni générée, l'envoi ne peut pas aboutir,
   * et la complétion n'avait JAMAIS lieu. Le scénario de sortie de vague §8 finissait donc en
   * impasse : le passage restait `in_progress`, rien n'était écrit, rien n'était envoyé.
   *
   * [finding 4] La même consigne prouve que le résumé écrit sur la pièce de preuve ne contient
   * PAS la consigne suivante.
   */
  it('§8 BOUT EN BOUT : « j’ai fini … note-le … et envoie la fiche » termine PUIS envoie (jamais l’impasse)', async () => {
    const completed: CompleteInterventionActionInput[] = [];
    const sent: InterventionActionInput[] = [];
    let etat: AgentIntervention[] = INTERVENTIONS;
    const agent = makeAgent({
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
      sendInterventionReport: async (input) => {
        sent.push(input);
        return ok({
          interventionId: input.interventionId,
          recipient: 'compta@ratp.example',
          deliveryStatus: 'queued',
        });
      },
    });

    const consigne =
      'J’ai fini chez RATP Bastille, note-le : détartrage complet, plus aucun dépôt, et envoie la fiche au client';

    // 1. La MUTATION passe d'abord : une consigne composite ne part jamais à l'envoi d'une
    //    fiche qui n'existe pas encore.
    expect(detectIntent(consigne)).toBe('terminer_intervention');
    const fin = await agent.ask(consigne);
    expect(fin.ok).toBe(true);
    if (!fin.ok) return;
    expect(fin.value.kind).toBe('proposed');
    expect(fin.value.pending?.tool).toBe('terminer_intervention');
    expect(fin.value.pending?.args).toMatchObject({ interventionId: 'itv-ratp-encours' });

    // [finding 4] Le résumé est le SEGMENT UTILE : ni la consigne suivante, ni le site.
    const summary = (fin.value.pending?.args as { summary?: string }).summary;
    expect(summary).toBe('détartrage complet, plus aucun dépôt');

    // Bob ANNONCE l'envoi sans le fusionner : le sortant garde SA confirmation.
    expect(fin.value.card?.body).toContain('fiche');
    expect(sent).toHaveLength(0);

    const confirme = await agent.confirm(fin.value.pending!);
    expect(confirme.ok).toBe(true);
    expect(completed).toEqual([
      { interventionId: 'itv-ratp-encours', summary: 'détartrage complet, plus aucun dépôt' },
    ]);
    // Rien n'est parti dans le même geste.
    expect(sent).toHaveLength(0);

    // 2. L'envoi annoncé aboutit — la fiche est terminée, l'impasse n'existe plus.
    const envoi = await agent.ask('Envoie la fiche de passage de RATP Bastille');
    expect(envoi.ok).toBe(true);
    if (!envoi.ok) return;
    expect(envoi.value.kind).toBe('proposed');
    const parti = await agent.confirm(envoi.value.pending!);
    expect(parti.ok).toBe(true);
    expect(sent).toEqual([{ interventionId: 'itv-ratp-encours' }]);
  });

  it('un envoi SEUL reste un envoi (la discrimination ne vole pas le geste sortant)', () => {
    expect(detectIntent('Envoie la fiche de passage des Docks Rouen')).toBe('envoyer_fiche_passage');
    // « du passage terminé » DÉCRIT la fiche, il ne demande pas de terminer quoi que ce soit.
    expect(detectIntent('Envoie la fiche du passage terminé hier chez RATP')).toBe(
      'envoyer_fiche_passage',
    );
  });

  it('hôte sans capacité fiche : Bob le DIT, rien n’est modifié (jamais un échec muet)', async () => {
    // Capacité ABSENTE (clé retirée, jamais `undefined` explicite — exactOptionalPropertyTypes).
    const { listInterventions: _absente, ...sansFiches } = baseActions;
    const agent = new BobAgent({
      router: new ModelRouter({ hasClaudeKey: false, hasGlmKey: false }),
      actions: sansFiches,
      runtime: { clock: { now: () => NOW }, ids: { newId: () => 'run-x' } },
    });
    const r = await agent.ask('Démarre l’intervention chez Carrefour');
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.card?.title).toBe('Fiche de passage indisponible');
  });
});

/**
 * [Revue de vérification 29/07 — RIEN N'EST JETÉ EN SILENCE]
 *
 * Trois trous mesurés au même endroit : la moitié aval d'une consigne disparaissait sans un mot
 * (finding 4), « j'ai fini le boulot, prépare la facture » ne facturait rien sur un passage
 * pourtant facturable et donnait la MAUVAISE raison sur un passage déjà facturé (cases
 * E4/E5/E6 × C12), et l'intent restitué changeait selon qu'une cible s'était résolue ou non
 * (finding 7). Ces tests mesurent la carte RENDUE, pas seulement le classement.
 */
describe('§3.7 — la moitié aval d’une consigne est TOUJOURS dite', () => {
  const facturable = (status: 'completed' | 'signed'): AgentIntervention[] => [
    {
      id: 'itv-facturable',
      kind: 'Détartrage',
      status,
      chantierId: 'site-docks',
      chantierNom: 'Docks Rouen',
      customerNom: 'Docks SAS',
      plannedAt: '2026-08-03T08:00:00.000Z',
      contractId: null,
      reportDocumentId: null,
      billedInvoiceId: null,
      billedInvoiceStatus: null,
      revision: 3,
    },
  ];

  it('E4/E5 : « j’ai fini le boulot, prépare la facture » PROPOSE le brouillon (terminé, signé)', async () => {
    for (const status of ['completed', 'signed'] as const) {
      const drafted: InterventionActionInput[] = [];
      const agent = makeAgent({
        listInterventions: async () => ok(facturable(status)),
        prepareInterventionInvoice: async (input) => {
          drafted.push(input);
          return ok({ interventionId: input.interventionId, invoiceId: 'inv-1', totalTtcCents: 12000 });
        },
      });
      const r = await agent.ask('J’ai fini le boulot, prépare la facture');
      expect(r.ok, status).toBe(true);
      if (!r.ok) return;
      expect(r.value.kind, status).toBe('proposed');
      expect(r.value.intent, status).toBe('facturer_intervention');
      expect(r.value.card?.body, status).toContain('BROUILLON');
      expect(drafted, status).toHaveLength(0);
      const confirme = await agent.confirm(r.value.pending!);
      expect(confirme.ok, status).toBe(true);
      expect(drafted, status).toEqual([{ interventionId: 'itv-facturable' }]);
    }
  });

  it('E6 : sur un passage DÉJÀ facturé, la raison est la bonne (jamais « plus rien à terminer »)', async () => {
    const agent = makeAgent({
      listInterventions: async () =>
        ok(
          facturable('completed').map((intervention) => ({
            ...intervention,
            billedInvoiceId: 'inv-vivante',
            billedInvoiceStatus: 'issued',
          })),
        ),
      prepareInterventionInvoice: async (input) =>
        ok({ interventionId: input.interventionId, invoiceId: 'x', totalTtcCents: 0 }),
    });
    const r = await agent.ask('J’ai fini le boulot, prépare la facture');
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.kind).toBe('answer');
    expect(r.value.card?.body).toContain('déjà couvert par une facture');
    expect(r.value.card?.body).not.toContain('plus rien à terminer');
  });

  it('geste aval COMPRIS mais impossible : Bob le dit dans la MÊME carte (visite contractuelle)', async () => {
    const agent = makeAgent({
      listInterventions: async () =>
        ok([
          {
            id: 'itv-contrat-encours',
            kind: 'Visite contractuelle',
            status: 'in_progress' as const,
            chantierId: 'site-contrat',
            chantierNom: 'Tour Montparnasse',
            customerNom: 'Gestion Tour',
            plannedAt: '2026-08-02T08:00:00.000Z',
            contractId: 'contract-1',
            reportDocumentId: null,
            billedInvoiceId: null,
            billedInvoiceStatus: null,
            revision: 2,
          },
        ]),
      completeIntervention: async (input) =>
        ok({
          interventionId: input.interventionId,
          status: 'completed',
          kind: 'Visite contractuelle',
          chantierNom: 'Tour Montparnasse',
        }),
    });
    const r = await agent.ask('C’est terminé, facture ce passage');
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.kind).toBe('proposed');
    // On termine (c'est possible), et la seconde moitié n'est PAS tue : sa raison est donnée.
    expect(r.value.pending?.tool).toBe('terminer_intervention');
    expect(r.value.card?.body).toContain('Je ne pourrai pas le facturer');
    expect(r.value.card?.body).toContain('visite contractuelle');
    // Aucune promesse en l'air : rien n'est annoncé comme « ensuite ».
    expect(r.value.pending?.chain).toBeUndefined();
  });

  it('une demande qui porte AILLEURS est citée VERBATIM dans la carte du passage', async () => {
    const agent = makeAgent({
      listInterventions: async () => ok(facturable('completed')),
      prepareInterventionInvoice: async (input) =>
        ok({ interventionId: input.interventionId, invoiceId: 'inv-1', totalTtcCents: 12000 }),
    });
    const r = await agent.ask('Facture ce passage et encaisse la facture 2026-014');
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.card?.body).toContain('« encaisse la facture 2026-014 »');
    expect(r.value.card?.body).toContain('redis-le-moi');
  });

  it('finding 7 : l’intent restitué est le même avec ou sans cible résolue', async () => {
    const sansPassage = makeAgent({ listInterventions: async () => ok([]) });
    const refus = await sansPassage.ask('Facture ce passage');
    expect(refus.ok).toBe(true);
    if (!refus.ok) return;
    expect(refus.value.intent).toBe('facturer_intervention');

    const avecPassage = makeAgent({
      listInterventions: async () => ok(facturable('completed')),
      prepareInterventionInvoice: async (input) =>
        ok({ interventionId: input.interventionId, invoiceId: 'inv-1', totalTtcCents: 12000 }),
    });
    const propose = await avecPassage.ask('Facture ce passage');
    expect(propose.ok).toBe(true);
    if (!propose.ok) return;
    expect(propose.value.intent).toBe(refus.value.intent);
  });
});
