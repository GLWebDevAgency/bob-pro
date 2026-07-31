/**
 * PORT HAPTIQUE — ce que le sceau ferme, et ce qu'il ne ferme pas.
 *
 * Les trois forgeries testées ici ne sont pas théoriques : ce sont exactement celles qui ont
 * traversé la première rédaction du port de flou (revue adversariale). On les rejoue sur le
 * port haptique pour que le même défaut ne renaisse pas dans un second port.
 */
import { describe, expect, it, vi } from 'vitest';
import {
  defineTabHapticPort,
  isSealedTabHapticPort,
  resolveTabHapticPort,
  tickSafely,
  type TabHapticPort,
} from './bob-tab-bar.haptics';

describe('port haptique — absent par défaut, jamais une panne', () => {
  it('un port ABSENT ne tick pas et ne lève pas', () => {
    expect(resolveTabHapticPort(undefined).status).toBe('absent');
    expect(tickSafely({ port: undefined, hapticsEnabled: true })).toBe(false);
  });

  it('un port SCELLÉ tick une fois, avec le rang `selection` de la table haptique', () => {
    const spy = vi.fn();
    const port = defineTabHapticPort(spy);
    expect(resolveTabHapticPort(port).status).toBe('ready');
    expect(tickSafely({ port, hapticsEnabled: true })).toBe(true);
    expect(spy).toHaveBeenCalledTimes(1);
    expect(spy).toHaveBeenCalledWith('selection');
  });

  it('respecte la préférence système : haptique désactivée = aucun appel du tout', () => {
    const spy = vi.fn();
    const port = defineTabHapticPort(spy);
    expect(tickSafely({ port, hapticsEnabled: false })).toBe(false);
    expect(spy).not.toHaveBeenCalled();
  });

  it('un port qui LÈVE ne fait pas tomber l’écran — le geste continue', () => {
    const port = defineTabHapticPort(() => {
      throw new Error('pont natif indisponible');
    });
    expect(() => tickSafely({ port, hapticsEnabled: true })).not.toThrow();
    expect(tickSafely({ port, hapticsEnabled: true })).toBe(false);
  });

  it('n’est PAS branché sur `expo-haptics` : ce fichier n’importe aucune dépendance native', () => {
    // Le comportement 3 est livré SANS installer `expo-haptics` : `UX-ADR-006` est `Proposed`.
    // Le contrôle porte sur le paquet, pas sur l’intention — voir le test d’imports plus bas.
    expect(resolveTabHapticPort(undefined).tick).toBeUndefined();
  });
});

describe('sceau du port — une APPARTENANCE, pas une propriété lisible', () => {
  it('refuse une fonction NON scellée — traitée comme absente, jamais à moitié', () => {
    const nu: TabHapticPort = () => undefined;
    expect(isSealedTabHapticPort(nu)).toBe(false);
    expect(resolveTabHapticPort(nu).status).toBe('unsealed');
    expect(tickSafely({ port: nu, hapticsEnabled: true })).toBe(false);
  });

  it('refuse la forgerie n° 1 : lire le symbole sur un port scellé n’ouvre rien', () => {
    const sealed = defineTabHapticPort(() => undefined);
    // Sur un sceau posé en PROPRIÉTÉ, `getOwnPropertySymbols` restituait la clé. Ici il n’y a
    // aucune propriété : le registre est un `WeakSet`, il compare des identités.
    expect(Object.getOwnPropertySymbols(sealed)).toHaveLength(0);
    const hostile: TabHapticPort = () => undefined;
    expect(isSealedTabHapticPort(hostile)).toBe(false);
  });

  it('refuse la forgerie n° 2 : hériter du prototype d’un port scellé', () => {
    const sealed = defineTabHapticPort(() => undefined);
    const hostile: TabHapticPort = () => undefined;
    Object.setPrototypeOf(hostile, sealed);
    expect(isSealedTabHapticPort(hostile)).toBe(false);
  });

  it('refuse la forgerie n° 3 : un `Proxy` qui répond « oui » à tout', () => {
    const sealed = defineTabHapticPort(() => undefined);
    const proxy = new Proxy(sealed, { get: () => true }) as unknown as TabHapticPort;
    expect(typeof proxy).toBe('function');
    // Un `Proxy` est un objet DIFFÉRENT de la fonction enregistrée : il échoue sans que le kit
    // ait eu à deviner qu’il en était un.
    expect(isSealedTabHapticPort(proxy)).toBe(false);
  });

  it('ne LIT aucune propriété d’une valeur fournie par l’application', () => {
    // Un accesseur hostile qui lève pendant la résolution emporterait l’écran depuis le rendu,
    // au-dessus de toute frontière d’erreur. Il n’y a plus de lecture du tout.
    const hostile = Object.defineProperty(() => undefined, 'anything', {
      get() {
        throw new Error('accesseur hostile');
      },
    }) as unknown as TabHapticPort;
    expect(() => resolveTabHapticPort(hostile)).not.toThrow();
    expect(resolveTabHapticPort(hostile).status).toBe('unsealed');
  });

  it('sceller est idempotent et laisse la fonction d’origine intacte', () => {
    const origine = vi.fn();
    const sealed = defineTabHapticPort(origine);
    expect(isSealedTabHapticPort(origine)).toBe(false);
    expect(isSealedTabHapticPort(sealed)).toBe(true);
    sealed('selection');
    expect(origine).toHaveBeenCalledWith('selection');
  });
});
