/**
 * Polices embarquées des PDF — les polices DE L'APP (packages/tokens : display = Schibsted
 * Grotesk 700/800, text = Hanken Grotesk 500/600/700), TTF statiques versionnés dans
 * `apps/api/assets/fonts/` (licence SIL OFL 1.1, fichiers OFL-*.txt à côté des TTF).
 *
 * Chargées UNE FOIS (cache module) puis embarquées par pdf-lib via @pdf-lib/fontkit
 * (`subset: true`). L'embarquement rapproche du PDF/A-3 (polices embarquées requises) et
 * n'affecte en rien le payload Factur-X.
 *
 * Résolution du dossier : par candidats depuis le cwd — `apps/api` est le cwd de vitest,
 * de `nest start` et du déploiement Railway ; la racine du monorepo est couverte aussi.
 * Aucun `__dirname`/`import.meta` : robuste à la fois au build CJS (dist/) et à vite-node.
 */

import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';

export const PDF_FONT_FILES = {
  /** Montant héros, titre de pièce. */
  display800: 'SchibstedGrotesk_800ExtraBold.ttf',
  /** Noms société/client, initiales du monogramme. */
  display700: 'SchibstedGrotesk_700Bold.ttf',
  /** Labels forts, en-têtes de tableau, eyebrows. */
  text700: 'HankenGrotesk_700Bold.ttf',
  /** Valeurs, corps de tableau, chiffres. */
  text600: 'HankenGrotesk_600SemiBold.ttf',
  /** Corps, adresses, mentions. */
  text500: 'HankenGrotesk_500Medium.ttf',
} as const;

export type PdfFontKey = keyof typeof PDF_FONT_FILES;

function fontDirCandidates(): string[] {
  const cwd = process.cwd();
  return [
    join(cwd, 'assets', 'fonts'), // cwd = apps/api (vitest, nest, Railway)
    join(cwd, 'apps', 'api', 'assets', 'fonts'), // cwd = racine du monorepo
  ];
}

let cachedBytes: Record<PdfFontKey, Uint8Array> | null = null;

/** Octets TTF des 5 polices du PDF — lecture disque une seule fois, puis cache process. */
export function loadPdfFontBytes(): Record<PdfFontKey, Uint8Array> {
  if (cachedBytes) return cachedBytes;
  const candidates = fontDirCandidates();
  const dir = candidates.find((candidate) =>
    existsSync(join(candidate, PDF_FONT_FILES.display800)),
  );
  if (!dir) {
    throw new Error(
      `PDF_FONTS_MISSING: aucun dossier de polices trouvé (essayés : ${candidates.join(' ; ')})`,
    );
  }
  const entries = Object.entries(PDF_FONT_FILES) as [PdfFontKey, string][];
  const loaded = Object.fromEntries(
    entries.map(([key, file]) => [key, new Uint8Array(readFileSync(join(dir, file)))]),
  ) as Record<PdfFontKey, Uint8Array>;
  cachedBytes = loaded;
  return loaded;
}
