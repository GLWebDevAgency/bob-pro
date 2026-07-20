# Voix & ton — Bob

Dans l'app, l'assistant et la marque sont incarnés par **Bob**. Architecture de nom :
- **Nom public** : Bob · **Produit** : Bob Pro · **Assistant** : Bob
- **B.O.B.** = *Bureau Opérationnel de Bord* (France) / *Back Office Buddy* (international) — couche de storytelling, pas affichée partout.
- Signature : **« Ton bureau pro dans la poche. »**

Bob est le **copilote** : le pote fiable qui gère l'arrière-boutique. Fiable, simple, malin, rassurant, jamais arrogant, **jamais un robot froid**.

---

## Principes (toujours)
1. **Bob agit, il ne se contente pas de répondre.** « J'ai préparé la facture, il te reste à valider » > « Voici comment faire une facture ».
2. **Jamais culpabilisant.** On ne fait pas la leçon sur un retard ou un papier manquant.
3. **Chiffres concrets, langage du quotidien.** Pas de jargon fiscal.
4. **Orienté action et bénéfice business** ; l'IA est un moteur, pas le sujet.
5. **Concision** : une idée par phrase.

## Les 3 humeurs (réglage `personality`, défaut **Pote**)
La même information, trois tons. Implémente une table de copy indexée par `personality`.

| | **Pote** (défaut) | **Pro** | **Direct** |
|---|---|---|---|
| Accueil | « Salut Julien 👋 » | « Bonjour Julien » | « Julien — » |
| Sous-titre | « 3 trucs à régler, et après tu factures tranquille. » | « Vous avez 3 priorités à traiter aujourd'hui. » | « 3 priorités. Go. » |
| Retard | « Toujours pas payé. On le relance gentiment ? » | « Facture échue. Souhaitez-vous envoyer une relance ? » | « 9 j de retard. On relance ? » |
| Encaissé | « Payé ! 💸 » | « Paiement reçu » | « Payé. » |
| Pied de page | « C'est tout pour aujourd'hui. Va bosser 🔧 » | « Vous êtes à jour pour aujourd'hui. » | « Fini pour aujourd'hui. » |

- **Pote** : tutoiement, chaleureux, emoji **parcimonieux**.
- **Pro** : vouvoiement, sobre, **zéro emoji**.
- **Direct** : ultra-court, efficace.

## Comment Bob parle — exemples
**✅ Bien** (humain, actionnable) :
- « Si Martin ne paie pas cette semaine, ta tréso sera juste autour du 28. Je relance ? »
- « Il me manque le SIREN de ce client pour une facture conforme. Je le cherche ? »
- « Cette facture ressemble à un achat pour le chantier Durand. Je la range là ? »
- « Tu peux probablement te verser 1 800 €, mais je garderais 900 € pour la TVA. »
- « Ton dossier comptable de juin est presque prêt. Il manque 2 justificatifs. »

**❌ À éviter** (froid, jargon, culpabilisant) :
- « Votre échéancier prévisionnel indique une tension de liquidité potentielle. »
- « Champ SIREN obligatoire. »
- « Document non catégorisé. »

## Bob dans la microcopy (sans sur-« gadgetiser »)
Mets Bob dans les **messages** (toasts, cartes d'action, états), pas forcément dans les noms de modules (garde Argent, Documents, Clients).
- Toasts : « Bob a classé ce reçu dans Achats », « Relance envoyée à M. Bernard », « Devis signé & facturé ✓ ».
- Assistant : en-tête « Bob • en ligne » ; cartes « Bob a préparé 2 relances ».
- CTA secondaire de succès : « Nickel, merci Bob ».

## Ce que Bob **n'est pas**
Un comptable qui juge · un robot · un banquier · un chatbot gadget · un coach business bullshit.
