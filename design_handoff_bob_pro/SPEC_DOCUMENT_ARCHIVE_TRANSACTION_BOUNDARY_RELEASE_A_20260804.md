# SPEC P0 — Archive documentaire, frontière transactionnelle Release A

**Statut :** `implemented`
**Objectifs canoniques :** O2 — facturation conforme et complète ; O7 — release reproductible
**Date :** 4 août 2026
**Décision produit source :** résoudre la cause réelle du blocage staging sans supprimer, masquer ni
réinventer un original. Les trois objets Storage historiques restent intacts tant qu'une opération de
quarantaine n'a pas été explicitement autorisée par le fondateur.

## 1. Objectif

Une émission de facture ou une signature de devis doit committer l'acte métier et un ordre durable
contenant tout ce qui est nécessaire pour reproduire **un seul original exact**. Le rendu, l'inspection
binaire et Supabase Storage s'exécutent après ce commit, sans transaction PostgreSQL longue. Un crash
à n'importe quelle frontière reprend le même travail, le même hash et la même clé ; il ne crée ni
second original ni objet Storage sans intention SQL.

Cette Release A est une fondation serveur. Elle ne traite ni l'état de matérialisation dans le mobile,
ni les pièces jointes de notification, ni la suppression de compte.

## 2. Causes prouvées

1. `POST /invoices/:id/issue` et `POST /quotes/:id/sign` héritent aujourd'hui de la transaction
   HTTP tenant. Le `runInTransaction` interne est réentrant et le worker est lancé avant le vrai
   commit extérieur.
2. `runDocumentArchiveJobs` enveloppe LIST, CLAIM, rendu PDF, Storage et finalisation dans une seule
   transaction tenant. Le lease n'est donc pas visible pendant l'I/O et une erreur SQL peut empoisonner
   toute la page.
3. `StoreDocument` publie l'objet avant l'INSERT SQL. En cas de rollback, l'objet survit sans référence.
4. Un retry relit Company, Customer et BillingSettings courants. Même avec des dates PDF stables, une
   adresse ou une couleur modifiée peut changer les octets d'un original déjà ordonné.
5. `pdf-lib` injecte l'horloge dans les métadonnées ; Factur-X utilise aussi `new Date()`. Deux rendus
   identiques fonctionnellement peuvent donc produire des SHA et clés différents.
6. L'adapter `BackendService.storeDocument` ne transmet pas actuellement
   `invoicePdfAttestation` au repository alors que le core l'exige et que Prisma sait la persister.
7. Les requêtes Supabase Storage n'ont aucune deadline.
8. L'audit V2 compare `storage.objects.updated_at` à un `Document.createdAt` capturé avant l'upload.
   L'objet staging valide observé a `created_at = updated_at`, mais ces deux valeurs sont 633 ms après
   le timestamp SQL : l'insertion initiale est faussement classée comme mutation.
9. `SendInvoice` révoque et recrée le jeton public avant de charger l'archive légale. Une archive
   indisponible produit donc une mutation visible et inutile alors que l'envoi est finalement refusé.
10. Le rituel de release rejoue le certificat mutable Archive V2 après le cutover terminal V3 et son
    cleanup laisse des fixtures RLS immuables. Un deuxième passage peut donc échouer ou demander de
    rouvrir des droits N-1 que le cutover vient précisément de fermer.

## 3. Périmètre Release A

### Inclus

- transaction métier courte pour issue/sign : agrégat, comptabilité éventuelle, snapshot de rendu,
  ordre d'archive et événement durable dans le même commit ;
- snapshot canonique, versionné, haché et immutable de l'entrée du renderer ;
- worker phasé : LIST courte, CLAIM+COMMIT, rendu hors transaction, intention d'artefact+COMMIT,
  upload/lecture hors transaction, insertion/adoption SQL+attestation, DONE/FAILED par CAS court ;
- rendu PDF déterministe pour facture B2B Factur-X, facture B2C et devis signé ;
- deadline de toutes les opérations de l'adapter Supabase Document Storage ;
- correction du pass-through d'attestation PDF ;
- chargement de l'archive légale avant toute rotation de lien public ou écriture d'outbox d'envoi ;
- correction du prédicat de mutation Storage de l'audit V2 ;
- outil de réconciliation historique en mode inventaire/dry-run, sans mutation par défaut ;
- cleanup RLS borné aux fixtures certifiées, atomique sous l'owner exact et rejouable ;
- certification de release consciente du protocole terminal : V3 prouve l'état courant sans
  réaccorder les mutations V2 retirées ;
- migrations additive/rolling, RLS forcée, ACL Data API fermées et writer N-1 certifié.

### Exclus et lots suivants

- **Release B :** projection API/mobile `preparing|retry_scheduled|ready`, polling et UX ;
- **Release C :** pièce jointe e-mail matérialisée hors transaction provider ;
- **Opération séparée :** copie vérifiée des trois orphelins staging vers une quarantaine privée,
  puis retrait des sources. L'exécution exige une autorisation fondateur explicite et un receipt ;
- aucun changement au chantier suppression de compte ;
- aucune modification des données de production.

## 4. Contrats persistés

### 4.1 Snapshot de rendu append-only

Chaque nouvel ordre d'archive crée atomiquement une ligne séparée
`document_archive_render_snapshots` :

- `schemaVersion = 1` ;
- `rendererVersion = 1` ;
- `payload`, JSON canonique UTF-8 fermé contenant `companyId`, `pieceId`, `reason`, l'instant de
  métadonnée, le plan exact des artefacts, les données exactes de `InvoicePdfData` ou
  `QuotePdfData` et le XML Factur-X exact lorsqu'il existe ;
- `payloadSha256 = sha256(payload canonique)`.

Le snapshot est produit dans la transaction d'émission/signature après la transition d'agrégat et
avant le commit. Il ne contient aucune lecture future de fiches mutables. Toute future dépendance
binaire (logo, signature image) devra être une référence content-addressed scellée dans ce snapshot ;
elle ne pourra pas être relue par « id courant ».

La table est tenant-scopée, liée au job par une FK composite et refuse tout `UPDATE` ou `DELETE`.
Les jobs N-1 sans snapshot restent lisibles. Ils peuvent uniquement vérifier une archive existante ;
ils ne peuvent jamais recevoir un snapshot rétro-inventé ni régénérer un original historique depuis
l'état courant.

### 4.2 Intention d'artefact pré-upload

La table additive `document_archive_artifact_intents` porte, pour chaque `(jobId, kind)` :

- tenant, documentId et versionId déterministes ;
- rendererVersion et renderSnapshotSha256 ;
- profil de contenu, MIME, taille, SHA-256 et clé Storage content-addressed ;
- instant serveur de création.

L'intention est insérée sous le lease possédé **après rendu et avant le premier upload**. Un rejeu
strictement identique est accepté ; tout écart est un conflit fermé. La ligne est append-only et
reste le receipt durable, y compris après DONE. Un objet référencé par une intention valide n'est pas
un orphelin : il est une projection due que le reaper doit terminer.

### 4.3 Protocole de snapshot distinct et rolling deploy

- `document_archive_protocol_state` reste terminal en V2 et n'est jamais rouvert ;
- un singleton distinct `document_archive_snapshot_protocol_state` pilote uniquement le cutover du
  writer snapshot (`activeVersion = 1|2`) ;
- migration expand : tables snapshots/intention + fonctions V3 + singleton en version 1, sans
  casser le writer N-1 ;
- contraintes `NOT VALID`, puis migration distincte de validation ;
- le writer V2 reste exécutable pendant l'expand ; le writer V3 crée job + snapshot atomiquement et
  refuse tout job incomplet préexistant sans snapshot ;
- les jobs legacy complets conservent leur preuve, sans snapshot inventé ;
- l'activation V1→V2 exige zéro lease N-1 et zéro job incomplet sans snapshot, lie le SHA de release,
  révoque les RPC V2 au runtime puis interdit tout nouvel ordre sans snapshot ;
- après activation, un rollback N-1 échoue fermé.

## 5. Invariants

1. Aucun renderer, inspecteur PDF ou appel Storage ne s'exécute avant le commit métier.
2. Une panne du kick post-commit ne change jamais le succès HTTP de l'émission/signature.
3. Le scheduler et l'outbox sont l'autorité durable ; le kick n'est qu'une accélération.
4. Les callbacks post-commit s'exécutent une fois après résolution de la transaction externe ; un
   rollback les abandonne et un callback tardif hérité d'un contexte fermé est refusé.
5. LIST, CLAIM, intention, insertion/adoption et finalisation sont des transactions courtes séparées.
6. Le lease est committé avant le rendu et expire sans ACK faux après un crash.
7. Une page est entièrement tentée ; l'échec d'un job n'empêche pas les suivants.
8. Le worker rend exclusivement depuis le snapshot scellé. Snapshot absent/invalide ou version de
   renderer inconnue = échec fermé, jamais relecture des fiches courantes.
9. Deux rendus d'un même snapshot et d'une même version de renderer sont byte-identiques.
10. Le SHA rendu doit être exactement celui de l'intention existante ; aucune nouvelle clé n'est
    créée en cas de divergence.
11. Aucun upload n'est autorisé sans intention durable possédée par le job/lease courant.
12. `put` reste no-upsert. Un ACK perdu est repris par GET exact ; une collision différente n'est
    ni écrasée ni supprimée.
13. Toutes les I/O Storage ont une deadline explicite de 15 s par requête. Un timeout est une erreur
    de dépendance structurée et le job reste reprenable.
14. `invoicePdfAttestation` traverse Backend → core → repository et est persistée atomiquement avec
    Document/version.
15. DONE exige Documents, versions, attestations, objets relus et manifeste exacts, sous le lease.
16. Les tables snapshot/intention sont tenant-scopées, append-only, RLS forcée et non exposées à
    `anon`, `authenticated`, `service_role` ou PUBLIC.
17. La mutation Storage est suspecte si l'objet manque, si ses timestamps manquent, ou si
    `updated_at > created_at` **et** que cette mise à jour est postérieure à la première version SQL.
    Une insertion initiale avec `created_at = updated_at` n'est jamais une mutation.
18. Les logs opérationnels n'ont aucune valeur légale avant commit. L'ordre/snapshot et les
    intentions sont les traces durables ; les logs ne sont émis qu'après résolution du commit.
19. Aucun objet historique n'est supprimé automatiquement par le code ou le release.
20. Un envoi de facture charge et vérifie l'archive avant toute révocation/création de jeton public
    ou INSERT d'outbox. Archive indisponible = zéro effet de bord d'envoi.
21. Le cleanup de certification ne cible que les fixtures `rls-*` connues, désactive/réactive les
    triggers immuables dans une seule transaction sous leur owner, et converge au second passage.
22. Une release en état snapshot V2 terminal ne rejoue ni ne réaccorde le certificat mutable Archive
    V2 ; le certificat snapshot V3 est l'unique preuve runtime de ce rail.

## 6. Critères d'acceptation binaires

- [x] Les contrôleurs issue/sign sont `@WithoutTenantPersistenceTransaction` et l'admission tenant
  courte précède le handler.
- [x] Mutation métier + snapshot + outbox rollbackent ensemble sur une erreur injectée.
- [x] `/ai/confirm` diffère le kick jusqu'au commit HTTP extérieur ; aucun renderer/Storage n'est
  observé avant ce commit.
- [x] Une Storage promise bloquée n'allonge pas la réponse issue/sign.
- [x] Un CLAIM est visible depuis une seconde connexion PostgreSQL avant l'appel renderer.
- [x] Crash après CLAIM, après intention et après upload : le retry converge vers exactement un
  objet, un Document, une version, une attestation et une preuve.
- [x] Le premier job en échec n'empêche pas le second de la page d'aboutir.
- [x] La modification de Company, Customer ou BillingSettings après émission ne change pas les
  octets issus du snapshot.
- [x] Deux processus/horloges rendent des bytes identiques pour B2B Factur-X, B2C et devis signé.
- [x] Une version de snapshot/renderer inconnue refuse avant Storage.
- [x] Le chemin Backend réel persiste l'attestation initiale exacte ; un conflit refuse DONE.
- [x] Les tests Storage couvrent timeout de GET/POST/readback/sign/stat/delete, ACK POST perdu,
  adoption exacte et collision différente.
- [x] L'audit accepte l'observation réelle `storage.created_at = storage.updated_at > SQL.createdAt`
  et refuse une vraie mise à jour postérieure.
- [x] L'inventaire de quarantaine est déterministe, ne mute rien par défaut et exige une confirmation
  exacte liée au digest pour tout mode apply.
- [x] Le writer N-1 insère sa forme exacte sous les migrations expand et validate finales.
- [x] L'activation snapshot refuse tout lease N-1, job incomplet sans snapshot ou SHA de release
  invalide ; après cutover, le writer N-1 échoue fermé sans écriture partielle.
- [x] Le certificat PostgreSQL utilise un déployeur/runtime non-superuser avec FORCE RLS et prouve
  ACL, anti-IDOR, immutabilité et rejeu exact.
- [x] Une archive indisponible pendant l'envoi ne révoque/crée aucun jeton public et n'écrit aucun
  événement d'outbox.
- [x] Deux passages complets du cleanup RLS convergent ; le second passage ne laisse ni fixture ni
  trigger immuable désactivé.
- [x] Le rituel prédeploy/postdeploy rejoué depuis l'état snapshot terminal ne réouvre aucun droit V2
  et passe sous le déployeur non-superuser.
- [x] Typecheck core/API, suites ciblées, build API et audit d'artefact passent depuis un checkout
  propre.
- [x] Revue adversariale indépendante : aucun P0/P1 ouvert.
- [ ] Replay des migrations et du script de release sur Supabase staging au SHA mergé ; aucun
  pending/failed migration et audit archive `p0Issues = 0`.

## 7. Preuves locales d'implémentation

Preuves reproduites le 4 août 2026 sur PostgreSQL 17 avec un runtime non-superuser et un déployeur
non-superuser distinct :

- `pnpm --filter @bob/core test` : 241 fichiers, 3 179 tests verts ;
- `pnpm --filter @bob/api test` : 239 fichiers Vitest verts (2 969 tests), 648 gardes release et
  83 tests schéma/staging verts ; les skips correspondent uniquement aux certificats opt-in ;
- cinq exécutions concurrentes répétées des suites sensibles archive : vertes ;
- `pnpm --filter @bob/core typecheck` et `pnpm --filter @bob/api typecheck` : verts ;
- `pnpm --filter @bob/core lint` et `pnpm --filter @bob/api lint` : verts ;
- `pnpm typecheck` et `pnpm lint` depuis le HEAD propre : tous les packages applicables verts ;
- `pnpm --filter @bob/api build` : 458 fichiers certifiés, aucun double métier/fixture ;
- `release.sh` en `predeploy`, activation terminale, puis `postdeploy` sur les 168 migrations : vert ;
- cleanup RLS exécuté deux fois consécutivement : vert et sans fixture résiduelle ;
- revue adversariale indépendante : tous les constats P1 vérifiés ont été corrigés.

## 8. Definition of Done

Le statut passe :

- à `implemented` lorsque code, migrations et tests sont présents sur une PR unique ;
- à `certified` uniquement après CI complète, PostgreSQL non-superuser, revue adversariale et
  replay Supabase staging au SHA mergé ;
- à `released` uniquement quand `/health/ready` sert ce SHA, que l'audit Archive V2 est vert et que
  le receipt de release est attaché.

La réconciliation des trois objets staging est une opération distincte. Tant qu'elle n'est pas
explicitement autorisée et exécutée avec copie+hash+receipt, elle reste un blocage opérationnel
honnête ; elle ne justifie ni suppression silencieuse ni abaissement de l'audit.
