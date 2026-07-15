# PROGRAMME V1 — CAP PUBLICATION (ordre fondateur 15/07/2026)

RÈGLE : quand le travail EN COURS est terminé, FEATURE FREEZE — plus aucun ajout avant
publication de la V1, SAUF manque jugé indispensable D'UN COMMUN ACCORD Claude+GPT.
Ce document est la liste unique de clôture ; toute entrée nouvelle exige l'accord des
deux + trace ici. Statuts : [EN COURS] à terminer · [MANQUE?] à juger ensemble ·
[BLOQUÉ FONDATEUR] input externe requis.

## A. EN COURS — à terminer (aucun débat, c'est le travail commencé)
1. [EN COURS] Verdict R4 GPT (levée NO-GO signature) + re-reviews adverses fiscal
   (Publicodes/1B/1C) et corrections issues de ces reviews.
2. [EN COURS] Lane Bob Live GPT : gates Mistral v2 OU décision de périmètre voix V1
   (voir C1). Les 34 tests gateway rouges de l'arbre doivent être verts ou hors build.
3. [EN COURS] Audit design premium + logo (commande fondateur) : verdicts croisés puis
   application UNIQUEMENT de ce qui est jugé indispensable V1 (cohérence du signe Bob).
4. [EN COURS] Amendements ADR-0001 (10/10 adoptés — doc, pas de code nouveau).

## B. MANQUES CANDIDATS à juger ENSEMBLE (proposition Claude — GPT challenge)
1. [MANQUE?] ÉCRAN PROFIL/COMPTE COMPLET (exemple cité par le fondateur) : état réel à
   auditer — compte.tsx existe (pilier 2 y route le bilan d'essai) mais : choix de plan,
   gestion d'abonnement, restauration d'achat, suppression de compte (OBLIGATOIRE Apple),
   déconnexion, mentions légales/CGU/confidentialité in-app. VERDICT CLAUDE : indispensable.
2. [MANQUE?] MONÉTISATION V1 : IAP StoreKit/Play Billing = gros chantier risqué. OPTION
   CLAUDE : publier V1 en early-access (essai/gratuit généreux, table subscriptions déjà
   en place, AUCUN paiement in-app) → pas d'IAP en V1, le paywall vient en V1.1. À trancher.
3. [MANQUE?] ONBOARDING premier lancement : provisioning SIRET existe — vérifier le
   parcours à froid complet (création compte → SIRET → premier devis) sur device vierge.
4. [MANQUE?] CRASH REPORTING + OBSERVABILITÉ prod mobile (Sentry ou équivalent) :
   indispensable pour opérer une V1. VERDICT CLAUDE : oui, minimal.
5. [MANQUE?] RGPD/LÉGAL : politique de confidentialité (données FINANCIÈRES + voix !),
   CGU, mentions légales, URL support — exigés par les stores. Indispensable.
6. [MANQUE?] PÉRIMÈTRE FLAGS V1 : fiscal simulations (shadow), Bob Live Mistral (OFF),
   PDP (démo) — figer la matrice des flags de la build publiée.
7. [MANQUE?] EAS build/submit pipeline + versioning/OTA policy (expo-updates) + QA device
   matrice minimale (1 iPhone réel, 1 Android réel).

## C. DÉCISIONS DE PÉRIMÈTRE à acter ensemble
1. VOIX V1 : Bob Live = OpenAI Realtime (adapter existant, certifié) OU push-to-talk
   simple ; Mistral v2 reste flag OFF (ses gates ne bloquent pas la V1). Proposition Claude.
2. Web/landing : hors V1 mobile (vitrine seulement). sign-web RESTE (requis par le flow).
3. Cabinet/export FEC : inclus (existant). Expert fiscal V2/V3 (simulation UI, dossier
   cabinet) : APRÈS V1 — le flag shadow ne s'ouvre pas avant la re-review, et l'UI de
   simulation n'entre pas dans le gel.

## D. [BLOQUÉ FONDATEUR] — sans quoi RIEN ne se publie
1. Comptes développeur Apple (99 $/an) + Google Play (25 $) — délais de validation !
2. Domaine bobpro.fr + bonjour@bobpro.fr (URL support/privacy exigée par les stores).
3. Clé OpenAI production (voix V1) + secrets prod (passage bob_app déjà préparé).
4. QA device : rebuild iPhone (tout le travail des 2 derniers jours) + un Android réel.

## E. CRITÈRES « PUBLIABLE » (les deux doivent signer)
Zéro P0 ouvert · suites vertes (hors flags OFF) · parcours à froid complet sans crash
sur les 2 OS · RGPD/légal en place · crash reporting actif · matrice de flags figée ·
CLAIMS à jour · certification device voix (périmètre C1) · double signature Claude+GPT
dans ce fichier.
