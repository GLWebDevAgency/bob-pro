/**
 * CLAVIER — le point du tableau « Ce que la référence ne fait PAS » que le portage avait perdu.
 *
 * LA RÉFÉRENCE N'EN A AUCUNE GESTION : sa barre est en `position: absolute; bottom: 0` et le
 * clavier lui passe dessus (ou sous, selon l'OS et le `windowSoftInputMode`). Le socle, lui,
 * exige un « comportement DÉFINI et TESTÉ » (04 § Ce que la référence ne fait PAS, et
 * § Exigences communes : « clavier, safe area et rotation testés »).
 *
 * LE COMPORTEMENT DÉFINI, ET POURQUOI C'EST CELUI-LÀ. Clavier ouvert → la barre flottante se
 * RETIRE : ni rendue, ni tactile. Deux raisons, aucune esthétique :
 *  · sur Android en `adjustResize`, une barre ancrée au bas de la fenêtre remonte AU-DESSUS du
 *    clavier et vient se poser juste sous le champ de saisie — elle mange la ligne qu'on est en
 *    train d'écrire, et le premier appui « à côté » change d'onglet en pleine frappe ;
 *  · sur iOS elle reste sous le clavier, invisible mais TACTILE au bord : une cible fantôme.
 * Dans les deux cas, la retirer est le seul état sans piège.
 *
 * ON NE DÉMONTE PAS LA BARRE, on la masque. Démonter reprovoquerait la perte des valeurs
 * partagées (position du highlight, progression du repli) et la barre reviendrait « en sautant »
 * à la fermeture du clavier. `display: 'none'` retire la vue du layout ET du dispatch de touche,
 * sans toucher à l'état.
 *
 * LES QUATRE ÉVÉNEMENTS, PAS DEUX. iOS émet `keyboardWillShow`/`keyboardWillHide` (avant
 * l'animation) et Android seulement `keyboardDidShow`/`keyboardDidHide`. S'abonner aux quatre
 * est correct sur les deux OS : sur iOS le `Did` suit le `Will` et redit la même chose.
 */
import { useEffect, useState } from 'react';
import { Keyboard } from 'react-native';

/** `true` tant que le clavier logiciel occupe l'écran. */
export function useKeyboardVisible(): boolean {
  const [visible, setVisible] = useState(false);
  useEffect(() => {
    const shown = (): void => setVisible(true);
    const hidden = (): void => setVisible(false);
    const subscriptions = [
      Keyboard.addListener('keyboardWillShow', shown),
      Keyboard.addListener('keyboardDidShow', shown),
      Keyboard.addListener('keyboardWillHide', hidden),
      Keyboard.addListener('keyboardDidHide', hidden),
    ];
    return () => {
      for (const subscription of subscriptions) subscription.remove();
    };
  }, []);
  return visible;
}
