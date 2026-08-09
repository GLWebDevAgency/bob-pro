# Audit concurrent ATTIX — voix, devis, base BTP et expérience mobile

**Date de l'audit : 9 août 2026**

**Mise à jour du snapshot Bob : 10 août 2026**

**Artefact principal : ATTIX Android 1.7.6 (89), package `com.mozza.attixmobileapp`**

**Statut : audit statique documenté — aucune exécution authentifiée, aucun contournement de licence**
**Portée Bob : éclaire O3, O4, O5 et O7 ; ce document ne modifie pas la direction produit normative**

## 1. Résumé exécutif

ATTIX donne une impression de grande fluidité dans ses captures marketing. La branche de devis
vocal statiquement câblée la plus cohérente est étroite, séquentielle et dotée de mécanismes de
reprise. Elle ne montre pas un assistant vocal duplex continu comparable à Bob Live. Le client
prévoit l'enregistrement d'un fichier audio, sa transcription, la correction du texte, une
conversation de clarification, puis la génération du devis par flux d'événements avec une route
JSON de repli. Le succès de ce parcours, sa persistance serveur et sa latence ne sont pas établis
sans exécution authentifiée.

Le secret produit est donc moins un modèle vocal exceptionnel qu'une orchestration bien cadrée :

```text
Appui micro
   → options d'encodage M4A/AAC mono 16 kHz demandées
   → pause / reprise / validation
   → transcription serveur
   → texte modifiable
   → questions de clarification
   → génération progressive du devis
   → contrôle des prestations et fournitures
   → aperçu PDF
   → envoi explicite
```

Cette conception réduit fortement la surface de situations qui fragilisent un agent temps réel :
barge-in, concurrence entre reconnaissance et synthèse, changement de fournisseur et négociation
de capacités. Elle ne supprime ni la dépendance au service d'enregistrement natif, ni les pannes
réseau/serveur, ni les interruptions. ATTIX fait peu de choses à la fois, mais chacune a un état
visible et une sortie manuelle. L'audit statique établit cette différence d'architecture ; il ne
mesure pas à lui seul la fluidité réelle sur appareil.

Ses deux autres avantages sont très nets :

1. la création de devis est le cœur de la navigation et non une capacité générique cachée dans un
   assistant ;
2. la « Base » est un vrai modèle métier BTP, séparant prestations, fournitures, coût, temps,
   pertes et marges, et non un simple catalogue de libellés et prix.

La bonne réponse pour Bob n'est pas de copier l'interface ni de renoncer à GPT Realtime. Elle est
de rendre la mission « devis chantier » indépendante du transport vocal : checkpoints éditables,
états persistés, schémas d'événements, reprise, base BTP riche et confirmation explicite. Le temps
réel pourra ensuite accélérer cette machine sans devenir son unique source de vérité.

## 2. Méthode, sources et limites

### 2.1 Artefacts analysés

| Artefact | Taille | SHA-256 |
| --- | ---: | --- |
| `ATTIX.apk` | 80 Mo | `e4caacd056e3e2360ec77fde1845b3f56d005677cdcdafbeccc722beeaeac3b9` |
| `com.mozza.attixmobileapp-1.7.6-89.zip` | 42 Mo | `2d3039787589fbe9493537c10266a5fdaf8c1c086c1c32a7f39f00400b22cfd7` |
| bundle Hermes décompilé | — | `0f3613a49702a87d5156b264e3805c70788fb2c82dc52485e68a4cbb0f1dbeb1` |

L'analyse couvre le manifeste Android, les ressources, les modules et routes identifiables dans le
bundle Hermes, les contrats réseau visibles, les modèles de formulaire, les composants de
navigation et les douze captures marketing embarquées/récupérées pour le store. Les captures 7 à
12 reprennent, au format tablette, le récit des captures téléphone 1 à 6.

### 2.2 Ce qui n'a pas été fait

- aucun contournement du contrôle de licence ou de l'authentification ;
- aucune connexion à un compte ATTIX ;
- aucun appel aux API de production ;
- aucune interception réseau ni observation du modèle ou des prompts serveur ;
- aucune mesure chronométrée sur appareil ;
- aucune conclusion sur une vulnérabilité exploitable à partir du seul code statique.

Les promesses marketing, notamment « un devis en 60 secondes », restent donc non vérifiées.

### 2.3 Cadre d'usage juridique

Les artefacts ont été fournis par le commanditaire, mais leur provenance licite, le droit d'usage
attaché à la copie et les CGU applicables n'ont pas été vérifiés indépendamment. L'absence de
contournement ne suffit pas à elle seule à autoriser toute décompilation, utilisation ou diffusion.

Ce rapport reste donc **interne et soumis à revue juridique**. Jusqu'à validation :

- ne redistribuer ni APK/ZIP, ni bundle décompilé, ni code, ni ressources ou captures ATTIX ;
- ne publier aucun extrait substantiel du code ou des assets ;
- ne reprendre que des idées fonctionnelles générales, avec conception et implémentation
  indépendantes, sans expression substantiellement similaire ;
- vérifier provenance, droit d'utiliser l'exemplaire, CGU et obligations de confidentialité avant
  toute circulation élargie.

Le cadre à faire valider comprend notamment l'[article L122-6-1 du Code de la propriété
intellectuelle](https://www.legifrance.gouv.fr/codes/article_lc/LEGIARTI000044365559), qui encadre
l'observation et la reproduction/traduction du code, et l'[article 3 de la directive (UE)
2016/943](https://eur-lex.europa.eu/eli/dir/2016/943/oj?locale=fr), qui conditionne notamment
l'observation/démontage à la mise à disposition publique ou à la possession licite sans obligation
valable limitant l'obtention du secret.

### 2.4 Niveau de confiance

| Niveau | Signification |
| --- | --- |
| Élevé | preuve directe dans le bundle, le manifeste ou plusieurs captures cohérentes |
| Moyen | inférence convergente à partir des routes, composants et états, sans exécution |
| Faible | promesse marketing ou comportement nécessitant le serveur/un appareil |

### 2.5 Snapshot Bob comparé

La comparaison Bob porte sur la PR [#82](https://github.com/GLWebDevAgency/bob-pro/pull/82), branche
`agent/gpt/pr82-voice-asr-recovery`, basée sur `origin/main@d0981ba2`. Le runtime a été validé
localement au commit exact `7d5720006305579b2abdfdb65c0d90197476bee4` ; le commit
`4f9b385c` consigne les preuves et le statut `implemented`. Aucun de ces SHA n'est un SHA de
release. Les lignes « Bob » distinguent l'Assistant classique réellement exposé, Bob Live
production `OFF` et M2-A sous flags/non certifié.

## 3. Anatomie technique d'ATTIX

### 3.1 Socle mobile

Le manifeste et le bundle établissent les éléments suivants avec un niveau de confiance élevé :

- version 1.7.6, code 89, Android minimum 24 et cible 36 ;
- application React Native/Expo avec bundle Hermes, Expo Router et React Navigation ;
- requêtes HTTP Axios, validation de données Zod et stores applicatifs de style Zustand ;
- capture audio Expo AV ;
- RevenueCat pour l'abonnement ;
- Amplitude et AppsFlyer pour l'attribution/télémétrie ;
- notifications, ML Kit et fonctions de document/import.

La structure des modules montre une architecture d'interface relativement découpée : routes
d'authentification, layouts protégés, écrans métier, hooks de données, utilitaires de calcul et un
design system propre (`AInput`, `AText`, `AToggle`, `BottomSheetModal`, `RecordingBar`, `Stepper`,
barres d'actions PDF, badges et cartes).

Ce découpage ne prouve pas une Clean Architecture côté métier, car le bundle ne permet pas de voir
le serveur et le code est aplati, mais il explique la cohérence visuelle et comportementale.

### 3.2 Navigation observée

La navigation principale protégée expose cinq onglets :

| Onglet ATTIX | Rôle |
| --- | --- |
| Base | prestations et fournitures BTP |
| Clients | liste, fiche, création particulier/entreprise |
| Création | devis vocal, texte, conversation IA et reprise |
| Documents | devis, factures, filtres et actions par statut |
| Profil | entreprise, équipe, modalités, marges, abonnement |

Le choix important est que « Base » et « Création » sont au premier niveau. Le produit annonce
immédiatement ses deux valeurs : produire un devis et réutiliser le savoir économique de
l'entreprise.

### 3.3 Authentification et onboarding

Le parcours d'accès comporte connexion, inscription, OTP e-mail, mot de passe oublié et
réinitialisation. Une notion d'organisation et un sélecteur d'organisation sont également présents.

L'onboarding est séparé en deux couches :

1. un wizard opérationnel `Entreprise → Coordonnées → Prêt`, avec recherche d'entreprise et repli
   de saisie manuelle ;
2. un onboarding de valeur en cinq écrans qui explique la dictée sur chantier, la génération, la
   base qui apprend des devis validés et les exemples de questions possibles.

Cette séparation est efficace : les données nécessaires ne sont pas mélangées au tutoriel produit.
Cette séparation rendrait possible de rejouer l'explication sans rejouer l'immatriculation ; le
comportement de reprise n'a pas été exécuté.

## 4. Le vrai fonctionnement du devis vocal

### 4.1 Capture et transcription

La branche statiquement câblée utilise Expo AV et demande un fichier `.m4a` : MPEG-4/AAC sur
Android, audio de qualité élevée sur iOS, mono, 16 kHz et 64 kb/s. Ces paramètres sont des options
d'encodage demandées ; le fichier effectivement produit par chaque OS n'a pas été inspecté. Le code
expose pause, reprise, arrêt et déchargement de l'enregistrement.

Le fichier est ensuite envoyé en multipart vers `POST /voice/transcribe`. Le client fixe un délai
de 30 secondes et prévoit le suivi de la progression de l'upload. La transcription alimente un
champ modifiable, avec une consigne équivalente à « Corrigez ou ajoutez des informations ».

Bénéfices UX recherchés par cette conception, à valider en exécution :

- l'artisan sait quand il enregistre et quand l'application traite ;
- une mauvaise reconnaissance ne détruit pas le parcours ;
- la correction clavier est un checkpoint normal, pas un échec honteux ;
- le serveur reçoit une unité audio complète et n'a pas à gérer un flux duplex instable.

### 4.2 Conversation et génération

Après validation du texte, le client manipule un `conversationId` et transmet notamment ce dernier,
le message, le profil artisan et, quand il existe, le client sélectionné. Cela indique une
conversation récupérable côté contrat, sans prouver la durabilité serveur.

La fonction de génération streamée appelle :

`POST /voice/generate-quote-from-conversation/stream`

avec `Accept: text/event-stream`. Les événements sont validés par un schéma Zod avant d'alimenter
l'interface. Un store empêche plusieurs générations concurrentes pour une même conversation et
conserve l'identité de la génération en cours.

Une route JSON classique existe également comme solution de repli candidate :

`POST /voice/generate-quote-from-conversation`

Le bundle contient en outre des utilitaires nommés `loadAssistantTurnRecovery`,
`quoteGenerationRecovery`, `getConversationWithSnapshots` et une récupération du devis par
conversation. Ces chemins client de tentative de reprise sont présents et appelés dans le bundle ;
la persistance serveur, leur convergence après réponse perdue et leur succès réel ne sont pas
certifiés sans exécution.

### 4.3 Progression visible

Les captures montrent trois jalons `Devis → Client → Modalités`, une transcription dans le fil,
un texte annonçant la création d'une première version et un indicateur de chargement. Le bundle
contient aussi une `StreamingProgressChecklist` et un hook dédié au progrès de génération.

L'interface prévoit donc des jalons et un texte d'attente plutôt qu'une simple orbe. Elle garde les
flèches de navigation et le micro dans une zone d'action fixe. Le temps maximal, la bonne reprise,
le focus et la fluidité de ces transitions ne sont pas mesurés.

### 4.4 Ce qui ne semble pas être la branche de production principale

Un ancien hook `use-voice-recognition.ts` subsiste. Il importe un module nommé `mock-voice` qui :

- annonce le service disponible ;
- émet un résultat partiel après environ 1,5 seconde ;
- émet après environ 3 secondes une transcription fixe décrivant une toiture de 100 m².

Le package natif `react-native-voice` est également présent dans l'artefact. Rien dans l'analyse ne
permet toutefois d'en faire le moteur du parcours actif décrit ci-dessus. Les références du hook
semblent surtout venir du contexte de routes/bundle. Confondre ce prototype mocké avec la chaîne
fichier → transcription → conversation conduirait à une mauvaise lecture de la fluidité d'ATTIX.

### 4.5 Différences de conception susceptibles d'expliquer la fluidité perçue

| Dimension | ATTIX store-and-forward observé | Bob classique avant le lot P0 | Bob Live Realtime |
| --- | --- | --- | --- |
| Portée | mission devis bornée | tour vocal dans un assistant global | mission continue, navigation et outils |
| Audio | fichier fini envoyé au serveur ; aucun retour vocal prouvé | ASR local puis cerveau puis TTS local, donc semi-duplex | transport audio plein-duplex cible |
| Reconnaissance | erreur corrigeable dans un champ | erreurs natives parfois silencieuses et fin de session ambiguë | transcription et audio liés à la session distante |
| Progression | jalons, checklist, transcription | phases d'écoute/réponse moins directement reliées au devis | phases de transport, admission, mission et livraison |
| Reprise | tentative de reprise conversation/génération statiquement prévue, non certifiée | cycle court local ; reprise métier séparée | reprise répartie entre session, admission et mission |
| Portes serveur | STT puis SSE, avec route JSON de repli | cerveau métier seulement après transcription locale | readiness, admission, capacité M2-A, fournisseur et livraison audio |
| Sortie devis | devis structuré puis revue | réponse/outils classiques | M2-A encore limitée au brouillon de lignes ; finalisation due |

Le différentiel n'est donc pas « leur IA est forcément plus rapide ». L'architecture ATTIX réduit
les courses audio et rend davantage d'attentes réversibles. Seuls un test authentifié et des
mesures sur appareils permettraient d'en faire la cause démontrée de sa fluidité réelle.

## 5. La base BTP : le plus gros avantage métier

### 5.1 Deux objets distincts

ATTIX sépare clairement :

- les **fournitures**, qui portent la réalité d'achat et de conditionnement ;
- les **prestations**, qui assemblent fournitures, main-d'œuvre, temps et marge.

Cette séparation permet de raisonner en coût de revient et non uniquement en prix de vente.

### 5.2 Données de fourniture observées

Le modèle et les formulaires exposent notamment :

- nom, fournisseur, fabricant et référence ;
- unité de vente et unité d'usage ;
- prix d'achat/unitaire ;
- quantité par conditionnement et facteur de conversion ;
- description du conditionnement ;
- quantité consommée par prestation ;
- taux de marge, avec valeur par défaut observée autour de 20 % ;
- taux de perte dans les calculs de devis.

Les unités repérées comprennent `u`, `m`, `m²`, `m³`, `ML`, `RL`, `kg`, `L`, `h` et `forfait`.

### 5.3 Données de prestation observées

Une prestation peut combiner :

- titre, quantité, unité, prix unitaire et TVA ;
- temps de travail ;
- coût de main-d'œuvre et marge associée ;
- liste de fournitures et quantités ;
- marge sur fournitures ;
- perte ;
- variantes et base de prestation réutilisable.

Des gardes empêchent notamment un prix inférieur au coût des fournitures et un temps de travail
négatif. Ce sont des garde-fous économiques, pas seulement de la validation de formulaire.

### 5.4 Boucle d'apprentissage opérationnelle

Le produit suggère la boucle suivante :

```text
devis généré
   → correction par l'artisan
   → validation
   → enrichissement de la base prestations/fournitures
   → prochain devis plus proche des habitudes réelles
```

Le bundle contient également des parcours d'analyse de facture fournisseur, résultats d'import,
édition des fournitures importées, mise à jour en cascade et export Excel. Cela transforme une
facture d'achat en matière première de chiffrage.

### 5.5 Écart avec Bob aujourd'hui

Le modèle Bob `CataloguePrestation` stocke actuellement le libellé, la catégorie, une unité
optionnelle, le prix unitaire HT, la TVA et une révision tenant-scoped. L'écran Catalogue permet la
recherche, la catégorie, le prix et la TVA ; lors d'une création, l'unité n'est pas directement
saisie et reste reprise d'une source existante ou nulle.

Ce socle Bob est propre, RLS et sans données inventées, mais il ne représente pas encore :

- le coût d'achat ;
- le fournisseur et le conditionnement ;
- la nomenclature d'une prestation ;
- le temps et le coût de main-d'œuvre ;
- les pertes, déboursés, frais et marges séparées ;
- l'historique de prix et l'effet d'une mise à jour ;
- l'import contrôlé d'une facture fournisseur.

ATTIX est donc en avance non par la taille du catalogue, mais par la qualité du modèle économique.

## 6. Expérience utilisateur détaillée

### 6.1 Forces de conception statiquement observables

Les effets sur la compréhension, la vitesse et la conversion restent à mesurer sur appareil :

1. **Une promesse immédiatement visible.** La capture d'ouverture dit ce que l'utilisateur va
   obtenir, dans quel contexte et avec quel effort.
2. **Un geste dominant.** Le micro est grand, central et personnalisé par le prénom.
3. **Une mission lisible.** `Devis → Client → Modalités` maintient la position et réduit la charge
   mentale.
4. **Des checkpoints éditables.** Transcription, prestation, fourniture, client et modalités sont
   corrigibles avant l'effet final.
5. **Une génération progressive.** Checklist, messages d'attente et événements streamés visent à
   éviter le trou noir.
6. **Une revue structurée.** Le résultat IA devient un tableau, puis des fiches de détail, puis un
   PDF ; il ne passe pas directement de la voix à l'envoi.
7. **Des actions adaptées au statut.** Brouillon, devis généré, attente de signature et devis facturé
   possèdent des feuilles d'actions distinctes.
8. **Une cohérence de composants.** Entrées, boutons, modales, feuilles, barres d'action et statuts
   reposent sur une bibliothèque interne dédiée.
9. **Plusieurs replis manuels prévus.** Recherche manuelle d'entreprise, correction du texte,
   édition des lignes et navigation sont représentées dans le client.

### 6.2 Bottom sheets et modales

Une cinquantaine de modules portent une responsabilité de modal, bottom sheet ou action sheet :
type de client, entreprise/particulier, modalités, délai de paiement, taux/marge, versions du devis,
envoi, export, import, facture fournisseur et actions par statut.

Le bon principe à retenir est la contextualisation : chaque feuille répond à une décision courte.
Il ne faut pas reprendre le volume tel quel. Un trop grand nombre de modales peut créer des
problèmes de focus, clavier, accessibilité, profondeur de navigation et cohérence de fermeture.

### 6.3 Parcours visuel des captures

| Capture | Message produit | Ce que l'interface enseigne |
| --- | --- | --- |
| 1 | devis « en 60 secondes » depuis le chantier | bénéfice avant fonctionnalités |
| 2 | accueil personnalisé et gros micro | un geste pour démarrer |
| 3 | IA qui questionne/vérifie/ajuste | jalons, transcription, attente expliquée |
| 4 | base prestations avec fournitures | mémoire métier visible et réutilisable |
| 5 | édition détaillée d'une prestation | l'IA propose, l'artisan reste maître |
| 6 | aperçu PDF et envoi | résultat concret et sortie claire |

### 6.4 Faiblesses UX à surveiller

- la promesse de 60 secondes peut devenir contre-productive sur réseau lent ou devis complexe ;
- le nombre de feuilles/modales augmente le risque de navigation en pile et de problèmes de
  lecteurs d'écran ;
- la dépendance au réseau demeure forte malgré l'impression de simplicité ;
- le vieux hook de reconnaissance mocké constitue une dette et peut induire les mainteneurs en
  erreur ;
- l'analyse statique ne prouve ni VoiceOver/TalkBack, ni le comportement clavier, ni la reprise
  réelle sur appareil bas de gamme.

## 7. Sécurité, confidentialité et qualité à auditer

### 7.1 Stockage de session

Le bundle utilise des clés `@attix_auth_token`, `@attix_refresh_token`, `@attix_user` et
`@attix_current_org` à travers la couche AsyncStorage. Le module Expo Secure Store est embarqué,
mais aucun appel applicatif clair à `SecureStore` n'a été identifié dans le bundle décompilé.

Le manifeste déclare `android:allowBackup="true"`. Les règles de sauvegarde reliées à
l'application sont celles d'AppsFlyer et ne montrent pas, dans l'inspection statique, une exclusion
explicite de la base AsyncStorage. Il s'agit d'un risque de sauvegarde des jetons à confirmer par un
test d'appareil et non de la preuve d'une extraction exploitable.

Bob partage actuellement une partie de cette classe de risque : le client Supabase est configuré
avec `storage: AsyncStorage` et `persistSession: true`. Le différentiel de sécurité mobile n'est donc
pas établi. Pour les deux produits, les exigences sont un stockage chiffré lié au terminal quand le
contrat le permet, des exclusions de backup vérifiées sur l'artefact release et une rotation/
révocation serveur certifiée.

### 7.2 Journalisation de la transcription et fichier local

Sur succès, la réponse `data` de `/voice/transcribe` est placée dans une propriété de log
`custom.responseData`; une réponse d'erreur peut l'être également. Le logger recopie les métadonnées
sans redaction client visible, sérialise son buffer dans AsyncStorage sous `attix_log_buffer`, puis
envoie les entrées vers `/logs` ou `/logs/batch`.

Le schéma exact de la réponse n'étant pas connu, il n'est pas possible d'affirmer que le transcript
complet est journalisé. Il existe néanmoins un flux **potentiel de transcript ou PII** vers le
buffer local et le serveur de logs. Rétention, ACL, chiffrement, redaction serveur et purge ne sont
pas établis. Un produit Bob équivalent doit imposer une allowlist de métadonnées, exclure tout corps
de réponse/transcript, tester la redaction et certifier rétention/ACL/purge.

Après `stopAndUnloadAsync`, le client récupère et journalise un URI de fichier. Aucun appel
applicatif clair à une suppression de ce fichier n'a été identifié dans la branche inspectée. La
durée de rétention audio locale reste donc inconnue ; le chemin doit être testé et la suppression
après succès, échec et abandon rendue déterministe.

### 7.3 Surface de collecte

Amplitude, AppsFlyer, RevenueCat, identifiant publicitaire et services de notification augmentent
la surface de données et les obligations de transparence. Leur présence peut être légitime, mais
elle doit être inventoriée, minimisée et alignée avec la politique réellement publiée.

### 7.4 Permissions et composants Android

Le manifeste contient des permissions de stockage historiques, `SYSTEM_ALERT_WINDOW` et plusieurs
composants exportés issus de bibliothèques. Aucun de ces éléments ne constitue à lui seul une
vulnérabilité. Ils mériteraient toutefois un audit dynamique de permissions, intents et providers
avant de prendre ATTIX comme référence technique.

## 8. Matrice comparative ATTIX ↔ Bob

| Dimension | ATTIX 1.7.6 statique | Bob — état exposé / statut | Décision recommandée | Preuve / confiance |
| --- | --- | --- | --- | --- |
| Proposition | devis chantier au premier plan | Assistant classique/local exposé ; Bob Live cible plus large mais production `OFF` | créer une mission « Devis chantier » visible sans prétendre qu'elle est déjà publique | routes + captures / élevée sur l'UI, faible sur le runtime |
| Entrée vocale | gros micro dans Création | `/voix` redirige vers l'Assistant canonique | garder une autorité vocale unique avec objectif devis préchargé | code client des deux apps / élevée |
| Capture classique | options M4A + pause/reprise demandées | reconnaissance locale, tour par tour, durcie dans la PR #82 `implemented` localement | étudier une capture longue bornée pour description chantier | code client / élevée ; fichiers réels non mesurés |
| Transcript | champ modifiable prévu | texte/repli texte après erreur dans le lot local | rendre l'édition un checkpoint systématique du devis | code + captures / élevée statiquement |
| Clarification | conversation orientée devis prévue | Assistant générique exposé ; propositions M2-A sous flags/non certifiées | une question indispensable à la fois, réponses structurées | modules/états / moyenne sans serveur |
| Génération | client SSE + Zod + route JSON | M2-A implémenté sous flags `OFF`, finalisation partielle, non publique | normaliser les événements et persister chaque checkpoint | code client/specs / élevée sur câblage, faible sur convergence |
| Progression | checklist et étapes `Devis/Client/Modalités` prévues | phases vocales/assistant plus techniques | afficher des étapes métier, pas le transport IA | capture + composants / élevée statiquement |
| Reprise | chemins client de reprise/snapshots présents | checkpoints plus nombreux entre classique, Realtime et mission | une identité de mission et une révision de brouillon | code client / élevée sur présence, faible sur succès |
| Résultat | tableau éditable → PDF → envoi dans le récit UI | devis/outils Bob avec confirmations ; verticale vocale non certifiée | revue économique puis création idempotente, envoi séparé | captures/modules + code Bob / moyenne |
| Base BTP | fournitures + recettes de prestations | catalogue simple réellement exposé | enrichir le domaine sans casser le catalogue | code/modèles / élevée |
| Coût/marge | achat, perte, travail, marges | prix de vente, catégorie, unité optionnelle, TVA | ajouter coût de revient et marges explicables | formulaires/calculs / élevée statiquement |
| Import fournisseur | parcours facture → fournitures prévu | OCR/documents, pas de boucle catalogue équivalente | OCR en proposition d'import, jamais écriture silencieuse | modules/code / moyenne sans serveur |
| Navigation | Base et Création en onglets | Catalogue derrière `Compte → Facturation & modèles` | rendre la Base découvrable depuis devis/navigation métier | routes / élevée |
| Actions | feuilles spécifiques au statut | composants d'action plus transversaux | contextualiser tout en limitant les couches | modules / moyenne sans exécution |
| Accessibilité | non certifiée | annonces d'erreur, CTA et focus testés localement ; appareils dus | conserver ce garde-fou et valider physiquement | tests Bob / élevée localement ; ATTIX faible |
| Auth/session | jetons et log buffer AsyncStorage, backup à auditer | session Supabase AsyncStorage ; backup release non certifié | corriger/certifier les deux ; aucun avantage établi | code + manifeste / élevée sur config, faible sur artefact réel Bob |
| Temps réel | aucun duplex continu établi dans la branche inspectée | Bob Live cible normative, production `OFF` | certifier O3 sur la même machine métier | absence de câblage apparent + flags Bob / moyenne |

## 9. Pourquoi Bob échouait plus souvent

L'audit causal du code et des tests Bob a révélé plusieurs familles de défauts. L'artefact ATTIX
montre un chemin qui n'implique pas certaines de ces portes, sans prouver l'absence de défauts dans
son exécution réelle :

1. **Cycle de vie natif ambigu.** Les événements de reconnaissance tardifs pouvaient être attribués
   à la session suivante et un `end` ne terminalisait pas toujours la machine.
2. **Erreurs silencieuses.** Certaines erreurs natives fermaient le lease sans remonter de cause ni
   offrir de repli texte.
3. **Concurrence entrée/sortie.** Une annulation de l'écoute pouvait rendre la main avant le teardown
   natif, puis la synthèse rencontrait `audio_busy` et le guidage était perdu.
4. **Promesse locale non prouvée.** Demander la reconnaissance locale ne garantissait pas, sur tous
   les OS/appareils, l'absence de repli réseau.
5. **Négociation Realtime plus large.** Admission, entitlement, capacité Mission M2-A, readiness,
   fournisseur et récupération forment plusieurs portes en série.
6. **Erreurs bootstrap aplaties.** Des indisponibilités et délais de reprise pouvaient être
   transformés en erreur terminale de négociation, perdant notamment l'information de retry.
7. **Démarrage froid coûteux.** Le chemin audité de livraison speech peut charger plusieurs services
   alors que la réservation mobile attend moins longtemps que leur disponibilité réelle.
8. **Mission devis incomplète.** M2-A produit des slots/lignes de brouillon ; revue, création finale,
   envoi et signature ne sont pas encore une seule verticale certifiée.

Le lot `SPEC_BOB_LIVE_NATIVE_ASR_RECOVERY_P0_20260809.md` implémente localement les correctifs des
quatre premières familles sur le mode classique : machine terminale exactement une fois, barrière native,
générations/leases et dictée classique fail-closed locale ou repli texte. Le TTS n'appelle pas le
backend Bob ; Android exige une voix installée marquée hors réseau, tandis qu'iOS dépend du service
système et n'est pas certifié absolument hors ligne. Annulation attendue, erreurs visibles, focus
et annonces d'accessibilité améliorent la fiabilité, mais cela ne certifie
pas à lui seul le chemin GPT Realtime public ni le devis de bout en bout.

## 10. Ce que Bob doit reprendre — sans copier ATTIX

### 10.1 À reprendre

- une mission devis étroite avec un début et une fin évidents ;
- la transcription éditable comme checkpoint de confiance ;
- les jalons métier visibles ;
- la génération progressive typée ;
- la reprise persistée après chaque transition ;
- le découplage entre proposition IA, revue, création et envoi ;
- une base BTP qui représente le coût de revient ;
- des feuilles d'action adaptées au statut réel ;
- la boucle « correction validée → base enrichie » après information contextualisée et sur la base
  légale déterminée par finalité ; si l'opt-in est la base retenue pour le réemploi/apprentissage,
  il doit être séparé, spécifique et révocable.

### 10.2 À ne pas reprendre

- présenter du fichier uploadé comme du duplex « live » ;
- une promesse temporelle absolue non mesurée ;
- les jetons de session en AsyncStorage sauvegardable ;
- un prototype mocké laissé près du chemin de production ;
- la prolifération de modales sans contrat de focus/navigation ;
- une collecte télémétrique plus large que ce que la notice explique ;
- apprendre automatiquement des prix sans version, provenance et confirmation.

## 11. Plan vertical recommandé

### P0 — Fiabilité vocale classique

**État : `implemented` localement dans la PR #82, non `certified` et non `released`.** Conserver le
lot actuel, ses barrières natives, son repli texte et ses preuves. Avant `certified` restent dus la
CI du commit de tête, les APK/IPA exact SHA, les appareils Android/iPhone, l'absence de modèle
fr-FR, le refus de permission, l'interruption, VoiceOver et TalkBack.

### O3 — GPT Realtime sur la même machine, priorité normative

La direction normative de publication reste GPT Realtime et ne devient pas un « P3 ». Le transport
temps réel ne doit toutefois pas posséder l'état métier. Il doit publier les mêmes événements,
écrire les mêmes checkpoints et appeler les mêmes use cases que le parcours manuel/classique. En
cas d'indisponibilité, la mission reste lisible et passe explicitement au texte ou à une capture
bornée.

Les pistes P1/P2 issues de l'analyse concurrentielle ci-dessous sont un backlog produit ; elles ne
préemptent ni O3 ni les gates O7. Toute modification de cette direction, du fournisseur ou de la
matrice de flags nécessite la décision et la contre-signature prévues par l'autorité de
publication.

### P1 — Mission « Devis chantier »

Construire une verticale unique, derrière les mêmes use cases métier que l'interface :

1. entrée `Créer un devis` avec client optionnel et mission persistée ;
2. capture courte locale ou enregistrement long explicitement uploadé, après information
   contextualisée et selon la base légale déterminée pour cette finalité ; la permission OS et le
   tap micro ne valent pas à eux seuls consentement RGPD ;
3. transcription affichée, modifiable et enregistrée ;
4. extraction typée : client, lieu, prestations, quantités, unités, fournitures, modalités ;
5. questions limitées aux champs réellement bloquants ;
6. événements `extracting`, `matching_catalogue`, `pricing`, `validating`, `draft_ready` ;
7. reprise idempotente après perte de réponse ;
8. revue ligne par ligne avec coût, marge, TVA et provenance ;
9. création de brouillon après confirmation ;
10. aperçu PDF, puis action d'envoi séparée et confirmée.

Cette distinction permission/consentement suit la [recommandation CNIL sur les permissions des
applications mobiles](https://www.cnil.fr/fr/permissions-applications-mobiles-recommandations-de-la-cnil-pour-respecter-la-vie-privee) : une permission OS est un accès technique et ne remplace pas
la détermination de la base légale ni, lorsqu'il est requis, un consentement libre, spécifique,
éclairé et univoque.

Critères binaires : aucun effet final depuis une simple transcription ; chaque événement appartient
à une mission/révision ; un retry ne duplique pas le devis ; fermeture réseau laisse le brouillon
reprenable ; clavier disponible à chaque étape.

### P1 — Base BTP V2

Étendre le catalogue sans migration destructive :

- `Supply`: fournisseur, fabricant, référence, unité d'achat, unité d'usage, conditionnement,
  conversion, coût HT, perte, marge, date/source du prix ;
- `ServiceRecipe`: temps, coût horaire, fournitures et quantités, frais, marge, variante, révision ;
- calcul déterministe et testé du déboursé, prix conseillé et marge ;
- aperçu d'impact avant mise à jour en cascade ;
- import OCR en proposition révisable, jamais en écriture directe ;
- historique et provenance pour expliquer chaque prix à l'artisan.

### P2 — Expérience et observabilité

- rendre Base accessible depuis le devis et la navigation principale pertinente ;
- présenter les phases métier et leurs délais, pas les noms de fournisseurs ;
- tracer p50/p95 par étape, abandon, correction de transcription et reprise, sans audio/PII ;
- tester dynamiquement clavier, sheets, grandes polices, VoiceOver et TalkBack ;
- mesurer le temps « micro → brouillon révisable », distinct du temps « micro → PDF envoyé ».

## 12. Stratégie concurrentielle proposée

| Action | Décision Bob |
| --- | --- |
| Éliminer | erreurs silencieuses, ambiguïté « live », moteurs audio concurrents, changement implicite de fournisseur, catalogue caché |
| Réduire | surface de l'assistant pendant un devis, jargon technique, nombre de couches modales, promesses magiques |
| Renforcer | reprise, transparence des étapes, édition, preuves économiques, accessibilité, idempotence et observabilité |
| Créer | base BTP à coût de revient, mission devis transport-agnostique, apprentissage validé, import fournisseur contrôlé |

Le positionnement défendable n'est pas « nous générons aussi un devis en 60 secondes ». Il est :

> Bob transforme la réalité du chantier en devis vérifiable, explique chaque prix, reprend là où
> l'artisan s'est arrêté et n'agit jamais sans confirmation.

## 13. Verdict

ATTIX est une référence statique utile de focalisation produit, de progression visible et de modèle
BTP. L'orchestration observée est compatible avec une perception fluide, mais aucune causalité ni
performance réelle n'est démontrée sans exécution authentifiée.

Bob possède une ambition plus large et des garde-fous métier documentés — données tenant réelles,
confirmations et idempotence — mais cette ambition a longtemps exposé l'utilisateur à la complexité
interne. La priorité est de rendre le devis aussi déterministe et révisable que le parcours prévu
par ATTIX, tout en certifiant accessibilité, stockage de session, backup et vérité réglementaire.

La PR #82 et ses preuves logicielles portent le repli classique au statut local `implemented`. Il
n'est ni `certified`, ni `released`, et ne possède aucun SHA de release. Les pages publiques, la
suppression réelle de compte, les décisions juridiques/DPA, les anciens binaires vocaux,
l'attestation exacte de release et les essais appareils restent des gates de publication séparés.

## 14. Index des preuves statiques principales

Les numéros ci-dessous correspondent au bundle décompilé de hash indiqué en §2 :

- options M4A/AAC mono 16 kHz/64 kb/s : `decompiled.js:805329-805344` ;
- pause d'enregistrement : `decompiled.js:805760-805764` ;
- transcription : `decompiled.js:806492-806494` ;
- réponse de transcription placée dans les métadonnées de log :
  `decompiled.js:806517-806566`, `806679-806690` ;
- buffer de logs AsyncStorage et envoi : `decompiled.js:465711-465745`,
  `465934-465975`, `466122-466188` ;
- URI audio rendu après arrêt : `decompiled.js:806021-806054` ;
- génération SSE : `decompiled.js:670895-670944`, `671419-671423` ;
- génération JSON de repli : `decompiled.js:671658-671663`, `671884-671888` ;
- store anti-concurrence : `decompiled.js:670872-670880` ;
- clés de session ATTIX : `decompiled.js:450885-450892` ;
- formulaire fourniture : `decompiled.js:745402-745476`, `748441-748447` ;
- manifeste backup : `AndroidManifest.xml:104` ;
- routes, écrans et composants : `module-paths.txt` ;
- captures marketing : `store/01-large.png` à `store/12-large.png`.

Ces références rendent l'audit techniquement reproductible à partir des artefacts fournis sans
utiliser un compte, une clé, une route privée ou un contournement de protection. Toute reproduction
ou circulation reste cependant soumise au gate juridique interne du §2.3.
