/**
 * PhotoViewer — RENDU HOSTILE reduce-motion (critère de preuve Lot 4 : « visionneuse sans
 * fade (Modal animationType 'none') ») + chrome tokenisé sur photoScrim.
 * Doctrine fail-closed : tant que la préférence n'est PAS résolue, AUCUN fade — le Modal
 * s'ouvre en 'none' dès la première frame. Le chrome (fermer/supprimer) est scrimChrome
 * (blanc plein), le scrim est overlays.photoScrim — plus aucun hex à l'écran.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { act, create, type ReactTestRenderer } from 'react-test-renderer';
import { overlays } from '@bob/tokens';
import { ThemeProvider } from '../theme';
import { PhotoViewer } from './photo-viewer';

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const { isReduceMotionEnabled } = vi.hoisted(() => ({
  isReduceMotionEnabled: vi.fn<() => Promise<boolean>>(),
}));

vi.mock('react-native', () => ({
  AccessibilityInfo: {
    isReduceMotionEnabled: (...args: unknown[]) =>
      (isReduceMotionEnabled as unknown as (...a: unknown[]) => Promise<boolean>)(...args),
    addEventListener: () => ({ remove: vi.fn() }),
  },
  Modal: 'Modal',
  Pressable: 'Pressable',
  Text: 'Text',
  View: 'View',
}));
vi.mock('react-native-svg', () => ({ default: 'Svg', Path: 'Path' }));
vi.mock('react-native-safe-area-context', () => ({
  useSafeAreaInsets: () => ({ top: 59, right: 0, bottom: 34, left: 0 }),
}));

interface RenderOptions {
  readonly onDelete?: () => void;
  readonly deleteAccessibilityLabel?: string;
}

async function renderViewer(options: RenderOptions = {}): Promise<ReactTestRenderer> {
  let renderer!: ReactTestRenderer;
  await act(async () => {
    renderer = create(
      <ThemeProvider>
        <PhotoViewer
          visible
          onRequestClose={() => {}}
          closeAccessibilityLabel="Fermer la photo"
          {...(options.onDelete !== undefined && options.deleteAccessibilityLabel !== undefined
            ? {
                onDelete: options.onDelete,
                deleteAccessibilityLabel: options.deleteAccessibilityLabel,
              }
            : {})}
        >
          {null}
        </PhotoViewer>
      </ThemeProvider>,
    );
  });
  return renderer;
}

function modalOf(renderer: ReactTestRenderer): { animationType?: string } {
  return renderer.root.findByType('Modal' as never).props as { animationType?: string };
}

beforeEach(() => {
  isReduceMotionEnabled.mockReset();
});

describe('PhotoViewer — fade gaté reduce-motion FAIL-CLOSED', () => {
  it("préférence JAMAIS résolue ⇒ animationType 'none' dès la première frame (fail-closed)", async () => {
    isReduceMotionEnabled.mockReturnValue(new Promise<boolean>(() => {}));
    const renderer = await renderViewer();
    expect(modalOf(renderer).animationType).toBe('none');
  });

  it("préférence résolue ACTIVE (réduire les animations) ⇒ 'none'", async () => {
    isReduceMotionEnabled.mockResolvedValue(true);
    const renderer = await renderViewer();
    expect(modalOf(renderer).animationType).toBe('none');
  });

  it("préférence résolue INACTIVE ⇒ 'fade' (le seul cas animé)", async () => {
    isReduceMotionEnabled.mockResolvedValue(false);
    const renderer = await renderViewer();
    expect(modalOf(renderer).animationType).toBe('fade');
  });
});

describe('PhotoViewer — scrim et chrome tokenisés', () => {
  it('scrim = overlays.photoScrim, chrome fermer = overlays.scrimChrome (blanc plein)', async () => {
    isReduceMotionEnabled.mockReturnValue(new Promise<boolean>(() => {}));
    const rendered = JSON.stringify((await renderViewer()).toJSON());
    expect(rendered).toContain(`"backgroundColor":"${overlays.photoScrim}"`);
    expect(rendered).toContain(`"stroke":"${overlays.scrimChrome}"`);
  });

  it('sans onDelete : AUCUN bouton supprimer ; avec onDelete + libellé : bouton 44 pt présent', async () => {
    isReduceMotionEnabled.mockReturnValue(new Promise<boolean>(() => {}));
    const without = JSON.stringify((await renderViewer()).toJSON());
    expect(without).not.toContain('Supprimer la photo');

    const withDelete = JSON.stringify(
      (
        await renderViewer({ onDelete: () => {}, deleteAccessibilityLabel: 'Supprimer la photo' })
      ).toJSON(),
    );
    expect(withDelete).toContain('Supprimer la photo');
    expect(withDelete).toContain('Fermer la photo');
  });
});
