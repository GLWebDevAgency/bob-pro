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

## V2 — CO-CHALLENGE GPT INTÉGRÉ (14/07, cadrage adopté avec nuances Claude)
GPT a challengé la v1 : verdict Claude = il a largement raison, j'adopte. Les corrections :
1. QUATRE SOMMES distinctes, jamais mélangées : trésorerie mobilisable sans fragiliser ·
   budget rémunération supportable par l'entreprise · net personnel estimé après
   cotisations/impôts · bénéfice distribuable (à la clôture SEULEMENT — L232-12 : un
   acompte sur dividendes exige un bilan intermédiaire certifié CAC ; jamais « mensuel »).
2. PROFIL FISCAL RICHE, pas la seule forme juridique : forme (EI≠micro ! réel/IS
   possibles) + régime fiscal (micro, réel IR, IS, option IR) + statut social
   (TNS/assimilé) + activité (BIC vente/service, BNC, Cipav, mixte) + TVA + ACRE (dates
   exactes) + VL + foyer/autres revenus + capital/primes/CCA + clôture/réserves.
   Chaque donnée a un STATUT : source-fiable / confirmée-utilisateur / hypothèse-signalée
   / manquante-bloquante. Nuance Claude (RGPD) : foyer/revenus = minimisation, optionnels,
   jamais bloquants au niveau 1.
3. RÉFÉRENTIEL TEMPOREL à dates d'effet exactes (pas un millésime annuel) : ex. PFU
   31,4 % au 01/01/2026, ACRE micro modifiée au 01/07/2026 (chiffres GPT — à RE-SOURCER
   officiellement à l'implémentation, c'est le principe même du référentiel). Toute
   simulation persiste version moteur + dates d'effet + sources + hypothèses + entrées +
   date de calcul → reproductible ; une évolution légale ne change JAMAIS silencieusement
   un résultat historique (même pattern que la métrologie voix).
4. NE PAS CLONER L'URSSAF : intégrer les règles Publicodes de Mon-entreprise (simulateurs
   officiels URSSAF open source : AE, EI, EURL, SASU, dividendes, comparaison de statuts)
   en VERSION ÉPINGLÉE, compléter seulement les manques. Nuances Claude : évaluation CÔTÉ
   SERVEUR uniquement (jamais dans le bundle mobile) ; spike de due diligence en tête de
   V1 (licence, poids, stabilité des règles, tests-contrats vs simulateur officiel en CI).
   Le LLM n'invente JAMAIS un taux, ne calcule JAMAIS, ne complète JAMAIS une donnée.
5. SCÉNARIOS : d'abord L'OBJECTIF (max net / protection sociale-retraite / revenu stable /
   trésorerie / emprunt / associés / simplicité), puis 3 scénarios (prudent/central/
   favorable) × 3 horizons (fin de mois / clôture / 12 mois). Devis non signés ≠ argent.
   Pas de « meilleure structure » universelle. Chaque chiffre ouvrable : « Comment Bob a
   calculé ça ? » (traçabilité §3).
6. LANGAGE par situation (tableau GPT adopté) : micro « Retrait personnel prudent ce
   mois-ci » · EI réel « Prélèvement possible après provisions » · IS « Budget disponible
   pour ta rémunération » · SASU « La société peut supporter X € de coût employeur, soit
   ~Y € nets » · dividendes « Potentiellement distribuable à la clôture » · profil
   incomplet « Trésorerie disponible après réserves — ta rémunération reste à préciser ».
7. SYNERGIE CABINET : pour tout arbitrage de structure, Bob génère un DOSSIER D'ARBITRAGE
   (données, hypothèses, simulations comparées, protection sociale, trésorerie, impacts,
   points à confirmer, proposition de RDV) → le cabinet valide/corrige → Bob explique et
   suit. Protection produit : la consultation juridique individualisée est réglementée
   (art. 54, loi du 31/12/1971) — Bob prépare et éclaire, il ne « consulte » pas.
8. SÉQUENCEMENT V2 : ⓪ QUICK-WIN dans le lot device : remplacer les formulations trop
   affirmatives (« Tu peux te verser 6 435 € ») par le langage prudent du tableau (profil
   incomplet) → ① profil fiscal + référentiel temporel → ② spike puis intégration
   Publicodes (micro, EI, EURL, SASU) → ③ séparation des 4 sommes dans l'UI/voix →
   ④ scénarios + explications → ⑤ dossier cabinet → ⑥ arbitrages proactifs en dernier.

## UX FLOW — PROPOSITION CLAUDE À CO-CHALLENGER AVEC GPT AVANT LA 1B (ordre fondateur 15/07)
Principes : papa-vocal (jamais un formulaire administratif), progressive disclosure (ne
jamais demander ce qui se déduit), confirmation CONTEXTUELLE (au moment où le profil
devient utile), jamais bloquant.
1. ENTRÉE PRINCIPALE — CONTEXTUELLE sur Argent : là où vit « trésorerie mobilisable »
   (quick-win ⓪), une carte douce « Ta rémunération exacte dépend de ton statut — 3
   questions et Bob te la précise » → MINI-FLOW conversationnel (pattern onboarding
   fintech : UNE question par écran, pré-remplie par l'hypothèse SIRET, confirmée d'un
   tap) : micro ? → ACRE ? → versement libératoire ? → (TVA si utile). Chaque réponse :
   le statut passe visuellement en confirmé (vert succès). SKIPPABLE à tout moment —
   profil partiel = langage prudent conservé sur ce qui manque.
2. RÉSIDENCE — Compte (« Mon statut fiscal ») : les champs avec leur statut visible
   (confirmé ✓ vert / hypothèse à confirmer orange doux / manquant neutre invitant),
   modification champ par champ. La résidence n'est PAS l'entrée principale.
3. VOIX — deux sens : « Bob, j'ai l'ACRE » à tout moment → proposition + tap ; et si
   l'utilisateur demande « combien je peux me verser ? » avec profil incomplet, Bob POSE
   les questions (« Pour te répondre juste : t'es en micro ? ») — le flow EST la
   conversation. Parité stricte avec le mini-flow tactile.
4. LES 4 SOMMES — RÉSIDENCES : Argent = trésorerie mobilisable (héros existant) + section
   « Ta rémunération » (budget supportable + net estimé) quand le profil le permet ;
   Home = un seul montant-clé (inchangé) ; Pilotage = l'angle activité/SIG ; dividendes
   = clôture uniquement (Pilotage/rapport), JAMAIS une somme mensuelle.
5. INTERDITS : onboarding bloquant au premier lancement ; écran-formulaire à 8 champs ;
   notification pushy ; toute somme affichée sans son statut de fiabilité.
À CHALLENGER PAR GPT : position d'entrée (Argent seul ? rappel Home ?), nombre/ordre des
questions, résidence Compte vs écran dédié, où vivent les RÉSULTATS Publicodes (sa lane),
conformité accessibilité/normes du mini-flow.

## UX FLOW — VERDICT GPT 11:30 : GO AVEC 10 AMENDEMENTS (ADOPTÉS, la 1B les applique tous)
1. Jamais « rémunération exacte / 3 questions » → « affiner ton estimation / quelques infos ».
2. Argent = entrée primaire ; Home = simple BADGE de fiabilité sur le montant (pas de 2e carte/nag) ; voix et clôture ouvrent le MÊME flow.
3. Flow DYNAMIQUE par forme/régime (pas de séquence fixe) : d'abord couple forme+régime (micro n'est pas une forme), puis activité (vente/service/BNC/mixte) AVANT ACRE, date début/éligibilité ACRE, VL ; TVA seulement si inconnue et utile ; branches SASU/EURL distinctes ; capital/primes/CCA uniquement au scénario dividendes.
4. Une décision par écran ; bottom sheet pour 1-2 données ; progression honnête « encore N infos » CALCULÉE ; « Plus tard » annonce la conséquence (« Bob restera prudent ») et n'accepte jamais une hypothèse.
5. Résidence : carte Compte → écran dédié « Mon profil fiscal » (INPUTS seulement) ; les RÉSULTATS Publicodes vivent sur un écran Simulation accessible depuis Argent (scénarios + trace) ; Argent = snapshot résumé ; Home = un montant ; la voix résume et ouvre.
6. Chaque donnée : source + date + statut en TEXTE (Confirmé/À confirmer/Manquant — jamais couleur/coche seules, a11y) ; priorité des sources cabinet/officiel à spécifier ; correction utilisateur AUDITÉE. Chaque résultat : certified|estimated|unsupported + date effective + ruleset + hypothèses + stale.
7. La voix ne mute JAMAIS directement : proposition opaque + diff + confirmation (tap/voix), parité manuelle exacte.
8. A11y : cibles 44 pt, Dynamic Type, focus VoiceOver par question, progression annoncée, contrastes, reduce-motion, clavier, erreurs inline + résumé, AUCUNE interaction temporisée ; states offline/error/retry/stale.
9. Foyer/revenus : optionnels avec FINALITÉ affichée + suppression possible (RGPD) ; net après IR = fourchette/indisponible si incomplet.
10. Rappels soumis au pressure ledger existant.

## PUBLICODES — CONTRE-REVUE GPT 11:27 (fait foi, amende le spike) : GO paquet serveur-only DERRIÈRE FLAG SHADOW, exposition prod NO-GO en l'état.
Bloqueurs intégrés au service en construction : date d'évaluation INJECTÉE explicitement (le paquet embarque 01/06/2026 par défaut — ACRE/replays faux sinon) ; missingVariables/warnings EXPOSÉS + couverture certified|estimated|unsupported (les cas du spike rendaient des nombres avec 11-16 missing) ; wrapper evaluateRule typé + manifest allowlisté + getRule au boot + goldens ; CalculationTraceV1 normalisé (jamais l'AST brut, hors semver) + artefact rejouable (versions, date, inputs, hypothèses, warnings, résidu inversion) ; bench réel : SASU/inversion ~76 ms → concurrence bornée ; réconciliation avec le moteur micro core existant (test comparatif documenté) ; aucun dottedName côté LLM/client ; upgrade = shadow + diff + revue + rollback.
