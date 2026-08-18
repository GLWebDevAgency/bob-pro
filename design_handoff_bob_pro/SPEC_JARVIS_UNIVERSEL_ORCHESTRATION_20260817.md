# SPEC — Jarvis universel et orchestration métier durable

Date de l'instruction fondatrice : 2026-08-17, conversation directe avec Codex.

Statut : **NORMATIVE — intégrée dans l'autorité O4 le 2026-08-18** sous bâton fondateur explicite
du 18/08 (Claude conduit le développement ; GPT reprend sur décision fondateur). Rédigée par GPT
(candidat du 17/08), **amendée par Claude le 18/08** pour fermer les trois P0 de la
contre-expertise (canal msg 531) : table normative classe→mode (§7.0), articulation V1 (§2.1),
continuité de surface et plancher de version client au cutover (§17.1) — et pour consigner les dix
décisions fondatrices du §20, tranchées par délégation explicite :
[DECISION_JARVIS_UNIVERSEL_20260817.md](DECISION_JARVIS_UNIVERSEL_20260817.md). La contre-lecture
de GPT sur ces amendements est attendue à son retour, non bloquante par décision fondateur.

Note de séquence : l'intégration O4 précède la fusion du lot RNW A1 (implémentation gelée en vol
chez GPT sous la spec c46b7802) par décision fondateur du 18/08. A1 reste une fondation de
transport séparée ; son gel et son GO pré-code (msg 527) ne sont pas affectés.

## 1. Directive fondatrice et résultat produit

Directive fondatrice du 17 août 2026 : le mode vocal Jarvis de Bob Pro ne se limite pas au devis
ni à une chaîne `client -> chantier -> devis`. Il doit orchestrer durablement l'ensemble des
capacités métier visibles dans l'application : création et modification des clients et contacts,
communications, chantiers, interventions, équipements, contrats, devis, envoi, signature,
factures, paiements, impayés, relances, dépenses, documents, trésorerie, gestion et
pré-comptabilité.

Le résultat attendu est le suivant : depuis Bob Live, l'utilisateur formule un objectif simple ou
composé ; Jarvis relit les données réelles du tenant, résout les entités, demande uniquement les
faits manquants, construit un plan typé, prépare les diffs et artefacts, recueille les confirmations
requises, appelle les mêmes use cases que l'interface manuelle, attend les événements externes,
reprend après fermeture ou crash, et annonce uniquement des résultats relus depuis leurs autorités.

Une phrase initiale peut demander toute la chaîne, mais elle n'autorise jamais implicitement les
engagements futurs. Le processus s'arrête à chaque frontière de confirmation, de tiers ou d'effet
externe et reprend avec le même contexte durable.

Cette directive corrige explicitement toute interprétation antérieure qui réduisait Jarvis au seul
parcours devis. Le lot RNW A1 reste une fondation de transport audio séparée ; il ne prouve aucune
capacité métier universelle.

## 2. Portée universelle et définition de la parité

La portée contient toutes les actions et lectures publiques proposées au propriétaire ou à un
collaborateur autorisé dans l'application Bob Pro. Elle comprend au minimum :

- navigation, recherche, lecture de contexte, notifications et tableaux de bord ;
- clients, contacts, coordonnées, conditions de paiement et canaux de facturation ;
- prise de contact, rédaction et envoi d'e-mails ou messages, préparation d'appel ;
- chantiers, notes, photos, interventions, équipements et contrats de maintenance ;
- catalogue, devis, lignes, clauses, bon de commande, envoi, refus et signature ;
- factures brouillon, acompte, situation, solde, émission, envoi, transmission et avoir ;
- paiements, échéances, impayés, relances unitaires ou politiques de relance ;
- dépenses, justificatifs, documents, classement et rattachements ;
- trésorerie, TVA, balance âgée, pilotage, clôture, FEC et pré-comptabilité ;
- profil société, réglages métier et autres actions publiques de l'application.

Les opérations d'administration de plateforme, de support interne, de migration, de callback
provider ou de développement ne sont pas des actions utilisateur et restent hors catalogue. Les
actions de sécurité extrême — achat d'abonnement, changement d'identité, suppression de compte,
clôture ou écriture irréversible — restent orchestrables par Jarvis mais leur validation finale peut
être imposée à l'écran avec authentification renforcée.

La parité ne signifie pas que la voix contourne un garde. Elle signifie que toute action manuelle
publique possède un chemin Jarvis qui :

1. rejoint le même use case ou coordinateur applicatif ;
2. applique les mêmes rôles, RLS, invariants, transactions et règles de confirmation ;
3. produit la même intention canonique et le même postimage métier ;
4. utilise une interface vocale, tactile ou une validation renforcée selon le risque ;
5. possède la même capacité de reprise et un reçu normalisé.

Le catalogue porte pour chaque action un mode vocal fermé : `read`, `prepare`, `confirmable`,
`screen_commit`, `third_party_wait` ou `closed`. Les cinq premiers sont des formes prises en charge
de l'orchestration. `closed` est un écart produit temporaire : tant qu'une action publique en porte
un, Bob Pro ne peut pas revendiquer « toute l'application avec Jarvis ».

### 2.1 Articulation avec la publication V1 (FD-2026-0817-11)

La parité universelle (`closed=0`) est **l'objectif produit** ; **la publication V1 n'attend pas le
train U0–U7**. La V1 publie avec le programme de publication existant, complété du critère
inter-domaines consigné le 16/08 (mission client → chantier → devis → facture → préparation
pré-comptable) — soit le socle U0/U1 et la chaîne U3/U4 sur les parcours du programme. U5–U7 se
livrent et s'annoncent action par action après publication. Aucun lot U* ne rejoint le chemin
critique de publication sans décision fondateur tracée dans
[PROGRAMME_V1_PUBLICATION.md](PROGRAMME_V1_PUBLICATION.md), qui porte le bloc normatif miroir du
17/08. Le claim public totalisant reste régi par FD-2026-0817-10 et le gate §21.4.

## 3. État actuel prouvé et dette de migration

Deux chemins d'exécution distincts existent actuellement — et le premier n'est pas seulement
vocal :

1. Le chemin historique `/ai/ask -> proposition -> /ai/confirm` exécute des outils du registre
   `@bob/ai` via `BackendService.buildBobActions()`. **C'est le moteur d'exécution de DEUX surfaces
   de production : l'onglet assistant texte publié (`AiController`, consommé par
   `apps/mobile/app/(tabs)/assistant.tsx`) et les tours du chemin realtime (`askBobWithPlan`)** —
   soit l'intégralité des outils du registre. Sa surface est large, mais son journal écrit
   `planned`, appelle l'effet puis écrit `executed`. Un crash entre l'effet et le journal laisse un
   résultat ambigu ; un batch ne rollbacke pas les effets déjà committés. Ce chemin n'est donc pas
   un orchestrateur métier durable. Tout plan de cutover qui le supprime doit traiter la continuité
   des deux surfaces qu'il sert (§17.1).
2. `AgentMission` possède des fences, révisions, événements et reprises plus fortes, mais le domaine
   courant est littéralement `quote_creation`, protocoles 1 et 2, avec des phases client/lignes et
   un binding `/devis/new`. Il ne publie pas encore le vrai devis et ne couvre aucun autre domaine.

Ces deux chemins décrivent une dette actuelle, pas deux moteurs à conserver. La cible en absorbe les
invariants utiles dans une seule orchestration puis supprime les reducers, journaux, workers et
routes d'exécution redondants. Aucun domaine ne reçoit une seconde implémentation métier « Jarvis ».

La surface manuelle et les use cases réutilisables sont déjà beaucoup plus vastes : clients et
contacts, chantiers, parc, interventions, contrats, devis, factures, paiements, relances, dépenses,
documents, trésorerie et états comptables. Plusieurs outils historiques appellent déjà ces
autorités, mais leur présence ne constitue pas une preuve de parité ou de durabilité.

Écarts déjà prouvés :

- la création de devis est annoncée comme action optionnelle mais n'est pas fournie par le
  `buildBobActions()` serveur de production ;
- le wizard manuel n'envoie pas non plus de clé stable au coordinateur de création de devis ; une
  perte de réponse peut donc produire un second brouillon ;
- aucune voix durable ne modifie un client ou ses contacts ;
- aucun CRUD chantier complet n'est missionnel ;
- les lignes, clauses, refus et signature du devis ne sont pas couverts de bout en bout ;
- seuls `envoyer_devis`, `envoyer_facture` et `envoyer_relance` sont réellement allowlistés comme
  envois vocaux ; il n'existe pas de messagerie générique ;
- `sendQuote` et `sendInvoice` peuvent recréer token et job après perte de réponse : l'idempotence
  provider actuelle n'est pas encore une idempotence de commande ;
- la clé vocale de paiement est dérivée de facture+montant+méthode et peut confondre deux virements
  légitimes identiques ;
- la création de client et de chantier n'est pas idempotente aujourd'hui : un retry peut générer
  un nouvel identifiant ;
- résultat, bilan, revue de clôture et FEC ne sont pas câblés dans l'hôte vocal serveur, même si des
  stubs locaux existent ; le FEC serveur a en outre des gaps de snapshot, auxiliaires et charset ;
- le journal legacy, l'UI et `AgentMission` peuvent encore se partager une même intention sans
  autorité unique.

La dette ne sera pas fermée par l'ajout de noms d'outils. Une action ne devient Jarvis-native
qu'après câblage réel, idempotence, confirmation, reprise, preuve PostgreSQL et E2E voix/toucher.

## 4. Décision d'architecture

### 4.1 Un seul moteur, deux durées de données

`JarvisRun` est l'unique machine d'état d'orchestration et l'unique propriétaire durable des
commandes, propositions, confirmations, checkpoints, effets et reçus. Il n'a ni parent ni enfant
d'orchestration. Les capacités utiles de l'actuel `AgentMission` sont absorbées dans ce modèle ;
`AgentMission` n'est pas conservé comme second agrégat ou sous-moteur cible.

Une connexion Realtime n'expose qu'une vue/DTO `JarvisInteractionBinding` étroite sur la
`RealtimeSessionLease` existante : session, principal, lease de premier plan, contexte écran,
challenge, tour courant et `runId`. Ce n'est ni un agrégat, ni une table, ni un store nouveau. Une
interaction tactile/HTTP fournit une enveloppe éphémère authentifiée et, si nécessaire, un
challenge de présentation ; elle ne crée ni n'exige une lease Realtime durable. Ni la vue Realtime
ni l'enveloppe tactile ne portent phase métier, reducer, journal de commande, retry ou work item ;
leur disparition ne perd jamais le run.

Tout type historique nommé `Mission` mais limité au wire ou à la conversation — notamment
`RealtimeMistralConversationMission` — est renommé `Session`, `Binding` ou `ConversationState`
selon sa responsabilité. Il peut garder la machine protocolaire, le curseur de séquence, la
déduplication, les ACK et la file de retransmission strictement nécessaires au transport. Ces
éléments ne portent jamais `actionId`, phase métier, use case, proposition, confirmation ou work
item et ne mutent aucun `JarvisRun`. Le mot `Mission` ne masque donc pas un second orchestrateur
métier.

Cette distinction de durée ne crée donc pas deux moteurs : une signature, un paiement ou une
relance peut attendre plusieurs semaines dans `JarvisRun`, tandis que le binding de transport vit
quelques minutes. Voix et toucher qui poursuivent un run, ainsi que les signaux système/provider,
entrent par le même `JarvisCommandGateway`; seuls leurs acteurs et preuves d'entrée diffèrent. Une
action manuelle one-shot hors run peut appeler directement le même use case et la même policy : la
parité n'impose pas de créer artificiellement un run ou un controller intermédiaire.

### 4.2 Quatre couches et une seule autorité par responsabilité

1. **Transport et interaction** : GPT Realtime, audio, VAD, contexte écran et rendu. Cette couche ne
   contient aucune règle métier et ne commite aucun effet.
2. **Compréhension et compilation** : le modèle propose des intentions structurées. Un compilateur
   serveur les traduit en actions du catalogue et en un processus autorisé ; il refuse toute action,
   liaison ou combinaison inconnue.
3. **Orchestration durable** : `JarvisRun` réduit des commandes et événements fermés, produit des
   propositions ou work items et attend leurs reçus. Le reducer est pur et versionné.
4. **Autorités métier** : use cases, agrégats, coordinateurs, repositories, outboxes et providers
   existants. Eux seuls décident validité, montants, numéros, statuts et résultats.

Le runner n'accède jamais directement à Prisma, un mailer, Stripe, une plateforme agréée ou une API
de signature. Pour chaque action, il appelle l'unique `commandAuthority` cataloguée, déjà utilisée
par les autres surfaces. Si cette interface canonique n'existe pas, elle est extraite une seule fois
et tous les callers concernés migrent dans le même changement. Aucun adapter Jarvis-specific,
façade pass-through ou chaîne adapter-vers-ancien-service n'est admis.

### 4.3 Processus bornés, jamais un exécuteur universel

Il n'existe ni BPMN utilisateur, ni DAG JSON libre, ni `execute_anything`, ni code généré par le
LLM. Un unique `JarvisReducer` possède l'entrée de réduction ; son switch exhaustif appelle des
transitions pures TypeScript versionnées par définition. Ces modules ne possèdent ni runner,
journal, worker, retry, gateway ou accès métier : ce sont des branches du même reducer, pas des
moteurs. Les premières familles cibles sont :

- `single_business_action_v1` pour une action cataloguée isolée ;
- `customer_contact_v1` pour fiche, contacts et communication ;
- `customer_job_to_cash_v1` pour client, chantier, devis, envoi, signature, facture et paiement ;
- `receivables_followup_v1` pour impayés et relances ;
- `field_service_v1` pour chantier, équipement, intervention et rapport ;
- `expense_to_accounting_v1` pour dépense, preuve, règlement et pré-comptabilité ;
- `business_management_review_v1` pour les lectures et préparations de gestion.

Une demande composée utilise une définition connue ou une séquence explicitement autorisée entre
capacités compatibles. Les liaisons de sortie vers entrée sont typées et revalidées côté serveur.
Il n'existe pas de boucle, branche ou compensation inventée par le modèle.

`single_business_action_v1` exécute exactement une action cataloguée, avec un nombre fini de phases
et au plus un effet mutant. Chaque définition fixe `maxSteps`, `maxOpenWorkItems`, taille maximale
du state, durée/TTL, nombre de réveils et transitions possibles. Fan-out/join dynamique,
sous-workflows runtime, boucles ou replay historique de code imposeraient un nouvel ADR build-vs-buy
avant toute extension : ils ne sont pas autorisés par cette spec.

Une lecture `L0` ou préparation `P1` pure demandée via l'assistant, synchrone, sans artefact durable,
confirmation ni reprise passe elle aussi par `JarvisCommandGateway`, qui choisit son mode stateless
et appelle le même catalogue/port. Elle retourne une réponse sourcée sans reçu durable ni write
métier et ne crée pas artificiellement un run. Il n'existe aucune route Jarvis « directe »
parallèle. Toute mutation, attente ou opération réessayable de l'assistant utilise un `JarvisRun`.

### 4.4 Unicité du code et hygiène du dépôt

Le catalogue est la source unique qui génère ou alimente les schémas d'outils, codecs API, modes
voix/toucher, policies et inventaires de preuve ; ces listes ne sont pas recopiées dans plusieurs
packages. Les adapters d'une interaction orchestrée ne font que décoder, authentifier et mapper
vers une commande canonique. Toute condition métier dans un adapter est un défaut d'architecture.

Une action référence le use case existant ou provoque son extraction propre ; elle ne crée jamais un
service `ForVoice`, `ForJarvis` ou `ForManual` équivalent. Les règles d'import du monorepo rendent le
graphe acyclique et interdisent au core les frameworks ainsi qu'à l'AI les repositories/providers.
Les tests de structure échouent sur double actionId, second reducer racine, double gateway, export
mort, table/trigger orphelin, ancienne route exécutante ou catalogue divergent.

Tout code de migration porte une date de suppression, un owner et un gate de suppression dans le
même train. Une abstraction sans deux consommateurs réels ou sans invariant propre n'est pas
introduite. Le résultat final ne contient ni couche « au cas où », ni wrapper pass-through, ni
compatibilité historique silencieuse.

## 5. Modèle durable : run, événements, work items et reçus

Le noyau initial reste volontairement petit. Il contient trois primitives et aucune table générique
de nœuds ou d'arêtes :

### 5.1 `JarvisRun`

Snapshot CAS tenanté avec au minimum : `id`, `companyId`, `createdBy`, `kind`,
`definitionVersion`, `status`, `revision`, `stateVersion`, `state`, `nextWakeAt`, `createdAt`,
`updatedAt` et `terminalAt`. `state` est une union fermée propre à la définition ; elle contient les
références d'entités, checkpoints, confirmations et reçus nécessaires, jamais un transcript ou un
prompt.

Le schéma SQL ferme les couples `kind/definitionVersion/stateVersion`, les clés possibles et la
taille du state. Chaque run pince exactement la définition et les versions d'actions avec lesquelles
il a démarré ; un déploiement ne les remplace jamais silencieusement.

Statuts de run fermés : `active`, `waiting_user`, `waiting_screen`, `waiting_external`,
`retry_due`, `parked`, `cancelling`, `completed`, `cancelled`, `failed_terminal` et `quarantined`.
Un run en attente externe, cancelling ou parké libère toute lease de premier plan.

`nextWakeAt` est uniquement un index. Tout délai porte dans le state un `wakeId` stable et un type de
réveil. Le scanner fondé sur l'heure PostgreSQL ne modifie aucun run : il soumet une commande de wake
idempotente à `JarvisCommandGateway`. Aucun timer mémoire n'est autoritaire.

### 5.2 `JarvisRunEvent`

Journal append-only et reçu idempotent : tenant, run, séquence, acteur, `commandId`, action et
version, fingerprint HMAC de l'intention, révisions avant/après, type/version de l'événement,
données en union fermée et horodatage base. Unicité au minimum sur le scope appelant et
`commandId`, ainsi que sur `(runId, sequence)`.

L'enveloppe commune voix/toucher contient `actionId@version`, `canonicalInputDigest` et un scope
fermé : `run(runId, commandId, expectedRevision)` ou `stateless(requestId)` pour une lecture/préparation
pure sans persistance. Le scope run ajoute, lorsque requis, `confirmationId`, `proposalHash` et les
fences d'écran. Le canal change l'acteur, pas la sémantique de la commande. Le scope stateless ne
peut créer ni event, proposition persistée, confirmation, work item ou mutation ; dès qu'un de ces
besoins apparaît, le gateway crée/utilise un run.

Pour un scope `run`, l'admission est une transaction PostgreSQL unique :
authentification/autorisation, lecture du catalogue, recherche du reçu, validation de la révision et
de la confirmation, réduction pure, insertion du reçu unique `(companyId, runId, commandId)`,
append de l'événement, CAS du snapshot et création des work items uniques
`(companyId, effectId)`. Aucun sous-ensemble de ce postimage ne devient visible ; toute erreur
rollbacke l'ensemble.

Pour un scope `stateless`, le gateway exécute uniquement authentification, autorisation, lookup du
catalogue et requête `L0/P1` pure, puis rend une réponse non persistée. Cette branche ne prend aucun
verrou de run et n'écrit ni DB métier, event, reçu, proposition, confirmation ou work item. Si une
capacité exige persistance, mutation, reprise ou retry, elle n'est pas stateless et doit utiliser un
run.

### 5.3 `JarvisWorkItem`

Outbox durable pour une opération applicative ou une observation à effectuer. Elle porte au minimum
`companyId`, `runId`, `effectId` stable, `actionId@version`, `actingPrincipalId` ou
`authorizationGrantRef`, et une source fermée
`authorizationSource = confirmation(receiptId) | mandateGrant(grantId, revision, digest, expiresAt)
| certifiedSystemRule(ruleId@version, observationScope)`, révisions/digests cibles, payload chiffré
ou référence purpose-specific, `executeBy`, statut, essais, `nextAttemptAt`, `leaseOwner`,
`leaseToken`, `leaseExpiresAt`, `authorizedAt`, `resultDigest`, `signalAppliedAt` et timestamps. Les
FK sont tenantées. Kind, version et adapter viennent d'un registre statique ; aucun payload ne choisit
une URL, destination ou classe d'exécution.

Statuts minimaux : `prepared`, `leased`, `authorized`, `retry_due`, `succeeded`,
`failed_terminal`, `outcome_unknown`, `cancelling` et `cancelled`. Le worker :

1. claim le work item dans une transaction courte et incrémente son fence de lease ;
2. dans une seconde transaction courte conditionnée par le `leaseToken` courant, revalide tenant
   ouvert, rôle/entitlement et la variante exacte d'`authorizationSource` encore valide/non révoquée,
   présence de l'action dans le
   release manifest exact de l'environnement/cohort, admission/dispatch kill switches, step-up,
   `databaseNow <= executeBy` et, lorsque la source expire, `executeBy <= authorization.expiresAt`, ainsi
   que révisions/digests cibles, puis persiste atomiquement
   `leased -> authorized`, `authorizedAt` et le digest d'autorisation ; en production l'action doit
   être `released`, ou `certified` sous un permis `production_canary` exact et encore valide, tandis
   qu'un tenant de certification staging peut exécuter une action `implemented` explicitement
   autorisée par son manifeste de preuve ;
3. appelle le port métier hors verrou du run avec `effectId` comme clé d'idempotence ;
4. persiste le résultat immuable ;
5. soumet le signal signé à `JarvisCommandGateway`, dont l'unique transaction applique l'événement,
   le CAS du run et `signalAppliedAt`.

Seul le détenteur du `leaseToken` courant peut autoriser ou écrire le résultat ; un worker stale
réconcilie par `effectId` sans committer. Un résultat avec `signalAppliedAt IS NULL` est redélivré de
façon level-triggered. Un signal devenu stale est acquitté comme no-op explicite et audité, jamais
perdu.

La staleness se décide par `effectId` et checkpoint attendu, pas par la seule révision globale du
run. Un résultat métier réussi est fusionné idempotemment dans son checkpoint même si une commande
sans rapport a avancé le run. Un no-op n'est permis que si le même résultat est déjà appliqué, ou si
un état terminal/cancel explicitement compatible conserve néanmoins le reçu et interdit tout effet
aval ; il ne peut jamais masquer un succès externe.

`authorized` est le point de non-retour : annulation et autorisation concourent sur la même ligne et
le même fence ; une seule transition conditionnelle gagne. Une annulation gagnante avant lui
supprime les effets préparés. Après lui, le run passe par `cancelling` et continue d'observer
l'effet ; il ne prétend jamais qu'un appel possiblement parti est annulé. Un kill switch d'admission
bloque les nouvelles commandes, celui de dispatch bloque les work items non autorisés ; aucun kill
switch ne coupe l'observation/réconciliation d'un effet déjà autorisé.

Un crash après l'effet mais avant l'ACK rejoue le même `effectId` et doit recevoir le même reçu. Une
capacité non idempotente ou non réconciliable reste `closed` jusqu'à l'ajout d'un coordinateur ou
registre purpose-specific. Il n'existe aucune compensation universelle : un avoir, une annulation,
une contre-écriture ou une correction sont des actions métier explicites.

Une lease expirée sur un work item `authorized` ne le remet jamais en `prepared` et n'autorise pas
un nouvel `effectId`. Un autre worker peut le reprendre uniquement par CAS du fence de lease. Il
réconcilie d'abord l'autorité métier/provider avec le même `effectId` : reçu trouvé => persistance et
observation du résultat ; absence d'effet prouvée par l'autorité et action cataloguée safe-to-retry
=> nouvel appel avec le même `effectId` ; résultat indécidable => `outcome_unknown`, sans retry
aveugle. Ce protocole vaut aussi après kill entre `authorizedAt`, appel externe et ACK local.

`JarvisWorkItem` ne duplique jamais une outbox ou un job métier existant. Lorsqu'une autorité possède
déjà son outbox, le work item soumet une seule fois la commande idempotente, conserve l'ID du reçu/job
retourné puis l'observe ; retry provider, livraison et vérité externe restent exclusivement dans
cette outbox canonique utilisée par toutes les surfaces. Si cette autorité manque, elle est créée
dans le domaine et remplace les anciens callers ; aucune outbox `ForJarvis` n'est ajoutée.

Les contenus sensibles — corps d'e-mail, pièces, données client, artefact signé — vivent dans leur
staging ou outbox métier, avec chiffrement et rétention propres. Le run ne conserve que leurs IDs,
versions et digests.

Les callbacks externes accélèrent la reprise mais ne sont jamais l'unique autorité. Un reconciler
level-triggered relit périodiquement signature, facture, paiement ou job de notification via une
clé d'observation déterministe, puis soumet son observation à `JarvisCommandGateway`. Callback et
reconciler ne mutent jamais le run directement. La perte ou duplication d'un webhook ne bloque donc
pas le run.

### 5.4 Identifiants, fingerprint et canonicalisation

- un geste utilisateur/tap génère un UUID cryptographique une fois, avant le premier essai, et le
  conserve jusqu'au reçu ;
- une commande système/reconciler utilise un UUID déterministe versionné issu de run, effect et
  observation ;
- `effectId` est généré par le serveur dans la transaction d'admission, stocké et jamais accepté du
  client ;
- la canonicalisation JSON, le HMAC et son `keyId` sont versionnés ; les clés brutes et contenus
  sensibles ne sont pas persistés dans les events ;
- même `(companyId, runId, commandId)` et même fingerprint rejoue ; autre fingerprint est un
  conflit, et le commandId n'est jamais réutilisé pour une autre action.

Le reçu de commande reste immuable et référence l'`effectId`. L'évolution `pending -> delivered` ne
réécrit pas ce reçu : elle ajoute des observations append-only et change la projection courante.

### 5.5 Compatibilité des versions et rétention

Définition, action, payload, canonicalisation et reçus publiés sont immuables. Tout déploiement
embarque toutes les versions encore référencées par un run ou work item non terminal, pas seulement
N-1. Une version ne peut être retirée qu'après preuve de zéro référence vivante ou migration
purpose-specific CAS, auditée, réversible côté application et testée. Une version introuvable met le
run en quarantaine sans effet.

Le snapshot est l'autorité opérationnelle ; le journal n'est pas rejoué pour reconstruire du code
historique. Les tests commencent sous N, déploient N+1, livrent timer/callback/résultat N, terminent
le run puis vérifient aussi le rollback applicatif compatible.

Chaque action fixe rétention du run, des reçus et de ses artefacts. Un référentiel nécessaire à un
run vivant ou à une réconciliation ne peut être purgé. Après terminal, le run est minimisé ou
pseudonymisé ; les pièces à rétention légale restent dans l'autorité métier, pas dans Jarvis.
Logout détache seulement la session. Rôle retiré ou principal supprimé interdit toute nouvelle
avance ; un collaborateur ne reprend que si la policy courante l'autorise et obtient une nouvelle
proposition. Fermeture de société annule les effets non autorisés et continue la réconciliation des
effets partis.

### 5.6 Ingresses provider

Chaque adapter vérifie signature sur les bytes bruts, endpoint/audience, compte provider, fraîcheur
quand disponible et anti-replay. Avant de répondre au provider, il persiste un événement unique
`(provider, providerAccountId, providerEventId)` dans son inbox purpose-specific.

Après cette persistance, l'ingress soumet une commande normalisée à `JarvisCommandGateway`. Il
n'appelle jamais directement le reducer et ne modifie jamais le run.

Une commande d'observation système ne réutilise pas l'autorisation d'un nouvel effet. Elle
s'authentifie par l'adapter/provider et le mapping serveur, ne peut créer aucun work item sortant,
et reste admissible après retrait de rôle, fermeture du tenant ou kill switch de dispatch afin de
consigner/réconcilier un effet déjà parti. Elle ne rouvre jamais le droit d'avancer le processus.

`companyId`, `runId`, `effectId`, ressource et artefact sont dérivés exclusivement du mapping serveur
créé lors de l'effet sortant, jamais du callback. Le reducer reçoit un reçu normalisé référencé et
digesté. Chaque action déclare sa machine d'outcomes provider-specific et ses transitions monotones ;
un événement tardif, réordonné ou contradictoire ne régresse pas l'état et part en quarantaine si
nécessaire. Une reconnaissance humaine du risque de doublon n'invente jamais `delivered` : elle peut
seulement autoriser une nouvelle action avec un nouvel `effectId`.

## 6. Catalogue versionné des capacités métier

`ProductActionCatalog` est l'autorité de couverture et la source unique de ses projections
exécutables. Le collecteur confronte ses entrées aux routes/gestes publics de l'UI, endpoints et use
cases ; `BobActions` n'est inspecté que comme dette de migration et n'alimente jamais le catalogue
cible. Chaque entrée contient :

- `actionId@version`, libellé, domaine et statut de publication ;
- surfaces manuelles exactes et mode vocal ;
- use case ou coordinateur autoritaire et port d'adaptation ;
- schémas canoniques d'entrée, de proposition et de reçu ;
- résolveurs d'entités et révisions requises ;
- classe de risque, flags additionnels, rôle et éventuel step-up ;
- mode de confirmation, TTL et politique d'invalidation ;
- scope transactionnel, namespace d'idempotence et stratégie de réconciliation ;
- modèle de résultat externe, route/écran d'ACK et preuves exigées ;
- flag d'action, kill switch et état `specified|implemented|certified|released` du lot qui la porte.

Le LLM ne choisit jamais la classe de risque, le mode de confirmation, le rôle ou la stratégie de
retry. Ces propriétés viennent exclusivement du catalogue serveur, dans les limites de la table
normative §7.0 dont aucune entrée ne peut déroger vers le bas.

### 6.1 Familles obligatoires

La liste ci-dessous fixe les familles minimales ; l'inventaire mécanique peut ajouter des actions
mais ne peut en retirer silencieusement.

| Domaine | Capacités obligatoires |
| --- | --- |
| Contexte | rechercher, naviguer, relire l'entité écran, notifications, actions du jour |
| Client | lister, rechercher, créer, modifier, compléter, conditions de paiement, canal de facturation |
| Contact | lister, créer, modifier, supprimer, choisir comme destinataire, historique de contact |
| Communication | préparer/envoyer e-mail, préparer/envoyer message si connector, appel/composer handoff, pièces jointes |
| Chantier | lister, rechercher, créer, modifier, fermer, rouvrir, notes, photos et rattachements |
| Parc/intervention | équipement créer/modifier/retirer/réactiver, intervention créer/démarrer/compléter/signaler, rapport |
| Contrat | rechercher, créer, modifier, activer, résilier, renouveler, préparer facture annuelle |
| Catalogue | rechercher, créer, modifier et utiliser une prestation réelle |
| Devis | créer, modifier lignes/clauses, dupliquer, bon de commande, prévisualiser, envoyer, refuser, attendre signature |
| Facture | créer directe ou depuis devis, acompte/situation/solde, modifier brouillon, émettre, envoyer, transmettre, avoir |
| Encaissement | créer lien, enregistrer paiement, programmer l'encaissement légal, relire solde et historique |
| Impayé | balance âgée, échéances, litiges/avoirs/paiements partiels, brouillon de relance, envoi, cadence |
| Dépense | saisir/scanner, classer, rattacher chantier, enregistrer règlement et justificatif |
| Document | rechercher, charger, classer, renommer, valider, rattacher, télécharger et exporter |
| Gestion | trésorerie, versement, TVA, résultat, bilan, DSO, revue d'activité, revue de clôture |
| Pré-compta | aperçu écritures, contrôles, export FEC, dossier comptable et actions de correction existantes |
| Société/réglages | profil, facturation, légal, notifications, relances, intervention, abonnement et compte selon policy |

Une capacité absente du code actuel reste dans le catalogue avec mode `closed` et un gap explicite.
Elle n'est ni simulée par le modèle, ni remplacée par une mutation directe de l'UI.

### 6.2 `PublicActionSurfaceManifest`

« Toute l'app » est calculé sur l'arbre Git exact, jamais sur un périmètre déclaré à la main. Un
collecteur versionné inventorie iOS/Android/web, routes et composants conditionnels, méthodes du
client HTTP, endpoints publics, use cases et outils. Chaque surface porte plateforme, route,
source, rôles, entitlements, flags/connecteurs et `actionId@version`.

Plusieurs boutons peuvent mapper explicitement vers la même action sémantique ; toute surface mappe
exactement une fois ou est justifiée `non_business`. Toute entrée catalogue possède une surface
manuelle réelle — une capacité Jarvis nouvelle exige aussi son contrôle manuel — et toutes les
configurations publiques conditionnelles sont incluses. Le manifeste contient commit, hash du
collecteur, hash de la liste, aliases/exclusions et contre-signature.

La DoD universelle utilise toujours `scope=all_public_user_actions@<commit>` : aucune formule « pour
le périmètre revendiqué » ne peut réduire la liste. Une dépendance/connector absent peut convertir
l'action en handoff uniquement si la surface manuelle a exactement la même limite ; sinon c'est un
gap `closed`.

### 6.3 Autorités et disponibilité par action

Chaque entrée nomme séparément : `commandAuthority`, `postimageAuthority`, `artifactAuthority`,
`externalOutcomeAuthority`, `finalityAuthority` et `reconciliationAuthority`. Elle décrit la règle
de préséance lorsque DB, outbox, provider et projection divergent. Le work item, le tool call, le
texte UI et la parole ne peuvent être aucune de ces autorités.

État et disponibilité sont distincts : le statut canonique reste
`specified|implemented|certified|released`; un release manifest exact décide si l'action est enabled
pour environnement, cohort et tenant. Le manifeste modèle ne contient que les actions autorisées,
activées, dont les dépendances sont saines. En staging de certification, une action `implemented`
peut être activée pour le tenant de preuve. En production, une action est normalement `released`.
L'unique exception est un permis éphémère `production_canary` pour une action déjà `certified` : il
lie commit et artifact exacts, `actionId@version`, tenants/cohort bornés, principal approbateur,
fenêtre/TTL, connecteurs et kill switches. Le modèle, l'admission et le dispatch ne voient cette
action que pour cette cohorte. Ce permis n'est ni un cinquième statut ni une activation générale ;
son expiration/révocation ferme l'action. Canary et smoke réussis permettent ensuite une promotion
explicite à `released` et un nouveau release manifest signé.

## 7. Politique de risque et confirmations humaines

La politique combine une classe de base et des flags orthogonaux.

| Classe | Définition | Politique par défaut |
| --- | --- | --- |
| `L0` | lecture ou navigation | exécution automatique, zéro write/outbox |
| `P1` | calcul, simulation ou préparation pure | demande initiale suffisante ; annoncer « préparé, rien envoyé/émis » |
| `M2` | mutation interne corrigeable | proposition serveur, diff avant/après et confirmation fraîche |
| `E3` | engagement financier, juridique ou irréversible | confirmation renforcée, rôle, snapshot immuable et éventuel step-up |

Flags fermés : `external`, `financial`, `legal`, `privacy_sensitive`, `recipient_authority`,
`destructive`, `irreversible`, `third_party_act`, `mass_action` et `security_sensitive`.

`external` est un flag, pas un niveau. Une relance est `E3 + external`; changer l'e-mail de
facturation est `M2 + privacy_sensitive + recipient_authority`; enregistrer un paiement est `E3` ;
une signature client est `third_party_act` et ne peut jamais être fabriquée par Jarvis.

Une préparation `P1` peut persister une proposition éphémère chiffrée et bornée pour permettre sa
lecture ou sa reprise. Elle ne crée ou ne modifie aucun agrégat métier autoritaire, numéro, grant,
outbox, écriture comptable ou statut juridique. Dès qu'un tel effet existe, l'action est `M2` ou
`E3` selon sa conséquence, même si l'UI continue à l'appeler « brouillon ».

### 7.0 Table normative classe→mode et grille de step-up (FD-2026-0817-02)

Le mapping suivant est **normatif dans cette spec, contre-signé, et n'est jamais délégué au
catalogue** : le catalogue porte les valeurs par action, mais aucune entrée ne peut y déroger vers
le bas, et aucun classement en `confirmable` avec restitution vocale ne peut contourner cette
table.

| Situation | Reçu de présentation minimal | Step-up |
| --- | --- | --- |
| `L0` | aucun | non |
| `P1` | aucun — annoncer « préparé, rien envoyé/émis » | non |
| `M2` sans aucun des flags `financial`, `external`, `mass_action`, `destructive`, `irreversible`, `security_sensitive`, `recipient_authority` | `voice_presentation_ack` admis (confirmation vocale one-shot liée au digest de la proposition) | non |
| `E3`, ou toute action portant `financial`, `external`, `mass_action`, `destructive`, `irreversible` ou `security_sensitive` ; tout octroi/modification/extension de mandat §7.2 | **`screen_ack` obligatoire** — présentation sur écran réel et confirmation par tap ; `voice_presentation_ack` interdit | selon liste R3 |
| Liste R3 (FD-02) : destruction définitive, avoir au-delà du seuil, coordonnées bancaires exposées aux clients, action de masse, fusion d'entités, modification du profil légal société, export FEC, mise en demeure, et tout acte engageant ≥ 5 000 € TTC | `screen_ack` | **`screen_commit` avec biométrie/PIN du terminal obligatoire** |
| R4 : suppression de compte, achat/changement d'abonnement, changement d'identité du compte | hors Jarvis — parcours écran dédié, la voix peut au plus y naviguer | authentification renforcée du parcours dédié |

Bornes de masse (FD-02) : ≥ 2 destinataires = `mass_action` ; préview nominatif complet
obligatoire ; plafond 20 destinataires par mandat. Le seuil de montant (5 000 € TTC) est fixe en
V1, paramétrable par tenant ensuite, jamais désactivable. Délégations et double approbation restent
sans objet tant que le produit est mono-utilisateur (FD-07). Ce mapping est le plancher
`decideAgentControl` existant (« une proposition ne se confirme jamais financièrement à la seule
voix ») élevé au rang de politique de la spec.

Règles normatives :

1. `L0` et `P1` purs ne demandent pas de seconde confirmation.
2. Toute `M2` présente d'abord les valeurs autoritaires et le diff. L'impératif initial ne vaut pas
   confirmation de ce diff.
3. Toute `E3` ou action `external` exige une confirmation explicite fraîche au dernier point avant
   commit/outbox. Montants, TVA, échéance, destinataire, canal, contenu, pièces et conséquence sont
   montrés et vocalisables.
4. Une commande composée prépare le plan complet mais s'arrête à chaque frontière `E3`,
   `external` ou acte de tiers. Une confirmation générale n'autorise jamais des envois futurs.
5. Un groupe de `M2` peut partager une confirmation uniquement si la liste est fermée, entièrement
   affichée et appliquée atomiquement. Les échecs partiels sont interdits.
6. Une confirmation est scellée sur tenant, principal, action/version, proposition, cibles et
   révisions, digests d'entrée/effet, risques, expiration et reçu de présentation typé
   `screen_ack | voice_presentation_ack`. Toute dérive invalide.
7. « Oui » sans proposition courante, après expiration, venant d'un ancien tour, entendu dans un
   audio tiers ou après un barge-in non corrélé produit zéro effet.
8. La voix seule n'est pas une authentification renforcée. Les actions de la liste R3 de la table
   §7.0 **exigent** `screen_commit` avec biométrie/PIN du terminal — ce n'est pas une option
   d'action ; Jarvis conserve le run et reprend après ce step-up.
9. Une correction n'est jamais décrite comme un rollback magique : facture émise -> avoir,
   paiement -> reversal, message parti -> nouvel envoi correctif, mutation interne -> commande
   inverse auditée si le domaine la permet.

### 7.1 Protocole de confirmation one-shot

Une confirmation n'est ni un booléen, ni un texte « oui ». L'autorité de proposition conserve une
union fermée portant au minimum : `confirmationId`, `companyId`,
`scope = run(runId, expectedRevision) | one_shot(actionAttemptId)`, `proposalCommandId`,
`actionId@version`, `effectSetId` et la liste fermée/bornée/digestée d'`effectIds` préalloués côté
serveur (exactement un hors batch),
principal attendu, session/terminal et challenge de présentation, IDs/révisions des cibles,
`canonicalInputDigest`, `proposalHash`, digest de chaque effet et du batch, flags de risque, méthode
de step-up requise, `issuedAt`, `presentedAt`, `expiresAt` et statut.

Cycle fermé : `issued -> presented -> consumed | rejected | expired | invalidated`. `presented`
n'est atteint qu'après un reçu typé `screen_ack | voice_presentation_ack` provenant d'une surface
réelle ou restitution vocale complète autorisée par la policy. **Pour toute action classée
`screen_ack` obligatoire par la table §7.0, seul un `screen_ack` d'une surface réelle atteint
`presented` ; une restitution vocale, même complète, ne l'atteint jamais.** `fresh` signifie simultanément :
TTL numérique de l'action non expiré, principal/rôle et
step-up courants, révision du run ou tentative one-shot exacte et dépendances inchangées, cibles
relues et challenge de présentation courant.

La commande de confirmation porte un `confirmationCommandId` cryptographique conservé au retry et
répète scope, `confirmationId`, `effectSetId`, session/terminal et challenge. Le serveur dérive la
liste d'`effectIds` de la proposition persistée et n'accepte jamais cette liste du client. Pour un run,
`JarvisCommandGateway` revalide tous les champs et, dans sa transaction unique, marque la
confirmation `consumed`, inscrit `consumedByCommandId`, append l'événement, CAS le run et crée tous
les work items. Pour une action manuelle one-shot, l'unique `commandAuthority` réalise la même
consommation et la mutation/outbox dans sa propre UoW purpose-specific ; si elle ne peut pas les
joindre atomiquement, l'action reste `closed`. Le même commandId et le même fingerprint rejouent le
reçu ; un autre commandId ne peut jamais réutiliser une confirmation consommée. Double tap, deux
appareils et voix/tap concurrents ont donc un seul gagnant.

Une mutation manuelle, une révocation, un nouveau destinataire, une dérive de montant, une nouvelle
session non autorisée ou un ACK tardif invalident la proposition ; ils ne valent jamais confirmation
rétroactive. `screen_commit` consomme de la même façon un challenge one-shot lié au run, à la
révision ou à l'action one-shot, à la proposition, au principal et au résultat d'authentification du
terminal. Une action nécessitant deux approbateurs, une délégation ou un seuil non spécifié reste `closed` :
`screen_commit` ne remplace pas une décision de policy.

### 7.2 Actions de masse et mandats futurs

Une action de masse scelle une liste paginée de cibles réelles, son digest, les comptes et montants
agrégés, les exclusions, une borne maximale et la stratégie d'erreur. Chaque effet externe possède
son propre `effectId` et son reçu ; un succès partiel n'est jamais présenté comme succès global.
Les caps, rôles, éventuelle double approbation et possibilités d'annulation sont définis dans
l'action versionnée, jamais par le modèle.

L'octroi, la modification ou l'extension d'un mandat est un acte de la liste R3 : `screen_ack` +
`screen_commit` biométrique obligatoires (table §7.0). Une relance automatique n'est autorisée sans
confirmation humaine par occurrence que par un mandat
durable distinct, lui-même confirmé et révocable, qui borne exactement population/éligibilité,
template, canal, cadence, quiet hours, nombre maximal d'envois, période, régime B2B/B2C, motifs
d'arrêt et traitement des litiges/paiements. Avant chaque occurrence, le domaine relit solde,
exigibilité, contact, opposition, transmission, avoirs, paiements et mandat courant. Toute dérive
hors mandat suspend l'envoi et demande une nouvelle proposition. Sans mandat catalogué et certifié,
chaque relance externe exige sa propre confirmation fraîche ; une phrase initiale ne préautorise
jamais les futures occurrences.

## 8. Résolution des entités, faits manquants et contexte

Le modèle peut proposer un libellé ou une intention ; il ne fournit jamais l'autorité d'une entité.
Chaque résolveur :

1. applique tenant, principal, rôle et RLS avant la recherche ;
2. normalise sans inventer et borne le nombre de candidats ;
3. renvoie zéro, un ou plusieurs candidats avec identifiants réels ;
4. demande une création ou un choix structuré uniquement lorsque nécessaire ;
5. relit l'entité et sa révision immédiatement avant proposition puis avant commit.

Zéro candidat n'autorise pas une création implicite. Un candidat fort reste une suggestion affichée.
Plusieurs candidats produisent des choix réels numérotés. Le contexte d'écran est un indice, jamais
une preuve de tenant, d'identité, de destinataire ou de révision.

Jarvis extrait tous les faits d'une phrase, conserve ceux qui ont été confirmés et ne redemande que
le minimum réellement manquant. Chaque fait porte sa provenance : `user_explicit`,
`database_authority`, `derived_rule`, `screen_context` ou `unconfirmed_default`. Un défaut UI
`unconfirmed_default` n'entre jamais dans un contrat, montant, délai, canal ou clause engageante.

Les dates utilisent le fuseau confirmé du propriétaire et sont conservées sous une forme canonique.
Les montants sont des entiers en centimes et les taux/quantités suivent les types du domaine. Les
calculs viennent des use cases, jamais du LLM.

Une adresse e-mail ou un numéro dicté librement n'est jamais utilisé directement pour un devis,
une facture, un paiement ou une relance. Il doit d'abord devenir une proposition de contact ou un
destinataire ad hoc confirmé, puis être relu avec son digest au moment de l'envoi.

## 9. Clients, contacts et communications

### 9.1 Clients et contacts

Jarvis doit pouvoir rechercher, créer et modifier la fiche client ainsi que lister, créer, modifier
et supprimer ses contacts. La création minimale et l'enrichissement ultérieur partagent les mêmes
invariants que les écrans. Les champs qui influencent TVA, facturation, bon de commande, adresse ou
destinataire invalident toute proposition aval devenue stale.

La création de client exige avant admission Jarvis un coordinateur idempotent purpose-specific :
même `effectId` et même intention -> même `customerId`; contenu différent -> conflit ; crash ou
réponse perdue -> replay sans doublon. La même règle s'applique à la création de chantier et de
contact lorsqu'un nouvel ID est généré.

Les doublons ne sont jamais fusionnés automatiquement. SIREN/SIRET, nom, adresse, email et téléphone
peuvent produire une alerte ou des candidats ; une fusion éventuelle est une action distincte,
destructive et renforcée.

### 9.2 Contacter un client

Le processus de communication est : cible réelle -> contact réel -> canal disponible -> contenu et
pièces -> aperçu exact -> confirmation -> outbox -> observation du résultat. Le reçu conserve le
destinataire, canal, digest de contenu, artefacts, idempotency/effect ID et statut provider.

- **E-mail serveur** : envoi possible seulement par le provider certifié et l'outbox durable.
- **SMS/WhatsApp/autre messagerie** : envoi réel uniquement si un connector et ses receipts sont
  certifiés. Sinon Jarvis ouvre un composer natif prérempli et retourne `handoff_opened`, jamais
  `sent`.
- **Téléphone** : Jarvis choisit le numéro confirmé et peut ouvrir l'appel. Sans intégration
  téléphonique, il annonce `call_handoff_opened`, jamais « client contacté ».
- **Message libre** : le contenu promotionnel, transactionnel ou de relance est classifié par une
  policy serveur. Pièces, CC/BCC, templates, opposition et quiet hours sont explicitement gérés.

La modification d'un contact entre aperçu et envoi invalide la proposition. Un message envoyé ne
peut pas être retiré ; un nouvel envoi correctif exige sa propre confirmation.

## 10. Chantiers, interventions, équipements et dépenses

Jarvis couvre la création, la modification, la fermeture et la réouverture d'un chantier, son client,
son adresse, ses notes, photos et rattachements. Un chantier ne peut pointer qu'un client du même
tenant ; une fermeture concurrente invalide tout nouvel effet qui exige un chantier ouvert.

Le parc et le service terrain couvrent :

- recherche, création, modification, retrait et réactivation d'équipement ;
- lecture de l'historique et de la couverture contractuelle avant retrait ;
- création, démarrage, mise à jour et achèvement d'intervention ;
- checklist, résumé, signature ou constat, rapport et envoi du rapport ;
- création, modification, activation, résiliation et renouvellement des contrats de maintenance ;
- préparation de facture annuelle ou d'intervention, sans émission implicite.

Un résumé vocal « c'est terminé » ne peut finaliser une intervention que si la proposition courante
énumère la checklist, les faits et les pièces. Une signature terrain suit sa policy propre et ne se
déduit jamais de la simple fin de l'intervention.

Les dépenses peuvent être saisies ou issues d'un document/OCR, relues, classées, rattachées au bon
chantier et réglées. Les données OCR sont toujours des suggestions. Le fournisseur, le numéro, les
montants, la TVA, la date et le statut de paiement sont revalidés avant commit. Un paiement de
dépense est `E3`; un simple rattachement chantier est `M2`.

## 11. Devis, envoi et signature

Le parcours devis utilise exclusivement les types/règles canoniques du domaine Devis et l'unique
`QuoteCreationCoordinator` partagé. `QuoteDraftSlot` est refactoré/renommé en place comme unique
ressource métier `QuoteDraft`, utilisée par l'UI et Jarvis ; le run ne conserve que
`quoteDraftId/revision/digest`, jamais une copie des lignes. Comme le slot historique n'a pas d'ID
métier autonome, l'expand ajoute un `quoteDraftId` tenanté nullable compatible writer N-1, le
backfill déterministe l'assigne et le nouveau writer le renseigne avant validation/not-null. Les
tables `agent_mission_quote_line_work` sont ensuite reparentées ou fusionnées par ce même ID sous
`QuoteDraft`, avec contrôle ligne/digest/revision, avant suppression de leur ownership
`AgentMission`. La bascule est idempotente et prouve vieux writer à chaque état intermédiaire ;
aucun draft ni line-work n'est dupliqué ou perdu. Les colonnes/triggers/GUC propres à
`AgentMission` sont alors supprimés. Aucun DTO miroir ou wrapper de compatibilité n'est admis. Le
parcours suit les checkpoints suivants :

1. client et, lorsque pertinent, chantier réels ;
2. lignes, unités, prix, TVA, remises, retenue, validité, urgence et acompte avec provenance ;
3. aperçu fidèle et totaux relus ;
4. confirmation de création du brouillon métier ;
5. reçu idempotent du `Quote` créé ;
6. préparation d'un artefact d'envoi immuable ;
7. confirmation fraîche du destinataire, canal, artefact et conséquence ;
8. outbox et vérité de livraison ;
9. attente d'une signature ou d'un refus externe authentiquement observé.

Aucun défaut d'acompte, délai, urgence ou clause non confirmé n'entre silencieusement dans le devis.
Créer le brouillon n'alloue pas un numéro d'envoi, ne crée pas un grant et n'envoie rien.

L'envoi doit posséder un coordinateur purpose-specific lié à `effectId` : un retry retourne le même
numéro, le même artefact, le même grant, le même job et le même reçu. Il ne recrée ni ne révoque un
token à chaque essai. L'artefact envoyé est lié à un digest du contenu exact et à la révision du
client/contact ; toute mutation invalide la proposition avant outbox.

Jarvis ne signe jamais au nom du client. Il peut préparer et envoyer le lien, expliquer l'étape,
ouvrir la page et observer un reçu externe. `link_opened`, nom auto-déclaré ou possession d'un bearer
ne valent ni identité civile vérifiée ni signature qualifiée. Le niveau de preuve réellement fourni
est affiché et conservé avec le digest de l'artefact signé.

Le run `waiting_external` se réveille sur signature, refus, expiration ou révocation relus depuis
l'autorité. Un simple webhook ne parle pas, ne navigue pas et ne crée aucune facture. Après reprise,
Jarvis annonce « signature observée » seulement si le reçu persistant correspond au même devis et
au même artefact.

## 12. Factures, paiements, impayés et relances

### 12.1 Facture et émission

Jarvis couvre les factures directes et celles dérivées d'un devis signé : acompte, situation et
solde/finale. Le mode, le montant ou avancement, la période, le bon de commande, l'audience, la TVA
et l'échéance sont des faits du domaine. Une facture de situation possède son propre commandId et
reçu ; un retry ne crée jamais la situation suivante.

La création d'un brouillon peut être préparée automatiquement après l'événement métier prévu par la
définition du run, mais ne l'émet ni ne l'envoie. Par défaut, émission et envoi sont deux frontières
`E3` distinctes :

- **émission** : snapshot immuable, numéro sans trou selon l'autorité, PDF/Factur-X, écritures et
  règles réglementaires ;
- **transmission** : destinataire ou plateforme, canal, artefact émis et reçu externe.

Une éventuelle confirmation combinée n'est admise que par une action versionnée qui affiche les deux
effets et prouve leur contrat transactionnel/outbox ; elle n'est jamais inférée d'une phrase vague.

Une facture émise n'est pas réécrite. Une correction utilise un avoir ou le protocole de reversal du
domaine. Jarvis peut préparer ce geste mais en expose les conséquences avant confirmation.

### 12.2 Paiements et impayés

Jarvis relit le montant émis, les échéances, paiements, avoirs, retenues, litiges et transmission
avant de qualifier un solde d'impayé. Le modèle ne calcule ni solde, ni exigibilité, ni pénalité.

Il peut :

- afficher la balance âgée et les factures réellement dues ;
- créer ou ouvrir un lien de paiement ;
- enregistrer un paiement exact avec méthode, date, référence et clé d'idempotence ;
- programmer l'encaissement lorsqu'une règle légale ou produit le permet ;
- préparer une relance contextualisée ;
- envoyer une relance confirmée ;
- configurer une politique de relance future, elle-même confirmée et révocable.

Un paiement est un engagement `E3`. Un doublon, une réponse perdue ou deux appareils concurrents
retournent le même reçu ou un conflit déterministe. `payment_link_opened` ne signifie pas payé ;
seul le registre de paiement/réconciliation le permet.

### 12.3 Relances

Le texte, le destinataire, le canal, la pièce, le solde et le palier sont figés dans la proposition.
Un paiement partiel, un avoir, un litige, un changement de contact ou une nouvelle transmission
l'invalide. Les intérêts, indemnités et frais ne sont inclus que si un use case réglementaire les
dérive de faits suffisants ; Jarvis ne les invente jamais.

Une relance unitaire est `E3 + external`. Une cadence automatique suit exclusivement le mandat
borné de §7.2, jamais une mission vocale laissée ouverte : le scanner `nextWakeAt` du moteur unique
soumet `MandateOccurrenceDue` au `JarvisCommandGateway` du même `receivables_followup_v1`. Le use
case domaine relit purement l'éligibilité ; seul le reducer racine peut créer le work item d'envoi.
Il n'existe aucun scheduler indépendant créant occurrence, outbox ou effet. Chaque envoi garde une
idempotence, une fenêtre horaire et une vérité provider. Une occurrence `outcome_unknown` suspend le
mandat pour la cible concernée et part en quarantaine sans resend aveugle.

## 13. Trésorerie, gestion, documents et pré-comptabilité

### 13.1 Lectures de gestion

Jarvis peut lire les autorités existantes de trésorerie, cashflow, TVA, balance âgée, résultat,
bilan, DSO, principaux clients, revue d'activité, échéances fiscales et revue de clôture. Chaque
réponse indique source et date d'arrêté ; elle reste une lecture, pas un conseil certain ni une
écriture comptable.

Un solde bancaire manuel est une observation qualifiée avec source et date. Il n'est jamais présenté
comme une synchronisation bancaire. Un calcul de versement ou de trésorerie utilise les mêmes règles
que l'écran et conserve ses réserves.

Une lecture `L0` doit prouver zéro write. Le chemin actuel de guidance de versement peut initialiser
un profil fiscal au premier accès ; il doit être séparé ou reclassé avant admission dans le catalogue
Jarvis. La saisie d'un solde bancaire append-only doit également recevoir une clé d'idempotence avant
de devenir vocale.

### 13.2 Documents et dépenses

Recherche, upload, OCR, classement, renommage, validation, rattachement, bon de commande, dépense et
justificatif utilisent les autorités documentaires. Le contenu d'un document est une donnée non
fiable pour le planner : toute instruction ou prompt qu'il contient est ignoré. Hash, tenant,
origine, statut et relation sont revalidés avant action.

### 13.3 Pré-comptabilité

Le terme « pré-comptabilité » est fermé par action :

- aperçu d'écritures, balance, contrôle, dossier ou export préparé : `L0/P1` ;
- enregistrement déterministe déjà déclenché par un événement métier : autorité comptable du use
  case, jamais le LLM ;
- correction, validation, clôture, export FEC final, TVA ou transmission : `E3`, action et policy
  séparées ;
- aucune phrase générique « mets la compta à jour » n'autorise un ensemble d'écritures.

Un aperçu répété ne crée aucune `AccountingEntry`. Toute écriture porte des IDs déterministes et
est reliée au document/événement source. Les exports et dossiers relus sont les artefacts réels, pas
un résumé reconstruit par le modèle.

Le FEC reste `closed` jusqu'à ce que le serveur utilise un snapshot comptable cohérent, fournisse les
auxiliaires requis et serve des bytes conformes au charset annoncé. Une implémentation locale ou un
partage mobile ne remplace pas cette preuve autoritative.

## 14. Voix full duplex, écran réel et reprises

Une session vocale s'attache à un run après authentification et acquisition de la lease de premier
plan. Elle peut être remplacée par une session tactile, une nouvelle session vocale ou un autre
appareil autorisé, sans dupliquer la commande.

Règles d'interaction :

- le barge-in arrête la lecture audio mais ne confirme, n'annule ni ne rejoue une commande ;
- une confirmation n'est acceptée que dans la fenêtre et avec le challenge courant ;
- la navigation attend l'ACK de l'écran, relit l'entité réelle puis lie le contexte ;
- le vrai détail, la vraie facture, le vrai chantier ou le vrai client est rendu avant l'ACK ;
- un restart avec binding valide n'auto-navigue et n'auto-parle pas ; l'utilisateur choisit
  explicitement « Reprendre » ;
- un worker, cron ou webhook ne parle, ne navigue ni ne met à jour directement le run ; il soumet un
  signal idempotent au gateway unique, puis une prochaine interaction présente le résultat ;
- une transition voix -> toucher ou toucher -> voix conserve les mêmes proposition, révision et
  reçus ;
- le fallback manuel ne crée pas une seconde autorité : il avance le même run par la même commande.

La surface persistante montre trois zones : plan/checkpoints, proposition courante, reçus/états
externes. Elle expose `Modifier`, `Confirmer`, `Annuler` et `Continuer à la main` lorsque permis.

Bob prononce une synthèse courte ; `Lis les détails` vocalise les champs critiques. Aucun champ
nécessaire à une confirmation n'est uniquement visuel. État focus, lecteur d'écran, contraste,
réduction de mouvement et états loading/empty/error/data font partie du contrat.

La confidentialité s'applique au rendu : e-mail, téléphone, solde ou contenu sensible ne sont pas
vocalisés intégralement sur écran verrouillé ou sans demande explicite. Les traces n'enregistrent ni
audio, ni transcript durable, ni contenu de proposition en clair.

## 15. Idempotence, concurrence, transactions et effets externes

La garantie distribuée est : au plus une transition admise pour
`(companyId, runId, commandId)`, avec le fingerprint stocké et comparé — identique rejoue, différent
produit un conflit — et vivacité par redelivery level-triggered. Les effets sont at-least-once
rendus sûrs par idempotence ou réconciliation. Aucun document ne promet un « exactly-once » réseau.

Pour chaque action mutante orchestrée :

1. le run persiste l'intention canonique et un `effectId` avant l'effet ;
2. le coordinateur métier utilise ce `effectId` dans un namespace purpose-specific ;
3. même clé + même fingerprint retourne le même objet/reçu ;
4. même clé + autre fingerprint produit un conflit ;
5. le worker réconcilie après timeout ou crash avant tout retry ;
6. le run n'avance qu'après relecture du reçu et des postimages.

Une action manuelle one-shot hors run suit les mêmes points dans le registre/UoW purpose-specific
de sa `commandAuthority` : intention et effectId avant effet, fingerprint fermé, même reçu au replay
et relecture du postimage. Cette différence de scope ne crée ni variante métier ni moteur parallèle.

Avant U1, les blockers connus sont explicitement traités : création client/contact/chantier,
création manuelle de devis, commande send devis/facture, saisie de solde bancaire et facture de
situation reçoivent une clé opaque stable par acte ; la clé paiement est un UUID d'acte confirmé et
non une fonction du montant.

Les opérations locales utilisent leurs UoW et ordres de verrous métier. La transaction du run reste
courte et ne contient aucun réseau. Une atomicité multi-agrégats n'est revendiquée que par un
coordinateur purpose-specific et un test PostgreSQL ; sinon le run est une saga explicite avec
checkpoints et aucune compensation générique.

Deux commandes concurrentes passent par CAS. Une seule gagne ; la perdante reçoit `stale_revision`,
effectue au plus une relecture et ne resoumet pas automatiquement. Une commande rejouée avec son
fingerprint retourne le reçu original. Une ancienne confirmation, un ancien ACK ou un callback
tardif ne touche jamais le nouvel état.

Vocabulaire commun des projections externes : `pending`, `provider_accepted`, `delivered`,
`failed_terminal`, `retry_due` et `outcome_unknown`. Ce vocabulaire n'est pas une machine d'état
universelle : chaque provider/action ferme ses propres états et transitions, notamment
`rejected`, `bounced`, `expired`, `revoked`, `cancelled` ou `disputed` lorsqu'ils existent.
`queued` ou `provider_accepted` ne signifient pas livré. `outcome_unknown` bloque tout nouvel envoi
automatique jusqu'à réconciliation provider ou décision humaine qui reconnaît explicitement le
risque de doublon sans réécrire l'issue historique.

Les retries ont backoff, plafond, lease et dead-letter/quarantaine. Un incident crée une alerte
corrélée, pas un bruit périodique. La fermeture du tenant, le retrait de rôle, la révocation d'un
contact ou d'un grant invalide les work items non committés.

## 16. Sécurité, confidentialité, droit et vérité de livraison

Chaque lecture, proposition, commande, run, work item et événement est tenanté et lié au principal.
Les adapters conservent RLS, anti-IDOR, rôle, entitlement, fermeture de société et limites de masse.
Le planner n'accède pas directement aux repositories et ne reçoit que des projections minimisées.

Les noms de clients, documents, e-mails, messages et résultats OCR sont des données non fiables.
Ils ne peuvent modifier le prompt système, choisir un outil, désactiver une confirmation ou fournir
une adresse d'effet. Les URLs, pièces et destinations passent par des validateurs/allowlists.

La voix n'est pas une preuve d'identité. Une voix enregistrée, un écho de haut-parleur ou un « oui »
d'un tiers ne déclenche aucun effet sans proposition, contexte, challenge et, selon le risque,
step-up du terminal.

Les communications sont classifiées comme transactionnelles, relationnelles, relances ou
prospection. Consentement, intérêt légitime, opposition, quiet hours, liste repoussoir, contenu et
rétention suivent la policy applicable ; une phrase libre du modèle ne décide pas cette base.

Pour le recouvrement, le solde et l'exigibilité viennent des pièces, échéances, paiements, avoirs et
litiges. Aucun frais ou menace n'est généré sans règle certifiée. Pour la signature, le produit
annonce exactement le niveau de preuve fourni. Pour la facturation électronique, un e-mail PDF ne
vaut jamais transmission via une plateforme agréée lorsqu'elle est légalement requise.

La minimisation s'applique aux événements et traces : IDs pseudonymisés, digests, codes fermés et
rétention bornée ; aucun secret, token, audio, transcript ou corps de message. Les contenus métier
restent dans leurs stores purpose-specific, chiffrés et soumis aux droits d'accès, effacement ou
rétention légale correspondants.

Les mots de vérité sont fermés : `brouillon`, `prêt`, `en file`, `accepté par le fournisseur`,
`livré`, `résultat inconnu`, `signature observée`, `paiement enregistré`, `aperçu comptable`.
Jarvis ne transforme jamais un tool call, une navigation, un enqueue, un timeout ou une parole en
preuve d'envoi, de signature, de paiement ou de comptabilisation.

### 16.1 Références officielles vérifiées le 17 août 2026

- La [CNIL distingue communications transactionnelles, relationnelles et
  prospection](https://www.cnil.fr/fr/communication-electronique-quelles-regles) et exige que la
  qualification suive la finalité, avec information, consentement ou opposition selon le cas.
- La [CNIL recommande privacy by design, minimisation, base légale, transparence et maîtrise des
  données pour les assistants vocaux](https://www.cnil.fr/fr/assistants-vocaux-les-bons-reflexes-pour-les-professionnels)
  et a publié une [note dédiée à l'IA agentique](https://www.cnil.fr/fr/ia-agentique-cnil-cianum-note).
- La [DGCCRF rappelle qu'une créance recouvrée doit être certaine, liquide et
  exigible](https://www.economie.gouv.fr/dgccrf/les-fiches-pratiques/recouvrement-amiable-de-creances-les-regles-connaitre).
- L'administration fiscale indique qu'au 1er septembre 2026 toutes les entreprises doivent pouvoir
  recevoir les factures électroniques, que les GE/ETI doivent alors émettre électroniquement et
  que les PME/micro passent à l'émission au 1er septembre 2027 ; les échanges B2B français concernés
  passent par une [plateforme agréée](https://www.impots.gouv.fr/professionnel/je-decouvre-la-facturation-electronique),
  un PDF par e-mail ne suffisant pas.
- Le [règlement eIDAS, article 25](https://eur-lex.europa.eu/eli/reg/2014/910/2024-10-18), distingue
  l'effet d'une signature électronique et l'équivalence manuscrite propre à la signature qualifiée.

Ces liens sont des gates de revalidation à la date de release, pas une consultation juridique
substituable aux règles de domaine, à l'autorité compétente ou au conseil professionnel nécessaire.

## 17. Remplacement de BobActions et AgentMission par le moteur unique

Cette spec supplante comme architecture cible le roadmap candidat limité à la chaîne devis. Les
invariants utiles des specs A1-manual et J1-A1a sont déplacés une seule fois dans les specs/tests
canoniques, puis ces documents sont marqués `superseded` et sortent de l'autorité de publication ;
ils ne créent ni moteur, ni agrégat, ni suite parallèle.

La cible ne contient qu'un ensemble d'exécution : `JarvisCommandGateway -> JarvisRun ->
JarvisRunEvent/JarvisWorkItem -> ports métier`. Toute interaction qui avance un run utilise ce
gateway ; une action manuelle one-shot conserve son endpoint mais rejoint directement le même use
case et la même policy. Il existe un seul catalogue, une seule policy de confirmation, une seule
canonicalisation, un seul ledger d'orchestration Jarvis et un seul `JarvisReducer` racine. Les
registres d'idempotence purpose-specific des domaines restent les autorités de leurs effets et ne
sont ni recopiés ni remplacés par un registre Jarvis parallèle. Aucun `*ForVoice`, `*ForManual`,
second journal d'orchestration, second outbox d'un même effet ou copie de use case n'est admis.

L'actuel `AgentMission` est refactoré/absorbé en place, pas enveloppé par un parent durable. Les
tables `agent_missions` et `agent_mission_events` sont expandées puis renommées/normalisées au
cutover pour devenir le stockage logique de `JarvisRun` et `JarvisRunEvent` ; aucune paire de tables
parallèle ne conserve la même autorité. Le moteur `AgentRuntime` historique est supprimé.
`agent_journal_entries` devient au plus une archive read-only sous rétention, sans writer ni replay,
puis est purgé selon sa policy ; il n'est jamais backfillé en faux runs.

Après le cutover, les anciens endpoints d'exécution retournent `426 upgrade_required` ou sont
supprimés. Ils ne proxyfient pas vers une seconde façade et ne contiennent aucun adapter durable.
Les clients compatibles utilisent l'unique API Jarvis ; l'ancien plancher de version est sorti du
support avant suppression définitive des routes. Le handler statique `426`, sans import métier,
n'est qu'un tombstone de migration et doit avoir disparu avant le statut `implemented` du moteur.

### 17.1 Cutover global sans coexistence active

Le cutover production est blue/green, global et à sens unique, sous maintenance des ingresses :
arrêt des nouvelles commandes, drain ou fermeture explicite des propositions/runs ouverts, arrêt
vérifié de toute la flotte ancienne, migration/renommage des tables et contraintes, révocation des
fonctions/permissions legacy, déploiement de la flotte Jarvis, smoke puis réouverture. Il n'existe
aucun registre d'ownership ou lookup de génération dans le chemin runtime. Une ancienne image qui
reviendrait après le cutover échoue sur les contraintes/grants DB et ne peut écrire.

Avant ouverture, les gates binaires sont : aucune proposition legacy sans effet encore ouverte,
aucun effet legacy autorisé/parti/inconnu sans reçu et mapping d'observation migrés, ancienne flotte
arrêtée, anciens workers/crons arrêtés, anciennes permissions d'écriture révoquées et nouveau schéma
vérifié. Une proposition sans effet peut être fermée puis recommencée ; un effet autorisé,
`outcome_unknown` ou encore livrable n'est jamais administrativement déclaré terminal pour atteindre
le gate. Il doit être réconcilié jusqu'à un état terminal, ou migré en checkpoint d'observation
Jarvis conservant exactement `effectId`, artefact, reçu et mapping provider, sans droit de
redispatch. Après la première admission Jarvis, revenir à une image contenant l'ancien moteur est
interdit ; le seul repli est kill switch d'admission puis forward repair ou version compatible du
moteur unique.

Deux gates supplémentaires ferment la continuité côté surface et côté clients installés :

- **Gate de continuité de surface** : la liste exacte des actions garanties ouvertes à la
  réouverture est égale à l'ensemble des actions legacy réellement servies en production par les
  DEUX surfaces du moteur historique — l'onglet assistant texte publié et le chemin realtime
  (§3). Cette liste est jointe au `LegacyEffectEvidenceManifest`, étendu à la parité de surface,
  avec `unclassified=0` sur cette liste avant la fenêtre. Rouvrir avec une surface publiée réduite
  est une régression silencieuse interdite : chaque action manquante est soit Jarvis-native et
  ouverte à la réouverture, soit explicitement retirée par décision fondateur tracée AVANT la
  fenêtre — jamais constatée après coup.
- **Gate de plancher de version client** : « l'ancien plancher de version est sorti du support »
  présuppose un mécanisme de plancher global qui n'existe pas encore dans le dépôt (seul le
  protocole mission possède un `upgrade_required`). Avant la fenêtre, soit un mécanisme de
  force-update global est implémenté, déployé et prouvé sur les clients installés, soit les
  anciennes routes répondent en lecture seule avec bandeau de migration pendant une période de
  compatibilité chiffrée dans le plan de cutover. Un client installé ne rencontre jamais un `426`
  sans chemin de mise à jour fonctionnel présenté dans l'app.

Un `LegacyEffectEvidenceManifest` exhaustif ferme cette gate action par action avant maintenance.
C'est un artefact immuable de CI/release, jamais une table, un registre d'ownership ou un lookup du
runtime. Pour chaque ancien tool/caller, il lie l'autorité DB, l'outbox/job, le provider, les
identifiants de corrélation, la requête de réconciliation et les failpoints avant/après effet.
Chaque occurrence est prouvée `not_started`, `terminal_with_receipt` ou
`migrated_observation_checkpoint`. Un outil sans preuve ou un effet `outcome_unknown` non
réconciliable bloque le cutover global ; il ne peut être masqué par une fermeture administrative,
une absence de ligne UI ou une agrégation de compteurs.

Le canary du moteur s'effectue avant ce cutover en staging isolé, pas en faisant tourner deux
moteurs production sur des tenants différents. Les commandId/effectId consommés avant la fenêtre
sont drainés ; aucun rollback ne les réautorise. Le rollback après migration est applicatif vers une
version compatible du moteur unique, ou une fermeture d'admission avec forward repair, jamais le
redémarrage de l'ancien moteur.

Le train de remplacement suit cet ordre :

1. intégrer et faire passer la PR RNW A1 séparément ; elle reste au plus `implemented` ;
2. publier cette directive, l'ADR du moteur unique et le catalogue, puis obtenir la
   contre-signature prescrite ;
3. durcir en place les use cases/coordinators métier et extraire les composants partagés sans
   créer de variante Jarvis ;
4. transformer en place le domaine et les tables `AgentMission` vers `JarvisRun`, avec migrations
   expand/validate, RLS/ACL, preuve writer N-1 avant maintenance et callers réels ;
5. faire passer par le gateway unique toutes les capacités vocales déjà publiées, afin que le
   cutover ne réactive jamais le moteur historique en fallback ;
6. exécuter le cutover global hors ligne ci-dessus, puis supprimer dans le même train le reducer,
   workers, bindings métier, permissions et routes d'exécution legacy ;
7. implémenter puis ouvrir ensuite, domaine par domaine, les entrées manuelles déjà présentes et
   `closed` dans le catalogue exhaustif, sans jamais dupliquer leurs autorités ;
8. supprimer les dernières migrations/helpers transitoires après preuve qu'aucune référence vivante
   ne les utilise ; aucun adapter de compatibilité ne subsiste au statut `implemented`.

Toutes les lignes `AgentMission` sont converties en place, avec les mêmes IDs, révisions, drafts et
line-work, par projection déterministe de leur snapshot courant ; aucune seconde ligne ou table
miroir n'est créée. Les événements historiques restent des `legacy_audit_event_v1` read-only,
non rejouables et non utilisables comme reçus de commande : le cutover ne leur invente ni
commandId/HMAC, ni action/version, ni révisions avant/après. Les nouveaux événements Jarvis naissent
seulement de l'unique gateway. Les propositions ouvertes sans effet sont terminées avant la fenêtre
ou fermées avec un reçu explicite ; les effets déjà autorisés suivent le protocole d'observation
ci-dessus. Les `agent_journal_entries` historiques ne sont jamais backfillés en faux runs, car leur
journal incomplet n'autorise pas cette reconstruction.

La table d'événements porte une union SQL fermée et discriminée. La branche Jarvis exige tenant,
run, séquence, `commandId`, HMAC, `actionId@version`, révisions avant/après et payload d'événement
fermé. La branche `legacy_audit_event_v1` exige ces champs d'autorité Jarvis à `NULL` et conserve
seulement son identifiant/source legacy, son digest brut vérifié, son horodatage et les références
nécessaires à la rétention. Les index de replay, le reducer et tout writer runtime filtrent
exclusivement la branche Jarvis ; aucun trigger ne peut promouvoir ou compléter un événement legacy.

Le manifeste de migration est exhaustif et hashé : `agent_mission_quote_line_work`, tables de
digests/HMAC, chaque FK/colonne `agentMissionId`, triggers, GUC, CHECK, RLS/grants, capability et
bootstrap fields de `RealtimeSessionLease`, index de foreground unique, workers, services, routes et
imports. Pour chacun il fixe `migrate | rename | archive_read_only | drop`, l'ordre et la preuve.
La projection ferme notamment `protocolVersion`, `stateVersion`, statut, binding, TTL et révisions.
La dépendance core à `AgentMissionRealtimeAuthorityProof` disparaît au profit de la preuve de
session/commande canonique ; aucun objet auxiliaire orphelin ne survit.

Les travaux peuvent être revus comme une série de commits empilés sur une branche d'intégration non
déployable, mais aucun commit fusionné sur `main` ni artefact éligible à la release ne contient deux
moteurs exécutables. L'arbre cible ajoute le moteur unique, migre les callers et supprime anciens
reducers/workers/routes dans le même train. Une courte maintenance est acceptée ; promettre à la
fois zéro interruption et zéro coexistence est interdit. Aucun statut `implemented` n'est attribué
tant que les abstractions dupliquées ne sont pas supprimées. Le graphe de dépendances et les tests
statiques interdisent deux reducers racines, deux policies ou deux gateways.

## 18. Lots verticaux et ordre de livraison

Chaque lot est une PR ou courte série de PR atomiques avec flags `OFF`, migrations, callers réels et
preuves. Aucun lot ne revendique la portée des suivants.

Ces lots sont des incréments du même moteur, pas des moteurs ou verticales techniques autonomes.
Avant le cutover global, leur exécution production reste fermée ; après le cutover, aucun fallback
vers l'ancien moteur n'existe. Une capacité encore absente est honnêtement `closed` ou reste
manuelle, jamais exécutée par une seconde orchestration.

### U0 — Autorité, catalogue et ADR

- A1 intégré sur `main` frais ;
- directive universelle dans `OBJECTIFS`, ADR `JarvisRun`, taxonomie de risque ;
- inventaire automatique UI/API/use cases ; audit séparé de `BobActions` uniquement pour garantir
  qu'aucune capacité historique n'est perdue avant sa suppression ;
- zéro action non classée ;
- matrice de rollout et décisions fondatrices consignées.

### U1 — Noyau durable + clients/contacts/communication

- `JarvisRun`, events et work items avec leur premier caller réel ;
- lecture, création et modification client/contact ;
- coordinateurs idempotents de création ;
- préparation puis e-mail certifié ou handoff honnête ;
- changement de destinataire invalide l'envoi ;
- voix/tap, double appareil et crash/replay PostgreSQL.

### U2 — Chantiers et service terrain

- création/modification/fermeture/réouverture chantier ;
- équipements, interventions, contrats et rapports ;
- dépenses/rattachements essentiels ;
- plan client -> chantier réutilisable par les lots aval.

### U3 — Devis, envoi et signature externe

- création/édition complète du brouillon et du vrai devis ;
- artefact immuable, envoi idempotent, vérité provider ;
- attente signature/refus/expiration, park/reprise ;
- Jarvis techniquement incapable de signer pour le client.

### U4 — Factures et transmission

- facture directe et depuis devis, acompte/situation/solde ;
- brouillon, émission, PDF/Factur-X, avoir ;
- envoi email ou plateforme agréée selon audience ;
- perte de réponse et outcome provider inconnu.

### U5 — Paiements, impayés et relances

- enregistrement/réconciliation paiement ;
- balance âgée déterministe, relance exacte, cadence et quiet hours ;
- paiements partiels, avoirs, litiges, course paiement x relance ;
- run long dormant/réveillé sans foreground vocal.

### U6 — Dépenses, documents, gestion et pré-comptabilité

- OCR/document non fiable, dépenses et règlement ;
- trésorerie et revues de gestion ;
- previews, écritures autorisées, corrections, clôture/FEC selon décisions ;
- preuves que toute lecture reste sans write.

### U7 — Fermeture de couverture

- profil/réglages et toute action publique résiduelle ;
- `closed=0`, `unclassified=0`, ancien moteur/code d'exécution/adapters de compatibilité=0 ;
- scénarios inter-domaines complets, providers, modèles et appareils ;
- `universal_certified` lorsque toutes les actions du manifeste exact sont certifiées, même si les
  flags de production restent `OFF` ;
- `universal_released` uniquement lorsque, pour la population revendiquée, chaque action est
  `released`, activée, disponible avec ses dépendances, passée par canary et smoke production ;
- seulement `universal_released` autorise le claim produit universel pour cette population. Une
  capacité certifiée mais non activée n'est jamais présentée comme disponible.

Les lots peuvent être subdivisés pour rester revuables, mais ni leur ordre de dépendance ni leur DoD
ne peuvent être contournés par une ancienne route ou un moteur parallèle.

## 19. Matrice de preuve, E2E et SLO

Chaque `actionId@version` et `definitionVersion` possède un `EvidenceManifest` immuable : commit et
hash du `PublicActionSurfaceManifest`/catalogue, checksums migrations et schémas, environnement et
cohort, rôle DB réellement utilisé, URL du run CI, version exacte modèle/prompt/tools, compte et
mode provider, appareils/OS/build, fixtures, seuils SLO numériques, date, reviewer indépendant et
checksums des artefacts/reçus. Une preuve sans ces bornes ne promeut aucun statut.

Les seuils de latence, disponibilité, coût, retry, quarantaine et taux d'erreur sont écrits dans
l'entrée catalogue avant le run de certification ; ils ne sont ni choisis après mesure, ni remplacés
par une moyenne globale. Les conclusions conformité citent juridiction, source, version/date,
responsable de revue et date de revalidation.

### 19.1 Preuves structurelles

- inventaire de chaque route, bouton/gesture métier et méthode publique ; chaque action apparaît
  exactement une fois dans le catalogue ;
- test statique : AI, transport et reducer n'importent aucun repository/provider concret ;
- la route manuelle et l'entrée catalogue Jarvis résolvent le même token `commandAuthority` et la
  même version de policy ; voix et tap pointent donc le même port/use case sans copie ;
- le FSM `Session/ConversationState` n'importe ni catalogue, `commandAuthority`, repository,
  reducer ou store Jarvis ; seul son adapter de bord peut soumettre une enveloppe au gateway ;
- schémas, définitions, transitions et actions exhaustifs, tous consommés par l'unique reducer
  racine ; mutations invalides et seconde implémentation de reducer rejetées ;
- action `closed` impossible à annoncer ou invoquer dans le manifeste modèle.

### 19.2 Preuves transactionnelles et recovery

- PostgreSQL réel non-superuser, RLS/cross-tenant et rôle ;
- migrations expand -> validate -> cutover -> finalize avec writer N-1 à chaque étape ;
- CAS, même commandId, collision fingerprint, deux commandIds, deux appareils ;
- crash avant/après run commit, claim work item, autorisation, effet métier, résultat stocké et
  signal atomique ; résultat stocké avant signal est obligatoirement redélivré ;
- lease expirée et worker stale, cancel avant/après autorisation, révocation, retry, backoff,
  quarantaine et fermeture société ;
- même `effectId` -> même objet/reçu ; aucun orphelin ni double effet ;
- timer dupliqué, upgrade N -> N+1, rollback applicatif, purge/rétention et reprise par autre rôle ;
- callback perdu/dupliqué/tardif/réordonné, signature forgée, bon événement sur mauvais compte et
  cross-tenant, polling de réconciliation et réveil déterministe ;
- course admission ancien moteur x cutover global x gateway unique sur plusieurs pods et vieux
  client, en prouvant qu'aucun instant n'admet les deux.

### 19.3 Oracles voix/toucher

Sur fixtures tenantées distinctes, les chemins voix et toucher produisent les mêmes intentions
canoniques, validations, postimages, artefacts et reçus normalisés. Seuls acteur, commandId,
timestamps et journaux de canal peuvent différer. La voix peut être plus restrictive, jamais plus
permissive.

Les E2E écoutent un vrai serveur Nest, utilisent PostgreSQL non-superuser, le vrai client mobile et
un vrai modèle staging. Les assertions relisent DB/API, bytes d'artefact, outbox et provider ; un
texte parlé ou un écran seul n'est jamais l'oracle.

### 19.4 Parcours critiques obligatoires

1. créer puis modifier client/contact, changer l'e-mail entre proposition et envoi ;
2. créer/modifier le chantier du bon client et courir sa fermeture ;
3. préparer/créer/envoyer un devis réel, puis signature par un acteur externe contrôlé ;
4. reprendre après kill et créer le bon mode de facture sans émission implicite ;
5. émettre/transmettre puis simuler réponse perdue et provider inconnu ;
6. rendre la facture échue, appliquer paiement partiel/avoir/litige puis relancer exactement une fois ;
7. enregistrer le paiement et relire écritures/solde/pré-compta ;
8. intervention -> rapport -> facture, ainsi que dépense -> justificatif -> pré-compta ;
9. commande composée couvrant client -> chantier -> devis -> send -> signature -> facture ->
   paiement, avec arrêt à chaque frontière ;
10. même parcours continu en alternant voix, tap, restart et appareil.

### 19.5 Sécurité, confidentialité et accessibilité

- autre tenant/rôle, session volée, confirmation enregistrée/écho, prompt injection dans client,
  document et message, ancien ACK, barge-in et double tap ;
- captures logger/Sentry/traces/provider prouvent l'absence d'audio, transcript, token et PII non
  nécessaire ;
- rétention, révocation, effacement/opposition et fermeture tenant exercés ;
- lecteurs d'écran, focus, détails vocalisés, grand texte et réduction de mouvement ;
- tests sur iPhone et Android physiques, réseau dégradé, appel entrant et cycle de vie réel.

### 19.6 Providers et SLO

E-mail, signature, paiement et plateforme de facturation utilisent sandbox/boîte/page contrôlée ou
staging réelle selon la preuve. Chaque suite couvre acceptation, livraison, bounce/échec, timeout,
webhook tardif et résultat inconnu.

Les budgets p50/p95 de compréhension, proposition, commit, reprise et notification, ainsi que les
seuils d'erreur/coût/quarantaine, sont numériques et fixés avant certification de chaque action,
mesurés dans Voice Trace sans contenu sensible. Fiabilité, coût et timeouts sont des gates binaires,
pas une moyenne masquant les erreurs.

Des mutations anti-faux-vert doivent casser séparément use case, policy de confirmation, tenant
guard, idempotency, écran réel et mapping provider.

## 20. Non-objectifs temporaires et décisions fondatrices restantes

La directive du 17 août ferme la question de portée : « toute l'application » signifie toutes les
capacités publiques utilisateur, avec orchestration vocale et validation adaptée au risque. Elle ne
signifie pas administration interne, migration ou exécution de code arbitraire.

**Les dix décisions ci-dessous sont TRANCHÉES et consignées le 17/08/2026** — délégation fondateur
explicite (« tu répondras toi-même, avec expertise »), arbitrage Claude, amendables par le
fondateur seul :
[DECISION_JARVIS_UNIVERSEL_20260817.md](DECISION_JARVIS_UNIVERSEL_20260817.md)
(`FD-2026-0817-01` à `-10`, plus `FD-2026-0817-11` pour l'articulation V1 en §2.1). Les entrées du
catalogue référencent ces `founderDecisionId` :

- `[TRANCHÉ FD-2026-0817-01]` canaux de message autorisés : e-mail = seul envoi provider ;
  SMS/WhatsApp/appel = handoff natif ; templates tenant-scoped, pièces rattachées à l'entité,
  BCC restreint au tenant ; prospection interdite ;
- `[TRANCHÉ FD-2026-0817-02]` step-up et seuils : grille R0–R4 de la table §7.0, seuil 5 000 € TTC,
  masse ≥ 2 avec plafond 20 par mandat ; délégations/double approbation sans objet en V1 ;
- `[TRANCHÉ FD-2026-0817-03]` signature : SES eIDAS, claim « signature électronique avec piste
  d'audit » uniquement, jamais de claim d'identité vérifiée ;
- `[TRANCHÉ FD-2026-0817-04]` facture après signature : chemin légal optimal proposé (embargo
  L221-10 B2C ; situation 30 % B2B/B2G), émission+envoi confirmables en une confirmation R2 qui
  nomme les deux effets, work items séquencés, plafond `netToPay` ;
- `[TRANCHÉ FD-2026-0817-05]` relances : unitaire confirmée R2, e-mail seul, fenêtre 09h–19h ouvrés,
  pénalités légales auto en B2B seulement, litige = arrêt total, mandat de campagne post-V1 ;
- `[TRANCHÉ FD-2026-0817-06]` doublons : fusion `closed` en V1, détection en lecture seule ;
  post-V1 fusion R3 avec préview des réaffectations et tombstone ;
- `[TRANCHÉ FD-2026-0817-07]` rôles : propriétaire seul en V1, comptable = exports ; post-V1
  lecture seule comptable puis employé terrain, plafonds hérités de la grille ;
- `[TRANCHÉ FD-2026-0817-08]` pré-comptabilité : Bob prépare / l'humain valide, propositions
  dérivées des autorités, correction = écriture inverse proposée, FEC étiqueté préparation ;
- `[TRANCHÉ FD-2026-0817-09]` RGPD voix/tiers : artisan RT / Bob ST / OpenAI ST ultérieur nommé,
  6.1.b + 6.1.f, gate résidence UE + ZDR, rétentions fermées, AIPD REQUISE —
  squelette : [legal/AIPD_VOIX_JARVIS_20260818.md](legal/AIPD_VOIX_JARVIS_20260818.md) ;
- `[TRANCHÉ FD-2026-0817-10]` canary : ordre U1→U6 sur compte fondateur + tenant démo ; claim
  « toute l'app » = événement fondateur après `universal_released`.

Valeurs fail-closed pour toute décision FUTURE encore manquante : l'action concernée reste `closed` avec un
`founderDecisionId` machine-readable et flags publics `OFF`. `screen_commit` n'est utilisable
qu'après définition des rôles, seuils, délégations, approbateurs et preuve de step-up ; il n'est pas
une valeur par défaut. Un connector absent produit un handoff uniquement si la surface manuelle a
la même limite ; signature -> aucun claim d'identité vérifiée ; facture -> préparation de brouillon
seulement si cette action est séparément classée et sûre ; relance -> unitaire confirmée ; fusion ->
fermée ; pré-compta -> lecture/preview. Aucune décision manquante n'est auto-autorisée par le modèle,
un écran ou une configuration locale.

Non-objectifs temporaires : autonomie sans confirmation, optimisation opportuniste de workflows,
langage de workflow générique, marketplace de plugins, compensation universelle, migration des
journaux historiques et claim marketing avant fermeture U7.

## 21. Definition of Done universelle

Le statut universel est le minimum des statuts de toutes les actions du
`PublicActionSurfaceManifest` au commit exact après filtrage déterministe par les faits de
configuration. `not_applicable` n'est pas un statut : c'est une exclusion documentée avant le
calcul, permise uniquement si la surface manuelle conditionnelle est elle-même indisponible pour le
tenant sous la même configuration. Il n'existe aucun « périmètre revendiqué » plus petit que ce
manifeste.

### 21.1 Gate `specified`

- [ ] Directive et canal/date fondateurs, ADR du moteur unique, manifeste de surfaces et catalogue
      concret sont committés et contre-signés.
- [ ] Chaque surface publique mappe exactement une fois ; `unclassified=0`, aliases/exclusions et
      configurations conditionnelles sont hashés.
- [ ] Chaque action du manifeste possède un contrat exact. Une action ouverte fixe use case,
      schémas, vérités, rôle, risque, confirmation, idempotence, recovery, version, écrans, SLO
      numériques et matrice de preuve. Une action `closed` fixe son refus wire/UI/voix, son motif,
      son identifiant de blocage et les conditions explicites de réouverture.
- [ ] Toute décision fondatrice manquante garde l'action `closed` avec ce contrat de refus binaire ;
      aucun défaut fonctionnel, fallback LLM ou absence de connector ne l'auto-autorise.
- [ ] Les définitions de run ferment états, transitions, bornes, versions et erreurs ; aucun DSL ou
      branche générée par le modèle.

### 21.2 Gate `implemented`

- [ ] Il n'existe qu'un `JarvisCommandGateway`, un catalogue, un ledger d'orchestration Jarvis, une
      policy de confirmation et un `JarvisReducer` racine ; les transitions de définition sont des
      branches pures sans moteur propre. Les registres métier d'idempotence restent purpose-specific
      sans dupliquer le ledger. Le code d'exécution `AgentRuntime`/`AgentMission` historique, les
      doubles journals/workers et les adapters de compatibilité ont été supprimés.
- [ ] Voix/toucher orchestrés, timers, workers, callbacks et reconciler entrent par le même gateway ;
      un test structurel échoue sur tout writer de run, event ou `signalAppliedAt` hors de sa
      transaction d'admission.
- [ ] Aucun code métier n'est dupliqué pour la voix : voix et toucher appellent le même port/use
      case/UoW ; AI, transport, binding et reducer n'importent aucun repository/provider concret.
- [ ] Le build cible contient zéro référence runtime à `AgentRuntime`, `AgentMission`,
      `RealtimeMistralConversationMission`, `buildBobActions`, `QuoteDraftSlot` et aux anciennes
      routes. Les mentions historiques ne subsistent que dans l'audit ; une archive conservée pour
      rétention est read-only, sans writer, trigger ni chemin runtime.
- [ ] Le graphe/build trouve zéro export mort, dépendance inutilisée, DTO/mapper/policy dupliqué,
      table/trigger/job/flag/env orphelin ou wrapper pass-through.
- [ ] Chaque action implémentée possède un caller réel, ses migrations, tests unitaires/contrats,
      PostgreSQL non-superuser, idempotence/recovery et mutation anti-faux-vert ; aucun module
      dormant ou table/fonction/flag orphelin.
- [ ] `JarvisRun` park/reprend sans lease Realtime et survit kill, logout, changement d'appareil,
      upgrade N -> N+1, rollback applicatif compatible et ancienne version de définition Jarvis
      encore référencée par un run vivant.
- [ ] Les confirmations one-shot, action de masse, cancel/authorize, lease fencing, timer, résultat
      avant signal et callbacks provider passent leurs courses fermées.
- [ ] Un work item `authorized` repris après expiration de lease réconcilie d'abord le même
      `effectId`; seuls un reçu existant, une absence d'effet autoritaire ou `outcome_unknown` sont
      admis, jamais un nouvel effectId ou un retry aveugle.
- [ ] Toutes les créations et effets sont idempotents ou réconciliables ; une capacité qui ne l'est
      pas reste `closed`.
- [ ] La commande inter-domaines complète s'arrête et reprend à chaque frontière sans effet aval,
      et Jarvis est techniquement incapable de signer à la place d'un tiers.
- [ ] Le train blue/green prouve zéro fenêtre à deux moteurs et termine avec tout scaffolding de
      migration supprimé.
- [ ] Le `LegacyEffectEvidenceManifest` couvre chaque ancien tool/caller et aucun effet ambigu ne
      traverse le cutover sans checkpoint d'observation immuable.

### 21.3 Gate `certified`

- [ ] Un `EvidenceManifest` complet lie chaque action/définition au commit, migrations,
      environnement, rôle DB, CI hosted, modèle, provider, appareils, fixtures, SLO et artefacts.
- [ ] Migrations N/N-1, RLS/ACL et replay sont verts sur Supabase staging avec deployer
      non-superuser ; la stratégie de retour distingue disable admission, rollback applicatif et
      forward repair des données irréversibles.
- [ ] Les preuves N/N-1 utilisent l'artefact précédent en environnement isolé ; elles n'autorisent
      jamais deux générations à admettre simultanément des commandes en production.
- [ ] E2E vrai modèle -> gateway -> use case -> PostgreSQL -> mobile -> provider passe pour voix et
      toucher sur iOS et Android physiques, avec oracles DB/API/artefact/outbox/provider.
- [ ] Crash/replay/concurrence, deux appareils, réseau dégradé, barge-in, provider inconnu,
      callback forgé/réordonné/cross-account et reprise longue passent aux seuils numériques.
- [ ] Accessibilité, confidentialité, rétention et captures logger/Sentry/traces prouvent zéro PII,
      audio, transcript, token ou corps de message non nécessaire.
- [ ] Communication, signature, recouvrement, facturation et RGPD ont un reçu de revue daté sur les
      sources/juridictions applicables.
- [ ] Une contre-revue exact-SHA clôt ses P0/P1 et les mutations prouvent que use case, policy,
      tenant guard, idempotence, écran réel et mapping provider sont discriminants.

### 21.4 Gate `released`

- [ ] Chaque canary production a utilisé une action `certified` sous permis éphémère exact, borné et
      révoqué/expiré après la preuve ; aucun canary ne crée un second moteur ou un statut durable.
- [ ] Pour chaque action de la population revendiquée : statut `released`, flag production actif,
      rôle/connector/dépendances sains, canary validé et smoke production exact.
- [ ] Admission, dispatch et observation ont métriques, alertes et kill switches opérationnels ;
      couper l'admission n'abandonne jamais la réconciliation d'un effet parti.
- [ ] Le commit exact est fusionné sur `main`, CI hosted verte, artefacts signés, staging validé et
      release manifest production archivé.
- [ ] `unclassified=0`, `closed=0`, ancien moteur=0 et compatibilité transitoire=0 pour le manifeste
      universel exact. `ancien moteur=0` signifie zéro code exécutable, route, registration DI,
      worker, cron, permission d'écriture, dépendance, export, flag, variable d'environnement ou
      adapter transitoire.
- [ ] Aucune documentation, réponse produit ou campagne ne dit « Jarvis fait toute l'app » avant
      `universal_released`; le claim reste borné aux cohorts/configurations réellement actives.

Les lots U1 à U6 peuvent être annoncés action par action avec leur statut exact. Ils ne réduisent
jamais les gates U7 et une action `certified` mais désactivée n'est pas une capacité livrée.
