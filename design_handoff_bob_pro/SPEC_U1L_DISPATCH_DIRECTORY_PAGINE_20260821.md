# SPEC U1-l — Annuaire de dispatch paginé, loué et équitable dans un tenant

- **Date** : 2026-08-21 · **Auteur** : GPT · **Statut normatif** : `implemented`.
- **Objectif primaire** : O4 — une mission confirmée continue jusqu'à un résultat, un abandon
  explicite ou une erreur récupérable ; une coordonnée fautive ne condamne pas les suivantes.
- **Contraintes** : O6/O7 — aucune progression inventée, protocole PostgreSQL reproductible,
  RLS/ACL et compatibilité N-1 prouvées.
- **Parents** : `OBJECTIFS_SPECS_DOD_PUBLICATION.md` O4/O6/O7,
  `SPEC_U1F_CHAINE_ARMEE_20260820.md` §1/§8 et règle permanente de pagination du dépôt.
- **Publication** : aucun flag, manifeste, entitlement ou statut d'action ne change. Le manifest
  Jarvis runtime reste fermé ; ce lot corrige une propriété de l'infrastructure dormante.

## 1. Défaut mesuré

Le worker demande une seule fois par tick :

```text
list_jarvis_dispatch_coordinates_v1(companyId, 25)
ORDER BY ownerUserId, runId
LIMIT 25
```

La fonction v1 est sans état. Elle repart donc toujours du même préfixe. Un résultat `succeeded`
dont le reçu métier reste inconstructible conserve `signalAppliedAt = NULL` et reste légitimement
dû. Vingt-cinq coordonnées de cette forme occupent chaque page ; une vingt-sixième coordonnée
valide n'est jamais présentée au worker. Le CAS des work items empêche certains doublons, mais ne
fournit aucune équité de découverte. L'action confirmée de la vingt-sixième mission peut rester
sans reçu indéfiniment.

La correction U1-f qui exclut `outcome_unknown` est nécessaire mais insuffisante : un succès
signalable dont la description ou l'admission échoue demeure une coordonnée due et valide. Le
filtrer de l'annuaire fabriquerait une fausse résolution ; le relire éternellement en tête affame
les autres.

## 2. Portée et non-objectifs

### Inclus

- une migration **append-only** ajoutant un curseur v2 par `companyId` ;
- un modèle Prisma `@@ignore` décrivant cette table technique sans ouvrir d'accès applicatif ;
- un index keyset additif sur `jarvis_work_items`, sans colonne, trigger ni forme de ligne neuve ;
- quatre opérations d'autorité v2 : réclamer une page, renouveler sa lease, marquer le démarrage
  de chaque tentative, puis acquitter la page ;
- l'adapter Prisma et le worker qui utilisent exclusivement v2 dans le binaire N ;
- la conservation de v1, byte-for-byte et exécutable par N-1 pendant l'expand ;
- les ACL/RLS, le provisionnement release et la certification PostgreSQL non-superuser ;
- les preuves de concurrence, reprise après expiration, cycle borné et non-famine.

### Hors lot

- la découverte et l'équité **entre sociétés**, qui restent celles de
  `ScheduledTenantDirectory`/`JOB_COMPANY_IDS` ; aucune équité globale n'est revendiquée ;
- les règles métier de claim, d'autorisation, d'exécution, de réconciliation ou de signal ;
- une mutation de migration historique, de `jarvis_work_items` ou de son vocabulaire ;
- tout nouveau flag, activation Jarvis, publication d'action ou changement mobile ;
- la réparation automatique d'un effet indécidable ou d'un reçu inconstructible.

## 3. Autorité et état minimal

Une table `jarvis_dispatch_directory_cursors` contient au plus une ligne technique par société.
Elle ne contient aucune charge métier : seulement `companyId`, le dernier couple keyset acquitté,
la borne haute et l'heure de coupure du cycle, la page pending, `claimId`, `claimExpiresAt`, une
échéance dure non renouvelable, la prochaine position à démarrer et une révision monotone.

La page pending persiste deux tableaux de même cardinalité, bornés au plafond SQL :
`ownerUserIds[]` et `runIds[]`. Ce sont les seules coordonnées que l'autorité v1 exposait déjà.
`ownerUserId` reste un identifiant personnel pseudonyme : la page est bornée à 50 couples, n'est
jamais copiée dans un cache persistant ni un log applicatif et hérite de la classification de sa
source. Elle est effacée seulement par ACK ou cascade société ; après expiration/crash, elle
persiste volontairement jusqu'à un ACK ultérieur afin de garantir la redelivery exacte,
potentiellement sans TTL autonome.

La table possède une FK vers `companies(id)` avec `ON UPDATE CASCADE ON DELETE CASCADE`, puis
`ENABLE ROW LEVEL SECURITY` + `FORCE ROW LEVEL SECURITY`. Les policies `SELECT`, `INSERT` et
`UPDATE` n'acceptent que `current_user = 'bob_jarvis_dispatch_directory'` ; aucune policy `DELETE`
n'est ouverte. Le rôle d'autorité reste `NOLOGIN`, `NOSUPERUSER`, `NOBYPASSRLS`, sans membre
runtime ni héritage implicite. L'adhésion éventuelle du déployeur est `SET`-only, issue de
`createrole_self_grant=set`, contrôlée par le rituel puis inutilisable par le rôle applicatif.

Le rôle applicatif n'obtient **aucun** privilège de table : seulement `EXECUTE` sur v1 et les quatre
fonctions v2. `PUBLIC`, `anon`, `authenticated` et `service_role` sont révoqués explicitement.
L'autorité reçoit `SELECT/INSERT/UPDATE` sur le seul curseur. Son grant source est exact :
`companyId`, `ownerUserId`, `runId`, `status`, `nextAttemptAt`, `leaseExpiresAt`, `authorizedAt`,
`authorizationDigest`, `resultDigest`, `signalAppliedAt`, `updatedAt`. `payloadRef`,
`authorizationSource`, `submittedJobRef` et `targetDigest` restent explicitement inatteignables ;
l'index ne crée aucun droit.

Les CHECK de la table sont fermés : tableaux non nuls ; lorsqu'ils sont non vides, ils sont
unidimensionnels, de borne basse 1, de dimensions identiques, de même cardinalité, sans élément
nul et bornés entre 1 et 50 ; les tableaux vides canoniques restent valides dans l'état idle ; tuples
`after`, `upper` et `pendingAfter` entièrement nuls ou présents ; `after < upper` tant qu'un cycle
intermédiaire subsiste et `after < pendingAfter <= upper` sous la même collation ; coupure présente
si et seulement si la borne haute l'est ; `claimId/claimExpiresAt/claimHardExpiresAt`,
`pendingHasMore/pendingAfter/pendingNextPosition` présents si et seulement si une page pending
existe ; `1 <= pendingNextPosition <= cardinality + 1` ; le dernier élément pending est
`pendingAfter` ; `claimExpiresAt <= claimHardExpiresAt` ; tout `upper` possède soit une page pending soit un `after`, et tout `after` ou
pending possède un `upper` ; `revision >= 0`. Les comparaisons/tails sont enveloppés dans des
prédicats qui rendent `FALSE`, jamais `UNKNOWN`, sur une forme incohérente. La différence de token
lors d'une reprise expirée est une garde 22023 de la fonction `claim` sous verrou — pas un CHECK
historique que la ligne ne pourrait pas exprimer.
`pendingHasMore IS TRUE` impose en plus `pendingAfter < upper` dès l'écriture de la page ; une
corruption `hasMore=true, tail=upper` est refusée immédiatement, pas découverte lors de l'ACK.
Les trois horodatages techniques sont finis : aucune coupure ou échéance `infinity/-infinity` ne
peut rendre un cycle ou un claim immortel.

## 4. Protocole v2 normatif

### 4.1 Réclamer une page

Le contrat SQL exact est :

```text
claim_jarvis_dispatch_coordinates_v2(text, integer, uuid)
RETURNS TABLE(status text, companyId text, claimId uuid, position integer,
              pageSize integer, ownerUserId text, runId uuid, hasMore boolean,
              replayed boolean, databaseNow timestamptz, claimHardExpiresAt timestamptz)
renew_jarvis_dispatch_coordinates_claim_v2(text, uuid) RETURNS boolean
start_jarvis_dispatch_coordinate_v2(text, uuid, integer) RETURNS boolean
ack_jarvis_dispatch_coordinates_v2(text, uuid) RETURNS boolean
```

`claim_jarvis_dispatch_coordinates_v2` rend un statut SQL fermé
`claimed | ack_ready | empty | busy`. Une erreur SQL lève et devient `unavailable` dans l'adapter ;
elle n'est jamais rabattue sur un statut fonctionnel. Pour `claimed`, chaque ligne porte une
position contiguë `pendingNextPosition..pageSize`, le même `pageSize`, le même `claimId` égal au
token demandé, les mêmes `hasMore`, `replayed`, `databaseNow` et `claimHardExpiresAt`, puis une coordonnée non
nulle. Une page fraîche porte `replayed = false` et commence en position 1 ; seule la redelivery
d'une page pending expirée porte `true`, ce qui autorise l'adapter à accepter une ancienne page
plus grande que la nouvelle borne demandée et à reprendre son suffixe exact. `ack_ready` signifie
que toutes les positions ont déjà été démarrées par un détenteur antérieur : une ligne de contrôle
porte le nouveau claim, `pageSize`, `hasMore`, `replayed=true`, l'heure base et l'échéance dure, mais
aucune coordonnée. Chaque statut porte `status` et `companyId` demandé non nuls. Pour
`claimed`, tous les autres champs sont non nuls ; pour `ack_ready`, seuls
`position/ownerUserId/runId` sont nuls ; `empty|busy` portent exactement une ligne de contrôle avec
tous les autres champs de page et de claim nuls : le token d'un claim vivant n'est jamais révélé :

1. refuse l'identité, la société, la borne ou le UUID invalides avant toute lecture ;
2. crée paresseusement puis verrouille `FOR UPDATE` le curseur de cette société ;
3. capture immédiatement et une seule fois `operationNow = clock_timestamp()` après le verrou ;
   si un claim court et dur non expiré existe, ne rend aucune page ;
4. si un claim a expiré ou atteint son échéance dure, exige un token neuf, remplace seulement son
   identité et écrit explicitement `claimExpiresAt = operationNow + 30 secondes`,
   `claimHardExpiresAt = operationNow + 5 minutes`, puis redélivre **exactement** le suffixe non
   démarré de la page pending ; aucun curseur de cycle n'avance ;
5. au début d'un cycle, cette même `operationNow` devient la coupure base avant de calculer le maximum
   `(ownerUserId, runId)` actuellement dû ;
6. lit `limit + 1` coordonnées distinctes, ordonnées sous collation `C`, avec un keyset
   strictement supérieur au couple acquitté, inférieur ou égal à la borne haute, et dues à
   l'heure de coupure ;
7. persiste la page sélectionnée, son dernier couple, `hasMore`, `pendingNextPosition = 1`, le
   `claimId`, une lease de 30 secondes et une échéance dure de 5 minutes, puis retourne les
   coordonnées dans l'ordre ;
8. si aucun candidat ne subsiste, ferme le cycle sans inventer d'ACK et rend une page absente.

Le prédicat « dû à la coupure » est réutilisé mot pour mot pour le calcul de la borne haute et la
page. **Toutes** ses branches exigent `updatedAt <= cycleCutoffAt` ; une insertion ou transition
horodatée après la coupure attend donc le cycle suivant, même si sa clé tombe entre le curseur et
la borne :

- `prepared|retry_due` avec `nextAttemptAt` absent ou antérieur/égal à la coupure ;
- `leased` avec lease non nulle strictement expirée à la coupure ; cette migration repince aussi
  la policy U1-f de `<=` vers `<` pour refléter exactement `claimDue` ;
- `authorized` avec lease non nulle strictement expirée à la coupure et `resultDigest IS NULL` ;
- `succeeded|failed_terminal|cancelled` signalable, avec résultat non nul, signal absent et les
  mêmes formes d'autorisation cohérentes que la policy U1-f ; sa mutation doit être antérieure ou
  égale à la coupure.

La policy RLS U1-f reste une pré-borne conservative évaluée avec le `statement_timestamp()` de
l'appel. Une ligne qui devient due pendant l'attente du verrou peut donc rester invisible malgré
un `operationNow` postérieur : la fonction ne contourne jamais cette policy et la coordonnée attend
le cycle/appel suivant. En revanche, le cutoff explicite empêche toujours d'admettre une mutation
horodatée après lui. Une coordonnée réglée entre-temps peut disparaître sans danger : le repository
reste l'autorité de son état. Une page déjà persistée est redélivrée depuis ses tableaux sans
re-filtrer `updatedAt` : c'est la condition de sa reprise exacte.

Un index partiel additif ordonne les statuts potentiellement dus par
`(companyId, ownerUserId COLLATE "C", runId)`. Les colonnes owner du curseur et les comparaisons
`after/upper/pendingAfter` utilisent toutes explicitement `COLLATE "C"`. Son prédicat statique
inclut les états non terminaux traitables et uniquement les formes terminales non
signalées/cohérentes. La fonction peut ainsi faire le keyset sans trier tout l'historique. La
certification exige l'index `indisvalid`, `indisready`, owner/collation/clés/prédicat exacts ; aucun
claim d'IO strictement `limit + 1` n'est fait sans plan PostgreSQL observé.

Une preuve table-driven couvre les neuf statuts et les frontières de chaque colonne :
`nextAttemptAt` nul/< /=/>, `leaseExpiresAt` nul/< /=/>, forme terminale avec digest/signal et
autorisation cohérente/incohérente, puis `updatedAt` < /=/> coupure. `outcome_unknown` et
`cancelling` sont toujours exclus. Cette même matrice vérifie les formes structurelles de la policy,
du prédicat de la fonction et du prédicat statique de l'index ; l'asymétrie temporelle conservative
de la policy fait l'objet du test de verrou/relecture séparé. Aucun des trois ne dérive
silencieusement.

Chaque fonction capture **une seule fois**, après son `SELECT ... FOR UPDATE`, un
`operationNow = clock_timestamp()`. Cette valeur est l'horloge normative des tests d'expiration,
des nouvelles échéances, du cutoff et de `databaseNow`. `statement_timestamp()` est interdit pour
ces décisions internes au curseur : un appel commencé avant la borne mais débloqué après ne doit pas
conserver une ancienne heure. La pré-borne RLS conservative décrite ci-dessus reste volontairement
plus ancienne et peut seulement reporter une coordonnée au prochain appel. Une page pending expirée
est redélivrée sans appliquer la nouvelle borne demandée, sous le seul plafond absolu 50.

### 4.2 Renouveler et démarrer une tentative

`renew_jarvis_dispatch_coordinates_claim_v2(companyId, claimId)` prolonge la lease de 30 secondes
si le même token est encore inscrit, même si son échéance courte vient de passer, mais **jamais**
au-delà de `claimHardExpiresAt`. L'expiration courte rend la page volable sans révoquer
magiquement son détenteur : le verrou `FOR UPDATE` tranche l'ordre. L'échéance dure rend en
revanche renew faux même sans repreneur. Si un nouveau claim a déjà remplacé le token, renew rend
également faux.

`start_jarvis_dispatch_coordinate_v2(companyId, claimId, position)` crée un **slot de tentative
durable**, distinct d'un succès, d'une tentative achevée et de l'ACK. Sous `FOR UPDATE`, il exige le
token courant, une échéance dure vivante et `position = pendingNextPosition`, puis incrémente
atomiquement `pendingNextPosition` et renouvelle la lease courte avec
`LEAST(operationNow + 30 secondes, claimHardExpiresAt)`. Comme renew, une lease courte
expirée reste récupérable si aucun repreneur n'a encore remplacé le token ; le verrou tranche. Le
worker appelle start immédiatement **avant** d'invoquer le handler de cette coordonnée. Un crash
dans cette fenêtre peut reporter cette coordonnée au cycle suivant, mais ne marque aucun work item
comme résolu : sa vérité reste due et elle sera redécouverte. Ce compromis fermé empêche un handler
qui ne termine jamais de monopoliser le suffixe de la page.
La garde exige aussi `position <= cardinality(pendingOwnerUserIds)` : une page entièrement
checkpointée rend false pour `start(pageSize + 1)` sans tenter une écriture qui violerait le CHECK.

Le worker renouvelle puis checkpoint la position avant chaque coordonnée, et maintient un heartbeat
sérialisé au plus toutes les 10 secondes pendant sa tentative. Il arrête et attend le heartbeat
avant toute coordonnée suivante ou ACK. Un renew/checkpoint faux ou indisponible marque le claim
perdu : aucune coordonnée suivante n'est démarrée et aucun ACK n'est émis par cet ancien détenteur.
L'échéance dure n'est jamais étendue. Si le handler ne termine pas, un tick ultérieur reprend le
suffixe après cinq minutes ; l'ancien handler peut finir tardivement, mais ses CAS/fences de work
item restent l'autorité et son ancien token ne peut ni démarrer la suite ni ACK. Le handler pendant
reste un incident observable et peut conserver ses propres ressources ; il ne conserve plus la
page ni le tenant. À chaque nouveau cycle il peut être retenté tant que sa source reste due : aucun
succès ou acquittement métier n'est inventé.

La `databaseNow` retournée avec le claim permet à l'adapter de calculer un budget monotone commun à
toute la page (`claimHardExpiresAt - databaseNow`), diminué du temps de requête et d'une marge de
sécurité. Chaque handler est attendu via `Promise.race` avec ce watchdog ; à son expiration, le
worker arrête/attend le heartbeat, attache un sink à toute résolution/rejection tardive, fige son
résumé local et rend la main. Le watchdog n'annule ni ne résout l'effet : il borne seulement la
mémoire de contrôle et permet au prochain tick de reprendre après l'échéance base. Une fin tardive
peut encore agir uniquement via les CAS/fences métier existants et ne modifie jamais le résumé ou
le curseur déjà rendu.
Tous les timers watchdog/heartbeat sont `unref`. Le service implémente `OnApplicationShutdown` : il
pose `stopping`, interdit tout claim/start neuf, déclenche la sortie des watchdogs de contrôle sans
prétendre annuler les handlers, stoppe puis attend les heartbeats en cours, attache leurs sinks et
rend la main sous une grâce bornée. Une page interrompue n'est jamais ACKée ; la reprise durable
reste dans le curseur.

### 4.3 Acquitter

`ack_jarvis_dispatch_coordinates_v2(companyId, claimId)` réussit uniquement si le même token est
encore inscrit et si `pendingNextPosition = pageSize + 1`, sans condition d'échéance. Comme
renew/start, son `FOR UPDATE` sérialise ACK et reprise : si l'ancien ACK gagne avant la reprise, il
peut avancer une page dont toutes les positions ont déjà reçu un slot ; si le repreneur a remplacé
le token, l'ancien ACK rend faux. Le worker courant l'appelle après le retour de tous ses
handlers ; un repreneur recevant `ack_ready` peut l'appeler immédiatement parce que chaque position
a déjà été démarrée durablement. Succès, résultat encore dû, exception capturée et handler ancien
encore pendant comptent tous comme une tentative démarrée ; aucun ne vaut résolution métier. Une
panne globale, une perte de token ou une position jamais checkpointée interdisent l'ACK.

L'ACK :

- avance le keyset au dernier couple pending lorsque `hasMore = true` ;
- ferme et remet à zéro la borne/coupure lorsque `hasMore = false` ;
- efface toujours la page pending et le claim ;
- ne modifie jamais un work item et ne prétend jamais qu'un effet ou un signal est réglé.

Ainsi, une coordonnée fautive reste due mais n'immobilise pas le cycle. Elle est redécouverte au
cycle suivant, après que toutes les coordonnées déjà bornées ont eu leur tour. Les arrivées
continues ne prolongent pas le cycle grâce au couple borne haute + coupure figés.

**Borne de liveness** : sous exécutions répétées du scheduler et disponibilité éventuelle de la
base/renew/start/ACK ainsi que d'une place dans la registry, toute coordonnée d'un cycle figé de `N` coordonnées qui reste due sous la
policy jusqu'au passage de son keyset est démarrée dans `ceil(N / limit)` pages ACKées, chacune
nécessitant au plus 50 slots et au plus 50 fenêtres dures si chaque handler précédent reste pendant.
Une coordonnée devenue non
due a été réglée par l'autorité source, elle n'est pas affamée. Un handler pendant reste dû et sera
redécouvert au cycle suivant, mais ne bloque plus les positions suivantes. Une panne permanente ou
l'absence de découverte du tenant restent hors garantie et sont des incidents nommés, jamais un
succès. Aucun claim d'équité inter-tenant n'en découle.

## 5. Intégration worker et erreurs

Chaque `claim`, `renew`, `start` et `ack` ouvre sa **propre** transaction globale courte via
`withIsolatedGlobal`, puis la termine avant tout travail externe. Dans la transaction, l'adapter
pose et relit `statement_timeout`/`lock_timeout` dans une instruction distincte avant d'appeler la
fonction. Aucun verrou de curseur ni transaction Prisma ne traverse une coordonnée ou un heartbeat.
Le `proconfig` de la fonction ne suffit pas à borner l'attente du statement appelant.
L'adapter refuse un UUID lexicalement malformé avant SQL ; un cast SQL direct malformé rend 22P02
avant l'entrée dans la fonction. Les quatre fonctions refusent par 22023, avant toute lecture, un
`companyId` invalide et un UUID `NULL` ou nil pourtant bien typé ; claim refuse aussi toute limite
hors 1..50, et start toute position hors 1..50. Avec des identités valides, un token stale, une
position différente de `pendingNextPosition` ou une page absente rend simplement `false` pour
renew/start/ACK : aucune erreur de forme n'est confondue avec une course.

Le port ne propose plus une liste stateless au binaire N. Il expose les unions fermées
`claimed | ack_ready | empty | busy | unavailable` et quatre gestes explicites : `claim`, `renew`,
`start`, `ack`.
`busy` n'est ni « rien à faire » ni une panne. Une page n'a qu'un `claimId` canonique ; toute ligne
retournée doit appartenir à la société demandée, respecter la forme des identifiants, être unique,
ordonnée et rester sous le plafond absolu 50. Une nouvelle page respecte la borne demandée ; une
page pending immuable créée avant un downgrade 50 → 25 peut être redélivrée au-delà de la nouvelle
borne, mais jamais au-delà de 50. L'adapter valide les positions SQL contiguës et l'ordre avec les
octets UTF-8 (`Buffer.compare`) pour `ownerUserId`, puis l'ordre canonique UUID ; jamais avec
`localeCompare`. Un suffixe `claimed` finit obligatoirement à `pageSize`; `databaseNow` et
`claimHardExpiresAt` sont des dates finies, homogènes, avec un delta strictement positif et au plus
égal aux cinq minutes normatives. `ack_ready` exige `pageSize` entre 1 et 50, `replayed=true`, zéro
coordonnée et les mêmes métadonnées temporelles fermées. Toute autre dérive rejette la page entière.

Le worker conserve l'ordre U1-f pour chaque coordonnée : redelivery, réconciliation autorisée,
puis seulement nouveau claim si le master dispatch est ouvert. Les exceptions restent isolées à
la coordonnée et incrémentent `failures`. Le worker poursuit la page, renouvelle/checkpoint avant
la suivante, puis ACK après la dernière tentative. Une erreur de claim/renew/start/ACK est visible
et n'est jamais traduite en page vide ou en progrès.

Le résumé expose aussi un compteur `busy` : un claim détenu par un autre replica reste observable
et n'est jamais confondu avec un tenant vide, même lorsque tous les autres compteurs valent zéro.

Une registry process-locale, bornée à 50 coordonnées et jamais exportée, pose une réservation
sentinelle synchronique par clé digest opaque de `(companyId, ownerUserId, runId)` **avant start**,
puis la remplace par la `trackedPromise` avant
l'invocation asynchrone du handler. Promise normale et Promise ayant dépassé le watchdog restent
toutes deux inscrites jusqu'à leur propre `finally`. Tant qu'une même coordonnée y reste pending,
un cycle ultérieur peut checkpoint son nouveau slot — déjà adossé à cette tentative réellement
démarrée — sans lancer un second handler dans ce process. Pour une coordonnée nouvelle lorsque les
50 places sont occupées, le worker ne fait ni start, ni handler, ni ACK : il rend une surcharge
visible et laisse la page au prochain tick. Le retrait en `finally` est gardé par l'identité exacte
de la Promise suivie (`map.get(key) === trackedPromise`) ; un throw synchrone libère la sentinelle et
sa rejection tardive est absorbée. Cette borne ne prétend pas annuler l'I/O ni dédupliquer entre
replicas : les CAS/fences métier restent l'autorité, mais la mémoire de contrôle d'un process ne
croît jamais avec les cycles. Jusqu'à 50 Promises et leurs closures peuvent persister jusqu'à leur
`finally` ou au redémarrage du process ; elles ne sont ni sérialisées ni loggées, et la clé de
registry ne duplique aucune coordonnée brute.

La sous-page interne `listPendingSignals(..., 25)` n'est pas une seconde promesse d'équité : les
deux définitions U1 ont `maxOpenWorkItems = 1`, donc une coordonnée canonique ne peut pas accumuler
25 signaux indépendants. Toute future définition augmentant cette borne reste non publiable tant
qu'une pagination level-triggered interne n'est pas spécifiée et prouvée.

Deux replicas ne traitent normalement pas le même suffixe : le curseur le loue atomiquement. Après
expiration, le suffixe non démarré est repris ; les fences et CAS existants sur les work items
arbitrent toute tentative tardive. Un ancien `claimId` ne peut ni renouveler, ni checkpoint, ni
acquitter le nouveau claim.

## 6. Expand, N-1 et cutover

- La migration crée la table curseur, l'index keyset additif et les fonctions v2 ; v1 reste intacte
  et aucune colonne, contrainte, trigger ou forme de writer ne change sur `jarvis_work_items`. Un
  writer/worker N-1 continue donc de compiler et d'appeler v1 après l'expand.
- `rls.sql` rejoue `FORCE RLS`, les trois policies curseur et les révocations Data API avant le
  provisionnement ; il ne crée aucun droit runtime direct.
- Le provisionnement configure v1 et les quatre fonctions v2 dans une transaction, avec propriétaires, options de
  sécurité, ACL de fonctions et grants de table/colonnes exacts. Le même rôle applicatif conserve
  `EXECUTE` v1 pour N-1 et reçoit v2 ; seul le code N interdit le fallback v1.
- Le binaire N n'a aucun fallback vers v1 : l'absence de v2 rend l'annuaire indisponible et le
  tick échoue honnêtement.
- Le cutover froid U1-f reste obligatoire avant de servir N. Cette migration ne rend pas une
  flotte mixte publiable et ne répare pas les défauts de vérité de N-1.
- Un rollback applicatif vers N-1 reste possible tant que v1 subsiste ; la table v2 inutilisée est
  additive. Sa suppression éventuelle est un train séparé, jamais le rollback de ce lot.

## 7. Acceptation binaire

### Tests unitaires worker/adapteur

- 25 coordonnées fautives sont toutes tentées ; l'ACK est appelé une fois malgré leurs échecs ;
- une coordonnée valide d'une page suivante est tentée au tick suivant ;
- perte/exception de renew ou start avant une coordonnée : arrêt immédiat, zéro ACK ;
- tentative supérieure à 30 secondes : heartbeat conserve le claim ; perte du heartbeat pendant
  la tentative : zéro coordonnée suivante et zéro ACK ; aucun timer ne survit au retour ;
- handler qui ne termine pas : l'échéance dure n'est pas renouvelée ; un tick repreneur obtient le
  suffixe à la position suivante et atteint la 26e coordonnée ; l'ancien token ne start/ACK plus ;
- failpoint après `start(k)` et avant le handler : suffixe repris à `k+1`, zéro résultat/signal
  inventé, puis `k` réapparaît au cycle suivant ;
- watchdog : le retour fige le résumé, attend/éteint tous ses timers et absorbe une rejection
  tardive ; une résolution tardive ne touche ni résumé ni curseur et reste arbitrée par les CAS ;
- shutdown pendant handler/renew : `stopping` interdit claim/start neuf, watchdogs et heartbeats
  `unref` sont arrêtés/attendus sous grâce bornée, zéro ACK de page incomplète, puis toute rejection
  tardive reste absorbée sans garder l'event loop ;
- registry late-in-flight : une Promise pendante n'est lancée qu'une fois par coordonnée/process ;
  un slot répété pour cette même coordonnée progresse sans doublon local ; à 50 coordonnées
  distinctes pendantes, une coordonnée nouvelle n'est ni startée ni ACKée et la surcharge est
  visible jusqu'au `finally` qui libère une place ;
- takeover concurrent exactement au déclenchement du watchdog : l'inscription préalable reste
  visible, aucun doublon local n'est lancé, puis seul le `finally` de la Promise exacte retire la clé ;
- handler qui throw synchroniquement : la Promise préinscrite absorbe l'erreur, son `finally`
  identity-safe retire la clé, la page continue et aucun unhandled rejection ne survit ;
- registry inspectée : au plus 50 entrées, clés digest opaques, aucune coordonnée brute dans la clé
  ou les logs ; les closures sont libérées au `finally` ou par redémarrage process ;
- dernière position déjà démarrée puis expiration : reprise `ack_ready`, ACK valide avec le nouveau
  token ; ACK avant `pendingNextPosition = pageSize + 1` ou après remplacement du token est faux ;
- page de taille 1 : `start(1)=true`, puis `start(2)=false` sans mutation (`next` reste 2), et ACK
  courant réussit ;
- exception non capturée/arrêt avant fin : zéro ACK ; ACK faux ou indisponible : échec visible ;
- kill switch fermé : redelivery/réconciliation de toute la page restent tentées, aucun nouveau
  work item n'est claimé, puis la page est acquittée ;
- page malformée, dupliquée, désordonnée, hors tenant ou au-delà du plafond 50 : rejet total ;
- une page pending de 50 reste redélivrable après un appel abaissé à 25 ; une page neuve respecte
  25 grâce au marqueur `replayed` homogène ;
- `busy`, `empty`, `ack_ready` et `unavailable` restent quatre issues distinctes ; positions non contiguës ou
  claim/`hasMore`/`replayed` substitué, mélange contrôle/coordonnée ou champ nul : rejet ;
- dates claim non finies/hétérogènes, delta dur nul ou supérieur à cinq minutes, suffixe ne finissant
  pas à `pageSize`, `ack_ready` non rejoué ou portant une coordonnée : rejet total ;
- ordre C discriminant : `z` puis `é` est accepté, l'inverse est rejeté ;
- page absente : zéro renew/start/ACK.

### Certification PostgreSQL réelle

- rôle runtime `NOSUPERUSER/NOBYPASSRLS`, tables source en `FORCE RLS` ;
- mesure rouge v1 : deux appels successifs avec 25 vrais succès inconstructibles rendent le même
  préfixe et manquent tous deux la 26e coordonnée, sans résoudre artificiellement la page 1 ;
- page 1 de taille runtime 25, ACK, puis page 2 contenant la 26e coordonnée ;
- avec `N = 2 * limit + 1`, trois pages acquittées tentent les `N` coordonnées malgré des fautifs
  persistants ; ceux-ci sont redécouverts au cycle suivant ;
- 25 signaux durablement inconstructibles restent dus, mais le worker atteint et applique le
  26e signal valide en au plus deux pages ; aucun faux `signalAppliedAt` sur les 25 ;
- claim concurrent vivant : un seul gagnant ; expiration sans repreneur : ancien renew/ACK reste
  possible avant l'échéance dure ; après reprise : suffixe exact, nouveau claim et ancien
  renew/start/ACK faux ;
- après échéance dure sans repreneur : renew/start faux, mais ACK vrai si et seulement si le token
  reste courant et `pendingNextPosition = pageSize + 1` ; après takeover, les trois gestes de
  l'ancien token sont faux ;
- appel start/renew lancé avant la borne mais bloqué sur le verrou jusqu'après celle-ci : faux avec
  l'unique `clock_timestamp()` capturé après lock ; aucun `statement_timestamp()` périmé ;
- claim lancé avant qu'une ligne devienne due puis débloqué après : la policy conservative peut
  l'omettre sans faux `empty` durable ; l'appel/cycle suivant la présente et la traite ;
- handler pendant en position 1 : après échéance dure, le repreneur reçoit les positions 2..N,
  les démarre puis ACK ; le handler 1 reste dû et revient au cycle suivant sans bloquer N ;
- sans ACK, le suffixe non démarré est redélivré ; ACK seulement après un slot durable pour chaque
  position, puis retour des handlers du détenteur courant ou reprise `ack_ready` ;
- arrivée avant/après le keyset pendant un cycle et coordonnée devenue due après la coupure :
  aucune extension du cycle, toutes réapparaissent au cycle suivant ;
- après ACK page 1, un nouveau `prepared` dont la clé tombe avant la borne haute n'entre pas dans
  le cycle figé ; le writer N-1 prouve que toute insertion ou mutation qui rend/maintient une
  branche due pose `updatedAt` à l'horloge base, jamais antidatée ; une mutation qui règle la ligne
  peut seulement la faire disparaître ;
- transaction commencée avant la coupure et commitée après avec un `updatedAt` base antérieur : la
  borne keyset reste finie et la coordonnée n'est jamais perdue ; selon sa clé/visibilité, elle
  rejoint le cycle courant ou le suivant, sans claim de snapshot MVCC entre les pages ;
- dernier ACK : une coordonnée toujours fautive est redécouverte au cycle suivant ;
- ACK et cascade société effacent la page pseudonyme ; sans ACK elle reste bornée et rejouable,
  sans cache/log local ;
- deux sociétés réclament/ACKent indépendamment ; société voisine invisible ; suppression société
  cascade le curseur ;
- société A en timeout/claim indisponible ou ACK en échec : société B est néanmoins appelée, tente
  toute sa page et ACK ; le résumé conserve l'échec A sans revendiquer l'équité de découverte ;
- N-1 v1 rend encore une page après migration v2 ; aucun trigger ni nouvelle exigence de ligne ne
  casse un writer N-1 ;
- company/UUID NULL ou nil/limite/position invalides refusés 22023 avant lecture ; UUID lexical
  malformé refusé par l'adapter sans SQL et par cast direct en 22P02 ; token stale ou position valide
  mais non prochaine rendent faux ; timeouts effectifs vérifiés ;
- contraintes atomiques invalides, tableaux avec NULL/cardinalités/tail incohérents, dimensions
  multiples ou borne basse 0 non vides, échéance/coupure infinie, et même token de reprise sont
  refusés par PostgreSQL ; les tableaux idle vides canoniques restent acceptés ;
- page `hasMore=true` dont le tail égale la borne haute : refus 23514 à l'écriture, jamais blocage
  différé au moment de l'ACK ;
- ACL exactes : app `EXECUTE` v1+v2, zéro table ; Data API/PUBLIC sans EXECUTE ; autorité sans
  payload ; fonction owner/SECURITY DEFINER/search_path/row_security/timeouts conformes ;
- verrou de curseur détenu au-delà de `lock_timeout` : appel indisponible/55P03, jamais page vide ;
- release rejouée idempotemment sur un rôle non-superuser ; SQL testé sur le profil PostgreSQL 17
  et sur Supabase staging avant toute promotion.

## 8. Definition of Done

- [x] Spec contre-relue, P0/P1 à zéro sur le protocole figé.
- [x] Migration append-only + modèle `@@ignore` + index keyset + v2 + RLS/ACL/release livrés, sans
      toucher v1 ni ajouter de colonne, statut, trigger ou nouvelle forme de writer à
      `jarvis_work_items`.
- [x] Worker/adapteur v2 sans fallback stateless ; chaque position possède un slot durable avant
      ACK, et un handler pendant ne bloque pas le suffixe après l'échéance dure.
- [x] Tests unitaires et PostgreSQL ci-dessus verts, avec mesure rouge reproduisant la famine v1.
- [x] Typechecks API, lint ciblé, migration safety, release safety et rituel AgentMission verts.
- [ ] Preuve Supabase staging non-superuser attachée au SHA exact.
- [x] Revue adversariale finale P0/P1 à zéro ; statut au plus `implemented` avant la preuve staging.
- [x] Aucun artefact temporaire de build/cluster conservé après validation ; nettoyage limité aux
      chemins régénérables explicitement vérifiés.
- [x] Aucun flag ouvert, aucun manifest positif, aucun déploiement ni claim d'équité inter-tenant.
