import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const mobilePackagePath = fileURLToPath(new URL('../../package.json', import.meta.url));
const rootPackagePath = fileURLToPath(new URL('../../../../package.json', import.meta.url));
const lockPath = fileURLToPath(new URL('../../../../pnpm-lock.yaml', import.meta.url));
const patchPath = fileURLToPath(
  new URL('../../../../patches/react-native-webrtc@124.0.8.patch', import.meta.url),
);
const workflowPath = fileURLToPath(
  new URL('../../../../.github/workflows/bob-live-native.yml', import.meta.url),
);
const installedPackagePath = fileURLToPath(
  new URL('../../../../node_modules/react-native-webrtc/package.json', import.meta.url),
);
const installedAndroidGradlePath = fileURLToPath(
  new URL('../../../../node_modules/react-native-webrtc/android/build.gradle', import.meta.url),
);
const installedPodspecPath = fileURLToPath(
  new URL(
    '../../../../node_modules/react-native-webrtc/react-native-webrtc.podspec',
    import.meta.url,
  ),
);
const installedPeerConnectionPath = fileURLToPath(
  new URL('../../../../node_modules/react-native-webrtc/src/RTCPeerConnection.ts', import.meta.url),
);

const EXPECTED_NPM_INTEGRITY =
  'sha512-uuQxvmk+mvnk5U0tr+1N42sKZqgm41fJrBA+fmCvML9J9P4roSh2So82t5RHAlu/vE9vxu5AKgivAiH61clCBg==';
const EXPECTED_PATCH_HASH = 'bto5gkoj5okhz5vdswwtvslgne';

function source(path: string): string {
  return readFileSync(path, 'utf8');
}

describe('react-native-webrtc dependency baseline', () => {
  it('pins the manifest, installed package and lock to the exact 124.0.8 tarball', () => {
    const mobilePackage = JSON.parse(source(mobilePackagePath)) as {
      dependencies?: Record<string, string>;
    };
    const installedPackage = JSON.parse(source(installedPackagePath)) as { version?: string };
    const lock = source(lockPath);

    expect(mobilePackage.dependencies?.['react-native-webrtc']).toBe('124.0.8');
    expect(installedPackage.version).toBe('124.0.8');
    expect(lock).toContain('react-native-webrtc@124.0.8:');
    expect(lock).toContain(`resolution: {integrity: ${EXPECTED_NPM_INTEGRITY}}`);
    expect(lock).toContain(`hash: ${EXPECTED_PATCH_HASH}`);
    expect(lock).not.toContain('react-native-webrtc@124.0.7');
  });

  it('limits the pnpm patch to the two exact native dependency pins', () => {
    const rootPackage = JSON.parse(source(rootPackagePath)) as {
      pnpm?: { patchedDependencies?: Record<string, string> };
    };
    const patch = source(patchPath);
    const changedLines = patch
      .split('\n')
      .filter((line) => /^[+-]/u.test(line) && !/^(---|\+\+\+)/u.test(line));

    expect(rootPackage.pnpm?.patchedDependencies).toEqual({
      'react-native-webrtc@124.0.8': 'patches/react-native-webrtc@124.0.8.patch',
    });
    expect(patch.match(/^diff --git /gmu)).toHaveLength(2);
    expect(changedLines).toEqual([
      "-    api 'org.jitsi:webrtc:124.+'",
      "+    api 'org.jitsi:webrtc:124.0.0'",
      "-  s.dependency          'JitsiWebRTC', '~> 124.0.0'",
      "+  s.dependency          'JitsiWebRTC', '= 124.0.2'",
    ]);
  });

  it('installs the exact Android and iOS native constraints', () => {
    const android = source(installedAndroidGradlePath);
    const ios = source(installedPodspecPath);

    expect(android).toContain("api 'org.jitsi:webrtc:124.0.0'");
    expect(android).not.toContain("api 'org.jitsi:webrtc:124.+'");
    expect(ios).toContain("s.dependency          'JitsiWebRTC', '= 124.0.2'");
    expect(ios).not.toContain("s.dependency          'JitsiWebRTC', '~> 124.0.0'");
  });

  it('contains the upstream closed-signaling disposal ordering from #1821', () => {
    const peerConnection = source(installedPeerConnectionPath);
    const signalingEvent = peerConnection.indexOf(
      "this.dispatchEvent(new Event('signalingstatechange'))",
    );
    const closedFence = peerConnection.indexOf(
      "if (ev.signalingState === 'closed')",
      signalingEvent,
    );
    const listenerRemoval = peerConnection.indexOf('removeListener(this)', closedFence);
    const nativeDispose = peerConnection.indexOf(
      'WebRTCModule.peerConnectionDispose(this._pcId)',
      listenerRemoval,
    );

    expect(signalingEvent).toBeGreaterThan(-1);
    expect(closedFence).toBeGreaterThan(signalingEvent);
    expect(listenerRemoval).toBeGreaterThan(closedFence);
    expect(nativeDispose).toBeGreaterThan(listenerRemoval);
  });

  it('keeps clean native application builds and dependency checks on every relevant change', () => {
    const workflow = source(workflowPath);

    expect(workflow.match(/- package\.json/gmu)).toHaveLength(2);
    expect(workflow.match(/- patches\/react-native-webrtc@124\.0\.8\.patch/gmu)).toHaveLength(2);
    expect(workflow).toContain(':app:dependencyInsight');
    expect(workflow).toContain('versions == ["124.0.0"]');
    expect(workflow).toContain('expo export');
    expect(workflow).toContain('--platform android');
    expect(workflow).toContain('${RUNNER_TEMP}/bob-live-metro-export');
    expect(workflow).toContain(':app:assembleDebug');
    expect(workflow).toContain('versions == ["124.0.2"]');
    expect(workflow).toContain('-workspace BobPro.xcworkspace');
  });
});
