import { describe, expect, it } from 'vitest';
import { detectIntent } from './intent';
import {
  acceptsGesture,
  explainInterventionBlock,
  explainWithheldDownstream,
  interventionRequestFor,
  readInterventionDirective,
  requestedGesture,
  resolveInterventionGesture,
  type InterventionDownstream,
  type InterventionStateView,
} from './intervention-directive';

/**
 * [Revue de vérification 29/07 — LECTURE CLAUSE PAR CLAUSE, ROUTAGE BORNÉ]
 *
 * Trois régressions mesurées, une seule cause : des expressions régulières d'arbitrage
 * appliquées au MESSAGE ENTIER pour trancher entre des gestes qui vivent dans des CLAUSES
 * différentes.
 *
 *   (1) le routage par état était INCONDITIONNEL : toute annonce de fin capturait le tour,
 *       même quand le geste demandé n'avait rien à voir avec le passage ;
 *   (2) l'arbitrage lexical croisé n'avait pas été supprimé mais DÉPLACÉ : un mot d'une clause
 *       éteignait l'autre clause ;
 *   (3) le classement se faisait sur le DÉTERMINANT (« prépare LA facture ») : le périmètre
 *       restait LEXICAL, seule la clé avait changé.
 *
 * Ces tests mesurent l'invariant qui les couvre toutes : AUCUNE CLAUSE NE PEUT EN ÉTEINDRE UNE
 * AUTRE, et l'annonce de fin ne capte que ce qui porte sur le passage.
 */

// ── Matière de mesure : clauses réelles, classées séparément ─────────────────────────────────

/** Annonces de fin telles qu'on les dit sur le terrain. */
const ANNONCES = ['C’est terminé', 'J’ai fini', 'Le passage est terminé'] as const;

/** Gestes qui PORTENT sur le passage — chacun se tient debout seul. */
const GESTES_DE_PASSAGE: readonly { clause: string; geste: InterventionDownstream }[] = [
  { clause: 'facture ce passage', geste: 'bill' },
  { clause: 'envoie la fiche de passage', geste: 'send' },
  { clause: 'fais signer', geste: 'sign' },
];

/** Gestes qui vivent AILLEURS — l'annonce de fin ne doit JAMAIS les capter. */
const GESTES_AILLEURS = [
  'envoie la facture au client',
  'encaisse la facture',
  'montre-moi ma trésorerie',
  'programme la prochaine visite lundi',
  'ajoute une dépense de 40 € chez Point P',
  'émets la facture 2026-014',
] as const;

/** Faits de terrain : ils ne demandent rien et ne doivent RIEN éteindre. */
const FAITS = [
  '0 € de pièces',
  'la pression était basse mais c’est réglé',
  'j’y suis resté deux heures',
] as const;

const PASSAGE_DE_BASE: InterventionStateView = {
  status: 'in_progress',
  contractId: null,
  billedInvoiceId: null,
  billedInvoiceStatus: null,
};

const vue = (over: Partial<InterventionStateView>): InterventionStateView => ({
  ...PASSAGE_DE_BASE,
  ...over,
});

// ── LIVRABLE 2 — le routage par état est BORNÉ aux gestes de passage ─────────────────────────

describe('§3.7 — l’annonce de fin ne capte QUE ce qui porte sur le passage', () => {
  it('les 18 phrases mesurées gardent l’intent du geste réellement demandé', () => {
    const echecs: string[] = [];
    for (const annonce of ANNONCES) {
      for (const geste of GESTES_AILLEURS) {
        const seul = detectIntent(geste);
        const compose = detectIntent(`${annonce}, ${geste}`);
        if (compose !== seul)
          echecs.push(`« ${annonce}, ${geste} » → ${compose} (seul : ${seul})`);
      }
    }
    expect(echecs.length === 0 ? '' : `${echecs.length}/18 détournées :\n${echecs.join('\n')}`).toBe(
      '',
    );
  });

  it('mais un geste de FICHE rend l’autorité à l’annonce (on termine, puis on enchaîne)', () => {
    for (const annonce of ANNONCES) {
      for (const { clause, geste } of GESTES_DE_PASSAGE) {
        const phrase = `${annonce}, ${clause}`;
        expect(detectIntent(phrase), phrase).toBe('terminer_intervention');
        expect(readInterventionDirective(phrase).downstreams, phrase).toContain(geste);
      }
    }
  });

  it('une annonce NUE reste une fin de passage (rien d’autre n’est demandé)', () => {
    for (const annonce of ANNONCES) expect(detectIntent(annonce)).toBe('terminer_intervention');
    expect(detectIntent('C’est terminé, 0 € de pièces')).toBe('terminer_intervention');
    expect(detectIntent('J’ai fini, note-le : la pression était basse')).toBe(
      'terminer_intervention',
    );
  });

  it('la demande qui porte ailleurs est CITÉE, jamais jetée en silence', () => {
    const directive = readInterventionDirective('C’est terminé, encaisse la facture');
    expect(directive.divertsElsewhere).toBe(true);
    expect(directive.asides.map((aside) => aside.text)).toEqual(['encaisse la facture']);
    expect(directive.asides[0]?.kind).toBe('ailleurs');
  });
});

// ── LIVRABLE 1 — aucune clause n’en éteint une autre ─────────────────────────────────────────

describe('§3.7 — lecture CLAUSE PAR CLAUSE : aucune clause n’en éteint une autre', () => {
  it('INVARIANT combinatoire : chaque geste dicté survit à toutes ses voisines', () => {
    const echecs: string[] = [];
    let mesurees = 0;
    for (const annonce of [...ANNONCES, '']) {
      for (const passage of GESTES_DE_PASSAGE) {
        for (const fait of [...FAITS, '']) {
          for (const ailleurs of [...GESTES_AILLEURS, '']) {
            const clauses = [annonce, passage.clause, fait, ailleurs].filter(
              (clause) => clause.length > 0,
            );
            const phrase = `${clauses.join(', ')}.`;
            mesurees += 1;
            const directive = readInterventionDirective(phrase);
            const raisons: string[] = [];
            // Le geste de fiche dicté doit SURVIVRE, quelles que soient ses voisines.
            if (!directive.downstreams.includes(passage.geste))
              raisons.push(`geste « ${passage.geste} » perdu (lu : ${directive.downstreams.join('+') || '∅'})`);
            // L'annonce de fin ne dépend pas non plus des voisines.
            if (annonce.length > 0 && !directive.announcesCompletion)
              raisons.push('annonce de fin perdue');
            // La demande qui porte ailleurs est toujours restituée VERBATIM.
            if (ailleurs.length > 0 && !directive.asides.some((aside) => aside.text === ailleurs))
              raisons.push(`demande « ${ailleurs} » jetée en silence`);
            // Un fait de terrain ne demande rien : il ne doit jamais devenir une demande.
            if (fait.length > 0 && directive.asides.some((aside) => aside.text === fait))
              raisons.push(`fait de terrain « ${fait} » pris pour une demande`);
            if (raisons.length > 0) echecs.push(`« ${phrase} » : ${raisons.join(' ; ')}`);
          }
        }
      }
    }
    expect(mesurees).toBeGreaterThanOrEqual(300);
    expect(
      echecs.length === 0 ? '' : `${echecs.length}/${mesurees} en échec :\n${echecs.slice(0, 12).join('\n')}`,
    ).toBe('');
  });

  it('les trois phrases de l’arbitrage croisé rendent LES DEUX gestes', () => {
    expect(
      readInterventionDirective('Envoie la fiche de passage et facture ce passage').downstreams,
    ).toEqual(['send', 'bill']);
    const annuelle = readInterventionDirective('J’ai fini la visite annuelle, facture ce passage');
    expect(annuelle.announcesCompletion).toBe(true);
    expect(annuelle.downstreams).toEqual(['bill']);
    const pieces = readInterventionDirective('C’est terminé, facture ce passage, 0 € de pièces');
    expect(pieces.announcesCompletion).toBe(true);
    expect(pieces.downstreams).toEqual(['bill']);
  });

  it('« prépare la facture » après une fin annoncée est LE geste de facturation (E4/E5/E6 × C12)', () => {
    const directive = readInterventionDirective('J’ai fini le boulot, prépare la facture');
    expect(directive.announcesCompletion).toBe(true);
    expect(directive.downstreams).toEqual(['bill']);
  });

  it('… mais la lecture reste bornée : devis, montant et pièce numérotée gardent leur geste', () => {
    for (const phrase of [
      'C’est terminé, prépare la facture du devis Durand',
      'C’est terminé, prépare la facture de 380 € pour Mme Girard',
      'C’est terminé, prépare la facture 2026-014',
      'C’est terminé, facture une situation de 40 % sur le chantier Durand',
      'Prépare la facture',
    ])
      expect(readInterventionDirective(phrase).downstreams, phrase).toEqual([]);
  });

  it('la négation ne déclenche rien, et n’éteint pas la clause voisine', () => {
    const directive = readInterventionDirective(
      'C’est terminé, n’envoie pas la fiche, facture ce passage',
    );
    expect(directive.downstreams).toEqual(['bill']);
    expect(readInterventionDirective('N’envoie pas la fiche de passage').downstreams).toEqual([]);
    expect(readInterventionDirective('Ne démarre pas l’intervention').startsPassage).toBe(false);
  });

  /**
   * La désambiguïsation (« Quel passage ? ») rejoue une commande CANONIQUE qui porte l'ID de la
   * fiche. Un id réel est un uuid : il contient des chiffres, et un chiffre suivi d'un « e »
   * (« …-9e0f », « …-123e- ») était lu comme un MONTANT dit. Le geste s'éteignait, la question
   * rebouclait sur elle-même. Une référence EXPLICITE au passage prime désormais sur un nombre.
   */
  it('NON-RÉGRESSION : les commandes canoniques à ID (uuid compris) restent classées', () => {
    const ids = [
      'itv-carrefour-1',
      '4d1c6f2e-8a3b-4c5d-9e0f-112233445566',
      'a1b2-123e-4567-89ab-000111222333',
    ];
    const echecs: string[] = [];
    for (const id of ids) {
      const attendus: readonly [string, string][] = [
        [`Démarre l'intervention ${id}`, 'commencer_intervention'],
        [`Termine l'intervention ${id}`, 'terminer_intervention'],
        [`Termine l'intervention ${id} et facture ce passage`, 'terminer_intervention'],
        [`Fais signer l'intervention ${id}`, 'faire_signer_intervention'],
        [`Envoie la fiche de passage ${id}`, 'envoyer_fiche_passage'],
        [`Facture le passage ${id}`, 'facturer_intervention'],
      ];
      for (const [commande, attendu] of attendus) {
        const obtenu = detectIntent(commande);
        if (obtenu !== attendu) echecs.push(`« ${commande} » → ${obtenu} (attendu ${attendu})`);
      }
    }
    expect(echecs.length === 0 ? '' : echecs.join('\n')).toBe('');
  });

  it('un montant DÉCIMAL reste dans SA clause (la citation n’est jamais mutilée)', () => {
    for (const phrase of [
      'C’est terminé, facture 380,50 € à Mme Girard',
      'C’est terminé, facture 380.50 € à Mme Girard',
    ]) {
      const directive = readInterventionDirective(phrase);
      expect(directive.downstreams, phrase).toEqual([]);
      expect(directive.asides[0]?.text, phrase).toContain('€');
      expect(detectIntent(phrase), phrase).toBe('facture_directe');
    }
  });

  it('l’enchaînement SANS coordination est découpé aussi (« c’est terminé envoie la facture »)', () => {
    const directive = readInterventionDirective('C’est terminé envoie la facture');
    expect(directive.announcesCompletion).toBe(true);
    expect(directive.downstreams).toEqual([]);
    expect(directive.divertsElsewhere).toBe(true);
    expect(detectIntent('C’est terminé envoie la facture')).toBe('envoyer_facture');
  });
});

// ── LIVRABLE 2 (suite) — la matrice ÉTAT × CONSIGNE ──────────────────────────────────────────

describe('§3.7 — matrice ÉTAT × CONSIGNE : le geste vient de l’état, jamais du lexique', () => {
  const ETATS: readonly { nom: string; vue: InterventionStateView }[] = [
    { nom: 'planifié', vue: vue({ status: 'scheduled' }) },
    { nom: 'en cours', vue: vue({ status: 'in_progress' }) },
    { nom: 'terminé', vue: vue({ status: 'completed' }) },
    { nom: 'signé', vue: vue({ status: 'signed' }) },
    {
      nom: 'déjà facturé',
      vue: vue({ status: 'completed', billedInvoiceId: 'inv-1', billedInvoiceStatus: 'issued' }),
    },
    { nom: 'contractuel', vue: vue({ status: 'completed', contractId: 'contract-1' }) },
    { nom: 'annulé', vue: vue({ status: 'cancelled' }) },
  ];

  const demandeDe = (phrase: string) => {
    const directive = readInterventionDirective(phrase);
    const intent = detectIntent(phrase);
    const geste =
      intent === 'commencer_intervention'
        ? 'start'
        : intent === 'terminer_intervention'
          ? 'complete'
          : intent === 'envoyer_fiche_passage'
            ? 'send'
            : intent === 'facturer_intervention'
              ? 'bill'
              : intent === 'faire_signer_intervention'
                ? 'sign'
                : 'complete';
    return interventionRequestFor(geste, directive);
  };

  it('aucun geste résolu n’est refusé par l’état — et aucun refusé n’est exécuté', () => {
    const phrases = [
      'Démarre l’intervention',
      'C’est terminé',
      'C’est terminé, facture ce passage',
      'C’est terminé, envoie la fiche de passage',
      'C’est terminé, fais signer',
      'J’ai fini le boulot, prépare la facture',
      'Facture ce passage',
      'Envoie la fiche de passage',
      'Fais signer le client',
      'Envoie la fiche de passage et facture ce passage',
      'C’est terminé, facture ce passage, 0 € de pièces',
      'J’ai fini la visite annuelle, facture ce passage',
      'C’est terminé, encaisse la facture',
      'C’est terminé, montre-moi ma trésorerie',
      'C’est terminé, émets la facture 2026-014',
    ];
    const echecs: string[] = [];
    for (const etat of ETATS) {
      for (const phrase of phrases) {
        const request = demandeDe(phrase);
        const resolution = resolveInterventionGesture(request, etat.vue);
        if (resolution === null) continue;
        if (!acceptsGesture(etat.vue, resolution.gesture))
          echecs.push(`[${etat.nom}] « ${phrase} » → geste ${resolution.gesture} INTERDIT par l’état`);
        if (resolution.then !== null && resolution.then === resolution.withheld)
          echecs.push(`[${etat.nom}] « ${phrase} » → geste ${resolution.then} annoncé ET retenu`);
      }
    }
    expect(echecs.length === 0 ? '' : echecs.join('\n')).toBe('');
  });

  it('« j’ai fini le boulot, prépare la facture » facture les passages facturables (E4/E5)', () => {
    for (const etat of ['completed', 'signed'] as const) {
      const resolution = resolveInterventionGesture(
        demandeDe('J’ai fini le boulot, prépare la facture'),
        vue({ status: etat }),
      );
      expect(resolution?.gesture, etat).toBe('bill');
    }
  });

  it('… et sur un passage DÉJÀ facturé, la raison donnée est la BONNE (E6)', () => {
    const dejaFacture = vue({
      status: 'completed',
      billedInvoiceId: 'inv-1',
      billedInvoiceStatus: 'issued',
    });
    const request = demandeDe('J’ai fini le boulot, prépare la facture');
    expect(resolveInterventionGesture(request, dejaFacture)).toBeNull();
    const raison = explainInterventionBlock(dejaFacture, request, 'Le passage « Détartrage »');
    expect(raison).toContain('déjà couvert par une facture');
    expect(raison).not.toContain('plus rien à terminer');
  });

  it('un passage EN COURS termine d’abord, puis annonce le geste aval', () => {
    const resolution = resolveInterventionGesture(
      demandeDe('C’est terminé, facture ce passage'),
      vue({ status: 'in_progress' }),
    );
    expect(resolution).toMatchObject({ gesture: 'complete', then: 'bill', withheld: null });
  });

  it('un passage DÉJÀ terminé exécute directement le geste aval (impasse miroir fermée)', () => {
    const resolution = resolveInterventionGesture(
      demandeDe('C’est terminé, facture ce passage'),
      vue({ status: 'completed' }),
    );
    expect(resolution).toMatchObject({ gesture: 'bill', then: null });
  });
});

// ── LIVRABLE 3 — un geste compris mais impossible est DIT ────────────────────────────────────

describe('§3.7 — rien n’est jeté en silence', () => {
  it('une visite contractuelle en cours : on termine, et Bob DIT qu’il ne facturera pas', () => {
    const contractuelle = vue({ status: 'in_progress', contractId: 'contract-1' });
    const request = interventionRequestFor(
      'complete',
      readInterventionDirective('C’est terminé, facture ce passage'),
    );
    const resolution = resolveInterventionGesture(request, contractuelle);
    expect(resolution).toMatchObject({ gesture: 'complete', then: null, withheld: 'bill' });
    expect(explainWithheldDownstream(contractuelle, 'bill', 'le passage « Visite »')).toContain(
      'visite contractuelle',
    );
  });

  it('un passage déjà facturé : la retenue cite la facture, jamais un motif inventé', () => {
    const facture = vue({
      status: 'in_progress',
      billedInvoiceId: 'inv-1',
      billedInvoiceStatus: 'issued',
    });
    const resolution = resolveInterventionGesture(
      interventionRequestFor('complete', readInterventionDirective('C’est terminé, facture ce passage')),
      facture,
    );
    expect(resolution?.withheld).toBe('bill');
    expect(explainWithheldDownstream(facture, 'bill', 'le passage « Détartrage »')).toContain(
      'déjà couvert par une facture',
    );
  });

  it('une demande NON COMPRISE est avouée, elle ne borne pas le routage', () => {
    const phrase = 'C’est terminé, prépare le matériel pour demain';
    const directive = readInterventionDirective(phrase);
    expect(directive.asides).toEqual([
      { text: 'prépare le matériel pour demain', kind: 'incompris' },
    ]);
    expect(directive.divertsElsewhere).toBe(false);
    // Le routage garde l'autorité : une demande illisible ne détourne pas la fin de passage.
    expect(detectIntent(phrase)).toBe('terminer_intervention');
  });
});

// ── LIVRABLE 4c — l’intent restitué ne dépend pas de la présence d’une cible ─────────────────

describe('§3.7 — le geste NOMMÉ dans un refus est celui que la consigne demande', () => {
  it('requestedGesture suit l’ordre du parcours, sans passage sous la main', () => {
    const de = (phrase: string, geste: Parameters<typeof interventionRequestFor>[0]) =>
      requestedGesture(interventionRequestFor(geste, readInterventionDirective(phrase)));
    expect(de('Démarre l’intervention chez Carrefour', 'start')).toBe('start');
    expect(de('C’est terminé, facture ce passage', 'complete')).toBe('complete');
    expect(de('Facture ce passage', 'bill')).toBe('bill');
    expect(de('Envoie la fiche de passage', 'send')).toBe('send');
    expect(de('Fais signer le client', 'sign')).toBe('sign');
    // Classement du modèle en désaccord avec le texte : le geste dicté reste porté.
    expect(
      interventionRequestFor('send', readInterventionDirective('Facture ce passage')).downstreams,
    ).toEqual(['send', 'bill']);
  });
});
