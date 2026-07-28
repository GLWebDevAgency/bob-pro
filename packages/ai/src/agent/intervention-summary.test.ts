import { describe, expect, it } from 'vitest';
import { extractInterventionSummary } from './intervention-summary';

/**
 * [Revue adversariale 28/07 — finding 4] Le résumé de passage part sur une PIÈCE DE PREUVE
 * (la fiche signée). L'extraction gloutonne (« tout jusqu'à la fin de la phrase ») y écrivait
 * la mauvaise chose dès que la consigne normative §3.7 enchaînait un geste, nommait le site ou
 * disait la durée.
 *
 * Ce test est un test d'INVARIANT sur un corpus COMBINATOIRE (amorces × résumés × sites ×
 * durées × suites de gestes) : pour chaque consigne, le résumé extrait doit être EXACTEMENT le
 * segment utile, et ne JAMAIS contenir une amorce de geste, un fragment de la consigne
 * suivante, un nom de site déjà résolu, ni une durée/heure déjà extraite. Les échecs sont
 * ÉNUMÉRÉS (jamais un simple « expected true to be false »).
 */

const OUVERTURES = ['J’ai fini', 'C’est terminé', 'Le passage est terminé'] as const;

/** Amorces RÉELLES du résumé dicté — accentuées comme on les dit. */
const AMORCES = ['note-le : ', 'notes : ', 'avec le résumé : ', 'résumé : ', 'note bien : '] as const;

/** Résumés de terrain — aucune amorce de geste, aucun site, aucune durée à l'intérieur. */
const RESUMES = [
  'la pression était basse mais c’est réglé',
  'filtre changé et cuve nettoyée',
  'le détartrage est complet, plus aucun dépôt',
  'joint remplacé, plus de fuite au raccord',
  'la vanne d’arrêt reste dure, à surveiller',
  'groupe froid remis en service, température conforme',
] as const;

const SITES = ['Carrefour Bastille', 'Docks Rouen', 'Tour Montparnasse'] as const;

const DUREES = [
  { intro: 'j’y suis resté', valeur: 'deux heures' },
  { intro: 'ça m’a pris', valeur: '45 minutes' },
  { intro: 'pendant', valeur: '1 h 30' },
] as const;

/** Consignes SUIVANTES : le résumé ne doit jamais en avaler le moindre fragment. */
const SUITES = [
  ' et envoie la fiche au client',
  ' puis facture ce passage',
  ' et fais-le signer',
  ' ensuite envoie le rapport à la compta',
  '',
] as const;

interface Consigne {
  phrase: string;
  attendu: string;
  site: string;
  duree: string;
  suite: string;
}

function buildCorpus(): Consigne[] {
  const corpus: Consigne[] = [];
  let index = 0;
  for (const famille of [0, 1, 2]) {
    for (const amorce of AMORCES) {
      for (const resume of RESUMES) {
        for (const site of SITES) {
          for (const duree of DUREES) {
            for (const suite of SUITES) {
              const ouverture = OUVERTURES[index % OUVERTURES.length]!;
              index += 1;
              const phrase =
                famille === 0
                  ? // Durée AVANT l'amorce (le résumé commence après elle).
                    `${ouverture} chez ${site}, ${duree.intro} ${duree.valeur}, ${amorce}${resume}${suite}.`
                  : famille === 1
                    ? // Durée APRÈS le résumé (piège : elle ne doit pas y entrer).
                      `${ouverture} chez ${site}, ${amorce}${resume}, ${duree.intro} ${duree.valeur}${suite}.`
                    : // Site rappelé APRÈS le résumé (autre piège du même ordre).
                      `${ouverture} ${duree.intro} ${duree.valeur}, ${amorce}${resume}, c’est chez ${site}${suite}.`;
              corpus.push({
                phrase,
                attendu: resume,
                site,
                duree: duree.valeur,
                suite: suite.trim(),
              });
            }
          }
        }
      }
    }
  }
  return corpus;
}

const CORPUS = buildCorpus();

function normaliser(value: string): string {
  return value
    .normalize('NFD')
    .replace(/\p{Diacritic}/gu, '')
    .replace(/[’‘]/g, "'")
    .toLowerCase();
}

/** Amorces de GESTE : leur présence dans un résumé signifie qu'une consigne a été avalée. */
const GESTES = [
  'envoie',
  'envoyer',
  'transmets',
  'transmettre',
  'adresse',
  'expedie',
  'facture',
  'facturer',
  'signer',
  'signe',
  'demarre',
  'demarrer',
  'commence',
  'prepare',
  'relance',
  'encaisse',
];

/** Durées/heures : le résumé n'en porte JAMAIS (elles sont extraites par ailleurs). */
const MOTIF_DUREE =
  /\b\d{1,3}\s*h(?:\s*\d{2})?\b|\b\d{1,3}\s*(?:heures?|minutes?|mins?|min)\b|\b(?:une|deux|trois|quatre|cinq|six|sept|huit|neuf|dix|douze|quinze|vingt|trente|quarante|cinquante)\s+(?:heures?|minutes?)\b|\bdemi[- ]heure\b/;

function motsSignificatifs(value: string): string[] {
  return normaliser(value)
    .split(/[^a-z0-9]+/)
    .filter((mot) => mot.length >= 4);
}

describe('§3.7 — extraction du résumé de passage par CONSTRUCTION (finding 4)', () => {
  it(`le corpus combinatoire est représentatif (${CORPUS.length} consignes)`, () => {
    expect(CORPUS.length).toBeGreaterThanOrEqual(150);
    // Aucune consigne dégénérée : chaque phrase porte bien son résumé et sa charnière.
    for (const consigne of CORPUS.slice(0, 5)) {
      expect(consigne.phrase).toContain(consigne.attendu);
    }
  });

  it('INVARIANT : le résumé est le segment utile, et RIEN d’autre', () => {
    const sites = [...SITES];
    const echecs: string[] = [];

    for (const consigne of CORPUS) {
      const resume = extractInterventionSummary(consigne.phrase, {
        siteNames: sites,
        customerNames: ['RATP CAP', 'Carrefour SA'],
      });
      const raisons: string[] = [];
      if (resume === null) {
        raisons.push('résumé NON extrait');
      } else {
        const normalise = normaliser(resume);
        if (resume !== consigne.attendu) raisons.push(`≠ attendu « ${consigne.attendu} »`);
        const geste = GESTES.find((mot) => new RegExp(`\\b${mot}\\b`).test(normalise));
        if (geste !== undefined) raisons.push(`amorce de geste « ${geste} »`);
        if (consigne.suite.length > 0) {
          const fragment = motsSignificatifs(consigne.suite).find((mot) =>
            normalise.includes(mot),
          );
          if (fragment !== undefined) raisons.push(`fragment de la consigne suivante « ${fragment} »`);
        }
        const nomDeSite = sites
          .flatMap((site) => motsSignificatifs(site))
          .find((mot) => normalise.includes(mot));
        if (nomDeSite !== undefined) raisons.push(`nom de site résolu « ${nomDeSite} »`);
        if (MOTIF_DUREE.test(normalise)) raisons.push(`durée/heure « ${consigne.duree} »`);
      }
      if (raisons.length > 0) {
        echecs.push(`« ${consigne.phrase} » → « ${resume ?? '∅'} » : ${raisons.join(' ; ')}`);
      }
    }

    // ÉNUMÉRATION explicite : la revue doit lire ce qui casse, pas un booléen.
    expect(
      echecs.length === 0
        ? ''
        : `${echecs.length}/${CORPUS.length} consignes en échec :\n${echecs.slice(0, 12).join('\n')}`,
    ).toBe('');
  });

  it('aucune amorce = aucun résumé inventé (le silence est une réponse honnête)', () => {
    expect(extractInterventionSummary('J’ai fini chez Carrefour Bastille')).toBeNull();
    expect(
      extractInterventionSummary('C’est terminé, envoie la fiche au client', {
        siteNames: ['Carrefour Bastille'],
      }),
    ).toBeNull();
  });

  it('borne haute : un monologue n’écrit pas 4 000 caractères sur une pièce de preuve', () => {
    const long = `C’est terminé, note-le : ${'la pression était basse '.repeat(40)}`;
    const resume = extractInterventionSummary(long);
    expect(resume === null || resume.length <= 300).toBe(true);
  });
});
