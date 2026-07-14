# SPEC — BOB EXPERT FISCAL & RÉMUNÉRATION (gravée 2026-07-14, PROGRAMMÉE après le lot en cours)

Ordre fondateur : le langage « tu peux te verser X » doit devenir VRAI pour toutes les
formes juridiques, avec des calculs RÉELS (moteurs type URSSAF), des seuils légaux JAMAIS
en dur, et Bob en conseiller expert (optimisation salaire/dividendes, choix de structure)
« tel un expert-comptable », par IA bien calibrée. Statut : SPEC À RE-CHALLENGER PAR
CLAUDE + GPT ENSEMBLE (specs, DoD, architecture) AVANT toute implémentation — les deux
sont notifiés. Ne démarre qu'une fois le lot retours device clos (ne pas s'éparpiller).

## Existant sur lequel on s'appuie
- Company.legalForm ('EI'|'EURL'|'SASU'|'SARL'|'SAS'|'micro') mappé du code INSEE au
  provisioning (nature-juridique.ts) — « micro » = RÉGIME à confirmer par l'utilisateur.
- Pattern référentiel versionné + flag stale : LATE_PENALTY_RATES (late-penalties.ts)
  — « jamais un taux inventé ». Pipeline devis/factures + paiements réels pour les
  projections. Digest/win-back pour les suggestions calendaires. FEC pour le comptable.

## Architecture en 3 couches (séparation STRICTE)
### C1 — Référentiel légal versionné (jamais en dur)
FISCAL_PARAMETERS millésimé (core, table d'entrée) : plafonds micro (vente/services),
franchise TVA + seuils majorés, taux URSSAF micro par nature d'activité, versement
libératoire, ACRE (barème dégressif), barèmes TNS, charges assimilé-salarié, IS 15/25 %
+ seuil, PFU 30 %. Surchargeable PAR LE SERVEUR (endpoint fiscal-parameters) → mise à
jour légale sans release binaire. Chaque usage porte son millésime + flag stale.
### C2 — Moteurs de calcul purs, testés contre les cas officiels (zéro IA)
computeMicroContributions (activité, ACRE, VL, TVA provisionnée, ALERTE de seuil de
plafond projetée sur le rythme réel) · computeTnsCost / computeAssimileCost (net↔chargé)
· computeDividendPocket (IS, PFU, règle EURL >10 % capital) · compareStructures (simule
micro/EURL/SASU sur CA réel 3-12 mois + pipeline signé/à encaisser : net-en-poche, coût
prélèvements, protection sociale/retraite) · deriveOwnerPayGuidance (le bon VOCABULAIRE
+ le bon montant par forme — consommé par Argent, Pilotage, digest, voix).
Profil fiscal utilisateur : ACRE (+date), versement libératoire, taux IR, régime TVA —
citables/modifiables, À LA VOIX aussi (philosophie papa).
### C3 — Bob conseiller (l'IA ORCHESTRE les moteurs, ne calcule JAMAIS)
Tool calls vers C2, interprétation en français humain, personnalisation ; suggestions
PROACTIVES calendaires (seuil micro approché, avant-bilan) via la mécanique digest/
win-back (gouvernance de pression respectée) ; DISCLAIMER structurel : Bob simule et
explique, la décision de structure se valide avec un expert-comptable humain (« un outil,
pas un miracle ») ; toute simulation affiche millésime + hypothèses.

## Séquencement
V1 micro/EI complet (référentiel + moteur + langage partout + alerte seuil) →
V2 EURL/SASU (net↔chargé, poche dividendes, arbitrage salaire/dividendes simulé) →
V3 comparateur de structures + suggestions calendaires.

## DoD (chaque V)
Spec re-challengée Claude+GPT AVANT code · moteurs testés contre les cas publiés URSSAF/
BOFiP (cas de référence cités en commentaire) · seuils uniquement via C1 (lint/review :
zéro constante fiscale hors référentiel) · parité vocale stricte (poser/modifier son
profil fiscal et demander conseil À LA VOIX) · estimations annoncées (« environ »,
millésime) · i18n ×3 · states/skeletons/erreurs conformes au socle · analytics produit
(events conseil consulté/suivi) · review adversariale + porte worktree verte.
