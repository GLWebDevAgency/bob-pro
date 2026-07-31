/**
 * ProgressiveBlurBob — REVUE ADVERSARIALE. On n'écrit pas ici un port poli : on écrit celui
 * qu'on redoute. Il est SCELLÉ — il a donc franchi la porte —, il jure honorer notre matière,
 * il peint le verre du système avec SA teinte, il tente de sortir de sa bande de −9999 à
 * +9999, il essaie de réécrire ce qu'on lui remet, et il rend n'importe quoi.
 *
 * CE QUE LE KIT DOIT TENIR, quoi qu'il fasse — dit avec sa PORTÉE EXACTE, parce que ce
 * fichier a d'abord promis « aucun verre système ne devient visible », ce qui est FAUX :
 * · un verre système qui RÉÉCRIT la matière ne monte PAS DU TOUT — rang `material-tampered`,
 *   et cela vaut aussi pour un élément FORGÉ dont `props` est un accesseur ;
 * · un verre système qui applique nos trois champs et peint quand même le sien à l'intérieur
 *   de SON composant, lui, monte : il reste CONFINÉ dans sa bande et recouvert de notre lavis
 *   puis de notre voile — sauf AU BORD LIBRE, où le lavis et le voile valent 0 et où sa matière
 *   est donc SEULE (part du port 1,0000 ; table dans `bobTintShareAt`). On ne prétend pas qu'il
 *   est invisible : on dit OÙ il l'est, et combien ;
 * · la matière transmise est GELÉE, et le kit ne relit jamais ce qu'il a transmis ;
 * · aucun nœud rendu par `@bob/ui` ne porte une couleur qui ne vienne pas de nos tokens ;
 * · l'écran ne disparaît jamais — y compris sur des props HORS CONTRAT DE TYPE.
 */
import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import { act, create, type ReactTestRenderer } from 'react-test-renderer';
import { createElement, type ReactElement } from 'react';
import { surfaceVeil } from '@bob/tokens';
import { ThemeProvider } from '../theme';
import { ProgressiveBlurBob, type ProgressiveBlurBobViewProps } from './progressive-blur-bob';
import { defineBlurPort, isSealedBlurPort, resolveBlurPort } from './progressive-blur-bob.port';
import {
  BLUR_PORT_FAILURE_WARNINGS,
  bobTintShareAt,
  resolveBlurMaterial,
  type ProgressiveBlurPlan,
} from './progressive-blur-bob.logic';
import type { BlurLayerSpec, RenderBlurLayer } from './progressive-blur-bob.types';

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const { isReduceMotionEnabled, isReduceTransparencyEnabled } = vi.hoisted(() => ({
  isReduceMotionEnabled: vi.fn<() => Promise<boolean>>(),
  isReduceTransparencyEnabled: vi.fn<() => Promise<boolean>>(),
}));

vi.mock('react-native', () => ({
  AccessibilityInfo: {
    isReduceMotionEnabled: () => isReduceMotionEnabled(),
    isReduceTransparencyEnabled: () => isReduceTransparencyEnabled(),
    addEventListener: () => ({ remove: vi.fn() }),
  },
  View: 'View',
  Text: 'Text',
}));

vi.mock('expo-linear-gradient', () => ({ LinearGradient: 'LinearGradient' }));

/** Le verre du système, avec SA teinte : ce que la doctrine refuse. */
const SystemGlass = 'SystemGlass' as unknown as () => null;
const HOSTILE_TINT = '#FF00FF';
const HEIGHT = 136;

interface RenderedNode {
  readonly type: string;
  readonly props: Record<string, unknown>;
  readonly children: readonly RenderedNode[] | null;
}

function flatten(node: RenderedNode | RenderedNode[] | null): readonly RenderedNode[] {
  if (node === null) return [];
  if (Array.isArray(node)) return node.flatMap((child) => flatten(child));
  return [node, ...flatten((node.children ?? null) as RenderedNode[] | null)];
}

function root(renderer: ReactTestRenderer): RenderedNode {
  return renderer.toJSON() as unknown as RenderedNode;
}

function all(renderer: ReactTestRenderer): readonly RenderedNode[] {
  return flatten(root(renderer));
}

/**
 * Tous les nœuds PRIMITIFS de l'arbre — chaînes et nombres. React les rend en TEXTE, et la
 * retombée n'en porte jamais : « décorative, non interactive, jamais de texte ni d'information ».
 */
function primitiveChildren(renderer: ReactTestRenderer): readonly unknown[] {
  const walk = (node: unknown): readonly unknown[] => {
    if (node === null || node === undefined) return [];
    if (typeof node !== 'object') return [node];
    if (Array.isArray(node)) return node.flatMap(walk);
    return ((node as RenderedNode).children ?? []).flatMap(walk);
  };
  return walk(root(renderer));
}

type Props = Partial<ProgressiveBlurBobViewProps>;
/** Tout est ouvert, assertion d'englobement du § 4 COMPRISE (elle refuse par défaut). */
const OPEN: Props = { renderCapability: 'capable', surfaceUnder: 'static', devShellHeight: 800 };

async function mount(props: Props): Promise<ReactTestRenderer> {
  let renderer!: ReactTestRenderer;
  await act(async () => {
    renderer = create(
      <ThemeProvider>
        <ProgressiveBlurBob anchor="bottom" height={HEIGHT} {...OPEN} {...props} />
      </ThemeProvider>,
    );
  });
  return renderer;
}

let warn: ReturnType<typeof vi.spyOn>;
let error: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  isReduceMotionEnabled.mockResolvedValue(false);
  isReduceTransparencyEnabled.mockResolvedValue(false);
  warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
  error = vi.spyOn(console, 'error').mockImplementation(() => undefined);
});

afterEach(() => {
  warn.mockRestore();
  error.mockRestore();
  vi.clearAllMocks();
});

/**
 * Port CONFORME AUX CHAMPS : il applique `intensity`, `tint` et `style` tels qu'on les lui
 * remet — c'est la forme de l'adaptateur documenté — mais son composant peint quand même ce
 * qu'il veut à l'intérieur. C'est la SEULE forme de matériau hostile qui reste possible après
 * la vérification de matière, et c'est donc elle qu'il faut confiner et recouvrir.
 */
function conformantGlass(): ReturnType<typeof defineBlurPort> {
  return defineBlurPort((spec: BlurLayerSpec) => (
    <SystemGlass
      key={spec.index}
      {...{ style: spec.style, intensity: spec.intensity, tint: spec.tint }}
    />
  ));
}

describe('LA MATIÈRE RÉÉCRITE NE PASSE PAS LA PORTE', () => {
  /**
   * L'ENVAHISSEUR DE LA REVUE : scellé, donc admis à la porte du sceau — mais il impose SA
   * teinte, SON intensité et SA géométrie. Il rendait autrefois ses N échantillons, confinés et
   * recouverts ; à la profondeur 0, où le lavis vaut encore 0, sa matière était SEULE (part du
   * port mesurée : 1,0000). Le lavis ne pouvait pas le fermer — il ne le peut toujours pas.
   * Ce qui le ferme est une vérification, pas une composition.
   */
  const invader = defineBlurPort((spec: BlurLayerSpec) => (
    <SystemGlass
      key={spec.index}
      {...{
        tint: HOSTILE_TINT,
        intensity: 100,
        style: { position: 'absolute', top: -9999, left: -9999, right: -9999, height: 99999 },
      }}
    />
  ));

  it('AUCUN de ses échantillons n’est monté : la pile se ferme sur `material-tampered`', async () => {
    const renderer = await mount({ layers: 10, renderBlurLayer: invader });
    expect(all(renderer).filter((node) => node.type === 'SystemGlass')).toHaveLength(0);
    expect(renderer.toJSON()).not.toBeNull();
    expect(warn.mock.calls.map((call) => String(call[0]))).toContain(
      BLUR_PORT_FAILURE_WARNINGS['material-tampered'],
    );
  });

  it('il suffit de réécrire UN SEUL des trois champs pour être refusé', async () => {
    const material = resolveBlurMaterial('canvas', 'light');
    const variants: readonly (readonly [string, (spec: BlurLayerSpec) => Record<string, unknown>])[] = [
      ['teinte réécrite', (spec) => ({ style: spec.style, intensity: spec.intensity, tint: HOSTILE_TINT })],
      ['intensité réécrite', (spec) => ({ style: spec.style, intensity: 100, tint: spec.tint })],
      // Même géométrie, mais RECOPIÉE : le contrat dit « tel quel », donc l'identité compte —
      // une copie est le point d'entrée de toutes les déformations ultérieures.
      ['style recopié', (spec) => ({ style: { ...(spec.style as object) }, intensity: spec.intensity, tint: spec.tint })],
      ['champ omis', (spec) => ({ style: spec.style, tint: spec.tint })],
      // « Une couche, et rien d'autre » : un enfant, c'est un conteneur — et du texte possible.
      ['enfant ajouté', (spec) => ({ style: spec.style, intensity: spec.intensity, tint: spec.tint, children: 'x' })],
    ];
    for (const [label, props] of variants) {
      const port = defineBlurPort((spec: BlurLayerSpec) => <SystemGlass key={spec.index} {...props(spec)} />);
      const renderer = await mount({ layers: 3, renderBlurLayer: port });
      expect(all(renderer).filter((n) => n.type === 'SystemGlass'), label).toHaveLength(0);
      expect(primitiveChildren(renderer), label).toEqual([]);
      expect(renderer.toJSON(), label).not.toBeNull();
    }
    expect(material.washOpacity).toBe(0.3); // la matière du kit n'a pas bougé pour autant
  });
});

describe('LE VERRE CONFORME RESTE CONFINÉ ET RECOUVERT', () => {
  const invader = conformantGlass();

  it('son verre vit DANS une bande clippée, jamais en enfant direct de l’enveloppe', async () => {
    const renderer = await mount({ layers: 3, renderBlurLayer: invader });
    const bands = (root(renderer).children ?? []).slice(0, 3);

    // Aucun nœud du port n'est un enfant direct de l'enveloppe : il est toujours DANS une bande.
    for (const child of root(renderer).children ?? []) {
      expect(child.type === 'SystemGlass').toBe(false);
    }
    for (const band of bands) {
      expect((band.props['style'] as Record<string, unknown>)['overflow']).toBe('hidden');
      expect((band.children ?? [])[0]?.type).toBe('SystemGlass');
    }
  });

  it('NOTRE lavis est composé APRÈS son verre, dans sa propre bande', async () => {
    const renderer = await mount({ layers: 3, renderBlurLayer: invader });
    const material = resolveBlurMaterial('canvas', 'light');

    for (const band of (root(renderer).children ?? []).slice(0, 3)) {
      const inner = band.children ?? [];
      const glassAt = inner.findIndex((node) => node.type === 'SystemGlass');
      const washAt = inner.findIndex((node) => node.type === 'LinearGradient');
      expect(glassAt).toBeGreaterThanOrEqual(0);
      // Déclaré APRÈS ⇒ peint AU-DESSUS. C'est la seule autorité, et elle joue pour nous.
      expect(washAt).toBeGreaterThan(glassAt);
      expect(inner[washAt]?.props['colors']).toEqual([material.tintTransparent, material.tintSolid]);
    }
  });

  it('et NOTRE voile est peint par-dessus TOUT — dernier déclaré de l’enveloppe', async () => {
    const renderer = await mount({ layers: 3, renderBlurLayer: invader });
    const children = root(renderer).children ?? [];
    const last = children[children.length - 1];
    expect(last?.type).toBe('LinearGradient');
    expect(last?.props['colors']).toEqual(surfaceVeil.light.canvas.stops);
  });

  it('AUCUNE couleur rendue par @bob/ui ne vient du port — toutes sortent de surfaceVeil', async () => {
    const renderer = await mount({ layers: 4, renderBlurLayer: invader });
    const ours = new Set<string>([
      ...surfaceVeil.light.canvas.stops,
      resolveBlurMaterial('canvas', 'light').tintTransparent,
      resolveBlurMaterial('canvas', 'light').tintSolid,
    ]);

    for (const node of all(renderer).filter((n) => n.type === 'LinearGradient')) {
      for (const color of node.props['colors'] as string[]) {
        expect(ours.has(color), `couleur étrangère rendue par le kit : ${color}`).toBe(true);
        expect(color).not.toBe(HOSTILE_TINT);
      }
    }
  });
});

describe('LA MATIÈRE TRANSMISE EST GELÉE', () => {
  it('un port qui tente de la réécrire échoue — et n’emporte pas l’écran pour autant', async () => {
    const thief = defineBlurPort((spec) => {
      // Tentative d'imposer sa teinte en écrivant dans ce qu'on lui remet.
      (spec as unknown as { tint: string }).tint = 'dark';
      return null;
    });

    const renderer = await mount({ layers: 3, renderBlurLayer: thief });

    // En module ESM (mode strict), écrire dans un objet gelé LÈVE : le kit l'attrape.
    expect(renderer.toJSON()).not.toBeNull();
    expect(all(renderer).filter((node) => node.type === 'SystemGlass')).toHaveLength(0);
    expect(warn.mock.calls.map((call) => String(call[0]))).toContain(
      BLUR_PORT_FAILURE_WARNINGS['factory-threw'],
    );
  });

  it('le style résolu est gelé lui aussi : la géométrie ne se renégocie pas', async () => {
    const specs: BlurLayerSpec[] = [];
    await mount({
      layers: 2,
      renderBlurLayer: defineBlurPort((spec) => {
        specs.push(spec);
        return null;
      }),
    });
    for (const spec of specs) {
      expect(Object.isFrozen(spec)).toBe(true);
      expect(Object.isFrozen(spec.style)).toBe(true);
    }
  });
});

/**
 * LE SCEAU — les QUATRE forgeries, dont les TROIS qui marchaient.
 *
 * Le fichier affirmait « `Symbol()` et non `Symbol.for()`, donc introuvable dans le registre
 * global, ni exporté, ni falsifiable ». La revue adversariale n'a eu aucun mal : le seul essai
 * que le test livré tentait était `Symbol.for` — précisément la forgerie qui ne pouvait PAS
 * marcher. Les trois autres passaient. Elles sont toutes rejouées ici, et elles échouent toutes
 * pour la MÊME raison : il n'y a plus de propriété à lire, seulement une appartenance à un
 * `WeakSet` de module, qui compare des identités d'objet.
 */
describe('LE SCEAU — les quatre forgeries de la revue, toutes fermées', () => {
  it('#0 · symbole GLOBAL homonyme (`Symbol.for`) — la seule qui ne marchait déjà pas', () => {
    const forged = Object.assign((_spec: BlurLayerSpec) => null, {
      seal: Symbol('@bob/ui:renderBlurLayer'),
      [Symbol.for('@bob/ui:renderBlurLayer')]: true,
    });
    expect(isSealedBlurPort(forged)).toBe(false);
    expect(resolveBlurPort(forged as unknown as RenderBlurLayer).status).toBe('unsealed');
  });

  it('#1 · `Object.getOwnPropertySymbols` sur un port légitime ne livre plus RIEN', () => {
    const legit = defineBlurPort(() => null);
    // `defineBlurPort` est exporté : n'importe qui peut fabriquer un port scellé. Ce qu'il ne
    // peut plus faire, c'est LIRE le sceau dessus pour le recopier ailleurs.
    expect(Object.getOwnPropertySymbols(legit)).toEqual([]);
    expect(Object.getOwnPropertyNames(legit).filter((name) => name !== 'length' && name !== 'name')).toEqual([]);
  });

  it('#2 · héritage PROTOTYPAL depuis un port légitime — refusé', async () => {
    const legit = defineBlurPort(() => null);
    const evil = ((spec: BlurLayerSpec) => <SystemGlass key={spec.index} />) as RenderBlurLayer;
    Object.setPrototypeOf(evil, legit);
    expect(isSealedBlurPort(evil)).toBe(false);
    expect(resolveBlurPort(evil).status).toBe('unsealed');
    const renderer = await mount({ layers: 3, renderBlurLayer: evil });
    expect(all(renderer).filter((node) => node.type === 'SystemGlass')).toHaveLength(0);
  });

  it('#3 · `Proxy` qui répond « oui » à toute propriété symbole — refusé', async () => {
    const evil = new Proxy(
      ((spec: BlurLayerSpec) => <SystemGlass key={spec.index} />) as RenderBlurLayer,
      { get: (t, p, r) => (typeof p === 'symbol' ? true : Reflect.get(t, p, r)) },
    );
    expect(typeof evil, 'un Proxy de fonction EST une fonction').toBe('function');
    expect(isSealedBlurPort(evil)).toBe(false);
    const renderer = await mount({ layers: 3, renderBlurLayer: evil });
    expect(all(renderer).filter((node) => node.type === 'SystemGlass')).toHaveLength(0);
  });

  it('#3 bis · un `Proxy` qui ENVELOPPE un port légitime est refusé lui aussi', () => {
    const legit = defineBlurPort(() => null);
    // L'identité est celle du proxy, pas celle de la fonction inscrite : `WeakSet.has` dit non
    // sans avoir eu besoin de deviner qu'il s'agissait d'un proxy.
    expect(isSealedBlurPort(new Proxy(legit, {}))).toBe(false);
  });

  it('un accesseur hostile ne peut plus lever pendant le rendu : plus rien n’est LU', async () => {
    const evil = new Proxy(((spec: BlurLayerSpec) => <SystemGlass key={spec.index} />) as RenderBlurLayer, {
      get: () => {
        throw new Error('trap hostile');
      },
    });
    // Avant : `resolveBlurPort` lisait une propriété sur cet objet PENDANT le rendu, dans un
    // `useMemo`, sans frontière au-dessus — l'écran tombait. Il n'y a plus de lecture du tout.
    expect(() => resolveBlurPort(evil)).not.toThrow();
    const renderer = await mount({ layers: 2, renderBlurLayer: evil });
    expect(renderer.toJSON(), 'ÉCRAN PERDU sur un accesseur hostile').not.toBeNull();
    expect(all(renderer).filter((node) => node.type === 'SystemGlass')).toHaveLength(0);
  });

  it('rejette tout ce qui n’est pas une fonction, sans jamais lever', () => {
    for (const value of [undefined, null, 0, '', {}, [], true]) {
      expect(resolveBlurPort(value as unknown as RenderBlurLayer).status).toBe('absent');
    }
  });

  it('sceller est idempotent et ne mute jamais la fonction reçue', () => {
    const raw = (_spec: BlurLayerSpec) => null;
    const once = defineBlurPort(raw);
    const twice = defineBlurPort(once);
    expect(isSealedBlurPort(raw)).toBe(false); // la fonction d'origine reste intacte
    expect(isSealedBlurPort(once)).toBe(true);
    expect(isSealedBlurPort(twice)).toBe(true);
  });
});

describe('LA RETOMBÉE NE PORTE JAMAIS DE TEXTE', () => {
  it('un port qui rend une CHAÎNE est refusé — pas de texte dans la zone décorative', async () => {
    const talker = defineBlurPort(
      (() => 'un texte que personne ne doit lire ici') as unknown as RenderBlurLayer,
    );

    const renderer = await mount({ layers: 2, renderBlurLayer: talker });

    const json = JSON.stringify(renderer.toJSON());
    expect(json).not.toMatch(/un texte que personne/);
    expect(warn.mock.calls.map((call) => String(call[0]))).toContain(
      BLUR_PORT_FAILURE_WARNINGS['invalid-element'],
    );
    expect(renderer.toJSON()).not.toBeNull();
  });

  it('un port qui rend un NOMBRE est refusé de la même façon', async () => {
    const counter = defineBlurPort((() => 42) as unknown as RenderBlurLayer);
    const renderer = await mount({ layers: 2, renderBlurLayer: counter });

    // La preuve n'est pas l'absence de la chaîne « 42 » — `rgba(239,242,247,0)` la contient —
    // mais l'absence de tout NŒUD PRIMITIF : un nombre rendu par React est un nœud de texte.
    expect(primitiveChildren(renderer)).toEqual([]);
    expect(renderer.toJSON()).not.toBeNull();
    expect(warn.mock.calls.map((call) => String(call[0]))).toContain(
      BLUR_PORT_FAILURE_WARNINGS['invalid-element'],
    );
  });

  /**
   * LE FRAGMENT — le trou que `isValidElement()` laissait ouvert, et la revue l'a franchi.
   * `isValidElement(<></>)` rend TRUE, et un Fragment porte n'importe quoi : le texte traversait
   * le garde et React le peignait. Preuve exécutée par la revue : `["texte-interdit-0",
   * "texte-interdit-1"]` peints dans une zone que le contrat déclare sans texte.
   */
  it('un FRAGMENT porteur de texte est refusé — isValidElement ne suffisait pas', async () => {
    const talker = defineBlurPort(
      ((spec: BlurLayerSpec) => <>{`texte-interdit-${String(spec.index)}`}</>) as unknown as RenderBlurLayer,
    );
    const renderer = await mount({ layers: 2, renderBlurLayer: talker });
    expect(primitiveChildren(renderer), 'du TEXTE a été peint dans la zone décorative').toEqual([]);
    expect(JSON.stringify(renderer.toJSON())).not.toMatch(/texte-interdit/);
    expect(warn.mock.calls.map((call) => String(call[0]))).toContain(
      BLUR_PORT_FAILURE_WARNINGS['invalid-element'],
    );
  });

  it('un FRAGMENT VIDE est refusé lui aussi : une couche n’est pas un passe-plat', async () => {
    const passthrough = defineBlurPort((() => <></>) as unknown as RenderBlurLayer);
    const renderer = await mount({ layers: 2, renderBlurLayer: passthrough });
    expect(renderer.toJSON()).not.toBeNull();
    expect(warn.mock.calls.map((call) => String(call[0]))).toContain(
      BLUR_PORT_FAILURE_WARNINGS['invalid-element'],
    );
  });

  it('un port honnête ne produit lui non plus aucun nœud de texte', async () => {
    expect(primitiveChildren(await mount({ layers: 3, renderBlurLayer: conformantGlass() }))).toEqual([]);
  });
});

/**
 * L'ÉLÉMENT FORGÉ — le trou que la vérification de matière laissait ouvert, et une revue
 * adversariale l'a franchi.
 *
 * `isValidElement()` ne regarde QUE `$$typeof`, et sa valeur est un symbole du registre GLOBAL
 * (`Symbol.for('react.transitional.element')`) : n'importe qui la recopie. Un objet forgé peut
 * donc exposer `props` — ou `type` — comme un ACCESSEUR qui rend la matière conforme à la
 * PREMIÈRE lecture (celle du kit) et la matière hostile à la SECONDE (celle de React). Preuve
 * exécutée avant correctif : verre système `intensity: 100`, `tint: 'dark'`, et
 * `["SOLDE 12 400 €", "SOLDE 12 400 €"]` peints dans une zone déclarée sans texte.
 *
 * Le kit lit désormais `type` et `props` UNE SEULE FOIS, vérifie CETTE lecture, et RÉ-ÉMET
 * l'élément à partir d'elle avec SA matière : l'objet piégé n'atteint jamais React.
 */
describe('L’ÉLÉMENT FORGÉ — une seule lecture, puis ré-émission', () => {
  /** `$$typeof` d'un vrai élément : global, donc recopiable — c'est tout le problème. */
  const ELEMENT_TYPE = (createElement('X' as unknown as () => null, {}) as unknown as {
    $$typeof: symbol;
  }).$$typeof;

  it('un accesseur `props` TOCTOU n’est lu QU’UNE FOIS, et sa matière hostile ne monte pas', async () => {
    let lecturesMax = 0;
    const forger = defineBlurPort((spec: BlurLayerSpec) => {
      let reads = 0;
      return {
        $$typeof: ELEMENT_TYPE,
        type: SystemGlass,
        key: String(spec.index),
        ref: null,
        get props() {
          reads += 1;
          lecturesMax = Math.max(lecturesMax, reads);
          return reads === 1
            ? { intensity: spec.intensity, tint: spec.tint, style: spec.style }
            : {
                intensity: 100,
                tint: HOSTILE_TINT,
                style: { position: 'absolute', top: 0, left: 0, right: 0, height: 9999 },
                children: 'SOLDE 12 400 €',
              };
        },
      } as unknown as ReactElement;
    });

    const renderer = await mount({ layers: 2, renderBlurLayer: forger });

    expect(lecturesMax, 'le kit relit `props` : la matière vérifiée n’est pas celle rendue').toBe(1);
    expect(primitiveChildren(renderer), 'du TEXTE a été peint dans la zone décorative').toEqual([]);
    for (const node of all(renderer).filter((n) => n.type === 'SystemGlass')) {
      expect(node.props['intensity']).toBe(5);
      expect(node.props['tint']).not.toBe(HOSTILE_TINT);
    }
    expect(renderer.toJSON()).not.toBeNull();
  });

  it('un accesseur `type` TOCTOU ne monte pas non plus le second type', async () => {
    const forger = defineBlurPort((spec: BlurLayerSpec) => {
      let reads = 0;
      return {
        $$typeof: ELEMENT_TYPE,
        key: String(spec.index),
        ref: null,
        props: { intensity: spec.intensity, tint: spec.tint, style: spec.style },
        get type() {
          reads += 1;
          return reads === 1 ? SystemGlass : ('TexteHostile' as unknown as () => null);
        },
      } as unknown as ReactElement;
    });

    const renderer = await mount({ layers: 2, renderBlurLayer: forger });
    expect(all(renderer).filter((n) => n.type === 'TexteHostile')).toHaveLength(0);
    expect(renderer.toJSON()).not.toBeNull();
  });

  it('un élément forgé dont `props` est NUL ferme la pile au lieu de lever', async () => {
    const forger = defineBlurPort(
      (spec: BlurLayerSpec) =>
        ({
          $$typeof: ELEMENT_TYPE,
          type: SystemGlass,
          key: String(spec.index),
          ref: null,
          props: null,
        }) as unknown as ReactElement,
    );
    const renderer = await mount({ layers: 2, renderBlurLayer: forger });
    expect(renderer.toJSON()).not.toBeNull();
    expect(all(renderer).filter((n) => n.type === 'SystemGlass')).toHaveLength(0);
  });
});

/**
 * LA LIMITE, MESURÉE PLUTÔT QUE TUE. La vérification de matière contrôle les CHAMPS du contrat,
 * pas les pixels : un port peut rendre un composant à LUI, qui reçoit correctement `intensity`,
 * `tint` et `style` et peint le verre du système à l'intérieur. Ce test ne prétend pas que le
 * kit l'en empêche — il PROUVE ce qui le borne, et où cette borne vaut zéro.
 */
describe('LE MATÉRIAU QUE LA VÉRIFICATION NE PEUT PAS FERMER', () => {
  /** Reçoit la matière, et peint la sienne. C'est LÉGAL au regard des champs. */
  function CalqueMenteur(_props: {
    intensity: number;
    tint: string;
    style: unknown;
  }): ReactElement {
    return <SystemGlass key="menteur" {...{ intensity: 100, tint: HOSTILE_TINT }} />;
  }

  it('il MONTE — et le kit le dit, au lieu de prétendre le contraire', async () => {
    const port = defineBlurPort((spec: BlurLayerSpec) =>
      createElement(CalqueMenteur, {
        key: spec.index,
        intensity: spec.intensity,
        tint: spec.tint,
        style: spec.style,
      }),
    );
    const renderer = await mount({ layers: 3, renderBlurLayer: port });
    const glass = all(renderer).filter((n) => n.type === 'SystemGlass');
    expect(glass, 'la limite a changé : mettre les commentaires à jour').toHaveLength(3);
    expect(glass[0]?.props['tint']).toBe(HOSTILE_TINT);
  });

  it('mais il reste DANS une bande clippée, et sous notre lavis puis notre voile', async () => {
    const port = defineBlurPort((spec: BlurLayerSpec) =>
      createElement(CalqueMenteur, {
        key: spec.index,
        intensity: spec.intensity,
        tint: spec.tint,
        style: spec.style,
      }),
    );
    const renderer = await mount({ layers: 3, renderBlurLayer: port });
    for (const band of (root(renderer).children ?? []).slice(0, 3)) {
      expect((band.props['style'] as Record<string, unknown>)['overflow']).toBe('hidden');
      const inner = band.children ?? [];
      expect(inner.findIndex((n) => n.type === 'LinearGradient')).toBeGreaterThan(
        inner.findIndex((n) => n.type === 'SystemGlass'),
      );
    }
    const children = root(renderer).children ?? [];
    expect(children[children.length - 1]?.type).toBe('LinearGradient');
  });

  it('et sa part vaut EXACTEMENT 1 au bord libre : la borne est chiffrée, pas promise', async () => {
    const plans: ProgressiveBlurPlan[] = [];
    await mount({
      layers: 10,
      renderBlurLayer: conformantGlass(),
      onPlan: (plan) => plans.push(plan),
    });
    const plan = plans.at(-1);
    expect(plan?.mode).toBe('blurred');
    // Le lavis est une RAMPE qui part de zéro, et le voile vaut zéro au bord libre.
    expect(bobTintShareAt(0, plan as ProgressiveBlurPlan)).toBe(0);
    // Notre part redevient majoritaire après la première marche, et totale dès 0,60.
    expect(bobTintShareAt(0.32, plan as ProgressiveBlurPlan)).toBeGreaterThan(0.93);
    expect(bobTintShareAt(0.6, plan as ProgressiveBlurPlan)).toBe(1);
  });
});
