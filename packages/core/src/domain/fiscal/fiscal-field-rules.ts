import { type LegalForm } from '../company/company';
import {
  FISCAL_PROFILE_FIELDS,
  datumValue,
  type FiscalProfileField,
  type FiscalProfileProps,
  type FiscalTaxRegime,
} from './fiscal-profile';

/**
 * RÈGLES D'AFFICHAGE ET DE CHOIX du profil fiscal (BOB EXPERT FISCAL — module domaine PUR,
 * consommé par l'UI mobile). Trois questions auxquelles l'écran « Mon profil fiscal » ne doit
 * JAMAIS répondre lui-même (la connaissance fiscale vit ici, pas dans un composant) :
 * · quels champs montrer pour CE profil ? (applicableFiscalFields)
 * · quels régimes fiscaux sont juridiquement POSSIBLES pour CETTE forme ? (allowedTaxRegimesFor)
 * · comment EXPLIQUER le statut social imposé par la forme ? (socialStatusExplanation)
 *
 * Philosophie « papa vocal » : chaque fonction renvoie des CLÉS i18n pédagogiques — Bob explique
 * le jargon (« assimilé salarié », « option IR »...) avec des mots simples, jamais un terme
 * fiscal brut jeté à l'écran. Les clés sont STABLES (contrat UI) ; le texte vit côté i18n.
 */

/**
 * Champs du profil à AFFICHER pour un profil donné — l'ordre est celui de
 * FISCAL_PROFILE_FIELDS (ordre canonique de l'écran).
 *
 * · versementLiberatoire : visible SEULEMENT en contexte micro (forme 'micro' ou régime fiscal
 *   'micro') — le VL n'existe qu'au régime micro (art. 151-0 CGI) ; hors micro le champ est posé
 *   « non applicable » (false, source_fiable) par la dérivation et serait un bruit trompeur
 *   (« Manquant ») s'il restait affiché.
 * · acre : visible TOUJOURS (toute entreprise a une réponse : accordée, refusée ou échue) —
 *   l'UI l'accompagne d'une aide pédagogique, pas d'un masquage.
 * · tous les autres champs : toujours visibles.
 */
export function applicableFiscalFields(
  profile: Pick<FiscalProfileProps, 'legalForm' | 'taxRegime'>,
): readonly FiscalProfileField[] {
  const legalForm = datumValue(profile.legalForm);
  const taxRegime = datumValue(profile.taxRegime);
  const microContext = legalForm === 'micro' || taxRegime === 'micro';
  return FISCAL_PROFILE_FIELDS.filter((field) => field !== 'versementLiberatoire' || microContext);
}

/** Un régime fiscal proposable pour une forme, avec sa clé d'explication pédagogique. */
export interface AllowedTaxRegime {
  readonly regime: FiscalTaxRegime;
  /**
   * Clé i18n de l'explication « papa vocal » du régime POUR CETTE FORME (le même régime ne
   * s'explique pas pareil selon la forme) — schéma stable :
   * `fiscal.tax_regime_choice.<forme>.<regime>`.
   */
  readonly explanationKey: string;
}

const taxRegimeChoice = (legalForm: LegalForm, regime: FiscalTaxRegime): AllowedTaxRegime => ({
  regime,
  explanationKey: `fiscal.tax_regime_choice.${legalForm}.${regime}`,
});

/**
 * Régimes fiscaux juridiquement VALIDES par forme — la liste que l'UI propose (jamais un menu
 * de tous les régimes où l'utilisateur peut se tromper). Contenu pédagogique attendu derrière
 * chaque clé (source de vérité pour la rédaction i18n) :
 *
 * · micro → 'micro' seul : la forme micro-entreprise implique le régime micro (invariant du
 *   profil, micro_legal_form_requires_micro_tax_regime).
 * · EI → 'micro' (POSSIBLE si le chiffre d'affaires reste sous les seuils art. 50-0 CGI —
 *   la clé doit le dire simplement : « si tu restes sous X €, tu peux passer en micro ») ;
 *   'reel_ir' (le régime par défaut) ; 'is' (option possible DEPUIS 2022 : l'EI peut opter
 *   pour son assimilation à une EURL soumise à l'IS, art. 1655 sexies CGI).
 * · EURL → 'micro' (POSSIBLE depuis la loi Sapin II — art. 124, loi n° 2016-1691, art. 50-0, 1
 *   CGI : EURL dont l'associé unique personne physique est le gérant, sous les seuils micro —
 *   la clé doit porter cette double condition simplement) ; 'reel_ir' (défaut du gérant associé
 *   unique personne physique) ; 'is' (sur option, irrévocable après 5 exercices, art. 239 CGI).
 * · SASU/SAS/SARL → 'is' (le régime par défaut des sociétés de capitaux) ; 'option_ir'
 *   (option TEMPORAIRE pour les jeunes sociétés : au plus 5 exercices, société de MOINS DE
 *   5 ANS à l'ouverture de l'option, art. 239 bis AB CGI — la clé doit porter cette mention
 *   pédagogique « seulement les 5 premières années, puis retour à l'IS »). Pour la SARL
 *   s'ajoute la SARL de famille (art. 239 bis AA CGI), à expliquer derrière la même clé.
 */
export function allowedTaxRegimesFor(legalForm: LegalForm): readonly AllowedTaxRegime[] {
  switch (legalForm) {
    case 'micro':
      return [taxRegimeChoice('micro', 'micro')];
    case 'EI':
      return [
        taxRegimeChoice('EI', 'micro'),
        taxRegimeChoice('EI', 'reel_ir'),
        taxRegimeChoice('EI', 'is'),
      ];
    case 'EURL':
      return [
        taxRegimeChoice('EURL', 'micro'),
        taxRegimeChoice('EURL', 'reel_ir'),
        taxRegimeChoice('EURL', 'is'),
      ];
    case 'SASU':
      return [taxRegimeChoice('SASU', 'is'), taxRegimeChoice('SASU', 'option_ir')];
    case 'SAS':
      return [taxRegimeChoice('SAS', 'is'), taxRegimeChoice('SAS', 'option_ir')];
    case 'SARL':
      return [taxRegimeChoice('SARL', 'is'), taxRegimeChoice('SARL', 'option_ir')];
  }
}

/**
 * Clé i18n de l'EXPLICATION pédagogique du statut social par forme — à afficher partout où le
 * statut est imposé (la feuille « statut social » en lecture seule doit EXPLIQUER pourquoi,
 * jamais un simple verrou muet). Contenu attendu derrière chaque clé :
 *
 * · SASU/SAS → le président est TOUJOURS « assimilé salarié » (art. L311-3, 11° CSS), même
 *   actionnaire unique : cotisations au régime général, pas de chômage — à dire simplement.
 * · EI → l'entrepreneur individuel est toujours travailleur indépendant (TNS).
 * · micro → même certitude, formulée pour le micro-entrepreneur.
 * · EURL → le gérant associé unique est TNS (art. L611-1 CSS).
 * · SARL → ça DÉPEND de la gérance : gérant majoritaire = TNS, minoritaire/égalitaire =
 *   assimilé salarié — c'est pourquoi Bob pose la question au lieu de deviner.
 */
export function socialStatusExplanation(legalForm: LegalForm): string {
  switch (legalForm) {
    case 'SASU':
    case 'SAS':
      return 'fiscal.social_status_explanation.sas_president_assimile';
    case 'EI':
      return 'fiscal.social_status_explanation.ei_tns';
    case 'micro':
      return 'fiscal.social_status_explanation.micro_tns';
    case 'EURL':
      return 'fiscal.social_status_explanation.eurl_gerant_tns';
    case 'SARL':
      return 'fiscal.social_status_explanation.sarl_selon_gerance';
  }
}
