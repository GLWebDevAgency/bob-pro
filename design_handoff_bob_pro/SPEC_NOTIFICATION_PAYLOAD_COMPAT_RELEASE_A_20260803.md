# SPEC — Notification payload compatibility, release A

**Date** : 2026-08-03
**Statut** : `implemented`
**Objectifs servis** : O2 — facture probante ; O7 — release reproductible

## Objectif

Déployer, avant le contrat notification V3, un worker N-1 sûr qui ne peut jamais envoyer un
payload portant des champs qu'il ne comprend pas ou qui ne sont pas couverts par son empreinte
historique. Cette release A est un préalable de rolling deploy ; elle ne crée aucun payload V3.

## Portée

- décodage strict du payload historique `channel/to/subject/body/idempotencyKey` ;
- vérification de son empreinte historique avant toute livraison ;
- quarantaine durable et auditée des payloads étendus, inconnus ou altérés ;
- pagination bornée pour qu'une ligne quarantinée n'affame pas les jobs valides suivants ;
- parité Prisma / in-memory et tests ciblés.

## Non-objectifs

- aucune émission d'empreinte `sha256-v2` ;
- aucune activation de la policy V3 ;
- aucune pièce jointe d'archive dans cette release ;
- aucune modification Bob Live.

## Invariants

1. Le worker historique n'envoie que les cinq champs qu'il sait décoder et dont les quatre champs
   sémantiques sont scellés par l'empreinte V1 ; toute clé supplémentaire ferme la livraison. Les
   colonnes `channel/recipient/subject` doivent aussi correspondre exactement au payload.
2. Une ligne invalide devient `failed`, payload purgé, échéance à l'an 9999 et erreur
   `[manual-review:*]`; elle n'est jamais reconstruite automatiquement.
3. La quarantaine se fait sous CAS : elle ne peut ni reprendre ni écraser le claim d'un autre
   worker.
4. Une page corrompue ne masque pas les jobs valides suivants ; le scan reste borné.
5. Fermeture produit annoncée : pendant l'intervalle release A → release B, toute notification
   utilisant expéditeur personnalisé, CC ou pièce jointe est volontairement mise en quarantaine.
   Le repli est la recréation depuis les snapshots autoritaires après activation V3, jamais le
   rejeu du payload non scellé.

## Critères d'acceptation binaires

- [x] Un payload minimal avec empreinte V1 exacte est livré.
- [x] Changer body ou empreinte le met en quarantaine avant provider.
- [x] Ajouter n'importe quelle clé hors contrat minimal le met en quarantaine avant provider.
- [x] Un payload dont l'empreinte est recalculée mais qui diverge des colonnes autoritaires est
      mis en quarantaine.
- [x] Au moins `limit` lignes invalides suivies d'une valide n'affament pas indéfiniment la valide.
- [x] La quarantaine est tenant-scoped, CAS sur `updatedAt`, et purge le payload.
- [x] Les doubles Prisma et in-memory donnent le même résultat.
- [x] Tests ciblés, typecheck API et build API passent.
- [x] Revue adversariale sans P0/P1.
- [ ] Avant le premier déploiement Release A, les workers de notification sont arrêtés/drainés et
      la base prouve zéro `leaseToken` actif ; ils ne sont réactivés qu'avec le SHA Release A.
- [ ] Release A est validée sur staging puis déployée sur toutes les répliques avant la PR V3.

## Definition of Done

`implemented` : code + tests + typecheck/build + revue.
`certified` : preuve staging que le worker quarantinera une extension et continuera le job suivant.
`released` : SHA déployé sur toutes les répliques ; seulement alors la release B peut être mergée.

## Preuves locales — 2026-08-03

- `pnpm --filter @bob/api exec vitest run` sur les 7 suites verticales touchées :
  **168/168** tests verts ;
- suite Vitest API exhaustive : **235** fichiers verts, **2 933** tests verts,
  **47** fichiers d'intégration opt-in ignorés ;
- gardes Node de release : un premier passage a exposé un test temporel instable comparant deux
  JWT générés de part et d'autre d'une frontière de seconde ; il a été rejoué à **42/42**, puis le
  train API complet a repassé à **637/637** (un certificat PostgreSQL opt-in ignoré) ;
- schéma staging M2-A-3 : **83/83** tests locaux verts (un certificat PostgreSQL opt-in ignoré) ;
- `pnpm --filter @bob/api typecheck` : vert ;
- `pnpm --filter @bob/api lint` : vert ;
- `pnpm --filter @bob/api build` : vert, artefact certifié **450 fichiers**, aucune fixture ;
- `git diff --check` : vert ;
- revue adversariale indépendante : aucun P0/P1 technique restant après correction de la
  sélection Prisma des payloads `NULL`, restauration de la garde UUID et réalignement des fixtures.

Les preuves de drain, de zéro lease, de staging Supabase/Railway et de déploiement ne sont pas
acquises par ces commandes locales ; leurs critères restent donc explicitement décochés.
