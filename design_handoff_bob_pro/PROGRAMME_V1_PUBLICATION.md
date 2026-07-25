# PROGRAMME V1 — CAP PUBLICATION (ordre fondateur 15/07/2026)

> **Mise à jour normative du 21/07/2026** — Les objectifs, l'ordre d'exécution et la DoD
> actuels vivent dans [OBJECTIFS_SPECS_DOD_PUBLICATION.md](OBJECTIFS_SPECS_DOD_PUBLICATION.md).
> La décision fondateur est désormais : **GPT Realtime + Voice Trace sur le chemin critique de
> publication ; Mistral Realtime V3 préservé mais différé après publication ; un seul tronc et une
> seule branche courte active à la fois**. Les sections historiques ci-dessous restent un journal
> de décision et ne prévalent pas lorsqu'elles contredisent ce cap.

> **Ratification du 25/07/2026 (fondateur, oral — contre-signature Claude)** — Le remplacement
> de la liste unique par OBJECTIFS_SPECS_DOD_PUBLICATION.md est RATIFIÉ, avec deux amendements :
> bascule d'ADMINISTRATION GPT Realtime ↔ Voxtral tour-par-tour (config runtime, exposée plus
> tard dans le futur dashboard admin — jamais un sélecteur utilisateur), et duplex Mistral en
> chantier parallèle long terme (jamais bloquant pour la publication). Les entrées historiques de
> ce document NON reprises dans OBJECTIFS **restent dues** et ne disparaissent pas par
> rétrogradation : renommage NICO (§ dédié), early-access/IAP, écran compte, onboarding à froid,
> arbitrages B1-B7 — chacune sera soit tracée dans OBJECTIFS, soit explicitement abandonnée par
> décision commune. Acomptes professionnels (B2B/B2G) : fermeture V1 CONFIRMÉE par le fondateur
> le 25/07 avec parcours de repli « situation » à proposer dans l'app.

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

## RÉPONSES FONDATEUR 15/07 (soir) — mises à jour actées
D1 COMPTES STORES : le fondateur délègue (« tu as tous les accès »). Répartition honnête :
l'incompressible IDENTITÉ reste à lui (~20 min chacun : Apple ID+2FA+pièce d'identité+CB
99 $/an ; Google CB 25 $ — vérifications d'identité impossibles à déléguer légalement).
CLAUDE fait 100 % du reste : dossier d'inscription prêt-à-cliquer (individu vs société —
à trancher selon la structure d'édition), puis certificats/EAS/TestFlight/fiches stores
dès les comptes créés. Config déjà en place : bundle fr.bobpro.app, eas.json (dev/preview
avec APK Android + env Railway/Supabase).
D2 NAMING : À FIGER AVANT toute soumission (bundle id immuable une fois publié). Nom
actuel « Bob Pro » (app.json). CLAUDE prépare le dossier : disponibilité App Store/Play,
recherche INPI marques, domaine bobpro.fr — décision FONDATEUR sur dossier. Le logo
(audit GPT) découle du nom figé.
C1 VOIX V1 RÉVISÉ (clé Mistral disponible, PAS de clé OpenAI) : le système est
provider-neutre (BOB_LIVE_PROVIDER openai|mistral). Précision importante : « Mistral
OFF » ne visait QUE le nouveau protocole full-duplex v2 (gateway GPT, gates ouverts) —
PAS Mistral comme fournisseur. AVEC la seule clé Mistral, la voix V1 = chemin Voxtral
STT/TTS EXISTANT et déjà mesuré en QA métrologie (tour-par-tour éprouvé). Le full-duplex
(OpenAI Realtime certifié OU Mistral v2) reste OFF en V1 et s'activera en V1.x quand la
clé OpenAI arrivera OU quand les gates Mistral v2 fermeront. La voix RESTE au cœur de la
V1 (philosophie papa) — accord GPT requis sur ce périmètre.
D4 PLAN DE TEST PROCHES : Android = IMMÉDIAT (APK preview EAS, installation directe sans
compte Google — profil déjà configuré) ; iOS = TestFlight dès le compte Apple (D1).
Matrice réelle = fondateur + proches, chacun son device : exactement la QA multi-devices
qu'il nous fallait.

## MAJ 15/07 soir — COMPTES STORES : ILS EXISTENT DÉJÀ (fondateur)
D1 candidat CLOS : comptes développeur Apple + Google déjà créés. EAS loggé sur la machine
(gl.dev / projet lié c45313b8). CONSÉQUENCES :
· BUILD APK ANDROID preview LANCÉ (build 6b2a9d03 — lien expo.dev/accounts/gl.dev) →
  installation directe par les proches dès la fin du build.
· iOS : il reste UNE session interactive de ~5 min avec le fondateur (login Apple ID +
  2FA dans `eas credentials`) pour qu'EAS génère les certificats — ensuite TestFlight
  entièrement opéré par Claude.
· Google Play submit : il faudra un service-account JSON (je guiderai) — pour l'instant
  l'APK direct suffit au test des proches.

## DÉCISION NAMING FONDATEUR — 16/07/2026 : **NICO** ✓
Choisi sur dossier v3 (DOSSIER_NAMING_V3_COURTS_20260716.md) : 1-2 syllabes, international,
invocable (« Hé Nico »), zéro conflit sectoriel détecté, 4/4 domaines composés .fr LIBRES
(re-vérifiés RDAP à la décision : heynico.fr, monnico.fr, nicoapp.fr, nico-gestion.fr).
ACTIONS DÉCLENCHÉES : ①réservation domaines PAR LE FONDATEUR immédiatement (alerte
sniping) ; ②recherche INPI manuelle classes 9/35/36/42 sur « NICO » avant dépôt de marque
(dernier verrou) ; ③GPT : logo/wordmark redémarre sur NICO, identité personnage à décliner
(phrase d'accueil, signature) ; ④chantier de renommage technique À PROGRAMMER dans le gel
V1 : app.json (name/slug), bundle id AVANT 1re soumission (fr.nicoapp.* à arbitrer),
toutes les occurrences UI/i18n « Bob » → « Nico » (catalogues ×3 humeurs, personnage,
prompts IA, docs stores) — le nom de code interne du repo (bob-pro) peut rester.

## Dette technique release actée 16/07 (à solder avant signature publiable)
- ERROR_REPORTER_WEBHOOK_URL sur Railway = placeholder (/health) — poser un vrai webhook
  d'alerting (Slack/Discord/mail) avant la V1. S'inscrit dans B4 (observabilité).
- Railway STAGING reste sur l'ancienne révision — à aligner ou décommissionner (une seule
  vérité d'environnement de démo).

## AJOUT B8 (17/07, cas fondateur/RATP — jugé nécessaire cible B2B) : N° DE BON DE COMMANDE
Les donneurs d'ordre (RATP…) émettent un n° de BC à l'acceptation du devis, exigé SUR la
facture (et requis par les specs e-invoicing quand il existe). Tranche : champ
purchaseOrderRef sur Invoice (domaine+migration additive) + saisie à la création/édition
de facture (+ voix « ajoute le bon de commande 4527 ») + rendu PDF/mentions + i18n ×3.
Court (S-M). Les 3 parcours post-devis (sur place / à distance-attente / différé-BC)
sont intégrés à la découpe du wizard en cours.

## AJOUT B9 (17/07, décision fondateur directe) : RECHERCHE INTELLIGENTE DEVIS & FACTURES
Bimodale et full-stack : ①VOCAL « retrouve les devis de Mairie de Sèvres du mois dernier »
→ navigation + filtres client/dates appliqués automatiquement ; ②MANUEL en parité :
filtres de dates (chips + personnalisé), AUTOCOMPLÉTION sur l'input de recherche,
bouton de recherche avancée (modale : client/numéro/prestation/dates) ; ③DB optimisée
recherche ultra-rapide (indexes trigram/composites tenant-scoped). Standards des
meilleures apps mondiales du genre.

## MAJ 19/07 — ÉLARGISSEMENT DU PÉRIMÈTRE V1 (décisions fondateur) + ÉTAT DES LIVRAISONS

### Décisions fondateur du 19/07 (toutes actées)
1. **AVENANTS = V1** (« indispensable pour exercer, ne peut pas attendre une V1.1 ») — multi-secteurs,
   spec complète SPEC_AVENANTS.md signée Claude, 10 DEC en attente du challenge GPT. ≈16 j-agents, 9 lots.
2. **AUDIT INDISPENSABLES** (AUDIT_INDISPENSABLES_V1.md) : « on enterre tout » — groupe A (8 obligations
   légales) + groupe B recommandé (7 bloquants terrain) entrent en V1.
3. **CANAL DE FACTURATION par client** (email/Chorus Pro/portail — cas RATP/caisses des écoles) : V1,
   version guidée (champ + checklist Chorus avec n° d'engagement B8).
4. Doctrine **« conseiller, jamais contraindre »** + **LegalHint** (pédagogie légale au point de décision) ;
   protections du client et intégrité fiscale non contournables.
5. M2 (relances réellement envoyées) + M4 (dépense dictée) = V1 ; M1/M3/M5 = V1.1.
6. Connecteurs boîte mail = V1.1 (P9), vertical bâtiment/avenants-chantiers = post-V1 (P6.4/P6.5).

### LIVRÉ ET DÉPLOYÉ depuis le 18/07 (serveur = HEAD 613ae684, sign-web à jour)
- Refonte documents/scan complète (une-décision-à-la-fois, reviewedAt, DocumentInsightCard, liens
  document↔chantier, intelligence tenant-aware) + outils vocaux documents ×4.
- B8 bons de commande bout-en-bout (PDF + Factur-X BT-13 + flow vocal RATP + enchaînement facture).
- Dépense↔chantier bout-en-bout + section Dépenses du chantier + M2 relances réelles + M4 dépense dictée.
- Profil fiscal intelligent (dérivations SIRET/Sirene, modales forme/régime séparées, statut social
  expliqué, VL masqué hors micro, sync vatRegime, seuils depuis référentiel sourcé).
- Tenant vierge honnête (cashflow/subscription/spinner devis) — bugs du parcours réel fondateur.
- ÉPIC A complet : 8 obligations légales dont rétractation 14 j avec fonctionnalité EN LIGNE
  (ordonnance 2026-2, page sign-web /retract), embargo L221-10, archivage immuable du contrat signé.
- A3bis : LegalHint, exception dépannage urgent, encaissement J+7 automatique annulable, override
  responsabilisé fail-closed, conseil du canal de signature.
- Navigation croisée des pièces (avoir↔facture↔devis, tags listes, couleurs par famille).
- EN VOL : ÉPIC B (facture directe, situations+tâches, remises, conditions de paiement, retenue de
  garantie 5 %, débours, garde-fou étranger) + canal de facturation.

### RESTE AVANT SIGNATURE PUBLIABLE (les deux signent)
Avenants (après DEC GPT) · crash reporting (webhook à fournir fondateur) · renommage
NICO (bundle id = décision identité fondateur) · cold onboarding re-certifié · grille tarifaire
hors iOS · build groupé de validation fondateur (SUR GO) · incohérence Stripe/release-gate à acter
(MATRICE_FLAGS_V1 n°1 — bloquant première release via workflow).

### MAJ 20/07 nuit — BUILD ANDROID LIVRÉ + STRATÉGIE MONÉTISATION/EARLY-ACCESS ACTÉE (fondateur)
- **BUILD EAS Android preview LIVRÉ** (GO fondateur) : build `4f027256`, commit d091b0b5, APK remis
  au fondateur pour test terrain — premier APK contenant B8/dépense↔chantier/fiscal/épics A-A3bis-B.
- **Monétisation — séquence actée sur analyse** (challenge des options IAP-first et bascule rejeté) :
  ① V1 early-access SANS paiement ; ② V1.1 checkout web Stripe (serveur DÉJÀ ~complet :
  createSubscriptionCheckout/portal/webhooks dans payment-gateway.ts) + Apple Pay/Google Pay,
  app login-only 0 % commission, vraies factures B2B ; ③ V1.2+ datadriven : IAP dual-canal via
  RevenueCat (adapter derrière port, subscriptions = autorité) au prix majoré ~+15-20 %.
  Décision B2 formelle fondateur : GO early-access demandé (débloque l'amendement du release gate).
- **Early-access par vagues (mécanisme fondateur challengé et calibré)** : waitlist (page simple
  email+SIRET, HORS app — pré-sortie) → vagues de 25-30 admis (concierge onboarding via provisioning
  existant, earlyAccess déjà en base backend.service.ts:4815) → récompenses : 3 mois gratuits
  (feedback structuré) · parrainage +3 mois/filleul activé plafonné 12 mois (filleul validé = compte
  + SIRET + 1 action de valeur ≤14 j) · statut « Membre fondateur » (badge + price-lock à vie).
  PARRAINAGE = V1.1 (promesse commerciale d'abord, code ensuite — RIEN ne bloque la publication).
  AJOUTS AU PÉRIMÈTRE (waitlist pré-sortie, parrainage V1.1) : accord GPT requis (règle du gel), notifié.
- Alerting acté : **Sentry région UE** (crash mobile + API) + webhook maison conservé (canal
  critique). Chantier autorisé fondateur (B4) — attente DSN (compte Sentry fondateur) ou webhook.

### MAJ 20/07 — MATRICE FLAGS ✓ LIVRÉE · lane GPT Mistral v2 intégrée ✓
- **MATRICE FLAGS V1 FIGÉE** : `MATRICE_FLAGS_V1.md` (10 familles, 37 flags figés machine-readable,
  gardes boot documentées fichier:ligne) + test anti-drift `apps/api/src/flags-matrix-v1.test.ts`
  (13 tests : défauts env.ts + liste de noms verrouillée + eas.json 2 profils + MUSTANG_VERSION ci).
  Toute modification = accord Claude+GPT. 15 incohérences documentées (n°1 Stripe/gate = bloquante
  release), 12 points « À confirmer » (fondateur/prod/GPT).
- Lane GPT Mistral v2 (dfe38b46) : intégrée ET déployée le 19/07 au soir (merge 25adfddb) —
  challenge adversarial Claude 20/07 : GO_AVEC_CORRECTIFS, garde liveness `nextServerSequence`
  (jamais flipper les flags v2 avant le fix GPT — verrouillé par le test anti-drift).
