import { afterEach, describe, expect, it, vi } from 'vitest';

/**
 * GARDE DE RÉSOLUTION DU GRAPHE D'INJECTION.
 *
 * Incident du 20/07/2026 : `VoiceTraceRecorder`, déclaré dans `AppModule`, injectait
 * `ERROR_REPORTER`. Ce token est fourni par `ObservabilityModule` — qui est `@Global()` mais ne
 * l'EXPORTAIT pas. Un token non exporté reste invisible aux autres modules, même depuis un module
 * global : le démarrage échouait avec `UnknownDependenciesException`.
 *
 * Aucune suite ne pouvait le voir : les tests unitaires CÂBLENT EUX-MÊMES leurs dépendances
 * (`new VoiceTraceRecorder(persistence, logger, reporter, …)`), donc ils passent tous pendant que
 * l'injection réelle est cassée. Le build non plus — il compile des types, pas un graphe.
 * Seul le boot rituel l'a attrapé, à un geste du déploiement.
 *
 * Cette garde ferme la classe entière : elle vérifie que TOUT token injecté hors du module qui le
 * fournit est bien exporté. Elle est statique (aucune base, aucun réseau) pour rester dans la
 * suite standard.
 */

import { ERROR_REPORTER } from './observability/error-reporter';
import { ObservabilityModule } from './observability/observability.module';

/** Lit les métadonnées Nest posées par le décorateur `@Module`. */
function moduleExports(target: unknown): readonly unknown[] {
  return (Reflect.getMetadata('exports', target as object) as unknown[] | undefined) ?? [];
}

function moduleProviders(target: unknown): readonly unknown[] {
  return (Reflect.getMetadata('providers', target as object) as unknown[] | undefined) ?? [];
}

/** Vrai si le provider fournit ce token (classe, ou objet `{ provide }`). */
function providesToken(provider: unknown, token: unknown): boolean {
  if (provider === token) return true;
  return (
    typeof provider === 'object'
    && provider !== null
    && (provider as { provide?: unknown }).provide === token
  );
}

afterEach(() => vi.restoreAllMocks());

describe('graphe d’injection — tokens partagés réellement exportés', () => {
  it('ObservabilityModule EXPORTE ERROR_REPORTER (sinon le boot échoue)', () => {
    expect(
      moduleProviders(ObservabilityModule).some((provider) =>
        providesToken(provider, ERROR_REPORTER),
      ),
      'ObservabilityModule doit fournir ERROR_REPORTER',
    ).toBe(true);
    expect(
      moduleExports(ObservabilityModule).includes(ERROR_REPORTER),
      "ERROR_REPORTER est injecté par des providers déclarés HORS d'ObservabilityModule "
        + "(VoiceTraceRecorder…) : sans export, @Global() ne suffit pas et le démarrage échoue "
        + 'avec UnknownDependenciesException — invisible aux tests unitaires, qui câblent eux-mêmes '
        + 'leurs dépendances.',
    ).toBe(true);
  });

  it('tout provider fourni ET exporté reste cohérent (aucun export fantôme)', () => {
    const providers = moduleProviders(ObservabilityModule);
    for (const exported of moduleExports(ObservabilityModule)) {
      expect(
        providers.some((provider) => providesToken(provider, exported)),
        `ObservabilityModule exporte un token qu'il ne fournit pas : ${String(exported)}`,
      ).toBe(true);
    }
  });
});
