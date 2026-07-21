import { readdirSync, readFileSync } from 'node:fs';
import { extname, relative, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const WEB_ROOT = resolve(process.cwd());
const RUNTIME_ROOTS = [
  resolve(WEB_ROOT, 'app/cabinet'),
  resolve(WEB_ROOT, 'app/auth'),
  resolve(WEB_ROOT, 'src/cabinet'),
] as const;

function runtimeSources(root: string): string[] {
  return readdirSync(root, { withFileTypes: true }).flatMap((entry) => {
    const path = resolve(root, entry.name);
    if (entry.isDirectory()) return runtimeSources(path);
    if (!entry.isFile() || !['.ts', '.tsx'].includes(extname(entry.name))) return [];
    if (/\.(?:test|spec)\.[^.]+$/u.test(entry.name) || entry.name === 'storage.ts') return [];
    return [path];
  });
}

describe('frontières des données du runtime Espace Cabinet', () => {
  const sources = RUNTIME_ROOTS.flatMap(runtimeSources);

  it('n importe ni persistance navigateur historique, ni fixture, ni double mémoire', () => {
    const forbidden = /(?:from\s*|import\s*\()['"][^'"]*(?:\/storage|\/fixtures|\/in-memory|local-client|demo-)[^'"]*['"]|\b(?:CABINET_STORAGE_KEY|createEmptyCabinetState|InMemory\w*|LocalBobClient)\b/u;
    const leaks = sources.flatMap((path) =>
      forbidden.test(readFileSync(path, 'utf8')) ? [relative(WEB_ROOT, path)] : [],
    );

    expect(leaks).toEqual([]);
  });

  it('ne persiste aucune donnée métier dans localStorage et ne cible aucun domaine démo', () => {
    const leaks = sources.flatMap((path) => {
      const source = readFileSync(path, 'utf8');
      return /\blocalStorage\b|https:\/\/demo\.bobpro\.fr/u.test(source)
        ? [relative(WEB_ROOT, path)]
        : [];
    });

    expect(leaks).toEqual([]);
  });

  it('borne sessionStorage à une préférence de cabinet revalidée par le portefeuille serveur', () => {
    const users = sources.filter((path) => readFileSync(path, 'utf8').includes('sessionStorage'));

    expect(users.map((path) => relative(WEB_ROOT, path))).toEqual([
      'app/cabinet/cabinet-gateway.tsx',
    ]);
    const gateway = readFileSync(users[0]!, 'utf8');
    expect(gateway).toContain("window.sessionStorage.getItem('bob.cabinet.selected')");
    expect(gateway).toContain('cabinets.find((cabinet) => cabinet.id === saved)');
    expect(gateway).not.toMatch(/sessionStorage\.(?:setItem|getItem)\([^)]*(?:dossier|fec|client|financial)/iu);
  });

  it('auto-héberge les polices Bob et ne dépend pas de Google pendant la build', () => {
    const layout = readFileSync(resolve(WEB_ROOT, 'app/layout.tsx'), 'utf8');

    expect(layout).toContain("from 'next/font/local'");
    expect(layout).not.toContain("from 'next/font/google'");
    expect(layout).toContain('@expo-google-fonts/schibsted-grotesk');
    expect(layout).toContain('@expo-google-fonts/hanken-grotesk');
  });

  it('laisse Turbo construire les dépendances workspace sans sous-build concurrent', () => {
    const packageJson = JSON.parse(
      readFileSync(resolve(WEB_ROOT, 'package.json'), 'utf8'),
    ) as { scripts?: { build?: unknown } };

    // `turbo.json` déclare déjà build.dependsOn = ["^build"]. Relancer core/i18n/tokens ici
    // nettoierait leurs dist pendant que l’API les consomme lors d’un build global parallèle.
    expect(packageJson.scripts?.build).toBe('next build');
  });
});
