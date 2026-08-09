// Contenu transcrit verbatim depuis design_handoff_bob_pro/legal/politique-confidentialite.md.
// Aucune dépendance markdown : ce texte est rendu par ./markdown.tsx (parseur minimal maison).
// Les blocages fondateur sont intentionnellement visibles : aucune donnée légale n'est inventée.
export const POLITIQUE_CONFIDENTIALITE_MD = `# Politique de confidentialité — Nico

**Version 1.0**
**Date d'entrée en vigueur : [BLOQUÉ FONDATEUR : DATE D'ENTRÉE EN VIGUEUR]**
**Dernière mise à jour : [BLOQUÉ FONDATEUR : DATE D'ENTRÉE EN VIGUEUR]**

> Application mobile : **Nico** (nom commercial ; l'application peut encore apparaître sous le nom
> technique « Bob Pro » dans certains éléments internes le temps de la transition — cela ne change
> rien aux engagements décrits ici).
> [BLOQUÉ FONDATEUR : confirmer le nom commercial définitif avant publication sur les stores et harmoniser ce document si besoin.]
>
> **Statut de publication : BLOQUÉ** tant que l'identité légale, le contact d'exercice des droits,
> les prestataires/DPA et les garanties de transfert listés ci-dessous ne sont pas complétés.

Cette politique explique, en langage simple, quelles données Nico traite, pourquoi, combien de temps
elles sont gardées, qui peut y avoir accès, et comment faire valoir vos droits. Nico est un copilote
vocal d'administratif et de gestion financière pour les artisans et indépendants : devis, factures,
encaissements, trésorerie, et un assistant vocal pour tout faire à la voix.

---

## 1. Qui est responsable de vos données ?

Le responsable du traitement de vos données personnelles, au sens du Règlement Général sur la
Protection des Données (RGPD), est :

- **Raison sociale / nom commercial** : [BLOQUÉ FONDATEUR : RAISON SOCIALE]
- **Forme juridique** : entrepreneur individuel
- **SIREN** : [BLOQUÉ FONDATEUR : SIREN]
- **Adresse** : [BLOQUÉ FONDATEUR : ADRESSE]
- **Email de contact** : [BLOQUÉ FONDATEUR : EMAIL]

Dans cette politique, « nous » désigne cet éditeur, et « vous » désigne l'utilisateur de l'application
Nico (l'artisan ou l'indépendant qui a créé un compte).

**Un point important à comprendre** : pour les données qui concernent *vos propres clients* (les
personnes ou entreprises à qui vous envoyez des devis et des factures), c'est **vous** qui êtes
responsable de traitement — Nico agit comme un sous-traitant technique qui héberge et traite ces
données pour votre compte, dans le cadre de votre activité professionnelle.

---

## 2. Quelles données traitons-nous ?

### 2.1 Données de compte et d'identité
Email, identifiant de connexion, mot de passe (jamais stocké en clair — géré par notre prestataire
d'authentification, voir section 5), informations de votre entreprise que vous renseignez
(nom commercial, SIREN/SIRET, adresse, régime de TVA, etc.).

### 2.2 Données métier et financières
Les données que vous créez en utilisant l'application pour gérer votre activité : vos clients, vos
devis, vos factures, vos paiements et encaissements, votre trésorerie, vos écritures comptables, vos
documents et pièces justificatives (photos de reçus, factures fournisseurs, etc.).

### 2.3 Données vocales
Nico peut être utilisé à la voix. La **dictée classique** impose un moteur de reconnaissance
strictement local et ne bascule jamais silencieusement vers internet. Sur Android, elle exige Android
13 ou ultérieur et le modèle français installé ; sur iOS, elle exige un moteur local disponible pour
le français. À défaut, le microphone n'est pas ouvert et la saisie au clavier reste disponible.

La synthèse classique n'appelle pas le serveur Bob. Sur Android, Nico ne choisit qu'une voix française
signalée comme ne nécessitant pas de connexion. Sur iOS, elle utilise le service de synthèse configuré
par le système, dont les conditions dépendent d'Apple et des réglages de l'appareil. Si une voix adaptée
n'est pas disponible ou si le moteur échoue, la réponse reste affichée et annoncée sous forme de texte.

Le canal distinct **Bob Live** vise, pour une publication ultérieure, **OpenAI — GPT Realtime**. Cette
capacité est actuellement **fermée au public**. Si elle est activée après certification, l'audio du
microphone sera transmis au serveur puis à OpenAI, avec un transfert hors Union européenne possible.
Bob ne persiste pas le flux PCM entrant du microphone. En revanche, l'audio de réponse généré est
déposé dans un stockage privé : l'objet reste disponible dans le fil pendant 15 minutes et chaque URL
signée, renouvelable pendant cette fenêtre, expire au plus tard après 30 secondes. Ses métadonnées
peuvent être conservées jusqu'à 30 jours. La purge de l'objet audio en production n'est pas encore certifiée ;
Bob Live doit donc rester fermé jusque-là.

La voie **Mistral AI / Voxtral V3** de Bob Live est différée et désactivée : aucun basculement vocal
silencieux vers ce prestataire n'est admis. Une capacité différente, **Voxtral tour-par-tour V1**, reste
cependant configurée sur les routes historiques de transcription et de synthèse. Le client mobile
courant neutralise son ancienne préférence « cloud » et ne les appelle plus pour la dictée classique,
mais un ancien binaire compatible peut encore envoyer un enregistrement microphone à Mistral pour le
transcrire, puis du texte pour générer une réponse audio. Ce flux n'est donc pas présenté comme fermé.
**[BLOQUÉ FONDATEUR : inventorier le parc N-1, certifier information/choix, DPA, région et rétention
Mistral, ou fermer cette capacité dans le lot atomique autorisé par la matrice.]** Mistral intervient
aussi pour des commandes textuelles minimisées et l'extraction de documents (sections 2.4, 2.5 et 5).

[BLOQUÉ FONDATEUR : avant toute ouverture de Bob Live, finaliser le DPA OpenAI, les clauses
contractuelles types et mesures complémentaires, la politique de non-entraînement, l'information
affichée avant ouverture du microphone, ainsi que la purge vérifiée des objets audio.]

### 2.4 Assistant intelligent (compréhension de vos commandes)
Quand vous tapez ou dictez une commande (par exemple « fais un devis pour Monsieur Dupont »), le texte
de cette commande peut être analysé par un assistant d'intelligence artificielle pour comprendre votre
intention et vous proposer l'action correspondante. Avant tout envoi, les informations sensibles
identifiables (email, téléphone, IBAN, numéro SIREN/SIRET) sont automatiquement masquées. Cet assistant
ne fait que *comprendre et proposer* : aucun montant ni aucune décision n'est jamais généré par
l'intelligence artificielle elle-même, et aucune action sensible (émission de facture, encaissement,
envoi à un tiers) n'est exécutée sans votre confirmation explicite. Vous pouvez choisir de ne pas
utiliser l'Assistant et conserver les parcours manuels. L'application ne propose toutefois pas encore
d'interrupteur global ni de moteur IA textuel local ; aucun « mode sans envoi » n'est donc promis.

### 2.5 Documents et extraction automatique (OCR)
Si vous photographiez ou importez un reçu ou un justificatif, l'image peut être transmise à
**Mistral AI** pour l'extraction principale ou à **Anthropic** pour le traitement documentaire de
secours, afin d'en extraire les informations utiles (montant, TVA, fournisseur). La saisie manuelle
reste disponible. [BLOQUÉ FONDATEUR : DPA, région de traitement effective, politique de rétention et
garanties de transfert Anthropic à confirmer avant publication commerciale.]

### 2.6 Données techniques et d'usage
Des données techniques limitées sont envoyées à **Sentry** pour diagnostiquer les plantages : exception
et pile filtrées, environnement, version de l'application et contextes appareil, système et runtime.
Les corps de requête, utilisateurs, transcriptions et documents sont exclus par liste blanche et
l'envoi automatique de données directement identifiantes est désactivé.

**Expo / EAS Observe** reçoit des mesures de performance de l'application (temps de démarrage, premier
rendu, interactivité, chargement de mise à jour et rendu/navigation), ainsi que plateforme, version de
l'application/build/OS, horodatages, identifiants de session et identifiant aléatoire propre à
l'installation. Aucun événement métier personnalisé n'est envoyé par le code actuel. Cet identifiant
persiste entre les mises à jour et est recréé après réinstallation. Ces canaux sont tiers et ne doivent
pas être présentés comme de simples mesures internes — voir la section 8.

Pour les notifications, **Expo Push** reçoit le jeton de l'appareil, un titre et un message génériques,
la route de l'inbox et des identifiants techniques de liaison. Aucun client, montant ou numéro de pièce
n'est placé dans ce payload. Expo le relaie au service de la plateforme, **Apple Push Notification
service (APNs)** ou **Google Firebase Cloud Messaging (FCM)**. Leurs régions, DPA et rétentions doivent
être certifiés avant publication commerciale.

---

## 3. Pourquoi traitons-nous vos données, et sur quelle base légale ?

| Donnée | Finalité | Base légale |
|---|---|---|
| Compte, identifiants | Créer et sécuriser votre accès à l'application | Exécution du contrat qui nous lie |
| Clients, devis, factures | Vous permettre d'établir vos devis/factures et suivre votre activité | Exécution du contrat / obligation légale (facturation) |
| Documents et pièces | Archiver vos justificatifs (Factur-X, reçus) | Obligation légale de conservation comptable |
| Paiements et encaissements | Encaisser vos factures, suivre vos règlements | Exécution du contrat |
| Relances et emails envoyés à vos clients | Vous aider à relancer les impayés | Intérêt légitime (recouvrement) et exécution du contrat |
| Assistant intelligent (texte) | Comprendre votre commande et proposer une action | Intérêt légitime ; utilisation facultative, parcours manuels disponibles |
| Voix (reconnaissance / synthèse) | Vous permettre d'utiliser Nico à la voix | Intérêt légitime ; utilisation facultative, saisie texte disponible |
| Extraction automatique de documents (OCR) | Éviter une saisie manuelle des reçus | Exécution du contrat |
| Crash reporting Sentry | Diagnostiquer et corriger les pannes | Intérêt légitime — mise en balance à valider |
| Performance EAS Observe | Mesurer les temps de démarrage/rendu et les régressions | Intérêt légitime — mise en balance à valider |

---

## 4. Combien de temps conservons-nous vos données ?

C'est le point le plus important à comprendre, car il comporte une nuance légale :

- **Vos pièces comptables — factures, écritures comptables et justificatifs concernés — doivent être
  conservées 10 ans**, en application du Code de commerce (article L123-22). Cette conservation
  continue après la clôture de votre accès.
- L'action disponible dans l'application est aujourd'hui une **clôture irréversible de l'accès**, pas
  une purge immédiate de toutes les données. Elle marque l'entreprise comme clôturée, annule
  l'abonnement, révoque les liens publics et supprime les appareils/diagnostics vocaux rattachés. La
  suppression de l'identifiant d'authentification Supabase est ensuite tentée ; sa reprise durable en
  cas d'échec n'est pas encore automatisée.
- Les données métier restantes — identité légale et coordonnées de l'entreprise, clients et contacts,
  brouillons, devis, documents, préférences et autres relations du dossier — restent actuellement
  conservées après la clôture. Aucune anonymisation ou purge complète de ces catégories n'est livrée.
  **[BLOQUÉ FONDATEUR : classifier chaque catégorie, arrêter sa base légale et sa durée, puis livrer et
  certifier le workflow de purge/anonymisation et la reprise durable de la suppression Auth.]**
- La dictée classique du client courant ne crée aucun objet audio sur les serveurs Bob. Les routes
  tour-par-tour V1 peuvent encore transmettre l'enregistrement à Mistral depuis un ancien binaire ;
  Bob ne le stocke pas comme fichier, mais la rétention fournisseur reste à certifier. Pour Bob Live, actuellement
  fermé au public, le flux microphone entrant n'est pas persisté par Bob ; l'objet audio de réponse
  reste disponible dans le fil pendant 15 minutes, via des URL signées valables au plus 30 secondes,
  et ses métadonnées sont conservées jusqu'à 30 jours. La durée réelle de
  l'objet audio et sa purge automatique doivent encore être certifiées avant toute activation.
- Les journaux techniques sont conservés pour une durée courte, strictement nécessaire à la sécurité
  et au diagnostic, avant suppression automatique. [BLOQUÉ FONDATEUR : fixer et publier la durée
  exacte des journaux.]
- Les métriques EAS Observe sont conservées **au minimum 60 jours** selon la documentation Expo ;
  [BLOQUÉ FONDATEUR : arrêter la durée maximale et la politique de suppression].
- [BLOQUÉ FONDATEUR : arrêter et publier la rétention Sentry des événements mobiles et serveur.]

En clair : **« Clôturer mon compte » coupe l'accès et les capacités actives, mais n'efface pas
immédiatement le dossier métier**. Une demande d'effacement RGPD reste distincte et doit être traitée
catégorie par catégorie, sous réserve des obligations légales de conservation.

---

## 5. À qui vos données sont-elles transmises ?

Nous ne vendons jamais vos données. Elles sont partagées uniquement avec les prestataires techniques
nécessaires au fonctionnement de Nico. Chacun doit agir dans le cadre d'un contrat encadrant l'usage
de vos données ; les contrats encore manquants constituent un blocage de publication :

| Prestataire | Rôle | Données concernées | Localisation |
|---|---|---|---|
| **Supabase** | Hébergement de la base de données, du stockage de documents et de l'authentification | Compte, clients, factures, documents | UE — région Paris (eu-west-3) |
| **Railway** | Hébergement du serveur applicatif (API) | L'ensemble des données transitant par l'application | [BLOQUÉ FONDATEUR : confirmer la région d'hébergement Railway (UE ou hors UE) et compléter ici] |
| **Vercel** | Hébergement du site public de consultation, signature et rétractation | Adresse IP, navigateur, URL contenant un jeton d'accès ; les données métier sont ensuite chargées directement depuis l'API | [BLOQUÉ FONDATEUR : région, DPA, journaux et rétention] |
| **OpenAI — GPT Realtime** (Bob Live, publication actuellement fermée) | Transport, reconnaissance et génération de la réponse vocale | Flux audio microphone, texte/contexte nécessaire, réponse audio | Hors UE possible (États-Unis) — [BLOQUÉ FONDATEUR : DPA, CCT et mesures complémentaires] |
| **Mistral AI** | Compréhension textuelle, OCR, Voxtral tour-par-tour V1 encore accessible aux anciens binaires ; voie Bob Live V3 différée | Texte minimisé ; images et texte extrait ; enregistrement microphone et texte de synthèse si une route V1 est appelée | France / UE — [BLOQUÉ FONDATEUR : DPA, région et rétention à finaliser] |
| **Anthropic (Claude)** | Tâches textuelles critiques et traitement documentaire de secours | Texte minimisé ; image/texte de justificatif si secours activé | Hors UE possible (États-Unis) — [BLOQUÉ FONDATEUR : DPA, CCT et mesures complémentaires] |
| **Sentry** | Crash reporting mobile et serveur | Exception/pile filtrées, tags techniques, appareil/OS/app/runtime ; sans corps de requête, utilisateur, document ou transcript | Région de données DE (Allemagne) d'après les DSN actifs — [BLOQUÉ FONDATEUR : DPA et rétention] |
| **Brevo** | Envoi des emails transactionnels (relances, envoi de devis/factures) | Email, nom, montant, référence de la pièce | UE (France) |
| **Expo / EAS** | Distribution, Expo Push et mesure de performance EAS Observe | Mesures appareil/app ; jeton push, message générique, route inbox et identifiants techniques de liaison | [BLOQUÉ FONDATEUR : région, DPA et durées ; EAS Observe annonce au moins 60 jours] |
| **Apple APNs / Google FCM** | Transport final des notifications selon la plateforme | Jeton push et payload générique relayé par Expo | [BLOQUÉ FONDATEUR : régions, DPA et rétentions] |
| **Prestataire de paiement** (si vous activez les liens de paiement) | Encaissement en ligne de vos factures | Montant, référence de facture, statut du paiement | [BLOQUÉ FONDATEUR : confirmer le prestataire retenu et sa localisation] |

**[BLOQUÉ FONDATEUR : faire signer et vérifier les contrats de sous-traitance applicables avant la
mise en production commerciale.]**

Nous pouvons également transmettre des données si la loi nous y oblige (réquisition judiciaire,
obligation fiscale ou comptable).

---

## 6. Vos données sortent-elles de l'Union européenne ?

La dictée classique reste sur l'appareil. En revanche, le canal Bob Live visé pour une publication
ultérieure transmettrait le flux vocal nécessaire à OpenAI, avec un traitement hors Union européenne
possible. Bob Live est donc fermé au public tant que le DPA, les clauses contractuelles types, les
mesures complémentaires, l'information préalable et la purge des artefacts de réponse ne sont pas
certifiés.

Un transfert hors UE peut également exister pour le fournisseur d'assistant intelligent textuel
mentionné en section 5, selon le fournisseur effectivement activé. Vous pouvez ne pas lancer ces
fonctions et utiliser les parcours manuels ou textuels ; il n'existe pas encore d'interrupteur global
garantissant un Assistant local.

Les DSN Sentry actifs ciblent la région de données allemande. La région effective d'EAS Observe et
les éventuels accès hors UE doivent encore être documentés contractuellement avant publication.

[BLOQUÉ FONDATEUR : arrêter la liste exacte des prestataires activés en production, leurs régions,
leurs DPA et les garanties applicables à chaque transfert hors UE avant publication commerciale.]

---

## 7. Vos droits

Conformément au RGPD, vous disposez des droits suivants sur vos données personnelles :

- **Droit d'accès** : obtenir une copie des données que nous détenons sur vous.
- **Droit de rectification** : corriger une donnée inexacte ou incomplète.
- **Droit à l'effacement** : demander l'examen et, lorsque la loi le permet, l'effacement de vos
  données. La clôture dans l'application ne vaut pas exécution automatique de cette demande ; les
  pièces comptables restent soumises au délai légal de 10 ans (voir section 4).
- **Droit à la portabilité** : récupérer vos données dans un format réutilisable.
- **Droit d'opposition** : vous opposer à un traitement fondé sur notre intérêt légitime en utilisant
  le canal de contact ci-dessous. Indépendamment de cette demande, vous pouvez ne pas utiliser
  l'Assistant ou Bob Live et conserver les parcours manuels ou textuels ; la dictée locale reste
  disponible si le modèle de l'appareil la prend en charge.
- **Droit à la limitation du traitement**, dans les cas prévus par la loi.

**Comment exercer ces droits ?**

- Directement dans l'application : la **clôture de votre accès** est accessible depuis les réglages.
  Elle coupe l'usage du service mais ne constitue pas une purge complète des données métier.
- Par email à [BLOQUÉ FONDATEUR : EMAIL], en précisant votre demande et l'adresse email associée à votre
  compte. Nous répondons dans un délai maximum d'un mois, conformément au RGPD.

Nous pouvons vous demander de justifier votre identité avant de traiter une demande, afin de protéger
vos données contre un accès non autorisé.

---

## 8. Cookies et traceurs

Nico est une application mobile, pas un site web : elle n'utilise **aucun cookie publicitaire tiers**
et ne fait l'objet d'aucun suivi publicitaire (pas de revente de données à des régies publicitaires,
pas de profilage marketing).

Nico utilise toutefois deux services tiers de télémétrie technique : **Sentry** pour les erreurs et
**EAS Observe** pour la performance. Ils ne servent ni à la publicité ni au profilage commercial.
Les événements sont minimisés comme décrit en section 2.6. EAS Observe attribue un identifiant
aléatoire à l'installation et collecte par défaut les métriques des builds de production ; aucun
interrupteur utilisateur n'est actuellement fourni. Sentry est activé dans les builds preview et
production ainsi que sur l'API de production lorsque son DSN conforme est présent.

[BLOQUÉ FONDATEUR : valider la mise en balance de l'intérêt légitime, les DPA, rétentions et régions,
et décider si un mécanisme d'opposition ou une désactivation de ces canaux est requis avant publication.]

---

## 9. Sécurité de vos données

Nous mettons en œuvre des mesures techniques pour protéger vos données, notamment : cloisonnement
strict des données entre chaque entreprise utilisatrice (chaque compte ne peut voir que ses propres
données), accès aux documents via des liens sécurisés à durée limitée, connexions chiffrées, et accès
restreint aux données de production. Aucun système n'étant infaillible à 100 %, nous vous invitons à
protéger votre mot de passe et à nous signaler tout usage suspect de votre compte.

---

## 10. Délégué à la protection des données (DPO) et contact

[BLOQUÉ FONDATEUR : préciser si un DPO est désigné, ou indiquer que le contact ci-dessous fait office de
point de contact protection des données tant qu'aucun DPO formel n'est désigné.]

Pour toute question relative à cette politique ou à vos données personnelles :
**[BLOQUÉ FONDATEUR : EMAIL]**

---

## 11. Réclamation auprès de la CNIL

Si vous estimez que vos droits ne sont pas respectés, vous pouvez adresser une réclamation à la
Commission Nationale de l'Informatique et des Libertés (CNIL) :

- Site web : www.cnil.fr
- Adresse : 3 Place de Fontenoy, TSA 80715, 75334 Paris Cedex 07

Nous vous invitons toutefois à nous contacter en premier lieu, afin de résoudre votre demande
directement.

---

## 12. Modification de cette politique

Cette politique peut être mise à jour, notamment si nous ajoutons une fonctionnalité ou changeons de
prestataire. La date de dernière mise à jour figure en haut de ce document. En cas de changement
important, nous vous en informerons dans l'application avant son entrée en vigueur.

---

*Document préparé par IA — relecture par un professionnel du droit recommandée avant publication.*`;
