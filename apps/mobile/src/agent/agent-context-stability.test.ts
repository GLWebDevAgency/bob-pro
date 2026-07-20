import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * Garde-fou anti-boucle de rendu — incident terrain du 20/07/2026.
 *
 * `usePublishAgentContext(context, layout, surface)` passe ses trois arguments en DÉPENDANCES
 * d'un `useFocusEffect` (`agent-context.tsx`). Un littéral d'objet écrit en ligne se réidentifie
 * à CHAQUE rendu : l'effet se rejoue, publie, incrémente la version du contexte, ce qui re-rend
 * l'écran… qui recrée le littéral. Boucle infinie mesurée à 20 002 rendus sans convergence : React
 * ne lève rien, le fil JS sature à 100 % et l'écran se fige (ANR Android) — vécu par le fondateur
 * sur « Mon profil fiscal ». Six écrans portaient le défaut simultanément, dont les deux onglets
 * principaux ; aucun test ne pouvait le voir, d'où ce contrôle statique.
 *
 * RÈGLE : les arguments `layout` et `surface` doivent être des RÉFÉRENCES STABLES — `undefined`
 * (les défauts `EMPTY_LAYOUT`/`EMPTY_SURFACE` sont figés), une constante de module gelée, ou une
 * valeur mémoïsée. Jamais un littéral en ligne.
 */

const APP_DIR = resolve(__dirname, '..', '..', 'app');
const HOOK_CALL = 'usePublishAgentContext(';

function tsxFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((entry) => {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) return tsxFiles(full);
    return entry.endsWith('.tsx') || entry.endsWith('.ts') ? [full] : [];
  });
}

/** Texte de l'appel, des parenthèses ouvrantes à leur fermeture (parenthèses équilibrées). */
function callText(source: string, start: number): string {
  let depth = 0;
  for (let i = start; i < source.length; i += 1) {
    const char = source[i];
    if (char === '(') depth += 1;
    else if (char === ')') {
      depth -= 1;
      if (depth === 0) return source.slice(start, i + 1);
    }
  }
  return source.slice(start);
}

/** Arguments de premier niveau (les virgules imbriquées dans {} [] () ne séparent pas). */
function topLevelArguments(call: string): string[] {
  const inner = call.slice(call.indexOf('(') + 1, call.lastIndexOf(')'));
  const args: string[] = [];
  let depth = 0;
  let current = '';
  for (const char of inner) {
    if ('([{'.includes(char)) depth += 1;
    if (')]}'.includes(char)) depth -= 1;
    if (char === ',' && depth === 0) {
      args.push(current.trim());
      current = '';
      continue;
    }
    current += char;
  }
  if (current.trim().length > 0) args.push(current.trim());
  return args;
}

describe('usePublishAgentContext — stabilité des arguments (anti-boucle de rendu)', () => {
  it("aucun écran ne passe un littéral d'objet en ligne comme layout ou surface", () => {
    const coupables: string[] = [];
    for (const file of tsxFiles(APP_DIR)) {
      const source = readFileSync(file, 'utf8');
      let index = source.indexOf(HOOK_CALL);
      while (index !== -1) {
        // Ignore l'import/ré-export du symbole lui-même.
        const call = callText(source, index + HOOK_CALL.length - 1);
        const args = topLevelArguments(call);
        for (const [position, argument] of args.entries()) {
          if (position === 0) continue; // le contexte est déjà mémoïsé par convention
          if (argument.startsWith('{')) {
            coupables.push(
              `${relative(APP_DIR, file)} — argument ${position + 1} littéral : ${argument.slice(0, 60).replace(/\s+/gu, ' ')}…`,
            );
          }
        }
        index = source.indexOf(HOOK_CALL, index + 1);
      }
    }
    expect(
      coupables,
      `Littéral inline passé à usePublishAgentContext : identité changeante à chaque rendu => boucle de rendu infinie et écran figé. Utilise undefined, une constante de module gelée ou useMemo.\n${coupables.join('\n')}`,
    ).toEqual([]);
  });
});
