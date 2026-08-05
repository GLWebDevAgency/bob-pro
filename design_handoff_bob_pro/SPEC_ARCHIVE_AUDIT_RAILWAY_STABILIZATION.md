# SPEC — Stabilisation de l’audit d’archive sur Railway

**Objectifs servis : O2 — Facturation conforme ; O7 — Release reproductible**

**Statut : implemented**

**Incidents de référence :** releases staging `30331071407` et `30339346237`, 28/07/2026 ;
release staging `30997199741`, 05/08/2026

## 1. Problème prouvé

Le service one-shot d’archive démarre comme utilisateur non-root dans un conteneur Railway isolé,
mais son entrypoint exécute toujours un smoke Bubblewrap avant de lire l’inventaire. Railway refuse
la création des namespaces Linux demandés :

```text
bwrap: Creating new namespace failed: Permission denied
```

Le processus sort avant tout accès à PostgreSQL ou Storage. Railway marque néanmoins le déploiement
`SUCCESS`. Sans marqueur `BOB_DOCUMENT_ARCHIVE_AUDIT_EVIDENCE`, l’orchestrateur continue alors de
poller jusqu’au timeout global de 5 400 secondes. La release reste bloquée alors que :

- le déploiement one-shot est déjà terminal et arrêté ;
- aucune preuve n’existe ;
- attendre ne peut plus changer le résultat.

La base staging comptait zéro document légal généré lors de l’incident. Un inventaire vide n’a
besoin d’exécuter ni Mustang ni FNFE, mais l’entrypoint l’interdit aujourd’hui avant même de le
savoir.

Le premier passage exact-SHA réparé a ensuite prouvé le one-shot d’archive, mais un certificat
PostgreSQL historique a échoué après activation : sa fixture utilisait un `companyId` aléatoire
avec un SIRET réel et un NIC choisi dans seulement 10 000 valeurs. Une interruption antérieure
avait laissé une société de test orpheline ; le run suivant a heurté l’unicité de `companies.siret`.

Le passage suivant a certifié cette reprise et activé archive/settlement V2, puis a révélé un second
défaut de rejouabilité : l’opérateur outbox rappelait un SQL de transition après un cutover déjà
terminal. Le `RETURN` contenu dans un bloc `DO` quittait seulement ce bloc, pas le fichier ; les
instructions suivantes relisaient donc la colonne expand `cutoverResumeAt`, volontairement retirée
à la première activation.

La release `30997199741` a ensuite prouvé une hypothèse Railway erronée dans l’orchestrateur :
`deployment.status=SUCCESS` signifie que l’image a été déployée, pas que le processus one-shot a
terminé. Le conteneur de l’auditeur a démarré à `10:49:57Z`, sans erreur, puis son instance est
restée `RUNNING`. La preuve immuable exacte `5/0/6` a été persistée en base à `10:49:59Z`, mais le
marqueur non-PII n’était publié qu’après la fin de la transaction de lease et la déconnexion des
trois clients Prisma. Cette finalisation n’a pas rendu la main. L’orchestrateur a armé immédiatement
sa grâce terminale de 60 secondes, envoyé `SIGTERM` à `10:51:01Z` et interrompu le runtime avant la
publication du marqueur. La readiness API et les migrations étaient vertes ; aucun objet n’a été
supprimé et aucune enveloppe n’a atteint GitHub. Deux fragilités sont donc prouvées : un statut de
déploiement sans état d’instance ne distingue pas « image démarrée » de « runtime terminé », et une
preuve durable ne doit pas dépendre d’un transport log placé après toutes les libérations locales.

## 2. Résultat attendu

Le one-shot Railway sait certifier un inventaire ne contenant aucune paire Factur-X professionnelle.
Il conserve Bubblewrap comme unique sandbox autorisé pour les validateurs externes et le vérifie
juste avant leur premier usage réel.

Si une paire professionnelle est présente alors que Railway ne peut pas exécuter Bubblewrap :

- aucun validateur externe n’est lancé hors sandbox ;
- aucune attestation n’est écrite ;
- la paire produit les écarts P0 canoniques de conformité externe ;
- `readyForActivation` reste faux et la release échoue fermée.

Un déploiement Railway `SUCCESS` dont une instance reste non terminale continue à consommer le
timeout global du scan. La fenêtre terminale courte ne commence qu’après l’observation d’au moins
une instance et la disparition de toute instance non terminale. Un état d’instance absent ou
incohérent ne vaut jamais preuve de fin.

Le marqueur allowlisté est publié et son flush attendu immédiatement après la persistance immuable
de l’enveloppe, à l’intérieur de la lease. Cette publication ne suffit pas à activer : le cleanup
Railway indépendant doit ensuite prouver l’arrêt de l’instance et donc la libération de ses
connexions et verrous. L’ordre devient ainsi « preuve durable → transport corrélé → quiescence
externe → activation », sans transformer un `$disconnect()` local en canal unique de preuve.

## 3. Portée

### Inclus

1. Déplacer le smoke Bubblewrap de l’entrypoint vers le validateur Factur-X, au premier appel réel.
2. Mémoriser uniquement un smoke réussi ; un échec ne peut jamais devenir un succès mis en cache.
3. Conserver l’environnement nettoyé, le réseau isolé, la racine en lecture seule et le seul
   workdir inscriptible pour Mustang/FNFE.
4. Distinguer le succès du déploiement de la terminaison du runtime à partir de l’inventaire typé
   des instances Railway (`CREATED`, `INITIALIZING`, `RESTARTING`, `RUNNING`, `REMOVING` restent
   non terminaux).
5. Borner l’attente d’un marqueur pendant 60 secondes seulement après une terminaison runtime
   prouvée ; une instance encore non terminale conserve le timeout global du scan.
6. Si un premier marqueur valide apparaît, ouvrir une phase de confirmation
   séparée et bornée à 60 secondes, puis exiger exactement la même enveloppe une seconde fois.
7. Publier exactement une fois le marqueur non-PII juste après la persistance immuable en base,
   attendre explicitement le flush stdout, puis laisser le cleanup Railway prouver la quiescence.
8. Mettre le runbook et la source de vérité environnementale en accord avec le comportement réel.
9. Certifier le chemin staging exact-SHA sur le service one-shot Railway.
10. Rendre le harness d’intégration Bob hermétique au réseau tiers : la suite de release ne doit
   jamais dépendre de la latence d’un fournisseur LLM pour atteindre son repli déterministe.
11. Rendre le certificat d’émission facture rejouable après interruption : identité explicitement
   fictive, réconciliation préalable limitée au namespace d’id de la suite, cleanup final commun.
12. Rendre l’opérateur d’activation outbox V2 réellement rejouable : état terminal certifié =
    succès sans mutation ; forme expand complète = transition ; toute forme mixte = refus fermé.

### Non inclus

- remplacer Bubblewrap par `/usr/bin/env`, retirer seulement `--unshare-user`, exécuter en root ou
  ajouter `CAP_SYS_ADMIN` ;
- déclarer les validateurs professionnels compatibles Railway ;
- activer Archive V2 sur une base contenant une paire professionnelle non validée ;
- concevoir dans ce lot le futur launcher Landlock + seccomp ;
- modifier Production.

## 4. Invariants

1. **Aucun fallback non sandboxé.** Mustang et FNFE ne s’exécutent jamais directement.
2. **Zéro secret vers les validateurs.** Le smoke et chaque commande conservent `--clearenv` et
   l’allowlist actuelle.
3. **Fail-closed par paire.** Une sandbox indisponible est une non-conformité externe, jamais une
   paire ignorée.
4. **Écriture atomique inchangée.** Un P0 global interdit toute attestation du lot.
5. **Preuve obligatoire.** `SUCCESS` Railway ne vaut jamais succès métier sans enveloppe corrélée
   au deployment id et au SHA.
6. **Deadline réelle.** Requêtes GraphQL, retries, `Retry-After` et backoffs partagent la même
   deadline absolue ; aucun appel réseau ne peut recréer une attente de 90 secondes par poll.
7. **Cleanup conservé et borné.** Toute sortie non acceptée tente l’arrêt distant sans masquer
   l’erreur initiale ; `stop` puis `cancel` partagent une seule deadline absolue de 30 secondes.
8. **Données privées.** GitHub ne reçoit toujours que l’enveloppe non-PII allowlistée.
9. **Aucune promesse excessive.** `O2` reste au plus `implemented` tant qu’une vraie paire
   Mustang/FNFE n’a pas été certifiée sous un sandbox compatible Railway.
10. **Tests hermétiques.** Un test qui certifie le classifieur local interdit explicitement tout
    réseau cloud ; une clé sentinelle ne vaut jamais isolation réseau.
11. **Fixtures distantes bornées.** Une reprise ne supprime jamais par SIREN ou libellé : elle ne
    réconcilie que le préfixe d’identifiants réservé au certificat, puis réactive les triggers avant
    chaque suppression finale.
12. **Idempotence au bon niveau.** Le SQL de cutover reste une transition atomique à usage unique ;
    l’opérateur détecte et certifie l’état terminal avant de l’appeler. Un `RETURN` PL/pgSQL n’est
    jamais interprété comme une sortie du fichier `psql`.
13. **État runtime explicite.** `deployment.status=SUCCESS` avec une instance non terminale est un
    audit en cours. La grâce terminale ne peut être armée que si au moins une instance a été
    observée et qu’elles sont toutes terminales ; une liste vide reste ambiguë et fail-closed sous
    la deadline globale.
14. **Preuve puis quiescence.** Le marqueur n’est émis qu’après le commit de l’enveloppe immuable,
    mais avant les nettoyages locaux potentiellement bloquants. Il ne permet aucune activation tant
    que le cleanup Railway n’a pas certifié zéro instance non terminale.

## 5. Critères d’acceptation binaires

- [ ] L’entrypoint non-root atteint le job d’audit sur Railway sans lancer Bubblewrap.
- [x] Un inventaire sans paire professionnelle n’appelle jamais la sandbox et produit une
      enveloppe `readyForActivation=true`, `p0Issues=0`.
- [x] Un inventaire B2C seul n’appelle jamais Mustang/FNFE.
- [x] La première paire professionnelle exécute exactement un smoke sandbox avant le premier
      validateur.
- [x] N paires professionnelles réutilisent uniquement un smoke précédemment réussi.
- [x] Un smoke refusé produit les P0 de conformité externe, zéro attestation et aucun fallback.
- [x] Un statut Railway `SUCCESS` avec instance `RUNNING` pendant plus de 60 secondes ne déclenche
      ni erreur terminale ni cleanup ; le marqueur tardif reste lu et validé sous la deadline
      globale.
- [x] Un statut Railway `SUCCESS` avec au moins une instance observée puis toutes les instances
      terminales, sans marqueur, fige son erreur au plus 60 secondes après cette terminaison avec
      le code stable `ARCHIVE_AUDIT_TERMINAL_EVIDENCE_MISSING` ; le cleanup best-effort qui suit
      ajoute au plus 30 secondes.
- [x] Une réponse Railway sans tableau d’instances, avec identifiant/statut d’instance invalide ou
      avec statut inconnu échoue fermée et ne fabrique jamais une terminaison.
- [x] Une preuve committée est publiée avant un nettoyage local artificiellement bloqué ; le flush
      du marqueur est acquitté, le runner la lit deux fois, puis le cleanup externe rend l’instance
      quiescente avant toute activation.
- [x] Un échec de persistance n’émet aucun marqueur ; un échec de transport n’est jamais transformé
      en succès, même si une ligne durable existe.
- [x] Un marqueur apparu dans cette fenêtre est confirmé par une enveloppe strictement identique
      dans une seconde fenêtre de 60 secondes au plus ; dès le premier `SUCCESS`, la recherche puis
      la confirmation utilisent un polling terminal de 10 secondes indépendant de la cadence
      nominale. Disparition ou dérive échoue immédiatement avec
      `ARCHIVE_AUDIT_TERMINAL_EVIDENCE_UNSTABLE`.
- [x] Les statuts de déploiement transitoires et les instances runtime non terminales utilisent le
      timeout global prévu pour un vrai scan.
- [x] Les tests interdisent explicitement `/usr/bin/env`, `|| true` et la suppression de la sandbox.
- [x] Les scénarios Bob déterministes du gate de release ne peuvent effectuer aucun appel réseau
      vers un fournisseur LLM et restent stables sous charge CI.
- [ ] Le certificat PostgreSQL d’émission purge une fixture interrompue puis repasse intégralement
      sur staging sans collision ni résidu.
- [ ] Deux appels successifs de l’opérateur outbox V2 réussissent sur PostgreSQL, le second sans
      mutation ni dépendance à la colonne expand supprimée.
- [ ] L’image `Dockerfile.archive-audit` est réellement construite.
- [ ] Le one-shot staging au SHA exact produit une enveloppe corrélée puis termine arrêté, sans
      déploiement actif résiduel.

## 6. Definition of Done

- [ ] Tests unitaires du runner, du validateur et de l’image verts.
- [x] Typecheck, lint, build API et gardes d’artefact verts.
- [ ] CI complète de PR verte.
- [x] Review adversariale sécurité/correctness confirmant zéro exécution externe non sandboxée.
- [ ] Certification Supabase/Railway staging sur le SHA exact.
- [x] Documentation normative mise à jour sans présenter le support professionnel comme livré.
- [ ] PR courte fusionnée avant tout autre chantier ; branche et worktree supprimés.

## 7. Suite explicitement séparée

Le support de vraies paires professionnelles sur Railway exige un launcher non privilégié,
fail-closed si le kernel ne fournit pas les primitives attendues :

- Landlock pour l’allowlist filesystem et les symlink escapes ;
- seccomp pour réseau, ptrace, `process_vm_*`, mount et BPF ;
- `no_new_privs`, limites CPU/RSS/fichiers/processus et terminaison du groupe ;
- identité/version du launcher incluse dans `validatorEvidenceDigest`.

Cette suite ne devient `certified` qu’après un test réel Railway prouvant le refus du réseau, de
`/proc/1/environ`, des écritures hors workdir et des échappements par symlink.
