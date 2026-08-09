# Registre des sous-traitants ultérieurs (RGPD art. 28)

Prestataires traitant des données personnelles pour le compte de Bob Pro. Un DPA (Data Processing Agreement)
doit être signé avec chacun avant mise en production.

| Sous-traitant | Rôle | Données traitées | Localisation | Base du transfert | DPA | Alternative / fermeture |
|---|---|---|---|---|---|---|
| **Supabase** (Postgres + Storage + Auth) | Hébergement base, stockage documentaire, authentification | T1–T3, T10 (comptes, clients, factures, documents, écritures) | **UE — eu-west-3 (Paris)** | Intra-UE (pas de transfert) | À signer | Non (cœur d'infra) |
| **Railway** | Hébergement du serveur applicatif (API) | Ensemble des données qui transitent par l'API selon la fonction utilisée | **[BLOQUÉ FONDATEUR : région effective]** | **[BLOQUÉ FONDATEUR : déterminer le transfert éventuel]** | **[BLOQUÉ FONDATEUR : DPA]** | Non tant que l'API de production y est hébergée |
| **Vercel** | Hébergement du site public de consultation, signature et rétractation | IP, user-agent, URL porteuse d'un jeton bearer ; chargement navigateur des données métier depuis l'API | **[BLOQUÉ FONDATEUR : région effective]** | **[BLOQUÉ FONDATEUR : déterminer le transfert éventuel]** | **[BLOQUÉ FONDATEUR : DPA, journaux et rétention]** | Auto-hébergement ou fermeture des parcours publics |
| **OpenAI — GPT Realtime** (cible Bob Live de publication, capacité publique `OFF`) | Transport et compréhension vocale temps réel ; génération de réponse | Flux audio micro, texte/contexte strictement nécessaire, réponse audio | **Hors UE possible (États-Unis)** | CCT + mesures supplémentaires à certifier | **[BLOQUÉ FONDATEUR : DPA et garanties de transfert]** | Oui — ne pas ouvrir Bob Live ; dictée locale/texte disponibles |
| **Mistral AI** | Routage LLM textuel, OCR principal, Voxtral tour-par-tour V1 encore appelable par anciens binaires ; Voxtral V3 Bob Live différé | Texte **minimisé**, images/texte extrait ; enregistrement micro et texte de synthèse si une route V1 est appelée | France / UE selon configuration à certifier | Intra-UE à confirmer contractuellement | **[BLOQUÉ FONDATEUR : DPA, région et rétention]** | Client courant : dictée locale/texte ; routes V1 à certifier ou fermer atomiquement |
| **Anthropic (Claude)** | Tâches textuelles critiques et traitement documentaire de secours | Texte de commande **minimisé** ; image/texte de pièce lorsqu'un secours documentaire est déclenché | **Hors UE possible (États-Unis)** | CCT + mesures supplémentaires | **[BLOQUÉ FONDATEUR : DPA, CCT et mesures]** | Parcours manuels disponibles ; aucun interrupteur global IA n'est livré |
| **Sentry** | Crash reporting mobile et API | Exception et pile filtrées, tags techniques, environnement/release ; mobile : appareil, OS, app, runtime | **DE (Allemagne)** selon les DSN `ingest.de.sentry.io` actifs | Région UE ; accès ultérieurs à confirmer | **[BLOQUÉ FONDATEUR : DPA et rétention]** | Canal dormant sans DSN ; aucun interrupteur utilisateur livré |
| **Expo / EAS (Observe + Push)** | Mesure de performance et relais de notifications | Observe : identifiant installation/session, appareil/OS/app/build/update et métriques ; Push : jeton, message générique, route inbox, binding id/génération | **[BLOQUÉ FONDATEUR : régions effectives]** | À documenter | **[BLOQUÉ FONDATEUR : DPA et durées maximales]** | Observe désactivable par configuration ; push remplaçable par l'inbox seule |
| **Apple APNs / Google FCM** | Transport final des notifications iOS/Android relayées par Expo | Jeton push et payload générique sans client, montant ni numéro de pièce | **[BLOQUÉ FONDATEUR : régions effectives]** | **[BLOQUÉ FONDATEUR : transferts éventuels]** | **[BLOQUÉ FONDATEUR : qualification, DPA et rétentions]** | Inbox authentifiée sans push |
| **Stripe** | Liens de paiement, encaissement | Montant, référence facture, statut | UE (entité Stripe UE) + flux internationaux | CCT le cas échéant | À signer | Oui (fonctionnalité paiement en ligne) |
| **Brevo** (ex-Sendinblue) | E-mail transactionnel (relances, envoi de pièces) | E-mail, nom, montant, n° de pièce | **UE (France)** | Intra-UE | À signer | Oui (repli : notifier local d'audit sans envoi) |

## Mesures de minimisation par sous-traitant

- **LLM (Mistral/Anthropic)** — c'est un point de transfert sensible. Atténuations en place :
  - `redactPII` masque e-mail, téléphone, IBAN, SIREN/SIRET **avant** l'envoi (voir [pii-redaction.ts](../../packages/ai/src/guardrails/pii-redaction.ts)).
  - Seul le **texte de commande** est transmis (pas la base clients ni les documents) — aucun contexte massif injecté.
  - Le LLM ne fait que de la **classification d'intention** (tool-calling) ; il ne produit ni montant ni décision métier (le domaine déterministe exécute).
  - L'utilisateur peut choisir les parcours manuels. Il n'existe cependant pas d'interrupteur global
    ni de garantie de classification locale ; l'absence d'une clé fournisseur est un mode opératoire
    de dégradation, pas un choix utilisateur certifié.
- **Voix** — l'ancienne préférence du client courant `cloud` est migrée vers `native`, sans repli
  réseau silencieux. Les routes Voxtral tour-par-tour V1 restent toutefois adressables et peuvent
  traiter l'audio d'un ancien binaire selon la configuration autoritaire ; ce flux doit être certifié
  ou fermé atomiquement, pas déclaré absent. La publication Bob Live cible OpenAI et reste fermée tant que ses garanties ne sont
  pas certifiées. Bob ne stocke pas le PCM micro ; la réponse TTS peut être déposée dans
  `bob-live-audio` (objet/feed 15 min, URL signée ≤ 30 s, métadonnées 30 jours). Le worker de purge objet production n'étant pas
  certifié, aucune suppression automatique plus courte n'est promise.
- **OCR** — Mistral est le chemin principal et Anthropic le secours documentaire dans la configuration
  autoritaire. La saisie manuelle reste l'alternative ; les DPA, régions et rétentions doivent être
  arrêtés avant publication commerciale.
- **Sentry** — `sendDefaultPii=false`, traces de performance coupées, corps de requête/utilisateur et
  contextes non allowlistés supprimés avant envoi. Les DSN actifs sont en région DE ; mobile et API
  restent dormants sans DSN.
- **EAS Observe** — uniquement l'instrumentation automatique de performance et `markInteractive` ;
  aucun `logEvent` métier dans le chemin actuel. La documentation Expo annonce un identifiant aléatoire
  par installation et une conservation minimale de 60 jours, sans constituer une durée maximale.
- **Expo Push / APNs / FCM** — payload volontairement générique : token, contrat de navigation vers
  l'inbox et binding technique ; aucun client, montant ni identifiant de pièce n'est transmis.
- **Documents (Supabase Storage)** — bucket privé ; accès uniquement via URLs signées à TTL court générées côté serveur ; RLS sur les métadonnées.

## Recommandations

1. Encadrer Mistral et Anthropic par leurs DPA, régions, rétentions et garanties de transfert.
   Inventorier/certifier ou fermer le tour-par-tour V1 ; la voie Mistral V3 reste une option
   post-publication, jamais un repli implicite du chemin OpenAI.
2. Certifier la configuration OCR Mistral principal / Anthropic secours sur le SHA publié.
3. Finaliser DPA/rétention Sentry et DPA/région/durée maximale EAS Observe ; décider et documenter le
   mécanisme d'opposition ou la fermeture de ces canaux avant publication commerciale.
4. Conserver la liste à jour : tout nouveau prestataire traitant des données personnelles = nouvelle ligne + DPA avant activation.
