# Bob Live Audio

Module Expo local, natif uniquement, chargé par autolinking dans les development builds et les builds store. Il est volontairement absent d’Expo Go : `BobLiveAudioModule` vaut alors `null` et l’appelant doit proposer le mode texte.

## Contrat audio

- PCM signé little-endian 16 bits, mono, 16 kHz ;
- trames strictes de 40 ms (`1 280` octets) émises en base64 sans retour à la ligne ;
- identifiant de session borné, `captureId` UUID propre à chaque génération et fences empêchant une ancienne capture/ACK/commande stop d’affecter la suivante ;
- séquence strictement croissante par capture et fenêtre de 16 trames non acquittées (640 ms) ;
- VAD natif déterministe sur fenêtres de 20 ms, pré-roll 240 ms, hystérésis 60/700 ms et coupure
  dure à 30 s ; son profil reste explicitement non certifié tant que le corpus appareil ne l'est pas ;
- handshake VAD fail-closed dans les capacités de `prepareAsync` : version, ordre `PCM → VAD`,
  fenêtre, pré-roll, hystérésis et durée maximale doivent tous correspondre au contrat JS avant
  l'ouverture du microphone ;
- acquittement cumulatif obligatoire via `acknowledgePcmAsync` après prise en charge effective par le transport ;
- watchdog natif indépendant de JavaScript, borné à 15 minutes et idéalement réduit à l’échéance serveur restante ;
- aucune écriture disque, aucun secret et aucun contenu audio journalisé ;
- arrêt au background, à la destruction du contexte et sur erreur/interruption audio.

iOS utilise `voiceChat` et VoiceProcessingIO lorsque la route le permet. Comme VoiceProcessingIO ne publie pas un statut AEC/NS certifiable par route, ces capacités restent `unknown` même lorsque le traitement est actif. La session audio est détenue par un lease générationnel : Bob ne restaure ni ne désactive une configuration reprise entre-temps, et notifie les autres acteurs lors de sa propre désactivation.

Android privilégie `VOICE_COMMUNICATION`, active AEC/NS/AGC seulement lorsqu’ils sont réellement disponibles, puis replie la source sur `MIC` sans inventer de capacité. Toutes les mutations `start/stop/release`, l’audio focus et la restauration du mode sont sérialisées; une perte de focus (appel, autre média prioritaire) coupe la capture.

`fullDuplexCertified` reste toujours `false` jusqu’à validation sur la matrice réelle appareils × haut-parleur × écouteur × Bluetooth. Une compilation simulateur/émulateur ne vaut pas certification acoustique.

## Frontière TypeScript

`BobLiveAudioPcmStreamDecoder` est la frontière recommandée : il valide les types runtime, la session, la séquence sans trou, l’horloge monotone, le padding base64 canonique et la taille avant de produire le `Uint8Array` destiné au transport. `BobLiveAudioVadStreamDecoder` corrèle start/end, génération, profil et horloge avant d'exposer une transition VAD. `assertBobLiveAudioCapabilities` refuse toute dérive du format natif.

Le démarrage est volontairement en deux phases : `prepareAsync` réserve/configure la capture sans
émettre, puis `startPreparedAsync` ne démarre le flux qu'après installation des listeners et du
decoder lié au `captureId`. La première séquence ne peut donc jamais précéder son fence JavaScript.

Le bundle JavaScript et le binaire natif sont déployés comme un couple de protocole. Si une mise à
jour OTA et le binaire installé n'annoncent pas exactement le même profil VAD, le démarrage échoue
fermé avant `startPreparedAsync` et l'application conserve son repli texte. Une évolution du profil
exige donc d'abord un binaire acceptant explicitement la nouvelle version, puis seulement son
activation côté bundle ; aucune compatibilité implicite n'est déduite d'un numéro de version.

Ordre obligatoire côté adaptateur :

1. appeler `prepareAsync`, valider ses capacités et construire le decoder ;
2. installer les quatre listeners (PCM, VAD, erreur, arrêt) puis appeler `startPreparedAsync` ;
3. décoder la trame avec une instance `BobLiveAudioPcmStreamDecoder` propre à la capture ;
4. la confier au transport avec succès (aucun simple « fire-and-forget ») ;
5. appeler `acknowledgePcmAsync(sessionId, captureId, sequence)`.

Sans ACK, ou avec un ACK futur/invalide, le module s’arrête volontairement. Cette politique empêche qu’un gel du runtime JS laisse le microphone produire ou accumuler de l’audio sans consommateur.

La permission microphone doit être accordée par l’UI avant `startAsync`. Le module ne déclenche jamais une demande système implicite.

## Validation locale

Depuis `apps/mobile` :

```sh
pnpm exec tsc --noEmit -p modules/bob-live-audio/tsconfig.json
pnpm exec vitest run --config modules/bob-live-audio/vitest.config.ts
pnpm exec expo-modules-autolinking verify --platform android
pnpm exec expo-modules-autolinking verify --platform apple
```

Le fence pur du watchdog iOS possède aussi un test Swift autonome. Depuis
`apps/mobile/modules/bob-live-audio` :

```sh
swiftc -module-cache-path /tmp/bob-live-swift-module-cache \
  ios/BobLiveAudioWatchdogFence.swift tests/swift/main.swift \
  -o /tmp/bob-live-audio-watchdog-test
/tmp/bob-live-audio-watchdog-test
```

Ce test prouve notamment qu'un callback de préparation déjà mis en file ne peut plus arrêter une
capture démarrée sous la même génération.

Le VAD pur possède son propre harness sans dépendance Expo :

```sh
swiftc -module-cache-path /tmp/bob-live-vad-swift-cache \
  ios/BobLiveVad.swift tests/swift/vad-main.swift \
  -o /tmp/bob-live-vad-tests
/tmp/bob-live-vad-tests
```

La validation native complète nécessite un prebuild éphémère ou une development build, puis `:bob-live-audio:compileDebugKotlin` et le scheme CocoaPods `BobLiveAudio`.
