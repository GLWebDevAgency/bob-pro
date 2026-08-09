# Registre des activités de traitement (RGPD art. 30)

Chaque traitement mis en œuvre par Bob Pro. « Base légale » au sens de l'art. 6 RGPD.

| # | Traitement | Finalité | Catégories de personnes | Catégories de données | Base légale | Conservation | Destinataires / sous-traitants |
|---|---|---|---|---|---|---|---|
| T1 | **Compte & authentification** | Créer, sécuriser puis clôturer l'accès | Utilisateurs (artisan, collaborateurs) | E-mail, identifiant, jeton de session (JWT) | Exécution du contrat | Accès coupé à la clôture ; suppression Auth tentée sans reprise durable certifiée ; données entreprise conservées selon T2/T3 et autres traitements | Supabase (auth) |
| T2 | **Clients & devis/factures** | Établir devis/factures, suivre l'encours | Clients de l'artisan (B2B, B2G, particuliers) | Identité, adresse, SIREN/TVA, montants, historique | Exécution du contrat / obligation légale (facturation) | Runtime : conservé après clôture. Pièces comptables concernées : **10 ans** (art. L123-22 C. com.) ; clients, contacts, devis et brouillons : **[BLOQUÉ FONDATEUR : classifier et fixer la durée/purge]** | Supabase (DB, RLS) |
| T3 | **Documents & pièces** | Archiver PDF, Factur-X, reçus, justificatifs | Clients, fournisseurs | Fichiers, métadonnées, hash | Obligation légale de conservation pour les pièces concernées / contrat pour les autres | Runtime : conservé après clôture. Pièces comptables concernées : **10 ans** ; autres documents : **[BLOQUÉ FONDATEUR : classifier et fixer la durée/purge]** | Supabase Storage (bucket privé, URLs signées) |
| T4 | **Paiements & encaissements** | Encaisser, générer des liens de paiement | Clients de l'artisan | Montant, statut, référence facture | Exécution du contrat | 10 ans (rapprochement) | Stripe (lien de paiement) |
| T5 | **Relances & e-mails sortants** | Relancer les impayés, envoyer devis/factures | Clients de l'artisan | E-mail, nom, montant, n° de pièce | Intérêt légitime (recouvrement) / contrat | Journal d'envoi borné | Brevo (e-mail transactionnel) |
| T6 | **Assistant IA (classification d'intention)** | Comprendre une commande et proposer l'action | Utilisateur (texte de la commande) | Texte de commande **minimisé** (PII incident masqué) | Intérêt légitime (assistance) ; parcours manuel disponible | Non persisté au-delà de la session de traitement | Mistral pour le routage textuel ; Anthropic pour des tâches critiques. Aucun interrupteur global ni mode IA local utilisateur n'est livré |
| T7 | **Voix (STT / TTS)** | Dicter une commande, écouter la réponse | Utilisateur | Client courant : audio traité par le recognizer local ; V1 historique : enregistrement micro + texte de synthèse ; Bob Live : flux audio micro, texte/contexte nécessaire, réponse audio | Intérêt légitime ; utilisation facultative | Client courant : aucun objet audio Bob. V1 historique : pas d'objet audio Bob, rétention Mistral à certifier. Bob Live : PCM micro non persisté par Bob ; objet de réponse disponible dans le fil 15 min via URL signée ≤ 30 s, métadonnées jusqu'à 30 jours ; purge objet production à certifier avant activation publique | Client courant : appareil ; V1 historique encore appelable par anciens binaires : Mistral/Voxtral tour-par-tour ; Bob Live de publication : OpenAI, actuellement fermé ; Mistral V3 différé |
| T8 | **OCR de pièces** | Extraire les données d'un reçu/justificatif | Fournisseurs, tiers figurant sur la pièce | Image de la pièce, texte extrait | Exécution du contrat (saisie dépense) | Pièce conservée 10 ans ; extraction rattachée | Mistral OCR principal ; Anthropic traitement documentaire de secours ; saisie manuelle disponible |
| T9 | **Trésorerie & tableau de bord** | Calculer disponible/versement, KPI | — (données agrégées de l'artisan) | Montants agrégés | Exécution du contrat | Vivant (recalculé) | Interne |
| T10 | **Journal comptable / grand livre** | Tenir les écritures en partie double, export cabinet | Clients (via écritures) | Comptes, débit/crédit, référence pièce | Obligation légale (comptabilité) | **10 ans** | Supabase (DB, RLS) |
| T11 | **Crash reporting** | Diagnostiquer les plantages mobile et API | Utilisateur ; personnes éventuellement concernées par un contexte technique résiduel | Exception/pile et tags filtrés ; appareil, OS, app, runtime ; aucun corps de requête, document, utilisateur ou transcript admis | Intérêt légitime — mise en balance à valider | **[BLOQUÉ FONDATEUR : rétention Sentry]** | Sentry, région DE selon les DSN actifs |
| T12 | **Mesure de performance mobile** | Détecter régressions de démarrage, rendu et navigation | Utilisateur de l'application | Identifiant aléatoire d'installation, session, appareil/OS, app/build/update, horodatages et durées | Intérêt légitime — mise en balance à valider | Minimum 60 jours selon Expo ; **[BLOQUÉ FONDATEUR : durée maximale]** | Expo / EAS Observe ; région et DPA à confirmer |
| T13 | **Consultation, signature et rétractation publiques** | Permettre au destinataire d'ouvrir et traiter une pièce sans compte | Clients et destinataires de l'artisan | Jeton d'accès dans l'URL, IP, user-agent ; identité et contenu de la pièce chargés depuis l'API | Exécution du contrat / mesures précontractuelles | Données métier selon T2/T3 ; **[BLOQUÉ FONDATEUR : rétention des journaux Vercel et des jetons]** | Vercel (page publique) et Railway (API) ; régions et DPA à confirmer |
| T14 | **Notifications push** | Signaler une nouveauté et renvoyer vers l'inbox authentifiée | Utilisateur | Jeton Expo, message générique, route inbox, identifiant et génération de liaison ; aucun client, montant ou numéro de pièce | Intérêt légitime — mise en balance à valider | Token jusqu'à révocation/désinstallation ; **[BLOQUÉ FONDATEUR : rétentions Expo/APNs/FCM et journaux]** | Expo Push puis Apple APNs ou Google FCM selon la plateforme |

## Mesures transverses (art. 32)

- **Cloisonnement multi-tenant** : Row Level Security Postgres `FORCE` + `WITH CHECK` sur `companyId` ; rôle applicatif non-superuser.
- **Minimisation IA** (T6) : `redactPII` masque e-mail/téléphone/IBAN/SIREN avant l'appel LLM cloud ; les références métier (n° de facture, nom client) nécessaires à l'exécution sont conservées.
- **Voix privée par défaut** (T7) : la dictée classique impose la reconnaissance **on-device**,
  sans transmission ni repli réseau silencieux. Une ancienne préférence `cloud` est neutralisée ;
  sans modèle `fr-FR` local, la capacité vocale se ferme et la saisie texte est proposée. Bob Live
  serveur constitue un canal distinct avec admission/disclosure propres. Sa cible de publication
  est OpenAI ; aucun basculement silencieux vers Mistral n'est admis.
  Les routes Voxtral tour-par-tour V1 ne sont pas modifiées par ce lot et restent potentiellement
  appelables par un ancien binaire ; ce flux distinct est déclaré au registre et doit être certifié
  ou fermé par une décision atomique avant publication.
- **Accès documents** (T3) : jamais servis directement au device — l'API renvoie des URLs signées à TTL court (60–3600 s), scopées `companyId`.
- **Secrets** : clés LLM/paiement/e-mail uniquement côté serveur (jamais sur le device).
- **Télémétrie** (T11/T12) : Sentry applique la liste blanche partagée de scrubbing et coupe les
  traces de performance ; EAS Observe n'utilise que l'instrumentation automatique, sans événement
  métier personnalisé. Aucun opt-out utilisateur n'est actuellement livré.

## Points de vigilance

- **T6 (LLM)** : encadrer Anthropic hors UE par CCT + mesures ; certifier région et rétention Mistral.
  L'utilisateur peut éviter l'Assistant via les parcours manuels, mais aucun opt-out global serveur ni
  mode IA textuel local ne doit être annoncé tant qu'il n'est pas livré.
- **T8 (OCR)** : certifier Mistral principal et Anthropic secours, leurs régions et leurs rétentions,
  conformément à [sous-traitants.md](sous-traitants.md).
- **T7 (Bob Live)** : garder la capacité publique `OFF` tant que le DPA, les garanties de transfert
  OpenAI, l'information avant ouverture et la purge des objets de réponse n'ont pas de preuve
  opérationnelle exact-SHA.
- **T7 (V1 historique)** : inventorier les versions encore actives, prouver l'information et le choix
  avant capture ainsi que DPA/région/rétention Mistral, ou fermer les routes dans un lot autorisé par
  la matrice. Le client courant local-only ne suffit pas à fermer le parc N-1.
- **T11/T12 (Sentry / EAS Observe)** : finaliser DPA, rétentions, région EAS et mise en balance ;
  décider d'un mécanisme d'opposition ou fermer les canaux avant publication commerciale.
- **T1/T2/T3 (clôture)** : l'action in-app ferme l'accès mais ne purge ni n'anonymise le dossier
  métier. Classifier les catégories, arrêter leurs durées, livrer un workflow de purge idempotent et
  une reprise durable de `deleteUser`, puis certifier le résultat avant de parler de « suppression de
  compte » ou d'effacement automatique.
