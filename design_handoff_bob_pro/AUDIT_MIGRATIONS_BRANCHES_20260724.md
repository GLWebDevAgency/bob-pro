# Audit des migrations dispersées — 24 juillet 2026

## Objectif

Établir la vérité avant toute nouvelle fusion : quelles migrations existent réellement sur
`main`, lesquelles sont appliquées, et quelles capacités restent prisonnières d'anciens worktrees.
Une migration historique n'est jamais renommée, réécrite ou copiée aveuglément.

## Résultat de l'inventaire Git

- Référence auditée : `origin/main` à `821e8da7`.
- `main` contient 108 migrations.
- 48 refs locales, distantes et d'agents ont été comparées, soit 31 commits de tête distincts.
- Aucune branche locale ou distante ne contient un dossier de migration commité absent de `main`.
- Aucun dossier portant le même nom que sur `main` ne contient un SQL divergent.
- Trois worktrees portent toutefois des fichiers de migration non suivis et un snapshot détaché
  conserve onze prototypes SQL. Ces fichiers ne font partie d'aucune lignée déployable.
- La garde de lignée est verte : zéro ajout antidaté après `20260722060000`, aucune mutation de
  migration existante.

## État des bases

| Environnement | Appliquées | En attente | Checksums appliqués |
|---|---:|---:|---|
| staging | 13 | 95 | conformes au dépôt |
| production | 83 | 25 | conformes au dépôt |

Ces écarts sont des déploiements en attente, pas des divergences silencieuses. Ils interdisent
toute activation de Bob Live natif avant une release staging complète et certifiée.

## Matrice des 13 migrations isolées

| Migration isolée | Verdict | Décision |
|---|---|---|
| `20260719160000_realtime_native_speech_delivery` | report sélectif | Le delivery natif est remplacé par `20260722010000`–`20260722060000`. Seul le latch atomique de publication des artefacts audités reste à reconstruire. |
| `20260719190000_realtime_openai_native_cost_dimensions` | à reporter | Les dimensions OpenAI texte/audio/cache manquent encore au registre d'usage réel. |
| `20260719210000_realtime_speech_object_purge_index` | à reporter | Le fallback audio audité reste actif sans purge d'objet de production. |
| `20260719213000_openai_native_speech_slo_durability` | supersédée | Entièrement reprise par `20260722010000` et ses tests PostgreSQL. |
| `20260719220000_realtime_speech_render_recovery` | à reporter | Reconcevoir le takeover fenced sur le schéma courant ; ne pas reprendre le SQL ancien. |
| `20260719223000_realtime_speech_purge_directory` | à reporter | Refaire sur le modèle récent de directory claim durable et équitable. |
| `20260719224000_openai_native_slo_export` | à reporter | Les mesures sont persistées, mais aucun export histogramme durable n'alimente l'observabilité. |
| `20260719225000_openai_native_slo_coverage` | à reporter | Nécessaire pour distinguer les ACK mesurés des ACK sans lot SLO. |
| `20260719230000_realtime_speech_atomic_payload_expand` | hors V1 | Architecture `postgres_ciphertext_v2` non activée ; chantier post-publication. |
| `20260719231000_realtime_speech_key_registry` | hors V1 | Dépend exclusivement du payload atomique gelé. |
| `20260720013000_realtime_mistral_duplex_open_claim` | hors V1 | Mistral Duplex V3 est gelé au profit de GPT Realtime pour la publication. |
| `20260720030500_mistral_conversation_terminal_cursor_hardening` | supersédée | Copie exacte de `20260720220000`; SHA-256 `5e45558deebd4a7234311b9bb9229f39771c7fe653334db6d9a360c15a65aa8d`. |
| `20260721010000_voice_trace_realtime_events` | à reporter en priorité | Les sessions/événements append-only complètent la trace bêta, mais doivent être reconstruits sur `main`. |

## Ordre de consolidation

Chaque ligne est une micro-PR issue du `main` courant, avec un timestamp strictement supérieur au
dernier timestamp déjà fusionné :

1. corriger le gate N-1 des clés natives, défaut P1 découvert pendant cet audit ;
2. reporter les dimensions de coût OpenAI ;
3. reporter Voice Trace sessions/événements ;
4. fermer publication, reprise et purge des artefacts audités dans une même spec verticale ;
5. reporter export SLO et couverture ;
6. garder payload atomique et Mistral V3 hors de la V1.

## Règles de sortie

- Aucun SQL des worktrees historiques n'est fusionné tel quel.
- Toute capacité retenue reçoit une spec, une migration append-only neuve, un test de lignée et une
  certification PostgreSQL réelle.
- Une micro-PR est fusionnée et sa branche supprimée avant d'ouvrir la suivante.
- Staging reçoit toute la lignée et passe le postflight checksum avant toute production.
