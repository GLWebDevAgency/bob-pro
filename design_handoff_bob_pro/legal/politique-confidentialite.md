# Politique de confidentialité — Nico

**Version 1.0**
**Date d'entrée en vigueur : [EN ATTENTE : DATE D'ENTRÉE EN VIGUEUR]**
**Dernière mise à jour : [EN ATTENTE : DATE D'ENTRÉE EN VIGUEUR]**

> Application mobile : **Nico** (nom commercial ; l'application peut encore apparaître sous le nom
> technique « Bob Pro » dans certains éléments internes le temps de la transition — cela ne change
> rien aux engagements décrits ici).
> [EN ATTENTE : confirmer le nom commercial définitif avant publication sur les stores et harmoniser ce document si besoin.]

Cette politique explique, en langage simple, quelles données Nico traite, pourquoi, combien de temps
elles sont gardées, qui peut y avoir accès, et comment faire valoir vos droits. Nico est un copilote
vocal d'administratif et de gestion financière pour les artisans et indépendants : devis, factures,
encaissements, trésorerie, et un assistant vocal pour tout faire à la voix.

---

## 1. Qui est responsable de vos données ?

Le responsable du traitement de vos données personnelles, au sens du Règlement Général sur la
Protection des Données (RGPD), est :

- **Raison sociale / nom commercial** : [EN ATTENTE : RAISON SOCIALE]
- **Forme juridique** : entrepreneur individuel
- **SIREN** : [EN ATTENTE : SIREN]
- **Adresse** : [EN ATTENTE : ADRESSE]
- **Email de contact** : [EN ATTENTE : EMAIL]

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
Nico peut être utilisé à la voix. Par défaut, la reconnaissance vocale (transformer votre voix en
texte) et la synthèse vocale (faire parler Nico) se font **directement sur votre téléphone**, sans
rien envoyer sur internet.

Une option de voix « qualité renforcée » (cloud) peut être proposée. Dans ce cas, l'enregistrement
audio de votre voix est envoyé à un prestataire spécialisé — **Mistral AI (France/UE)** — le temps
strictement nécessaire pour le transformer en texte ou générer une réponse vocale. **L'audio n'est pas
conservé après ce traitement** : seul le texte qui en résulte (votre commande, ou la réponse de Nico)
reste dans l'application.

À notre connaissance et selon les engagements pris par ce prestataire, votre voix n'est **pas utilisée
pour entraîner ses modèles d'intelligence artificielle sans votre consentement explicite préalable**.
[EN ATTENTE : faire confirmer et documenter contractuellement (contrat de sous-traitance / DPA) cette
absence d'entraînement auprès de Mistral AI avant mise en production, et ajouter ici un lien vers sa
politique de confidentialité.]

### 2.4 Assistant intelligent (compréhension de vos commandes)
Quand vous tapez ou dictez une commande (par exemple « fais un devis pour Monsieur Dupont »), le texte
de cette commande peut être analysé par un assistant d'intelligence artificielle pour comprendre votre
intention et vous proposer l'action correspondante. Avant tout envoi, les informations sensibles
identifiables (email, téléphone, IBAN, numéro SIREN/SIRET) sont automatiquement masquées. Cet assistant
ne fait que *comprendre et proposer* : aucun montant ni aucune décision n'est jamais généré par
l'intelligence artificielle elle-même, et aucune action sensible (émission de facture, encaissement,
envoi à un tiers) n'est exécutée sans votre confirmation explicite. Cette fonction est optionnelle et
peut être désactivée (un mode de reconnaissance simplifié, sans aucun envoi, reste disponible).

### 2.5 Documents et extraction automatique (OCR)
Si vous photographiez ou importez un reçu ou un justificatif, l'image peut être transmise à un
prestataire spécialisé pour en extraire automatiquement les informations utiles (montant, TVA,
fournisseur), afin de vous éviter une saisie manuelle. [EN ATTENTE : confirmer le prestataire retenu
pour cette extraction et sa localisation avant publication ; à défaut, la saisie reste possible
manuellement.]

### 2.6 Données techniques et d'usage
Des données techniques limitées (journaux d'erreurs, mesures internes d'usage de l'application) sont
collectées pour assurer le bon fonctionnement du service et l'améliorer. Ces mesures d'usage internes
sont conçues pour ne contenir **aucune donnée personnelle identifiable** (pas de nom, pas d'email, pas
de contenu de vos documents) — voir aussi la section 8 « Cookies et traceurs ».

---

## 3. Pourquoi traitons-nous vos données, et sur quelle base légale ?

| Donnée | Finalité | Base légale |
|---|---|---|
| Compte, identifiants | Créer et sécuriser votre accès à l'application | Exécution du contrat qui nous lie |
| Clients, devis, factures | Vous permettre d'établir vos devis/factures et suivre votre activité | Exécution du contrat / obligation légale (facturation) |
| Documents et pièces | Archiver vos justificatifs (Factur-X, reçus) | Obligation légale de conservation comptable |
| Paiements et encaissements | Encaisser vos factures, suivre vos règlements | Exécution du contrat |
| Relances et emails envoyés à vos clients | Vous aider à relancer les impayés | Intérêt légitime (recouvrement) et exécution du contrat |
| Assistant intelligent (texte) | Comprendre votre commande et proposer une action | Intérêt légitime, fonction activable/désactivable |
| Voix (reconnaissance / synthèse) | Vous permettre d'utiliser Nico à la voix | Intérêt légitime, fonction activable/désactivable |
| Extraction automatique de documents (OCR) | Éviter une saisie manuelle des reçus | Exécution du contrat |
| Mesures d'usage internes | Comprendre l'usage du produit, l'améliorer, le sécuriser | Intérêt légitime |

---

## 4. Combien de temps conservons-nous vos données ?

C'est le point le plus important à comprendre, car il comporte une nuance légale :

- **Vos pièces comptables — factures, devis transformés en facture, écritures comptables, justificatifs
  — doivent être conservées 10 ans**, en application du Code de commerce (obligation légale de
  conservation des documents comptables, article L123-22). **Cette conservation continue même après
  la suppression de votre compte** : nous ne pouvons pas effacer ces documents avant l'expiration de ce
  délai légal, sous peine de vous mettre en difficulté en cas de contrôle fiscal ou de litige avec un
  client. Passé ce délai, ces documents sont supprimés ou anonymisés.
- **Tout le reste** (données de compte, préférences, historique d'usage, brouillons non transformés en
  facture) est **supprimé ou anonymisé** dès la clôture de votre compte, ou après une période
  d'inactivité prolongée [EN ATTENTE : fixer et documenter ici la durée d'inactivité exacte retenue,
  par exemple 24 ou 36 mois].
- **L'audio de votre voix n'est jamais conservé** : il est transformé en texte à la volée, puis effacé.
- Les journaux techniques (logs) sont conservés pour une durée courte, strictement nécessaire à la
  sécurité et au diagnostic, avant suppression automatique.

En clair : **supprimer votre compte n'efface pas vos factures avant 10 ans**, parce que la loi l'exige
— mais tout le reste disparaît.

---

## 5. À qui vos données sont-elles transmises ?

Nous ne vendons jamais vos données. Elles sont partagées uniquement avec les prestataires techniques
nécessaires au fonctionnement de Nico, chacun agissant comme sous-traitant dans le cadre d'un contrat
encadrant l'usage de vos données :

| Prestataire | Rôle | Données concernées | Localisation |
|---|---|---|---|
| **Supabase** | Hébergement de la base de données, du stockage de documents et de l'authentification | Compte, clients, factures, documents | UE — région Paris (eu-west-3) |
| **Railway** | Hébergement du serveur applicatif (API) | L'ensemble des données transitant par l'application | [EN ATTENTE : confirmer la région d'hébergement Railway (UE ou hors UE) et compléter ici] |
| **Mistral AI** | Reconnaissance et synthèse vocale (option voix cloud) | Audio de votre voix (non conservé), texte transcrit | France / UE |
| **Fournisseur d'assistant intelligent** (Anthropic Claude, ou alternative) | Compréhension du texte de vos commandes | Texte de commande, avec informations sensibles masquées avant envoi | [EN ATTENTE : ce prestataire peut être situé hors UE (États-Unis) — confirmer le prestataire retenu en production et les garanties de transfert mises en place (clauses contractuelles types)] |
| **Brevo** | Envoi des emails transactionnels (relances, envoi de devis/factures) | Email, nom, montant, référence de la pièce | UE (France) |
| **Expo / EAS** | Distribution de l'application et notifications push | Identifiant technique de l'appareil, notifications | [EN ATTENTE : confirmer la localisation de ce prestataire] |
| **Prestataire de paiement** (si vous activez les liens de paiement) | Encaissement en ligne de vos factures | Montant, référence de facture, statut du paiement | [EN ATTENTE : confirmer le prestataire retenu et sa localisation] |
| **Fournisseur d'extraction OCR** | Extraction automatique des données d'un reçu/justificatif | Image de la pièce, texte extrait | [EN ATTENTE : à confirmer, voir section 2.5] |

Chacun de ces prestataires est engagé (ou en cours d'engagement) par un contrat de sous-traitance
conforme à l'article 28 du RGPD. [EN ATTENTE : faire signer les contrats de sous-traitance restants
avant la mise en production commerciale.]

Nous pouvons également transmettre des données si la loi nous y oblige (réquisition judiciaire,
obligation fiscale ou comptable).

---

## 6. Vos données sortent-elles de l'Union européenne ?

La majorité de vos données (compte, clients, factures, documents, voix) reste hébergée dans l'Union
européenne. Un transfert hors UE peut néanmoins exister pour le prestataire d'assistant intelligent
(texte) mentionné en section 5, selon le fournisseur effectivement utilisé en production. Lorsque c'est
le cas, ce transfert est encadré par les garanties prévues par le RGPD (clauses contractuelles types de
la Commission européenne, mesures de sécurité complémentaires). Cette fonction reste par ailleurs
**désactivable** : un mode de fonctionnement local, sans aucun envoi hors de votre appareil, est
toujours disponible.

[EN ATTENTE : trancher et documenter précisément, avant publication, le ou les prestataires
effectivement activés en production et le statut définitif de chaque transfert hors UE.]

---

## 7. Vos droits

Conformément au RGPD, vous disposez des droits suivants sur vos données personnelles :

- **Droit d'accès** : obtenir une copie des données que nous détenons sur vous.
- **Droit de rectification** : corriger une donnée inexacte ou incomplète.
- **Droit à l'effacement** : demander la suppression de vos données — dans la limite du délai légal de
  conservation de 10 ans pour les pièces comptables (voir section 4).
- **Droit à la portabilité** : récupérer vos données dans un format réutilisable.
- **Droit d'opposition** : vous opposer à un traitement fondé sur notre intérêt légitime (par exemple,
  désactiver l'assistant intelligent ou la voix cloud).
- **Droit à la limitation du traitement**, dans les cas prévus par la loi.

**Comment exercer ces droits ?**

- Directement dans l'application : la suppression de votre compte est accessible depuis les réglages
  de l'application.
- Par email à [EN ATTENTE : EMAIL], en précisant votre demande et l'adresse email associée à votre
  compte. Nous répondons dans un délai maximum d'un mois, conformément au RGPD.

Nous pouvons vous demander de justifier votre identité avant de traiter une demande, afin de protéger
vos données contre un accès non autorisé.

---

## 8. Cookies et traceurs

Nico est une application mobile, pas un site web : elle n'utilise **aucun cookie publicitaire tiers**
et ne fait l'objet d'aucun suivi publicitaire (pas de revente de données à des régies publicitaires,
pas de profilage marketing).

Nous utilisons uniquement une mesure d'usage **interne** (nos propres outils, pas de service tiers
type Google Analytics ou équivalent), destinée à comprendre quelles fonctionnalités sont utilisées et
à améliorer le produit. Cette mesure est conçue pour ne contenir aucune donnée permettant de vous
identifier personnellement (pas de nom, pas d'email, pas de contenu de vos documents). Cette collecte
est **facultative pour le fonctionnement de l'application** : Nico fonctionne normalement même si elle
est désactivée côté serveur.

---

## 9. Sécurité de vos données

Nous mettons en œuvre des mesures techniques pour protéger vos données, notamment : cloisonnement
strict des données entre chaque entreprise utilisatrice (chaque compte ne peut voir que ses propres
données), accès aux documents via des liens sécurisés à durée limitée, connexions chiffrées, et accès
restreint aux données de production. Aucun système n'étant infaillible à 100 %, nous vous invitons à
protéger votre mot de passe et à nous signaler tout usage suspect de votre compte.

---

## 10. Délégué à la protection des données (DPO) et contact

[EN ATTENTE : préciser si un DPO est désigné, ou indiquer que le contact ci-dessous fait office de
point de contact protection des données tant qu'aucun DPO formel n'est désigné.]

Pour toute question relative à cette politique ou à vos données personnelles :
**[EN ATTENTE : EMAIL]**

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

*Document préparé par IA — relecture par un professionnel du droit recommandée avant publication.*
