import { describe, it, expect } from 'vitest';
import { ok } from '@bob/core';
import { BobAgent, type AgentRun } from './bob-agent';
import { ModelRouter } from '../router/model-router';
import { type BobActions } from './actions';
import { type LlmPort } from '../llm/port';

/**
 * ENCHAÎNEMENT de bout en bout (« niveau Claude Code ») — le scénario composite de la norme
 * fondateur : relancer une facture en retard PUIS marquer une autre transmise PUIS tomber sur
 * l'acompte pro fermé d'un devis et suivre le REPLI « Situation n°1 (30 %) » jusqu'au bout.
 * Invariants vérifiés à chaque maillon :
 *  · le runner enchaîne (l'historique porte le fil, chaque tour se classe correctement) ;
 *  · les CONFIRMATIONS ne tombent QUE sur les mutations (les lectures et les questions n'en
 *    demandent jamais) ;
 *  · rien n'est exécuté avant confirm() (recorders vides), et chaque confirm() exécute
 *    exactement l'action proposée ;
 *  · le fil n'est jamais perdu : chaque étape suivante repart des chips/commandes canoniques
 *    rendues par l'étape précédente.
 */

const NOW = '2026-07-27T10:00:00.000Z'; // Paris : 2026-07-27 — « hier » = 2026-07-26

interface Recorders {
  relancesSent: unknown[];
  transmissionsRecorded: unknown[];
  invoicesGenerated: unknown[];
  invoicesSent: unknown[];
}

function makeChainHost(over: Partial<BobActions> = {}): {
  agent: BobAgent;
  rec: Recorders;
  actions: BobActions;
} {
  const rec: Recorders = {
    relancesSent: [],
    transmissionsRecorded: [],
    invoicesGenerated: [],
    invoicesSent: [],
  };
  const actions: BobActions = {
    computePayout: async () => ok({ payoutCents: 100000, availableCents: 200000 }),
    draftRelance: async (input) =>
      ok({
        subject: `Relance facture ${input?.invoiceId ?? 'urgente'}`,
        body: 'Bonjour, votre facture reste impayée à ce jour.',
      }),
    listPayableInvoices: async () =>
      ok([
        { id: 'inv-1', number: '2026-014', remainingCents: 132000, customerName: 'Durand SARL' },
        { id: 'inv-2', number: '2026-002', remainingCents: 480000, customerName: 'RATP Infrastructures' },
      ]),
    listSendableQuotes: async () => ok([]),
    listIssuableInvoices: async () => ok([]),
    listDocuments: async () => ok([]),
    // Devis pro SIGNÉ dont l'acompte est FERMÉ (b2b) : le repli « Situation n°1 » s'offre —
    // situationInvoiced:false STRICT (fail-closed : absent = pas d'option numérotée).
    listInvoiceableQuotes: async () =>
      ok([
        {
          id: 'q-bv',
          number: 'D2026-050',
          customerName: 'Bureau Veritas',
          totalTtcCents: 1200000,
          depositPct: 30,
          depositInvoiced: false,
          depositAvailable: false,
          depositUnavailableReason:
            'L’acompte n’est pas disponible pour ce client professionnel : la reprise d’avance n’est pas certifiée au format Factur-X EXTENDED.',
          situationInvoiced: false,
        },
      ]),
    sendRelance: async (input) => {
      rec.relancesSent.push(input);
      return ok({ jobId: 'job-relance-1', status: 'done', tone: 'ferme' });
    },
    recordInvoiceTransmission: async (input) => {
      rec.transmissionsRecorded.push(input);
      return ok({
        transmission: {
          depositedAt: typeof input.depositedAt === 'string' ? input.depositedAt : null,
          acceptedAt: typeof input.acceptedAt === 'string' ? input.acceptedAt : null,
        },
      });
    },
    generateInvoice: async (input) => {
      rec.invoicesGenerated.push(input);
      return ok({ invoiceId: 'inv-situation-1' });
    },
    sendInvoice: async (input) => {
      rec.invoicesSent.push(input);
      return ok({ number: '2026-014', recipient: 'client@durand.fr', deliveryStatus: 'queued' as const, jobId: 'job-send-1' });
    },
    registerPayment: async () => ok({ status: 'paid' }),
    sendQuote: async () => ok({ number: 'D2026-050' }),
    issueInvoice: async () => ok({ number: 'F2026-777' }),
    ...over,
  };
  const agent = new BobAgent({
    router: new ModelRouter({ hasClaudeKey: false, hasGlmKey: false }),
    actions,
    runtime: { clock: { now: () => NOW }, ids: { newId: () => 'run-chain' } },
  });
  return { agent, rec, actions };
}

type Turn = { role: 'user' | 'bob'; text: string };

/** Déroule un tour comme le ferait l'app : message + fenêtre GLISSANTE d'historique (les 6
 * derniers échanges, la même borne que le payload /ai/ask), puis mémorise les deux côtés. */
async function play(
  agent: BobAgent,
  history: Turn[],
  message: string,
): Promise<AgentRun> {
  const r = await agent.ask(message, { history: history.slice(-6) });
  if (!r.ok) throw new Error(`tour en échec (« ${message} ») : ${JSON.stringify(r.error)}`);
  history.push({ role: 'user', text: message });
  history.push({ role: 'bob', text: r.value.spokenPrompt ?? r.value.card.body });
  return r.value;
}

describe('Enchaînement E2E — relance → transmission déclarée → repli Situation n°1 (30 %)', () => {
  it('déroule la directive composite sur une session : confirmations aux seules mutations, fil jamais perdu', async () => {
    const { agent, rec } = makeChainHost();
    const history: Turn[] = [];

    // ── Maillon 1 : « relance la facture en retard » → envoi RÉEL proposé, confirmé, exécuté ──
    const relance = await play(agent, history, 'Relance la facture 2026-014');
    expect(relance.intent).toBe('relance');
    expect(relance.kind).toBe('proposed'); // mutation sortante → confirmation OBLIGATOIRE
    expect(relance.pending?.tool).toBe('envoyer_relance');
    expect(relance.pending?.args).toEqual({ invoiceId: 'inv-1' });
    expect(rec.relancesSent).toEqual([]); // rien ne part avant la confirmation
    const relanceDone = await agent.confirm(relance.pending!);
    expect(relanceDone.ok && relanceDone.value.kind).toBe('done');
    expect(relanceDone.ok && relanceDone.value.card.title).toBe('Relance envoyée ✓');
    expect(rec.relancesSent).toEqual([{ invoiceId: 'inv-1' }]);
    if (relanceDone.ok) history.push({ role: 'bob', text: relanceDone.value.card.body });

    // ── Maillon 2 : « marque l'AUTRE facture transmise » (fait déclaré daté) → confirmé ──
    const transmission = await play(
      agent,
      history,
      'J’ai déposé la facture 2026-002 sur Chorus hier',
    );
    expect(transmission.intent).toBe('declarer_transmission');
    expect(transmission.kind).toBe('proposed'); // fait déclaré → plancher de consentement
    expect(transmission.pending?.tool).toBe('marquer_facture_transmise');
    expect(transmission.pending?.args).toEqual({ invoiceId: 'inv-2', depositedAt: '2026-07-26' });
    expect(rec.transmissionsRecorded).toEqual([]); // rien n'est noté avant la confirmation
    const transmissionDone = await agent.confirm(transmission.pending!);
    expect(transmissionDone.ok && transmissionDone.value.kind).toBe('done');
    expect(transmissionDone.ok && transmissionDone.value.card.title).toBe('Transmission notée ✓');
    expect(rec.transmissionsRecorded).toEqual([{ invoiceId: 'inv-2', depositedAt: '2026-07-26' }]);
    if (transmissionDone.ok) history.push({ role: 'bob', text: transmissionDone.value.card.body });

    // ── Maillon 3 : facturer le devis pro → acompte FERMÉ → le repli est PROPOSÉ (lecture,
    //    AUCUNE confirmation : rien n'est muté ici) avec la commande canonique en chip ──
    const fallback = await play(agent, history, 'Fais la facture du devis D2026-050');
    expect(fallback.intent).toBe('generer_facture');
    expect(fallback.kind).toBe('answer'); // une question/chips, jamais un pending
    expect(fallback.pending).toBeUndefined();
    expect(fallback.card.title).toBe('Acompte indisponible pour ce client');
    expect(fallback.card.body).toContain('Factur-X EXTENDED'); // le motif RÉEL du domaine, verbatim
    const chip = fallback.choices?.find((c) => c.label === 'Situation n°1 (30 %)');
    expect(chip).toBeDefined();
    expect(chip?.value).toBe('Facture une situation de 30 % sur le devis D2026-050');
    // La finale reste offerte en second (le repli occupe la place de l'acompte fermé).
    expect(fallback.choices?.[1]?.label).toBe('Facture finale');
    expect(rec.invoicesGenerated).toEqual([]);

    // ── Maillon 4 : suivre la chip VERBATIM → facturer_situation 30 % proposé puis confirmé ──
    const situation = await play(agent, history, chip!.value);
    expect(situation.intent).toBe('facturer_situation');
    expect(situation.kind).toBe('proposed'); // palier fiscal → confirmation même en auto
    expect(situation.pending?.tool).toBe('facturer_situation');
    expect(situation.pending?.args).toEqual({ quoteId: 'q-bv', situation: { percent: 30 } });
    expect(rec.invoicesGenerated).toEqual([]); // toujours rien avant la confirmation
    const situationDone = await agent.confirm(situation.pending!);
    expect(situationDone.ok && situationDone.value.kind).toBe('done');
    expect(situationDone.ok && situationDone.value.card.title).toBe('Situation générée ✓');
    // MÊME use case GenerateInvoiceFromQuote (mode situation) que l'écran — jamais un chemin parallèle.
    expect(rec.invoicesGenerated).toEqual([
      { quoteId: 'q-bv', mode: 'situation', situation: { percent: 30 } },
    ]);

    // ── Bilan de session : 3 mutations = 3 confirmations, 1 lecture/choix = 0 confirmation ;
    //    aucune action fantôme, chaque recorder contient EXACTEMENT ce qui a été confirmé. ──
    expect(rec.relancesSent).toHaveLength(1);
    expect(rec.transmissionsRecorded).toHaveLength(1);
    expect(rec.invoicesGenerated).toHaveLength(1);
    expect(rec.invoicesSent).toHaveLength(0);
  });

  it('repli fail-closed : une situation déjà vivante (situationInvoiced) retire la chip « n°1 » — jamais un mensonge', async () => {
    const { agent } = makeChainHost({
      listInvoiceableQuotes: async () =>
        ok([
          {
            id: 'q-bv',
            number: 'D2026-050',
            customerName: 'Bureau Veritas',
            totalTtcCents: 1200000,
            depositPct: 30,
            depositInvoiced: false,
            depositAvailable: false,
            depositUnavailableReason: 'Acompte professionnel indisponible.',
            situationInvoiced: true,
          },
        ]),
    });
    const r = await agent.ask('Fais la facture du devis D2026-050');
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.card.title).toBe('Acompte indisponible pour ce client');
    expect(r.value.choices?.some((c) => c.label.startsWith('Situation n°1'))).toBe(false);
    expect(r.value.choices?.[0]?.label).toBe('Facture finale');
  });

  it('repli fail-closed : hôte historique SANS situationInvoiced → pas d’option numérotée', async () => {
    const { agent } = makeChainHost({
      listInvoiceableQuotes: async () =>
        ok([
          {
            id: 'q-bv',
            number: 'D2026-050',
            customerName: 'Bureau Veritas',
            totalTtcCents: 1200000,
            depositPct: 30,
            depositInvoiced: false,
            depositAvailable: false,
            depositUnavailableReason: 'Acompte professionnel indisponible.',
            // situationInvoiced ABSENT (hôte historique) : le « n°1 » ne s'affirme jamais.
          },
        ]),
    });
    const r = await agent.ask('Fais la facture du devis D2026-050');
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.choices?.some((c) => c.label.startsWith('Situation n°1'))).toBe(false);
  });
});

describe('Enchaînement E2E — lot multi-directives (classifier LLM) avec les nouveaux maillons', () => {
  const routerWithKey = new ModelRouter({ hasClaudeKey: false, hasGlmKey: true });

  const llmComposite: LlmPort = {
    id: 'fake-composite',
    async complete() {
      return {
        text: null,
        toolCalls: [
          { name: 'relance_brouillon', arguments: { reference: '2026-014' } },
          { name: 'marquer_facture_transmise', arguments: { reference: '2026-002' } },
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

  it('« relance X puis marque Y déposée hier » : UN lot, UNE confirmation globale, les DEUX exécutées', async () => {
    const { actions, rec } = makeChainHost();
    const agent = new BobAgent({
      router: routerWithKey,
      llm: llmComposite,
      actions,
      runtime: { clock: { now: () => NOW }, ids: { newId: () => 'run-chain-lot' } },
    });
    const proposed = await agent.ask(
      'Relance la facture 2026-014 puis marque la facture 2026-002 déposée sur Chorus hier',
    );
    expect(proposed.ok).toBe(true);
    if (!proposed.ok) return;
    expect(proposed.value.kind).toBe('proposed');
    const batch = proposed.value.pending?.batch;
    expect(batch).toHaveLength(2);
    // Asymétrie corrigée : la relance CIBLÉE du lot est l'ENVOI réel (envoyer_relance), pas un
    // simple brouillon — même geste que le flux mono-étape.
    expect(batch?.[0]).toMatchObject({ tool: 'envoyer_relance', args: { invoiceId: 'inv-1' } });
    expect(batch?.[1]).toMatchObject({
      tool: 'marquer_facture_transmise',
      args: { invoiceId: 'inv-2', depositedAt: '2026-07-26' },
    });
    expect(rec.relancesSent).toEqual([]);
    expect(rec.transmissionsRecorded).toEqual([]);

    const done = await agent.confirm(proposed.value.pending!);
    expect(done.ok && done.value.kind).toBe('done');
    if (done.ok) {
      expect(done.value.card.body).toContain('✓ Envoyer la relance de 2026-014');
      expect(done.value.card.body).toContain('✓ Noter la facture 2026-002 transmise le 26/07/2026');
    }
    expect(rec.relancesSent).toEqual([{ invoiceId: 'inv-1' }]);
    expect(rec.transmissionsRecorded).toEqual([{ invoiceId: 'inv-2', depositedAt: '2026-07-26' }]);
  });

  it('étape comprise mais hors lot : le lot l’AVOUE au lieu de l’amputer en silence', async () => {
    const llmWithForeignStep: LlmPort = {
      id: 'fake-foreign-step',
      async complete() {
        return {
          text: null,
          toolCalls: [
            { name: 'encaisser_facture', arguments: { reference: '2026-014' } },
            // generer_facture_devis n'entre pas encore dans un lot : il doit être AVOUÉ.
            { name: 'generer_facture_devis', arguments: {} },
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
    const { actions } = makeChainHost();
    const agent = new BobAgent({
      router: routerWithKey,
      llm: llmWithForeignStep,
      actions,
      runtime: { clock: { now: () => NOW }, ids: { newId: () => 'run-chain-aveu' } },
    });
    const r = await agent.ask('Encaisse la 2026-014 puis fais la facture du devis signé');
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.kind).toBe('proposed');
    expect(r.value.pending?.batch).toHaveLength(1);
    expect(r.value.card.body).toContain('ne sait pas encore entrer dans un lot');
  });
});

describe('Enchaînement E2E — émission → envoi (la chaîne P0 « génère → émets → envoie »)', () => {
  it('après l’émission confirmée, Bob PROPOSE l’envoi ; la commande chip aboutit à envoyer_facture', async () => {
    const { agent, rec } = makeChainHost({
      listIssuableInvoices: async () =>
        ok([
          {
            id: 'draft-1',
            number: null,
            totalTtcCents: 132000,
            customerName: 'Durand SARL',
            status: 'draft',
            operationCategoryRequired: false,
          },
        ]),
      // Après émission, la pièce devient payable sous son numéro légal — la même liste
      // qui nourrit l'envoi et l'encaissement.
      listPayableInvoices: async () =>
        ok([{ id: 'draft-1', number: 'F2026-777', remainingCents: 132000, customerName: 'Durand SARL' }]),
    });
    const history: Turn[] = [];

    const issue = await play(agent, history, 'Émets la facture de Durand');
    expect(issue.intent).toBe('emettre_facture');
    expect(issue.kind).toBe('proposed');
    const issued = await agent.confirm(issue.pending!);
    expect(issued.ok && issued.value.kind).toBe('done');
    if (!issued.ok) return;
    // L'enchaînement : la carte propose l'étape suivante avec la commande canonique.
    expect(issued.value.card.body).toContain('Je l’envoie au client');
    const sendChip = issued.value.choices?.[0];
    expect(sendChip?.value).toBe('Envoie la facture F2026-777');
    history.push({ role: 'bob', text: issued.value.card.body });

    const send = await play(agent, history, sendChip!.value);
    expect(send.intent).toBe('envoyer_facture');
    expect(send.kind).toBe('proposed'); // sortant → confirmation, jamais d'envoi silencieux
    expect(send.pending?.tool).toBe('envoyer_facture');
    expect(rec.invoicesSent).toEqual([]);
    const sent = await agent.confirm(send.pending!);
    expect(sent.ok && sent.value.kind).toBe('done');
    expect(sent.ok && sent.value.card.title).toBe('Facture envoyée ✓');
    expect(rec.invoicesSent).toEqual([{ invoiceId: 'draft-1' }]);
  });

  it('hôte SANS envoyer_facture : l’émission confirmée ne propose pas d’envoi (capacité absente)', async () => {
    const { actions } = makeChainHost({
      listIssuableInvoices: async () =>
        ok([
          {
            id: 'draft-1',
            number: null,
            totalTtcCents: 132000,
            customerName: 'Durand SARL',
            status: 'draft',
            operationCategoryRequired: false,
          },
        ]),
    });
    const { sendInvoice: _sendInvoice, ...withoutSend } = actions;
    const agent = new BobAgent({
      router: new ModelRouter({ hasClaudeKey: false, hasGlmKey: false }),
      actions: withoutSend,
      runtime: { clock: { now: () => NOW }, ids: { newId: () => 'run-chain-nosend' } },
    });
    const issue = await agent.ask('Émets la facture de Durand');
    expect(issue.ok && issue.value.kind).toBe('proposed');
    if (!issue.ok || !issue.value.pending) return;
    const issued = await agent.confirm(issue.value.pending);
    expect(issued.ok && issued.value.kind).toBe('done');
    if (issued.ok) {
      expect(issued.value.card.body).not.toContain('Je l’envoie au client');
      expect(issued.value.choices).toBeUndefined();
    }
  });
});
