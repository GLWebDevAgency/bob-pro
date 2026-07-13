# Audit vocal — Bob partout, conscient du contexte

Date : 2026-07-13

Auteur : session C (GPT)

Périmètre audité en lecture seule : apps/mobile, packages/ai, packages/api-client, avec lecture ponctuelle de packages/core et apps/api pour vérifier les frontières de use cases et le transport HTTP.

## Verdict

La vision est juste et techniquement atteignable, mais Bob n'est pas encore « partout » : c'est aujourd'hui un agent robuste enfermé dans l'onglet Assistant, plus un second flux vocal spécialisé qui ne sait que créer une facture. Aucun écran ne publie son contexte, aucun accès vocal ne survit correctement aux routes Stack, et la production HTTP jette même l'historique et l'humeur que l'écran Assistant construit.

Le projet possède déjà de très bonnes briques : IDs stables de pièces et de lignes, use cases métier purs, outils typés, désambiguïsation vocale fail-safe, confirmation explicite, calculs monétaires issus du domaine, TTS/STT et boucle live. La grosse difficulté n'est donc pas « ajouter un LLM » ; c'est de créer une session agentique unique, de transporter un contexte UI borné et non fiable, puis de faire recharger et revalider chaque cible par les mêmes use cases que l'interface manuelle.

Avant d'exposer un bouton global, trois prérequis sont bloquants :

1. corriger le transport HTTP de history, tone et context ;
2. supprimer le risque résiduel d'auto-confirmation par écho post-TTS ;
3. remplacer le PendingAction modifiable côté client par une proposition serveur opaque, versionnée, avec diff et challenge.

Décision de découpage recommandée :

- **S1 — Bob sait où je suis, en lecture seule** : contrat AgentContext, transport local/HTTP, résolution déterministe des anaphores, accès global avec une seule oreille ;
- **S2 — édition vocale devis/factures** : nouveaux use cases de brouillon, diff canonique, proposition serveur sûre, même parcours manuel et vocal ;
- **S3 — généralisation** : toutes les capacités restantes, migration du wizard /voix en sous-flux spécialisé, fermeture complète de la parité.

## 1. Constats prioritaires

### P0 — Le contexte UI n'existe pas

AskOptions ne connaît que l'autonomie, la phase, l'historique et le ton (packages/ai/src/agent/bob-agent.ts:275-284). L'appel réel de l'écran Assistant confirme l'absence de screen/entities/capabilities :

    const r = await agent.ask(message, {
      autonomy,
      history,
      tone: personality,
      onPhase: ...
    });

Source : apps/mobile/app/(tabs)/assistant.tsx:331-346.

La résolution actuelle ne lit que le texte : numéro de pièce, mot significatif du nom client, ou repli si une seule pièce est disponible (packages/ai/src/agent/bob-agent.ts:163-205). Elle ne peut pas distinguer « cette facture », « ce devis » ou « ligne 2 » à partir de l'écran.

Les données nécessaires existent pourtant déjà. PieceLineView conserve line.id et l'ordre visuel (packages/core/src/application/billing/build-piece-view.ts:80-89,184-194), puis PieceDetailView rend ces lignes dans le même ordre :

    view.lines.map((line, i) => (
      <LineRow key={line.id} line={line} ... />
    ))

Source : apps/mobile/src/components/PieceDetailView.tsx:395-400.

### P0 — L'historique et l'humeur sont perdus sur le vrai chemin HTTP

L'écran construit six tours d'historique et transmet tone, mais makeServerAssistant ne garde que message et autonomy :

    return client.askBob({
      message,
      ...(opts.autonomy !== undefined ? { autonomy: opts.autonomy } : {})
    });

Source : apps/mobile/src/data/bob.ts:38-46.

AskBobClientInput confirme ce DTO réduit à deux champs (packages/api-client/src/client.ts:246-251), et le contrôleur serveur reçoit la même forme (apps/api/src/api.controllers.ts:497-504). LocalBobClient.askBob redescend lui aussi à autonomy (packages/api-client/src/local-client.ts:1455-1459). Résultat : l'anaphore LIVE-2 démontrée directement contre le moteur n'est pas disponible dans l'application connectée. Ajouter context uniquement côté React créerait donc une intégration factice.

### P0 — La confirmation vocale peut encore avaler son propre écho

Le correctif récent coupe le barge-in pendant un prompt de confirmation et ajoute une purge. Mais le prompt prononce lui-même la phrase acceptée :

    return actionLabel +
      '. Dites « je confirme » pour valider, ou « annule » pour abandonner.';

Source : packages/ai/src/voice/voice-confirm.ts:48-49.

Dans la fenêtre post-TTS, une réponse de consentement courte est volontairement exclue de l'échoscan, puis « je confirme » déclenche confirm :

    const structuredReply =
      expected.kind === 'consent' &&
      shortReply &&
      parseVoiceConsent(text) !== 'unclear';

    if (!structuredReply && echoOverlap(text, reference) >= 0.5) ...

Sources : apps/mobile/app/(tabs)/assistant.tsx:515-526,553-559.

Un résidu audio « je confirme » reçu après la purge peut donc suivre exactement le chemin d'un consentement humain. Les 32 tests ciblés voix/diff/confirmation sont verts, mais aucun ne couvre cette composition post-TTS.

Correctif requis avant bouton global :

- ne prononcer aucun token affirmatif accepté dans le prompt ; demander par exemple « Souhaitez-vous valider ou annuler ? » ;
- conserver l'oreille fermée pendant le TTS et recréer une session STT après silence/purge ;
- supprimer le bypass consent-écho actuel ou le borner à une nouvelle session audio prouvée ;
- ajouter un test de composition TTS → résidu → consent : zéro exécution ;
- pour amount/fiscal, utiliser le challenge typé ou basculer vers la validation visuelle si le canal audio n'est pas fiable.

### P0 — La proposition à confirmer n'est ni opaque, ni liée au diff

PendingAction ne contient que tool, args, label et éventuellement batch (packages/ai/src/agent/bob-agent.ts:42-49). Le client renvoie ces args à POST /ai/confirm ; confirm() refait parse puis run directement (packages/ai/src/agent/bob-agent.ts:1328-1346). Le diff n'est pas dans la proposition : l'Assistant le reconstruit en best-effort pour trois outils seulement (apps/mobile/app/(tabs)/assistant.tsx:278-300).

Cela ne suffit pas pour une correction financière contextuelle : la cible, le montant, la version et l'avant/après doivent être liés à ce que le serveur a proposé. Le contrat cible doit être :

    PendingActionView {
      proposalId;
      label;
      diff;
      challenge;
      expiresAt;
    }

Le plan interne serveur conserve tool, args, tenant, expectedVersion et contextFingerprint. POST /ai/confirm reçoit uniquement proposalId et la réponse au challenge. Avant exécution, le serveur recharge l'agrégat, revalide tenant/RBAC/état/version, puis appelle le même use case. Une proposition expirée ou obsolète est recalculée, jamais exécutée par approximation.

### P1 — Les catalogues « compris par le LLM » et « exécutables » divergent

Les specs de classification sont codées séparément dans packages/ai/src/agent/classifier.ts:5-161 et le registre exécutable dans packages/ai/src/tools/registry.ts:63-405. creer_devis, scan_depense, export_fec, envoyer_relance et creer_client sont exposés dans BobActions/registry mais n'ont pas tous un BobIntent et une branche runSingle ; ils sont donc inaccessibles par ask malgré leur présence.

S3 doit générer specs LLM, intent, registre et capabilities depuis une définition d'outil unique. Sinon la promesse de parité continuera à dériver silencieusement.

### P1 — Une seule oreille globale est indispensable

Assistant instancie useVoiceInput (assistant.tsx:413-429) et /voix en instancie une seconde (voix.tsx:276-284). Le hook branche des événements STT globaux mais n'a ni lease/mutex, ni nettoyage AppState/unmount (apps/mobile/src/data/voice.ts:41-130). Deux écrans montés peuvent donc se disputer le micro ou recevoir un transcript.

Le futur AgentSessionProvider doit être l'unique propriétaire de STT, TTS, echo-guard, attente de choix et confirmation. Chaque tour capture un snapshot immuable du contexte. À AppState différent de active, il arrête micro/TTS et invalide l'attente.

### P1 — Le flux /voix ne sait pas corriger

/voix cumule les transcriptions, puis re-dérive le brouillon depuis tout le texte (apps/mobile/app/voix.tsx:276-324). « 450, pas 540, corrige la ligne 2 » peut donc ajouter ou reparser, mais pas adresser un line.id. Après une seule feuille de confirmation, le flux chaîne createQuote → sendQuote → signQuote → generateInvoice → issueInvoice → paiement éventuel (voix.tsx:332-377).

Cette machine reste utile comme compétence spécialisée de création de facture, mais :

- elle ne doit plus être l'entrée vocale générique ;
- son auto-signature « sur place » au nom du client doit être requalifiée juridiquement avant généralisation ;
- elle doit céder le micro à la session globale et être invoquée comme sous-flux explicite.

### P1 — i18n et confirmation ne couvrent pas encore les trois voix

L'infrastructure @bob/i18n impose pote/pro/direct (packages/i18n/src/index.ts:1-19), mais buildSpokenConfirmation, speakableQuestion, ActionDiff et plusieurs textes de ConfirmSheet sont des chaînes françaises fixes. tone n'agit aujourd'hui que sur la naturalisation et ne traverse pas HTTP. Les nouvelles clés globales, contextuelles et de diff doivent être ajoutées dans les trois humeurs ; les textes légaux/fiscaux doivent rester sémantiquement identiques entre humeurs.

## 2. Cartographie exhaustive des écrans

« Onglet » signifie que l'utilisateur doit quitter son écran pour ouvrir Assistant ; ce n'est pas un accès contextuel. Toutes les routes Stack perdent la BottomTabBar.

| Route / fichier | Entités et IDs réellement disponibles | Pouvoirs vocaux attendus | Accès Bob actuel |
|---|---|---|---|
| /(tabs)/index.tsx | cashflow, customers, priorities p.id, invoiceId, invoices, notifications (:279-299,:388-399) | expliquer disponible/payout, lire la priorité, « relance/encaisse celle-ci », générer finale, ouvrir diagnostic/devis/scan | Onglet Assistant ; relance générique sans ID ; micro vers /voix facture seulement (:198-217,:470-496) |
| /(tabs)/clients.tsx | customer.id, invoices, quotes, standing.customerId, création client (:307-405,:412-460) | chercher/ouvrir/créer, lister retardataires, relancer, renommer/archiver lorsque les use cases existent | Onglet seulement ; FAB métier de création client |
| /(tabs)/argent.tsx | cashflows 7/30/60/90, invoices, expenses, entries, customers, company, payments, deadline.id, aged.customerId (:373-434,:716-753,:890-954) | expliquer réserves/scénario/échéance, comparer horizons, ouvrir/relancer un client | Onglet + CTA relance générique ; FAB nouveau devis |
| /(tabs)/documents.tsx | document.id, linkedEntityType/Id, expense/chantier/invoice/customer IDs (:289-365,:609-620,:874-879,:987-1032) | retrouver/ouvrir/scanner, classer « ce document », corriger classement, exporter FEC | Onglet seulement |
| /(tabs)/assistant.tsx | fil local, invoices, quotes, pending invoiceId/quoteId, prompt optionnel (:229-299) | agent générique, live, choix, confirmation, navigation | Direct ; live générique + micro adjacent vers /voix facture (:377-599,:948-993) |
| /catalogue.tsx | prestations p.id, profil, suggestion/personnalisée (:93-162,:291-298) | rechercher, créer, modifier prix/TVA/catégorie, supprimer une prestation perso | Aucun |
| /chantiers.tsx | chantier.id, profil/module, suggestions adresse (:14-20,:106-116) | créer/ouvrir/renommer/clôturer, choisir adresse, associer client/pièce lorsque disponible | Aucun |
| /client/[id].tsx | param id, customer, invoices/quotes/chantiers/docs filtrés, invoiceId et linkedEntityId (:316-400) | « relance ce client/cette facture », créer devis, ouvrir la nième pièce, renommer/archiver futur | Deux liens Assistant avec prompt générique sans ID (:535-565,:733-755) |
| /cloture.tsx | invoices/quotes/docs/entries/company, signed quote IDs, invoice IDs, control.id (:92-155,:341-366) | expliquer contrôle/anomalie, ouvrir les pièces concernées, préparer/exporter dossier/FEC | Aucun |
| /comptabilite.tsx | accounting entry.id, lignes/comptes/référence/date, export FEC (:98-155,:388-423) | expliquer cette écriture/ligne/compte, filtrer journal, trouver déséquilibre, exporter | Aucun |
| /compte.tsx | tab profil/abonnement, identité/session/profile/subscription, plan, invoice id (:86-112,:211-279,:406-459) | expliquer offre/profil/services, ouvrir réglages ; déconnexion uniquement confirmée | Aucun |
| /depenses.tsx | expense.id, fournisseur/catégorie/statut/totaux (:69-105,:258-313) | « paie cette dépense », filtrer/expliquer TVA, corriger les champs via futur use case, scanner | Aucun |
| /devis/[id].tsx | quote id, customerId, invoice id, PDF doc id, line.id stable (:20-99) | lire, « ligne 2 : 450 pas 540 », TVA/acompte, envoyer/signer/refuser/facturer, ouvrir PDF/facture | Aucun |
| /devis/new.tsx | brouillon local customerId/lignes/TVA/acompte/signature, prestation IDs, futurs quoteId/invoiceId (:186-230,:298-386) | remplir/corriger le formulaire et la ligne 2, naviguer entre étapes, créer/envoyer après confirmation | Aucun |
| /diagnostic.tsx | diagnostic, customer ids/types/SIREN, invoice id/customerId/lines, payment invoiceId, question IDs/routes (:220-291,:592-640) | répondre, expliquer score/axe, lancer l'action correctrice | Aucun |
| /facture/[id].tsx | invoice id, customerId, parentQuoteId, sibling IDs, PDF doc id, accounting preview, line.id (:24-72,:113-154) | lire ; corriger si brouillon ; émettre/relancer/encaisser ; créer avoir ; ouvrir devis/PDF/écriture | Aucun |
| /gallery.tsx | thème et données factices, aucune donnée réseau (:1-5,:98-115) | aucune capability métier ; route de développement à exclure | Aucun Bob réel |
| /notifications.tsx | notification.id/route, invoiceId, customerId, doc number (:375-414,:485-567) | lire/ouvrir la première, relancer cette facture, expliquer, marquer lu | Aucun |
| /onboarding.tsx | step, Trade, clientèle, VatRegime, profil lu ; réponses non persistées (:145-158) | choisir/expliquer/suivant/précédent ; ne jamais promettre une sauvegarde inexistante | Aucun |
| /pilotage.tsx | entries/payments/invoices/customers/expenses/company, top customerId (:81-122,:377-443) | expliquer KPI/DSO/SIG/concentration, comparer mois, ouvrir top client | Aucun |
| /recherche.tsx | q, customer IDs, piece source+id, document id (:86-109,:216-291) | rechercher/reformuler, « ouvre le deuxième résultat/cette facture » | Aucun |
| /reglages-facturation.tsx | profile, dernière invoice id/number/mentions (:62-69,:167-216) | expliquer TVA/mentions/numérotation, ouvrir catalogue ; pas d'édition sans endpoint | Aucun |
| /scan-document.tsx | photo mémoire, OCR draft, supplier/category/tags, expense id après enregistrement (:26-61,:174-206) | capturer après geste/permission, corriger OCR/TVA/catégorie, enregistrer confirmé | Aucun agent global ; QuestionSheet seulement |
| /ventes.tsx | quote/invoice/customer IDs, statuts/totaux, DocumentActions (:26-41,:92-164) | filtrer/ouvrir, envoyer le 2e devis, émettre/relancer/encaisser/créer avoir selon l'état | Aucun |
| /voix.tsx | customer IDs, profile, prestations, brouillon sans line.id persistant, futurs quoteId/invoiceId/number (:248-386) | sous-flux de dictée facture, pas agent générique | Micro direct plein écran, facture seulement |

### Layouts

- apps/mobile/app/_layout.tsx:75-110 monte BobClientProvider → AuthGate → ConfirmProvider → Stack, sans contexte, session vocale ou overlay. Le futur accès global doit rester absent avant auth, provisioning et biométrie.
- apps/mobile/app/(tabs)/_layout.tsx:19-25,40-55,61-69 contient cinq onglets dont Assistant. Cet accès disparaît sur les routes Stack et modales.

## 3. Contrat AgentContext proposé

Le contrat doit rester petit, sérialisable, fermé et sans donnée financière dupliquée. Les montants ne voyagent pas dans le contexte : le serveur les recharge depuis le domaine.

    export type AgentEntityType =
      | 'customer' | 'quote' | 'quote_line'
      | 'invoice' | 'invoice_line'
      | 'expense' | 'document' | 'chantier'
      | 'notification' | 'accounting_entry';

    export interface AgentEntityRef {
      readonly type: AgentEntityType;
      readonly id: string;
      readonly label: string;
      readonly ordinal?: number;
      readonly parent?: { readonly type: AgentEntityType; readonly id: string };
      readonly version?: string;
    }

    export type AgentCapability =
      | 'entity.read'
      | 'quote.line.update'
      | 'quote.deposit.update'
      | 'invoice.draft_line.update'
      | 'invoice.collect'
      | 'invoice.issue'
      | 'invoice.credit_note.create'
      | 'customer.rename'
      | 'document.classify';

    export interface AgentContext {
      readonly screen: {
        readonly name: string;
        readonly instanceId: string;
      };
      readonly entities: readonly AgentEntityRef[];
      readonly capabilities: readonly AgentCapability[];
    }

    export interface AgentAskPayload {
      readonly message: string;
      readonly autonomy?: AgentAutonomy;
      readonly history?: readonly { role: 'user' | 'bob'; text: string }[];
      readonly tone?: 'pote' | 'pro' | 'direct';
      readonly context?: AgentContext;
    }

    export interface AskOptions extends Omit<AgentAskPayload, 'message'> {
      readonly onPhase?: (phase: AgentPhase) => void;
    }

Bornes : historique 6 tours, entités 20, label 120 caractères, liste de screen/capabilities fermée. Le contexte est un **indice non fiable**, jamais une autorisation. Les labels sont minimisés et nettoyés comme une entrée de prompt. Le LLM reçoit des alias E1/E2 avec type/label/capability, jamais les IDs bruts ; le mapping alias → ID reste côté agent.

### Publication React

Arbre cible :

    <BobClientProvider>
      <AuthGate>
        <AgentContextProvider>
          <AgentSessionProvider>
            <ConfirmProvider>
              <Stack />
              <GlobalBobAccess />
              <AgentOverlay />
            </ConfirmProvider>
          </AgentSessionProvider>
        </AgentContextProvider>
      </AuthGate>
    </BobClientProvider>

Chaque écran appelle usePublishAgentContext au focus, pas au seul mount : les tabs sous-jacents restent montés. Le provider empile les publications, sélectionne la route focus, et nettoie au blur/unmount avec un token de publication. useAgentContext expose le snapshot actif à AgentSessionProvider et à l'overlay, sans permettre aux écrans de le muter directement. Un contexte distinct VoiceChromeContext publie bottomAvoidance/hidden ; il ne doit jamais être sérialisé vers l'agent.

À la fin du transcript, AgentSessionProvider fige contextAtTurn. Une navigation pendant le réseau n'altère pas la cible du tour en cours. Le prochain tour prend le nouveau contexte. Une proposition conserve son contextFingerprint et sa version jusqu'à confirmation ou expiration.

### Résolution des anaphores

Ordre strict :

1. référence explicite dans la phrase ;
2. entité focus de type compatible et capability compatible ;
3. unique entité compatible publiée par l'écran ;
4. histoire conversationnelle ;
5. sinon AgentQuestion.

Jamais de « premier résultat » silencieux, de similarité floue, ni de repli à une pièce d'un autre type. Pour « ligne 2 », l'agent charge le devis tenant-scoped, compare l'ordre canonique à l'ordinal publié, puis transforme l'ordinal en lineId stable. L'exécution utilise lineId + expectedVersion, jamais l'ordinal.

Exemple demandé :

1. /devis/q-42 publie quote q-42 et ses quote_line l-1/l-2 dans l'ordre visuel ;
2. « tu t'es trompé ligne 2, c'est 450 € pas 540 » sélectionne l-2 ;
3. le serveur recharge q-42, vérifie draft, tenant, version et valeur canonique actuelle ;
4. si l'avant canonique n'est pas 540 €, Bob signale le conflit et redemande ;
5. le core calcule prix unitaire, HT, TVA, TTC avant/après ;
6. l'overlay montre ActionDiffView ; aucune écriture ;
7. après challenge explicite, UpdateQuoteLine s'exécute une fois ;
8. query invalidée, contexte republié avec la nouvelle version.

## 4. Nouveaux pouvoirs et parité humain ↔ Bob

BobActions ne contient aujourd'hui aucune édition de pièce. Quote sait ajouter/supprimer une ligne et poser l'acompte uniquement en draft, mais aucun use case UpdateQuoteLine n'existe (packages/core/src/domain/billing/quote/quote.ts:68-102). Customer est immuable (packages/core/src/domain/customer/customer.ts:24-87).

Pouvoirs à ajouter, uniquement après création du use case manuel correspondant :

| BobAction | Use case / règle | Confirmation et diff |
|---|---|---|
| getContextEntity | lecture tenant-scoped de la projection nécessaire | aucune mutation ; faits du domaine seulement |
| updateQuoteLine | nouveau UpdateQuoteLine ; devis draft seulement ; lineId + patch + expectedVersion | toujours proposé pour une dictée chiffrée ; PU, qty, TVA, HT/TVA/TTC avant/après |
| setQuoteDeposit | nouveau use case autour de Quote.setDeposit | pourcentage et totaux avant/après |
| updateDraftInvoiceLine | nouveau use case ; facture draft seulement | montant/totaux avant/après ; facture émise refusée |
| renameCustomer | nouvelle méthode domaine + use case avec validation | nom avant/après ; même formulaire manuel |
| classifyDocument | use case client existant à exposer proprement | type/lien avant/après |
| createCreditNote | use case existant | palier fiscal ; seul chemin de correction d'une facture émise |

Les changements de brouillon restent classés draft/reversible dans le domaine, mais toute modification monétaire dictée reçoit une policy de confirmation always, distincte de son riskTier. Les paliers accounting/outbound/fiscal restent inviolables. Le LLM ne calcule aucun montant et ne complète jamais un prix absent : il pose une question structurée.

ActionDiff doit être étendu au-delà des trois cas actuels encaisser/émettre/envoyer (packages/ai/src/agent/action-diff.ts:54-94). Le diff est produit à partir d'un snapshot canonique serveur et d'un preview core. ActionDiffView ne fait que rendre cette preuve.

Une facture émise est immuable : Bob refuse updateDraftInvoiceLine et propose l'avoir/correction légale existante. Un devis sent/viewed/signed/refused/expired n'est jamais réécrit comme draft.

## 5. Accès global et UX

### Placement

Conserver l'onglet Assistant comme fil/historique et secours clavier. Ajouter GlobalBobAccess dans RootLayout, au-dessus du Stack, ouvrant une sheet/overlay sans navigation.

Placement recommandé :

- bas-gauche, 56 × 56, couleur semantic.ai, au-dessus du chrome ;
- les FAB métier restent bas-droite (Clients, Argent) ;
- sur les tabs, respecter le dégagement de la pill flottante ;
- sur les détails, remonter au-dessus des barres d'actions sticky ;
- sur /devis/new et /voix, publier un bottomAvoidance spécifique ;
- sur Assistant, le contrôle global se docke dans le composer : jamais deux boutons ni deux listeners ;
- sur /voix, le wizard possède temporairement le lease micro et l'accès global reflète « flux en cours ».

Ne pas coder une table de offsets par pathname. useBobAccessLayout publie l'évitement au focus. /gallery est hidden et sans capability métier.

### États

- idle : « Parler à Bob », pas d'animation continue ;
- listening : pill « Je vous/t'écoute », tap = finaliser ;
- thinking : « J'analyse », deuxième envoi bloqué ;
- speaking : « Bob répond », tap/barge-in = interrompre ;
- awaiting_choice : parseVoiceChoice fail-safe + choix visuel ;
- awaiting_confirmation : diff visible, écoute structurée, TTS sans token affirmatif ;
- permission_denied/unavailable/offline/error : texte honnête et clavier ;
- background/suspended : micro et TTS arrêtés, attente invalidée.

« Mains-libres » en S1 signifie un tap initial puis une boucle continue. Un hotword OS n'est ni réaliste ni sûr dans ce périmètre.

### Accessibilité

- cible au moins 56, role button, label/hint dynamique, selected/live et busy/thinking ;
- live region polite pour les transitions, assertive seulement pour erreur/confirmation ;
- état jamais transmis par la seule couleur ;
- focus dans la sheet puis retour au bouton ;
- Reduce Motion : état fixe + texte/icône ; les boucles actuelles de voix.tsx et Assistant n'en tiennent pas compte ;
- Dynamic Type, VoiceOver/TalkBack, 320/390/402 px, safe areas, clavier ouvert ;
- avec lecteur d'écran, suspendre l'oreille pendant les annonces ou utiliser push-to-talk par défaut afin que l'annonce ne soit pas retranscrite.

### Migration des entrées actuelles

- today.quickVoice ouvre l'overlay générique ; « Facture à la voix » devient une action explicite du hub ;
- le micro adjacent au live dans Assistant disparaît ou devient le même contrôle global ;
- les prompts génériques « relance » depuis Home/Argent/Client deviennent openBob avec contexte, sans perdre invoiceId/customerId ;
- /voix reste provisoirement un sous-flux spécialisé, puis n'est plus une entrée principale.

## 6. Plan implémentable

### S1 — Contexte lecture seule : « Bob sait où je suis »

**Objectif.** Bob est accessible sur chaque écran authentifié, connaît uniquement les entités réellement affichées, répond avec des faits rechargés, et ne possède encore aucune nouvelle mutation.

**Fichiers principaux.**

- nouveau packages/ai/src/agent/context.ts + tests ;
- packages/ai/src/agent/bob-agent.ts, classifier.ts + tests ;
- packages/api-client/src/client.ts, http-client.ts, local-client.ts + tests ;
- apps/api/src/api.controllers.ts et backend.service.ts pour accepter/revalider le payload ;
- nouveaux apps/mobile/src/agent/AgentContextProvider.tsx, AgentSessionProvider.tsx ;
- nouveau apps/mobile/src/components/GlobalBobAccess.tsx / AgentOverlay.tsx ;
- apps/mobile/app/_layout.tsx, extraction du live depuis (tabs)/assistant.tsx, src/data/voice.ts ;
- publishers légers dans les 25 routes, /gallery hidden ;
- packages/i18n catalogues/tests, clés agent.global/context ×3.

**Risques.** Contexte de screen caché, PII/prompt injection, IDs/capabilities forgés, payload trop grand, contexte stale, double micro, overlay sur CTA, écoute en background.

**Acceptation.**

- un seul propriétaire STT/TTS et un seul bouton logique ;
- local et HTTP transmettent history, tone et le même context snapshot ;
- chaque route focus publie son screen ; détails publient seulement les IDs chargés ;
- « résume cette facture/devis/client » cible la pièce affichée et cite uniquement ses données canoniques ;
- 0 ou plusieurs cibles compatibles produisent AgentQuestion ; aucune supposition ;
- navigation/back/modal ne laisse jamais l'ancien contexte actif ;
- ID d'un autre tenant → not_found, capability forgée → ignorée/recalculée ;
- AppState background coupe le live ;
- aucune nouvelle mutation ;
- echo-guard, parseVoiceChoice, consent et tests de composition post-TTS verts ;
- trois humeurs, Reduce Motion, VoiceOver/TalkBack.

### S2 — Édition vocale des devis et factures

**Prérequis bloquants.** proposalId serveur opaque, challenge typé, correction de l'écho de confirmation, version/concurrence sur les agrégats.

**Fichiers principaux.**

- packages/core : Quote/Invoice/Customer et nouveaux UpdateQuoteLine, SetQuoteDeposit, UpdateDraftInvoiceLine, RenameCustomer + tests ;
- apps/api : endpoints, adapters/repositories, tests tenant/concurrence ;
- packages/api-client : DTO/méthodes local/HTTP/tests ;
- packages/ai : actions.ts, intent/classifier, registry, bob-agent, action-diff, confirmation/voice tests ;
- mobile : publishers devis/facture, édition manuelle partageant les use cases, AgentOverlay, ActionDiffView/ConfirmSheet, i18n.

**Risques.** Ordinal différent du lineId, course lecture→diff→OK, confusion HT/TTC, recalcul TVA/acompte, facture émise mutée, replay/double action, version absente dans les DTO actuels.

**Acceptation.**

- devis draft réel avec ligne 2 à 540 € : « 450, pas 540 » produit un diff 540 → 450 et les nouveaux totaux core ; DB intacte ;
- annuler, réponse ambiguë ou résidu TTS « je confirme » : zéro mutation ;
- confirmation valide : le lineId exact est modifié une seule fois par le même use case que le formulaire manuel ;
- version stale : refus + nouveau diff, jamais application aveugle ;
- ligne ambiguë : question structurée ;
- devis non draft et facture émise : mutation refusée ; facture émise propose l'avoir ;
- tentative cross-tenant : 404/not_found ;
- aucun nombre calculé ou complété par le LLM.

### S3 — Généralisation et fermeture de la parité

**Objectif.** Étendre le même modèle aux clients, documents, dépenses, chantiers, comptabilité, paramètres autorisés et navigation ; faire de /voix une compétence du hub.

**Fichiers principaux.**

- publishers/capabilities complets pour toutes les routes ;
- nouveaux BobActions seulement lorsqu'un CTA manuel et son use case existent ;
- génération unique registry ↔ LLM specs ↔ intent ↔ capabilities ;
- migration finale de app/voix.tsx, suppression des chaînes parallèles et doubles useVoiceInput ;
- i18n, a11y, tests E2E device.

**Risques.** Dérive humain/Bob, trop de contexte/PII, capability prise pour autorisation, fatigue/activation accidentelle, collisions chrome, dégradation cloud sans barge-in.

**Acceptation.**

- matrice route × capability exhaustive et testée ;
- chaque tool mutateur trace vers un CTA manuel et le même use case ;
- serveur revalide tenant/RBAC/état/version ;
- toutes les mutations vocales montrent leur diff et respectent le plancher ;
- toutes les ambiguïtés demandent, aucune heuristique silencieuse ;
- /voix n'a plus de chaîne agentique parallèle ;
- tests voix/tap sur permission refusée, offline, écho, interruption, choix, confirmation, navigation, reprise et background ;
- trois humeurs et audit a11y sur appareils ;
- zéro montant inventé.

## 7. Tests à ajouter en premier

1. **EchoConfirmComposition** : le TTS du prompt réinjecté après la purge ne confirme jamais.
2. **HttpAskParity** : message/history/tone/context identiques entre LocalBobClient et HttpBobClient.
3. **FocusedScreenWins** : un tab monté mais non focus ne remplace pas le contexte d'une modale.
4. **ContextIsNotAuthority** : capability ou ID forgé ne contourne ni tenant, ni statut.
5. **LineOrdinalToStableId** : ordinal publié → lineId canonique ; reorder/stale → question/reproposition.
6. **ProposalTampering** : /ai/confirm ne reçoit pas d'args ; proposalId expiré/rejoué/modifié échoue.
7. **NoWriteBeforeConsent** : diff, annulation, unclear et echo laissent les repositories inchangés.
8. **IssuedInvoiceImmutable** : correction vocale sur facture émise propose un avoir.
9. **SingleMicLease** : Assistant, overlay et /voix ne peuvent pas posséder deux sessions STT.
10. **NoInventedMoney** : chaque montant vocalisé/diffé est inclus dans les données canoniques ou produit par le core.

## Conclusion

La trajectoire recommandée préserve ce qui est déjà fort : le domaine calcule, Bob orchestre, la voix n'est qu'un canal, et l'ambiguïté n'écrit rien. L'accès global ne doit pas être un simple FAB branché sur l'Assistant actuel : il exige d'abord un contexte sérialisé de bout en bout, une session audio unique et une proposition confirmable inviolable.

Une fois S1 livrée, Bob pourra honnêtement dire « je sais où tu es » sans pouvoir modifier quoi que ce soit. S2 ajoutera le cas fondateur « ligne 2, 450 € au lieu de 540 € » avec preuve avant/après. S3 étendra cette même mécanique au reste de l'application sans créer de chemin métier parallèle.

## État d’exécution — S1 prête pour contre-revue

Mise à jour du 13 juillet 2026, session C.

S1 a été implémentée sur les frontières IA, HTTP, API et mobile : `AgentContext`/`AgentAskPayload` fermés et bornés, historique/ton/contexte transportés à parité local-HTTP, résolution contextuelle fail-safe, rechargement canonique tenant-scoped, provider racine, accès Bob global, snapshot au tour, lease STT process-wide et coupure AppState. Les écrans Aujourd’hui, recherche, client, devis et facture publient leurs entités réelles ; toutes les autres routes authentifiées conservent l’accès global avec un contexte écran minimal. `/gallery`, Assistant et `/voix` ont une cohabitation explicite.

Les prérequis de sécurité ont également été avancés avant S2 : le prompt parlé ne contient plus aucun consentement accepté, y compris lorsqu’un libellé métier hostile contient ces mots avec ponctuation ; le client HTTP confirme uniquement un `proposalId` opaque ; le serveur persiste le dry-run tenant-scoped, impose une expiration de dix minutes, ignore les `tool/args/label` du client et consomme atomiquement la proposition avant exécution. Les tests couvrent résidus TTS courts, altération des arguments, replay, isolation tenant et recharge canonique malgré un label falsifié.

La session globale reste volontairement en `confirm_all` et ne possède aucun chemin de confirmation : toute proposition ou question structurée s’arrête avec « rien exécuté, terminer à l’écran ». Cela maintient S1 en lecture seule, même si le réglage d’autonomie de l’abonnement est supérieur.

Validations au point de handoff : `pnpm test` (14 tâches), `pnpm typecheck` (16 tâches), `pnpm lint` (8 tâches) et `git diff --check` verts. La validation STT/TTS, permissions, safe areas, clavier et AppState sur appareils iOS/Android reste obligatoire. S2 demeure bloquée jusqu’à la contre-revue adversariale de Claude, puis exigera encore diff canonique, challenge typé et version d’agrégat avant toute édition financière.

La revue adversariale interne finale n’a trouvé aucun P0, mais trois P1 ont été fermés avant le handoff :

- les réponses métier/contextuelles, montants, numéros de pièces et pourcentages ne passent plus dans la naturalisation cloud ; la décision est prise avant même la construction du prompt ;
- le lease micro est désormais fencé par propriétaire, génération et état `active|closing`, de sorte qu’un ancien `end`, callback ou timer ne peut pas libérer une nouvelle session ; l’audio cloud temporaire est supprimé en `finally` et limité à 8 MiB ;
- l’email de devis est produit par une outbox commitée et le worker conserve une UUID provider stable sur les retries. Les actions agentiques `outbound` restent néanmoins bloquées fail-safe et doivent être terminées à l’écran tant que la relance n’a pas, elle aussi, migré vers cette outbox stricte.

Le serveur refuse en plus les MIME audio hors allowlist, le Base64 invalide et les payloads décodés supérieurs à 8 MiB. La matrice finale `test + typecheck + lint` compte 32/32 tâches vertes, plus `git diff --check` vert.

## Durcissement production post-audit — sorties et outbox

Mise à jour du 13 juillet 2026, session C, avant contre-revue Claude.

Les sorties devis et relances ne réalisent plus aucun appel réseau dans la transaction HTTP ou métier. Elles committent un job, puis `NotificationDeliveryService` le réclame dans une transaction courte, appelle le fournisseur hors transaction et finalise avec un fence générationnel. Le payload effectivement envoyé est celui relu après le claim, jamais le snapshot potentiellement obsolète de `listDue`.

Garanties désormais testées :

- UUID provider stable sur retry et ré-enqueue, y compris crash après acceptation Brevo mais avant `markDone` ;
- insertion concurrente par `createMany(skipDuplicates)`/`ON CONFLICT DO NOTHING`, sans `P2002` qui invaliderait la transaction PostgreSQL ;
- lease de cinq minutes et `leaseToken` UUID séparé de l'échéance, avec `markDone`/`markFailed` conditionnés par tenant + génération ;
- aucun ré-enqueue ne raccourcit un lease actif ni ne remplace son payload ; expiration exacte, snapshot A→B et ABA dans la même milliseconde sont couverts ;
- push Expo uniquement après commit email et uniquement par le worker gagnant ; une panne push ne remet jamais l'email en retry ;
- endpoint `POST /jobs/run-relances` limité au tenant authentifié ; seul le cron interne parcourt tous les tenants ;
- relances automatiques dédupliquées par facture + version de politique + palier (`cordial`, `neutre`, `ferme`), relances manuelles dédupliquées séparément par jour ; la mise en demeure reste exclusivement humaine ;
- compteurs séparant `queued`, `sent` et `deduplicated`, sans annoncer chaque jour un ancien envoi ;
- proposition agent opaque liée à `companyId` **et** `userId`, expirante et consommée atomiquement ; un collègue du même tenant ne peut pas l'exécuter ;
- résultat `envoyer_devis` projeté par allowlist vers le seul `deliveryStatus` : token et URL de signature n'entrent ni dans l'outcome, ni dans le journal ;
- cartes et UI distinctes `queued` / `sent` / `skipped`. `sent` est formulé honnêtement comme « pris en charge par le service d'envoi » : aucune livraison inbox n'est affirmée sans webhook fournisseur.

`envoyer_devis` est le seul outil sortant autorisé par l'agent serveur. `envoyer_relance` reste bloqué fail-safe tant que son adapter agent serveur et son test agent→outbox ne sont pas câblés, même si le chemin manuel des relances utilise déjà l'outbox certifiée.

La migration `20260713043000_notification_job_lease_token` doit être appliquée avant le déploiement de ce worker. S2 reste bloquée pour la revue Claude et pour les versions d'agrégats/diffs canoniques ; aucune édition vocale financière nouvelle n'a été activée. La QA physique iOS/Android STT/TTS, permissions, safe areas, clavier et AppState reste requise.

Validations finales locales : 63 tests API ciblés outbox/agent, 49 tests IA ciblés, 43 tests API-client, 55 tests i18n, schéma Prisma valide, puis matrice monorepo `test + typecheck + lint` à 32/32 tâches et `git diff --check` vert. La concurrence `skipDuplicates` n'a pas été rejouée contre la base PostgreSQL/RLS de production afin de ne pas muter un environnement partagé depuis cette session ; elle reste une certification de déploiement explicite.
