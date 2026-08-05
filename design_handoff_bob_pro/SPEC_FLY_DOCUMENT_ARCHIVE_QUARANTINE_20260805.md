# SPEC O2/O7 — Quarantaine des cinq émissions échouées FLY SERVICES

**Statut :** `implemented`
**Objectifs canoniques :** O2 — facturation conforme ; O7 — release reproductible
**Date :** 5 août 2026
**Décision fondatrice :** conversation Codex du 4/5 août 2026 — supprimer uniquement les
documents FLY SERVICES provenant des brouillons dont l'émission a échoué.

## 1. Objectif

Retirer du bucket documentaire staging exactement les cinq PDF orphelins produits par deux
émissions FLY SERVICES annulées, sans toucher à une pièce valide, à un autre tenant ni à la
production. Avant le premier retrait, les cinq originaux sont copiés dans un bucket privé de
quarantaine et relus intégralement ; leurs octets, métadonnées et SHA-256 sont vérifiés et un reçu
durable est persisté.

Supabase Storage ne fournit ni versioning/Object Lock ni condition `If-Match` sur DELETE. Cette
opération n'invente donc pas un faux CAS. Elle s'exécute comme une saga monotone et reprenable, sous
des fences PostgreSQL sur les cinq clés, les références, le worker et les buckets, ainsi qu'un lease
advisory conservé pendant toute la phase mutative. Une interruption peut laisser une progression
partielle, mais jamais un octet retiré sans copie vérifiée préalable.

## 2. Périmètre fermé

### Inclus

- environnement `staging` uniquement ;
- une seule société dont le SHA-256 canonique de l'identifiant est
  `83ade527a836a4425181a02dd4461b61cd39f417e0941623db9216e7d4c5a5db` ; l'identifiant brut
  reste exclusivement dans la preuve privée ;
- bucket source privé configuré comme bucket documentaire runtime ;
- clés strictement sous
  `companies/<companyId>/documents/<documentId>/v1/<sha256>.pdf` ;
- exactement cinq objets, dont l'ensemble fermé des SHA-256 de **clé** est :
  - `480394bce0b442b9b1cbaf4e546634696fab519ae341cfbaa3f97301c8e43b9d` ;
  - `1b01bcf44ba61e034870d9da4c6604fa0a6bce629b51843a73fe953a600dac09` ;
  - `a307e4eea77b617e106308d4ad81f5ba7865743a90cffe5e502653d41e457468` ;
  - `c9ab8b92c0da9c8542a4ff22877e489adf3ecd2d63985b9265ac99168db3f5d6` ;
  - `7e0b737fb7b08bf2f6d3f8e9a971b2a8735312eea4f3860065cfe4938812570b` ;
- bucket destination privé distinct, limité aux PDF et reçus JSON ;
- plan scellé depuis un audit Archive frais lié au SHA servi et sous OIDC fondateur, puis apply
  sous un nouvel OIDC fondateur avec confirmation exacte ;
- audit Archive final complet et remise en service du même SHA.

### Exclus

- production ;
- tout objet d'un autre tenant ;
- toute clé `chantiers/`, pièce scannée, document utilisateur ou archive émise/signée ;
- toute référence SQL, facture ou devis valide ;
- purge du bucket de quarantaine ;
- mutation directe de `storage.objects` par SQL ;
- affaiblissement du scanner ou conversion d'un orphelin en fausse référence SQL.

## 3. Autorités et données d'entrée

1. Le rapport autoritaire est un **nouveau** rapport Archive staging produit sur le SHA exact de
   l'opérateur fusionné, déployé et servi. Le rapport historique de cadrage sur `51d88bb…` ne peut
   jamais autoriser l'apply.
2. Il doit porter exactement cinq `STORAGE_OBJECT_WITHOUT_SQL_REFERENCE`, zéro
   `SQL_REFERENCE_WITHOUT_STORAGE_OBJECT` et aucune autre anomalie P0 étrangère au lot.
3. Le manifeste v2 lie : environnement, SHA servi, identité de base, digest snapshot, deployment
   d'audit, rapport, inventaire, bucket source/destination, companyId, cardinalité, ensemble exact
   des hashes de clés et, par entrée, `objectId`, `version`, `createdAt`, `updatedAt`, métadonnées,
   MIME, taille et SHA-256 recalculé depuis les octets. Sa sérialisation est canonique par champ,
   y compris après un aller-retour JSONB qui réordonne les propriétés : le digest chargé doit être
   strictement celui qui a été scellé. L'ordre des clés est total par unités de code, jamais lié à
   la locale, y compris pour des clés Unicode distinctes mais visuellement équivalentes.
4. L'ETag n'est jamais utilisé comme hash de contenu. Le SHA-256 des bytes reste l'autorité.
5. Le **plan et l'apply** exigent chacun un jeton OIDC GitHub lié au workflow immuable, au SHA et
   workflow SHA servis, à l'environment staging, à l'événement `workflow_dispatch`, au dépôt et
   owner IDs, au subject `repo:GLWebDevAgency/bob-pro:environment:staging` et à l'actor ID fondateur.
   Le plan persiste atomiquement un événement `plan_authorized`; l'apply persiste son événement
   `authorized`, dont l'autorité stable doit être identique mais dont le hash du jeton OIDC doit
   être distinct — rejouer le jeton du plan ferme l'apply. L'apply exige en plus la chaîne exacte
   `QUARANTINE-STAGING:<manifestDigest>`. Le journal nomme ces preuves honnêtement « autorisations
   opérationnelles » ; il ne fabrique jamais une seconde « décision fondatrice » depuis un champ
   libre. La décision produit source reste celle consignée en tête de cette spec.
6. Le détail des clés et documents reste dans le rapport privé/manifeste privé. Logs Railway,
   GitHub, Sentry et artefacts publics n'exposent que hashes opaques, compteurs et codes.

## 4. Machine d'état monotone

`planned -> copied_verified -> deleting(0..5) -> deleted_verified -> final_audit_verified -> completed`

- `planned` ne mute aucun objet source ; après authentification OIDC il peut créer le bucket de
  destination privé s'il est absent, puis sceller dans la même transaction le plan append-only,
  ses cinq entrées et `plan_authorized` ;
- `copied_verified` n'est atteint qu'après copie de toutes les entrées, GET intégral de toutes les
  destinations et relecture exacte du reçu privé ;
- `deleting(n)` conserve le nombre et l'ensemble opaque des entrées retirées ; la reprise doit
  accepter uniquement ce préfixe canonique de progression ;
- `deleted_verified` exige les cinq sources absentes, cinq destinations exactes et le snapshot SQL
  ciblé vert, mais n'annonce pas encore l'opération terminée ;
- `final_audit_verified` exige un **nouvel** audit Archive global, frais, lié au même SHA/bucket/base,
  avec `storageOrphans=0`, `missingStoredObjects=0` et `p0Issues=0` ;
- `completed` exige cet audit global append-only, une relecture relationnelle globale sans écart et
  un reçu final lié aux digests exacts de cet audit ;
- aucun retour arrière, UPDATE silencieux ou deuxième plan ouvert ; une perte d'ACK relit le plan
  exact par son périmètre fermé et rend le même digest sans nouvelle mutation.

Les reçus Storage écrits sans upsert sont durables et tamper-evident, mais ne sont pas qualifiés
WORM. La preuve finale repose aussi sur le rapport Archive append-only déjà protégé par RLS forcée.

## 5. Fence exact-key et suppression

1. L'opération partage le mutex `railway-api-staging` avec toutes les releases/opérateurs staging.
2. Avant apply, le SHA de l'API servi, l'environnement, le service et la topologie mono-réplique
   sont certifiés.
3. Le plan prend le verrou advisory partagé de l'audit des bytes, puis un verrou quarantine
   distinct. Dans une transaction courte il relit la preuve privée exacte, les cinq objets et les
   cinq familles de références, puis scelle une opération et cinq entrées immuables. L'apply reprend
   les deux verrous sur une connexion dédiée et les conserve jusqu'au reçu `deleted_verified` ; un
   audit concurrent ou un deuxième apply échoue fermé.
4. Dès ce commit, un trigger `storage.objects` interdit INSERT/UPDATE sur les cinq clés source et
   protège les destinations. Des triggers sur les tables référentes interdisent toute nouvelle
   référence à une source clôturée. Le trigger Storage n'autorise un DELETE source que si :
   - l'événement append-only `copied_verified` existe pour le manifeste exact ;
   - l'objet OLD porte encore l'id, la version, les timestamps et métadonnées scellés ;
   - aucune référence SQL n'existe ;
   - la destination exacte existe et n'est plus mutable.
5. Le fence PostgreSQL est la barrière transactionnelle réelle ; il remplace l'arrêt global de
   l'API et n'invente aucun `If-Match` Storage inexistant.
6. Juste avant chaque DELETE, le guard applicatif prouve aussi :
   - opération scellée et progression exacte ;
   - progression précédente exacte ;
   - source relue intégralement et métadonnées inchangées ;
   - zéro référence dans `documents`, `document_versions`, `chantier_photos`,
     `document_archive_artifact_intents` et `document_archive_job_artifacts` ;
   - destination et reçu `copied_verified` relus sous verrou, avec octets, taille, MIME,
     identifiants, version, timestamps et métadonnées égaux au journal scellé ;
   - inventaire exact des huit fences attendus (nom, table, fonction, `tgtype`, activation), sans
     homonyme supplémentaire : objet, bucket, cinq familles de références et worker.
7. Un DELETE Storage REST unitaire est tenté. ACK perdu : source absente + destination/reçu exacts
   vaut succès réconcilié ; source encore présente et exacte vaut arrêt reprenable ; source
   différente vaut P0 et interdit toute nouvelle mutation.
8. Les gardes de progression sont distinctes : `assertPreCopySnapshotExact`,
   `assertEntryDeleteSafe` et `assertFinalSnapshotClean`. Le digest initial n'est jamais exigé
   inchangé après la première suppression.
9. Après `deleted_verified`, un audit Archive global frais s'exécute. Le finalizer reprend les deux
   verrous, lie cette preuve exacte au journal, revalide l'absence globale d'orphelin/de référence
   manquante, puis écrit `completed` dans la transaction qui verrouille les objets/buckets, les cinq
   familles de références et les jobs. Cette frontière recertifie exactement : opération et cinq
   entrées attendues, zéro source, cinq destinations liées aux événements, zéro référence, deux
   reçus exacts, séquence du journal complète, audit global `0/0/0`, buckets privés, zéro lease et
   huit fences exacts. Si l'ACK est perdu après le lien de l'audit ou le
   reçu Storage final, la reprise relit la preuve append-only déjà liée au lieu d'exiger un nouvel
   audit incompatible.
10. À chaque relance `apply`, l'opérateur tente d'abord le finalizer sans aucune variable de pin :
    une preuve `final_audit_verified` durable permet la reprise immédiate ; seule l'absence nommée
    de cette preuve autorise un nouvel audit global. Une configuration partielle ou toute autre
    erreur ferme l'opération. Plan, apply et finalize ré-ancrent le manifeste relu au SHA, tenant
    hashé, cinq hashes et deux buckets exacts compilés dans l'artefact.
11. `/health/ready` et la topologie prouvent encore le même SHA après l'opération. Un échec de
    l'opération ne déclenche jamais un autre SHA.

## 6. Contrat Storage

- toutes les I/O ont une deadline bornée et une limite d'octets ;
- source et destination sont certifiées privées avant chaque phase mutative ;
- copie inter-buckets via l'API REST Supabase, sans upsert ; une destination différente préexistante
  ferme l'opération ;
- reçus écrits par upload standard `x-upsert=false`, puis relus byte-à-byte ;
- suppression via l'API Storage uniquement, jamais `DELETE FROM storage.objects` ;
- le port s'appelle honnêtement `removeFenced`, jamais `removeExact` ;
- les erreurs opérationnelles utilisent `manifestDigest`, ordinal et hash de clé, jamais la clé.

## 7. Critères d'acceptation binaires

- [ ] Le builder refuse autre tenant, préfixe `chantiers`, cardinalité différente de 5, sixième
      orphelin, hash de clé absent/supplémentaire ou SQL-missing object.
- [ ] Le manifeste v2 lie toutes les métadonnées Storage et les octets au rapport frais exact.
- [ ] Le digest du manifeste survit à un aller-retour JSONB réel ; un test unitaire réordonne toutes
      les propriétés, dont des clés Unicode distinctes équivalentes sous certaines collations, et le
      certificat PostgreSQL recharge le manifeste persisté avant l'apply.
- [ ] Plan, apply et finalize refusent un manifeste pourtant valide s'il diverge du SHA, des deux
      buckets, du tenant hashé ou de l'ensemble fermé des cinq hashes compilés.
- [ ] Source **et** destination publiques ou mal configurées sont refusées avant copie.
- [ ] Une collision destination différente ne retire aucune source.
- [ ] Les cinq copies et le reçu `copied_verified` sont relus avant le premier DELETE.
- [ ] Chaque DELETE recertifie transactionnellement les cinq destinations/reçus et l'inventaire
      exact des huit fences ; perte d'une destination ou substitution d'un reçu retire zéro source.
- [ ] Perte du fence, source remplacée, référence SQL apparue, trigger absent/désactivé ou lease
      vivant arrêtent avant le DELETE suivant.
- [ ] Crash après chaque DELETE et ACK DELETE perdu reprennent sans perte ni double effet.
- [ ] Un audit concurrent refuse l'apply ; le lease apply reste possédé jusqu'à
      `deleted_verified`, et le finalizer refuse toute preuve autre que le nouvel audit global
      `0/0/0` du même SHA/base/bucket.
- [ ] Un second passage exact retourne le même receipt final sans mutation.
- [ ] Jeton plan absent/invalide : aucune création de bucket ni opération ; plan et apply portent
      deux preuves OIDC distinctes avec la même autorité stable.
- [ ] ACK perdu après le commit du plan, après `final_audit_verified`, après le PUT du reçu final ou
      après `completed` reprend la même saga sans second plan ni seconde suppression. Le workflow
      tente cette reprise sans pin avant tout nouvel audit ; seul le code d'absence explicite lance
      l'audit frais, toute autre erreur reste bloquante.
- [ ] `completed` refuse dans la même transaction une destination perdue, un bucket public, une
      lease worker vivante, un reçu divergent ou un état exact incomplet, puis accepte la reprise
      d'un ACK perdu sur l'unique événement déjà persisté.
- [ ] Tests de confidentialité garantissent zéro clé brute dans les sorties non privées.
- [ ] Le runtime passe sous la topologie Supabase exacte à owners séparés : le déployeur
      non-superuser lit/verrouille Storage sans pouvoir prendre son owner ; le rôle NOLOGIN des
      tables `public` est assumé seulement dans des transactions bornées ; aucune requête ne joint
      les deux autorités, aucun GRANT transversal n'est ajouté, et chaque retour au `session_user`
      est prouvé avant une lecture Storage.
- [ ] Le certificat PostgreSQL owner-split appelle les vraies méthodes du repository de
      `loadPinnedAudit` à `recordCompleted`, rejoue chaque ACK, traverse les deux leases mutatifs et
      termine avec une opération, cinq entrées, seize événements, zéro source, cinq destinations et
      trois reçus. Il refuse de s'exécuter si la base n'est pas explicitement déclarée éphémère.
- [ ] Tests de contrat Railway prouvent SHA servi exact, topologie, mutex staging partagé et
      exécution distante dans l'artefact déployé sur l'instance exacte, avec clé SSH dédiée — jamais
      `railway run` local ni « première instance » implicite. Le runner éphémère amorce le relais
      Railway avec `StrictHostKeyChecking=accept-new` : première clé acceptée, clé changée refusée,
      et jamais de désactivation du contrôle de clé hôte. La configuration SSH par défaut impose
      aussi `BatchMode`, `IdentitiesOnly`, un délai court et la clé dédiée aux quatre sites d'appel
      Railway scellés (au plus trois exécutés dans un run), dont la reprise sans pin avant audit.
- [ ] Pour chaque run `plan` ou `apply`, l'opérateur crée et enregistre une clé SSH Railway unique,
      conserve le reçu externe horodaté de cet enregistrement, puis lie le workflow à son empreinte
      SHA-256 exacte et à une fenêtre d'autorisation commencée depuis moins de 30 minutes, couvrant
      le timeout entier et bornée à quatre heures. Le workflow ne présente jamais cette fenêtre
      déclarative comme une preuve d'âge de la clé. Après le run, l'opérateur retire d'abord cette
      empreinte de Railway et prouve son absence, supprime ensuite le secret GitHub staging et
      prouve son absence. Sans reçu d'enregistrement et des deux retraits, le lot reste non certifié
      même si la saga est `completed`.
- [ ] Avant de poser le secret SSH temporaire, l'environnement GitHub `staging` exige une revue du
      compte fondateur et ne laisse passer que `main`. Cette protection reste active jusqu'aux deux
      retraits prouvés ; l'état de protection antérieur est capturé puis restauré après la fenêtre
      JIT, afin que cette opération bornée ne modifie pas silencieusement la gouvernance globale.
- [ ] Typecheck, lint, tests ciblés, suite API complète, build et garde artefact sont verts.
- [ ] Review adversariale indépendante : zéro P0/P1 ouvert.
- [ ] Certification réelle Supabase staging : bucket privé, copie/hash/receipt, retrait des cinq
      sources, aucune autre mutation.
- [ ] Audit final : `storageOrphans=0`, `missingStoredObjects=0`, `p0Issues=0`.
- [ ] `/health/ready` sert toujours le SHA exact après l'opération.

## 8. Definition of Done

- `specified` : ce document est accepté comme frontière de l'opération ;
- `implemented` : cœur v2, adapters, runner et tests existent sur une PR unique ;
- `certified` : CI, review, PostgreSQL non-superuser et plan staging frais sont verts ;
- `released` : les cinq sources sont absentes, les cinq copies vérifiées restent privées, le reçu
  final et l'audit 0/0/0 sont persistés, puis l'API staging sert de nouveau le SHA capturé.

Tant que la dernière ligne n'est pas prouvée, la demande n'est pas annoncée comme terminée.
