# ACCOUNT-DELETE-LIFECYCLE-01 — Clôture, effacement Auth et extinction des canaux

**Statut : `implemented`**  
**Objectif canonique : O7 — release reproductible et livrabilité stores**  
**Parent : `STORE-DELETE-01`, critères AC9 et AC10**  
**Date : 2026-08-02**  
**Environnement autorisé par ce lot : développement et tests ; aucun déploiement**

## 1. Objectif

Remplacer la suppression Supabase Auth post-commit et best-effort par un protocole de clôture
atomique, durable, idempotent et opérable, sans supprimer les pièces qui doivent être légalement
conservées.

Le résultat attendu de la requête authentifiée est une **clôture Bob Pro commise** et une
**demande durable de suppression d'identité**, pas la prétention que Supabase Auth a déjà répondu.
Un worker doit ensuite supprimer l'identité, reprendre toute panne, traiter `404` comme un succès
idempotent et minimiser le sujet Auth dès que l'opération est acquittée.

Ce train ferme également les deux capacités qui pourraient continuer à agir après la clôture :

1. les notifications email/push encore en attente ;
2. la création ou restauration d'une membership Cabinet pendant qu'une suppression Auth globale
   est engagée.

## 2. État réel avant lot

- `CloseAccount` pose `Company.closedAt`, annule l'abonnement et révoque les liens publics dans une
  transaction.
- `BackendService.closeAccount` purge ensuite les appareils et certaines traces, commit, puis
  appelle `SupabaseAdmin.deleteUser` hors transaction. Un échec réseau/5xx est seulement loggé et
  la requête renvoie malgré tout un succès ; aucun retry durable ne subsiste.
- `notification_jobs` n'est pas annulée. Ses claims et autorisations ne relisent pas
  `Company.closedAt`; une intention ancienne peut donc encore être autorisée.
- même après purge de `payload`, `notification_jobs.recipient` et `subject` peuvent conserver une
  adresse email ou un contenu personnel.
- `DELETE /account` fait confiance au scalaire JWT `app_metadata.company_id`. `Company` ne porte
  aucune ownership et la route ne prouve pas que `companyId = company-<sub>`.
- un même sujet Supabase peut avoir plusieurs `CabinetMember`. Supprimer ce sujet sans garde peut
  orpheliner plusieurs cabinets, y compris leur dernier administrateur.
- les logs `account.closed` et `auth.user_deleted` contiennent actuellement le `userId` brut.
- `ScheduledTenantDirectory` n'est pas une source de retry fiable : sous le rôle runtime sans GUC,
  la RLS peut rendre la liste globale vide, et une valeur `JOB_COMPANY_IDS` incomplète omettrait les
  tenants clôturés.

## 3. Portée

### Inclus

- binding propriétaire V1 canonique `company-<userId>` à l'onboarding et à la clôture ;
- refus atomique de clôture lorsqu'une membership Cabinet non révoquée existe ;
- verrou lifecycle commun au sujet Auth pour sérialiser suppression et mutations Cabinet ;
- outbox tenantée `auth_user_deletion_jobs`, créée dans la transaction de clôture ;
- capacité globale bornée `SECURITY DEFINER` pour claim/ack/retry, possédée par une autorité
  `NOLOGIN`, sans scan global accordé au rôle runtime ;
- worker borné, leases récupérables, backoff plafonné et absence de dead-letter silencieuse ;
- annulation et minimisation transactionnelles des notifications du tenant ;
- fence `Company FOR SHARE` avant enqueue, claim, autorisation email et snapshot push ;
- purge transactionnelle des appareils et traces déjà couvertes ;
- retrait des identifiants Auth bruts des logs du parcours ;
- migration additive, writer N-1, RLS/ACL non-superuser et tests de concurrence ciblés ;
- mise à jour honnête de la spec web et du rapport de lancement.

### Non-objectifs de ce train

- supprimer ou anonymiser toutes les catégories Postgres/Storage ;
- trancher seul la base légale et la durée de chaque document, log, sauvegarde ou sous-traitant ;
- créer l'outil opérateur de vérification d'identité pour les demandes email ;
- envoyer une confirmation finale durable après suppression Auth ;
- corriger les placeholders de l'identité légale, du support et des sous-traitants ;
- déployer en staging/production, modifier les consoles Apple/Google ou déclarer AC9/AC10 certifiés ;
- introduire le futur modèle multi-utilisateur `CompanyMember(owner|member)` ; la bêta reste
  volontairement mono-propriétaire.

## 4. Invariants

### I1 — Autorité propriétaire fail-closed

Pour la bêta, une société supprimable par l'application a exactement l'identifiant
`company-${userId}`. Un claim JWT non canonique est refusé avant toute mutation. Les couples legacy
ne sont jamais auto-rattachés : ils exigent une vérification opérateur distincte.

### I2 — Aucun cabinet orphelin

La demande acquiert un verrou transactionnel déterministe sur le sujet Auth, puis refuse si une
membership Cabinet `active` ou `suspended` existe. Les `INSERT`, restaurations et changements vers
un statut non révoqué acquièrent le même verrou et refusent lorsqu'une demande de suppression
existe. Une membership gagnante fait échouer la clôture ; une suppression gagnante fait échouer la
membership. Il n'existe aucune fenêtre lecture-puis-écriture non protégée.

### I3 — Un seul commit métier

Sous le verrou exclusif `Company`, les effets suivants réussissent ensemble ou sont tous annulés :

- `closedAt` et motif éventuel ;
- abonnement `canceled` ;
- liens publics révoqués ;
- demande Auth durable ;
- notifications non livrées annulées et contenu personnel minimisé ;
- appareils supprimés ;
- traces vocales effaçables supprimées.

Un échec de n'importe quel effet laisse la société ouverte et aucune demande Auth commise.

### I4 — Réparation idempotente

Un second appel authentifié correctement confirmé sur une société déjà clôturée rejoue les
extinctions idempotentes et retrouve la même demande par `(provider, subjectHash)`. Il ne crée ni
second job, ni nouveau `closedAt`. Cette propriété répare une clôture historique tant que
l'identité Auth permet encore l'appel.

### I5 — Identité transitoire et minimisée

L'outbox ne stocke ni email, ni téléphone, ni metadata, ni réponse fournisseur. Elle conserve un
champ `userId` séparé uniquement tant que Supabase doit être appelé. Au succès, ce champ devient
`NULL` ; le reçu conserve un hash SHA-256 séparé par domaine, l'identifiant du job, la société, les
dates et le nombre d'essais. Le hash **et** le `companyId` historique `company-<userId>` restent des
données pseudonymes permettant de relier le sujet ; ils doivent figurer dans la matrice RGPD et ne
sont jamais présentés comme anonymes. Ce lot minimise l'outbox, il ne prétend pas rendre le graphe
tenant anonyme.

`lastErrorCode` appartient à une liste fermée. Aucun message, corps HTTP, stack, secret ou sujet
Auth ne peut entrer dans la table, les logs ou les métriques.

### I6 — Retry durable et équitable

États autorisés :

```text
pending -> pending (lease)
pending|failed -> done
pending|failed -> failed -> pending|failed (nouveau lease)
```

- `2xx` et `404` Supabase sont des succès ;
- réseau, timeout, `408`, `429`, tout `4xx`, tout `5xx`, configuration et erreur inconnue restent
  dus avec backoff borné ; il n'existe pas de terminal silencieux ;
- le claim utilise `FOR UPDATE SKIP LOCKED`, une lease et l'horloge PostgreSQL ;
- ack/retry sont des CAS sur le token exact ;
- une lease expirée est réclamable ;
- une page contient au plus 10 jobs : même à 12 s de timeout provider par job, le traitement
  séquentiel reste nettement sous la lease PostgreSQL de 5 minutes ;
- une page claimée est entièrement tentée. Un échec A déplace A à sa prochaine échéance et ne
  bloque jamais B ;
- le scheduler ne dépend ni de `JOB_COMPANY_IDS`, ni d'une lecture globale de `companies`.

### I7 — Extinction des notifications

À la clôture, tout job `pending|failed`, y compris loué ou quarantiné, devient `cancelled`. Pour
tous les statuts du tenant, `payload`, `recipient`, `subject`, `payloadFingerprint`, `leaseToken`
et `lastError` sont purgés ou remplacés par une sentinelle non personnelle. Un worker portant une
ancienne lease ne peut plus `markDone` ni `markFailed`.

Chaque capacité notification prend `Company FOR SHARE` avant le job/device. Aucun enqueue, claim,
autorisation email ou autorisation push dont le point de linéarisation est postérieur au commit de
clôture n'est accepté. Un appel réseau déjà autorisé avant le commit peut finir après celui-ci : le
lot ne maintient volontairement pas une transaction PostgreSQL ouverte pendant Brevo/Expo. Cette
limite est documentée et testée, jamais décrite comme un zéro-réseau absolu.

### I8 — RLS et autorité minimale

- table avec `ENABLE` et `FORCE ROW LEVEL SECURITY` ;
- runtime tenant : uniquement la capacité d'enqueue idempotente nécessaire ;
- runtime global : uniquement `EXECUTE` sur les fonctions bornées de claim/ack/retry ;
- autorité dédiée `NOLOGIN`, `NOSUPERUSER`, `NOBYPASSRLS`, sans membership runtime ;
- `PUBLIC`, `anon`, `authenticated` et `service_role` explicitement révoqués ;
- aucun `DELETE` ou `TRUNCATE` runtime ;
- fonctions `SECURITY DEFINER` avec `search_path=pg_catalog`, `row_security=on`,
  `statement_timeout` et `lock_timeout` ;
- certification réelle comme déployeur puis rôle runtime non-superuser sur Supabase staging avant
  toute promotion.

### I9 — Compatibilité N-1

La migration est additive et n'impose pas de colonne nouvelle à un ancien writer. Le test N-1
exécute la forme exacte `PrismaCompanyRepository.save` de l'ancien writer sous l'état expand final.
Le trigger `Company` reste autonome : sans preflight O7, il crée lui-même le reçu durable et
annule/minimise les notifications dans la transaction de clôture. Le train de release reste fermé
tant que le replay Supabase staging ne prouve pas qu'aucune requête N-1 ne peut être perdue pendant
le remplacement des instances.

## 5. Protocole transactionnel réellement implémenté

Pour une société encore ouverte, l'adaptateur pose d'abord des timeouts PostgreSQL locaux, puis
appelle `request_auth_user_deletion_v1` dans **la même transaction tenantée** que `CloseAccount` :

1. la RPC vérifie le binding propriétaire, verrouille `Company` et le sujet Auth, puis refuse toute
   membership Cabinet active/suspendue ;
2. tant que `Company.closedAt` est nul, elle **n'insère aucune outbox** : elle place seulement le
   `requestId` corrélé dans deux GUC transaction-locales ;
3. la transition réelle `closedAt: NULL -> valeur` déclenche
   `enqueue_auth_user_deletion_on_company_close_v1`, qui crée/retrouve le job, annule et minimise
   les notifications ; sans transition dans cette transaction, aucun nouveau job n'est commis ;
4. un writer N-1 qui ne connaît pas la preflight est couvert par le même trigger autonome ;
5. une société déjà clôturée suit la branche de réparation idempotente et recrée uniquement le job
   historique manquant ;
6. le claim global ne sélectionne que des sociétés clôturées, utilise `FOR UPDATE SKIP LOCKED`, puis
   `complete` et `retry` appliquent un CAS sur la lease exacte.

Cette séquence ferme le cas dangereux « RPC acceptée sans clôture, puis identité supprimée ». Elle
ne transforme pas pour autant la candidate locale en release : le déploiement et la preuve
exact-SHA restent des gates distincts.

## 6. Schéma normatif

`auth_user_deletion_jobs` contient au minimum :

| Colonne | Contrat |
| --- | --- |
| `id UUID` | clé primaire immuable |
| `companyId TEXT` | FK `companies`, `ON DELETE RESTRICT`, `ON UPDATE CASCADE` |
| `provider TEXT` | valeur fermée `supabase` |
| `userId TEXT NULL` | sujet externe brut, présent seulement tant que le job est dû |
| `subjectHash CHAR(64)` | SHA-256 séparé par domaine, unique avec provider |
| `status TEXT` | `pending`, `failed`, `done` |
| `attempts INTEGER` | nombre de claims fournisseur, positif ou nul |
| `nextAttemptAt TIMESTAMPTZ(6)` | échéance de retry ou de lease |
| `leaseToken UUID NULL` | fence du worker courant |
| `lastErrorCode TEXT NULL` | classe fermée, jamais un message |
| `completedAt TIMESTAMPTZ(6) NULL` | obligatoire uniquement pour `done` |
| `createdAt`, `updatedAt` | horloge PostgreSQL |

Contraintes :

- `(provider, subjectHash)` unique et `companyId` unique pour le modèle mono-propriétaire V1 ;
- `pending|failed` implique `userId NOT NULL` et `completedAt IS NULL` ;
- `done` implique `userId IS NULL`, `completedAt NOT NULL`, lease et erreur nulles ;
- index partiel dû sur `(nextAttemptAt, createdAt, id)` pour `pending|failed` ;
- aucun FK vers `auth.users`, qui n'est pas une table métier Bob Pro.

## 7. Critères d'acceptation binaires

| ID | Critère | Preuve attendue |
| --- | --- | --- |
| AC1 | Un claim non canonique est refusé à l'onboarding et à la clôture sans effet. | Tests API ; audit legacy préalable au rollout. |
| AC2 | Membership active/suspended bloque la clôture ; revoked-only l'autorise ; les courses membership/suppression sont linéarisées. | Tests unitaires + PostgreSQL à deux connexions. |
| AC3 | Fermeture, outbox, annulation/minimisation notifications, appareils et traces committent ou rollbackent ensemble. | Tests in-memory + PostgreSQL. |
| AC4 | Un retry de clôture retrouve le même job et conserve le premier `closedAt`. | Tests core/API et contrainte unique. |
| AC5 | Le worker reprend crash/lease expirée ; deux workers n'acquièrent jamais la même génération. | Tests worker + PostgreSQL. |
| AC6 | `204/404` donnent `done` et nullent `userId`; toutes les autres classes restent dues avec backoff borné. | Tests adapter et worker. |
| AC7 | Une panne tenant A n'empêche pas le traitement tenant B et aucune discovery ne dépend de la config des tenants. | Test de page globale bornée. |
| AC8 | Clôture A annule seulement A, purge le contenu personnel et invalide toute ancienne lease ; B reste intact. | Tests repository mémoire/Prisma. |
| AC9 | Aucun enqueue/claim/fence email/push post-clôture n'est autorisé ; indisponibilité DB échoue fermée sans I/O. | Tests service + courses PostgreSQL. |
| AC10 | Migration expand respecte timeouts, writer N-1 et forme finale ; CHECK/enum TypeScript ne dérivent pas. | Certificat PostgreSQL ciblé. |
| AC11 | RLS/ACL empêchent lecture/mutation cross-tenant et Data API ; le runtime n'a que les RPC requises. | Certificat non-superuser + release ACL. |
| AC12 | Aucun champ `userId` séparé, email, message fournisseur ou secret n'apparaît dans logs/erreurs/reçus du parcours ; le `subjectHash` et le `companyId` pseudonymes restants sont explicitement routés vers `STORE-DELETE-01/AC10` et la matrice RGPD. | Tests logger/reçus/routage locaux ; matrice RGPD complète requise seulement pour `certified`. |
| AC13 | Typecheck, tests ciblés puis tests API/core plus larges passent depuis le SHA courant. | Sorties de commandes datées. |
| AC14 | AC9–AC10 de `STORE-DELETE-01` restent non certifiés tant que runbook, confirmation, matrice RGPD et preuves d'environnement manquent. | État des specs/rapport cohérent. |

## 8. Definition of Done

Le train passe à `implemented` uniquement lorsque AC1–AC13 sont reproductibles localement ou dans
le certificat PostgreSQL prévu, sans déploiement et sans régression des suites core/API.

Il ne peut passer à `certified` qu'après :

1. replay de la migration et certificat non-superuser sur Supabase staging ;
2. audit des bindings legacy `auth.users.sub/app_metadata.company_id` ;
3. exercice d'une demande réelle, du runbook opérateur et de la confirmation finale ;
4. matrice AC10 complète (Postgres, Storage, logs, sauvegardes, sous-traitants), validation
   juridique/fondateur et politique publique exacte ;
5. preuve exact-SHA staging puis production, conformément à `PR -> staging validé -> production`.

L'existence du code, un typecheck vert ou un appel Supabase simulé ne suffisent jamais.

## 9. Preuves d'implémentation locale — 2026-08-02

- certificat PostgreSQL O7 : **5/5**, avec runtime non-superuser, preflight sans ligne, writer N-1
  exact, `SKIP LOCKED`, lease/retry CAS, clôture/réparation et courses Cabinet dans les deux sens ;
- suites PostgreSQL voisines adaptées au binding canonique : **32/32**
  (`company-mutation` 12, `public-capability` 15, `invoice-issue` 5) ;
- garde release canonique : **640 pass, 0 fail, 1 skip**, puis sous-gate M2A3
  **83 pass, 0 fail, 1 skip** ; le test O7 est importé par le gate déjà exécuté en CI ;
- tests ciblés core/API/adaptateurs/worker/notifications : **verts**, y compris `204/404`, toutes
  les classes retryables, invalidation des anciennes leases et fences email/push fail-closed ;
- ACL adversariales : `MAINTAIN` accordé à l'autorité ou au runtime fait échouer le certificat ;
  la configuration nominale rôle → migration → grants/RLS → certificat repasse verte ;
- TypeScript, SQL et tests de sécurité vérifient la même liste d'états, les mêmes codes d'erreur,
  le même binding `company-<userId>` et le même hash de sujet.

Ces preuves portent sur le worktree local non committé, pas sur `main`, Supabase staging ou la
production. Elles justifient uniquement `implemented`.

## 10. Blocages conservés

- `[BLOQUÉ FONDATEUR : identité légale et adresse support de marque]`
- `[BLOQUÉ FONDATEUR : accès Play Console / App Store Connect et validation Data Safety]`
- `[BLOQUÉ FONDATEUR/JURIDIQUE : matrice de rétention, sauvegardes et sous-traitants]`
- `[BLOQUÉ OPÉRATIONS : boîte support vérifiée, runbook d'identité et confirmation finale durable]`
- `[BLOQUÉ CERTIFICATION : replay Supabase staging et audit des bindings Auth legacy]`
