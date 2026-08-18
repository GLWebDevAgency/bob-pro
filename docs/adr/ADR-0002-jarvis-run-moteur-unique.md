# ADR-0002 — `JarvisRun` : moteur unique d'orchestration métier durable

- **Statut** : Accepted — 2026-08-18, sous bâton fondateur explicite (Claude conduit le
  développement) ; contre-lecture GPT attendue à son retour, non bloquante par décision fondateur.
- **Décideurs** : fondateur (directive du 17/08), GPT (auteur de la spec), Claude (contre-expertise,
  amendements, décisions déléguées `FD-2026-0817-01..11`).
- **Spec normative de référence** :
  [SPEC_JARVIS_UNIVERSEL_ORCHESTRATION_20260817.md](../../design_handoff_bob_pro/SPEC_JARVIS_UNIVERSEL_ORCHESTRATION_20260817.md)
  — le présent ADR consigne la décision et ses alternatives ; la spec porte le détail normatif.

## Contexte

Deux chemins d'exécution coexistent et aucun n'est un orchestrateur métier durable :

1. `/ai/ask → proposition → /ai/confirm` via `BackendService.buildBobActions()` — moteur des DEUX
   surfaces de production (onglet assistant texte publié et tours realtime). Journal
   `planned → effet → executed` : un crash entre l'effet et le journal laisse un résultat ambigu ;
   un batch ne rollbacke pas les effets committés.
2. `AgentMission` — fences, révisions et reprises solides, mais un seul domaine réel
   (`quote_creation`) et pas de publication du vrai devis.

L'objectif produit (parité vocale universelle, §2 de la spec) exige une orchestration durable,
idempotente, reprenante et confirmée par risque, sur toutes les actions publiques de
l'application — sans dupliquer les use cases existants.

## Décision

Un **moteur unique** : `JarvisCommandGateway → JarvisRun → JarvisRunEvent / JarvisWorkItem → ports
métier`.

- `JarvisRun` est l'unique machine d'état durable (snapshot CAS tenanté, statuts fermés, reducer
  pur versionné). `AgentMission` est **absorbé en place** (tables expandées puis renommées), jamais
  enveloppé ni conservé comme second agrégat. `AgentRuntime` est supprimé.
- `buildBobActions` et les routes `/ai/ask`/`/ai/confirm` sont remplacés au cutover §17.1
  (blue/green, sens unique, gates de continuité de surface et de plancher de version client).
- Les work items réutilisent les outboxes métier canoniques existantes — aucune outbox `ForJarvis`.
- Le catalogue versionné `ProductActionCatalog`/`PublicActionSurfaceManifest` est la source unique
  des modes vocaux, classes de risque et autorités ; la table normative classe→mode (§7.0, issue de
  `FD-2026-0817-02`) est contre-signée dans la spec et ne peut être dérogée vers le bas.
- Intention-avant-effet partout : `effectId` serveur préalloué, idempotence par
  `(companyId, runId, commandId)` + fingerprint, réconciliation avant tout retry, `outcome_unknown`
  bloquant.

## Alternatives considérées

1. **Conserver les deux moteurs** (buildBobActions pour le texte, AgentMission élargi pour la
   voix) — rejeté : double journal, double policy de confirmation, divergence garantie des
   invariants, coût de parité doublé par domaine, et le journal legacy n'est pas durable.
2. **Envelopper `AgentMission` dans un parent Jarvis** — rejeté : crée un agrégat d'orchestration
   au-dessus d'un autre (deux vérités de reprise), la spec l'interdit explicitement (§4.1).
3. **Exécuteur générique (DAG/BPMN/code généré)** — rejeté : surface d'attaque et d'audit
   inbornable ; la spec impose des définitions fermées versionnées (§4.3) ; tout élargissement
   exigerait un nouvel ADR build-vs-buy.
4. **Étendre `buildBobActions` avec des fences** — rejeté : son modèle `planned/executed` est
   structurellement non durable (pas d'intention-avant-effet, pas de work items, pas de reprise) ;
   le refactorer équivaut à écrire le moteur cible sans en prendre le nom.

## Conséquences

- Positives : une seule vérité d'orchestration, parité voix/toucher par construction (même use
  case, même policy), reprise après crash/fermeture, auditabilité (reçus typés, provenance des
  faits), suppression réelle du code legacy (gate `implemented` §21.2 : zéro référence runtime).
- Négatives assumées : cutover global sous maintenance (aucune coexistence de moteurs en
  production) ; train U0–U7 long — mitigé par l'articulation V1 (`FD-2026-0817-11` : la publication
  V1 n'attend pas le train) ; migration `AgentMission → JarvisRun` exigeant preuve writer N-1 et
  manifeste de migration hashé.
- Gardes : les gates §21 (specified/implemented/certified/released) et le
  `LegacyEffectEvidenceManifest` conditionnent chaque étape ; les décisions fondatrices sont
  référencées par `founderDecisionId` et amendables par le fondateur seul.
