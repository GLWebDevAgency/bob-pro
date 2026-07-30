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
 * `defineBlurPort` est cette déclaration, et le sceau est un symbole de MODULE : `Symbol()` et
 * non `Symbol.for()`, donc introuvable dans le registre global, ni exporté, ni falsifiable.
 * Personne ne peut fabriquer un port « scellé » sans passer par cette porte.
 *
 * Une fonction NON scellée n'est pas une erreur : elle est traitée comme ABSENTE — repli
 * opaque unique, rang normal de l'algorithme — et le développeur reçoit un avertissement
 * NOMMÉ qui lui dit quoi faire. Fail-closed, jamais fail-open, jamais à moitié.
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
 * SCEAU du kit — symbole de MODULE, ni exporté ni enregistrable. Une propriété homonyme posée
 * de l'extérieur ne peut pas l'égaler : deux `Symbol()` ne sont jamais identiques.
 */
const PORT_SEAL: unique symbol = Symbol('@bob/ui:renderBlurLayer');

/**
 * LA porte d'entrée du port. Rend une fonction de type `RenderBlurLayer` — la signature du
 * contrat, inchangée — portant le sceau en propriété NON énumérable et NON configurable.
 *
 * On enveloppe plutôt que de marquer la fonction reçue : marquer muterait un objet étranger,
 * et un second appel sur la même fonction lèverait sur une propriété non configurable. Ici,
 * sceller est idempotent et sans effet de bord observable.
 */
export function defineBlurPort(render: RenderBlurLayer): RenderBlurLayer {
  const sealed: RenderBlurLayer = (spec) => render(spec);
  Object.defineProperty(sealed, PORT_SEAL, {
    value: true,
    enumerable: false,
    writable: false,
    configurable: false,
  });
  return sealed;
}

/** Vrai seulement pour une fonction passée par `defineBlurPort`. */
export function isSealedBlurPort(value: unknown): value is RenderBlurLayer {
  return (
    typeof value === 'function' && (value as unknown as Record<symbol, unknown>)[PORT_SEAL] === true
  );
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
