import type { JarvisActionReleasePolicy } from '@bob/core';

/**
 * Policy permissive des seules preuves : jamais importée par un provider ou un module runtime.
 * Elle rend testable une verticale avant promotion du catalogue et publication du manifeste.
 */
export const TEST_ONLY_JARVIS_ACTION_RELEASE_POLICY: JarvisActionReleasePolicy = Object.freeze({
  isPublished: () => true,
});
