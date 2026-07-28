import { describe, it, expect } from 'vitest';
import { ok } from '@bob/core';
import { BobAgent } from './bob-agent';
import { ModelRouter } from '../router/model-router';
import { type AgentEquipment, type BobActions, type CreateEquipmentActionInput } from './actions';

/**
 * PR-11c — parité vocale INTELLIGENTE du parc d'équipements : résolution par NOM PARLÉ contre
 * les données réelles (site via resolveSpokenChantier, équipement via resolveSpokenEquipment),
 * TESTS D'AMBIGUÏTÉ OBLIGATOIRES (la revue du train n°1 a prouvé qu'ils attrapent les boucles
 * infinies) : chaque question porte des followUps par ID qui CONVERGENT au tour suivant.
 */

const NOW = '2026-07-28T10:00:00.000Z';

const CHANTIERS = [
  { id: 'site-carrefour', nom: 'Carrefour' },
  { id: 'site-carrefour-vitry', nom: 'Carrefour Vitry' },
  { id: 'site-bastille', nom: 'RATP Bastille' },
];

const EQUIPMENTS: AgentEquipment[] = [
  { id: 'equip-clim-carrefour', label: 'Clim local serveur', kind: 'Climatisation', status: 'active', chantierId: 'site-carrefour', chantierNom: 'Carrefour' },
  { id: 'equip-clim-vitry', label: 'Clim local serveur', kind: 'Climatisation', status: 'active', chantierId: 'site-carrefour-vitry', chantierNom: 'Carrefour Vitry' },
  { id: 'equip-clim-accueil', label: 'Clim accueil', kind: 'Climatisation', status: 'active', chantierId: 'site-bastille', chantierNom: 'RATP Bastille' },
  { id: 'equip-fontaine', label: 'Fontaine accueil R+2', kind: 'Fontaine réseau', status: 'active', chantierId: 'site-bastille', chantierNom: 'RATP Bastille' },
  { id: 'equip-vitrine', label: 'Vitrine froide', kind: null, status: 'retired', chantierId: 'site-carrefour', chantierNom: 'Carrefour' },
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
  listFilingDestinations: async () => ok({ chantiers: CHANTIERS, dossiers: [] }),
  listEquipments: async () => ok(EQUIPMENTS),
};

const makeAgent = (over: Partial<BobActions> = {}): BobAgent =>
  new BobAgent({
    router: new ModelRouter({ hasClaudeKey: false, hasGlmKey: false }),
    actions: { ...baseActions, ...over },
    runtime: { clock: { now: () => NOW }, ids: { newId: () => 'run-equipment' } },
  });

describe('ajouter_equipement — « ajoute la clim du local serveur chez Carrefour » (norme fondateur)', () => {
  it('résout le site par NOM (inclusion départagée : Carrefour ≠ Carrefour Vitry), extrait le label, et PROPOSE (une confirmation groupée)', async () => {
    const created: CreateEquipmentActionInput[] = [];
    const agent = makeAgent({
      createEquipment: async (input) => {
        created.push(input);
        return ok({ id: 'equip-new' });
      },
    });
    const r = await agent.ask('Ajoute la clim du local serveur chez Carrefour');
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.intent).toBe('ajouter_equipement');
    // Mutation → confirmation OBLIGATOIRE : rien n'est créé avant le geste.
    expect(r.value.kind).toBe('proposed');
    expect(created).toEqual([]);
    expect(r.value.pending?.tool).toBe('ajouter_equipement');
    const args = r.value.pending?.args as unknown as CreateEquipmentActionInput;
    // Départage en inclusion : « Carrefour » dit seul = le site le plus spécifique ENTIÈREMENT
    // dit — jamais une question Carrefour vs Carrefour Vitry qui rebouclerait.
    expect(args.chantierId).toBe('site-carrefour');
    expect(args.label.toLowerCase()).toContain('clim');
    expect(args.label.toLowerCase()).toContain('local serveur');
  });

  it('consigne composite désordonnée : marque et garantie extraits en UNE passe, jamais re-demandés', async () => {
    const agent = makeAgent({ createEquipment: async () => ok({ id: 'equip-new' }) });
    const r = await agent.ask(
      'La fontaine du deuxième chez RATP Bastille, marque Culligan, garantie jusqu’au 12/03/2027, ajoute-la',
    );
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.kind).toBe('proposed');
    const args = r.value.pending?.args as unknown as CreateEquipmentActionInput;
    expect(args.chantierId).toBe('site-bastille');
    expect(args.brand).toBe('Culligan');
    expect(args.warrantyUntil).toBe('2027-03-12');
  });

  it('[revue n°2] exemple NORMATIF fondateur (§1.6) : « sous garantie jusqu’en mars 2027 » → FIN de mois extraite en UNE passe', async () => {
    const agent = makeAgent({ createEquipment: async () => ok({ id: 'equip-new' }) });
    const r = await agent.ask(
      'La fontaine du deuxième chez RATP Bastille, marque Culligan, elle est sous garantie jusqu’en mars 2027, ajoute-la',
    );
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.kind).toBe('proposed');
    const args = r.value.pending?.args as unknown as CreateEquipmentActionInput;
    expect(args.chantierId).toBe('site-bastille');
    expect(args.brand).toBe('Culligan');
    // Mois-année parlé = fin de mois — le fait n'est plus perdu en silence.
    expect(args.warrantyUntil).toBe('2027-03-31');
    // Verbe en FIN de consigne (« ajoute-la ») : le libellé vit AVANT le verbe.
    expect(args.label.toLowerCase()).toContain('fontaine');
    // La confirmation groupée DIT la garantie extraite (frDate : 31/03/2027).
    expect(r.value.card.body).toContain('garantie');
    expect(r.value.card.body).toContain('31/03/2027');
  });

  it('[revue n°2] garantie dite mais ILLISIBLE (« constructeur deux ans ») : Bob le DIT à la confirmation — jamais strippée en silence', async () => {
    const agent = makeAgent({ createEquipment: async () => ok({ id: 'equip-new' }) });
    const r = await agent.ask(
      'Ajoute la clim du local serveur chez Carrefour, garantie constructeur deux ans',
    );
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.kind).toBe('proposed');
    const args = r.value.pending?.args as unknown as CreateEquipmentActionInput;
    // Aucune date inventée…
    expect(args.warrantyUntil).toBeUndefined();
    // …mais l'honnêteté au point de décision : le manque est dit, avec le chemin de rattrapage.
    expect(r.value.card.body).toContain('pas su lire');
    expect(r.value.card.body).toContain('fiche');
  });

  it('site MANQUANT : question ciblée sur le seul manque, followUps qui REDISENT la commande complète', async () => {
    const agent = makeAgent({ createEquipment: async () => ok({ id: 'equip-new' }) });
    const r = await agent.ask('Ajoute la pompe de relevage au parc');
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.kind).toBe('answer');
    expect(r.value.card.title).toContain('site');
    const followUp = r.value.ask?.[0]?.options?.[0]?.followUp ?? r.value.choices?.[0]?.value ?? '';
    expect(followUp.toLowerCase()).toContain('pompe de relevage');
    expect(followUp.toLowerCase()).toContain('chez');
  });

  it('site nommé INTROUVABLE : refus honnête (rien n’est créé) + sites réels en options', async () => {
    const created: unknown[] = [];
    const agent = makeAgent({
      createEquipment: async (input) => {
        created.push(input);
        return ok({ id: 'equip-new' });
      },
    });
    const r = await agent.ask('Ajoute la clim du local serveur sur le site Leclerc Nord');
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.kind).toBe('answer');
    expect(r.value.card.body).toContain('Rien n’a été créé');
    expect(created).toEqual([]);
    expect((r.value.choices ?? []).length).toBeGreaterThan(0);
  });

  it('refus du domaine (site clôturé) restitué VERBATIM à la confirmation — jamais contourné', async () => {
    const agent = makeAgent({
      createEquipment: async () =>
        ({
          ok: false,
          error: {
            kind: 'domain',
            error: {
              code: 'VALIDATION',
              field: 'chantierId',
              message: 'Ce site est clôturé — rouvre-le pour ajouter un équipement.',
            },
          },
        }) as never,
    });
    const proposed = await agent.ask('Ajoute la clim du local serveur chez Carrefour');
    expect(proposed.ok).toBe(true);
    if (!proposed.ok || !proposed.value.pending) throw new Error('proposition attendue');
    const confirmed = await agent.confirm(proposed.value.pending);
    expect(confirmed.ok).toBe(true);
    if (!confirmed.ok) return;
    expect(confirmed.value.kind).toBe('answer');
    expect(confirmed.value.card.body).toBe('Ce site est clôturé — rouvre-le pour ajouter un équipement.');
  });

  it('plancher de consentement : MÊME en autonomie auto, la création reste proposée (jamais silencieuse)', async () => {
    const created: unknown[] = [];
    const agent = makeAgent({
      createEquipment: async (input) => {
        created.push(input);
        return ok({ id: 'equip-new' });
      },
    });
    const r = await agent.ask('Ajoute la clim du local serveur chez Carrefour', { autonomy: 'auto' });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.kind).toBe('proposed');
    expect(created).toEqual([]);
  });
});

describe('historique_equipement — résolution par nom parlé + AMBIGUÏTÉ OBLIGATOIRE', () => {
  it('nom unique entièrement dit : lit l’historique réel SANS confirmation (lecture)', async () => {
    const asked: unknown[] = [];
    const agent = makeAgent({
      getEquipmentHistory: async (input) => {
        asked.push(input);
        return ok({
          equipmentId: 'equip-fontaine',
          label: 'Fontaine accueil R+2',
          status: 'active' as const,
          entries: [
            { type: 'note' as const, at: '2026-05-12T10:00:00.000Z', label: 'Détartrage complet — Papa' },
          ],
        });
      },
    });
    const r = await agent.ask("L'historique de la fontaine de l'accueil");
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.intent).toBe('historique_equipement');
    expect(r.value.kind).toBe('answer');
    expect(r.value.pending).toBeUndefined();
    expect(asked).toEqual([{ equipmentId: 'equip-fontaine' }]);
    expect(r.value.card.body).toContain('Détartrage complet');
  });

  it('AMBIGUÏTÉ « la clim » (3 clims) : question posée, followUps par ID — le tour suivant CONVERGE (jamais de boucle)', async () => {
    const asked: unknown[] = [];
    const agent = makeAgent({
      getEquipmentHistory: async (input) => {
        asked.push(input);
        return ok({ equipmentId: String((input as { equipmentId: string }).equipmentId), label: 'Clim local serveur', status: 'active' as const, entries: [] });
      },
    });
    const first = await agent.ask("L'historique de la clim");
    expect(first.ok).toBe(true);
    if (!first.ok) return;
    expect(first.value.kind).toBe('answer');
    expect(asked).toEqual([]); // aucune lecture tant que la cible est ambiguë
    const items = first.value.ask?.[0]?.options ?? [];
    expect(items.length).toBeGreaterThanOrEqual(2);
    const followUp = items[0]?.followUp ?? '';
    expect(followUp).toContain('equip-'); // followUp par ID : le rematch est exact

    // Le tour suivant (followUp) résout par ID — la même question ne se repose JAMAIS.
    const second = await agent.ask(followUp, {
      history: [
        { role: 'user', text: "L'historique de la clim" },
        { role: 'bob', text: first.value.card.body },
      ],
    });
    expect(second.ok).toBe(true);
    if (!second.ok) return;
    expect(second.value.kind).toBe('answer');
    expect(asked).toHaveLength(1);
  });

  it('deux « Clim local serveur » sur DEUX sites : le site dit départage (« chez Carrefour Vitry »)', async () => {
    const asked: { equipmentId: string }[] = [];
    const agent = makeAgent({
      getEquipmentHistory: async (input) => {
        asked.push(input as { equipmentId: string });
        return ok({ equipmentId: 'x', label: 'Clim local serveur', status: 'active' as const, entries: [] });
      },
    });
    const r = await agent.ask("L'historique de la clim du local serveur chez Carrefour Vitry");
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.kind).toBe('answer');
    expect(asked).toEqual([{ equipmentId: 'equip-clim-vitry' }]);
  });

  it('équipement nommé INTROUVABLE : refus honnête + parc réel en options — jamais un id inventé', async () => {
    const asked: unknown[] = [];
    const agent = makeAgent({
      getEquipmentHistory: async (input) => {
        asked.push(input);
        return ok({ equipmentId: 'x', label: 'x', status: 'active' as const, entries: [] });
      },
    });
    const r = await agent.ask("L'historique de la chaudière murale");
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.card.title).toBe('Équipement introuvable');
    expect(r.value.card.body).toContain('Rien n’a été modifié');
    expect(asked).toEqual([]);
  });
});

describe('retirer_equipement — mutation TOUJOURS confirmée + avertissement contrat dit', () => {
  it('« la vitrine froide est déposée, retire-la du parc » : cible le parc ACTIF — la vitrine déjà retirée n’y est plus', async () => {
    const agent = makeAgent({
      retireEquipment: async () => ok({ equipmentId: 'x', label: 'x', contractWarning: null }),
    });
    const r = await agent.ask('La vitrine froide est déposée, retire-la du parc');
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.intent).toBe('retirer_equipement');
    // La vitrine est DÉJÀ retirée : le pool actif ne la contient pas → réponse honnête, pas
    // une mutation fantôme.
    expect(r.value.kind).toBe('answer');
  });

  it('retrait d’une machine active : proposition confirmée, puis l’avertissement contrat est DIT', async () => {
    const retired: unknown[] = [];
    const agent = makeAgent({
      retireEquipment: async (input) => {
        retired.push(input);
        return ok({
          equipmentId: 'equip-fontaine',
          label: 'Fontaine accueil R+2',
          contractWarning:
            "Couvert par le contrat Entretien fontaines 2026 : la couverture (et son prix) continue jusqu'à modification du contrat.",
        });
      },
    });
    const proposed = await agent.ask('Retire la fontaine de l’accueil du parc');
    expect(proposed.ok).toBe(true);
    if (!proposed.ok) return;
    expect(proposed.value.kind).toBe('proposed');
    expect(retired).toEqual([]);
    expect(proposed.value.pending?.args).toEqual({ equipmentId: 'equip-fontaine' });

    // La CONFIRMATION exécute la seule mutation et DIT l'avertissement contrat (amélioration 4).
    const confirmed = await agent.confirm(proposed.value.pending!);
    expect(confirmed.ok).toBe(true);
    if (!confirmed.ok) return;
    expect(confirmed.value.kind).toBe('done');
    expect(confirmed.value.card.body).toContain('Entretien fontaines 2026');
    expect(retired).toEqual([{ equipmentId: 'equip-fontaine' }]);
  });

  it('[amélioration 4 — domaine §1.5-1.6] la couverture est LUE et l’avertissement DIT AVANT la confirmation : la PROPOSITION le porte (carte ET voix), rien n’est retiré', async () => {
    const coverageReads: unknown[] = [];
    const retired: unknown[] = [];
    const agent = makeAgent({
      getEquipmentContractCoverage: async (input) => {
        coverageReads.push(input);
        return ok({ activeContractLabels: ['Entretien fontaines 2026'] });
      },
      retireEquipment: async (input) => {
        retired.push(input);
        return ok({ equipmentId: 'equip-fontaine', label: 'Fontaine accueil R+2', contractWarning: null });
      },
    });
    const proposed = await agent.ask('Retire la fontaine de l’accueil du parc');
    expect(proposed.ok).toBe(true);
    if (!proposed.ok) return;
    expect(proposed.value.kind).toBe('proposed');
    // La lecture a eu lieu AVANT le geste ; la mutation, elle, n'a PAS eu lieu.
    expect(coverageReads).toEqual([{ equipmentId: 'equip-fontaine' }]);
    expect(retired).toEqual([]);
    // La proposition PORTE l'avertissement du domaine — même copy que le use case (@bob/core).
    expect(proposed.value.card.body).toContain(
      "Couvert par le contrat Entretien fontaines 2026 : la couverture (et son prix) continue jusqu'à modification du contrat.",
    );
    expect(proposed.value.spokenPrompt).toContain('Entretien fontaines 2026');
  });

  it('[amélioration 4] couverture ILLISIBLE (lecture en échec) : la proposition reste possible SANS avertissement inventé — info jamais bloquante', async () => {
    const agent = makeAgent({
      getEquipmentContractCoverage: async () => ({
        ok: false as const,
        error: { kind: 'unavailable' as const, service: 'contracts' },
      }),
      retireEquipment: async () =>
        ok({ equipmentId: 'equip-fontaine', label: 'Fontaine accueil R+2', contractWarning: null }),
    });
    const proposed = await agent.ask('Retire la fontaine de l’accueil du parc');
    expect(proposed.ok).toBe(true);
    if (!proposed.ok) return;
    expect(proposed.value.kind).toBe('proposed');
    expect(proposed.value.card.body).not.toContain('Couvert par le contrat');
  });
});

describe('parc_equipements — lecture pure scopée au site dit', () => {
  it('« montre-moi le parc du site RATP Bastille » : liste RÉELLE du seul site, sans confirmation', async () => {
    const r = await makeAgent().ask('Montre-moi le parc du site RATP Bastille');
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.intent).toBe('parc_equipements');
    expect(r.value.kind).toBe('answer');
    expect(r.value.card.title).toBe('Parc — RATP Bastille');
    expect(r.value.card.body).toContain('Fontaine accueil R+2');
    expect(r.value.card.body).toContain('Clim accueil');
    expect(r.value.card.body).not.toContain('Vitrine froide');
  });

  it('hôte sans capacité : réponse honnête, jamais un parc inventé', async () => {
    // exactOptionalPropertyTypes : l'absence de capacité = clé ABSENTE, jamais `undefined` explicite.
    const { listEquipments: _sansParc, ...actionsSansParc } = baseActions;
    const r = await new BobAgent({
      router: new ModelRouter({ hasClaudeKey: false, hasGlmKey: false }),
      actions: actionsSansParc,
      runtime: { clock: { now: () => NOW }, ids: { newId: () => 'run-equipment' } },
    }).ask('Montre-moi le parc du site RATP Bastille');
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.card.body).toContain('Rien n’a été modifié');
  });
});
