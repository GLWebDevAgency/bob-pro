import { describe, it, expect } from 'vitest';
import { ok } from '@bob/core';
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

  it('relance : brouillon (lecture)', async () => {
    const r = await makeAgent().ask('Tu peux relancer le client en retard ?');
    expect(r.ok && r.value.intent).toBe('relance');
    expect(r.ok && r.value.kind).toBe('answer');
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
});
