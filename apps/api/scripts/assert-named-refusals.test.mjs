// GARDE ANTI-FAUX-VERT — un refus attendu doit NOMMER la règle qui l'a produit.
//
// LE 29/07, LA CERTIFICATION DES FICHES DE PASSAGE ÉTAIT VERTE POUR UNE RAISON ENTIÈREMENT
// FAUSSE. Hors NODE_ENV=production, Prisma préfixe son message d'un EXTRAIT DU CODE SOURCE
// citant les lignes voisines de l'appel. Pour l'assertion de la ligne 528, cet extrait citait
// la ligne 526 — qui contient littéralement `.rejects.toThrow(/RÈGLE/)`. L'assertion se
// satisfaisait donc de son PROPRE TEXTE SOURCE, jamais de la réponse de la base. Le gate, lui,
// tourne en NODE_ENV=production (errorFormat 'minimal', aucun extrait) : d'où « vert en local,
// rouge au déploiement », et un refus qui ne prouvait plus rien depuis son écriture.
//
// DEUX DÉFENSES, ET IL FAUT LES DEUX :
//  1. une unité de travail par refus attendu — sinon la première erreur avorte la transaction
//     et la suivante n'atteint jamais la base (helper `expectRefused` des certifications) ;
//  2. un motif OBLIGATOIRE et SPÉCIFIQUE sur chaque refus — ce que ce fichier verrouille.
// Un `rejects.toThrow()` nu accepte n'importe quelle erreur, « transaction avortée » comprise :
// il ne prouve rien. Un motif trop large (`/Invalid/`, `/./`, `/Error/`) non plus.
//
// POURQUOI UN CLIQUET PLUTÔT QU'UNE INTERDICTION SÈCHE : le dépôt porte 60 refus nus hérités,
// répartis sur 13 fichiers. Isolés dans leur propre transaction, ils ne produisent pas de faux
// vert — ils prouvent seulement moins qu'ils ne devraient. Les corriger d'un bloc mêlerait une
// refonte de 60 assertions à un correctif de production. La dette est donc GELÉE ici, fichier
// par fichier : aucune nouvelle occurrence ne peut apparaître, et chaque baisse de compteur est
// définitive (le test échoue si un chiffre est laissé au-dessus du réel). La dette ne peut que
// décroître.
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import assert from 'node:assert/strict';

// fileURLToPath, jamais .pathname : un chemin contenant une espace arriverait percent-encodé.
const RACINE_API = fileURLToPath(new URL('..', import.meta.url));
const RACINE_SRC = join(RACINE_API, 'src');

/** Dette HÉRITÉE, gelée au 29/07/2026. Un compteur ne doit JAMAIS croître, et toute baisse se grave ici. */
const DETTE_GELEE = Object.freeze({
  'persistence/prisma/credit-note-traceability.postgres.test.ts': 7,
  'persistence/prisma/devices.postgres.test.ts': 3,
  'persistence/prisma/document-archive-integrity.postgres.test.ts': 15,
  'persistence/prisma/document-archive-rollout.postgres.test.ts': 19,
  'persistence/prisma/expense-creation-requests.postgres.test.ts': 2,
  'persistence/prisma/notification-jobs.postgres.test.ts': 2,
  'persistence/prisma/quote-creation-requests.postgres.test.ts': 2,
  'voice/realtime/mistral-conversation-authority.postgres.test.ts': 1,
  'voice/realtime/mistral-conversation-bootstrap-reaper.postgres.test.ts': 3,
  'voice/realtime/mistral-conversation-bootstrap-ticket.postgres.test.ts': 1,
  'voice/realtime/mistral-conversation-resume-ticket.postgres.test.ts': 1,
  'voice/realtime/realtime-capacity.postgres.test.ts': 3,
  'voice/realtime/realtime-speech.prisma.postgres.test.ts': 1,
});

/** Motifs trop larges : ils resatisfont une transaction avortée, donc ne prouvent rien. */
const MOTIFS_NON_SPECIFIQUES = [/^\/\.[?*]?\/[a-z]*$/i, /^\/Invalid\/[a-z]*$/i, /^\/Error\/[a-z]*$/i];

function certifications(dossier, acc = []) {
  for (const entree of readdirSync(dossier)) {
    if (entree === 'node_modules' || entree === 'dist' || entree === '.turbo') continue;
    const chemin = join(dossier, entree);
    if (statSync(chemin).isDirectory()) certifications(chemin, acc);
    else if (entree.endsWith('.postgres.test.ts')) acc.push(chemin);
  }
  return acc;
}

test('la dette de refus NON NOMMÉS ne croît jamais (cliquet)', () => {
  const reels = {};
  for (const fichier of certifications(RACINE_SRC)) {
    const cle = relative(RACINE_SRC, fichier);
    const n = (readFileSync(fichier, 'utf8').match(/\.rejects\s*\.\s*toThrow\s*\(\s*\)/g) ?? []).length;
    if (n > 0) reels[cle] = n;
  }
  const regressions = [];
  for (const [cle, n] of Object.entries(reels)) {
    const gele = DETTE_GELEE[cle] ?? 0;
    if (n > gele) {
      regressions.push(
        `${cle} : ${n} refus nus contre ${gele} gelés — un refus attendu doit nommer SA règle ` +
          `(trigger, CHECK ou contrainte), sinon il accepte aussi « transaction avortée ».`,
      );
    }
  }
  for (const [cle, gele] of Object.entries(DETTE_GELEE)) {
    const n = reels[cle] ?? 0;
    if (n < gele) {
      regressions.push(
        `${cle} : dette réduite à ${n} (gelé à ${gele}) — merci, grave-le en abaissant DETTE_GELEE.`,
      );
    }
  }
  assert.deepEqual(regressions, [], `\n${regressions.join('\n')}`);
});

test('aucun refus attendu ne se contente d’un motif trop large', () => {
  const fautifs = [];
  for (const fichier of certifications(RACINE_SRC)) {
    readFileSync(fichier, 'utf8')
      .split('\n')
      .forEach((ligne, i) => {
        const motif = /\.rejects\s*\.\s*toThrow\s*\(\s*(\/[^)]*\/[a-z]*)\s*\)/.exec(ligne);
        if (motif && MOTIFS_NON_SPECIFIQUES.some((large) => large.test(motif[1] ?? ''))) {
          fautifs.push(`${relative(RACINE_SRC, fichier)}:${i + 1} — motif ${motif[1]} : ne prouve rien`);
        }
      });
  }
  assert.deepEqual(fautifs, [], `\n${fautifs.join('\n')}`);
});
