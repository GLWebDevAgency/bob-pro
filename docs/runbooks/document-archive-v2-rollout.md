# Runbook — activation monotone de l’archive documentaire V2

## But et invariants

Archive V2 fixe le périmètre légal depuis le snapshot immuable pris à l’émission, jamais depuis
une fiche client relue après coup :

- devis signé : PDF signé ;
- facture B2B/B2G émise : PDF/A-3 Factur-X et XML EN16931 correspondant ;
- facture B2C émise : PDF simple, sans XML embarqué ni XML séparé.

Le profil d’un PDF facture est attesté après lecture de ses octets. Le MIME, le nom du fichier,
le motif du job et un SHA déclaratif ne sont pas une preuve de représentation. Le runtime écrit
l’attestation uniquement via `attest_generated_invoice_pdf_v1`; il ne peut pas modifier directement
la table d’attestations ni appeler le validateur profond non tenant-scopé.

Le passage V1 → V2 est monotone. Il n’existe ni rollback vers V1, ni correction silencieuse d’une
preuve. Un échec se traite par roll-forward audité.

## Pourquoi deux trains sont obligatoires

La migration `1332` sait spooler les jobs et bloquer leur matérialisation en base, mais elle ne peut
pas empêcher un binaire N-1 de rendre ou de retourner directement un PDF hybride/XML B2C par HTTP.
Appliquer les migrations pendant qu’un tel N-1 reçoit encore du trafic créerait donc une fenêtre de
non-conformité hors base.

Le déploiement se fait impérativement en deux trains indépendants :

### Train 0 — fence HTTP compatible avec l’ancien schéma

1. Livrer uniquement le fence HTTP/rendu B2C, sans dépendance aux migrations `1332+`.
2. Le binaire doit publier dans `/health/ready` :

   ```json
   {
     "capabilities": {
       "documentArchiveB2cHttpFence": "v1"
     }
   }
   ```

3. Attendre que **toutes** les répliques actives exposent ce marqueur et le même
   `release.sha` complet. Aucune réplique antérieure ne doit encore recevoir de trafic.
4. Conserver le SHA du train 0 et la réponse readiness comme preuve de précondition.

Si ce marqueur, le mono-SHA ou l’inventaire des répliques ne peuvent pas être prouvés, ne pas
appliquer `1332+`. Une coupure explicite du trafic HTTP est l’unique alternative acceptable.

### Train 1 — expand, binaire V2, activation

Le train 1 applique les migrations, certifie la phase V1, déploie le binaire V2, retire N-1, puis
active V2 dans une transaction unique. Pendant l’intervalle expand :

- tous les nouveaux jobs sont datés au sentinel `9999-12-31 23:59:59.999` ;
- aucune archive légale générée ne peut être matérialisée en base ;
- les imports utilisateur et les autres documents du coffre restent disponibles ;
- l’activation réarme les jobs spoolés seulement après le flip V2.

## Préconditions bloquantes avant l’expand du train 1

- Train 0 prouvé sur toutes les répliques, avec le contrat readiness ci-dessus.
- `check-document-archive-legacy-audience.sh` passe **avant toute migration**. Sur un schéma
  pré-1332, la moindre facture déjà émise bloque l’expand jusqu’à constitution d’un snapshot
  d’audience revu ; sur un schéma expand, la moindre audience `NULL` bloque tout nouveau train.
- Les neuf migrations `20260721133200`, `1333`, `1335`, `1337`, `1338`, `1339`, `1340`, `1341`
  et `1342`
  n’ont jamais été réécrites après application dans un environnement persistant. Enregistrer leurs
  SHA-256 locaux avant le premier `migrate deploy`.
- Le rôle `APP_DATABASE_ROLE` existe avec `NOSUPERUSER` et `NOBYPASSRLS`.
- `DIRECT_URL` utilise l’autorité de migration, jamais le rôle applicatif.

## Gates bloquants entre l’expand et l’activation

- `BOB_RELEASE_PHASE=predeploy sh apps/api/scripts/release.sh` a appliqué les migrations et
  certifié la phase expand V1 sur la base cible.
- Les checksums appliqués correspondent exactement aux fichiers locaux enregistrés.
- Toutes les répliques du train 1 exposent son SHA exact dans `/health/ready`; aucune N-1 ne vit.
- Chaque facture émise possède un `archiveAudienceAtIssuance` audité.
- Chaque PDF facture généré existant possède une attestation issue d’une relecture réelle des octets.
- L’inventaire objet/SQL décrit ci-dessous est archivé et ses anomalies P0 sont résolues.

## Vérifier l’immutabilité des migrations

Prisma stocke le SHA-256 de chaque `migration.sql` dans `_prisma_migrations`. Le script
`activate-document-archive-v2.sh` recalcule obligatoirement les neuf SHA-256 locaux et les compare,
dans sa transaction et avant toute mutation, à une unique ligne Prisma terminée et non annulée.
La commande suivante reste la preuve opérateur lisible à joindre au dossier de release :

```sh
for migration in \
  20260721133200_document_archive_integrity_proof \
  20260721133300_document_original_retention_fences \
  20260721133500_document_archive_db_closure \
  20260721133700_document_archive_customer_scope_fence \
  20260721133800_document_archive_rollout_protocol \
  20260721133900_document_archive_audit_evidence \
  20260721134000_legal_storage_object_immutability \
  20260721134100_document_archive_private_report \
  20260721134200_document_archive_data_api_fence
do
  file="apps/api/prisma/migrations/$migration/migration.sql"
  local_checksum="$(openssl dgst -sha256 -r "$file" | awk '{print $1}')"
  database_checksum="$(
    psql "$DIRECT_URL" -X -qAt -v ON_ERROR_STOP=1 -v migration="$migration" <<'SQL'
SELECT checksum
  FROM public._prisma_migrations
 WHERE migration_name = :'migration'
   AND finished_at IS NOT NULL
   AND rolled_back_at IS NULL;
SQL
  )"
  test -n "$database_checksum" && test "$local_checksum" = "$database_checksum" || {
    echo "checksum migration absent ou divergent: $migration" >&2
    exit 1
  }
done
```

Une divergence interdit le cutover. Ne jamais « résoudre » le problème en éditant
`_prisma_migrations`; créer une nouvelle migration corrective.

## Inventaire du stockage objet

Les clés sont content-addressées : une tentative interrompue ne réécrit pas un original, mais peut
laisser un objet sans ligne SQL. À l’inverse, une ligne SQL sans objet est une perte d’original.

Avec `DIRECT_URL`, exporter au minimum :

```sql
-- Objets du bucket qui ne sont référencés par aucune pièce/version.
SELECT object.name, object.created_at, object.updated_at, object.metadata
  FROM storage.objects AS object
 WHERE object.bucket_id = 'bob-documents'
   AND object.name LIKE 'companies/%/documents/%'
   AND NOT EXISTS (
     SELECT 1 FROM public.documents AS document
      WHERE document."storageKey" = object.name
   )
   AND NOT EXISTS (
     SELECT 1 FROM public.document_versions AS version
      WHERE version."storageKey" = object.name
   )
 ORDER BY object.created_at, object.name;

-- Originaux légaux générés dont la métadonnée objet est absente.
SELECT document."companyId", document.id, document.kind, document."storageKey", document.sha256
  FROM public.documents AS document
  LEFT JOIN storage.objects AS object
    ON object.bucket_id = 'bob-documents'
   AND object.name = document."storageKey"
 WHERE document.origin = 'generated'
   AND document.kind IN ('invoice_pdf', 'facturx_xml', 'signed_quote')
   AND object.id IS NULL
 ORDER BY document."companyId", document.id;
```

Remplacer `bob-documents` par la valeur certifiée de `SUPABASE_STORAGE_BUCKET`. Archiver les exports,
leur horodatage et leur SHA-256. Vérifier également par l’API d’administration Storage que chaque
objet critique est lisible et que taille/SHA correspondent à la version 1.

- Objet sans SQL : ne pas supprimer automatiquement. Le placer dans la file de revue/quarantaine,
  retrouver le job/correlation id et conserver les octets jusqu’à décision auditée.
- SQL sans objet, taille/hash divergents ou octets illisibles : P0, activation interdite.
- PDF historique non attesté : le scanner privilégié relit les octets, détecte le profil puis appelle
  la capacité d’attestation sous le tenant exact. Il ne déduit jamais le profil du nom ou du MIME.

### Scanner one-shot et preuve immuable

Le scanner remplace les contrôles manuels ci-dessus pour le gate final. Il ne tourne jamais sur le
runner GitHub : `railway run` exécute localement et ferait transiter les originaux par GitHub. Le
service Railway dédié utilise `Dockerfile.archive-audit` et `railway.archive-audit.json` :

- aucun domaine public ni healthcheck HTTP ;
- une seule instance en région européenne, `restartPolicyType = NEVER`, aucun cron ni
  `preDeployCommand`, veille applicative désactivée, `overlapSeconds = 0` et une fenêtre de drainage
  de 30 secondes pour laisser le scanner libérer proprement ses connexions et son verrou PostgreSQL
  après `SIGTERM` ;
- fichier Config-as-Code du service explicitement réglé sur `/railway.archive-audit.json`,
  `startCommand` et `dockerfilePath` fixés, auto-déploiement GitHub désactivé et aucun héritage
  silencieux du dashboard ; le runner relit tous ces réglages par GraphQL et refuse toute dérive
  **avant** de créer un déploiement ;
- image exacte du SHA à publier, Java/Mustang/FNFE/bubblewrap intégrés au build ;
- runtime UID/GID dédié non-root ; l’entrypoint vérifie son identité, la racine non inscriptible et
  son workdir avant tout accès aux données. Le smoke Bubblewrap est **lazy** : il s’exécute juste
  avant la première paire Factur-X professionnelle, jamais pour un inventaire vide/B2C qui ne lance
  aucun exécutable tiers ;
- uniquement `DIRECT_URL`, `DATABASE_URL`, `SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY`,
  `SUPABASE_STORAGE_BUCKET` et `DOCUMENT_ARCHIVE_SUPABASE_PROJECT_REF` ; aucun secret Stripe,
  OpenAI, Mistral ou mobile. L’origine HTTPS Supabase doit correspondre exactement au project ref
  attendu avant que la clé service-role puisse être envoyée.

Mustang 2.24.0 et le corpus FNFE-MPE 1.4.0.02 sont téléchargés **pendant le build sans secrets**,
vérifiés par SHA-256 puis intégrés en lecture seule. Pendant le scan, chaque validateur reçoit un
environnement sans secrets et tourne dans Bubblewrap avec espace PID isolé et réseau coupé. Le
smoke vérifie cette isolation une fois avant le premier usage et n’est mémorisé qu’après succès.
Railway refusant actuellement les namespaces non privilégiés, la première paire professionnelle y
produit un refus P0 sans attestation ni fallback ; un inventaire vide/B2C peut être certifié parce
qu’il n’exécute aucun validateur externe. Le support professionnel Railway reste fermé jusqu’à la
certification du launcher Landlock + seccomp décrit dans
`SPEC_ARCHIVE_AUDIT_RAILWAY_STABILIZATION.md`. Le corpus FNFE est vérifié à chaque usage, mais
jamais téléchargé pendant le traitement d’un document. La sentinelle négative BR-FR est exercée une
fois par job, pas une fois par facture.

Le workflow déclenche ce service par `serviceInstanceDeployV2(serviceId, environmentId, commitSha)`.
Le project token est borné à l’environnement ; la mutation n’est jamais rejouée si sa réponse est
perdue. Avant la mutation, le runner prend un instantané paginé des déploiements du service. Si la
réponse est absente, invalide ou réutilise un identifiant antérieur, il ouvre une fenêtre bornée de
convergence : au moins sept et jusqu’à huit instantanés espacés de dix secondes, soit au minimum
soixante secondes de surveillance après l’ambiguïté. Il suit les nouveaux identifiants du SHA demandé
ainsi que ceux dont la métadonnée de commit n’est pas encore propagée, tente de les
arrêter une seule fois, puis exige deux instantanés stables confirmant `deploymentStopped=true`.
Une cible encore active, disparue de la liste ou non convergée fait échouer le gate. Il refuse
également de muter tant qu’une instance antérieure du service n’est pas explicitement marquée
arrêtée par Railway. Le gate attend le déploiement exact et un unique marqueur final corrélé à
`RAILWAY_DEPLOYMENT_ID` et au SHA. Un statut Railway seul ne constitue jamais une preuve.
Le polling est espacé d’au moins dix secondes, respecte `Retry-After` dans une borne de soixante
secondes et ne double pas les mutations. Après le premier statut terminal `SUCCESS`, l’absence de
marqueur ne peut plus consommer le timeout global : la première enveloppe doit apparaître dans une
grâce terminale de soixante secondes. Dès `SUCCESS`, un polling terminal interne de dix secondes
remplace la cadence nominale afin de ne pas manquer un log retardé. Si l’enveloppe apparaît, une
phase séparée de soixante secondes au plus exige une seconde observation strictement identique.
Disparition, dérive ou dépassement échoue techniquement. La détection d’absence reste donc bornée à
60 secondes ; le cleanup distant
best-effort dispose ensuite d’une unique deadline absolue de 30 secondes partagée entre `stop` et
`cancel`. Toute sortie non acceptée tente ainsi une seule annulation ou un seul arrêt distant, sans
masquer l’erreur d’origine. Un refus métier garde son enveloppe non-PII et
ses codes canoniques ; un crash sans cette preuve reste une panne technique. `SIGHUP`, `SIGINT` et
`SIGTERM` interrompent les requêtes/pollings, conservent le handler pendant le cleanup idempotent,
retirent toute preuve locale écrite pendant la course puis ressortent avec le code Unix du signal.
Si le signal croise une réponse de création perdue et que l’hôte laisse le processus vivre, le runner
termine d’abord la réconciliation distante non annulable, puis restitue le code du signal. Lors
d’une [annulation GitHub Actions](https://docs.github.com/en/actions/reference/workflows-and-actions/workflow-cancellation),
le processus n’obtient toutefois qu’environ dix secondes : le job porte donc une condition
`always()` et enchaîne, après **tout** audit effectivement démarré — succès, refus, échec ou
annulation — un mode `--cleanup-only` indépendant. Railway peut en effet accepter
`deploymentStop` sur un one-shot déjà marqué `SUCCESS` sans retirer son instance encore `RUNNING` ;
le runner tente donc `deploymentCancel` en premier dans cet état. Le cleanup recherche pendant au
moins 60 secondes tout déploiement actif du SHA, l’annule ou le stoppe puis exige deux confirmations
d’arrêt avant de rendre la main. Son échec interdit toute activation, même si la preuve d’audit était
positive. Le conteneur Railway dispose séparément d’au plus 30 secondes entre `SIGTERM` et `SIGKILL`,
laissant au cleanup durable assez de temps pour observer sa terminaison même si tout ce délai de
drainage est consommé. Le job est borné à six
heures et refuse de démarrer l’audit après trois heures écoulées ; l’étape d’audit est elle-même
bornée à 100 minutes, le cleanup à quatre minutes, la preuve à dix minutes et l’activation à une
heure. Le hard-timeout du job ne peut donc pas supprimer la fenêtre de cleanup une fois l’audit lancé.
Le shell d’entrypoint relaie ces mêmes signaux à Node et attend sa sortie : le conteneur PID 1 ne
peut donc pas disparaître en laissant le scanner ou le verrou advisory vivre en arrière-plan.
Ce gate exige un projet Railway **Hobby ou Pro** : sa cadence nominale maximale est de 720 lectures
par heure pendant la courte phase `SUCCESS`, avec temporisation explicite sur `Retry-After`. Elle
n’est donc pas compatible avec les 100 requêtes par heure du plan Free. Voir les
[limites API Railway](https://docs.railway.com/integrations/api#rate-limits).

En protocole V1, le job prend un snapshot SQL + métadonnées `storage.objects`, relit chaque octet,
recalcule taille/SHA/MIME, détecte le profil PDF, valide
chaque paire professionnelle avec Mustang + FNFE puis écrit toutes les attestations manquantes dans
une transaction sérialisable via la capacité historique tenant-scopée. Au moindre P0 global, aucune
attestation n’est écrite. Un verrou advisory global sérialise tout scanner avec le flip V1 → V2 ;
un second snapshot est exigé avant d’accepter la preuve ; il doit être identique au premier hors
attestations exactes écrites par ce lot. L’activation refait ensuite l’inventaire Storage↔SQL sous
ses verrous pour fermer la fenêtre entre preuve et flip.

En protocole V2, cette capacité historique a été retirée. Le même job exécute donc le contrôle
`protocol-v2-verified` : il relit à nouveau **tous** les octets, recalcule taille/SHA/MIME, inspecte
chaque PDF et rejoue Mustang + FNFE sur chaque paire professionnelle, puis vérifie les invariants
relationnels, preuves de jobs, projection d’artefacts, Storage↔SQL, baseline du SHA d’activation et
absence de mutation d’un objet légal après sa version immuable. Il refuse toute attestation tardive
et ne tente jamais de restaurer un droit V1.

Le rapport détaillé peut contenir des identifiants de diagnostic : il reste en `0600` dans le
filesystem éphémère du conteneur puis est détruit. Avant toute sortie, le scanner persiste dans
`document_archive_audit_evidence` la preuve append-only liée à l’identité de base, au déploiement,
au SHA, au bucket, aux digests, versions et compteurs, ainsi que le rapport détaillé JSONB accessible
uniquement au rôle privilégié. GitHub ne reçoit qu’une enveloppe allowlistée sans PII, enrichie de
codes d’écart canoniques ; aucun PDF, XML, nom de fichier, identifiant tenant/document, URL ou secret
ne quitte Railway. Le marqueur n’est publié qu’après commit de cette preuve, sortie de la transaction
qui porte le verrou advisory et déconnexion des trois clients PostgreSQL.

Le marqueur est accepté uniquement si `readyForActivation=true`, `p0Issues=0`, mode/protocole
cohérents, validateurs exacts et trois SHA-256 canoniques. Une preuve CI préexistante n’est jamais
écrasée. Un échec ou timeout est fail-closed ; le rejeu crée un **nouveau** déploiement Railway et
une nouvelle preuve, sans modifier l’historique.

## Séquence obligatoire du train 1

1. Prouver le train 0 et enregistrer les checksums locaux des migrations encore non appliquées.
2. Déclencher le workflow GitHub **Railway API** avec `purpose=release` sur le ref exact. Le
   predeploy reçoit obligatoirement `BOB_RELEASE_SHA`, `BOB_RELEASE_RUN_ID`,
   `BOB_RELEASE_RUN_ATTEMPT` et `BOB_RELEASE_EXPECTED_ENV`; son préflight audience refuse le train
   avant toute mutation si un historique non revu existe. Sinon il applique les migrations,
   certifie V1, ferme Bob Live et écrit le reçu du run.
3. Le workflow déploie N, attend la readiness du SHA exact et prouve topologie, environnement,
   capacités et source d'IP. Ne jamais scanner pendant qu'une ancienne réplique ou un ancien lease
   peut finir un upload.
4. Le service one-shot archive audite le même SHA. En V1, son passage byte-derived applique
   atomiquement les attestations seulement après un inventaire intégral sans P0, persiste la preuve
   puis émet l'enveloppe sans PII.
5. Le workflow revalide la révision puis appelle l'opérateur unique
   `activate-release-protocols-v2.sh`. Il certifie la paire de bases, relit le reçu et active
   Archive, Settlement puis Outbox dans un seul snapshot Railway. Lancer
   `activate-document-archive-v2.sh` isolément n'est plus un chemin supporté.
6. Après une seconde preuve de la révision, le finaliseur postdeploy relit les preuves structurelles
   et ne rejoue le certificat comportemental Archive V2 que si ce SHA vient de l'activer en staging.
   Il ne relance ni migrations, ni provisioning, ni suite métier large.
7. Vérifier les métriques du worker : le backlog spoolé décroît, aucun échec de représentation ne se
   répète et aucun nouvel orphelin Storage n'apparaît.
8. Conserver logs, SHA, checksums, inventaires, reçu public non-PII et résultats ciblés avec la
   release. La liaison de secrets reste privée au runner et n'est jamais uploadée.

## Ce que fait atomiquement le script

Le script prend d’abord le même verrou advisory global que le scanner, puis ouvre une transaction
privilégiée unique et verrouille `storage.objects` avant les clients, devis, factures, documents,
versions, photos de chantier, attestations, jobs et projections. Il :

1. contrôle les migrations, le singleton, le bucket runtime, le rôle applicatif, les ACL/RLS des
   tables privées et l’inventaire fermé des RPC internes ;
2. refait sous verrou les deux directions Storage↔SQL et refuse tout orphelin/objet manquant apparu
   depuis la preuve ;
3. refuse toute facture émise sans snapshot d’audience audité ;
4. refuse toute représentation générée invalide, tout PDF facture sans attestation byte-derived et
   tout XML Factur-X hors scope professionnel ;
5. refuse toute preuve au mauvais scope et tout conflit entre jobs legacy ;
6. réconcilie uniquement le motif des jobs facture non prouvés, sans effacer statut, compteur ni
   marqueur `[archive-integrity-proof-required]` ;
7. revérifie les preuves et matérialise leur projection relationnelle ;
8. vérifie que l’XML embarqué dans chaque PDF/A-3 professionnel a le même SHA que l’XML séparé et
   qu’une B2C n’a aucun artefact XML ;
9. effectue le CAS monotone `1 → 2`, horodaté avec le SHA certifié ;
10. réarme les jobs au sentinel seulement après le flip, sans effacer leur historique ;
11. retire les mutations directes, les capacités V1 et le validateur pur temporairement requis par
    le CHECK SECURITY INVOKER de N-1, puis installe les ACL V2 et certifie données/triggers/privilèges.

La moindre erreur annule l’ensemble. Aucune preuve n’est réécrite, aucun conflit n’est fusionné et
aucune ligne ni aucun objet n’est supprimé.

## Conduite en cas d’échec

### Avant activation effective

- Ne pas contourner l’audit ni modifier le singleton à la main.
- Si le préflight audience bloque avant 1332, aucune migration d’archive n’a été appliquée : faire
  qualifier chaque facture historique par une revue comptable traçable avant de relancer. Ne jamais
  déduire silencieusement l’audience depuis la fiche client actuelle.
- Lire l’erreur PostgreSQL et identifier le document/job avec `DIRECT_URL` en lecture seule.
- Pour une preuve, un snapshot ou un profil incohérent, suspendre la publication et ouvrir une revue
  comptable/technique. Ne jamais recalculer silencieusement l’original.
- Corriger par une migration additive ou un outil d’administration audité, puis recommencer le train.

Un échec avant commit laisse la base en V1, les ACL expand intactes et les jobs au sentinel.

### Après activation effective

- Ne jamais remettre `activeVersion` à `1` et ne jamais redéployer N-1.
- En cas d’incident, suspendre le worker si nécessaire et livrer N+1 en roll-forward.
- Une relance du script d’activation est idempotente : elle conserve SHA/horodatage initiaux,
  recontrôle les invariants V2 et répare seulement un éventuel job non prouvé resté au sentinel.

Le contrôle V2 intégral reste volontairement O(N) pour le cutover et les premières releases. Avant
que le volume rende ce coût excessif, une tranche séparée devra ajouter un audit incrémental fondé
sur la baseline immuable et un scrub intégral planifié/checkpointé. Cette optimisation ne doit jamais
remplacer le scrub périodique ni être présentée comme livrée tant qu’elle n’est pas certifiée.

## Preuves attendues

- readiness train 0 : capability `documentArchiveB2cHttpFence = "v1"`, mono-SHA, zéro N-1 ;
- checksums des neuf migrations identiques aux lignes Prisma appliquées ;
- inventaires Storage/SQL bidirectionnels datés et hashés, preuve DB liée au déploiement Railway ;
- avant activation : `RUN_POSTGRES_DOCUMENT_ARCHIVE_ROLLOUT_CERT=true` ;
- après activation : `RUN_POSTGRES_DOCUMENT_ARCHIVE_CERT=true` ;
- `activatedByReleaseSha` identique au SHA readiness du premier passage ;
- zéro facture émise sans snapshot, zéro représentation/attestation invalide ;
- zéro job non prouvé avec lease ou sentinel après activation ;
- zéro droit direct de mutation du runtime sur jobs, artefacts ou attestations ;
- zéro privilège Data API (`anon`, `authenticated`, `service_role`) sur les preuves/tables privées,
  zéro mutation de singleton et zéro EXECUTE sur les 31 RPC archive internes ;
- helper profond inaccessible, wrapper RLS tenant-scopé et capacité d’attestation accessibles ;
- capacités V1 `enqueue/complete` inaccessibles, capacités V2 accessibles ;
- triggers de spool, de matérialisation, d’immutabilité et de monotonie actifs.
- trigger d’immutabilité `storage.objects` actif sur les originaux légaux générés ;
- preuve V2 issue d’une relecture intégrale et rattachée au même SHA que l’activation V1 certifiée.
