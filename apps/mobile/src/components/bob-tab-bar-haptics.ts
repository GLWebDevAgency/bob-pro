/**
 * PORT HAPTIQUE — CÔTÉ APPLICATION. Il est DÉBRANCHÉ, et c'est délibéré.
 *
 * `expo-haptics` est introuvable dans les douze `package.json` du dépôt, et `UX-ADR-006` est
 * encore `Proposed`. Le socle interdit de l'installer dans ce lot ; le comportement 3 se livre
 * donc SANS lui, avec un port ABSENT — pas de tick, jamais d'erreur, scrub identique.
 *
 * CE FICHIER EXISTE POUR QUE LE BRANCHEMENT SOIT UNE LIGNE, PAS UNE ENQUÊTE. Le jour où
 * `UX-ADR-006` passe `Accepted` et où `expo-haptics` entre au dépôt, l'adaptateur ci-dessous est
 * décommenté et `tabHapticPort()` rend un port scellé. Rien d'autre ne bouge : ni la barre, ni
 * sa logique, ni ses tests.
 *
 *     import * as Haptics from 'expo-haptics';
 *     import { defineTabHapticPort } from '@bob/ui';
 *
 *     export function tabHapticPort(): TabHapticPort | undefined {
 *       return defineTabHapticPort(() => {
 *         void Haptics.selectionAsync();
 *       });
 *     }
 *
 * DEUX RÈGLES QUE L'ADAPTATEUR DEVRA TENIR, et que la référence ne tient pas :
 *  · PAS DE GARDE `Platform.OS === 'ios'`. La référence garde son tick sous iOS (l. 129) ; c'est
 *    un choix de sa lib, pas une contrainte. Android a `selectionAsync` lui aussi ;
 *  · LA PRÉFÉRENCE SYSTÈME PRIME. Elle se transmet par `hapticsEnabled` à la barre, pas par une
 *    lecture cachée dans le port : le port TICK, il ne décide pas.
 */
import type { TabHapticPort } from '@bob/ui';

/**
 * Rend `undefined` : le port n'est pas branché tant que `UX-ADR-006` n'est pas `Accepted`.
 *
 * Ce n'est pas un `TODO` déguisé — c'est le RANG NORMAL décrit par le socle, et il est testé
 * comme tel : un port absent ne tick pas et ne lève pas.
 */
export function tabHapticPort(): TabHapticPort | undefined {
  return undefined;
}
