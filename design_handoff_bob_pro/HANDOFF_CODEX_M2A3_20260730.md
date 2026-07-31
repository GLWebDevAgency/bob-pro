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

## Checkpoint pré-redémarrage — 30 juillet 2026

État figé à `agent/gpt/m2a3-realtime-loop@466c6286`. Le worktree est propre et le commit est
déjà présent sur `origin/agent/gpt/m2a3-realtime-loop`. `origin/main` est toujours
`cd6092d7d407ba96129f49c8fc82733ee7ccabb0` : aucun rebase n'est requis tant que cette référence
n'avance pas.

### Plan actif

1. Synchronisation branche, claims et spec : **terminée**.
2. Raccordement OpenAI WebRTC, runtime et recovery mobile au protocole V2 : **prochaine action**.
3. Surface mobile mission et parité voix↔toucher ; fermeture des writers legacy : à faire.
4. Certifications PostgreSQL reprise/concurrence : à faire.
5. Validations, reviews adversariales, staging exact-SHA et appareils : à faire.
6. Une seule PR après certification : à faire.

### Audit mobile déjà effectué

- `apps/mobile/src/realtime/webrtc-realtime-transport.ts` envoie encore
  `REALTIME_AGENT_MISSION_PROTOCOL_VERSION` (V1). OpenAI WebRTC doit envoyer exactement
  `REALTIME_AGENT_MISSION_PROTOCOL_M2A_VERSION` (V2).
- `apps/mobile/src/realtime/mistral-realtime-transport.ts` doit rester strictement V1 ; Mistral
  est hors de ce train et aucun fallback V2→V1 n'est autorisé.
- `apps/mobile/src/agent/agent-mission-runtime.ts` refuse actuellement toute session autre que
  V1 et n'expose que lecture, ACK, décision client et handoff. Il doit accepter le discriminant
  V1/V2, conserver la compatibilité M1-C V1, et exposer les mutations V2 avec refus fermé quand
  une session V1 tente une opération M2-A.
- `apps/mobile/src/agent/agent-mission-recovery.tsx` et
  `agent-mission-recovery-state.ts` lisent encore la reprise V1. La reprise froide M2-A doit
  appeler `getCurrentQuoteAgentMissionResumeV2` et transporter le couple cohérent
  `{ mission, presentation }`.
- `apps/mobile/src/agent/realtime-session.ts` porte encore les noms et gardes
  `resumeMissionV1` / `requireMissionV1ForStart`. Le contrôleur doit demander un protocole
  attendu explicite (`1 | 2 | null`) ; la reprise M2-A exige exactement V2 et échoue fermée si
  le transport négocié ne le fournit pas.
- `apps/mobile/src/agent/quote-screen-mission-coordinator.ts` ne transporte pas encore
  `presentation`. Le binding `ready` doit garder mission, choix réels et présentation issus du
  même snapshot autoritaire.
- `apps/mobile/src/agent/use-quote-screen-mission-binding.ts` transforme actuellement
  automatiquement `awaiting_lines` en `handoff_required`. Ce comportement doit être supprimé :
  `awaiting_lines` reste une mission ouverte avec Bob actif.
- `apps/mobile/app/devis/new.tsx` contient encore l'UI de reprise V1 et le handoff historique.
  La surface M2-A doit être extraite en composant focalisé, i18n et accessible, et rendre les
  quatre phases : saisie de ligne, choix catalogue réel, détail manquant, confirmation avec diff.
- Les méthodes et codecs V2 nécessaires existent déjà dans `@bob/api-client` :
  lecture courante, ACK, sélection client, staging de lignes, choix catalogue, patch de ligne,
  décision de proposition et reprise froide V2 stricte.

### Invariants à ne pas perdre au redémarrage

- OpenAI seul négocie V2 ; Mistral reste V1.
- Une mission propriétaire du slot rend tous les parseurs et writers legacy inertes.
- Un choix tactile et la réponse vocale utilisent le même identifiant scellé et les mêmes fences.
- `awaiting_lines` ne coupe pas Bob et ne force pas de handoff manuel.
- La reprise froide hydrate sans parole ni navigation automatique.
- Aucun mock, libellé inventé ou montant fabriqué : affichage depuis la projection autoritaire.
- Les preuves appareils, acoustiques et PostgreSQL restent explicitement non certifiées tant
  qu'elles n'ont pas été exécutées.

### Première séquence après redémarrage

1. Lire ce handoff, puis vérifier `git status --short --branch`, `origin/main` et
   `refs/agents/*`.
2. Renouveler les claims GPT si leur TTL a expiré.
3. Inspecter `agent-session.tsx` et les tests des transports/runtime/recovery avant toute édition.
4. Livrer un premier commit atomique « transport + runtime + reprise V2 », avec tests ciblés,
   typecheck et lint mobiles.

Phrase de reprise courte : **« reprends M2-A-3 au checkpoint pré-redémarrage »**.
