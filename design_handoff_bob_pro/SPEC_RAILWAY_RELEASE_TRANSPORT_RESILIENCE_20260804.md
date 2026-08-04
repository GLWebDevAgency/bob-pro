# SPEC O7 — Transport de déploiement Railway résilient

**Statut :** `implemented`
**Objectif canonique :** O7 — release reproductible
**Date :** 4 août 2026
**Incident source :** workflow staging `30921527702`, SHA
`3af32e1230e168866b60f2b125ce0764d16c69d6`

## 1. Objectif

Une release ne doit pas échouer parce que le flux de logs attaché du CLI Railway est interrompu
après que l'upload a été accepté. Le déploiement est identifié par son UUID autoritaire, attendu
jusqu'à un état terminal via l'API Railway, puis rapproché du déploiement réellement servant avant
la readiness au SHA exact.

Le 4 août 2026, Railway a créé le déploiement
`7c7e7a74-d994-4e9f-871d-2446a969df85`, qui a atteint `SUCCESS`, mais `railway up` a quitté avec
`Failed to stream build logs: Failed to retrieve build log`. La CI s'est arrêtée avant l'audit
archive, l'activation et le postdeploy alors que l'API saine servait déjà le bon SHA. Le flux de
logs n'est donc pas une autorité de publication.

## 2. Périmètre

### Inclus

- upload Railway détaché avec sortie JSON bornée à un `deploymentId` UUID ;
- attente bornée de ce déploiement exact via GraphQL Railway ;
- validation stricte de `projectId`, `environmentId` et `serviceId` à chaque poll ;
- rapprochement avant mutation des IDs Railway avec les noms d'environnement/service attendus ;
- refus de tout état inconnu ou terminal en échec ;
- certification qu'une seule réplique sert et qu'elle correspond au déploiement attendu ;
- readiness HTTPS au SHA et à l'environnement exacts, conservée comme autorité applicative ;
- absence d'erreur secondaire d'artefact quand l'audit n'a jamais démarré ;
- chemin de reprise staging manuel et explicite lorsqu'un déploiement Railway terminal en échec
  est plus récent que l'unique réplique saine ;
- réutilisation du même contrat de déploiement par les opérateurs staging existants.

### Exclus

- aucune mutation métier, fiscale ou documentaire ;
- aucune modification des données staging ou production ;
- aucune activation Bob Live ou Archive hors du workflow canonique ;
- aucune relance automatique d'un upload dont l'acceptation est ambiguë ;
- aucune quarantaine ou suppression des objets Storage historiques.

## 3. Invariants

1. `railway up --detach --json` est la seule commande qui crée un déploiement dans le rituel.
2. Un UUID absent, ambigu ou mal formé arrête la release avant tout poll.
3. Le poll n'accepte `SUCCESS` que pour le même projet, environnement, service et déploiement.
4. Un UUID tout juste créé est recherché pendant au plus 60 secondes via la connexion paginée
   `deployments`, sans hypothèse d'ordre. Chaque page et curseur est borné, chaque nœud doit porter
   l'identité project/environnement/service exacte, et une pagination tronquée ou dupliquée échoue
   fermée. Après sa découverte, seul `deployment(id)` suit son état ; toute disparition ou
   divergence d'identité échoue immédiatement.
5. `BUILDING`, `DEPLOYING`, `INITIALIZING`, `QUEUED` et `WAITING` sont les seuls états transitoires.
6. Tout état inconnu ou terminal en échec ferme la release ; aucun retry d'upload n'est implicite.
7. Les appels GraphQL ont une deadline monotone partagée, une taille de réponse maximale, un
   backoff exponentiel et respectent `Retry-After` borné à 60 secondes. Une indisponibilité de
   lecture reste dans le polling du même UUID ; elle ne crée jamais un autre déploiement.
8. En release normale, `latestDeployment` doit être exactement l'unique déploiement actif sain
   avant toute commande `railway run`, puis `latest == active == UUID créé` avant l'audit, avant
   activation et avant postdeploy. Un latest plus récent même terminal interdit toute mutation.
9. La readiness doit encore prouver `ready=true`, le SHA exact et l'environnement exact ; un
   `SUCCESS` Railway seul n'est jamais une preuve applicative.
10. L'enveloppe d'audit est exigée uniquement si l'étape d'audit a effectivement démarré. Un échec
    antérieur reste unique et lisible.
11. `release-recovery` est un chemin staging uniquement, déclenchable seulement par dispatch manuel
    direct de `railway-api.yml` sur `main`. `github.workflow_ref` doit être celui de ce workflow —
    propager `workflow_dispatch` depuis un workflow appelant ne suffit pas. Il autorise avant upload
    un `latest` distinct uniquement s'il est terminal, non servant, et si l'unique `active` reste
    sain. Il re-prouve immédiatement les IDs, la topologie, l'environnement et la paire de bases
    avant les migrations. Dès le nouvel upload, toutes les preuves redeviennent strictes sans
    exception. Un appel réutilisable, une cible production, une autre ref ou un latest transitoire
    sont refusés. L'audit, les activations et le postdeploy restent intégralement obligatoires.

## 4. Critères d'acceptation binaires

- [x] Le parser accepte uniquement une sortie JSON portant un `deploymentId` UUID canonique.
- [x] Le waiter converge de chaque état transitoire vers `SUCCESS` pour l'identité exacte.
- [x] Une inscription GraphQL retardée converge par pagination sans second upload ; page/cursor
      invalide, doublon, mauvaise identité, troncature ou absence durable échoue fermé.
- [x] `Retry-After`, le backoff et la deadline absolue sont testés sans retry d'upload.
- [x] Une identité différente, un état inconnu, un état terminal en échec ou un timeout échoue fermé.
- [x] Les erreurs HTTP transitoires sont rejouées de façon bornée ; les erreurs permanentes ne le
      sont pas.
- [x] Le workflow déploie en mode détaché et attend l'UUID exact sans dépendre du streaming de logs.
- [x] La certification de topologie rapproche l'UUID servant de l'UUID créé par la release.
- [x] La cible est re-probée par project/environment/service IDs immédiatement avant le prédeploy,
      et les deux `railway run` utilisent seulement ces IDs avec `--no-local`.
- [x] Ce rapprochement exact est rejoué après l'audit, avant activation puis avant postdeploy.
- [x] La release normale refuse `latest != active`. Le recovery staging manuel accepte seulement
      un latest terminal non servant, puis revient au contrat strict après upload ; routage,
      environnement et refus via `workflow_call` sont testés.
- [x] La readiness SHA/environnement reste bloquante avant audit et activation.
- [x] Un audit non démarré ne crée pas une seconde erreur `No files were found`.
- [x] Les tests de contrat du workflow empêchent le retour à un `railway up` attaché.
- [x] Les suites ciblées, la suite API complète, le typecheck, le lint et le build API passent.
- [ ] La CI complète de la PR passe.
- [ ] Un nouveau workflow staging au SHA mergé termine audit, activation et postdeploy.

## 5. Blocage explicite de promotion production

`[BLOQUÉ FONDATEUR : GO de promotion production + provisioning/certification des variables GitHub
production]`

Au 4 août 2026, l'environnement GitHub `production` porte uniquement `API_BASE_URL` et
`RAILWAY_API_SERVICE`. Il ne porte pas `RAILWAY_PROJECT_ID`, `RAILWAY_ENVIRONMENT_ID`,
`RAILWAY_API_SERVICE_ID` ni `RAILWAY_ARCHIVE_AUDIT_SERVICE_ID`, alors que le rituel exige une cible
par UUID. Les valeurs Railway sont observables, mais elles ne seront installées qu'après validation
staging et GO de promotion, conformément à la loi `PR → staging validé → production`. Aucune
compatibilité production n'est revendiquée avant ce preflight réel.

## 6. Definition of Done

- `implemented` : module partagé, workflow et tests présents sur une PR atomique ;
- `certified` : CI complète verte et déploiement Railway testé avec identité exacte ;
- `released` : workflow staging canonique vert, `/health/ready` au SHA mergé, audit archive vert,
  activation et postdeploy terminés avec receipts non-PII.
