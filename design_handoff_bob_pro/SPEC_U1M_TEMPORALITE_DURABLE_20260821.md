# SPEC U1-m — Réveils Jarvis durables, sans faux effet ni expiration inventée

- **Date** : 2026-08-21
- **Auteur / writer** : Codex, après audits domaine, PostgreSQL, runtime et mobile en lecture seule.
- **Statut normatif** : `specified`. Aucun code de ce lot n'est encore `implemented`, `certified`
  ou `released`.
- **Parents** :
  [OBJECTIFS_SPECS_DOD_PUBLICATION](OBJECTIFS_SPECS_DOD_PUBLICATION.md) O4/O6/O7,
  [SPEC_JARVIS_UNIVERSEL_ORCHESTRATION](SPEC_JARVIS_UNIVERSEL_ORCHESTRATION_20260817.md)
  §5.1/§5.2/§5.6/§17.1 et
  [SPEC_U1H](SPEC_U1H_PARITE_TACTILE_ET_CONVERGENCE_20260820.md) §6.
- **Objet du premier vertical** : rendre exécutoires les `wake_run` déjà définis par
  `single_business_action@1` et `customer_contact@1`, par l'horloge PostgreSQL et le gateway
  unique, avec pagination durable, idempotence et reprise après panne.
- **Décision de périmètre** : `idleExpiresAt` et `hardExpiresAt` ne sont **pas** maquillés en
  `wake_run`. Leur consommation est un lot de cycle de vie distinct, nommé ici **U1-n**, qui doit
  définir une sémantique versionnée par phase avant tout scanner.

## 0. Pourquoi ce découpage est une exigence de vérité

Le parent §5.1 dit déjà la bonne loi : `nextWakeAt` n'est qu'un index ; le réveil stable vit dans
le state et un scanner fondé sur l'heure PostgreSQL soumet une commande idempotente au gateway.
Aujourd'hui cette commande existe dans les deux définitions U1, mais aucun émetteur ne la produit.

Les deux autres timestamps ont une nature différente :

- `idleExpiresAt` est rafraîchi à chaque transition réellement commitée et clampé sur la borne
  dure ;
- `hardExpiresAt` est une borne de vie du run, immuable après le semis ;
- aucun `JarvisRunEnvelope` U1 ne transporte ces deux champs ;
- aucune définition U1 v1 n'accepte une commande de cycle de vie ni ne possède une raison
  terminale correspondante ;
- après autorisation d'un effet, terminer brutalement le run pourrait masquer un effet déjà parti
  et empêcher sa réconciliation.

Émettre un `wake_run` v1 est donc un câblage d'une sémantique existante. Consommer idle/hard ajoute
des commandes, événements, raisons terminales et règles post-autorisation : la voie normale est
`customer_contact@2` et `single_business_action@2`, avec conservation des références v1. Une
mutation de v1 ne serait permise qu'après preuve SQL, dans **chaque** environnement cible, de zéro
run et zéro work item v1 vivant, plus décision explicite pré-publication. Le manifest runtime
fermé n'est pas cette preuve.

## 1. Baseline mesurée — les défauts que le lot doit réellement casser

### 1.1 Le réveil est un vocabulaire sans émetteur

Les reducers savent traiter `wake_run`, et le state porte un `wakeId` stable avec une échéance.
`nextWakeAt` projette le minimum. Pourtant `JarvisModule` ne câble que l'admission, le dispatch et
la purge de payload ; aucun cron ne découvre les runs dus.

Conséquence : une proposition expirée reste visuellement et durablement en attente jusqu'à ce
qu'une autre commande provoque paresseusement sa revalidation. O4 n'est pas tenu.

### 1.2 L'enveloppe système actuelle signifie uniquement « observation d'effet »

`JarvisSystemAdmissionEnvelope` exige `effectId` UUID et `observationKind` ; son commandId est
dérivé de `(runId, effectId, observation, digest?)`. Un SBA possède pourtant un réveil avant que
son `effectId` ne soit alloué. Inventer un effectId temporel serait factuellement faux et ferait
entrer le replay dans la greffe qui re-stampe `jarvis_work_items`.

L'autorité actuelle ne recalcule pas non plus systématiquement le commandId depuis la commande
parsée. Ce défaut de fingerprint de la branche effet est réel, mais il exige un train reader-first
et un plancher de rollback propres ; U1-m ne le dissimule pas dans le lot wake. Il est tracé en
U1-o (§3.3/§11), sans changer les octets des reçus effet existants dans ce vertical.

### 1.3 Le « no-op » pur ne passe pas la vraie persistance

Un wake inconnu, périmé ou prématuré rend aujourd'hui la **même** postimage, la **même** révision et
zéro intent dans les deux définitions. Mais toute réduction `ok` appelle ensuite
`persistTransition`, qui exécute toujours un `UPDATE`, rafraîchit l'idle et append un événement.
Le trigger exige `NEW.revision = OLD.revision + 1` et le journal exige également `after = before +
1`. La baseline ne produit donc pas un no-op : elle rollbacke.

Faire avancer artificiellement la révision serait pire : un réveil prématuré consommerait un CAS
interactif et pourrait déposer un reçu immuable que le vrai réveil rejouerait à l'échéance.

### 1.4 L'heure de réduction est échantillonnée trop tôt

L'admission lit actuellement l'horloge DB avant les verrous société, owner et run. Une commande
peut lire `now < dueAt`, attendre le verrou jusqu'après l'échéance puis réduire avec cet instant
périmé. Pour le wake cela retarde la transition ; pour une confirmation tactile concurrente cela
peut autoriser une proposition après son TTL.

### 1.5 L'index simple ne constitue pas un annuaire

`agent_missions_next_wake_idx("nextWakeAt")` ne fournit ni tuple keyset stable, ni tenant/owner/run,
ni cutoff, ni borne haute, ni filtre moteur fermé. Une page stateless réouverte au début peut être
affamée par les mêmes coordonnées dues, comme l'était l'annuaire de dispatch avant U1-l.

`nextWakeAt` accepte en outre actuellement les timestamps PostgreSQL infinis. Son égalité avec le
minimum des wakes du state n'est vérifiée que par les constructeurs de définition, pas par une
frontière publique commune.

### 1.6 L'écran ne relit pas un timer local pendant l'attente utilisateur

Le hook mobile repoll uniquement les statuts où un effet déjà autorisé peut encore modifier une
projection. Un run `waiting_user|waiting_screen` portant `nextWakeAt` peut donc rester affiché
périmé jusqu'au focus, à la reconnexion ou à un geste. La sécurité serveur peut rester ferme, mais
la vérité visible O6 exige une relecture bornée et non autoritaire.

### 1.7 Il n'existe pas de preuve opérationnelle du balayage

Les logs seuls ne prouvent ni le retard, ni la dernière exécution réussie, ni la différence entre
`empty`, `busy`, indisponibilité et erreur coordonnée. Un scanner activé sans métriques ni alerte
serait une capacité silencieusement morte.

## 2. Périmètre, non-objectifs et états de livraison

### 2.1 Inclus dans U1-m

1. fermer l'algèbre `committed | ignored | refused` avant le premier émetteur ;
2. séparer les sujets système `effect_observation` et `wake_due` ;
3. rendre le commandId du wake déterministe, générationnel et revérifié par l'admission ;
4. exposer les wakes pendants par la définition pure, sans parser le JSON dans l'infrastructure ;
5. créer un annuaire global wake, paginé et durable, distinct de celui des work items ;
6. brancher un scheduler unique dans `JarvisModule`, derrière un kill switch fermé ;
7. relire le run sous scope owner avant de soumettre le wake au gateway unique ;
8. ajouter la cadence mobile de vérité, bornée et suspendue en arrière-plan ;
9. exposer métriques, alerte, runbook, scripts de release et certificats exacts.

### 2.2 Explicitement hors U1-m

- expiration idle/hard et toute nouvelle raison terminale ;
- mutation silencieuse des définitions v1 ;
- nouveau work item temporel, table de schedule métier ou second gateway ;
- timer mémoire autoritaire ;
- nouvelle route HTTP, nouvel outil voix, action publiée ou ouverture du manifest ;
- activation de staging/production, modification de la matrice des flags ou décision fondateur
  implicite ;
- garantie d'équité absolue entre sociétés ou borne d'I/O sans `EXPLAIN` représentatif ;
- promesse d'expiration instantanée sur le mobile.

### 2.3 Ledger de livraison

- Le présent fichier porte U1-m à `specified` seulement.
- L'existence du code portera chaque sous-lot à `implemented` au maximum.
- `certified` exige la matrice locale, PostgreSQL non-superuser, replay Supabase staging au SHA
  exact et preuve opérationnelle du scanner fermé puis ouvert.
- `released` exige le cutover froid §9 et la preuve sur l'environnement réellement servi.

## 3. Autorité domaine et admission

### 3.1 Projection pure des wakes

`JarvisDefinitionModule` expose une fonction pure et totale :

```ts
type JarvisPendingWakesResult =
  | { readonly ok: true; readonly value: readonly JarvisWake[] }
  | { readonly ok: false; readonly error: 'invalid_state' };

readonly pendingWakes: (run: DefinitionRun) => JarvisPendingWakesResult;
```

Lois :

- elle ne lit ni horloge, port, repository, environnement ni payload externe ;
- chaque wake est gelé, porte un `wakeId` canonique, un `kind` fermé et un ISO UTC canonique fini ;
- le tableau est ordonné par `dueAt`, puis par octets UTF-8 du `wakeId` à égalité ;
- les `wakeId` sont uniques dans un run ;
- `deriveNextWakeAt(pendingWakes(run).value) === run.nextWakeAt` pour toute postimage lisible ;
- une postimage terminale lisible produite par une définition supportée rend zéro wake et
  `nextWakeAt = null` ; une ligne `quarantined` n'est jamais reparsée par cet oracle ;
- l'infrastructure ne connaît aucune clé privée des states SBA/Customer Contact.

Une incohérence détectée à la lecture est `invalid_state`, jamais une tentative devinée. Elle reste
visible dans les métriques et fait échouer la coordonnée ; la pagination continue.

### 3.2 Normalisation fermée avant persistance, sans réécrire les définitions v1

Les modules `@1` restent byte-stables : leurs reducers et leurs tests continuent à rendre les
drafts historiques `sba_wake_ignored`, `cc_wake_noop` et les autres no-op existants. L'admission
ajoute une frontière pure de classification entre ce résultat versionné et la persistance :

```text
committed { transition }
ignored   { postimage = preimage, auditEventDraft, reason }
refused   { error }
quarantine_required { kind, definitionVersion }
```

Invariants non négociables :

- `committed` implique `postimage.revision = preimage.revision + 1`, exactement un événement de
  run et le CAS existant ; c'est le seul cas qui rafraîchit `updatedAt` et `idleExpiresAt` ;
- `ignored` n'est reconnu que si `transition.postimage === preimage`, révision identique, zéro
  intent, bail non libéré et wakes exactement égaux à l'oracle `pendingWakes`. Il implique zéro
  `persistTransition`, zéro événement, zéro reçu, zéro mise à jour de lease/foreground et zéro
  re-stamp de work item ; le draft historique reste une métadonnée d'audit en mémoire seulement ;
- toute forme qui n'est ni R+1 commitée, ni no-op strict, ni erreur/quarantaine devient
  `invalid_command/invalid_transition_shape` en zéro-write ;
- `quarantine_required` conserve le chemin §5.5 existant : CAS dédié R+1, statut `quarantined`,
  exactement un événement `run_quarantined`, zéro work item, hard/idle/nextWake conservés ; ce
  n'est ni un `refused`, ni un `ignored`, ni un appel à `persistTransition` ;
- un ignoré peut émettre un log structuré et une métrique **sans identifiant**, mais aucun faux
  `JarvisRunEvent` ;
- un appel user qui aboutirait à `ignored` est refusé intérieurement comme défaut de protocole :
  aucun nouveau résultat ambigu ne traverse l'API tactile ;
- un appel système `ignored` retourne `JarvisSystemAdmissionResult.status = 'ignored'` avec la
  seule raison U1-m `wake_not_due` ; répéter cet appel recalcule le même ignoré, sans « replay »
  persistant.

Le choix « zéro reçu » est volontaire. Un reçu `ignored` du wake prématuré serait immuable et
empoisonnerait le même wake à l'instant où il devient dû.

### 3.3 Sujets système disjoints

Le port système utilise une union, jamais des champs optionnels :

```text
effect_observation {
  effectId, observationKind, observationDigest
}
wake_due {
  wakeId, dueAt, expectedRevision
}
```

Le sujet `lifecycle_expiry { deadlineKind, deadlineAt, expectedRevision }` est réservé au futur
U1-n et n'entre pas dans l'union exécutable U1-m.

Pour `effect_observation` :

- le type public historique est adapté à la variante discriminée sans modifier son namespace UUID
  v8, son `deriveJarvisSystemCommandId`, sa canonicalisation de reçu, ses événements ni ses octets
  persistés ;
- `observationDigest` reste exactement le digest déjà passé à la dérivation historique ;
- le replay-heal work-item reste possible uniquement pour cette variante et uniquement pour son
  `effectId` vérifié ; aucun champ wake ne peut atteindre cette greffe ;
- U1-m ne prétend **pas** que le fingerprint historique scelle toute la commande métier. En
  particulier `customerRevision` n'est pas prouvée par le seul `resultDigest` actuel.

Le durcissement complet de cette variante est un train séparé **U1-o** : déployer d'abord un
lecteur N-1 capable de comprendre un fingerprint complet de commande, certifier ce lecteur dans
tous les environnements, puis seulement autoriser un writer fort et poser un plancher de rollback.
Le recalcul obligatoire du commandId effect avant receipt appartient lui aussi à ce train, après
inventaire/reconstruction de tous les reçus système vivants ; l'ajouter dans U1-m pourrait rendre
un reçu historique jusque-là replayable infiniment divergent.
Jusqu'à ce train, un `command_conflict` effet ne constitue pas une preuve d'application métier et
ne doit pas être présenté comme tel dans les preuves U1-m. U1-m ne crée aucun nouvel événement
effet, ne change pas sa règle d'ACK et n'en revendique pas la certification.

Pour `wake_due` :

- aucun `effectId`, observation d'effet ou digest de résultat ne peut être fourni ;
- le commandId est produit par un nouveau namespace figé :
  `deriveJarvisWakeCommandId(runId, wakeId, dueAt, expectedRevision)` ;
- l'UUID scelle le run, le wake, l'ISO dû et la génération CAS. Un wake prématuré `ignored` garde
  volontairement la **même** identité afin de pouvoir devenir dû ; seule une replanification de
  l'échéance ou une autre génération de révision reçoit une identité distincte ;
- l'admission recalcule cet UUID et refuse `system_command_binding_mismatch` en zéro-write ;
- le reçu conserve `fingerprintCanonicalizationVersion = 1`, mais la canonicalisation sélectionne
  une branche neuve sans modifier les bytes user/effect existants. Après parse de `wake_run`, les
  bytes de `canonicalInputDigest` sont le SHA-256 hex minuscule du JSON canonique
  `["bob.jarvis.wake-input.v1","wake_run",wakeId]`. Puis les
  bytes HMAC sont exactement
  `[bob.jarvis.admission.wake.v1, companyId, ownerUserId, kind, definitionVersion, runId,
commandId, expectedRevision, wakeId, dueAt, canonicalInputDigest]` joints par `U+001F`, nombres
  en base 10 et ISO UTC canonique. Le fingerprint scelle donc sujet, commande parsée et génération ;
- aucun replay wake ne touche `jarvis_work_items`.

`deriveJarvisWakeCommandId` calcule SHA-256 sur le JSON canonique
`["bob.jarvis.wake-command.v1", runId, wakeId, dueAt, expectedRevision]`, puis projette les mêmes
bits version/variant UUID v8 que le dériveur historique. Les vecteurs UUID **et** HMAC des branches
effect historique et wake neuve sont figés. Une évolution future crée un namespace neuf, jamais un
changement silencieux d'octets.

### 3.4 Horloge et ordre de linéarisation

Pour une commande sur run existant :

1. parser la forme, la variante et les liaisons structurelles du sujet, sans lire de reçu ;
2. acquérir les verrous société, owner et kind existants. Une société absente est refusée ; pour un
   appel user, résoudre aussi le principal/capability sous ces verrous avant toute recherche de
   reçu ;
3. rechercher le reçu et vérifier son fingerprint historique. Un reçu exact déjà commité reste
   rejouable après fermeture du kill switch ou de la société ; le replay wake est strictement
   zéro-write, tandis que la greffe de re-stamp reste effect-only ;
4. en absence de reçu, appliquer les gates de **nouvelle** avance : `effect_observation` conserve
   l'exception §5.6, mais `wake_due` exige société ouverte et admission activée ;
5. acquérir le run `FOR UPDATE`, puis toutes les lignes susceptibles de bloquer la revalidation
   autoritaire (dont la cible Customer Contact) dans l'ordre existant ; un replay exact valide
   également l'appartenance au run sans révéler un reçu hors owner/kind ;
6. lire **une fois** `clock_timestamp()` après le **dernier** de ces verrous, immédiatement avant
   réduction, uniquement sur le chemin qui réduit ou re-stampe ; un replay wake pur n'a besoin
   d'aucun nouvel instant ;
7. vérifier la révision ; pour `wake_due`, résoudre `pendingWakes`, retrouver le premier wake et
   exiger sous verrou `wakeId + dueAt + nextWakeAt` exactement égaux au sujet, puis recalculer le
   commandId depuis ces valeurs autoritaires ; une divergence vaut
   `system_command_binding_mismatch`, zéro-write ;
8. réduire avec cet instant ;
9. persister un `committed` ou la quarantaine dédiée ; `ignored` ne passe jamais à une frontière
   d'écriture.

L'ordre « autorité puis reçu » interdit l'oracle de replay : owner divergent, capability révoquée
ou société absente ne peuvent ni apprendre ni rejouer un reçu. La fermeture opérationnelle ne
transforme toutefois jamais un retry **exact déjà commité** en faux refus : société fermée ou
admission OFF bloquent seulement le chemin sans reçu.

Pour un seed, l'instant est lu après les verrous owner/kind, immédiatement avant la réduction.
L'`occurredAt` du transport reste une corrélation, jamais l'autorité temporelle.

La frontière est inclusive : un wake est dû si `databaseNow >= dueAt`. Une confirmation dont la
proposition échoit pendant l'attente du verrou run **ou cible** ne peut pas gagner sous un instant
pré-lock périmé.

## 4. Annuaire global wake v1

### 4.1 Pourquoi un annuaire distinct

L'annuaire de dispatch U1-l porte des work items par société ; ses prédicats, ACL et gestes ne
décrivent pas un run dû. Le réutiliser créerait une autorité transversale illisible. U1-m crée donc
un curseur singleton, sept gestes runtime et une fonction de scrub dédiée au lane unique `wake_v1`.

Le curseur est global pour fermer l'absence de découverte inter-tenant sans dépendre d'une liste
de sociétés. Il ne conserve au maximum que 50 tuples pseudonymes
`(companyId, ownerUserId, runId, observedDueAt, observedRevision)` et les métadonnées de cadence.
Il ne conserve jamais state, payload, libellé, input, cible métier, action ou digest métier. La
rétention couvre le **cycle entier**, y compris `after`, borne haute, cutoff et page pending :
`cycleRetentionExpiresAt = cycleCreatedAt + 24 h`, fini, non renouvelable. Une page survit
volontairement à une panne jusqu'à cette borne pour être redélivrée ; chaque ACK efface la page.

Le reset est sans faux progrès : il efface page **et cycle** sans avancer le keyset, de sorte que la
source level-triggered soit redécouverte depuis le début. Trois autorités sont disjointes : le
token courant reset une page possédée ; la révision exacte reset immédiatement un cycle idle entre
deux pages ; un geste cleanup atomique reset tout cycle expiré même sans token. Ce dernier geste est
le seul appel annuaire permis quand le flag reste OFF : il ne claim, ne start et ne contacte jamais
le gateway. Ainsi une fermeture juste après un ACK intermédiaire ne retient pas les keysets à vie,
même après crash du processus.

Une suppression de société déclenche sous la même transaction un scrub global `SECURITY DEFINER`
qui invalide le claim et remet le curseur à zéro, que la société figure ou non dans la page. Ce
reset conservateur peut redélivrer d'autres coordonnées mais ne perd aucun travail. Échec DB pendant
un reset : le scanner reste fermé ; le cleanup expiré est retenté sans créer de page.

### 4.2 Ensemble dû et ordre

Une coordonnée fraîche est éligible exactement si :

- `kind@definitionVersion` appartient à la liste fermée
  `customer_contact@1 | single_business_action@1` ;
- `terminalAt IS NULL`, statut non terminal et différent de `quarantined` ;
- `nextWakeAt IS NOT NULL`, fini et `nextWakeAt <= cycleCutoffAt` ;
- `updatedAt <= cycleCutoffAt` ;
- elle est strictement après le keyset courant et au plus égale à la borne haute figée.

Ordre total :

```text
(nextWakeAt, companyId COLLATE "C", ownerUserId COLLATE "C", runId)
```

Le cutoff et le maximum de ce même ensemble sont figés au début du cycle. Les requêtes de maximum
et de page réutilisent **mot pour mot** le prédicat. Une arrivée horodatée après cutoff attend le
cycle suivant ; une transaction commencée avant et commitée après peut rejoindre le cycle si son
horodatage et sa clé satisfont la borne, sinon elle attend le suivant. Aucune promesse de snapshot
MVCC inter-ticks n'est formulée.

L'index additif est figé, généré depuis les vocabulaires core et certifié contre eux :

```sql
CREATE INDEX CONCURRENTLY agent_missions_jarvis_wake_directory_v1_idx
ON public.agent_missions (
  "nextWakeAt",
  "companyId" COLLATE "C",
  "ownerUserId" COLLATE "C",
  id
)
INCLUDE ("updatedAt", revision)
WHERE kind IN ('customer_contact', 'single_business_action')
  AND "definitionVersion" = 1
  AND status IN (
    'active', 'waiting_user', 'waiting_screen', 'waiting_external',
    'retry_due', 'parked', 'cancelling'
  )
  AND "terminalAt" IS NULL
  AND "nextWakeAt" IS NOT NULL;
```

Les requêtes maximum et page emploient ce même filtre, ajoutent `updatedAt <= cycleCutoffAt`,
`nextWakeAt <= cycleCutoffAt` et les bornes keyset. L'ancien index reste intact pour N-1. La
création concurrente vit dans une migration non transactionnelle dédiée compatible avec le
runner. Le certificat exige `indisvalid`, `indisready`, ordre/opclasses/collations/INCLUDE/prédicat
exacts et deux plans séparés — maximum et page — sur volume représentatif ; sans ces `EXPLAIN`,
aucune borne d'I/O n'est revendiquée.

### 4.3 Schéma fermé du curseur

La migration crée exactement `public.jarvis_wake_directory_cursor`, modélisée `@@ignore`, avec une
unique ligne préinsérée :

```text
singleton boolean PRIMARY KEY DEFAULT true CHECK (singleton IS TRUE)

afterDueAt timestamptz(6) null
afterCompanyId text COLLATE "C" null
afterOwnerUserId text COLLATE "C" null
afterRunId uuid null

cycleUpperDueAt timestamptz(6) null
cycleUpperCompanyId text COLLATE "C" null
cycleUpperOwnerUserId text COLLATE "C" null
cycleUpperRunId uuid null
cycleCutoffAt timestamptz(6) null
cycleCreatedAt timestamptz(6) null
cycleRetentionExpiresAt timestamptz(6) null

pendingDueAts timestamptz(6)[] NOT NULL DEFAULT '{}'
pendingCompanyIds text[] COLLATE "C" NOT NULL DEFAULT '{}'
pendingOwnerUserIds text[] COLLATE "C" NOT NULL DEFAULT '{}'
pendingRunIds uuid[] NOT NULL DEFAULT '{}'
pendingRevisions bigint[] NOT NULL DEFAULT '{}'
pendingAfterDueAt timestamptz(6) null
pendingAfterCompanyId text COLLATE "C" null
pendingAfterOwnerUserId text COLLATE "C" null
pendingAfterRunId uuid null
pendingHasMore boolean null
pendingNextPosition integer null

claimId uuid null
claimExpiresAt timestamptz(6) null
claimHardExpiresAt timestamptz(6) null
revision bigint NOT NULL DEFAULT 0 CHECK (revision >= 0)
```

Les CHECK portent des noms figés et ferment chaque état :

- les quatre tuples keyset sont all-null ou all-présents ; dates finies ; ordre tuple explicite
  `(dueAt, companyId COLLATE C, ownerUserId COLLATE C, runId)` ; `after < upper`, `tail <= upper`
  et, lorsque les deux existent, `after < tail` ; `pendingHasMore IS TRUE => tail < upper`, chaque
  comparaison enveloppée par `IS TRUE` ;
- les cinq arrays ont cardinalité égale entre 0 et 50. Non vides : exactement une dimension,
  lower bound 1, mêmes dimensions, aucun NULL ; la dernière cellule de chaque array est
  `IS NOT DISTINCT FROM` le tuple tail ; les arrays vides canoniques sont autorisés ;
- cycle absent : `after/upper/cutoff/created/retention` tous NULL. Cycle présent : upper, cutoff,
  created et retention tous présents/finis, `cycleCreatedAt = cycleCutoffAt`,
  `cycleRetentionExpiresAt = cycleCreatedAt + interval '24 hours'`, et soit `after` existe soit une
  page pending est non vide ;
- page absente : arrays vides et tail/hasMore/next/token/soft/hard tous NULL. Page présente : arrays
  1..50, tail/hasMore/next/token/soft/hard tous non NULL, token non nil,
  `1 <= pendingNextPosition <= pageSize + 1`, soft/hard finis et
  `claimExpiresAt <= claimHardExpiresAt <= cycleRetentionExpiresAt` ;
- `hasMore=true` implique tail strictement avant upper. Un état fantôme, un array `[0:n]`, 2D,
  discordant, infini ou un CHECK qui évaluerait `UNKNOWN` est refusé `23514`.

### 4.4 Contrats SQL et machine de claim

Les sept fonctions runtime ont des signatures exactes :

```text
claim_jarvis_wake_coordinates_v1(integer, uuid)
  RETURNS TABLE(status text, "claimId" uuid, position integer, "pageSize" integer,
    "companyId" text, "ownerUserId" text, "runId" uuid,
    "observedDueAt" timestamptz, "observedRevision" bigint, "hasMore" boolean,
    replayed boolean, "databaseNow" timestamptz, "claimHardExpiresAt" timestamptz,
    "cursorRevision" bigint)

renew_jarvis_wake_coordinates_claim_v1(uuid)
  RETURNS TABLE(renewed boolean, "databaseNow" timestamptz,
    "claimExpiresAt" timestamptz, "claimHardExpiresAt" timestamptz,
    "cursorRevision" bigint)
start_jarvis_wake_coordinate_v1(uuid, integer)
  RETURNS TABLE(started boolean, "databaseNow" timestamptz,
    "claimExpiresAt" timestamptz, "claimHardExpiresAt" timestamptz,
    "cursorRevision" bigint)
ack_jarvis_wake_coordinates_v1(uuid)
  RETURNS TABLE(acknowledged boolean, "acknowledgedAt" timestamptz,
    "cursorRevision" bigint)
reset_claimed_jarvis_wake_directory_v1(uuid)
  RETURNS TABLE(reset boolean, "databaseNow" timestamptz, "cursorRevision" bigint)
reset_idle_jarvis_wake_directory_v1(bigint)
  RETURNS TABLE(reset boolean, "databaseNow" timestamptz, "cursorRevision" bigint)
reset_expired_jarvis_wake_directory_v1()
  RETURNS TABLE(reset boolean, "databaseNow" timestamptz, "cursorRevision" bigint)
```

`claim` rend l'une des formes fermées :

- `claimed` : 1..N lignes, positions absolues contiguës `k..pageSize`, dernière position
  `pageSize`, coordonnées et métadonnées homogènes non NULL ; page fraîche `N <= limit` et
  `replayed=false`, suffixe repris `N <= 50` et `replayed=true` ;
- `ack_ready` : une ligne, token/pageSize/hasMore/replayed=true/databaseNow/hard/revision non NULL,
  coordonnées et position NULL ;
- `empty|busy` : une ligne, `status/databaseNow/cursorRevision` non NULL et tous les champs de page
  NULL. `busy` ne révèle jamais le token concurrent ;
- tout mélange, substitution d'identité, ordre non-C, doublon, position trouée, date non finie ou
  révision négative est `invalid_response` à l'adapter, jamais `empty`.

L'adapter valide l'ordre texte avec `Buffer.compare(Buffer.from(value,'utf8'))`, les UUID via leur
forme canonique/16 octets et les dates via leur instant, jamais `localeCompare`. Les `bigint` SQL
sont parsés puis refusés hors entier sûr attendu par le domaine ; les noms camelCase de la table de
retour sont quotés et certifiés.

Machine normative :

- limite fraîche runtime 25, plafond 50 ; malformed UUID est rejeté par l'adapter, cast SQL direct
  vaut `22P02`, NULL/nil/limite/position sémantiquement invalides valent `22023` avant lecture ;
- chaque geste locke la ligne `FOR UPDATE`, puis capture **une seule fois** `clock_timestamp()` ;
  soft 30 s, hard commun 5 min et au plus égal à la rétention du cycle ;
- au début de `claim`, une TTL de cycle échue reset toute la machine avant toute découverte. Un
  pending encore retenu est redélivré sans re-filtrer la source ni appliquer la nouvelle limite ;
- expiration soft rend le claim volable sans auto-révocation ; takeover avec token strictement neuf
  conserve page et `pendingNextPosition`, recrée soft/hard et rend le suffixe exact ; réutiliser le
  même token pour reprendre vaut `22023`, état inchangé ;
- `renew/start` ignorent soft expirée si aucun takeover, mais exigent token courant et hard/TTL
  vivants. `start(position)` exige la position suivante et `position <= pageSize`, puis avance le
  slot et renouvelle soft atomiquement ;
- `renew/start` deviennent faux à hard/TTL ; ACK exige token courant et `next=pageSize+1`, sans
  condition temporelle. Après hard sans repreneur, cet ACK complet reste vrai ; après takeover,
  tout geste de l'ancien token est faux ;
- chaque ACK efface page/token/échéances. `hasMore=true` avance `after=tail` et conserve le cycle ;
  l'ACK final efface aussi after/upper/cutoff/created/retention. `acknowledgedAt` n'est non NULL que
  pour un ACK vrai et provient de l'unique horloge DB post-lock ;
- une page n'est ACKée qu'après un slot `start` durable pour chaque position. Erreur individuelle,
  crash après start ou handler déjà vivant localement comptent comme tentative de slot sans
  inventer de succès ; la source non réglée revient au cycle suivant ;
- perte de claim, surcharge locale, shutdown ou arrêt avant tous les slots : zéro ACK ;
- `reset_claimed(token)` efface page **et cycle** sans avancer ; `reset_idle(revision)` fait de même
  uniquement sans page/claim et sur révision exacte ; `reset_expired()` locke puis reset uniquement
  si la TTL de cycle est échue, même sous flag OFF. Les trois incrémentent la révision seulement sur
  succès et ne renouvellent jamais la TTL ; stale/missing est false zéro-write.

Chacun des six gestes de contrôle renew/start/ACK/trois resets rend **exactement une ligne**. Son
booléen et `cursorRevision` post-opération sont toujours non NULL. `databaseNow` est toujours non
NULL pour renew/start et les trois resets ; pour renew/start, les deux échéances sont toutes deux
non NULL si et seulement si le booléen vaut true, sinon toutes deux NULL. ACK ne porte pas de
`databaseNow` distinct : `acknowledgedAt` est non NULL si et seulement si `acknowledged=true`. Les
resets n'ont aucun autre champ nullable.

Toute mutation réussie — page fraîche, takeover, renew, start, ACK ou reset — incrémente la révision
du curseur **exactement une fois**, sans jamais la réinitialiser ; le postimage rendu porte cette
révision. `busy`, false et `empty` sur un état déjà idle sont zéro-write et rendent la révision
courante. Si `claim` doit simultanément expirer un ancien cycle et rendre `empty` ou une page neuve,
il construit une seule postimage atomique et n'incrémente qu'une fois. L'adapter rejette zéro ou
plusieurs lignes, booléen NULL, échéances discordantes et révision non postérieure attendue.

Chaque claim, renew, start, ACK ou reset vit dans sa propre transaction globale courte. L'adapter
pose puis relit `statement_timeout='4s'` et `lock_timeout='1s'` avant l'appel, sous timeout Prisma
global ; aucun verrou/transaction ne traverse heartbeat, lecture owner ou gateway. Une attente de
verrou rend `55P03`/`unavailable`, jamais `empty|busy`.

Garantie de liveness, bornée honnêtement : pour un ensemble fini de N coordonnées au cutoff qui
restent dues jusqu'au passage de leur keyset, si DB/scheduler/registry redeviennent disponibles et
si chaque page reçoit tous ses slots puis son ACK **avant la TTL de cycle**, chaque coordonnée est
présentée en au plus `ceil(N/limit)` pages ACKées. Une coordonnée devenue non due est résolue par la
source, pas affamée. Les pannes perpétuelles, handlers externes non terminants, backlog dépassant la
capacité d'un cycle de 24 h et équité inter-tenant absolue sont hors garantie ; ils sont métrés et
bloquent toute revendication de capacité avant les `EXPLAIN`/canary.

### 4.5 RLS, rôles, scrub et surface SQL

Un rôle dédié `bob_jarvis_wake_directory`, `NOLOGIN`, `NOSUPERUSER`, `NOBYPASSRLS`, possède
l'autorité minimale :

- SELECT par colonnes sur `agent_missions` uniquement pour company, owner, id, kind,
  definitionVersion, status, revision, nextWakeAt, terminalAt et updatedAt ;
- SELECT/UPDATE sur le curseur singleton préinséré, jamais INSERT/DELETE/TRUNCATE/REFERENCES/TRIGGER ;
- zéro state/payload, timestamps idle/hard, work item, client ou autre table métier.

La source et le curseur sont `ENABLE ROW LEVEL SECURITY` + `FORCE ROW LEVEL SECURITY`. Une policy
source `FOR SELECT` autorise **explicitement** `current_user = 'bob_jarvis_wake_directory'` sur le
prédicat **statique** fermé (kind/version supporté, statut structurel éligible, `terminalAt` nul,
`nextWakeAt` non nul). Les bornes dynamiques due/cutoff/keyset restent dans la fonction, pas dans
une policy qui devrait les deviner. Les policies owner/GUC existantes ne sont jamais supposées
s'appliquer à cette autorité globale. L'inventaire, l'expression exacte et l'exécution de cette
policy avec le rôle non-superuser sont certifiés : un test superuser seul serait un faux vert.

Le curseur possède exactement deux policies pour cette même autorité : `FOR SELECT USING
(current_user = 'bob_jarvis_wake_directory')` et `FOR UPDATE` avec les mêmes `USING` **et**
`WITH CHECK`. Le singleton est créé sous son owner pendant l'expand ; aucune policy INSERT runtime
n'est nécessaire ni permise. La ligne singleton est préinsérée **avant** FORCE RLS.

L'expand crée table/policies et fonctions runtime `SECURITY INVOKER` révoquées, mais **n'attache pas
encore** le trigger société : tant que les fonctions sont fermées et le flag faux, aucun identifiant
ne peut entrer dans le curseur. Dans la transaction atomique de provisionnement, le release :

1. transfère les fonctions runtime à l'autorité et pose leurs propriétés `SECURITY DEFINER` ;
2. crée/transfère la fonction de scrub `SECURITY DEFINER`, garde `TG_OP='DELETE'`, `TG_TABLE_SCHEMA`
   et `TG_TABLE_NAME`, puis attache l'unique trigger `AFTER DELETE` sur `companies` ;
3. certifie le trigger et seulement ensuite accorde EXECUTE runtime.

Ainsi un writer N-1 supprimant une société avant provision ne rencontre aucun trigger incomplet ;
après provision, le scrub s'exécute comme l'autorité RLS sans donner UPDATE au writer société. Le
harness exécute une vraie suppression dans les états avant expand, après expand/avant provision et
après provision.

Le runtime n'a aucun privilège table/colonne et seulement EXECUTE sur les sept gestes runtime après
provisionnement. `PUBLIC`, `anon`, `authenticated`, `service_role` et tout grantee parasite ont
zéro table, colonne et EXECUTE, sans grant option. Les fonctions naissent `SECURITY INVOKER`,
révoquées, puis sont transférées/provisionnées atomiquement en `SECURITY DEFINER`, search_path
`pg_catalog`, row_security on et timeouts exacts. Le rôle runtime ne peut ni hériter ni `SET ROLE`
vers l'autorité ; l'adhésion du déployeur est SET-only via `createrole_self_grant='set'`. Le replay
`rls.sql` normalise policies, owners, ACL table/colonne/fonction/schéma, grantors, `MAINTAIN`,
`USAGE` et `REVOKE CREATE` ; toute lecture vérifie `current_user` avant la source.

## 5. Revalidation owner-scopée et gateway unique

Le scheduler ne fait jamais confiance à la page pour décider d'une commande. Pour chaque entrée,
après `start` :

1. ouvrir une lecture tenantée par `(companyId, ownerUserId)` ;
2. relire exactement `runId`, sans cache ;
3. résoudre la définition épinglée et appeler `pendingWakes(run)` ; un résultat `invalid_state`
   ferme la coordonnée sans construire de wake ;
4. vérifier que kind/version sont supportés, run non terminal/non quarantiné, révision égale à
   `observedRevision`, `run.nextWakeAt === observedDueAt`, et que le premier wake porte exactement
   cette échéance ;
5. lire l'horloge DB de cette frontière ; si le wake n'est pas dû, classer `stale`/`not_due` sans
   gateway ; ce précheck économise un appel mais ne fait pas autorité : l'admission répète la garde
   sous le verrou du run avec sa propre horloge post-lock ;
6. construire `wake_run { wakeId }`, dériver le commandId générationnel et appeler l'unique
   `runJarvisSystemAdmission` ;
7. traiter le résultat par la matrice fermée ci-dessous, sans `default` et sans jamais écrire le run
   directement.

Une révision ou échéance divergente n'est pas une réussite silencieuse : elle est comptée stale,
la source courante déterminera le prochain cycle. Un `command_conflict` alors que le wake exact
reste dû est une défaillance ; il n'est jamais transformé en ACK métier. L'ACK de page reste permis
après **tentative** de cette coordonnée afin qu'elle ne puisse affamer les suivantes ; sa source
due la fera revenir au cycle suivant.

| Résultat système/gateway                       | Résumé coordonnée                    | Suite de page                                              |
| ---------------------------------------------- | ------------------------------------ | ---------------------------------------------------------- |
| `admitted`                                     | `admitted`                           | continue                                                   |
| `replayed`                                     | `replayed`                           | continue, zéro write wake                                  |
| `ignored(wake_not_due)`                        | `ignored`                            | continue ; la source revient si elle reste due             |
| `stale_revision`                               | `stale`                              | continue                                                   |
| `system_command_binding_mismatch`              | `stale` + audit sans identifiant     | continue                                                   |
| `run_not_found`                                | `stale`                              | continue                                                   |
| `company_unavailable(missing)`                 | `stale`                              | continue ; aucun autre tenant n'est bloqué                 |
| `company_unavailable(closed)`                  | `failed`                             | continue ; aucun autre tenant n'est bloqué                 |
| `command_conflict`                             | `failed`                             | continue ; jamais succès métier                            |
| `foreground_busy` / `foreground_unavailable`   | `failed`                             | continue                                                   |
| `capability_rejected`                          | `failed` + défaut de câblage système | continue                                                   |
| `quarantined`                                  | `failed`                             | continue                                                   |
| `refused`                                      | `failed`                             | continue                                                   |
| `action_refused(admission_kill_switch)`        | `failed` + cycle `partial`           | arrêter avant tout prochain start, reset de page, zéro ACK |
| autre `action_refused`                         | `failed`                             | continue                                                   |
| exception/timeout/`unavailable` de l'admission | `failed`                             | continue ; la ligne reste due                              |

Cette table est matérialisée par un `satisfies Readonly<Record<...>>` exhaustif sur l'union système.
Tout ajout de statut casse la compilation et impose une décision. Seuls flag/admission devenus OFF,
perte du claim, saturation ou shutdown arrêtent une page ; une erreur individuelle déjà slotée est
tentée et n'affame pas le suffixe. Une fois toutes les positions slotées, l'ACK d'annuaire signifie
« page entièrement tentée », jamais « toutes les transitions métier ont réussi ».

Le scheduler ne crée aucun work item et n'appelle aucun exécuteur métier directement. Une
postcondition rejette tout résultat système wake qui contiendrait un intent.

## 6. Scheduler, mémoire, arrêt et concurrence

`JarvisRunWakeScheduler` appartient à `JarvisModule`. `ScheduleModule.forRoot()` reste unique dans
`AppModule`; aucun second gateway, UoW ou provider de définition n'est créé.

Le port `JarvisWakeDirectoryPort` vit dans la couche application/jobs et ne dépend ni de Prisma ni
de Nest. `PrismaJarvisWakeDirectory` l'implémente depuis le même objet `PERSISTENCE` que les autres
autorités ; un unique token `JARVIS_WAKE_DIRECTORY` est construit par factory typée, sans cast
partiel. Le scheduler injecte ce port, l'instance existante `JARVIS_ADMISSION` et le registry de
définitions existant. Il est toujours enregistré afin que le cron et le shutdown soient
observables, mais une autorité manquante produit `dependencies_absent`/cycle `unavailable`, zéro
claim et zéro fallback mémoire. Le test de module casse si une fausse persistence n'expose pas
exactement les sept gestes.

### 6.1 Activation

- variable dédiée : `BOB_JARVIS_WAKE_SCANNER_ENABLED` ;
- schéma/env/example : seulement `'true' | 'false'`, défaut `false` ;
- lecture avant le claim **et avant chaque `start`** ; seule la chaîne exacte `'true'` ouvre ;
- distincte de `BOB_JARVIS_ADMISSION_ENABLED` et indépendante du dispatch, mais un wake n'est pas
  une réconciliation d'effet : son ouverture effective exige **les deux** flags wake et admission
  à `'true'` ;
- flag déjà faux à l'entrée du tick : zéro claim/renew/start/ACK/gateway ; seul
  `reset_expired_jarvis_wake_directory_v1()` peut être appelé dans la lane cleanup, au plus une fois
  par heure, sans coordonnée ni nouvelle rétention ;
- le manifest d'actions reste inchangé et fermé ;
- l'ajout de ce flag fermé au code/env n'autorise pas à modifier seul la matrice normative :
  `[BLOQUÉ FONDATEUR : ajout/contre-signature de BOB_JARVIS_WAKE_SCANNER_ENABLED dans
MATRICE_FLAGS_V1]` ;
- activation staging/production :
  `[BLOQUÉ FONDATEUR : GO cutover wake après staging exact-SHA et contre-signature]`.

Une coordonnée déjà `start` au moment où le flag se ferme peut finir son admission. Aucun nouveau
`start` n'est pris ; une page partielle n'est pas ACKée. Après l'opération en vol, le détenteur
tente `reset` afin de libérer les identifiants sans avancer le keyset ; un reset indisponible reste
une reprise obligatoire de la lane cleanup ; aucun nouveau claim n'est nécessaire pour purger.

Si toutes les positions avaient déjà reçu leur `start` et terminé avant la fermeture, l'ACK reste
permis : il ne crée aucun travail et clôt une page entièrement tentée. Ainsi le flag OFF interdit
claim/renew/start/gateway neufs, mais autorise exactement l'ACK final ou le reset de **nettoyage**
de la page déjà possédée, `reset_idle` avec la révision rendue par l'ACK précédent, et le cleanup
expiré. U1-m ne modifie ni manifest ni policy de publication et ne prétend pas fermer des seeds sur
la base d'une métrique locale.

La tolérance §5.6 parent reste strictement réservée à `effect_observation` : elle peut réconcilier
un effet déjà parti malgré admission fermée ou société fermée. Un **nouveau** `wake_due` est une
avance du run ; admission fermée ou société fermée retourne
`action_refused(admission_kill_switch)`/`company_unavailable` zéro-write. Un reçu wake exact déjà
commité reste néanmoins `replayed` zéro-write après ces fermetures. Le scheduler ne prend aucun
nouveau `start` dès qu'il observe les flags fermés ; la race après un start suit la matrice §5.

### 6.2 Cadence et concurrence

- tick nominal : une minute ; pas de chevauchement local ;
- plusieurs replicas sont arbitrés par le claim DB ; `busy` est distinct de `empty` ;
- un tick traite au plus 4 pages et au plus 4 minutes ; aucune page neuve ne démarre avec moins de
  30 s de budget local ;
- avant `claim`, le scheduler capture `claimRequestStartedMonotonic`. À la réponse il calcule
  `queryElapsedMs`, valide `dbRemainingMs = claimHardExpiresAt - databaseNow` dans `]0,300_000]`,
  puis fixe une seule deadline
  `min(tickStarted+240_000, nowMonotonic+dbRemainingMs-queryElapsedMs-5_000)` ; elle n'est jamais
  réarmée par coordonnée et doit laisser un budget positif, sinon reset/zéro start ;
- cette soustraction est volontairement conservative : elle absorbe trajet DB/adapter et empêche
  une réponse retardée de prolonger localement la hard lease ;
- heartbeat toutes les 10 s, sérialisé, sans `setInterval` concurrent, arrêté et attendu avant
  position suivante ou ACK ; une perte tardive après résolution du handler interdit la suite et
  l'ACK ;
- registre process borné à 50 opérations. Sa clé est un SHA-256 salé par un aléa process des cinq
  champs de coordonnée, jamais la coordonnée brute ; réservation sentinel synchrone avant `start`,
  puis remplacement identity-safe par la Promise lancée via microtask. Une sentinel concurrente
  n'est pas une tentative : zéro start ; une Promise exacte déjà running permet start+skip sans
  second handler ; le `finally` ne retire que sa propre identité ;
- un handler tardif ne peut muter un résumé déjà rendu et sa rejection est absorbée ;
- saturation : zéro `start`, zéro handler et zéro ACK de la page partielle ; jamais une position
  « tentée » sans place mémoire.

### 6.3 Shutdown

Au signal Nest :

1. `stopping = true` avant tout nouveau claim/start ;
2. timers heartbeat/watchdog `unref`, arrêtés ;
3. opérations de contrôle en vol abortées/attendues sous une grâce locale de 5 s ;
4. Promises métier tardives sinkées mais non attendues indéfiniment ;
5. aucune page partielle ACKée ; un reset courant peut être tenté, sans faux progrès ;
6. zéro tick, timer ou registre possédé après la grâce, hors ressource externe non annulable
   explicitement auditée.

La borne dure DB n'annule pas magiquement une I/O externe. Une admission déjà entrée dans sa
transaction reste autoritaire et peut committer après le watchdog ou la grâce de shutdown ; le
scheduler fige alors son résumé local, n'ACKe pas la page inconnue et laisse la source/le reçu
arbitrer la reprise. U1-m ne revendique que la libération du worker, de ses timers et de son
autorité d'ACK ; toute ressource portuaire non annulable reste un risque nommé.

## 7. Vérité mobile non autoritaire

Le mobile utilise `nextWakeAt` uniquement pour **relire**, jamais pour expirer ou envoyer un wake.
Le helper de cadence est pur :

- le polling effet L7 à 1,5 s conserve sa priorité ;
- sinon, pour un run non terminal avec `nextWakeAt`, le helper calcule
  `delta = Date.parse(nextWakeAt) - Date.now()` : date invalide => 30 000 ms, `delta <= 0` =>
  10 000 ms, sinon `max(1_000, min(30_000, delta))` ; un intervalle armé juste avant la frontière
  ne peut donc pas conserver l'ancienne cadence 30 s après l'échéance ;
- la durée est clampée, donc un décalage d'horloge client ne peut ni déclencher une mutation ni
  suspendre la relecture indéfiniment ;
- arrière-plan : zéro GET ; reprise au focus. U1-m n'invente pas de signal « reconnect » : aucun
  pont NetInfo n'est actuellement câblé, les erreurs réseau suivent seulement le retry/backoff
  existant tant que l'application est au premier plan ;
- la query owner-scopée existante est partagée : deux hôtes ne créent pas deux boucles réseau ;
- erreur réseau : conserver la sémantique fail-closed actuelle du hook — aucune ancienne carte
  actionnable n'est présentée comme autoritaire ; l'éventuel control-frame unpresentable conserve
  sa règle U1-k. Le timer local ne fabrique jamais un état « expiré » ni une action ;
- le serveur reste seul à décider `databaseNow >= dueAt`.

L'acceptation produit est une convergence visible bornée en premier plan, pas une expiration
instantanée. Aucun nouvel endpoint n'est nécessaire.

## 8. Observabilité et confidentialité

Métriques sans identifiants ni labels non bornés :

- `bob_jarvis_wake_cycles_total{outcome=empty|busy|completed|partial|unavailable|shutdown}` ;
- `bob_jarvis_wake_coordinates_total{outcome=admitted|replayed|ignored|stale|failed}` ;
- `bob_jarvis_wake_lag_seconds` histogramme de `databaseNow - observedDueAt` ;
- `bob_jarvis_wake_scanner_enabled` gauge local 0/1 ;
- `bob_jarvis_wake_scanner_enabled_since_timestamp_seconds` gauge locale, posée seulement au
  passage de l'ouverture effective wake+admission ;
- `bob_jarvis_wake_last_success_timestamp_seconds` gauge ;
- compteurs takeover, perte de claim, saturation et refus d'autorité.

`last_success` prend l'horloge DB `databaseNow` de `empty` ou `acknowledgedAt` de l'ACK final ;
`busy`, ACK intermédiaire, `partial` et `unavailable` ne l'avancent jamais. Chaque replica expose sa
jauge locale et l'alerte agrège par `max`, sans label métier. Avec tick 1 min et borne 4 min, la loi
minimale laisse trois fenêtres complètes puis exige une persistance :

```promql
max(bob_jarvis_wake_scanner_enabled) == 1
and time() - max(bob_jarvis_wake_scanner_enabled_since_timestamp_seconds) > 900
and time() - (max(bob_jarvis_wake_last_success_timestamp_seconds) or on() vector(0)) > 900
```

`for: 5m`. L'absence initiale de succès ne crée donc pas d'incident immédiat, mais ne devient pas
non plus un empty vector vert. Tests : ouverture sans série, succès multipod, busy-only,
désactivation et réouverture. Le canary calibre ensuite le SLO de lag ; il ne change pas cette
sémantique.

Les logs portent un incident/cycle, des counts et des codes fermés, jamais companyId, ownerUserId,
runId, wakeId, state ou payload. Une indisponibilité persistante ouvre un incident unique ; aucun
log périodique bruyant sur `empty`/`busy` normal.

La mémoire process peut retenir au maximum 50 Promises/closures de handlers avec leur coordonnée
pseudonyme jusqu'à leur propre `finally`; ce n'est ni un cache durable ni un log. Le watchdog libère
le scheduler et ses timers, pas une I/O externe non annulable. La registry supprime ses références
au settle/shutdown de manière identity-safe ; ce résiduel borné est audité comme donnée owner-scopée
et repris dans les risques §11.

Le runbook décrit : flag OFF, lecture des métriques, preuve de dernier sweep, inspection
metadata-only du curseur, redelivery et rollback binaire. Une alerte se déclenche si le scanner est
ouvert et qu'aucun cycle réussi n'est observé au-delà de la fenêtre ci-dessus, ou si le lag dépasse
le SLO mesuré. Le seuil de santé de base est figé par le budget du scheduler ; le seuil de lag final
vient du canary.

## 9. Migrations, N-1 et cutover

### 9.1 Expand additive

- migrations historiques immuables ;
- migration table/contraintes/policies/fonctions, migration de validation, puis migration d'index
  concurrent sont trois artefacts append-only séparés ;
- `SET LOCAL lock_timeout='5s'` et `statement_timeout='30s'` sont posés en tête des migrations
  transactionnelles ; le runner de l'index impose ses timeouts hors transaction ;
- modèle Prisma `@@ignore` pour le curseur ; index/collation/partiel restent autorité SQL ;
- deux CHECK nommés sont ajoutés `NOT VALID`, après préflight lecture seule zéro violation :
  `agent_missions_jarvis_next_wake_finite_v1` exige NULL ou `isfinite(nextWakeAt)` ;
  `agent_missions_jarvis_terminal_without_wake_v1` exige `nextWakeAt IS NULL` pour les deux kinds
  `@1` en `completed|cancelled|failed_terminal`. `quarantined` reste explicitement hors de ce second
  CHECK : le writer N-1 de quarantaine conserve aujourd'hui l'index opaque et doit continuer à
  réussir ; l'annuaire l'exclut par statut ;
- l'immuabilité n'est pas maquillée en CHECK : une fonction/trigger additifs
  `guard_jarvis_run_temporal_immutability_v1` /
  `agent_missions_jarvis_temporal_immutability_v1`, `BEFORE UPDATE`, examinent OLD et NEW. Pour les
  deux kinds, tout OLD `definitionVersion=1` exige simultanément
  `NEW.definitionVersion IS NOT DISTINCT FROM OLD.definitionVersion` et
  `NEW.hardExpiresAt IS NOT DISTINCT FROM OLD.hardExpiresAt`, sinon `23514`. Une projection
  NULL->1 exige elle aussi hard inchangé, et 2->1 est refusé ; mutation simultanée ou séquence
  1->2 puis hard ne contourne donc pas le backstop. L'inventaire source certifié comprend exactement
  ce trigger plus les triggers historiques attendus ;
- une migration ultérieure exécute `VALIDATE CONSTRAINT` pour les deux CHECK et le certificat exige
  `convalidated=true`. Aucun UPDATE de réparation silencieux n'est dans ce train ; une violation
  de préflight bloque la release et produit un inventaire sans payload ;
- le contrôle exact `nextWakeAt === min(pendingWakes)` reste une postcondition domaine/admission,
  prouvée sur les versions supportées ; SQL ne parse pas le JSON métier.

### 9.2 Compatibilité N-1

Un binaire N-1 :

- continue à écrire la forme exacte avant/après expand ;
- ignore la nouvelle table, les fonctions et l'index ;
- ne voit aucune fonction v1 historique remplacée ;
- n'obtient aucun privilège table/colonne ; le rôle DB partagé reçoit les EXECUTE additifs après
  provisionnement, mais le binaire N-1 ne connaît ni n'appelle ces signatures ;
- reste sûr car le flag scanner est faux et les fonctions v1 naissent fermées.

Le harnais utilise le writer N-1 exact, sans helper N déguisé, dans quatre états : baseline, après
CHECK NOT VALID + trigger, après validation + index, puis après RLS/provision. Il couvre seed,
transition qui conserve/replanifie le wake, terminal qui le retire et quarantaine qui le conserve ;
chaque mutation attend exactement R+1/event et la forme row historique. La même postimage non vide
reste lisible par N-1 avant/après expand et n'est découvrable par le scanner N qu'après
provisionnement et ouverture explicite.

### 9.3 Provisionnement et certificat

Le release script :

1. exclut le curseur des grants DML génériques avant toute fenêtre d'interruption ;
2. normalise table **et grants colonne** pour tous les grantees ;
3. transfère/provisionne rôles et fonctions sous déployeur non-superuser avec `SET ROLE` contrôlé ;
4. attache le scrub société dans la même transaction, avant tout EXECUTE runtime (§4.5) ;
5. conserve les fonctions effect existantes et ajoute seulement la surface wake versionnée ;
6. exécute un certificat READ ONLY metadata-only avant et après déploiement.

Le certificat épingle inventaires/hashes de contraintes, policies, index et corps des sept fonctions
runtime + scrub, propriétaires, `SECURITY DEFINER`, `prokind/provolatile/proparallel/proisstrict/
proleakproof`, proconfig exact et cardinalité, résultats, zéro overload, zéro trigger utilisateur sur
le curseur, triggers source attendus et l'unique scrub sur `companies`, sans parasite ; ACL,
grantors, memberships SET-only, privilège `MAINTAIN`, schéma et absence de grant option. Il rejoue
`rls.sql`, vérifie source **et** curseur ENABLE/FORCE RLS, policies exactes, et fait les probes
d'accès avec `WHERE FALSE`, sous timeouts, jamais un scan global.

### 9.4 Cutover froid

Ordre obligatoire :

1. déployer N avec flag wake `false` ;
2. appliquer expand/index/provision/certificat sur staging non-superuser au SHA exact ;
3. exécuter le vertical PG et le smoke métriques flag fermé ;
4. obtenir le GO fondateur et la contre-signature de la matrice ;
5. ouvrir le scanner sur un canary staging, mesurer lag/erreurs et vérifier une expiration de
   proposition réelle sans mutation métier ;
6. seulement ensuite élargir ; rollback = flag `false`, attente des admissions déjà startées, reset
   CAS puis certificat curseur idle. Un rollback binaire N-1 est **interdit** tant que ce reset n'a
   pas réussi ; table et reçus commités ne sont jamais supprimés ;
7. aucune production avant la même preuve de release et le gate §17.1 d'inventaire des workers.

## 10. Matrice d'acceptation binaire

### 10.1 Core et identité

- [ ] `pendingWakes` couvre les deux définitions, les phases valides et les states invalides.
- [ ] Ordre/tie UTF-8, unicité wakeId, dates ISO finies et égalité exacte avec `nextWakeAt`.
- [ ] Tests snapshot des reducers `@1` inchangés, y compris leurs drafts historiques de no-op ; la
      frontière pure seule les classe avant persistance.
- [ ] `committed` implique toujours R+1 ; `ignored(wake_not_due)` conserve la même postimage, les
      mêmes wakes et zéro intent. Toute autre forme égale/incohérente est refusée.
- [ ] Vecteurs UUID v8 et HMAC wake figés ; run/wake/dueAt/révision/commande distincts divergent,
      tandis qu'un ignored exact garde la même identité jusqu'à l'échéance.
- [ ] Vecteurs, HMAC, ordre de validation et reçus effect v1 restent byte/behavior-stables ;
      recalcul commandId et fingerprint métier complet restent explicitement U1-o.

### 10.2 Admission et PostgreSQL réel

- [ ] Wake exact mais prématuré : `ignored(wake_not_due)`, zéro UPDATE, event, reçu, work item, idle
      refresh ou release de foreground ; tous les octets du run et les tests v1 restent identiques.
- [ ] Wake inconnu, déjà consommé, ancienne échéance ou binding auto-cohérent mais non autoritaire :
      `system_command_binding_mismatch` ou `stale_revision`, zéro-write ; jamais `ignored`.
- [ ] Le même wake devenu dû committe exactement R+1 et nettoie/replanifie `nextWakeAt` selon le
      state, sans créer de work item.
- [ ] Réponse perdue après commit puis admission OFF ou société fermée : replay exact zéro-write ;
      replay wake ne re-stampe jamais un work item. Sans reçu, ces mêmes gates refusent le wake.
- [ ] Ancienne échéance/révision puis nouvelle génération du même wake : identité distincte et
      vraie transition ; un ignored prématuré ne l'empoisonne pas.
- [ ] Wake avec dueAt fourni différent du wake autoritaire sous verrou :
      `system_command_binding_mismatch`, zéro write, même si son UUID est auto-cohérent.
- [ ] Autorité owner/capability révoquée ou divergente : aucun reçu n'est révélé/rejoué avant les
      verrous et la preuve du principal.
- [ ] Deux scanners et une commande user autour du TTL : un seul CAS ; une cible Customer Contact
      verrouillée au-delà du TTL prouve que l'unique heure est lue après **tous** les verrous.
- [ ] Société fermée : wake neuf refusé, reçu wake exact rejoué ; société absente/run supprimé :
      stale/not-found sans invention.
- [ ] `nextWakeAt=infinity`, terminal U1 supporté avec wake et mutation de hard sont refusés par la
      DB ; le vrai writer N-1 de quarantaine avec wake continue à réussir et reste invisible à
      l'annuaire.
- [ ] Le trigger refuse hard+version mutés ensemble, `definitionVersion` 1->2 puis hard dans une
      seconde UPDATE, projection NULL->1 avec hard modifié et downgrade 2->1 ; hard inchangé passe.
- [ ] Une mutation retirant la branche `ignored`, avançant sa révision ou lisant l'heure pré-lock
      rend la suite rouge.

### 10.3 Annuaire PostgreSQL

- [ ] N=`2*limit+1`, timestamps identiques, plusieurs tenants et IDs discriminant `COLLATE C` :
      chaque coordonnée restant due est tentée en trois pages ACKées.
- [ ] Borne haute/cutoff : arrivées avant/après keyset, due déplacée, commit tardif ; aucune perte,
      seulement report au cycle suivant.
- [ ] Deux replicas : un gagnant, `busy` observable, redelivery suffixe exacte, positions absolues.
- [ ] Lease douce volable, hard non renouvelable, ancien token incapable de renew/start/ACK.
- [ ] Crash après start, dernière position/`ack_ready`, ACK post-hard courant et page 50 rejouée
      sous limite 25.
- [ ] Flag OFF juste après ACK intermédiaire : `reset_idle` CAS si le détenteur vit ; après crash et
      24 h, cleanup `reset_expired` sous flag toujours OFF efface after/upper/page sans avance.
- [ ] Suppression société avant expand, après expand/avant provision et après provision réussit ;
      l'état final invalide le claim et efface tous les identifiants du singleton.
- [ ] Panne coordonnée/tenant A n'empêche pas B ni les suivantes ; les fautives reviennent au cycle
      suivant.
- [ ] RLS/ACL/Data API/cross-tenant avec déployeur non-superuser ; zéro state/payload visible.
- [ ] Matrice négative : UUID lexical/nil/NULL, limite/position, stale token/révision, arrays vides et
      invalides (borne 0, 2D, NULL, tail/dimensions), tail égal/antérieur à after, TTL/hard infinis,
      tuples/hasMore incohérents et control rows malformées échouent avec le code exact, jamais en
      faux `empty`.
- [ ] Renew/start/ACK/reset rendent chacun exactement une ligne, booléen non NULL, champs nullable
      cohérents et révision post-opération ; zéro/multi-ligne, échéances partielles et booléen NULL
      sont refusés. Une révision d'ACK antérieure ne peut reset_idle après une page supplémentaire.
- [ ] Chaque geste utilise une transaction courte isolée ; verrou curseur détenu produit
      `55P03/unavailable` sous la borne puis un succès après libération, sans verrou pendant gateway.
- [ ] Catalogue index exact, valid/ready, collation/prédicat ; `EXPLAIN (ANALYZE, BUFFERS)` sur
      maximum **et** page sur volume représentatif avant toute revendication de SLO.

### 10.4 Scheduler et mobile

- [ ] Flag absent/false/valeur non exacte : zéro claim/renew/start/ACK/gateway ; seule la lane
      horaire `reset_expired` est permise et son CAS est testé. Hot true puis false au milieu d'une
      page => zéro nouveau start, ACK seulement si page complète sinon reset.
- [ ] Matrice exhaustive de tous les résultats système sans `default` ; `empty`, `busy`,
      `unavailable`, partial, saturation et shutdown ont des summaries exacts et labels bornés.
- [ ] Single-flight local, heartbeat série, deadline commune = min(tick, hard) moins trajet+5 s ;
      réponse claim retardée et perte heartbeat tardive donnent zéro suite/ACK.
- [ ] Registry réservation/Promise, cap 50, throw sync, late completion et shutdown sans timer ni
      mutation tardive du summary/ACK ; une admission DB déjà engagée reste arbitrée par son reçu.
- [ ] Module graph réel : un scheduler, le `JARVIS_ADMISSION` existant et l'adapter persistence
      unique ; dépendance absente => fail-closed, aucun cast permissif.
- [ ] Vrai run dû -> vrai scheduler -> gateway/UoW -> événement de proposition expirée ; deuxième
      tick zéro double révision.
- [ ] Mobile : cadence avant/après due, effet L7 prioritaire, erreur, arrière-plan et reprise.
- [ ] Deux hôtes utilisent une seule query/fetch ; aucune commande wake ne part du mobile.

### 10.5 Release et exploitation

- [ ] env/schema/example fermé, module graph, release order, N-1 writers à chaque état et cert
      metadata exacts ; matrice de flags et activation restent bloquées jusqu'au GO contre-signé.
- [ ] Métriques exposées, labels bornés, aucun identifiant ; `last_success` DB/multipod exact ;
      alerte testée après la grâce scanner ouvert sans série, busy-only, succès, multipod et silence
      flag fermé.
- [ ] Replay Supabase staging non-superuser au SHA exact, canary wake réel et rollback flag OFF.
- [ ] Inventaire §17.1 prouve un seul scanner wake et aucun timer autoritaire concurrent.
- [ ] Device/foreground vérifie la disparition des boutons/proposition périmée et la convergence de
      la carte vers le notice `preparing` autoritaire ; aucune promesse vocale nouvelle.

## 11. Definition of Done et risques restant honnêtes

U1-m n'est `implemented` que lorsque le vertical complet core -> annuaire -> scheduler -> gateway ->
PostgreSQL -> lecture API/mobile est appelé par le runtime et que tous les items 10.1–10.4 sont
verts. Un typecheck ou un cron enregistré mais flag fermé n'est pas cette preuve.

U1-m n'est `certified` que lorsque 10.5 est vert sur Supabase staging non-superuser au SHA exact.
Il n'est `released` qu'après le cutover froid et la preuve sur l'artefact servi.

Risques explicitement non levés par U1-m :

- les runs U1 v1 ne possèdent toujours pas de cycle de vie idle/hard exécutoire ; U1-n reste dû ;
- le fingerprint complet des commandes `effect_observation`, son train reader-first et son plancher
  de rollback restent U1-o ; U1-m ne certifie pas l'ACK historique de `command_conflict` effet ;
- le singleton global peut devenir un plafond de throughput ; l'index et le budget doivent être
  mesurés, pas supposés ;
- aucune équité stricte inter-tenant n'est revendiquée, seulement la non-famine keyset d'un
  ensemble fini sous hypothèses de DB/scheduler/tentatives éventuellement disponibles ;
- une I/O externe non annulable peut survivre à la Promise de contrôle ; si l'admission est déjà
  entrée dans sa transaction, son reçu/CAS conserve l'autorité d'écrire, mais le scheduler perd
  toute autorité locale de résumé/ACK ;
- l'horloge mobile n'est jamais une autorité et peut seulement retarder une relecture dans la
  borne de cadence ;
- une APK N-1 et le staging exact restent à inventorier avant activation ;
- la matrice de flags et le GO d'activation restent bloqués fondateur/contre-signature ; le code
  fermé ne vaut pas cette décision ;
- U1-n devra décider phase par phase le sort de prepared/authorized/outcome_unknown et maintenir
  la réconciliation d'un effet potentiellement parti.
