# Espace Cabinet — État de reprise

> À lire après `ARCHITECTURE.md`, `GLOSSAIRE.md` et `SLICES.md`.
> Ce fichier décrit uniquement ce qui est réellement terminé selon la Definition of Done V3.

## État courant

- Date d'audit : 2026-07-12.
- HEAD de départ de l'implémentation : `49be95e`.
- Phase : **implémentation locale de la Slice 0**.
- Slice active : **Slice 0 — Fondations et rails**.
- Checkpoint : **validé par le fondateur le 2026-07-12** (« bien continues puissance max »).
- Livraison V3 : **0/15 slices acceptées**.

## Fait

- exploration du monorepo, auth, RLS, Prisma/migrations, notifications, documents, Invoice,
  agent vocal, tests, CI/CD et web cabinet ;
- architecture cible, modèle, API, écrans, jobs, stratégie de migration/déploiement ;
- ubiquitous language et carte fidèle des 15 slices ;
- décision proposée : `Cabinet` distinct de `Company`, membership DB source d'autorité ;
- décision proposée : référentiel fiscal seul runtime, moteur historique simple oracle ;
- audit transverse du design web et rattachement de sa correction à la Slice 0 ;
- retrait du prototype non commité de Slice 12 qui modélisait `Company↔Company`.

## Ce qui n'est pas livré

- les fichiers de `docs/espace-cabinet` sont un plan, pas une implémentation ;
- le web cabinet reste localStorage, sans auth/API ;
- aucun Cabinet/CabinetMember/RBAC/flag/RLS cabinet ;
- aucune chaîne de déploiement web ou staging→prod prouvée ;
- aucune slice n'a ses e2e, smoke production et métriques d'acceptation.

## Travail préparatoire hors acceptation

L'audit design a trouvé :

- couleurs web dupliquées au lieu de `@bob/tokens` ;
- typographies et poids non conformes ;
- CTA primaire vert alors que le primaire Bob est navy ;
- TypeScript web moins strict ;
- copie cabinet en dur au lieu de `@bob/i18n` Pro ;
- plusieurs écarts clavier/focus/drawer/table/toasts.

Une extension locale de `toCssVars` et de son test peut être présente dans le worktree. Elle
n'est ni connectée au web ni acceptée : elle devra être finalisée et validée dans le rail UI
de la Slice 0, ou retirée avant toute autre livraison.

## Checkpoint et limites externes

Le plan de `CHECKPOINT.md` est accepté. Le développement local est autorisé. L'acceptation
finale de la Slice 0 reste conditionnée aux éléments externes non encore confirmés :

1. cible staging séparée pour API, web et DB/Supabase ;
2. credentials CI/CD disponibles dans les secrets du provider ;
3. cible de déploiement `apps/web` ;
4. configuration email d'invitation et destination d'erreurs/alertes ;
5. comptes et cabinet pilote pour les smoke tests.

Ces absences ne bloquent pas le code et les tests locaux ; elles bloquent staging, production
et donc le passage de la Slice 0 au statut « acceptée ».

## Infra livrée (session A, 2026-07-12) — prérequis checkpoint résolus

- **STAGING COMPLET ET SMOKE-TESTÉ** : environnement Railway `staging` (dupliqué puis isolé),
  Postgres dédié `bob-pro-db-staging`, rôle `bob_app` NOSUPERUSER/NOBYPASSRLS, 13 migrations +
  grants + RLS + **certification adversariale RLS passée** (release.sh complet), bucket Supabase
  `bob-documents-staging`, variables isolées (DATABASE_URL staging ≠ prod, vérifié).
  URL : https://bob-pro-api-staging.up.railway.app — smoke : health live · ready 200 ·
  403 sans token · lookup public 200. La chaîne staging→prod du cahier est OUVERTE.
- **BREVO** : clé API validée (compte OK) et posée sur staging + prod (`BREVO_API_KEY`).
  EN ATTENTE humain : (1) désactiver la restriction par IP (sinon Railway sera rejeté) ;
  (2) sender — le DOMAINE n'est pas figé et LE NOM DE L'APP PEUT CHANGER (directive fondateur
  2026-07-12) → sender définitif reporté ; pour les tests : adresse personnelle validée suffira.
- **Pièges corrigés au passage** : dossier de migration VIDE (reliquat du prototype retiré)
  cassait tout `prisma migrate deploy` — supprimé ; courses sur pnpm-lock.yaml (chantier CAB-0C)
  — lockfile synchronisé et règle rappelée au protocole.

## Journal

| Date | Phase | Statut | Résultat |
|---|---|---|---|
| 2026-07-12 | Découverte initiale | corrigée | Première cartographie créée, puis audit adversarial |
| 2026-07-12 | Audit adversarial | terminé | Aucun vertical V3 accepté ; statuts et ADR corrigés |
| 2026-07-12 | Prototype relation | retiré | Hors séquence Slice 12 et mauvais tenant `Company↔Company` |
| 2026-07-12 | Checkpoint | validé | Autorisation d'exécuter la V3 en autonomie |
| 2026-07-12 | Slice 0 | en cours | Domaine, API/RLS/flags et web/design lancés en parallèle |

## Règle de reprise

Reprendre la Slice 0 sur le premier item non validé de sa Definition of Done, puis exécuter
domaine→application→infra→API→web→tests→staging→prod. Ne pas commencer la Slice 1 tant que la
Slice 0 n'est pas acceptée et enregistrée ici.
