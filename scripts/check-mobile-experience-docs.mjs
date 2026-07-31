#!/usr/bin/env node
/**
 * Validateur du socle documentaire `docs/mobile-experience` (A27 · 2026-07-30).
 *
 * POURQUOI. Le socle est une autorité : ses chiffres conditionnent le code visuel à venir.
 * Jusqu'ici il ne portait AUCUN contrôle exécutable — 11 § Tests statiques listait des
 * contrôles « à écrire » que des work packages citaient déjà comme preuves de sortie. Ce
 * script ne remplace pas cette liste : il ferme les quatre familles d'erreurs que le dossier
 * a réellement commises, celles où un document affirme un fait que le dépôt contredit.
 *
 * CE QU'IL VÉRIFIE
 *   C1  Les versions SDK citées par 17 § Versions réellement intégrées == apps/mobile/package.json.
 *   C2  Aucune mention d'un SDK périmé (Expo 56 / RN 0.85) sans marqueur de supersession.
 *   C3  Les constantes livrées citées par 17 § Autorités normatives == le code de packages/ui.
 *   C4  La table de contraste de 04 § 2 recalculée depuis packages/tokens (WCAG 2.x).
 *   C5  PERF-13 est bien dans la stratégie exécutable de 11 § Performance.
 *   C6  Aucun lien `docs.expo.dev/versions/latest` : une URL qui change sans changer d'adresse
 *       ne peut pas être une source pinée.
 *   C7  Toutes les ancres de liens internes du socle résolvent vers un titre réel.
 *   C8  Intégrité des tableaux Markdown (A28) : aucune ligne vide ne coupe un tableau, et toutes
 *       ses lignes ont le même nombre de colonnes. Défaut invisible à la relecture et fatal au
 *       rendu — en GFM un tableau se termine à la première ligne vide, et un `|` non échappé
 *       (y compris dans un `code span`) ajoute une colonne fantôme qui tronque la ligne.
 *   C9  Affirmations d'ABSENCE de chemin (A28) : « pas de répertoire `x/` » est faux si `x/`
 *       existe. C'est la famille d'erreur exacte qu'A27 a commise en écrivant « pas de répertoire
 *       `scripts/` » dans le commit qui créait `scripts/`. ÉLARGI A30 : la formulation SANS nom de
 *       chose — « aucun `scripts/` » — passait au travers ; c'est précisément celle qui avait
 *       survécu dans la colonne « Source » de la rangée A27 du journal.
 *   C10 Affirmations d'ABSENCE de dépendance (A28) : « absents de tous les `package.json` » est
 *       faux si l'un des paquets nommés y figure.
 *   C11 Bornes d'amendements (A30) : toute borne « A1 → AN » écrite dans le socle vaut le dernier
 *       amendement RÉELLEMENT déclaré au journal. Le socle en portait deux valeurs différentes
 *       dans le même fichier — dont l'une, trois mots avant la phrase qui met en garde contre les
 *       énumérations recopiées.
 *   C12 Index d'amendements (A30) : si le journal déclare qu'un amendement touche un document,
 *       l'encadré de tête de ce document le cite. Sinon la règle existe mais reste introuvable là
 *       où elle s'applique — cas d'A18, absent de l'index de 04 alors qu'il l'amende en trois
 *       endroits. Une énumération recopiée n'est admissible que si un contrôle la tient.
 *
 * CE QU'IL NE VÉRIFIE PAS. Les gardes d'import, la matrice de routes, les IDs de traçabilité :
 * ce sont d'autres contrôles, à écrire avec les lots qui en ont besoin. C12 vérifie la PRÉSENCE
 * d'un identifiant dans l'encadré de tête, pas l'exactitude de la portée qui y est décrite.
 *
 * USAGE   node scripts/check-mobile-experience-docs.mjs
 * SORTIE  0 = conforme, 1 = au moins un écart. Aucune dépendance, aucun accès réseau.
 * NON BRANCHÉ à turbo ni à la CI : le brancher est une décision de gouvernance (13), pas
 * d'auteur de document.
 */
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const read = (p) => readFileSync(join(ROOT, p), 'utf8');

const failures = [];
const checks = [];
const fail = (id, message) => failures.push(`${id} — ${message}`);
const ok = (id, message) => checks.push(`${id} — ${message}`);

const SOCLE = [
  '00-audit-baseline.md', '01-experience-vision.md', '02-roadmap.md',
  '03-motion-interaction-system.md', '04-navigation-scroll-surfaces.md',
  '05-bob-live-experience.md', '06-screen-by-screen-spec.md', '07-content-design.md',
  '08-accessibility-adaptive-design.md', '09-technical-architecture.md',
  '10-performance-observability.md', '11-test-strategy.md', '12-definition-of-done.md',
  '13-delivery-governance.md', '14-risk-register.md', '15-traceability-matrix.md',
  '16-implementation-backlog.md', '17-references.md', '18-evidence-register.md',
  '19-glossary.md', 'README.md',
  'adr/README.md', 'adr/UX-ADR-001-motion-runtime.md', 'adr/UX-ADR-002-navigation-surfaces.md',
  'adr/UX-ADR-003-bob-live-visual-projection.md', 'adr/UX-ADR-004-adaptive-appearance.md',
  'adr/UX-ADR-005-performance-observability.md', 'adr/UX-ADR-006-haptic-feedback.md',
].map((f) => `docs/mobile-experience/${f}`);

// ── C1 · versions SDK ────────────────────────────────────────────────────────
const pkg = JSON.parse(read('apps/mobile/package.json'));
const refs = read('docs/mobile-experience/17-references.md');
const clean = (v) => String(v).replace(/^[~^]/, '');
const EXPECTED = {
  expo: clean(pkg.dependencies.expo),
  'react-native': clean(pkg.dependencies['react-native']),
  react: clean(pkg.dependencies.react),
  'expo-router': clean(pkg.dependencies['expo-router']),
};
for (const [name, version] of Object.entries(EXPECTED)) {
  if (refs.includes(`**${version}**`)) ok('C1', `${name} ${version} cité par 17`);
  else fail('C1', `17 § Versions réellement intégrées ne cite pas ${name} ${version} (apps/mobile/package.json)`);
}

// ── C2 · dérive de SDK ───────────────────────────────────────────────────────
// Règle éditoriale : on ne cite un SDK périmé que BARRÉ (`~~`), entre GUILLEMETS (« … »),
// ou sur une ligne qui porte explicitement sa supersession. Sans cela, un lecteur pressé
// prend la citation pour une prescription — c'est exactement ce qui a produit A25.
const STALE = [/Expo\s*(?:SDK\s*)?56\b/, /RN\s*0\.85\b/, /React Native 0\.85\b/, /Expo Router 56\b/];
const SUPERSEDED = /~~|«|corrigé A25|actualisé A25|supersédée|Rédaction|périmé|remplace|ne doit plus/i;
for (const file of [...SOCLE, 'design_handoff_bob_pro/RN_EXPO_GUIDE.md']) {
  read(file).split('\n').forEach((line, i) => {
    if (STALE.some((re) => re.test(line)) && !SUPERSEDED.test(line)) {
      fail('C2', `${file}:${i + 1} cite un SDK périmé sans marqueur de supersession`);
    }
  });
}
ok('C2', 'aucune mention active d’Expo 56 / RN 0.85');

// ── C3 · constantes livrées ──────────────────────────────────────────────────
const num = (src, name) => {
  const m = src.match(new RegExp(`${name}\\s*=\\s*([0-9.]+)`));
  if (!m) throw new Error(`constante ${name} introuvable dans le code`);
  return m[1];
};
const toast = read('packages/ui/src/components/toast.tsx');
const buttonLogic = read('packages/ui/src/components/button.logic.ts');
const pressable = read('packages/ui/src/components/pressable-scale.logic.ts');
const DELIVERED = [
  ['Toast entrée', num(toast, 'ENTER_MS'), '**200 ms**'],
  ['Toast sortie', num(toast, 'EXIT_MS'), '**180 ms**'],
  ['Toast auto-dismiss', num(toast, 'AUTO_DISMISS_MS'), '**2 400 ms**'],
  ['Button échelle', num(buttonLogic, 'BUTTON_PRESSED_SCALE'), '**0,94 instantanée**'],
  ['Button hauteur', num(buttonLogic, 'BUTTON_MIN_HEIGHT'), '`BUTTON_MIN_HEIGHT = 48`'],
  ['PressableScale in', num(pressable, 'PRESSABLE_SCALE_IN_MS'), '**90 ms**'],
  ['PressableScale out', num(pressable, 'PRESSABLE_SCALE_OUT_MS'), '**150 ms**'],
];
const EXPECT_VALUE = { '200': 200, '180': 180, '2400': 2400, '0.94': 0.94, '48': 48, '90': 90, '150': 150 };
for (const [label, value, citation] of DELIVERED) {
  if (!(value in EXPECT_VALUE)) fail('C3', `${label} : le code vaut ${value}, valeur non prévue par 17`);
  else if (!refs.includes(citation)) fail('C3', `${label} : 17 ne cite pas « ${citation} » alors que le code vaut ${value}`);
  else ok('C3', `${label} = ${value}, cité tel quel par 17`);
}

// ── C4 · table de contraste de 04 § 2 ────────────────────────────────────────
const lin = (c) => { const s = c / 255; return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4; };
const luminance = (hex) => {
  const n = parseInt(hex.slice(1), 16);
  return 0.2126 * lin((n >> 16) & 255) + 0.7152 * lin((n >> 8) & 255) + 0.0722 * lin(n & 255);
};
const ratio = (a, b) => {
  const [x, y] = [luminance(a), luminance(b)];
  return (Math.max(x, y) + 0.05) / (Math.min(x, y) + 0.05);
};
const nav = read('docs/mobile-experience/04-navigation-scroll-surfaces.md');
// Lignes « | `ton` `#HEX` | r | r | **r** | verdict | » de la table A23 (dans une citation `> `).
const ROW = /^>?\s*\|\s*`[a-z.]+`\s*`(#[0-9A-F]{6})`\s*\|\s*([\d,]+)\s*\|\s*([\d,]+)\s*\|\s*\*\*([\d,]+)\*\*\s*\|\s*(.+?)\s*\|$/gm;
const ROLES = ['#0C2340', '#4338CA', '#5B6B7B'];
let rows = 0;
for (const m of nav.matchAll(ROW)) {
  rows += 1;
  const bg = m[1];
  const printed = [m[2], m[3], m[4]].map((v) => Number(v.replace(',', '.')));
  ROLES.forEach((role, i) => {
    const actual = ratio(role, bg);
    if (Math.abs(actual - printed[i]) > 0.011) {
      fail('C4', `04 § 2 : ${role} sur ${bg} annoncé ${printed[i]} mais vaut ${actual.toFixed(2)}`);
    }
  });
  const passes = ROLES.every((role) => ratio(role, bg) >= 4.5);
  const verdictSaysAA = m[5].replace(/\*/g, '').trim() === 'AA';
  if (passes !== verdictSaysAA) {
    fail('C4', `04 § 2 : verdict « ${m[5]} » incohérent pour ${bg} (min = ${Math.min(...ROLES.map((r) => ratio(r, bg))).toFixed(2)})`);
  }
}
if (rows < 6) fail('C4', `04 § 2 : ${rows} ligne(s) de contraste lue(s), 6 attendues — la table a bougé`);
else ok('C4', `${rows} couples de contraste recalculés et conformes`);

// ── C5 · PERF-13 dans la stratégie exécutable ────────────────────────────────
const tests = read('docs/mobile-experience/11-test-strategy.md');
if (/scénarios `PERF-01` à \*\*`PERF-13`\*\*/.test(tests)) ok('C5', 'PERF-13 est dans 11 § Performance');
else fail('C5', '11 § Performance n’inclut pas PERF-13 dans les scénarios à exécuter');

// ── C6 · sources externes pinées ─────────────────────────────────────────────
let latest = 0;
for (const file of SOCLE) {
  read(file).split('\n').forEach((line, i) => {
    if (line.includes('docs.expo.dev/versions/latest')) {
      latest += 1;
      fail('C6', `${file}:${i + 1} pointe une URL « latest » : source non pinée`);
    }
  });
}
if (latest === 0) ok('C6', 'toutes les URLs Expo du socle sont pinées sur une version');

// ── C7 · ancres de liens internes ────────────────────────────────────────────
// Un renvoi cassé transforme une règle en affirmation invérifiable : le lecteur qui veut
// remonter à l'autorité tombe en haut du fichier et croit la règle absente.
// Slugification GitHub : la ponctuation disparaît mais les espaces qui l'entouraient
// restent — « a — b » donne `a--b`. Remplacer `\s+` d'un coup produirait `a-b` et ferait
// passer pour cassées des ancres correctes.
const slug = (heading) => heading
  .toLowerCase()
  .replace(/[^\p{L}\p{N}\s-]/gu, '')
  .trim()
  .replace(/\s/g, '-');
const headings = new Map();
const ALL = [...SOCLE, 'design_handoff_bob_pro/RN_EXPO_GUIDE.md'];
for (const file of ALL) {
  const set = new Set();
  const src = read(file);
  for (const m of src.matchAll(/^#{1,6}\s+(.+?)\s*$/gm)) set.add(slug(m[1]));
  // Ancres HTML explicites (`<a id="s01"></a>`), employées par 06 pour les 33 écrans.
  for (const m of src.matchAll(/<a\s+(?:id|name)="([^"]+)"/g)) set.add(m[1].toLowerCase());
  headings.set(file, set);
}
const LINK = /\]\(([^)\s]+?)#([^)\s]+?)\)/g;
let anchors = 0;
for (const file of ALL) {
  const dir = dirname(file);
  read(file).split('\n').forEach((line, i) => {
    for (const m of line.matchAll(LINK)) {
      const [, target, fragment] = m;
      if (target.startsWith('http')) continue;
      const resolved = join(dir, target).replace(/\\/g, '/');
      const known = headings.get(resolved);
      if (!known) continue; // fichier hors périmètre du validateur
      anchors += 1;
      if (!known.has(decodeURIComponent(fragment))) {
        fail('C7', `${file}:${i + 1} renvoie à ${target}#${fragment} — aucun titre ne porte cette ancre`);
      }
    }
  });
}
ok('C7', `${anchors} ancres de liens internes vérifiées`);

// ── C8 · intégrité des tableaux Markdown ─────────────────────────────────────
// Deux défauts fatals au rendu et invisibles à la relecture, tous deux commis par ce dossier :
//   (a) une LIGNE VIDE au milieu d'un tableau. En GFM le tableau se termine là : les rangées
//       suivantes s'affichent en texte brut. C'est ce qui sortait A17→A27 du journal des
//       amendements et R43/R44 du registre des risques.
//   (b) un `|` NON ÉCHAPPÉ dans une cellule — y compris à l'intérieur d'un `code span`, où GFM
//       le traite quand même comme un séparateur. La colonne surnuméraire tronque la ligne.
// Un tableau peut légitimement en suivre un autre après une ligne vide : ce cas se reconnaît à
// la présence d'une ligne de délimiteurs (`| --- |`) juste après la reprise. On ne le compte pas.
const quotePrefix = (line) => (line.match(/^\s*(?:>\s*)*/) ?? [''])[0].replace(/\s/g, '');
const isTableLine = (line) => /^\s*(?:>\s*)*\|/.test(line);
const isBlankish = (line) => /^\s*(?:>\s*)*$/.test(line);
const isDelimiter = (line) => /^\s*(?:>\s*)*\|(?:\s*:?-{3,}:?\s*\|)+\s*$/.test(line);
// Colonnes = nombre de `|` non échappés, moins les deux bordures.
const columns = (line) => {
  const body = line.replace(/^\s*(?:>\s*)*/, '');
  let count = 0;
  for (let i = 0; i < body.length; i += 1) {
    if (body[i] === '|' && body[i - 1] !== '\\') count += 1;
  }
  return count - 1;
};
// Deux passes indépendantes : la passe (b) saute d'un bloc de tableau à l'autre, elle ne peut
// donc pas porter aussi la passe (a), qui doit visiter CHAQUE rangée. Les mélanger avait produit
// un contrôle muet — vérifié par test négatif avant de le déclarer vert.
let tables = 0;
for (const file of ALL) {
  const lines = read(file).split('\n');

  // (a) coupure par ligne vide — chaque rangée est visitée
  for (let i = 0; i < lines.length; i += 1) {
    if (!isTableLine(lines[i])) continue;
    let j = i + 1;
    while (j < lines.length && isBlankish(lines[j])) j += 1;
    if (j > i + 1 && j < lines.length && isTableLine(lines[j])
        && quotePrefix(lines[j]) === quotePrefix(lines[i])
        && !isDelimiter(lines[j + 1] ?? '')) {
      fail('C8', `${file}:${i + 2} — ligne vide au milieu d’un tableau : la rangée ${j + 1} sort du tableau au rendu`);
    }
  }

  // (b) largeur constante, mesurée sur la ligne de délimiteurs
  for (let i = 0; i < lines.length; i += 1) {
    if (!isTableLine(lines[i]) || !isDelimiter(lines[i + 1] ?? '')) continue;
    tables += 1;
    const width = columns(lines[i]);
    let k = i;
    while (k < lines.length && isTableLine(lines[k]) && quotePrefix(lines[k]) === quotePrefix(lines[i])) {
      if (columns(lines[k]) !== width) {
        fail('C8', `${file}:${k + 1} — ${columns(lines[k])} colonnes au lieu de ${width} (un « | » non échappé ajoute une colonne, même dans un code span)`);
      }
      k += 1;
    }
    i = k - 1;
  }
}
ok('C8', `${tables} tableaux Markdown vérifiés — aucune coupure, largeur constante`);

// ── C9 · affirmations d'absence de chemin ────────────────────────────────────
// A27 a écrit « vérifié le 2026-07-30 : pas de répertoire `scripts/` » DANS le commit qui créait
// `scripts/check-mobile-experience-docs.mjs`. Une affirmation d'absence est un fait de dépôt : elle
// se vérifie comme les autres.
// (élargi A30) La formulation SANS nom de chose — « aucun `scripts/`, aucun job CI » — passait au
// travers du premier motif, qui exige « répertoire|dossier|fichier|script » avant le backtick.
// C'est exactement la phrase qui a survécu dans la colonne « Source » de la rangée A27, après
// qu'A28 l'eut soldée ailleurs. Le troisième motif la couvre, MAIS il exige que la chose nommée
// contienne un `/` : sans cette borne il attrapait « aucun `package.json` du dépôt ne déclare ces
// paquets » (A24), qui est une affirmation d'absence de DÉPENDANCE — le domaine de C10, pas de C9.
const ABSENCE = [
  /(?:pas|aucun|absence)\s+(?:de\s+)?(?:répertoire|dossier|fichier|script)\s+`([^`]+)`/gi,
  /`([^`]+)`\s+n[’']existe\s+pas\s+(?:encore\s+)?dans\s+le\s+dépôt/gi,
  /(?:aucune?|pas\s+de)\s+`([\w@.-]*\/[\w@./-]*)`/gi,
];
// Même convention éditoriale que C2 : une affirmation d'absence PÉRIMÉE peut rester citée, à
// condition de porter sa supersession sur la même ligne. Les guillemets seuls ne suffisent pas —
// c'est justement sous guillemets qu'une phrase fausse se recopie sans être requalifiée.
const ABSENCE_SUPERSEDED = /~~|supersédée?|Rédaction A\d|corrigé A\d|rectifié A\d|\bfausse\b/i;
let claims = 0;
for (const file of ALL) {
  read(file).split('\n').forEach((line, i) => {
    if (ABSENCE_SUPERSEDED.test(line)) return;
    for (const re of ABSENCE) {
      re.lastIndex = 0;
      for (const m of line.matchAll(re)) {
        const target = m[1].trim();
        if (!/^[\w@./-]+$/.test(target)) continue; // pas un chemin : on ne devine pas
        claims += 1;
        if (existsSync(join(ROOT, target))) {
          fail('C9', `${file}:${i + 1} affirme l’absence de « ${target} » — ce chemin EXISTE dans le dépôt`);
        }
      }
    }
  });
}
ok('C9', `${claims} affirmation(s) d’absence de chemin vérifiée(s) contre le dépôt`);

// ── C10 · affirmations d'absence de dépendance ───────────────────────────────
const manifests = [];
(function walk(dir) {
  for (const entry of readdirSync(dir)) {
    if (entry === 'node_modules' || entry === '.git' || entry.startsWith('dist')) continue;
    const p = join(dir, entry);
    if (statSync(p).isDirectory()) walk(p);
    else if (entry === 'package.json') manifests.push(p);
  }
})(ROOT);
const declared = new Set();
for (const p of manifests) {
  const m = JSON.parse(readFileSync(p, 'utf8'));
  for (const field of ['dependencies', 'devDependencies', 'peerDependencies']) {
    for (const name of Object.keys(m[field] ?? {})) declared.add(name);
  }
}
let absents = 0;
for (const file of ALL) {
  read(file).split('\n').forEach((line, i) => {
    if (!/absent[es]?\s+de\s+tous\s+les\s+`package\.json`/i.test(line)) return;
    const names = [...line.matchAll(/`([a-z0-9@][\w@./-]*)`/gi)]
      .map((m) => m[1])
      .filter((n) => n !== 'package.json');
    for (const name of names) {
      absents += 1;
      if (declared.has(name)) {
        fail('C10', `${file}:${i + 1} déclare « ${name} » absent de tous les package.json — il y est déclaré`);
      }
    }
  });
}
ok('C10', `${absents} dépendance(s) déclarée(s) absente(s) vérifiée(s) sur ${manifests.length} package.json`);

// ── journal des amendements : source unique pour C11 et C12 ──────────────────
// Le tableau du README est l'autorité sur QUELS documents un amendement touche ; l'encadré de
// chaque fichier est l'autorité sur OÙ il l'amende. Les deux contrôles ci-dessous ne font que
// tenir cette répartition, qu'aucun humain ne peut relire à chaque amendement.
const README = 'docs/mobile-experience/README.md';
const journal = read(README);
// Cellules d'une rangée Markdown, coupées sur les `|` NON échappés (même règle que C8).
const cells = (row) => {
  const out = [];
  let current = '';
  for (let i = 0; i < row.length; i += 1) {
    if (row[i] === '|' && row[i - 1] !== '\\') { out.push(current); current = ''; } else current += row[i];
  }
  out.push(current);
  return out.slice(1, -1).map((c) => c.trim());
};
const amendments = [];
for (const line of journal.split('\n')) {
  const m = /^\|\s*\*\*A(\d+)\*\*\s*\|/.exec(line);
  if (!m) continue;
  const parts = cells(line);
  amendments.push({ id: `A${m[1]}`, n: Number(m[1]), touched: parts[parts.length - 1] ?? '' });
}
if (amendments.length === 0) fail('C11', `${README} : aucune rangée d’amendement lue — le journal a changé de forme`);
const lastAmendment = Math.max(0, ...amendments.map((a) => a.n));

// ── C11 · bornes d'amendements ───────────────────────────────────────────────
// « A1 → A27 » écrit trois mots avant « une énumération recopiée devient fausse au premier
// amendement suivant », dans un fichier dont l'en-tête disait « A1 → A29 ».
// DEUX EXCLUSIONS, toutes deux nécessaires et toutes deux vérifiées par test négatif :
//   · les RANGÉES DU JOURNAL (`| **A6** | … propagation d'A1 → A5 … |`) : elles décrivent la
//     portée d'UN amendement passé, pas l'étendue courante du dossier. Les inclure ferait rougir
//     l'histoire à chaque nouvel amendement, c'est-à-dire l'inverse du but ;
//   · les spans entre GUILLEMETS « … » : c'est ainsi qu'on cite une rédaction supersédée, même
//     convention qu'en C2. Le marqueur de supersession ne peut pas servir ici — la prose est
//     enveloppée à 100 colonnes et la borne tombe régulièrement sur la ligne SUIVANTE.
const BOUNDS = /`?A1`?\s*(?:→|->|–|—)\s*`?A(\d+)`?/g;
let bounds = 0;
for (const file of ALL) {
  read(file).split('\n').forEach((line, i) => {
    if (/^\s*(?:>\s*)*\|/.test(line)) return;              // rangée de tableau (journal inclus)
    const quoted = line.replace(/«[^»]*»/g, '');           // citations retirées
    BOUNDS.lastIndex = 0;
    for (const m of quoted.matchAll(BOUNDS)) {
      bounds += 1;
      if (Number(m[1]) !== lastAmendment) {
        fail('C11', `${file}:${i + 1} annonce les bornes « A1 → A${m[1]} » alors que le journal déclare A${lastAmendment}`);
      }
    }
  });
}
ok('C11', `${bounds} borne(s) d’amendements vérifiée(s) contre le journal (dernier : A${lastAmendment})`);

// ── C12 · index d'amendements de chaque document ─────────────────────────────
// A18 amende 04 en trois endroits et n'apparaissait pas dans son index de tête : la règle existe,
// mais reste introuvable là où elle s'applique. L'encadré de tête = tout ce qui précède le premier
// titre de niveau 2 ; un identifiant peut y figurer en entrée détaillée OU dans la ligne compacte
// « Amendements portés dans le corps ». C12 vérifie la présence, pas l'exactitude de la portée.
// LIMITE ASSUMÉE : dans un document dont le premier `##` arrive tard (19 — Glossaire, l. 103), la
// fenêtre couvre de fait le corps. Le contrôle y dégénère en « l'amendement laisse une trace »,
// ce qui reste la garantie utile ; il ne faut simplement pas lui prêter plus de portée qu'il n'en
// a sur ces fichiers-là.
const LINKED = /\]\(((?:\.\.\/)*[\w@./-]+\.md)(?:#[^)]*)?\)/g;
const headerOf = (src) => {
  const out = [];
  for (const line of src.split('\n')) {
    if (/^##\s/.test(line)) break;
    out.push(line);
  }
  return out.join('\n');
};
const headers = new Map();
for (const file of SOCLE) headers.set(file, headerOf(read(file)));
let indexed = 0;
for (const { id, touched } of amendments) {
  for (const m of touched.matchAll(LINKED)) {
    const resolved = join('docs/mobile-experience', m[1]).replace(/\\/g, '/');
    if (resolved === README || !headers.has(resolved)) continue; // « ce fichier » et hors socle
    indexed += 1;
    if (!new RegExp(`\\b${id}\\b`).test(headers.get(resolved))) {
      fail('C12', `${README} déclare que ${id} touche ${resolved} — l’encadré de tête de ce document ne le cite pas`);
    }
  }
}
ok('C12', `${indexed} couple(s) amendement×document vérifié(s) contre les index de tête`);

// ── rapport ──────────────────────────────────────────────────────────────────
for (const line of checks) console.log(`  ok   ${line}`);
if (failures.length > 0) {
  console.error(`\n${failures.length} écart(s) :`);
  for (const line of failures) console.error(`  FAIL ${line}`);
  process.exit(1);
}
console.log(`\n${checks.length} contrôles verts — socle documentaire conforme au code.`);
