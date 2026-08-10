# STORE-DELETE-01 — Demande web de suppression de compte

**Statut : `implemented`**  
**Objectif parent : `OBJ-PUB-V1` / O7 — release reproductible et livrabilité stores**  
**Date : 2026-08-02**  
**Portée : Google Play et information RGPD publique**

Cette spec affine le cap de publication et s'appuie désormais sur le protocole de clôture durable
`ACCOUNT-DELETE-LIFECYCLE-01`. La
demande authentifiée reste le parcours principal de l'application (`DELETE /account`). La
surface web permet à une personne qui n'a plus accès à l'application d'initier une demande ; elle
ne devient jamais un endpoint destructif anonyme.

## 1. Objectif

Publier une ressource web Bob Pro à `/account-deletion` qui :

1. nomme sans ambiguïté Bob Pro et la suppression du compte ;
2. explique le chemin de demande authentifiée dans l'application ;
3. permet d'envoyer une demande externe à l'adresse support réellement configurée ;
4. décrit les catégories effacées et celles conservées pour obligation légale ;
5. renvoie vers la politique de confidentialité ;
6. est indexable, utilisable au clavier et lisible sur mobile ;
7. n'expose aucun secret et ne collecte aucune donnée dans sign-web.

## 2. État réel avant lot

- Le mobile expose déjà `Compte → Zone sensible → Supprimer mon compte`, avec confirmation par le
  nom exact de l'entreprise.
- La baseline auditée tentait la suppression Supabase Auth après commit, sans retry durable, et ne
  fermait pas les notifications. La candidate locale remplace ce comportement par une clôture
  atomique avec outbox, worker reprenable, annulation/minimisation des notifications et fences
  email/push ; elle n'est ni committée sur `main`, ni rejouée sur Supabase staging, ni déployée.
- L'URL de production `https://bob-pro-sign-web.vercel.app/account-deletion` répondait HTTP 404 le
  2 août 2026.
- Le contact réellement injecté dans les binaires preview/production est
  `ghassenelimame@gmail.com`. L'adresse de marque reste une décision fondateur non fournie.

## 3. Invariants

- **I1 — Pas de suppression anonyme.** La page ne doit appeler ni l'API métier, ni Supabase, ni une
  Server Action destructive.
- **I2 — Vérification hors bande.** Une demande email n'est qu'une demande ; l'opérateur vérifie
  l'identité avant toute action. La page ne promet pas une suppression automatique.
- **I3 — Minimum de données.** Le message prérempli demande uniquement l'email du compte et le nom
  de l'entreprise. Il interdit mot de passe, token, pièce d'identité et document métier dans le
  premier message.
- **I4 — Vérité de rétention.** Les accès et données personnelles effaçables sont distingués des
  pièces comptables déjà émises conservées pendant leur durée légale.
- **I5 — Un contact vivant.** `NEXT_PUBLIC_SUPPORT_EMAIL` remplace le contact local courant au
  build. Un build Vercel distribué échoue s'il n'a pas une valeur explicite ; le repli vers l'adresse
  déjà certifiée par le garde mobile est réservé au développement, aux tests et au build local.
- **I6 — Zéro JavaScript client nécessaire.** La page reste un Server Component statique et le
  déclenchement utilise un lien `mailto:`.

## 4. Périmètre

### Inclus

- page publique et métadonnées indexables ;
- instructions in-app et demande externe par email prérempli ;
- explication suppression/conservation ;
- lien vers la confidentialité ;
- lien depuis le pied des pages légales ;
- configuration documentée du contact support ;
- test de contrat, typecheck et build Next.

### Non-objectifs

- inventer l'identité légale, un domaine ou une adresse `support@` ;
- créer une route API publique de suppression ;
- automatiser la vérification d'identité ou le traitement DSAR ;
- modifier davantage la transaction `DELETE /account` au-delà du lot backend O7 documenté ;
- déployer ou modifier Vercel sans un train de release exact-SHA ;
- déclarer le lot `certified` avant preuve HTTP et demande reçue sur l'environnement cible.

## 5. Critères d'acceptation binaires

| ID   | Critère                                                                                                                                                                     | Preuve attendue                                                                                        |
| ---- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------ |
| AC1  | Next génère la route `/account-deletion` sans client JavaScript propre au parcours.                                                                                         | Build sign-web vert et manifeste de routes.                                                            |
| AC2  | Le H1 associe explicitement « Bob Pro » et « suppression de compte ».                                                                                                       | Test de rendu statique.                                                                                |
| AC3  | Les étapes in-app exactes et un lien `mailto:` vers le support configuré sont visibles ; un build Vercel refuse un contact absent.                                          | Test de rendu + résolution de config + inspection du href encodé.                                      |
| AC4  | Le message prérempli interdit secrets et pièces jointes sensibles ; aucune donnée n'est postée à sign-web.                                                                  | Test de contrat + absence de form/action/fetch.                                                        |
| AC5  | Les données effaçables et les documents soumis à conservation sont distingués.                                                                                              | Test de rendu.                                                                                         |
| AC6  | La politique de confidentialité est liée et la page autorise index/follow.                                                                                                  | Test de métadonnées.                                                                                   |
| AC7  | Le lien est découvrable depuis les deux pages légales.                                                                                                                      | Test de contrat ou inspection du shell.                                                                |
| AC8  | Typecheck et build sign-web passent depuis le worktree courant.                                                                                                             | Sorties de commandes datées.                                                                           |
| AC9  | Une demande réelle est traitable de bout en bout : URL 200, mail reçu, identité vérifiée, clôture opérateur sûre, effacement/rétention contrôlés et confirmation envoyée.   | Reçu exact-SHA + runbook exercé + reçu de suppression Auth ou retry durable ; requis pour `certified`. |
| AC10 | La politique de confidentialité ne contient plus de placeholder et sa matrice suppression/rétention correspond au runtime, au Storage, aux logs, backups et sous-traitants. | Revue juridique et technique cosignée ; requise pour `certified`.                                      |

## 6. Definition of Done

Le lot passe à `implemented` lorsque AC1–AC8 sont prouvés. Il passe à `certified` uniquement lorsque
AC9 et AC10 sont prouvés sur staging puis production conformément à
`PR → staging validé → production`.
Recevoir un email n'est pas suffisant : l'API publique `DELETE /account` exige le JWT du titulaire
et une demande externe exige encore un parcours opérateur vérifié. La candidate locale possède une
file Auth durable, mais tant que migration, rôle, ACL/RLS, worker et runbook ne sont pas prouvés sur
Supabase staging puis production, la fiche Google Play ne doit pas déclarer ce cycle certifié.

## 7. Blocages fondateur conservés

- `[BLOQUÉ FONDATEUR : nom/adresse support de marque et accès à la boîte]`
- `[BLOQUÉ FONDATEUR : accès Play Console pour enregistrer l'URL et réaliser la déclaration Data Safety]`
- `[BLOQUÉ OPÉRATIONS : mécanisme opérateur authentifié, confirmation finale et exercice du runbook]`
- `[BLOQUÉ CERTIFICATION : migration/outbox/worker/ACL rejoués sur Supabase staging puis production]`

## 8. Écarts découverts par l'audit adversarial

La certification exige toujours un lot RGPD/opérations et une promotion exacte de la candidate
backend. L'état du 2 août 2026 présente encore ces P0 :

- la candidate locale fournit désormais outbox, retry durable, `404` idempotent, annulation et
  minimisation des notifications, fences email/push, binding propriétaire et garde Cabinet, mais
  elle n'est pas fusionnée sur `main`, exécutée en CI du SHA publié, rejouée sur Supabase staging
  ou déployée ;
- clients, contacts, brouillons, documents/OCR/Storage, dépenses, préférences, journaux IA et une
  partie des données realtime restent conservés sans plan d'effacement par catégorie ;
- les devis ne sont pas distingués entre brouillon, signé, transformé ou légalement retenu ;
- aucun outil opérateur ne transforme une demande email vérifiée en clôture sûre sans SQL manuel,
  faux JWT ou dashboard destructif ;
- la politique publique promet encore que « tout le reste » disparaît à la clôture, contrairement
  au runtime, et contient des placeholders.

La page web ne doit jamais masquer ces écarts : elle parle d'initiation, de traitement et de
confirmation finale, pas d'effacement instantané.

## 9. Preuves d'implémentation — 2026-08-02

AC1 à AC8 sont reproductibles depuis le worktree courant :

- `pnpm --filter @bob/sign-web test` : **4 tests sur 4 passent** ;
- `pnpm --filter @bob/sign-web typecheck` : **passe** ;
- `VERCEL=1 NEXT_PUBLIC_SUPPORT_EMAIL=ghassenelimame@gmail.com pnpm --filter @bob/sign-web build` :
  **passe**, avec `/account-deletion` pré-rendue en route statique ;
- serveur de production local : **HTTP 200**, titre, H1, `mailto:`, lien confidentialité et
  `robots=index,follow` présents, aucun élément `<form>` ;
- contraste de l'avertissement : **6,79:1** sur son fond, au-dessus du minimum WCAG AA pour le
  texte normal.

AC9 et AC10 restent non prouvés. En particulier, aucune preuve de déploiement staging/production,
de réception réelle du mail, d'audit des bindings Auth legacy, de runbook opérateur, de confirmation
finale ou de matrice de rétention juridiquement validée n'existe encore. Le retry Supabase Auth est
maintenant une **candidate locale implémentée et testée**, pas une capacité certifiée. Le lot reste
donc `implemented`, jamais `certified`.
