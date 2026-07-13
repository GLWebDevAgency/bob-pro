const { withAndroidManifest } = require('expo/config-plugins');

const LEGACY_BLUETOOTH = new Set([
  'android.permission.BLUETOOTH',
  'android.permission.BLUETOOTH_ADMIN',
]);
const DISALLOWED_BACKGROUND_AUDIO = new Set([
  'android.permission.FOREGROUND_SERVICE_MEDIA_PLAYBACK',
  'android.permission.FOREGROUND_SERVICE_MICROPHONE',
]);

/**
 * Normalise le manifeste après les plugins expo-audio et react-native-webrtc.
 * Android 12+ utilise BLUETOOTH_CONNECT ; les permissions legacy restent uniquement
 * pour les casques Android <= 11. Bob ferme sa conversation au background et ne doit
 * donc déclarer aucun service audio de fond.
 */
module.exports = function withBobAudioPermissions(config) {
  return withAndroidManifest(config, (next) => {
    const manifest = next.modResults.manifest;
    const byName = new Map();
    for (const permission of manifest['uses-permission'] ?? []) {
      const name = permission.$?.['android:name'];
      if (!name || DISALLOWED_BACKGROUND_AUDIO.has(name)) continue;
      const normalized = { ...permission, $: { ...permission.$ } };
      if (LEGACY_BLUETOOTH.has(name)) normalized.$['android:maxSdkVersion'] = '30';
      byName.set(name, normalized);
    }
    manifest['uses-permission'] = [...byName.values()];
    return next;
  });
};

