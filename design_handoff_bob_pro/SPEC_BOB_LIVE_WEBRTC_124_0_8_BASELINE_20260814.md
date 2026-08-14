# SPEC — Bob Live WebRTC 124.0.8 : baseline native reproductible

Date : 2026-08-14
Objectif : O3 — GPT Realtime
État initial : `specified`
État maximal de ce lot : `implemented` (dormant, sans activation)

## 1. Décision de lot

Avant de poursuivre l'autorité d'extinction audio locale de Bob Live, isoler la montée de
`react-native-webrtc` de `124.0.7` vers `124.0.8` dans un micro-train réversible. La version
`124.0.8` contient notamment la correction amont qui attend l'état de signalisation `closed`
avant de disposer le peer (`react-native-webrtc#1821`), mais aussi un delta plus large. La
compatibilité Expo 57 / React Native 0.86 de Bob doit donc être prouvée indépendamment du futur
ACK natif d'extinction.

Sources primaires :

- release officielle : <https://github.com/react-native-webrtc/react-native-webrtc/releases/tag/124.0.8> ;
- correctif de cycle de vie : <https://github.com/react-native-webrtc/react-native-webrtc/pull/1821> ;
- artefact npm attendu : `react-native-webrtc@124.0.8`, intégrité
  `sha512-uuQxvmk+mvnk5U0tr+1N42sKZqgm41fJrBA+fmCvML9J9P4roSh2So82t5RHAlu/vE9vxu5AKgivAiH61clCBg==` ;
- binaire Android M124 publié : `org.jitsi:webrtc:124.0.0` ;
- binaire iOS M124 actuellement résolu : `JitsiWebRTC 124.0.2`.

Au 14 août 2026, Maven Central ne publie qu'un seul binaire Android M124,
`org.jitsi:webrtc:124.0.0`, et `pod trunk info JitsiWebRTC` publie trois builds iOS M124 dont
`124.0.2` est le dernier (`124.0.0`, `124.0.1`, `124.0.2`). La divergence Android `.0` / iOS `.2`
est donc volontaire : chaque plateforme est figée sur son dernier artefact M124 disponible, pas
sur un numéro artificiellement commun. Références de catalogue :

- <https://repo1.maven.org/maven2/org/jitsi/webrtc/> ;
- <https://github.com/jitsi/webrtc> et `pod trunk info JitsiWebRTC`.

Ces pins sont réévalués dans un micro-train explicite dès qu'un artefact M124 plus récent est
publié, qu'un correctif sécurité/audio WebRTC le requiert, ou que React Native, Expo ou
`react-native-webrtc` change de version. Ils ne redeviennent jamais une plage flottante.

## 2. Résultat binaire

Le dépôt installe exactement le tarball npm `124.0.8`. Un patch pnpm borné à deux contraintes de
résolution remplace les plages natives amont par `org.jitsi:webrtc:124.0.0` et
`JitsiWebRTC 124.0.2`. Ce patch ne modifie aucun comportement WebRTC. Android et iOS compilent
ensuite l'application Expo réelle avec ces versions exactes.

Ce lot ne prétend pas que `close()` constitue une preuve d'extinction audio physique. Il ne crée
ni ACK natif, ni reçu local vert, ni certification appareil.

Les APK et diagnostics historiques ont été construits avec la contrainte Android dynamique
`124.+`, sans reçu catalogique de la version finalement résolue. A0 rend les futurs builds
déterministes ; il ne rétro-certifie aucun artefact, timing ou comportement observé avant ce pin.

## 3. Périmètre

- `apps/mobile/package.json` ;
- `package.json`, uniquement pour le registre `pnpm.patchedDependencies` ;
- `pnpm-lock.yaml` ;
- `patches/react-native-webrtc@124.0.8.patch`, uniquement pour les deux pins natifs ;
- `.github/workflows/bob-live-native.yml` ;
- `apps/mobile/src/realtime/react-native-webrtc-dependency.contract.test.ts` ;
- présente spec et registre O3.

## 4. Non-objectifs

- aucun changement du transport, du contrôleur, de Mission V2 ou des API audio ;
- aucun ACK d'arrêt ou d'ouverture du micro ;
- aucune implémentation de l'ACK natif RN-WebRTC ; les signaux OS restent une corroboration
  secondaire et le coordinateur natif structuré appartient au train lifecycle suivant ;
- aucun flag Railway/EAS, déploiement staging, APK, migration ou keyring ;
- aucune modification de Mistral, du rail audité ou du fournisseur ;
- aucune revendication `certified` ou `released`.

## 5. Invariants

1. `apps/mobile/package.json`, le lock et le package installé désignent exactement `124.0.8`.
2. L'intégrité npm est celle publiée par le registre ; aucune source Git, fork ou tarball privé.
3. Le patch contient seulement les deux substitutions de version native ; aucune ligne JS,
   Java, Objective-C ou Swift comportementale.
4. Android résout exactement `org.jitsi:webrtc:124.0.0` et compile `:app:assembleDebug`.
5. CocoaPods résout exactement `JitsiWebRTC 124.0.2` et compile le workspace Expo réel.
6. Le correctif amont `#1821` est présent dans le package installé : l'événement
   `signalingstatechange` précède le retrait des listeners et `peerConnectionDispose` lorsque
   l'état devient `closed`.
7. Les événements consommés par Bob (`track`, `connectionstatechange`, `message`, `close`) et les
   tests WebRTC existants ne régressent pas.
8. Metro bundle le graphe JavaScript Android réel : les changements JS du tarball `124.0.8` ne
   sont pas couverts par la seule compilation des projets natifs ni par un runtime injecté en test.
9. Le workflow est déclenché par toute modification du manifeste racine ou du patch exact.
10. Aucun fichier généré `apps/mobile/android` ou `apps/mobile/ios` n'est committé.
11. Le compile-lock natif et tous les flags restent inchangés.

## 6. Critères d'acceptation

- [x] Installation propre `pnpm install --frozen-lockfile` verte.
- [x] Contrat statique : version, intégrité, absence totale de `124.0.7`, patch borné et marqueur
      de cycle de vie `#1821` exacts.
- [x] Suites ciblées mobile/WebRTC et typecheck mobile verts.
- [x] Export Metro Android du graphe JavaScript réel vert.
- [x] Expo prebuild Android et iOS verts sur un checkout propre.
- [x] Android : dépendance native exacte observée puis application réelle `assembleDebug` verte.
- [x] iOS : `Podfile.lock` exact puis `xcodebuild` de l'application réelle vert.
- [x] `actionlint`, lint ciblé et `git diff --check` verts.
- [ ] CI générale et workflow natif verts sur le commit candidat.
- [x] Revue indépendante : zéro P0/P1.
- [x] Aucun changement transport/configuration de publication/déploiement/APK.

## 7. Definition of Done

Le lot est `implemented` seulement après merge sur `main` et CI complète verte. La preuve appareil,
la preuve d'extinction audio physique, le soak Bluetooth/routes et toute activation restent dus aux
trains lifecycle suivants. Une compilation seule ne les acquitte pas.

## 8. Rollback

Le rollback est le revert atomique du lot : manifeste mobile, entrée `patchedDependencies`, patch,
lock, contrat et workflow reviennent ensemble au baseline historique `124.0.7`, y compris ses
contraintes natives amont alors dynamiques. Aucun rollback partiel ne doit conserver `124.0.8`
avec un pin, un hash de patch ou un contrat incohérent.

## 9. Risques explicitement ouverts

- `@config-plugins/react-native-webrtc@15.0.1` annonce historiquement Expo 56 alors que Bob utilise
  Expo 57 ; les deux builds natifs réels sont la preuve exigée, pas une supposition de compatibilité.
- Expo Doctor classe encore `react-native-webrtc` comme non testé sous la New Architecture. Le
  bundle Metro et les builds natifs prouvent la compatibilité de construction de ce lot dormant,
  pas le comportement sur appareil ; ce dernier reste une gate Android/iPhone du train lifecycle.
- `:app:assembleDebug` et le `xcodebuild` simulateur prouvent la compilation Debug réelle, pas un
  build EAS de publication avec R8/ProGuard, signatures et splits ABI. Ce dernier reste une gate du
  train APK, sous GO fondateur explicite.
- Android M124 `.0` et iOS M124 `.2` peuvent diverger en comportement audio/SDP ; toute anomalie
  spécifique à une plateforme commence par vérifier ce différentiel explicitement assumé.
- `124.0.8` ne fournit pas d'ACK acoustique structuré. Le futur train lifecycle reste bloqué tant
  qu'une autorité native/OS exacte, retentable et testée Android+iOS n'existe pas.
