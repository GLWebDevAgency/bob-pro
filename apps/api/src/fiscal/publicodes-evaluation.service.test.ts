import { describe, expect, it, vi } from 'vitest';
import Engine from 'publicodes';
import type { AppLogger } from '../observability/logger';
import { PublicodesEvaluationService, validatePublicodesRuleManifest } from './publicodes-evaluation.service';
import { PUBLICODES_RULE_MANIFEST, type PublicodesRuleName } from './publicodes-rule-manifest';

/**
 * Tests-contrats (réserve du spike + amendement de la mission) : valeurs EXACTES sur les DEUX cas
 * du spike. Si une future montée de version de `modele-social` fait varier ces montants, ces
 * tests échouent et forcent la revue — c'est le mécanisme de veille voulu (SPIKE_PUBLICODES_20260715.md
 * §6, « processus de veille des releases »).
 *
 * ÉCART DOCUMENTÉ avec le rapport de spike initial (rapport de la tâche, à lire en entier) : le
 * spike avait rapporté 585 €/mois de cotisations / 22 980 €/an de revenu net pour le cas micro
 * CA 30 000 €/an service, MAIS avec une situation Publicodes INCOMPLÈTE (sans `entreprise .
 * catégorie juridique`) qui route silencieusement le calcul vers la catégorie de cotisation Cipav
 * au lieu de la catégorie BIC-service réellement demandée. Une situation complète et légalement
 * correcte (`entreprise . catégorie juridique = 'EI'`, cf. fiscal-situation.mapper.ts) donne
 * 533,50 €/mois / 23 598 €/an — les valeurs retenues ici. C'est précisément le risque que
 * `missingVariables`/`coverage` (amendement pt.②) est censé rendre visible : jamais un nombre nu.
 */

function logger(): AppLogger {
  return {
    audit: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    log: vi.fn(),
    debug: vi.fn(),
    verbose: vi.fn(),
  } as unknown as AppLogger;
}

async function boot(): Promise<PublicodesEvaluationService> {
  const service = new PublicodesEvaluationService(logger());
  await service.onModuleInit();
  return service;
}

describe('PublicodesEvaluationService — boot', () => {
  it('charge le moteur en un temps raisonnable et journalise un boot < 2s (mesuré ~150 ms/17 MB au spike)', async () => {
    const service = await boot();
    expect(service.getBootMs()).toBeGreaterThan(0);
    expect(service.getBootMs()).toBeLessThan(2_000);
  });

  it('valide chaque règle du manifeste contre le VRAI modele-social@11.0.0 (aucune ne doit lever)', async () => {
    await expect(boot()).resolves.toBeInstanceOf(PublicodesEvaluationService);
  });
});

describe('validatePublicodesRuleManifest — garde-fou renommage (réserve n°1 du spike)', () => {
  it("échoue au démarrage si une règle du manifeste est absente du jeu de règles fourni à l'Engine", () => {
    // Jeu de règles synthétique TRONQUÉ (aucune des règles du manifeste réel n'y figure) : simule
    // un renommage amont qui aurait échappé à la garde de compilation (`satisfies`).
    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- Engine générique non contraint pour ce test synthétique.
    const engine = new Engine<PublicodesRuleName>({ 'une règle': { valeur: 42 } } as any, {
      logger: { log: () => {}, warn: () => {}, error: () => {} },
    });
    expect(() => validatePublicodesRuleManifest(engine)).toThrow(/échec de démarrage/);
    expect(() => validatePublicodesRuleManifest(engine)).toThrow(
      new RegExp(PUBLICODES_RULE_MANIFEST.microEntrepreneur.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')),
    );
  });
});

describe('PublicodesEvaluationService.evaluateMicro — cas-contrat micro (situation complète)', () => {
  it('CA 30 000 €/an service (BIC), sans ACRE, évalué au 2026-07-15 → 533,50 €/mois de cotisations, 23 598 €/an de revenu net', async () => {
    const service = await boot();
    const result = await service.evaluateMicro({
      type: 'micro',
      caAnnualCents: 3_000_000,
      activityNature: 'bic_service',
      acre: null,
      versementLiberatoire: false,
      date: '2026-07-15',
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.result.cotisationsCentsPerMonth).toBe(53_350);
    expect(result.value.result.revenuNetCentsPerYear).toBe(2_359_800);
    expect(result.value.rulesVersion).toBe('modele-social@11.0.0');
    expect(result.value.effectiveDate).toBe('2026-07-15');
    expect(result.value.coverage).toBe('estimated');
    expect(result.value.missingVariablesCount).toBeGreaterThan(0);
    expect(result.value.traces.length).toBeGreaterThan(0);
    expect(result.value.traces[0]?.ruleTitle).toBeTruthy();
  });

  it('ACRE créée le 2026-01-01, évaluée au 2026-07-15 (post-réforme, taux Acre = 75 %) → 401,50 €/mois, 25 182 €/an', async () => {
    const service = await boot();
    const result = await service.evaluateMicro({
      type: 'micro',
      caAnnualCents: 3_000_000,
      activityNature: 'bic_service',
      acre: { granted: true, startDate: '2026-01-01' },
      versementLiberatoire: false,
      date: '2026-07-15',
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.result.cotisationsCentsPerMonth).toBe(40_150);
    expect(result.value.result.revenuNetCentsPerYear).toBe(2_518_200);
  });

  it('ACRE créée le 2026-01-01, évaluée au 2026-06-15 (avant la réforme du 1er juillet 2026, taux Acre = 50 %) → 268,50 €/mois, 26 778 €/an', async () => {
    const service = await boot();
    const result = await service.evaluateMicro({
      type: 'micro',
      caAnnualCents: 3_000_000,
      activityNature: 'bic_service',
      acre: { granted: true, startDate: '2026-01-01' },
      versementLiberatoire: false,
      date: '2026-06-15',
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.result.cotisationsCentsPerMonth).toBe(26_850);
    expect(result.value.result.revenuNetCentsPerYear).toBe(2_677_800);
  });

  it("la cotisation pré-réforme (50 % dû) est STRICTEMENT inférieure à la cotisation post-réforme (75 % dû) — l'ACRE 2026 est moins généreuse, pas plus", async () => {
    const service = await boot();
    const before = await service.evaluateMicro({
      type: 'micro',
      caAnnualCents: 3_000_000,
      activityNature: 'bic_service',
      acre: { granted: true, startDate: '2026-01-01' },
      versementLiberatoire: false,
      date: '2026-06-15',
    });
    const after = await service.evaluateMicro({
      type: 'micro',
      caAnnualCents: 3_000_000,
      activityNature: 'bic_service',
      acre: { granted: true, startDate: '2026-01-01' },
      versementLiberatoire: false,
      date: '2026-07-15',
    });
    expect(before.ok && after.ok).toBe(true);
    if (!before.ok || !after.ok) return;
    expect(before.value.result.cotisationsCentsPerMonth).toBeLessThan(after.value.result.cotisationsCentsPerMonth);
  });

  it('rejette les activités mixtes avant tout appel au moteur (garde-fou produit explicite)', async () => {
    const service = await boot();
    const result = await service.evaluateMicro({
      type: 'micro',
      caAnnualCents: 3_000_000,
      activityNature: 'mixte',
      acre: null,
      versementLiberatoire: false,
      date: '2026-07-15',
    });
    expect(result.ok).toBe(false);
  });

  it('les 4 catégories de cotisation micro sont strictement différenciées (12,3 % < 21,2 % < 23,2 % < 25,6 %)', async () => {
    const service = await boot();
    const evalFor = async (activityNature: 'bic_vente' | 'bic_service' | 'bnc' | 'bnc_cipav') =>
      service.evaluateMicro({
        type: 'micro',
        caAnnualCents: 3_000_000,
        activityNature,
        acre: null,
        versementLiberatoire: false,
        date: '2026-07-15',
      });
    const [vente, service_, bnc, cipav] = await Promise.all([
      evalFor('bic_vente'),
      evalFor('bic_service'),
      evalFor('bnc'),
      evalFor('bnc_cipav'),
    ]);
    expect(vente.ok && service_.ok && bnc.ok && cipav.ok).toBe(true);
    if (!vente.ok || !service_.ok || !bnc.ok || !cipav.ok) return;
    const [venteCents, serviceCents, bncCents, cipavCents] = [
      vente.value.result.cotisationsCentsPerMonth,
      service_.value.result.cotisationsCentsPerMonth,
      bnc.value.result.cotisationsCentsPerMonth,
      cipav.value.result.cotisationsCentsPerMonth,
    ];
    expect(venteCents).toBeLessThan(serviceCents);
    expect(serviceCents).toBeLessThan(cipavCents);
    expect(cipavCents).toBeLessThan(bncCents);
  });
});

describe('PublicodesEvaluationService.evaluateAssimileSalarie — cas-contrat SASU (inversion numérique)', () => {
  it('net cible 2 500 €/mois, évalué au 2026-07-15 → brut 3 191,75 €/mois, coût total employeur 4 492,60 €/mois', async () => {
    const service = await boot();
    const result = await service.evaluateAssimileSalarie({ type: 'assimile', netMensuelCibleCents: 250_000, date: '2026-07-15' });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.result.brutMensuelCents).toBe(319_175);
    expect(result.value.result.coutTotalEmployeurCents).toBe(449_260);
    expect(result.value.result.inversionFail).toBe(false);
    expect(result.value.rulesVersion).toBe('modele-social@11.0.0');
  });
});
