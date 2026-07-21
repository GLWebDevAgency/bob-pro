# SPEC — GPT Realtime natif : duplex, barge-in et autorité durable

**Statut** : en implémentation, non activable en production avant certification physique.

## 1. Résultat produit

Quand Bob Live sélectionne OpenAI, le même appel GPT Realtime reçoit le microphone et restitue la
voix par WebRTC. Le microphone reste ouvert pendant la parole de Bob afin que l'utilisateur puisse
l'interrompre naturellement. Le cerveau métier, le contexte d'écran, les contrôles et les mutations
restent exclusivement sous l'autorité de Bob Pro.

Le mode Mistral conserve son transport et sa parole par artefact audité. Aucun fallback implicite,
appel concurrent ou mélange de clés n'est autorisé dans une session.

## 2. Contrats de livraison séparés

- `openai-native-webrtc-v1` : RTP descendant GPT Realtime, plein duplex candidat, contrôle durable
  distinct de la metadata fournisseur ;
- `audited-signed-url-v1` : artefact privé TTS/ASR actuel, utilisé par Mistral et disponible comme
  chemin à exactitude acoustique pré-audible.

Le bootstrap et le client discriminent ces contrats. Un client ancien, une réponse ambiguë ou une
configuration partielle échoue fermé ; il ne joue jamais les deux sorties.

## 3. Autorités et invariants

1. Le sideband garde `create_response=false`, `tools=[]` et `tool_choice='none'`. Seul le serveur
   Bob peut demander une restitution vocale.
2. `BobAgent` produit le texte canonique à partir du contexte durable et des use cases. OpenAI ne
   reçoit qu'une demande hors conversation (`conversation: 'none'`) de prononcer ce texte.
3. La metadata OpenAI ne contient aucun payload métier, route, `proposalId` ni commande. Elle ne
   transporte que des identifiants opaques de corrélation bornés.
4. Chaque rendu natif possède une machine durable monotone et un dispatch **at-most-once**. Un
   résultat réseau ambigu n'est jamais rejoué.
5. Une réponse n'est complète qu'après transcription finale concordante, `response.done` réussi,
   arrêt du buffer distant, persistance de l'usage et contexte toujours courant.
6. Une divergence, un outil, une réponse inconnue, un chevauchement ou un événement malformé
   annule/purge, révoque tout contrôle et ferme la session si l'autorité ne peut plus être prouvée.
7. Une action reste une capacité opaque issue du cerveau Bob. Elle n'est consommable qu'après la
   complétion serveur, un ACK mobile durable post-lecture et une nouvelle validation du contexte.
8. La metadata provider seule n'autorise jamais navigation, proposition ou mutation. Le mobile
   refuse toute référence dépourvue du reçu durable Bob.
9. Le barge-in coupe le son local immédiatement, puis envoie `response.cancel` et
   `output_audio_buffer.clear`. Aucun événement tardif ne peut ressusciter une ancienne génération.
10. Le micro reste fermé jusqu'à l'ACK exact du premier contexte. Il reste ensuite actif pendant la
    sortie Bob, sous réserve de l'AEC native certifiée sur appareils.

## 4. Limite d'exactitude explicitement assumée

Le RTP natif peut être entendu avant `response.output_audio_transcript.done`. L'audit de transcript
est donc un garde de révocation et de contrôle, pas une preuve indépendante préalable à l'écoute.
Il ne peut pas retirer une phrase déjà entendue.

Conséquences de rollout :

- le master Bob Live reste fermé pendant ce lot ;
- aucune communication « exactitude acoustique préauditée » n'est permise pour ce mode ;
- la première activation native est limitée aux comptes internes, puis aux réponses non
  actionnables et à faible risque ;
- les paroles financières, légales, contractuelles ou portant un contrôle restent sur le chemin
  préaudité tant qu'une certification et un ADR de risque dédiés ne les autorisent pas.

## 5. Machine durable cible

```text
prepared → dispatching → requested → accepted
         → streaming → draining → completed → delivered
         ↘ cancelled | failed | expired
```

- `dispatching` est le claim atomique avant `socket.send` ;
- `completed` exige transcript conforme + génération terminée + buffer arrêté + usage accepté ;
- `delivered` exige l'ACK mobile exact, tenant/session/turn/contexte scellés ;
- tous les états terminaux sont immuables ;
- un contrôle référence en XOR soit un artefact audité, soit une livraison native, jamais les deux.

## 6. Critères d'acceptation binaires — code et contrats

- [ ] Le config public et le bootstrap discriminent exactement les deux modes de livraison.
- [ ] Une session OpenAI native démarre avec une seule clé OpenAI et n'appelle jamais Mistral.
- [ ] `output_modalities=['audio']`, `create_response=false`, aucun outil et budget borné sont
      vérifiés par tests de contrat provider.
- [ ] Le sideband rejette réponse inconnue, metadata divergente, sortie texte, outil, réponse
      concurrente et événement malformé.
- [ ] Le dispatch `response.create` est durable et at-most-once, y compris après résultat réseau
      ambigu ou reprise de processus.
- [ ] Les ordres inversés `response.done` / `output_audio_buffer.stopped` convergent vers le même
      état terminal sans double contrôle.
- [ ] Transcript absent/divergent, contexte obsolète, perte d'owner ou usage indisponible ne
      produisent ni livraison, ni historique complet, ni contrôle.
- [ ] Le contrôle durable accepte une liaison XOR artefact/livraison native et reste one-shot,
      tenant-scopé, contextuel et anti-rejeu.
- [ ] Le bootstrap OpenAI ne dépend pas du stockage audio signé ni du TTS Mistral.
- [ ] Le bootstrap Mistral et son artefact audité restent inchangés par tests de régression.
- [ ] Le mobile OpenAI négocie un unique média audio `sendrecv`, accepte une seule piste distante
      audio et arrête toute piste vidéo, dupliquée ou obsolète.
- [ ] Le RTP entrant alimente les métriques sans fermer la session ; le micro reste actif pendant
      `bob_speaking`.
- [ ] Une interruption émet au plus un cancel et un clear par réponse, retire le contrôle et ne
      laisse reprendre aucun ancien buffer.
- [ ] Background, stop et échec natif arrêtent piste distante, piste locale, data channel et peer ;
      le lease audio n'est rendu qu'après fermeture native confirmée.
- [ ] Un client incompatible ou un protocole de livraison incohérent échoue fermé sans double voix.
- [ ] Aucun flag de production n'est activé par le lot.

## 7. Certification bloquante avant activation

- [ ] Tests unitaires, courses, contrats, typecheck, lint et builds API/mobile verts.
- [ ] Migration expand-only, RLS forcée, CAS, XOR et takeover owner certifiés sur PostgreSQL réel.
- [ ] Dix barge-ins consécutifs sans reprise audio, double contrôle ni incohérence de session.
- [ ] iPhone et Android physiques : haut-parleur, écouteur, filaire et Bluetooth.
- [ ] Fin de parole → premier audio : p50 ≤ 900 ms, p95 ≤ 1 800 ms.
- [ ] Début de barge-in → silence : p50 ≤ 250 ms, p95 ≤ 500 ms.
- [ ] Background/foreground, perte réseau et changement de route audio certifiés.
- [ ] Zéro requête Mistral observée sur toute la mission OpenAI.
- [ ] ADR de risque natif et matrice de certification explicitement validés avant ouverture.

## 8. Hors lot

- activation production et modification des variables Railway ;
- Mistral V3 ;
- nouvelles capacités métier des missions vocales multi-étapes ;
- preuve acoustique indépendante avant écoute, incompatible avec un RTP immédiatement audible
  sans buffering complet.
