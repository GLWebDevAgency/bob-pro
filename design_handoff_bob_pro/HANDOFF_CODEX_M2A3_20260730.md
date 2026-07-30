# HANDOFF CODEX — M2-A-3 Bob Live

**Date :** 30 juillet 2026  
**Statut :** implémentation en cours, non certifiée, flag public OFF  
**Objectifs :** O4, O5, O6, O7  
**Spec canonique :** `SPEC_AGENT_MISSIONS_JARVIS_M2A_QUOTE_LINE.md`, §15.1.1 et §17.1

## Point de reprise exact

- Worktree d'écriture : `/private/tmp/bob-m2a3`
- Branche : `agent/gpt/m2a3-realtime-loop`
- Base : `origin/main@cd6092d7d407ba96129f49c8fc82733ee7ccabb0`
- Commit spec : `21fa4816` — `docs(agent): figer le contrat M2-A-3`
- Commit serveur : `2485d4b3` — `feat(agent): raccorder la boucle devis M2-A-3 au realtime`
- Une seule PR doit être ouverte pour ce train, après complétion et certification. Aucune PR
  M2-A-3 n'est ouverte au moment de ce handoff.
- Le workspace racine utilisateur n'a pas été modifié par ce train.

## Ce qui est implémenté

- Contrat sémantique V2 fermé pour les phases ligne : patch mono-champ, confirmation, édition et
  annulation ; matrice `requiredFact`/scope/champ fermée.
- GET capability V1 inchangé et GET V2 exact `{ mission, presentation }`, avec cohérence
  mission/projection vérifiée.
- Relecture V2 après compréhension avant toute mutation ; variation de snapshot = refus.
- Appels aux wrappers M2-A-2 avec les fences mission, brouillon, work item, décision, proposition,
  catalogue et diff réellement relus.
- Continuation post-ACK M2-A rattachée à l'ACK durable, y compris après reprise d'une mission déjà
  avancée.
- Réponses vocales reconstruites depuis la projection autoritaire, jamais depuis les arguments du
  modèle.
- Correctifs issus de la revue adversariale :
  - centimes convertis en euros avant parole ;
  - choix catalogue indisponibles annoncés honnêtement et impossibles à sélectionner à la voix ;
  - aucune promesse de « recalcul » non câblée ;
  - aucun faux « ligne ajoutée » lors du replay d'une décision invalidée.

## Preuves vertes au checkpoint

- `@bob/ai` : build de production et garde d'artefact verts ; typecheck et lint verts ;
  `quote-creation-v2.test.ts` : **16/16**.
- `@bob/api-client` : typecheck et lint verts ; codecs/session : **31/31**.
- `@bob/api` : typecheck avec `prisma generate` et lint verts ; service/controller/orchestrateur :
  **71/71**.
- `git diff --check` vert.
- Deux reviews adversariales lecture seule exécutées. Leurs correctifs vérifiés sont inclus dans
  `2485d4b3`.

## Bloquants DoD encore ouverts

1. **Mobile OpenAI V2 non raccordé.** `webrtc-realtime-transport.ts` demande encore le protocole 1
   et `agent-mission-runtime.ts` refuse V2. Le chemin serveur V2 n'est donc pas encore atteignable
   sur appareil. Mistral doit rester strictement V1 et hors de ce train.
2. **Projection et parité mobile à livrer.** La reprise doit porter `presentation`, supprimer le
   handoff automatique à `awaiting_lines`, rendre une seule surface mission et bloquer tous les
   writers/parseurs legacy lorsque la mission possède le slot.
3. **M2A3-04 non certifié.** Ajouter une preuve verticale sur vraie persistance/PostgreSQL :
   commit utilisateur, coupure avant continuation, nouvel ACK, replay/concurrence, exactement un
   événement métier et une ligne au plus.
4. **M2A3-08 non certifié.** Ajouter deux confirmations PostgreSQL réellement concurrentes et
   prouver exactement une ligne et un événement, avec l'autre appel replay/stale convergent.
5. **Appareils physiques non certifiés.** iPhone et Android doivent prouver reprise froide,
   voix↔toucher, AEC/barge-in et silence local avant réseau. Ne jamais promouvoir M2-A-3 à
   `certified` avant ces preuves.

## Ordre de reprise

1. Rebaser uniquement si `origin/main` a réellement avancé, après lecture des claims ; conserver
   ces deux commits atomiques.
2. Raccorder **OpenAI WebRTC seulement** au protocole 2 ; laisser Mistral V1.
3. Étendre runtime, recovery et UI mobile pour la présentation V2, puis supprimer le double writer
   du wizard pendant la possession de mission.
4. Ajouter les certifications PostgreSQL de coupure/reprise et confirmation concurrente.
5. Exécuter suites complètes, build mobile, reviews adversariales, staging exact-SHA et QA device.
6. Ouvrir puis merger une seule PR seulement lorsque les gates binaires M2A3-01 à M2A3-13 sont
   satisfaits ou explicitement marqués bloqués par un input fondateur.

Commande de reprise conversationnelle : **« reprends M2-A-3 depuis
`HANDOFF_CODEX_M2A3_20260730.md` »**.
