# SPEC P0 — Reprise Archive sur métadonnées Storage autoritatives

**Statut :** `implemented`
**Objectifs canoniques :** O2 — facturation conforme et complète ; O7 — release reproductible
**Parent :** `SPEC_DOCUMENT_ARCHIVE_TRANSACTION_BOUNDARY_RELEASE_A_20260804.md`
**Date :** 9 août 2026
**Environnement autorisé avant merge :** tests locaux uniquement ; aucune mutation staging

## 1. Objectif

Un retry d'archive doit adopter un objet Supabase strictement identique même lorsque l'en-tête HTTP
du téléchargement est générique ou réécrit par la chaîne de distribution. L'intégrité des octets
reste prouvée par taille et SHA-256 calculés après téléchargement ; le type MIME est relu depuis la
métadonnée objet autoritative de Supabase. Une divergence réelle d'octets, de taille ou de
métadonnée reste un conflit fermé : aucune clé n'est écrasée ni supprimée.

Le lot doit également faire converger le job facture staging déjà dû vers une archive complète,
sans modifier son snapshot, ses intentions, ses clés ou ses octets scellés.

## 2. Incident prouvé

Sur staging, un job `invoice-issued` a scellé un XML Factur-X et un PDF, puis s'est arrêté après
trois tentatives :

- la première tentative a publié l'XML puis a échoué sur
  `Supabase storage read-after-write integrity mismatch` ;
- les suivantes ont échoué sur `Document object key collision with different content` ;
- le PDF n'a jamais été publié et aucune représentation de cette facture n'a été matérialisée en
  `documents` ; le job reste `failed` et dû ;
- l'XML présent a exactement la taille et le SHA-256 de l'intention durable ;
- `GET /storage/v1/object/...` le sert avec `Content-Type: text/plain` ;
- `GET /storage/v1/object/info/...` porte bien `content_type: application/xml` et la taille exacte.

La collision est donc fausse : les adapters runtime et audit traitaient l'en-tête de téléchargement
comme métadonnée autoritative. `put` refusait ensuite l'objet pourtant byte-identique et l'audit de
release aurait rejeté le même XML.

## 3. Portée

### Inclus

- adapters Supabase du runtime documentaire et de l'auditeur Archive V2 ;
- type MIME issu de `/object/info`, taille et SHA-256 issus des octets réellement téléchargés ;
- cohérence fail-closed entre taille téléchargée et taille autoritative ;
- budget réseau composite : téléchargement et métadonnée partagent la même échéance ;
- adoption idempotente d'un objet byte-identique malgré un en-tête GET générique ;
- tests de contrat du premier upload, du retry, des métadonnées invalides et des collisions réelles ;
- audit V2 rouge sur un ordre d'archive incomplet au-delà de trois cadences cron (15 minutes),
  sans rendre aléatoirement rouge un enqueue frais dû, une lease active bornée ou un retry `failed`
  futur borné ;
- égalité exacte entre la preuve d'un job terminé et sa projection relationnelle d'artefacts ;
- reprise opérationnelle du job staging existant après déploiement canonique ;
- audit Archive V2 final avec zéro objet manquant, zéro orphelin et zéro P0.

### Exclus

- aucune migration ou modification de schéma ;
- aucun changement de snapshot, d'intention, de clé ou de renderer ;
- aucun upsert, renommage, effacement ou quarantaine d'objet ;
- aucune mutation de production ;
- aucun changement au lot suppression de compte O7 non committé dans l'arbre principal ;
- aucun changement aux flags Bob Live/Mission dans cette PR.

## 4. Invariants

1. Le SHA-256 et la taille de `LoadedStoredObject` sont calculés depuis les octets téléchargés ; une
   métadonnée distante ne peut jamais les remplacer.
2. Le type MIME retourné par les adapters vient de l'endpoint objet `info`, jamais du seul en-tête
   du téléchargement.
3. Une lecture objet réussie suivie d'une métadonnée absente, malformée, syntaxiquement invalide
   ou d'une taille différente échoue fermé avec une cause explicite.
   Un timeout/abort de lecture conserve sa cause réseau et n'est jamais maquillé en JSON invalide.
4. Une absence objet ne déclenche pas d'interprétation de métadonnée comme présence.
5. `put` reste `x-upsert: false`. Un retry adopte seulement clé, octets, taille, SHA et MIME exacts.
   Le MIME sortant est validé avant le premier appel réseau ; une valeur invalide ne peut donc pas
   publier une clé immuable impossible à relire.
6. Un même nombre d'octets avec un SHA différent reste une collision fatale, sans `DELETE`.
7. Le job existant peut re-rendre uniquement depuis son snapshot scellé. Les intentions
   append-only déjà préparées doivent rester strictement identiques ; toute divergence échoue avant
   Storage et aucune nouvelle identité d'artefact n'est scellée.
8. La correction ne baisse aucun contrôle de `loadVerifiedStoredObject` et ne normalise que les
   paramètres MIME déjà autorisés (`; charset=...`).
9. Un `get` conserve un budget total de 15 secondes : la lecture `/object/info` reçoit uniquement
   le reliquat après téléchargement, jamais une seconde fenêtre complète.
10. Un `pending` frais et déjà dû, une lease `failed` active de 30 minutes au plus, ou un retry
    `failed` sans lease planifié dans les 24 heures est un état opérationnel normal. Un `pending`
    futur, le sentinel, une lease/reprise hors plafond, un scope invalide ou un job toujours
    incomplet 15 minutes après son échéance de reprise est immédiatement refusé selon sa cause.
11. Pour tout job `done`, la projection `document_archive_job_artifacts` reproduit exactement la
    cardinalité et les neuf champs de chaque artefact de la preuve ; absence, surplus ou divergence
    rend l'audit rouge.
12. La certification ne peut pas être rendue verte par un kick ponctuel : le scheduler durable doit
    reprendre le job dû dans sa cadence normale, sans mutation manuelle de sa ligne ou de ses objets.
13. La séquence octets puis métadonnée peut observer une suppression administrative concurrente ;
    ce cas échoue fermé. `x-upsert:false` et l'absence de `DELETE` runtime empêchent le remplacement
    silencieux d'une clé par ce lot.

## 5. Critères d'acceptation binaires

- [ ] Un GET d'octets exacts avec en-tête `text/plain`, suivi d'un `info` exact
  `application/xml`, retourne un objet vérifié `application/xml`.
- [ ] Le même scénario dans `put` adopte l'objet avec `created=false`, sans POST ni DELETE.
- [ ] Un premier upload `absent -> POST -> GET text/plain + info application/xml` retourne
  `created=true` et le SHA réel.
- [ ] Une réponse `info` absente, malformée ou dont la taille diffère des octets échoue fermé.
- [ ] `; charset=...` sans type/sous-type et `not-a-mime` sont refusés ; un MIME valide avec
  paramètre `charset` est conservé ; wildcard, contrôle, paramètre vide/inconnu/dupliqué sont refusés.
- [ ] Un MIME sortant invalide est refusé avant tout GET/POST, dans l'adapter live et son double de
  test ; aucun objet orphelin ne peut être publié par ce chemin.
- [ ] Le téléchargement et sa lecture `info` utilisent une seule échéance de 15 secondes, prouvée
  par un test déterministe du budget restant.
- [ ] Une collision byte-différente, même taille et même MIME, reste refusée sans effacement.
- [ ] L'auditeur de release reproduit le cas terrain `GET text/plain + info application/xml` et
  valide les octets avec `application/xml` ; il refuse une métadonnée absente ou divergente.
- [ ] Un `pending` frais et dû, une lease `failed` ≤ 30 minutes ou un retry `failed` sans lease
  ≤ 24 heures ne bloque pas ; un scope invalide, un `pending` futur, le sentinel, une échéance hors
  plafond ou le même ordre encore incomplet 15 minutes après `nextAttemptAt` rend le rapport V2
  rouge avec `ARCHIVE_PROTOCOL_V2_JOB_PROOF_INVALID`, même si ses objets existent dans Storage.
- [ ] Un ordre `done` sans preuve/hash/horodatage valides ou dont la projection d'artefacts est
  absente/divergente rend le même rapport rouge.
- [ ] Un test PostgreSQL réel exécute le prédicat exact avec job frais, lease active, retry futur,
  job en retard, job terminé valide et projection supprimée/divergente.
- [ ] Les tests Storage existants (timeouts, ACK perdu, concurrence, signed URL, stat, delete)
  restent verts et les séquences HTTP attendues incluent la lecture metadata nécessaire.
- [ ] Les suites API ciblées Archive et Document Storage, typecheck, lint et build API passent
  depuis un checkout propre.
- [ ] Revue adversariale indépendante : aucun P0/P1 ouvert.
- [ ] Après merge et déploiement staging au SHA exact, le scheduler durable (sans kick manuel)
  reprend le job dû, qui passe à `done` avec exactement un XML, un PDF, leurs deux versions,
  l'attestation PDF et une preuve d'intégrité valide.
- [ ] L'audit Archive V2 staging au SHA servi rapporte `missingStoredObjects=0`,
  `storageOrphans=0` et `p0Issues=0`.

## 6. Definition of Done

- `implemented` : adapters, contrats et tests ciblés présents dans une PR unique ;
- `certified` : CI complète verte, revue adversariale, déploiement staging canonique, reprise du job
  réel par le scheduler durable et audit Archive V2 vert au SHA servi ;
- `released` : le même SHA est promu selon `PR -> staging validé -> production`, sans modifier ni
  supprimer manuellement un objet pour rendre l'audit vert.

## 7. Preuves d'implémentation locales — 9 août 2026

- `vitest` ciblé Storage/audit : 86 tests passés ;
- certificat PostgreSQL réel après activation Archive V2 : 28/28, sur une base PostgreSQL 17
  jetable reproduisant les owners Supabase et un rôle runtime `NOSUPERUSER NOBYPASSRLS` ;
- rail `release.sh` pré-déploiement complet : 169 migrations, certificats RLS et intégrité verts ;
- suite API complète, typecheck monorepo (17 tâches), lint (9 tâches) et build (10 tâches) : verts ;
- artefact API : `470` fichiers, aucun double métier/fixture ;
- deux relectures adversariales indépendantes : aucun P0/P1 restant après fermeture des constats
  MIME, backlog borné, scope, sentinel, projection relationnelle, timeout CI et garde exacte.

La CI du commit, le déploiement staging, la reprise durable du job réel et l'audit au SHA servi
restent volontairement non cochés : eux seuls font passer ce lot de `implemented` à `certified`.
