# LOT RETOURS DEVICE — 2026-07-14 (fondateur, tests iPhone réels)

Source : session de test du fondateur sur device (screenshots Pilotage, Home, devis
D-2026-0005, Devis & Factures, facture d'acompte F-2026-0003). Sept demandes, une règle
gravée dans le marbre, et une passe challenge GPT exigée après ma livraison.

## RÈGLE GRAVÉE DANS LE MARBRE (s'applique à CHAQUE item)
**Parité STRICTEMENT égale manuel ↔ vocal Bob Live.** Chaque flow ci-dessous doit être
faisable à la voix, étape par étape : Bob guide, PROPOSE, demande de manière fluide et
structurée, et l'utilisateur VALIDE (plancher de sûreté inchangé : jamais d'action
financière à la seule voix — proposer → montrer → valider). Mécanique : affordances
d'écran (AgentSurface) + propositions révisables core (devis-proposal.ts) + i18n ×3.

## Les 7 demandes

### R1 — Pilotage : trop fade
Ajouter des couleurs VISUELLES pour faciliter lecture/compréhension (encaissé vs facturé,
tendance négative en warning — déjà orange, cascade SIG, top clients avec la barre de
concentration). Être PROACTIF sur d'autres améliorations de lisibilité. Contrainte
absolue : tokens uniquement (semantic.success/warning/danger, ai, gradients) — JAMAIS un
hex en dur dans l'UI.

### R2 — Home : carte « Ta semaine avec Bob » (le digest)
Deux problèmes : elle prend trop de place dans le Home (les raccourcis « en un coup
d'œil » sont en dessous), et le GAIN réel est montré de façon fade. Attendu : un visuel
moderne, esprit sales/marketing psychologique — montrer le RÉSULTAT que Bob apporte
(« 488 € encaissés cette semaine ») avec fierté, compact, célébration sobre. Options à
arbitrer : carte compacte à accent de couleur (success/gradient), pastille intégrée au
hero, ou déplacement partiel vers Argent avec un rappel discret au Home.

### R3 — Flow facture depuis le Home (BUG + navigation)
- La carte « Créer la facture finale — Boulangerie Lefèvre » (À régler aujourd'hui) doit
  naviguer vers LE DEVIS concerné (devis/[id]), pas vers /ventes.
- Sur le devis avec acompte DÉJÀ facturé (D-2026-0005, acompte 40 % = F-2026-0003) : le
  CTA doit dire « Générer la facture finale » (pas « Générer la facture »).
- BUG : le clic dit « facture générée » mais AUCUNE facture finale n'est créée. Diagnostic
  et correctif bout-en-bout (mobile + client + core + api si besoin).
- Tout le flow à régler à 100 % de manière proactive (états intermédiaires compris).

### R4 — « Faire signer » : deux options réelles
Aujourd'hui : une modale « Confirmer » (mensongère). Attendu au tap sur « Faire signer » :
- **« Sur place »** → écran avec PAD DE SIGNATURE natif (le client signe au doigt sur le
  téléphone de l'artisan, pour le devis concerné).
- **« Envoyer le lien »** → envoi du lien de signature à distance (l'app sign-web du
  projet, token public existant).

### R5 — Génération de facture : choix du type
Sur un devis SANS facture : « Générer la facture » ne doit PAS créer silencieusement une
facture de 100 %. Attendu : une modale bien stylée qui propose — facture de 100 % OU
facture d'acompte au pourcentage (utiliser LES VALEURS EXISTANTES du domaine — à vérifier
dans le core, le fondateur évoque 10/30/40). Le choix génère la facture correspondante.

### R6 — Brouillons et édition ligne par ligne
- Facture BROUILLON (liste Devis & Factures) : à côté d'« Émettre », un bouton corbeille
  (rouge) pour SUPPRIMER le brouillon (cas d'usage : erreur détectée dans le devis).
- Édition du devis ligne par ligne : swipe droite→gauche sur une ligne → actions
  Supprimer / Modifier (le fondateur privilégie le swipe ; jugement final chez moi sur le
  pattern le plus moderne/adapté). Modifier ouvre l'édition de la ligne.
- Règles domaine à respecter : que peut-on modifier selon le statut du devis (signé ?) et
  l'existence de factures liées — les invariants du core font foi, l'UI ne contourne rien.

### R7 — Parité vocale (règle du marbre appliquée)
Chaque nouveau flow (générer finale, choix d'acompte, faire signer avec 2 options,
supprimer brouillon, modifier/supprimer une ligne) reçoit ses affordances vocales sur les
écrans concernés + le chemin proposition→validation. Exemples cibles : « génère la facture
finale », « fais un acompte de 30 % », « fais signer sur place », « supprime le brouillon
de Mme Durand », « modifie la deuxième ligne, mets 3 heures ».

## Ordre d'exécution (valeur d'abord)
1. R3 (bug + navigation — le flow cœur est cassé) → 2. R5 (modale de choix, même zone de
code) → 3. R6 (suppression brouillon + swipe lignes) → 4. R4 (signature 2 options + pad)
→ 5. R2 + R1 (visuel Home/Pilotage) → R7 en continu dans chaque tranche.

## Passe challenge GPT (exigence fondateur)
Après ma livraison, GPT challenge TOUT (fonctionnalité, design, sécurité, architecture) :
ce document + les commits du lot + le handoff d'exploration constituent son dossier.
Points que je lui signale d'avance : la sûreté du pad de signature (preuve d'intention,
horodatage, lien au devis — la signature sur place doit valoir ce que vaut celle du lien
sign-web), l'immutabilité des documents émis (jamais d'édition d'une pièce émise), et la
parité vocale de chaque nouveau flux.

## Exploration 14/07 — faits décisifs (fichier:ligne dans le handoff w3dxfkh1s)
- R3 racine : GenerateInvoiceFromQuote infère mode='deposit' si quote.depositPct≠null (même déjà facturé) et la garde d'idempotence renvoie la facture d'acompte EXISTANTE avec ok() → « générée » sans rien créer. Chaîne mode explicite déjà transportée bout-en-bout ; pattern correct sur facture/[id] (mode:'final'). Carte Home : quoteId déjà sur FactureFinalePriority → router.push(/devis/{id}).
- R5 : DEPOSIT_PRESETS [0,10,20,30,40,50] vivent à la CRÉATION (devis/new). Domaine : depositPct figé au draft (setDeposit assertDraft) — il fait partie du CONTRAT signé.
- R4 : SignaturePad @bob/ui existe (SVG+PanResponder, tracé jeté — signQuote n'accepte que signerName) ; « Signer sur place » actuel = ConfirmSheet booléenne SANS tracé ; sendQuote renvoie déjà signatureToken (lien sign-web) ; Share/expo-sharing dispo.
- R6 : lignes modifiables UNIQUEMENT en draft (assertDraft ; signed = terminal) ; agrégat sans updateLine (add/remove only) ; AUCUN deleteInvoice dans la pile ; Swipeable classique dispo (reanimated = dép fantôme, NE PAS utiliser ReanimatedSwipeable) ; capacités agent quote.line.update DÉJÀ publiées mais non câblées.

## ARBITRAGES (documentés pour fondateur + challenge GPT)
1. Devis SIGNÉ = contrat : ni édition de lignes, ni changement du % d'acompte à la génération. Le choix R5 sur devis signé = {acompte signé X %, 100 %} ; sans acompte signé → 100 % direct. Les presets restent au moment de la CRÉATION. (Changer l'acompte après signature = altérer ce que le client a signé.)
2. Édition de lignes (swipe) : devis DRAFT uniquement — l'UI n'affiche pas ce que le domaine interdit. Un devis signé à corriger = nouveau devis/révision (chantier ultérieur si souhaité).
3. Suppression : facture BROUILLON uniquement (guard status='draft', tenant-scoped, full-stack à créer).
4. Signature sur place : réutiliser SignaturePad ; conserver le tracé = évolution domaine (Signature ne porte pas d'image) — proposé en suite du lot, challenge GPT invité (preuve/valeur juridique).
