# Spec — gate N-1 des clés sujet Bob Live natives

## Problème

`20260722060000_openai_native_key_lifecycle` laisse `subjectKeyVersion` nullable pour les writers
N-1, mais son trigger refuse toute nouvelle valeur `NULL`. Une migration appliquée pendant qu'un
ancien pod termine une requête peut donc casser ce writer malgré la promesse expand/contract.

## Invariants

1. Un writer N persiste toujours une version sujet admise et liée.
2. Un writer N-1 peut persister `NULL` uniquement pendant un gate durable `open`.
3. Le gate est monotone : `open -> closed`, jamais l'inverse.
4. L'insert N-1 prend le verrou partagé sujet avant de lire le gate.
5. Le retrait prend les verrous exclusifs sujet puis preuve, ferme le gate et avance les deux
   floors dans une seule transaction.
6. Writer-first : le retrait attend puis échoue sur la ligne `NULL`; son changement de gate est
   rollbacké.
7. Retire-first : le gate ferme et le retrait commitent avant que le writer N-1 soit refusé.
8. Toute ligne native utilisant l'ancienne version sujet ou `NULL`, terminale comprise, bloque le
   retrait sujet.
9. Toute ligne non terminale utilisant l'ancienne preuve, y compris `completed`, bloque son retrait.
10. Aucune migration déjà publiée n'est modifiée.
11. Une default ACL historique ne crée aucune fenêtre d'accès runtime entre la migration et la
    normalisation des grants de release.

## Modèle

Une table technique singleton, sans secret ni accès runtime direct, matérialise le gate. Son trigger
interdit insertion, suppression, truncate, réouverture et mutation d'identité. Le trigger de
delivery, `SECURITY DEFINER`, consulte cette ligne sous le verrou sujet.

Le gestionnaire de versions ferme le gate dans le mode `retire`, y compris lorsque les floors sont
déjà sur la version courante. Cela permet de terminer une fenêtre rolling sans rotation artificielle.

## Critères d'acceptation binaires

- [x] migration strictement postérieure à `20260722060000` ;
- [x] schéma Prisma décrit le singleton comme table technique ignorée ;
- [x] insert N avec version admise : accepté ;
- [x] insert N-1 avec gate ouvert : accepté sans désactiver les triggers ;
- [x] insert N-1 avec gate fermé : refusé ;
- [x] réouverture, delete, truncate et seconde ligne : refusés ;
- [x] courses writer-first et retire-first prouvées sur PostgreSQL réel ;
- [x] retrait sujet/preuve et fermeture du gate atomiques ;
- [x] certificat metadata de release vérifie table, contraintes, trigger, fonction et ACL ;
- [x] migration et release normalisent le gate owner-only, y compris avec une default ACL hostile ;
- [x] tests unitaires du gestionnaire et tests anti-drift de release verts ;
- [x] garde de lignée et checksums verts.

## Preuves locales

- lignée complète appliquée sur PostgreSQL 17 éphémère : `109` migrations, `0` en attente ;
- rituel `apps/api/scripts/release.sh` complet : build, checksums, ACL, RLS et certificats verts ;
- certificat mutationnel OpenAI natif : les deux ordres writer/retrait passent sur les vrais
  advisory locks et triggers ;
- le rôle runtime ne possède aucun droit de table ou de fonction sur le gate.

## Hors périmètre

La capacité typée de keyset vérifiée au boot et les huit reports identifiés par l'audit des branches
restent des micro-PR distinctes. Ce correctif ne réactive ni Mistral V3 ni le payload audio atomique.
