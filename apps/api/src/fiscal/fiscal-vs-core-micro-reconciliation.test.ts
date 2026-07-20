import { describe, expect, it } from 'vitest';
import Engine, { formatValue } from 'publicodes';
import rules from 'modele-social';
import { computeMicroSocialProvision } from '@bob/core';

/**
 * Réconciliation Publicodes ↔ moteur micro EXISTANT du core (contre-revue GPT ⑦).
 *
 * `computeMicroSocialProvision` (packages/core/src/domain/fiscal/micro-social.ts) ne modélise QUE
 * les « cotisations sociales » au sens strict de l'art. D613-4 CSS (son propre docstring le dit :
 * « la table des taux globaux du micro-entrepreneur »). Publicodes, via la règle « cotisations et
 * contributions », additionne CETTE MÊME assiette (`… . cotisations`) + la TFC (taxe pour frais de
 * chambre consulaire) + la CFP (contribution formation professionnelle) — deux lignes distinctes,
 * hors périmètre de la table `MICRO_SOCIAL_RATES` du core.
 *
 * Vérifié ici sur le cas-contrat (CA 30 000 €/an, BIC service, 2026, sans ACRE/VFL) : le sous-nœud
 * Publicodes `… . cotisations` (le pur équivalent D613-4 CSS) ÉGALE EXACTEMENT le résultat du core
 * (530 €/mois = 6 360 €/an) ; l'écart avec le total complet exposé par l'API (533,50 €/mois) est
 * intégralement expliqué par TFC (1 €/mois) + CFP (2,50 €/mois) — jamais un écart inexpliqué.
 * Si une future version de `modele-social` OU du référentiel core fait dériver ce delta, ce test
 * échoue et force la revue.
 */
describe('Publicodes vs core.computeMicroSocialProvision — même cas, même base légale', () => {
  it("le sous-nœud Publicodes « cotisations » (pur D613-4 CSS) égale exactement le core, l'écart au total étant TFC+CFP", () => {
    const engine = new Engine(rules, { logger: { log: () => {}, warn: () => {}, error: () => {} } });
    engine.setSituation({
      'dirigeant . auto-entrepreneur': 'oui',
      'entreprise . catégorie juridique': "'EI'",
      'entreprise . catégorie juridique . EI . auto-entrepreneur': 'oui',
      'entreprise . activité . nature': "'commerciale'",
      'entreprise . activités . service ou vente': "'service'",
      'dirigeant . auto-entrepreneur . Cipav': 'non',
      'entreprise . activité . revenus mixtes': 'non',
      "dirigeant . auto-entrepreneur . chiffre d'affaires": '30000.00 €/an',
      date: '15/07/2026',
    });

    const pureCotisations = engine.evaluate(
      engine.getRule('dirigeant . auto-entrepreneur . cotisations et contributions . cotisations'),
    );
    const tfc = engine.evaluate(engine.getRule('dirigeant . auto-entrepreneur . cotisations et contributions . TFC'));
    const cfp = engine.evaluate(engine.getRule('dirigeant . auto-entrepreneur . cotisations et contributions . CFP'));
    const total = engine.evaluate(engine.getRule('dirigeant . auto-entrepreneur . cotisations et contributions'));

    expect(pureCotisations.nodeValue).toBe(530); // €/mois
    expect(tfc.nodeValue).toBe(1); // €/mois
    expect(cfp.nodeValue).toBe(2.5); // €/mois
    expect(total.nodeValue).toBe(533.5); // €/mois — 530 + 1 + 2,5

    const core = computeMicroSocialProvision({
      encaissedCents: 3_000_000, // 30 000 €/an — même CA que Publicodes ci-dessus.
      category: 'bic_prestations', // BIC-service (activityNature 'bic_service' du profil fiscal).
      vfl: false,
      year: 2026,
      acreRatePct: null,
    });

    // Le core rend un total annuel ; Publicodes une mensualité — même base légale (D613-4 CSS),
    // donc le core ANNUALISÉ doit égaler exactement Publicodes MENSUALISÉ × 12.
    expect(core.socialCents).toBe(636_000); // 6 360 €/an = 530 €/mois × 12.
    expect(core.socialCents / 12).toBe((pureCotisations.nodeValue as number) * 100);
    expect(core.stale).toBe(false);

    // Documentation explicite de l'écart (jamais un écart "mystère") :
    const deltaCentsPerMonth = (total.nodeValue as number) * 100 - core.socialCents / 12;
    expect(deltaCentsPerMonth).toBe((tfc.nodeValue as number) * 100 + (cfp.nodeValue as number) * 100);

    // Sanity check du helper d'affichage (aucune incidence sur le calcul, juste une garde contre
    // une régression de formatage silencieuse) :
    expect(formatValue(total)).toContain('533');
  });
});
