// GARDE — aucun octet de contrôle BRUT dans un fichier source suivi.
//
// LE DÉFAUT QU'ELLE EMPÊCHE, constaté sur ce dépôt le 20/08/2026. Une classe de regex écrite avec
// les octets eux-mêmes, invisibles à l'écran, au lieu de leurs échappements
// (`[\\u0000-\\u001f\\u007f]`) s'exécute EXACTEMENT pareil : aucun test ne rougit, aucun type ne
// bronche, la revue de code ne voit rien. Mais git classe alors le fichier BINAIRE :
//
//   · `git diff` n'affiche plus qu'une taille (« Bin 0 -> 8066 bytes ») — la revue ne voit
//     littéralement JAMAIS le contenu, et un changement de logique y passe inaperçu ;
//   · `grep` refuse le fichier en SILENCE (sortie vide, code 1) — chercher un symbole qui s'y
//     trouve deux fois ne rend rien, sans le moindre avertissement ;
//   · une fusion à trois branches perd son découpage par ligne : le moindre conflit se règle
//     fichier entier.
//
// Huit fichiers suivis en portaient, dont un module de domaine neuf et sa suite de preuves. Le
// coût de la rechute est invisible, donc élevé : la seule défense qui tienne est mécanique.
//
// CE QUI EST TOLÉRÉ : tabulation, saut de ligne, retour chariot — les seuls contrôles qui aient un
// sens dans du texte. Tout le reste s'écrit échappé, ce qui produit la MÊME valeur à l'exécution :
// la garde ne coûte rien d'autre qu'une notation lisible.
//
// CE QUI N'EST PAS EXAMINÉ : les fichiers légitimement binaires (images, polices, PDF), reconnus
// par extension. Allonger cette liste doit rester un geste conscient.
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import assert from 'node:assert/strict';

// fileURLToPath, jamais .pathname : un chemin contenant une espace arriverait percent-encodé.
const RACINE_DEPOT = fileURLToPath(new URL('../../..', import.meta.url));

/** Extensions dont le contenu binaire est la nature même : jamais lues par un humain. */
const EXTENSIONS_BINAIRES = new Set([
  'png',
  'jpg',
  'jpeg',
  'gif',
  'webp',
  'ico',
  'icns',
  'pdf',
  'ttf',
  'otf',
  'woff',
  'woff2',
  'eot',
  'mp3',
  'mp4',
  'mov',
  'wav',
  'zip',
  'gz',
  'jar',
  'keystore',
  'p8',
  'p12',
]);

/** Contrôles ACCEPTÉS dans du texte : tabulation, saut de ligne, retour chariot. */
const TOLERES = new Set([0x09, 0x0a, 0x0d]);

function estBinaireParExtension(chemin) {
  const base = chemin.slice(chemin.lastIndexOf('/') + 1);
  const point = base.lastIndexOf('.');
  if (point <= 0) return base === '.DS_Store';
  return EXTENSIONS_BINAIRES.has(base.slice(point + 1).toLowerCase());
}

/** Rend les emplacements fautifs, ligne par ligne : le message doit dire QUOI corriger et OÙ. */
export function trouverOctetsDeControle(contenu) {
  const fautes = [];
  let ligne = 1;
  let colonne = 1;
  for (const octet of contenu) {
    if (octet === 0x0a) {
      ligne += 1;
      colonne = 1;
      continue;
    }
    if ((octet < 0x20 || octet === 0x7f) && !TOLERES.has(octet)) {
      fautes.push({ ligne, colonne, octet });
    }
    colonne += 1;
  }
  return fautes;
}

/** Fichiers SUIVIS uniquement : `node_modules` et les `dist` n'ont jamais à être jugés. */
export function fichiersSuivis(racine) {
  return execFileSync('git', ['-C', racine, 'ls-files', '-z'], { encoding: 'buffer' })
    .toString('utf8')
    .split('\u0000')
    .filter((chemin) => chemin.length > 0);
}

export function scannerSourcesSuivies(racine) {
  const violations = [];
  for (const chemin of fichiersSuivis(racine)) {
    if (estBinaireParExtension(chemin)) continue;
    let contenu;
    try {
      contenu = readFileSync(`${racine}/${chemin}`);
    } catch {
      // Lien symbolique cassé ou fichier absent du working tree : hors du ressort de cette garde.
      continue;
    }
    const fautes = trouverOctetsDeControle(contenu);
    if (fautes.length > 0) violations.push({ chemin, fautes });
  }
  return violations;
}

test('aucun fichier source suivi ne porte d’octet de contrôle brut', () => {
  const violations = scannerSourcesSuivies(RACINE_DEPOT);
  const detail = violations
    .flatMap(({ chemin, fautes }) =>
      fautes.slice(0, 5).map(({ ligne, colonne, octet }) => {
        const echappe = `\\u${octet.toString(16).padStart(4, '0')}`;
        return `${chemin}:${ligne}:${colonne} — octet 0x${octet
          .toString(16)
          .padStart(2, '0')} ; écris ${echappe}`;
      }),
    )
    .join('\n');
  assert.equal(
    violations.length,
    0,
    `Octets de contrôle BRUTS dans des sources suivies : git les classe binaires, la revue ne les\n` +
      `voit plus et grep devient silencieusement aveugle. Écris-les échappés — valeur identique.\n${detail}`,
  );
});

test('le détecteur MORD : il voit ce que git verrait, et laisse passer ce qui est légitime', () => {
  // Sans cette preuve, la garde pourrait ne rien détecter du tout et rester verte à jamais.
  // Les octets sont FABRIQUÉS, jamais écrits : ce fichier respecte la règle qu'il impose.
  const nul = String.fromCharCode(0x00);
  const us = String.fromCharCode(0x1f);
  const fautif = Buffer.from(`const a = /[${nul}-${us}]/;\nconst b = 1;\n`, 'utf8');
  const fautes = trouverOctetsDeControle(fautif);
  assert.equal(fautes.length, 2);
  assert.deepEqual(
    fautes.map((faute) => faute.octet),
    [0x00, 0x1f],
  );
  assert.equal(fautes[0].ligne, 1);

  // La forme ÉCHAPPÉE — celle qu'on exige — passe, et c'est bien la même valeur à l'exécution.
  const sain = Buffer.from('const a = /[\\u0000-\\u001f]/;\n\tconst b = 1;\r\n', 'utf8');
  assert.deepEqual(trouverOctetsDeControle(sain), []);
});

test('les binaires légitimes sont écartés par extension, pas par devinette de contenu', () => {
  for (const chemin of ['apps/mobile/assets/icon.png', 'a/b/Font.TTF', 'design/.DS_Store']) {
    assert.equal(estBinaireParExtension(chemin), true, chemin);
  }
  for (const chemin of ['packages/core/src/index.ts', 'scripts/run.mjs', 'README.md', 'Makefile']) {
    assert.equal(estBinaireParExtension(chemin), false, chemin);
  }
});
