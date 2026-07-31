/**
 * PORT DE FLOU — même discipline que `PrefsStorage` (voir `theme.tsx`) : `@bob/ui` DÉCRIT la
 * capacité, l'APPLICATION la BRANCHE. `packages/ui` ne dépend d'aucun module Expo, `expo-blur`
 * ne sort jamais d'`apps/mobile`, et le paquet d'interface reste installable et testable sans
 * pont natif.
 *
 * LA SIGNATURE EST CELLE DU CONTRAT, sans un caractère de plus :
 * `RenderBlurLayer = (spec: BlurLayerSpec) => ReactElement | null`. `defineBlurPort` prend une
 * fonction de ce type et rend une fonction de ce même type — la valeur qui traverse la
 * frontière reste un `RenderBlurLayer`, assignable dans les deux sens.
 *
 * CE QUE LE SCEAU AJOUTE, et pourquoi. Le port est du code que `packages/ui` ne contrôle pas.
 * Une fonction nue ne dit rien : elle n'a jamais déclaré qu'elle rend UNE couche et rien
 * d'autre — ni voile, ni dégradé, ni conteneur —, ni qu'elle applique `spec.style` TEL QUEL.
 * `defineBlurPort` est cette déclaration.
 *
 * ─── LE SCEAU N'EST PAS UNE PROPRIÉTÉ, C'EST UNE APPARTENANCE ────────────────────────────
 * Première rédaction de ce fichier : « le sceau est un symbole de MODULE, `Symbol()` et non
 * `Symbol.for()`, donc introuvable dans le registre global, ni exporté, ni falsifiable ».
 * C'ÉTAIT FAUX, et une revue adversariale l'a démontré par TROIS forgeries qui marchaient :
 *
 *   1. `Object.getOwnPropertySymbols(defineBlurPort(() => null))[0]` RESTITUE le symbole.
 *      `defineBlurPort` est exporté : n'importe qui fabrique un port scellé et lit le sceau
 *      dessus. Un symbole non exporté n'est pas un symbole introuvable ;
 *   2. `Object.setPrototypeOf(hostile, portScellé)` — lire `value[SCEAU]` traverse la chaîne
 *      des prototypes. Ce n'est pas une lecture de propriété PROPRE ;
 *   3. `new Proxy(hostile, { get: () => true })` — répond « oui » à tout symbole, et
 *      `typeof proxy === 'function'`.
 *
 * Le registre ci-dessous est insensible aux trois : `WeakSet.has()` compare des IDENTITÉS
 * d'objet, il n'y a plus AUCUNE propriété à lire, à hériter ou à simuler. Un `Proxy` est un
 * objet DIFFÉRENT de la fonction enregistrée, donc il échoue lui aussi — sans que le kit ait
 * eu à deviner qu'il en était un.
 *
 * BÉNÉFICE COLLATÉRAL, et il vaut le premier : `resolveBlurPort` ne LIT plus rien sur un objet
 * fourni par l'application. Un accesseur hostile qui jetait pendant la résolution — donc
 * pendant le RENDU, sans frontière au-dessus — emportait l'écran. Il n'y a plus de lecture.
 *
 * CE QUE LE SCEAU GARANTIT, exactement : que la valeur est SORTIE de `defineBlurPort`. Il ne
 * dit rien du COMPORTEMENT de la fonction enveloppée — c'est une DÉCLARATION d'intention, pas
 * une preuve. Ce que le port rend est vérifié ailleurs, au rendu (`BlurLayerSlot`).
 *
 * Une fonction NON scellée n'est pas une erreur : elle est traitée comme ABSENTE — repli
 * opaque unique, rang normal de l'algorithme — et le développeur reçoit un avertissement
 * NOMMÉ qui lui dit quoi faire. Fail-closed, jamais fail-open, jamais à moitié.
 *
 * L'ÉLÉMENT RENDU EST VÉRIFIÉ, LUI AUSSI (ajout du kit, voir `BlurLayerSlot`) : il doit porter
 * `spec.intensity`, `spec.tint` et `spec.style` TELS QUELS — même valeur, et pour le style la
 * même RÉFÉRENCE, celle de l'objet gelé qu'on lui a remis — et n'avoir AUCUN enfant. Sinon la
 * pile se ferme sur le rang `material-tampered`. Le kit lit `type` et `props` UNE SEULE FOIS et
 * RÉ-ÉMET l'élément à partir de cette lecture : un élément forgé dont `props` est un accesseur
 * ne peut donc plus servir une matière au kit et une autre à React (TOCTOU démontré par une
 * revue, verre système + TEXTE peints).
 *
 * CE QUE CELA NE COUVRE PAS, écrit ici pour que le prochain ne s'y trompe pas : un port peut
 * rendre un composant à LUI qui reçoit correctement les trois champs et peint le verre du
 * système à l'intérieur — même chose via un HOC. Cette classe-là n'est bornée que par le CLIP,
 * le lavis et le voile, c'est-à-dire par la CONFORMITÉ chiffrée dans `bobTintShareAt`, et nulle
 * au bord libre. Aucune vérification de props ne la fermera : il faudrait inspecter des pixels.
 *
 * Adaptateur attendu côté `apps/mobile`, à l'étape d'ADOPTION (décision D08, hors de ce lot) :
 *
 *     import { BlurView } from 'expo-blur';
 *     import { defineBlurPort, type RenderBlurLayer } from '@bob/ui';
 *
 *     const blurTargetRef = useRef<View | null>(null);
 *     const renderBlurLayer = useMemo<RenderBlurLayer>(
 *       () =>
 *         defineBlurPort((spec) => {
 *           if (!canBlurHere) return null;          // tout ou rien : null pour TOUS les index
 *           return (
 *             <BlurView
 *               key={spec.index}
 *               style={spec.style}                  // géométrie de @bob/ui, appliquée telle quelle
 *               intensity={spec.intensity}
 *               tint={spec.tint}
 *               blurTarget={blurTargetRef}          // la ref, capturée — jamais passée à @bob/ui
 *               blurMethod="dimezisBlurViewSdk31Plus"
 *             />
 *           );
 *         }),
 *       [canBlurHere],
 *     );
 *
 * La `ref` ne franchit JAMAIS la frontière de paquet : le port est une CLOSURE créée dans
 * `apps/mobile` qui la capture lexicalement. `@bob/ui` ne la voit pas, ne la type pas, et n'a
 * donc aucune raison d'importer `expo-blur`.
 */
import type { BlurPortStatus } from './progressive-blur-bob.logic';
import type { RenderBlurLayer } from './progressive-blur-bob.types';

/**
 * REGISTRE DES PORTS SCELLÉS — portée MODULE, jamais exporté, jamais énumérable : un `WeakSet`
 * n'a pas d'itérateur, donc il ne dit à personne ce qu'il contient. Faible, donc un port oublié
 * par l'application est collecté avec elle : ce registre ne retient jamais un écran en mémoire.
 */
const SEALED_PORTS = new WeakSet<object>();

/**
 * LA porte d'entrée du port. Rend une fonction de type `RenderBlurLayer` — la signature du
 * contrat, inchangée — INSCRITE au registre du module.
 *
 * On enveloppe plutôt que d'inscrire la fonction reçue : inscrire marquerait un objet étranger,
 * et la valeur rendue doit être celle que le kit reconnaît. Ici, sceller est idempotent — la
 * fonction d'origine reste intacte — et sans effet de bord observable de l'extérieur.
 */
export function defineBlurPort(render: RenderBlurLayer): RenderBlurLayer {
  const sealed: RenderBlurLayer = (spec) => render(spec);
  SEALED_PORTS.add(sealed);
  return sealed;
}

/**
 * Vrai seulement pour une fonction SORTIE de `defineBlurPort`. Aucune lecture de propriété :
 * `WeakSet.prototype.has` est total — il rend `false` pour tout non-objet au lieu de lever — et
 * il compare des identités, donc ni un prototype, ni un `Proxy`, ni un symbole recopié ne
 * peuvent le tromper.
 */
export function isSealedBlurPort(value: unknown): value is RenderBlurLayer {
  return typeof value === 'function' && SEALED_PORTS.has(value);
}

export interface ResolvedBlurPort {
  readonly status: BlurPortStatus;
  /** Défini au seul rang `ready` — la fonction que chaque bande appellera, une fois.  */
  readonly render?: RenderBlurLayer;
}

/**
 * Résout le rang d'un port AVANT le plan. Trois issues et pas de quatrième : scellé
 * (`ready`), fonction non scellée (`unsealed`), tout le reste (`absent`) — `undefined`, un
 * objet bricolé, une valeur héritée d'un autre contrat.
 */
export function resolveBlurPort(port: RenderBlurLayer | undefined): ResolvedBlurPort {
  if (typeof port !== 'function') return { status: 'absent' };
  if (!isSealedBlurPort(port)) return { status: 'unsealed' };
  return { status: 'ready', render: port };
}
