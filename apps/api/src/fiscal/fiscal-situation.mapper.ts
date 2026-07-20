import { type AppError, type DateOnly, type Result, err, isValidDateOnly, ok } from '@bob/core';
import { PUBLICODES_RULE_MANIFEST, type PublicodesRuleName } from './publicodes-rule-manifest';
import type { AssimileSimulationInput, MicroSimulationInput } from './fiscal-simulation.types';

/**
 * Frontière anti-corruption (SPEC_EXPERT_FISCAL.md §V2 pt.4) : traduit les DTO Bob (FiscalProfile
 * core + entrées de simulation) en `Situation<RègleModèleSocial>` Publicodes. AUCUN dottedName brut
 * ne franchit cette limite dans l'autre sens — les DTO exposés au client (fiscal-simulation.types.ts)
 * n'en portent aucun.
 *
 * Découverte de due diligence (au-delà du spike) : `entreprise . catégorie juridique` (= 'EI' pour
 * le micro-entrepreneur, régime de l'entreprise individuelle) est un pré-requis SILENCIEUX de
 * `modele-social@11.0.0` — sans lui, `dirigeant . auto-entrepreneur . chiffre d'affaires` se route
 * dans la mauvaise catégorie de cotisation (Cipav/BNC au lieu de la catégorie BIC vente/service
 * réellement demandée) SANS erreur ni `missingVariables` signalant l'anomalie côté sortie visible.
 * Vérifié empiriquement (scratch tests, 4 catégories différenciées correctement UNIQUEMENT une fois
 * cette règle posée) — documenté dans le rapport de la tâche. Ne JAMAIS omettre ces deux clés.
 */

export type PublicodesSituation = Partial<Record<PublicodesRuleName, string>>;

export interface MappedSituation {
  readonly situation: PublicodesSituation;
  /** Décisions de mapping non triviales, à faire remonter dans `hypotheses` de la réponse. */
  readonly hypotheses: readonly string[];
}

function validationError(field: string, message: string): AppError {
  return { kind: 'validation', issues: [{ field, message }] };
}

/** "YYYY-MM-DD" -> "DD/MM/YYYY" (format des constantes date Publicodes, ex. "15/07/2026"). */
function toPublicodesDate(date: DateOnly): string {
  const [y, m, d] = date.split('-');
  return `${d}/${m}/${y}`;
}

/** Centimes entiers -> chaîne euros décimale, jamais de perte/notation scientifique. */
function eurosString(cents: number): string {
  return (cents / 100).toFixed(2);
}

const M = PUBLICODES_RULE_MANIFEST;

export function mapMicroSituation(input: MicroSimulationInput): Result<MappedSituation, AppError> {
  if (!Number.isInteger(input.caAnnualCents) || input.caAnnualCents <= 0) {
    return err(
      validationError('caAnnualCents', "Le chiffre d'affaires annuel doit être un entier de centimes strictement positif."),
    );
  }
  if (!isValidDateOnly(input.date)) {
    return err(validationError('date', 'Date invalide (attendu YYYY-MM-DD).'));
  }
  if (input.activityNature === 'mixte') {
    return err(
      validationError(
        'activityNature',
        "Bob ne simule pas encore les activités mixtes (trou de couverture documenté du référentiel " +
          'Publicodes — cf. SPIKE_PUBLICODES_20260715.md §6, issue mon-entreprise #3195) : ventile le ' +
          "chiffre d'affaires par nature d'activité pour obtenir une simulation.",
      ),
    );
  }

  const hypotheses: string[] = [];
  const situation: PublicodesSituation = {
    [M.microEntrepreneur]: 'oui',
    [M.categorieJuridique]: "'EI'",
    [M.categorieJuridiqueEiAutoEntrepreneur]: 'oui',
    [M.chiffreAffaires]: `${eurosString(input.caAnnualCents)} €/an`,
    [M.versementLiberatoire]: input.versementLiberatoire ? 'oui' : 'non',
    // Bob rejette 'mixte' en amont (garde ci-dessus) : les 4 catégories restantes sont TOUJOURS
    // mono-nature, donc toujours 'non' — jamais une hypothèse, une CONSÉQUENCE du rejet déjà posé.
    [M.activiteRevenusMixtes]: 'non',
    [M.evaluationDate]: toPublicodesDate(input.date),
  };

  switch (input.activityNature) {
    case 'bic_vente':
      situation[M.activiteNature] = "'commerciale'";
      situation[M.activiteServiceOuVente] = "'vente'";
      situation[M.activiteCipav] = 'non';
      hypotheses.push(
        "Nature Publicodes posée à 'commerciale' (le profil fiscal Bob ne distingue pas artisan/" +
          'commerçant ; vérifié sans incidence sur le montant pour ce cas — même total avec ' +
          "'artisanale').",
      );
      break;
    case 'bic_service':
      situation[M.activiteNature] = "'commerciale'";
      situation[M.activiteServiceOuVente] = "'service'";
      situation[M.activiteCipav] = 'non';
      hypotheses.push(
        "Nature Publicodes posée à 'commerciale' (le profil fiscal Bob ne distingue pas artisan/" +
          'commerçant ; vérifié sans incidence sur le montant pour ce cas — même total avec ' +
          "'artisanale').",
      );
      break;
    case 'bnc':
      situation[M.activiteNature] = "'libérale'";
      situation[M.activiteCipav] = 'non';
      break;
    case 'bnc_cipav':
      situation[M.activiteNature] = "'libérale'";
      situation[M.activiteCipav] = 'oui';
      hypotheses.push(
        "Affiliation Cipav posée directement (le profil fiscal Bob connaît déjà la catégorie 'bnc_cipav') " +
          'plutôt que dérivée par Publicodes de « profession réglementée » + date de création — cette ' +
          "dérivation automatique s'est révélée non fiable sans contexte complémentaire que Bob ne " +
          'détient pas encore (cf. rapport de la tâche).',
      );
      break;
  }

  const acre = input.acre;
  if (acre != null && acre.granted) {
    if (acre.startDate === undefined || !isValidDateOnly(acre.startDate)) {
      return err(
        validationError(
          'acre.startDate',
          'ACRE accordée mais date de début d\'activité absente ou invalide (YYYY-MM-DD requis : ' +
            'elle pilote le taux réduit 50 %/75 % au 1ᵉʳ juillet 2026).',
        ),
      );
    }
    situation[M.acreToggle] = 'oui';
    situation[M.entrepriseDateCreation] = toPublicodesDate(acre.startDate);
  }

  return ok({ situation, hypotheses });
}

export function mapAssimileSituation(input: AssimileSimulationInput): Result<MappedSituation, AppError> {
  if (!Number.isInteger(input.netMensuelCibleCents) || input.netMensuelCibleCents <= 0) {
    return err(
      validationError('netMensuelCibleCents', 'Le net mensuel cible doit être un entier de centimes strictement positif.'),
    );
  }
  if (!isValidDateOnly(input.date)) {
    return err(validationError('date', 'Date invalide (attendu YYYY-MM-DD).'));
  }

  const situation: PublicodesSituation = {
    [M.regimeSocial]: "'assimilé salarié'",
    // 'SAS' : la SASU est la forme unipersonnelle de la SAS, même barème « assimilé salarié »
    // (art. L311-3, 11° CSS) — c'est le cas exact validé par le spike (net 2 500 €/mois → brut
    // 3 191,75 €, coût total employeur 4 492,60 €).
    [M.categorieJuridique]: "'SAS'",
    [M.netAPayerAvantImpot]: `${eurosString(input.netMensuelCibleCents)} €/mois`,
    [M.evaluationDate]: toPublicodesDate(input.date),
  };

  return ok({
    situation,
    hypotheses: [
      "Catégorie juridique posée à 'SAS' (SASU = forme unipersonnelle, même régime social du dirigeant).",
    ],
  });
}
