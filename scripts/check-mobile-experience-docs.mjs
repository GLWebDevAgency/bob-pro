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
 *
 * CE QU'IL NE VÉRIFIE PAS. Les gardes d'import, la matrice de routes, les IDs de traçabilité :
 * ce sont d'autres contrôles, à écrire avec les lots qui en ont besoin.
 *
 * USAGE   node scripts/check-mobile-experience-docs.mjs
 * SORTIE  0 = conforme, 1 = au moins un écart. Aucune dépendance, aucun accès réseau.
 * NON BRANCHÉ à turbo ni à la CI : le brancher est une décision de gouvernance (13), pas
 * d'auteur de document.
 */
import { readFileSync } from 'node:fs';
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

// ── rapport ──────────────────────────────────────────────────────────────────
for (const line of checks) console.log(`  ok   ${line}`);
if (failures.length > 0) {
  console.error(`\n${failures.length} écart(s) :`);
  for (const line of failures) console.error(`  FAIL ${line}`);
  process.exit(1);
}
console.log(`\n${checks.length} contrôles verts — socle documentaire conforme au code.`);
