import { describe, expect, it } from 'vitest';
import { detectIntent } from './intent';
import {
  acceptsGesture,
  explainInterventionAsides,
  explainInterventionBlock,
  explainWithheldDownstream,
  interventionRequestFor,
  markInterventionCommand,
  readInterventionDirective,
  requestedGesture,
  resolveInterventionGesture,
  type InterventionDownstream,
  type InterventionStateView,
} from './intervention-directive';
import { extractInterventionSummary } from './intervention-summary';

/**
 * [Revue architecturale 29/07 — LE PÉRIMÈTRE DU CHEMIN DÉTERMINISTE]
 *
 * Six passes ont demandé à des expressions régulières d'arbitrer entre PLUSIEURS gestes dictés
 * dans la même phrase. Ce n'est pas leur travail : c'est celui du chemin LLM, qui rend
 * `steps[]`. Chaque passe a déplacé l'impasse (113 cas fautifs sur 343 à la dernière mesure).
 *
 * Ces tests mesurent le PÉRIMÈTRE, pas les motifs :
 *
 *   · UN geste dicté       → il s'exécute (comportement d'avant, déjà prouvé) ;
 *   · PLUSIEURS gestes     → le PREMIER geste certain est retenu, le reste est DIT verbatim ;
 *   · AUCUN geste certain  → une question, jamais un geste faux ni un silence ;
 *   · CERTITUDE            → un verbe en TÊTE DE CLAUSE. Un déterminant devant le mot en fait un
 *                            NOM ou un PARTICIPE (« l'archive », « la classe », « c'est rangé »).
 */

// ── Matière de mesure : clauses réelles, classées séparément ─────────────────────────────────

/** Annonces de fin telles qu'on les dit sur le terrain. */
const ANNONCES = [
  'C’est terminé',
  'J’ai fini',
  'Le passage est terminé',
  'Termine ce passage',
] as const;

/** Gestes qui PORTENT sur le passage — chacun se tient debout seul. */
const GESTES_DE_PASSAGE: readonly { clause: string; geste: InterventionDownstream }[] = [
  { clause: 'facture ce passage', geste: 'bill' },
  { clause: 'envoie la fiche de passage', geste: 'send' },
  { clause: 'fais signer', geste: 'sign' },
];

/**
 * Demandes qui vivent AILLEURS — l'annonce de fin ne doit JAMAIS les capter. Les trois dernières
 * n'ont AUCUN verbe impératif : c'est une QUESTION et deux GROUPES NOMINAUX. La borne ne les
 * voyait pas, et le routage par l'état redevenait inconditionnel sur toute la famille.
 */
const GESTES_AILLEURS = [
  'envoie la facture au client',
  'encaisse la facture',
  'montre-moi ma trésorerie',
  'programme la prochaine visite lundi',
  'ajoute une dépense de 40 € chez Point P',
  'émets la facture 2026-014',
  'combien je gagne ?',
  'ma trésorerie ?',
  'et le devis Durand ?',
] as const;

/**
 * Faits de terrain : ils ne demandent rien et ne doivent RIEN éteindre. Les quatre derniers sont
 * des HOMOGRAPHES du mode impératif une fois les accents repliés (« rangé/range »,
 * « archivé/archive », « classé/classe », « marqué/marque ») : c'est sur eux que la borne
 * d'« ailleurs » s'armait, et une fin de chantier finissait en « je n'ai pas compris ».
 */
const FAITS = [
  '0 € de pièces',
  'la pression était basse mais c’est réglé',
  'j’y suis resté deux heures',
  'tout est rangé',
  'l’archive est à jour',
  'la classe énergétique est correcte',
  'c’est marqué sur la fiche',
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
  it('les phrases mesurées gardent l’intent du geste réellement demandé', () => {
    const echecs: string[] = [];
    let mesurees = 0;
    for (const annonce of ANNONCES) {
      for (const geste of GESTES_AILLEURS) {
        mesurees += 1;
        const seul = detectIntent(geste);
        const compose = detectIntent(`${annonce}, ${geste}`);
        if (compose !== seul)
          echecs.push(`« ${annonce}, ${geste} » → ${compose} (seul : ${seul})`);
      }
    }
    expect(mesurees).toBeGreaterThanOrEqual(36);
    expect(
      echecs.length === 0 ? '' : `${echecs.length}/${mesurees} détournées :\n${echecs.join('\n')}`,
    ).toBe('');
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
            // La demande qui porte ailleurs est toujours restituée VERBATIM (la ponctuation de
            // liaison, elle, appartient à la découpe — jamais à la citation).
            if (
              ailleurs.length > 0 &&
              !directive.asides.some(
                (aside) => aside.text.length > 3 && ailleurs.startsWith(aside.text),
              )
            )
              raisons.push(`demande « ${ailleurs} » jetée en silence`);
            // Un fait de terrain ne demande rien : il ne doit jamais devenir une demande.
            if (fait.length > 0 && directive.asides.some((aside) => aside.text === fait))
              raisons.push(`fait de terrain « ${fait} » pris pour une demande`);
            if (raisons.length > 0) echecs.push(`« ${phrase} » : ${raisons.join(' ; ')}`);
          }
        }
      }
    }
    expect(mesurees).toBeGreaterThanOrEqual(1000);
    expect(
      echecs.length === 0 ? '' : `${echecs.length}/${mesurees} en échec :\n${echecs.slice(0, 12).join('\n')}`,
    ).toBe('');
  });

  it('DEUX gestes dictés : le premier est retenu, le second est DIT (jamais arbitré)', () => {
    const deux = readInterventionDirective('Envoie la fiche de passage et facture ce passage');
    expect(deux.downstreams).toEqual(['send']);
    expect(deux.asides).toEqual([{ text: 'facture ce passage', kind: 'reporte' }]);
    expect(explainInterventionAsides(deux.asides)).toContain(
      'Je ne traite pas « facture ce passage » dans ce tour',
    );
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
      for (const [nue, attendu] of attendus) {
        // Ces commandes ne sont JAMAIS rejouées nues : Bob y appose son marqueur.
        const commande = markInterventionCommand(nue);
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
    // Classement du modèle en désaccord avec le texte : le tour ne porte QU'UN geste — celui du
    // classement. Deux gestes concurrents ne sont jamais empilés dans la même demande.
    expect(
      interventionRequestFor('send', readInterventionDirective('Facture ce passage')).downstreams,
    ).toEqual(['send']);
  });
});

// ── LE PÉRIMÈTRE, MESURÉ ─────────────────────────────────────────────────────────────────────

describe('périmètre — un FAIT de terrain n’éteint plus rien (homographes participe/impératif)', () => {
  /**
   * Une fois les accents repliés, le participe est le sosie de l'impératif : « rangé/range »,
   * « classé/classe », « marqué/marque », « archivé/archive ». La borne d'« ailleurs » s'armait
   * dessus et éteignait l'annonce de fin — un constat de fin de chantier faisait répondre
   * « je n'ai pas compris » à Bob. Le déterminant tranche : il n'y a pas d'impératif derrière lui.
   */
  it('les huit constats mesurés laissent la fin de passage intacte', () => {
    const constats = [
      'tout est rangé',
      'l’archive est à jour',
      'la classe énergétique est correcte',
      'c’est marqué sur la fiche',
      'le local est classé ERP',
      'les pièces sont archivées',
      'la marque du compresseur est Atlas',
      'la note de service est affichée',
    ];
    const echecs: string[] = [];
    for (const constat of constats) {
      const phrase = `C’est terminé, ${constat}`;
      const directive = readInterventionDirective(phrase);
      if (!directive.announcesCompletion) echecs.push(`« ${phrase} » : annonce de fin perdue`);
      if (directive.gesture !== 'complete')
        echecs.push(`« ${phrase} » : geste ${directive.gesture ?? '∅'} (attendu complete)`);
      if (detectIntent(phrase) !== 'terminer_intervention')
        echecs.push(`« ${phrase} » → ${detectIntent(phrase)}`);
    }
    expect(echecs.length === 0 ? '' : echecs.join('\n')).toBe('');
  });
});

describe('périmètre — la borne s’arme aussi sur une demande INTERROGATIVE ou NOMINALE', () => {
  /**
   * La borne ne regardait qu'une liste de verbes en tête : dès que la seconde demande était une
   * QUESTION ou un simple GROUPE NOMINAL, le routage par l'état redevenait inconditionnel et
   * détournait la demande vers le passage.
   */
  it('« c’est terminé, combien je gagne ? » n’est pas une fin de passage', () => {
    const sansPassage = [
      'combien je gagne ?',
      'ma trésorerie ?',
      'et la facture Durand ?',
      'où en est mon devis ?',
      'mes échéances ?',
    ];
    const echecs: string[] = [];
    for (const demande of sansPassage) {
      const phrase = `C’est terminé, ${demande}`;
      const directive = readInterventionDirective(phrase);
      if (directive.gesture !== null)
        echecs.push(`« ${phrase} » : geste ${directive.gesture} (le passage capte le tour)`);
      if (!directive.divertsElsewhere) echecs.push(`« ${phrase} » : demande non vue`);
      if (detectIntent(phrase) === 'terminer_intervention') echecs.push(`« ${phrase} » → passage`);
    }
    expect(echecs.length === 0 ? '' : echecs.join('\n')).toBe('');
  });

  it('… mais une question SUR LE PASSAGE ne détourne rien', () => {
    const directive = readInterventionDirective('C’est terminé, combien de passages aujourd’hui ?');
    expect(directive.gesture).toBe('complete');
  });
});

describe('périmètre — l’exclusion INTRA-clause a disparu (le complément ouvre sa clause)', () => {
  it('« envoie-lui la fiche de passage avec la facture » envoie la FICHE et DIT le reste', () => {
    const directive = readInterventionDirective('Envoie-lui la fiche de passage avec la facture');
    expect(directive.downstreams).toEqual(['send']);
    expect(directive.asides).toEqual([{ text: 'la facture', kind: 'ailleurs' }]);
    expect(detectIntent('Envoie-lui la fiche de passage avec la facture')).toBe(
      'envoyer_fiche_passage',
    );
  });
});

describe('périmètre — aucun geste certain : Bob POSE UNE QUESTION', () => {
  it('une tournure qui n’ORDONNE rien ne déclenche aucune mutation', () => {
    for (const phrase of [
      'la fiche de passage est à envoyer',
      'le passage Carrefour est à facturer',
      'la fiche de passage serait à faire signer',
    ]) {
      const directive = readInterventionDirective(phrase);
      expect(directive.gesture, phrase).toBeNull();
      expect(directive.needsClarification, phrase).toBe(true);
      expect(directive.downstreams, phrase).toEqual([]);
    }
  });

  it('… et une consigne CLAIRE ne pose jamais la question', () => {
    expect(readInterventionDirective('Envoie la fiche de passage').needsClarification).toBe(false);
    expect(readInterventionDirective('C’est terminé').needsClarification).toBe(false);
  });
});

// ── LE CHEMIN DE L’ARGENT ────────────────────────────────────────────────────────────────────

describe('argent — une facture DIRECTE dictée avec un montant reste une facture directe', () => {
  /**
   * BLOQUANT MESURÉ : la précédence donnée à « le passage » / « la visite » pour rejouer les
   * commandes canoniques faisait sauter la garde du montant. « Facture 380 € à Mme Girard pour
   * la visite » partait vers `facturer_intervention` : le chemin de l'argent, détourné par un
   * mot. Seul un marqueur posé par BOB peut dispenser de cette garde.
   */
  it('les dix phrases du chemin de l’argent gardent leur geste', () => {
    const phrases = [
      'Facture 380 € à Mme Girard pour la visite',
      'Facture 380 € à Mme Girard pour le passage',
      'Facture 380 € à Mme Girard pour cette intervention',
      'Facture 250 € pour le dépannage',
      'Facture 1 200 € TTC à la SCI Bellevue pour la visite',
      'Fais une facture de 380 € pour la visite chez Mme Girard',
      'Facture 380,50 € pour le passage',
      'Facture 90 € HT pour la visite de contrôle',
      'Prépare la facture de 380 € pour la visite',
      'Facture directe de 2 jours de régie pour la visite',
    ];
    const echecs: string[] = [];
    for (const phrase of phrases) {
      const intent = detectIntent(phrase);
      if (intent === 'facturer_intervention') echecs.push(`« ${phrase} » → DÉTOURNÉ vers le passage`);
      if (readInterventionDirective(phrase).downstreams.length > 0)
        echecs.push(`« ${phrase} » : geste de passage lu`);
    }
    expect(echecs.length === 0 ? '' : echecs.join('\n')).toBe('');
    expect(detectIntent('Facture 380 € à Mme Girard pour la visite')).toBe('facture_directe');
  });

  it('la commande canonique MARQUÉE, elle, facture bien le passage (id à chiffres compris)', () => {
    for (const id of ['itv-1', 'a1b2-123e-4567-89ab-000111222333']) {
      const commande = markInterventionCommand(`Facture le passage ${id}`);
      expect(detectIntent(commande), commande).toBe('facturer_intervention');
    }
  });

  it('le marqueur n’est jamais prononçable : sans lui, la même phrase reste une facture directe', () => {
    expect(detectIntent('Facture le passage 380 €')).not.toBe('facturer_intervention');
  });
});

// ── L’OBJET DÉSIGNÉ : une fiche DE PASSAGE, un passage QUI EST UNE VISITE ────────────────────

describe('périmètre — « fiche » et « rapport » ne désignent la fiche du terrain que NUS ou COMPLÉTÉS PAR LE PASSAGE', () => {
  /**
   * Trois consignes SIMPLES — le périmètre que le déterministe DOIT réussir — partaient vers un
   * geste de fiche de passage alors qu'elles parlent d'un document de BUREAU : « fiche » et
   * « rapport » étaient captés quel que soit leur complément, et la paie, la TVA et les états
   * périodiques ne comptaient pas encore parmi les pièces de bureau.
   */
  it('les trois consignes mesurées ne partent plus sur la fiche de passage', () => {
    const bureau = [
      'Envoie la fiche de paie à Marc',
      'Envoie le rapport de TVA au comptable',
      'Envoie le rapport mensuel au comptable',
    ];
    const echecs: string[] = [];
    for (const phrase of bureau) {
      const directive = readInterventionDirective(phrase);
      if (directive.downstreams.length > 0)
        echecs.push(`« ${phrase} » : geste de fiche lu (${directive.downstreams.join('+')})`);
      if (detectIntent(phrase) === 'envoyer_fiche_passage')
        echecs.push(`« ${phrase} » → envoyer_fiche_passage`);
    }
    expect(echecs.length === 0 ? '' : echecs.join('\n')).toBe('');
  });

  it('… et les symétriques LÉGITIMES marchent toujours (le document du passage, nu ou complété)', () => {
    const terrain = [
      'Envoie la fiche de passage',
      'Envoie la fiche',
      'Envoie la fiche au client',
      'Envoie la fiche d’intervention',
      'Envoie le compte rendu',
      'Envoie le compte rendu de passage',
      'Envoie le rapport d’intervention',
      'Envoie le rapport de passage au client',
    ];
    const echecs: string[] = [];
    for (const phrase of terrain) {
      const directive = readInterventionDirective(phrase);
      if (!directive.downstreams.includes('send'))
        echecs.push(`« ${phrase} » : envoi de fiche PERDU (lu : ${directive.downstreams.join('+') || '∅'})`);
      if (detectIntent(phrase) !== 'envoyer_fiche_passage')
        echecs.push(`« ${phrase} » → ${detectIntent(phrase)}`);
    }
    expect(echecs.length === 0 ? '' : echecs.join('\n')).toBe('');
  });
});

describe('périmètre — « le passage » désigne une VISITE, jamais un ouvrage', () => {
  /**
   * « le passage » était reconnu sans regarder ce qui suit : « Facture le passage À NIVEAU de la
   * SNCF » — un ouvrage ferroviaire — devenait une facturation de passage (c'était `unknown`).
   * En français, « nom + à + nom NU » soude un nom COMPOSÉ ; un déterminant, une civilité ou une
   * heure après « à » SITUENT la visite, ils ne la re-qualifient pas.
   */
  it('un nom COMPOSÉ n’est pas une visite (« facture le passage à niveau de la SNCF »)', () => {
    const echecs: string[] = [];
    for (const phrase of ['Facture le passage à niveau de la SNCF', 'Facture le passage à gué']) {
      const directive = readInterventionDirective(phrase);
      if (directive.downstreams.length > 0)
        echecs.push(`« ${phrase} » : geste de passage lu (${directive.downstreams.join('+')})`);
      if (detectIntent(phrase) === 'facturer_intervention')
        echecs.push(`« ${phrase} » → facturer_intervention`);
    }
    expect(echecs.length === 0 ? '' : echecs.join('\n')).toBe('');
  });

  it('… et toute référence qui DÉSIGNE la visite facture toujours ce passage', () => {
    const visites = [
      'Facture ce passage',
      'Facture cette intervention',
      'Facture cette visite',
      'Facture le passage',
      'Facture le passage chez Carrefour',
      'Facture le passage de ce matin',
      // « à » + déterminant / civilité / heure : le complément SITUE la visite ou en nomme le
      // destinataire — il ne la re-qualifie pas.
      'Facture le passage à la SNCF',
      'Facture le passage à Mme Girard',
      'Facture la visite',
    ];
    const echecs: string[] = [];
    for (const phrase of visites) {
      const directive = readInterventionDirective(phrase);
      if (!directive.downstreams.includes('bill'))
        echecs.push(`« ${phrase} » : facturation de passage PERDUE (lu : ${directive.downstreams.join('+') || '∅'})`);
      if (detectIntent(phrase) !== 'facturer_intervention')
        echecs.push(`« ${phrase} » → ${detectIntent(phrase)}`);
    }
    expect(echecs.length === 0 ? '' : echecs.join('\n')).toBe('');
  });
});

// ── COHÉRENCE DES CARTES ─────────────────────────────────────────────────────────────────────

describe('cartes — un texte capté comme RÉSUMÉ n’est jamais déclaré « incompris »', () => {
  it('« note-le : la pression était basse » part sur la fiche, et rien ne le contredit', () => {
    const phrase = 'C’est terminé, note-le : la pression était basse';
    expect(extractInterventionSummary(phrase)).toBe('la pression était basse');
    const directive = readInterventionDirective(phrase);
    expect(directive.asides).toEqual([]);
    expect(explainInterventionAsides(directive.asides)).toBe('');
    expect(directive.gesture).toBe('complete');
  });

  it('… mais une demande qui n’est PAS le résumé reste avouée', () => {
    const directive = readInterventionDirective('C’est terminé, prépare le matériel pour demain');
    expect(directive.asides).toEqual([
      { text: 'prépare le matériel pour demain', kind: 'incompris' },
    ]);
  });
});

// ── UNE SEULE LECTURE DU RÉSUMÉ ──────────────────────────────────────────────────────────────

describe('cartes — UNE SEULE LECTURE du résumé : la pièce de preuve et la carte disent la MÊME chose', () => {
  /**
   * La directive lisait le résumé SANS charnières pendant que l'agent le relisait AVEC (sites et
   * clients résolus). Deux lectures du même message, donc deux vérités dans la même carte. Les
   * deux phrases ci-dessous sont exactement celles où elles divergeaient :
   *
   *   · au-delà de 300 caractères, la lecture SANS charnières renonce (`null`) alors que celle
   *     AVEC s'arrête proprement au nom de client : le texte partait sur la FICHE SIGNÉE et
   *     était déclaré « incompris » dans la MÊME carte ;
   *   · à l'inverse, la lecture SANS charnières avalait la demande voisine dans le résumé — donc
   *     la taisait — alors que celle AVEC n'écrivait RIEN : ni fait, ni dit, ni écrit.
   *
   * Le remède n'est pas un motif : c'est UNE seule lecture, rendue par la directive (`summary`).
   */
  const CHARNIERES = {
    siteNames: ['RATP Bastille', 'Docks Rouen'],
    customerNames: ['RATP CAP', 'Docks SAS'],
  };
  const MONOLOGUE = 'la pression est restée stable toute la matinée '.repeat(7);
  const ECRIT_ET_INCOMPRIS = `J’ai fini, note-le : la pompe est HS, enregistre 12 bars au manomètre, ${MONOLOGUE} pour RATP CAP`;
  const NI_FAIT_NI_DIT = 'J’ai fini, note-le : la pompe est HS chez Docks Rouen, montre-moi ma trésorerie';

  it('la directive REND le résumé qu’elle a lu — mêmes arguments, même résultat', () => {
    for (const phrase of [ECRIT_ET_INCOMPRIS, NI_FAIT_NI_DIT, 'C’est terminé, note-le : joint refait']) {
      expect(readInterventionDirective(phrase, CHARNIERES).summary, phrase).toBe(
        extractInterventionSummary(phrase, CHARNIERES),
      );
    }
  });

  it('ce qui est ÉCRIT sur la pièce de preuve n’est jamais déclaré « incompris » dans la même carte', () => {
    // Les deux lectures d'AVANT, sur la même phrase : elles se contredisaient.
    expect(extractInterventionSummary(ECRIT_ET_INCOMPRIS)).toBeNull();
    expect(extractInterventionSummary(ECRIT_ET_INCOMPRIS, CHARNIERES)).toBe(
      'la pompe est HS, enregistre 12 bars au manomètre',
    );
    const directive = readInterventionDirective(ECRIT_ET_INCOMPRIS, CHARNIERES);
    expect(directive.summary).toBe('la pompe est HS, enregistre 12 bars au manomètre');
    expect(directive.asides).toEqual([]);
    expect(explainInterventionAsides(directive.asides)).toBe('');
  });

  it('… et réciproquement : ce qui n’est PAS écrit sur la fiche est DIT', () => {
    expect(extractInterventionSummary(NI_FAIT_NI_DIT)).toContain('montre-moi ma trésorerie');
    expect(extractInterventionSummary(NI_FAIT_NI_DIT, CHARNIERES)).toBeNull();
    const directive = readInterventionDirective(NI_FAIT_NI_DIT, CHARNIERES);
    expect(directive.summary).toBeNull();
    expect(directive.asides).toEqual([{ text: 'montre-moi ma trésorerie', kind: 'ailleurs' }]);
    expect(explainInterventionAsides(directive.asides)).toContain('montre-moi ma trésorerie');
  });

  it('INVARIANT : aucun aside n’est un morceau du résumé rendu (et le résumé n’avale aucun aside)', () => {
    const phrases = [
      ECRIT_ET_INCOMPRIS,
      NI_FAIT_NI_DIT,
      'C’est terminé, note-le : la pression était basse',
      'J’ai fini chez Docks Rouen, note-le : détartrage complet, envoie la fiche de passage',
      'C’est terminé, note-le : joint refait, encaisse la facture',
      'C’est terminé, prépare le matériel pour demain',
    ];
    const echecs: string[] = [];
    for (const phrase of phrases) {
      const directive = readInterventionDirective(phrase, CHARNIERES);
      const resume = directive.summary;
      if (resume === null) continue;
      for (const aside of directive.asides)
        if (resume.includes(aside.text) || aside.text.includes(resume))
          echecs.push(`« ${phrase} » : « ${aside.text} » écrit sur la fiche ET rendu « ${aside.kind} »`);
    }
    expect(echecs.length === 0 ? '' : echecs.join('\n')).toBe('');
  });
});
