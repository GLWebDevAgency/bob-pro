# SPEC — Archive V2 : insertion tenantée d'une version PDF avant attestation

**Objectifs** : O2 / O7
**Statut** : implemented
**Origine** : audit staging du run `31346182023`, 10 août 2026.

## 1. Problème prouvé

Le worker V2 matérialise un PDF généré dans une transaction unique selon l'ordre
`document → version → attestation`. La policy restrictive de lecture de `documents` masque
volontairement un PDF généré tant que son attestation byte-derived n'existe pas. Or la policy
INSERT de `document_versions` relit ce parent à travers RLS : elle ne le voit donc jamais et
empêche l'insertion qui précède précisément l'attestation.

Deux jobs durables de factures émises/payées sont ainsi bloqués. Leurs objets Storage existent ;
leurs documents, versions, attestations et projections n'existent pas. Ce ne sont ni des
brouillons ni des orphelins autorisés à supprimer.

## 2. Résultat attendu

Une version peut être insérée uniquement si son `documentId` appartient au tenant présent dans
`app.current_company_id`, même lorsque la policy SELECT masque temporairement le parent. Aucune
lecture de PDF non attesté n'est élargie. Le worker conserve l'atomicité : si l'attestation échoue,
document et version sont annulés avec la transaction.

## 3. Invariants

1. Le prédicat reçoit uniquement le `documentId`; aucun tenant fourni par l'appelant n'est accepté.
2. L'absence, la forme vide ou un tenant différent dans `app.current_company_id` retourne `false`.
3. La lecture profonde est une fonction `SECURITY DEFINER`, `STABLE`, `STRICT`, avec
   `search_path=pg_catalog,public` et `row_security=off`, possédée par l'owner effectif de
   `documents`, obligatoirement `SUPERUSER` ou `BYPASSRLS`. La migration résout séparément l'owner
   de `document_versions` et échoue fermée si l'un des rôles n'est pas assumable. Le replay RLS
   canonique conserve son invariant actuel plus strict : les tables tenantées historiques ont un
   owner convergent ; changer ce modèle relève d'un train d'ownership distinct.
4. La fonction ne retourne qu'un booléen et n'expose ni document, ni identifiant d'un autre tenant.
5. `PUBLIC`, `anon`, `authenticated` et `service_role` n'ont aucun EXECUTE. La migration préserve
   atomiquement l'EXECUTE des seuls rôles qui possèdent déjà explicitement INSERT sur
   `document_versions`, afin qu'un predeploy interrompu ne coupe pas les uploads. La reconstruction
   ACL de `release.sh` réduit ensuite l'inventaire au seul rôle runtime.
6. Seule la policy `tenant_document_version_insert` change. La fence SELECT Protocol V2, les
   triggers d'attestation, l'immutabilité et les ACL mutationnelles restent inchangés.
7. La migration est additive, porte `lock_timeout`/`statement_timeout` et fonctionne avec un
   déployeur Supabase non-superuser qui prend explicitement le rôle owner.
8. Aucun job, objet Storage ou enregistrement staging n'est modifié manuellement. Le scheduler
   durable reprend naturellement après déploiement.

## 4. Critères d'acceptation binaires

- [x] Sous rôle runtime `NOSUPERUSER/NOBYPASSRLS`, document + version + attestation valides sont
      créés atomiquement lorsque Protocol V2 est actif.
- [x] Sans tenant GUC et avec le tenant B, la version du document du tenant A est refusée.
- [x] Le PDF généré reste invisible avant attestation.
- [x] Une attestation invalide annule document et version dans la même transaction.
- [x] Immédiatement après la migration et avant la reconstruction ACL, le repository non modifié
      du binaire N-1 peut encore insérer atomiquement un document importé et sa version — le seul
      writer coffre autorisé tant que Protocol V1 maintient la pause des archives légales générées.
- [x] Après reconstruction ACL et activation V2, le même repository matérialise atomiquement le
      parcours terrain `PDF généré → version → attestation` malgré la fence SELECT.
- [x] Owner du helper égal à celui de `documents`, owner de policy assumé explicitement,
      `prosecdef`, `proconfig` et EXECUTE exact sans GRANT OPTION sont certifiés sur un vrai
      PostgreSQL avec le rôle de production.
- [x] `document_versions` possède exactement une policy INSERT permissive, ciblant le rôle policy
      canonique et l'expression normalisée du helper — aucune deuxième policy composable par `OR`.
- [ ] Staging exact-SHA termine les deux jobs bloqués et l'audit neuf retourne
      `storageOrphans=0`, `missingStoredObjects=0`, `p0Issues=0`, `issueCodes=[]`.
- [ ] Les paires professionnelles passent encore les validateurs Mustang/FNFE.

## 5. Definition of Done

Migration et source RLS cohérentes, test PostgreSQL réel vert, tests statiques de release verts,
review adversariale sans P0/P1, PR unique mergée, déploiement staging exact-SHA réussi et audit
terminal 0/0/0. Avant ces preuves, le statut maximal est `implemented`.

## 6. Preuves locales reproductibles

- certificat intermédiaire Supabase-like : `1/1` test PostgreSQL vert sous rôle runtime
  `NOSUPERUSER/NOBYPASSRLS` ;
- certificat Archive V2 final : `31/31` tests PostgreSQL verts, dont parcours facture générée,
  refus cross-tenant et rollback d'attestation ;
- garde statique de release : `12/12` tests verts ;
- typecheck API et build de la chaîne `core → ai → api` verts, garde d'artefact incluse.

Ces preuves locales ne certifient pas Supabase staging : les deux dernières cases de la section 4
restent volontairement ouvertes jusqu'au déploiement exact-SHA et aux validateurs externes.
