/**
 * PORT HAPTIQUE de la tab bar — MÊME DISCIPLINE QUE LE PORT DE FLOU
 * (`progressive-blur-bob.port.ts`) : `@bob/ui` DÉCRIT la capacité, l'APPLICATION la BRANCHE.
 *
 * POURQUOI UN PORT PLUTÔT QU'UNE DÉPENDANCE. `expo-haptics` est INTROUVABLE dans les douze
 * `package.json` du dépôt, et `UX-ADR-006` est encore `Proposed`. Le socle est explicite : le
 * comportement 3 (« scrubbing au doigt avec ticks haptiques ») se livre SANS installer la
 * dépendance. Un port absent n'est donc pas une panne — c'est le RANG NORMAL de l'algorithme :
 * pas de tick, jamais d'erreur, et le scrub fonctionne à l'identique.
 *
 * LE PORT RESTE DÉBRANCHÉ tant que `UX-ADR-006` n'est pas `Accepted`. C'est écrit ici pour que
 * personne n'aille chercher pourquoi « ça ne vibre pas » : ça ne doit pas vibrer encore.
 *
 * ─── LE SCEAU, ET CE QU'IL GARANTIT EXACTEMENT ────────────────────────────────────────────
 * Un `WeakSet` de portée module, jamais exporté, jamais énumérable. Il compare des IDENTITÉS
 * d'objet : il n'y a AUCUNE propriété à lire, donc ni un prototype bricolé, ni un `Proxy`, ni un
 * symbole recopié ne le trompent — les trois forgeries qui avaient traversé la première
 * rédaction du port de flou. Bénéfice collatéral, et il vaut le premier : la résolution ne LIT
 * plus rien sur un objet fourni par l'application, donc aucun accesseur hostile ne peut lever
 * pendant le rendu.
 *
 * CE QUE LE SCEAU GARANTIT : que la valeur est SORTIE de `defineTabHapticPort`. Il ne dit RIEN
 * du comportement de la fonction enveloppée — c'est une DÉCLARATION d'intention, pas une preuve.
 * Ce qui protège l'écran, c'est que l'appel est toujours enveloppé (`tickSafely`).
 *
 * ─── DEUX RÈGLES QUE LA RÉFÉRENCE N'A PAS ─────────────────────────────────────────────────
 *  · elle garde le tick sous `Platform.OS === 'ios'` (l. 129). C'est un choix de sa lib, pas une
 *    contrainte : notre port est appelé sur LES DEUX OS, et c'est l'implémentation qui décide ;
 *  · elle ne consulte aucune préférence système. Le nôtre reçoit `hapticsEnabled` et se TAIT
 *    quand l'utilisateur a désactivé le retour haptique.
 */

/**
 * Le seul rang de tick de la barre : « Sélection → `selection` » de la table haptique de
 * [03 — Motion](03-motion-interaction-system.md). Rien à inventer, et le type le dit — un port
 * ne peut pas décider de jouer un impact lourd sur un franchissement d'onglet.
 */
export type TabHapticKind = 'selection';

/** Le port : une fonction, rien de plus. Elle ne rend rien et ne doit jamais lever. */
export type TabHapticPort = (kind: TabHapticKind) => void;

export type TabHapticPortStatus = 'absent' | 'unsealed' | 'ready';

const SEALED_HAPTIC_PORTS = new WeakSet<object>();

/**
 * LA porte d'entrée du port. On ENVELOPPE plutôt que d'inscrire la fonction reçue : inscrire
 * marquerait un objet étranger, et la valeur rendue doit être celle que le kit reconnaît.
 * Sceller est idempotent et sans effet de bord observable de l'extérieur.
 */
export function defineTabHapticPort(tick: TabHapticPort): TabHapticPort {
  const sealed: TabHapticPort = (kind) => tick(kind);
  SEALED_HAPTIC_PORTS.add(sealed);
  return sealed;
}

/** Vrai seulement pour une fonction SORTIE de `defineTabHapticPort`. Aucune lecture de propriété. */
export function isSealedTabHapticPort(value: unknown): value is TabHapticPort {
  return typeof value === 'function' && SEALED_HAPTIC_PORTS.has(value);
}

export interface ResolvedTabHapticPort {
  readonly status: TabHapticPortStatus;
  /** Défini au seul rang `ready`. */
  readonly tick?: TabHapticPort;
}

/**
 * Trois issues, pas de quatrième : scellé (`ready`), fonction non scellée (`unsealed`), tout le
 * reste (`absent`). Une fonction non scellée n'est pas une erreur : elle est traitée comme
 * ABSENTE — pas de tick — parce qu'elle n'a jamais déclaré qu'elle ne fait QUE ticker.
 */
export function resolveTabHapticPort(port: TabHapticPort | undefined): ResolvedTabHapticPort {
  if (typeof port !== 'function') return { status: 'absent' };
  if (!isSealedTabHapticPort(port)) return { status: 'unsealed' };
  return { status: 'ready', tick: port };
}

export interface TabHapticGate {
  readonly port: TabHapticPort | undefined;
  /** Préférence SYSTÈME de retour haptique. `false` = on se tait, quoi qu'il arrive. */
  readonly hapticsEnabled: boolean;
}

/**
 * APPEL PROTÉGÉ — le port vient de l'APPLICATION, c'est du code que `packages/ui` ne contrôle
 * pas. Un tick qui lève ne doit JAMAIS remonter : il serait levé depuis un rappel de geste, et
 * ferait tomber l'écran d'un artisan qui est en train de naviguer. Il n'y a rien à retenter et
 * rien à journaliser : un retour tactile manqué ne se rattrape pas.
 *
 * Rend `true` seulement si le tick a réellement été joué — c'est ce que les tests vérifient.
 */
export function tickSafely(gate: TabHapticGate, kind: TabHapticKind = 'selection'): boolean {
  if (!gate.hapticsEnabled) return false;
  const resolved = resolveTabHapticPort(gate.port);
  if (resolved.status !== 'ready' || resolved.tick === undefined) return false;
  try {
    resolved.tick(kind);
    return true;
  } catch {
    // Silencieux DÉLIBÉRÉMENT : un tick raté n'a ni rattrapage, ni message utile à afficher.
    return false;
  }
}
