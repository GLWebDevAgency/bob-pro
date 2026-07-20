# Bob Live — architecture de production et critères de certification

> Statut au 16 juillet 2026 : fondation multi-provider en cours d'intégration, **rollout production fermé** tant que les
> gates P0 de ce document ne sont pas tous prouvés. Ce document complète
> `design_handoff_bob_pro/SPEC_BOB_LIVE.md` et prévaut pour la sécurité runtime.

### État honnête du profil Mistral

La maturité Mistral est évaluée à **45–50 % de la cible classe mondiale**, et non à 100 %. Cette
valeur est une appréciation d'ingénierie conservatrice, pas un SLO : seuls les percentiles mesurés
sur appareils réels autoriseront une communication commerciale.

| Sous-ensemble | État estimé | Preuve actuelle |
| --- | ---: | --- |
| Session mono-provider sécurisée, un échange | 75–80 % | PCM/WSS, ticket opaque, tenant fence, cerveau Bob, parole auditée et contrôle one-shot testés |
| Capture native semi-duplex | 65–70 % | iOS/Android, ACK/backpressure, watchdog, lifecycle et génération testés ; build/appareils incomplets |
| Conversation persistante multi-tour | 20–25 % | le protocole `bob.mistral-pcm.v1` reste volontairement terminal après un seul tour |
| Plein duplex, VAD et barge-in naturel | 25–30 % | VAD natif iOS/Android et contrat temporel v1 testés ; transport conversationnel v2, AEC appareil et duplex restent non certifiés |
| Certification production acoustique | non certifiée | `fullDuplexCertified=false`, aucune matrice physique ni p50/p95 signée |

Le profil activable reste donc un **semi-duplex one-shot sûr** : l'utilisateur parle, finalise son
énoncé, puis reçoit une réponse Bob auditée. Le passage à `bob.mistral-pcm.v2` devra conserver la
WebSocket Bob sur plusieurs tours, dissocier le ticket de bootstrap des `turnId`, garder le micro
actif pendant la lecture via AEC native, exploiter le VAD natif désormais présent et couper le son
avant tout aller-retour JavaScript ou réseau. Le VAD n'autorise pas à lui seul le plein duplex :
la composition transport, l'annulation acoustique et les percentiles appareil restent des gates.
Mistral documente Voxtral Realtime comme un composant
STT à combiner avec un LLM et Voxtral TTS ; Bob possède donc lui-même l'orchestration duplex.

Références fournisseur :
[Voxtral Realtime](https://docs.mistral.ai/studio-api/audio/speech_to_text/realtime_transcription),
[pipeline audio Mistral](https://docs.mistral.ai/studio-api/audio/overview).

## 1. Résultat produit attendu

Bob Live est une mission vocale continue : l'utilisateur peut parler, interrompre Bob, naviguer,
faire remplir un écran et reprendre la conversation sans recréer une session à chaque étape.
La voix et le geste manuel appellent les mêmes use cases. Le modèle accélère la compréhension et
la formulation ; il n'est jamais l'autorité d'un montant, d'un droit, d'un contexte d'écran ou
d'une mutation.

Objectifs certifiables sur appareils réels :

| Mesure | p50 | p95 | Plancher |
| --- | ---: | ---: | --- |
| Fin de parole → premier audio Bob | ≤ 900 ms | ≤ 1 800 ms | aucune réponse fantôme |
| Début de barge-in → silence acoustique | ≤ 250 ms | ≤ 500 ms | audio annulé non repris |
| Publication d'un nouvel écran → contexte actif | ≤ 300 ms | ≤ 800 ms | ancien contexte inutilisable |
| Contrôle audité → effet UI | ≤ 150 ms | ≤ 400 ms | zéro effet avant ACK serveur |

Les percentiles sont calculés par version d'app, OS, classe réseau, provider, modèle et plan. Une
moyenne seule n'est jamais une preuve de disponibilité.

## 2. Autorités et frontières

```text
Micro / UI mobile
      │  WebRTC montant (micro) + événements non fiables
      ▼
Provider Realtime sélectionné (OpenAI WebRTC ou Mistral Voxtral PCM/WSS)
      │ transcript/VAD sideband — aucune piste audio descendante
      ▼
API Bob ──► BobAgent ──► use cases ──► contrôle candidat durable
  │          cerveau       autorité               │
  │          unique        métier                 ▼
  ├── contexte durable ◄────────────── ACK serveur one-shot
  ├── texte canonique ─► TTS ─► ASR indépendant ─► audit exact
  ├── artefact privé éphémère ─► URL 30 s ─► player audio mobile
  └── admission / entitlement / usage / SLO durables
```

Les cinq autorités ne sont pas interchangeables :

1. **Droits et tenant :** API Bob + persistance/RLS.
2. **Sens métier :** `BobAgent`, exécuté une fois côté serveur.
3. **Calcul et mutation :** use cases déterministes de `@bob/core`.
4. **Contexte affiché :** snapshot durable, révision monotone et digest canonique.
5. **Audio sensible :** texte canonique déjà validé, synthétisé sans reformulation générative.

Le provider Realtime assure le transport montant et la transcription. Le VAD reste une capacité
du transport Bob quand le fournisseur ne l'offre pas. Il ne possède aucune
piste audible descendante dans le profil certifié. Ses métadonnées, transcripts et événements reçus
sur le mobile restent des entrées non fiables ; le feed d'artefacts est découvert auprès de l'API
par un curseur de séquence durable, jamais par une métadonnée provider.

### Profils de fournisseur

| Profil | Entrée temps réel | Cerveau | Sortie Bob | Audit indépendant | Clé OpenAI |
| --- | --- | --- | --- | --- | --- |
| OpenAI-only | WebRTC + sideband | routeur Bob | OpenAI TTS | Whisper local auto-hébergé | **OpenAI uniquement** |
| Mistral-only | PCM S16LE 16 kHz via relais Bob → Voxtral Realtime | routeur Bob | Voxtral TTS | Whisper local auto-hébergé | **non** |

Changer `OPENAI_API_KEY` en `MISTRAL_API_KEY` ne transforme pas le protocole : le bootstrap choisit
un adapter et un transport distincts. L'identité `{providerId, providerCallId}` est persistée avec
le bail afin que le reaper ne transmette jamais un identifiant distant au mauvais fournisseur.
Un adapter absent échoue fermé ; le switch n'est autorisé qu'après drainage complet.

Dans les deux profils, `BOB_LIVE_AUDIT_PROVIDER=local-whisper` est obligatoire. Ce sidecar reçoit
un jeton interne dédié, reste côté serveur et expose un endpoint multipart compatible OpenAI ; son
domaine de confiance est figé à `bob.local-whisper` et sa destination est limitée au loopback
(`localhost`, `127.0.0.1` ou `::1`). Un fournisseur ne peut jamais auditer sa
propre sortie TTS.

### Runbook de changement de fournisseur

La sélection est exclusivement serveur : `BOB_LIVE_PROVIDER=openai|mistral`. Elle prend effet au
redémarrage de l'API ; le mobile relit `/voice/realtime/config`, reçoit le transport discriminé et
ne doit contenir aucune clé provider.

| Profil | Variables provider minimales | Audit acoustique |
| --- | --- | --- |
| `openai` | `OPENAI_API_KEY` pour Realtime **et** TTS OpenAI | `local-whisper` obligatoire |
| `mistral` | `MISTRAL_API_KEY` pour Realtime **et** TTS Voxtral | `local-whisper` obligatoire |

Les secrets d'identité, preuve, usage et contrôle `BOB_LIVE_*_SECRET` restent dédiés et inchangés
lors d'un switch. En production :

1. fermer les nouvelles admissions et drainer les baux de l'ancien provider ;
2. déployer la nouvelle valeur `BOB_LIVE_PROVIDER` avec sa clé unique sur un canary et vérifier config, bootstrap,
   audio audité, ACK et hangup ;
3. vérifier l'absence de bail portant l'ancien `providerId`, puis ouvrir les admissions ;
4. ne jamais laisser le builder TTS choisir un fallback chez le fournisseur concurrent.

Le service actif n'enregistre jamais l'adapter du fournisseur concurrent, même si sa clé existe
pour un autre sous-système. Un déploiement roulant multi-provider n'est donc pas accepté : il faut
fermer les admissions, drainer l'ancien profil, puis basculer. Un changement de variable ne
convertit jamais une session en cours et ne doit jamais envoyer un identifiant distant à l'autre
fournisseur.

## 3. Invariants non négociables

### Session et audio

- Une mission possède au plus un transport primaire, un propriétaire de microphone et un cerveau.
- Le transport Realtime se connecte micro désactivé. Le micro ne s'ouvre qu'après l'ACK exact du
  snapshot initial `{sessionHandle, version, revision, digest}`.
- Tout changement d'écran coupe localement la sortie, désactive le micro, invalide le tour actif,
  publie le nouveau snapshot, puis réouvre le micro uniquement après l'ACK exact.
- `start`, `stop`, reconnexion et fallback sont single-flight et fencés par génération. Une
  continuation async d'une ancienne génération ne peut ni réactiver le micro ni lancer un fallback.
- Le fallback historique démarre seulement après fermeture confirmée du peer et retourne un lease
  réel dont `close` arrête effectivement ASR, TTS et microphone.

### Cerveau, contexte et contrôles

- Le client ne peut jamais créer le résultat métier du tour. Le transcript final est remis au
  sideband ; le sideband appelle le même `BobAgent` que le mode texte.
- Le contexte est relu avant et après le cerveau. Une révision ou un digest différent annule le
  tour sans texte, navigation ou proposition tardive.
- Une navigation ou une proposition reçue du provider n'est jamais appliquée. Le seul candidat
  recevable est créé par `BobAgent`, lié en base à l'artefact et au contexte exact.
- L'API délivre le contrôle une seule fois, uniquement après audit acoustique exact, stockage privé,
  lecture locale confirmée par `deliveryId`, contexte toujours courant et identité
  user/tenant/session identique. Un replay, un autre tenant ou un ACK consommé ne produit aucun
  effet.
- Toute mutation conserve le contrat `proposalId` opaque, diff visible et confirmation dédiée.
  La confirmation vocale utilise le parseur Bob, jamais l'interprétation libre du provider.

### Exactitude acoustique

- Un audit postérieur ne peut pas retirer un montant déjà entendu. **Toute phrase dynamique** est
  donc sensible, même sans chiffre. Seules les phrases fixes exactes inscrites dans l'allowlist et
  associées à un asset préapprouvé peuvent éviter la double passe TTS/ASR.
- Le TTS reçoit uniquement le texte canonique. Un ASR appartenant à un domaine de confiance
  distinct retranscrit l'audio complet ; le texte et le multiensemble de faits doivent être
  strictement identiques avant que le premier octet devienne téléchargeable.
- Après l'upload privé, une quatrième lecture du contexte conditionne le CAS `rendering→ready`.
  L'objet est supprimé si ce fence échoue ou si un cancel gagne la course.
- Le WebRTC mobile est `sendonly` dans le profil certifié et toute piste distante inattendue ferme
  la session. Bob est lu par un player local qui vérifie MIME, taille et SHA-256 avant lecture.
- Un barge-in arrête ce player immédiatement, invalide le contrôle, publie une annulation
  idempotente et purge l'artefact. Aucun audio annulé ne peut reprendre après reconnexion.

## 4. Séquence nominale

1. Le client lit `/voice/realtime/config`. Le serveur vérifie feature flag, plan et disponibilité
   de l'entitlement ; toute erreur échoue fermée pour Live.
2. Le client acquiert l'autorité audio process, micro désactivé, puis envoie l'offre SDP au broker.
3. Le serveur réserve un bail tenant/utilisateur, crée l'appel provider, attache le sideband, rend
   l'answer SDP et un `sessionHandle` opaque. Toute création partielle est compensée exactement une
   fois.
4. Le client publie le snapshot initial avec `AbortSignal`. Il compare l'ACK version/révision/digest
   et active seulement alors la piste micro.
5. Le VAD détecte la fin de parole. Le sideband attend le transcript final, recharge le contexte,
   exécute `BobAgent` avec `autonomy='confirm_all'`, puis revalide le contexte.
6. Le texte canonique est découpé en segments courts. Chaque segment dynamique passe par TTS puis
   ASR indépendant ; texte, faits, format, durée et empreintes doivent être exacts.
7. Le serveur uploade l'audio dans un bucket privé, relit le contexte, puis publie atomiquement
   l'artefact `ready`. Le mobile le découvre par long-poll avec un curseur monotone, télécharge via
   une URL signée de 30 secondes et vérifie l'empreinte avant lecture locale.
8. Le barge-in rend le silence local immédiatement puis publie un cancel idempotent. Après lecture,
   un `deliveryId` scelle l'artefact ; le mobile peut alors échanger la référence liée contre le
   contrôle one-shot et seulement ensuite naviguer ou ouvrir la revue.
9. Heartbeat, usage et SLO sont persistés. Background, logout, expiration, durée max ou perte du bail
   ferment provider, sideband, piste distante, data channel, micro et lease dans cet ordre logique.

## 5. Multi-réplique

Une map mémoire ne suffit pas en production horizontale. Les propriétés suivantes sont requises :

- admission, contexte, artefact, audit acoustique, contrôle, consommation et terminalité du
  provider sont durables ;
- l'instance propriétaire du sideband reçoit toute invalidation de contexte par bus distribué
  (PostgreSQL LISTEN/NOTIFY, Redis Streams ou équivalent) ;
- l'ACK HTTP d'un nouveau contexte n'est final qu'après publication durable et confirmation de
  l'invalidation par le propriétaire, ou après fermeture sûre de la session si celui-ci est perdu ;
- les artefacts portent un numéro monotone par session, sont idempotents et rejettent les révisions
  inférieures ; le long-poll relit PostgreSQL toutes les 75–100 ms et ne garde aucune transaction
  ouverte pendant l'attente ;
- le reaper clôt les baux orphelins avec une pagination équitable et un fencing token ;
- un test à deux managers partageant la même persistance prouve que B invalide le rendu actif sur A.

Le sticky routing peut réduire les courses, mais ne remplace pas cette preuve.

## 6. Résilience et politique de repli

| Cause | Retry Live | Repli | Règle de sécurité |
| --- | --- | --- | --- |
| Plan non éligible | non | assistant historique | aucun bootstrap provider |
| Entitlement indisponible | une fois, bornée | historique | Live échoue fermé |
| Permission micro refusée | non | texte seul | aucun second prompt micro |
| Autorité audio occupée | non | texte seul | aucun chevauchement audio |
| Bootstrap/data channel/ICE/provider | une fois avec jitter | historique | fermer le peer avant repli |
| Contexte non publié ou ACK incohérent | non | historique/texte | micro reste désactivé |
| Audit audio ou contrôle invalide | non | texte sûr | purge, kill-switch, aucun effet UI |
| Stop/background/navigation expirée | non | aucun | intention de fermeture, pas un échec |

Chaque attente a un timeout et un `AbortSignal`. Trois erreurs provider arbitraires peuvent fermer
la session ; les erreurs bénignes attendues d'une course d'annulation sont reconnues par
`event_id/response_id` et ne consomment pas ce budget.

## 7. Métrologie et coût sans PII

Chaque session et chaque tour émettent côté serveur :

- temps admission, provider SDP, sideband ready, contexte ACK, cerveau, rendu et ACK contrôle ;
- voix→voix acoustique, barge-in→silence/clear, RTT, jitter, perte paquets et reconnexions remontés
  par un endpoint mobile authentifié, borné et anti-rejeu ;
- tokens texte/audio input/output, transcription séparée, durée audio, TTS canonique, annulations et
  audio généré puis jeté ;
- plan, provider, modèle, version app, OS et classe réseau ; user pseudonymisé par HMAC rotatif.

Aucun texte, transcript, audio, nom, document ou identifiant métier brut n'entre dans les métriques.
Les événements d'usage sont durables et idempotents par session/tour/kind. La table de prix est une
entrée versionnée, jamais une constante dispersée. Les alertes portent au minimum sur SLO p95,
taux de fallback, audits rejetés, baux orphelins, entitlement indisponible et coût/session.

## 8. Rollout et rollback

1. **CI fermée :** tests unitaires/races, typecheck/lint, contrat provider simulé, migrations et RLS.
2. **Canary provider :** session sans donnée métier, validation du schéma officiel et teardown.
3. **Dogfood interne :** opt-in explicite, un replica, sortie exclusivement par artefact audité.
4. **Pilote ciblé :** allowlist tenant, contrôle server-ACK, stockage privé éphémère et télémétrie
   durables.
5. **Multi-réplique :** seulement après certification de l'invalidation distribuée et du reaper.
6. **Ouverture par plan :** p95 et budget tenus sur sept jours, aucun incident de tenant/contrôle.

Un kill-switch serveur coupe toute nouvelle admission sans casser l'assistant texte. Il n'existe
aucun interrupteur autorisant un rendu dynamique direct : si la chaîne acoustique auditée est
indisponible, Bob Live échoue fermé et propose le mode texte. Le rollback ne supprime jamais les
données d'audit ou d'usage déjà écrites.

## 9. Definition of Done finale

- [ ] zéro micro avant ACK initial exact et zéro résurrection après stop dans les tests de course ;
- [ ] zéro navigation/proposition avant ACK audité, zéro replay et zéro confusion tenant/session ;
- [ ] faits sensibles exclusivement prévalidés avant le premier octet audible ;
- [ ] dix barge-ins consécutifs sans reprise audio, double cancel ni épuisement du budget d'erreurs ;
- [ ] changement de contexte inter-réplique coupe le tour précédent avant ACK du nouvel écran ;
- [ ] reaper équitable, idempotent et certifié sur PostgreSQL avec provider indisponible ;
- [ ] usage et SLO persistés sans PII, tableaux p50/p95 et alertes opérationnels ;
- [ ] entitlement, consentement/opt-out, quotas et kill-switch prouvés côté serveur ;
- [ ] tests, typecheck, lint, build, migrations, RLS et scripts release verts ;
- [ ] matrice iOS/Android, casque/haut-parleur/Bluetooth, 4G/Wi-Fi/perte réseau et background
  certifiée sur appareils physiques ;
- [ ] rollback staging exécuté et rapport de pilote signé avant ouverture production.
