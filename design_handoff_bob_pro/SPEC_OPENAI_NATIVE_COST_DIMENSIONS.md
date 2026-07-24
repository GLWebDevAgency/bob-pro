# Spec — vérité des coûts GPT Realtime par modalité

## Problème

Le chemin GPT Realtime natif persiste aujourd'hui deux compteurs agrégés
`realtime_tokens_in/out`. Ils ne permettent pas de calculer le coût réel : OpenAI applique des
tarifs distincts au texte, à l'audio, à l'image et aux entrées servies depuis le cache. De plus,
`cached_tokens` est un sous-ensemble de `input_tokens` ; tarifer les deux totaux directement
compterait deux fois le cache.

La réponse `response.done` est l'unique preuve fournisseur corrélée à la facturation. Elle ne doit
produire ni estimation, ni ventilation inventée, ni écriture partielle.

## Sources de contrat

- [SDK TypeScript officiel OpenAI, généré depuis
  l'OpenAPI](https://github.com/openai/openai-node/blob/master/src/resources/realtime/realtime.ts) :
  `RealtimeResponseUsage`, `RealtimeResponseUsageInputTokenDetails` et
  `RealtimeResponseUsageOutputTokenDetails`.
- [Tarification officielle du modèle
  `gpt-realtime-2.1`](https://developers.openai.com/api/docs/models/gpt-realtime-2.1) :
  texte, audio et image ont des tarifs d'entrée/cache/sortie distincts.

Les prix ne sont pas copiés dans le code. Ils restent une table versionnée fournie au moteur pur.

## Invariants

1. Le decoder ne conserve que des entiers bornés ; jamais de payload, transcript ou identifiant
   métier.
2. Une preuve de coût GPT native est complète uniquement si :
   - `total = input + output` ;
   - `input = texte + audio + image` ;
   - `cached = cached texte + cached audio + cached image` ;
   - chaque cache modal est inférieur ou égal au total de sa modalité ;
   - `output = texte + audio`.
3. Les dimensions persistées sont non chevauchantes :
   - entrée non cachée texte/audio/image ;
   - entrée cachée texte/audio/image ;
   - sortie texte/audio.
4. Le chemin GPT natif n'écrit plus ses agrégats `realtime_tokens_in/out`. Ces kinds restent
   acceptés en base et dans le contrat partagé pour la compatibilité N-1 et les autres providers.
5. Les huit dimensions d'une réponse sont écrites dans un seul batch atomique, y compris les
   zéros. Un retry complet est un duplicate complet ; une collision divergente rollbacke événements
   et rollups.
6. Une ventilation absente, partielle ou incohérente est rejetée avant toute écriture. Le
   dispatcher conserve sa politique actuelle : usage indisponible = fermeture fail-closed.
7. Le coût est calculé uniquement par la table de prix injectée. Une dimension sans prix reste
   visible en volume et vaut zéro en coût, sans tarif inventé.
8. La migration est additive et postérieure à `20260724010000`. Elle étend les contraintes en
   conservant tous les kinds historiques ; aucune migration publiée n'est modifiée.
9. Le registre demeure append-only, sous FORCE RLS, pseudonymisé et sans contenu vocal.

## Definition of Done binaire

- [x] decoder texte/audio/image/cache complet et adversarialement testé ;
- [x] normalisation en huit dimensions non chevauchantes, sans double comptage ;
- [x] batch fixe de huit événements, HMAC/idempotence et confidentialité testés ;
- [x] moteur de coût pur testé avec tarifs cache et non-cache différents ;
- [x] migration additive neuve, lignée et contraintes historiques préservées ;
- [x] certification PostgreSQL réelle : insert, rollup, duplicate, RLS et rollback atomique ;
- [x] certificat PostgreSQL enregistré dans la CI principale ;
- [x] tests ciblés, suites globales, typecheck, lint et build verts.

Condition de clôture hors artefact : aucune PR suivante ne peut démarrer avant la fusion de celle-ci
dans `main`, puis la suppression de sa branche et de son worktree.

## Preuves locales

- lignée : `MIGRATION_BASE_REF=main node apps/api/scripts/assert-migration-lineage.mjs` ;
- PostgreSQL 17 réel, schéma complet de 110 migrations et rôle propriétaire `postgres` :
  `apps/api/scripts/release.sh` ;
- certificat ciblé PostgreSQL : insert de 8 événements, 8 rollups exacts, duplicate complet,
  étanchéité RLS inter-tenant et rollback intégral sur conflit ;
- `pnpm typecheck` : 17 tâches vertes ;
- `pnpm test` : 15 tâches vertes, dont 238 tests API ;
- `pnpm build` : 10 artefacts de production verts ;
- `pnpm lint` : 9 tâches vertes.

## Hors périmètre

- prix commerciaux et marges des abonnements ;
- UI de consultation des coûts ;
- Voice Trace, publication/reprise/purge des artefacts et export SLO ;
- Mistral Duplex V3 et payload audio atomique, gelés hors V1.
