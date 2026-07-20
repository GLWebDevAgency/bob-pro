# Verdict GPT — publication V1 au 18 juillet 2026

## Verdict exécutif

**NO-GO publication.** La V1 possède un socle solide, mais il n'existe pas encore de preuve
reproductible permettant de distribuer le binaire comme un produit fini. Ce verdict ne juge pas
le volume de code : il applique le critère de `PROGRAMME_V1_PUBLICATION.md` — zéro P0, checkout
propre, flags figés, parcours réels et certification sur appareils.

Base committée auditée : `47d9097`. Le worktree principal contient plusieurs lots non commités ;
ils sont des travaux en cours et **ne comptent pas comme preuve de release**. Les audits R4,
fiscal et voix ont été conduits en lecture seule. Aucun de leurs fichiers n'a été modifié.

## Matrice de vérité

| Surface | Verdict | Preuve actuelle | Condition de fermeture |
| --- | --- | --- | --- |
| Accès anticipé sans abonnement payant | **GO après intégration** | `0b154be` aligne `loadEnv`, le gate Railway et `buildPaymentGateway` : les 7 variables Stripe toutes absentes ou vides sélectionnent le gateway inerte ; toute configuration partielle échoue fermée. Tests paiement 9/9, config 45/45, release 33/33, build topologique certifié. | Cherry-pick atomique du commit, puis smoke en configuration production : boot API, écran Compte « accès anticipé », aucun CTA d'achat et gateway de paiement inerte. |
| Retour checkout/portail et factures d'abonnement | **POST-V1, non bloquant** | La V1 décidée n'encaisse aucun abonnement. `2e1a2f1` livre déjà les relais Sign Web, le deep link Compte et le refetch autoritatif nécessaires au futur checkout. | Intégrer et recertifier ce lot au moment d'activer Stripe ; il ne doit pas être cherry-pické dans le candidat V1 uniquement pour « compléter » une capacité volontairement désactivée. |
| Build reproductible du monorepo | **NO-GO P0** | Le checkout commité importe `apps/web/src/cabinet/api.ts` depuis `cabinet-gateway.tsx`, alors que ce fichier reste non suivi dans le worktree principal. Le dernier build propre était vert 9/10, `@bob/web` seul en échec. | Commit atomique du lot Cabinet complet, lockfile inclus, puis `pnpm build` depuis un clone/worktree propre. |
| Signature sur place R4 | **NO-GO P0 ciblé** | `5aa8419` ferme les objectifs fonctionnels R4 initiaux : preuve honnête, révocation lors de la signature, création de lien sans envoi sortant et passage client isolé. Il reste toutefois une course de sécurité : `CreateQuoteSignatureToken` enchaîne lecture, révocation et création hors UoW/verrou devis, alors que `SignQuote` suppose que toute rotation concurrente attend ce verrou. Une rotation intercalée peut donc réactiver un accès après signature ou créer plusieurs liens actifs. | Faire partager à l'émission du lien la même transaction et le même verrou devis que la signature, puis prouver les entrelacements sur PostgreSQL réel et terminer la QA du handoff sur appareils. Hash de version canonique, consentement versionné, archive image et durcissements biométriques/anti-capture restent explicitement post-V1 et ne sont pas réintroduits comme P0. |
| Identité NICO et identifiants stores | **NO-GO P0** | La décision fondateur du 16/07 fixe le nom **NICO**, mais le candidat reste visible comme « Bob Pro » et utilise encore `fr.bobpro.app`. Le logo a été repris directement par le fondateur et sort de cette lane ; cela n'annule pas la migration du nom. | Valider la recherche INPI et l'identifiant de bundle définitif avant première soumission, puis renommer les surfaces visibles, catalogues i18n, prompts et métadonnées stores sans relancer la création du logo. |
| B8 — référence de bon de commande | **NO-GO P0** | Le programme V1 exige `purchaseOrderRef` de bout en bout. Dans le checkout commité, le symbole n'existe que dans la spec et un commentaire du wizard indiquant explicitement ce manque : ni domaine, ni migration, ni API, ni voix, ni PDF. | Livrer la tranche additive complète — domaine, BDD/RLS, API, création/édition facture, voix, rendu PDF, i18n — avec tests ciblés et migration PostgreSQL réelle. |
| B9 — recherche intelligente devis/factures | **GO code ; QA candidat restante** | `f1459b9` livre le contrat core, la recherche PostgreSQL `pg_trgm` tenant-scopée, l'API, l'autocomplétion, les filtres manuels, les périodes vocales et la navigation filtrée. Rejeu isolé du 18/07 : core 36/36, API 5/5 et mobile 15/15. | Rejouer ces suites et le test PostgreSQL sur le SHA candidat, puis vérifier sur appareil la parité doigt/voix, l'isolation tenant, les états vide/erreur et les performances avec un volume réaliste. |
| Profil fiscal et guidance déjà exposés | **NO-GO P0** | Le profil fiscal est réécrit sans CAS ; les corrections multi-champs ne sont pas atomiques. Le parcours peut annoncer « complet » sans `socialStatus`/`fiscalYearEnd`. La guidance traite un versement libératoire inconnu comme faux et emploie une copy trop certaine. | Ajouter transaction/CAS, couverture explicite et niveaux de confiance, ou masquer ces surfaces du candidat. |
| Simulations Publicodes | **OFF post-V1, non bloquant** | Le moteur peut encore qualifier `certified` malgré hypothèses/warnings, mais le programme place ces simulations après la V1 et le flag est correctement fermé par défaut. | Maintenir `FISCAL_PUBLICODES_SIMULATIONS_ENABLED=false` ; corriger et recertifier avant toute ouverture ultérieure. |
| Voix V1 — Voxtral historique tour-par-tour | **NO-GO P0 de QA** | C'est le chemin vocal annoncé pour la V1 avec la seule clé Mistral. La preuve finale sur le SHA candidat, iPhone réel et Android réel, manque encore. | Certifier le flux réellement publié — permissions, écoute, réponse, interruption/reprise d'app, erreurs réseau et latence — sur les deux OS. |
| Bob Live Mistral `bob.mistral-pcm.v1` | **OFF/dogfood, non bloquant** | Le nouveau transport est réellement composé mais volontairement mono-tour, sans barge-in ni plein duplex ; Local-Whisper, secrets dédiés, matrice device et SLO ne sont pas certifiés ensemble. | Garder `BOB_LIVE_ENABLED=false` dans le candidat V1. Ne pas confondre ce transport expérimental avec le chemin Voxtral historique publié. |
| Bob Live Mistral v2/full duplex | **OFF confirmé** | `mistral-conversation-gateway-v2.ts` et le protocole v2 ne sont importés par aucun composition root. Le bootstrap public et le mobile imposent encore v1. | Rester hors composition V1. Activation post-V1 seulement après matrice acoustique, canary et percentiles signés. |
| Module audio natif Bob Live | **NO-GO seulement s'il reste dans le candidat** | Le workflow CI référence les nouvelles fences d'annulation, mais leurs fichiers Kotlin/Swift et tests sont encore non suivis dans le worktree principal. Bob Live étant OFF en V1, ce WIP n'a pas à être forcé dans le binaire. | Deux fermetures valides : livrer et certifier atomiquement le lot natif, ou retirer du candidat et de ses gates toutes les références aux fichiers absents. Aucun checkout propre ne doit dépendre d'un WIP non suivi. |
| Données BDD-only écran par écran | **NON CERTIFIÉ P0** | Les gardes structurants existent (`DEMO_MODE=false`, interdiction d'`EXPO_PUBLIC_DEMO_MODE` et du token statique), mais la matrice autoritative mobile reste non intégrée et aucune campagne route × état × tenant ne prouve encore tous les écrans avec uniquement les données du propriétaire. | Committer la matrice, exécuter le parcours complet avec un compte propriétaire réel, et vérifier missing/error = indisponible/inconnu, jamais zéro ou valeur supposée. |
| Crash reporting mobile | **NO-GO P0** | Aucun reporter global mobile Sentry/Crashlytics équivalent n'est composé. L'API possède un reporter HTTP sanitisé, mais la destination Railway réelle doit encore être prouvée ; `/health` n'est pas un collecteur d'alertes. | Reporter mobile privacy-first, sourcemaps/dSYM/Proguard, test d'événement staging et vrai webhook API. |
| Légal, support et configuration EAS | **PARTIEL** | `app.config.ts` exige les URLs CGU/confidentialité et un **e-mail** support ; cela ne crée pas l'URL support publique demandée par les stores. Le code ne prouve pas non plus la disponibilité live des pages ni la conformité des questionnaires. | Publier et renseigner l'URL support store, smoke HTTPS des pages depuis les deux profils EAS, revue du contenu voix/finance, App Privacy/Data Safety et preuve des artefacts de symbolication. |
| Cold start et QA appareils | **NO-GO P0** | Aucune matrice finale signée iPhone réel + Android réel sur le même SHA de release. | Clean install, création/connexion, SIRET, premier devis, scan, données BDD, voix V1, arrière-plan/reprise et déconnexion sur les deux OS. |
| État Git/claims de release | **NO-GO P0** | Le worktree principal contient des modifications et fichiers non suivis sur Bob Live, Cabinet, Sign Web, docs et lockfile. | Chaque lane doit devenir un commit atomique revu ; le candidat final doit partir d'un checkout propre et reproductible. |

## Matrice de flags exigée pour le candidat V1

Cette matrice privilégie le repli honnête. Elle ne peut être élargie qu'après une nouvelle
certification sur le SHA candidat.

| Capacité | Valeur V1 | Conséquence produit |
| --- | --- | --- |
| Données de démonstration API | `DEMO_MODE=false` | JWT, RLS et BDD réels obligatoires. |
| Données de démonstration mobile | `EXPO_PUBLIC_DEMO_MODE` **absent** | Aucun mode fixture dans le binaire. |
| Token API statique mobile | `EXPO_PUBLIC_API_TOKEN` **absent** | Tenant issu uniquement de l'auth réelle. |
| Paiement abonnement | 7 variables Stripe **toutes absentes/vides** | Accès anticipé sans plan payant ; aucun CTA d'achat actif. |
| Bob Live provider-neutral | `BOB_LIVE_ENABLED=false` | Le protocole realtime non certifié ne démarre pas. Le parcours vocal V1 reste le chemin Voxtral historique tour-par-tour, à certifier sur device. |
| Alias OpenAI Realtime | `OPENAI_REALTIME_ENABLED=false` | Aucune activation cachée sans clé OpenAI. |
| Fiscal Publicodes | `FISCAL_PUBLICODES_SIMULATIONS_ENABLED=false` | Aucune simulation présentée comme certifiée. |
| Mistral v2 full duplex | hors composition | Impossible à activer par une simple variable sur la V1. |
| OTA | OFF pour `1.0.0` tant que le contrat binaire audio n'est pas certifié | Aucun JS plus récent que le module natif installé. |

## Ordre de fermeture recommandé

1. Intégrer `0b154be`, puis livrer atomiquement le lot Cabinet/lockfile. Conserver `2e1a2f1`
   hors candidat tant que le paiement reste volontairement désactivé.
2. Fermer B8 et la course R4, figer le nom NICO et son bundle identifier ; ne pas rouvrir le
   chantier logo repris par le fondateur.
3. Obtenir un build monorepo complet depuis un checkout propre ; conserver ce SHA comme candidat
   et rejouer les preuves B9.
4. Corriger ou masquer le profil/guidance fiscal exposé ; garder les simulations Publicodes OFF.
5. Livrer le lot natif complet, puis certifier le profil vocal **réellement annoncé** sur deux OS.
6. Brancher le crash reporting mobile et un vrai collecteur d'alertes API.
7. Exécuter et signer la matrice BDD-only route × état × tenant avec le compte propriétaire.
8. Vérifier les URLs légales et les questionnaires stores, puis refaire le parcours à froid sur
   le SHA final.

## Signature

- Signature GPT publication : **REFUSÉE au 18/07/2026** tant que les P0 ci-dessus restent ouverts.
- Signature Claude : en attente de relecture après intégration des lanes.

La directive fondateur la plus récente **remplace explicitement** les consignes logo encore
présentes dans `PROGRAMME_V1_PUBLICATION.md` (A3 et action naming du 16/07) : l'audit design peut
continuer, mais le logo et ses assets sont entièrement repris par le fondateur. Ce verdict ne
relance donc aucune création ni modification d'asset. Le renommage technique NICO reste requis,
mais doit être découpé et transmis sans écrire dans les chemins encore travaillés ou revendiqués
par Claude.
