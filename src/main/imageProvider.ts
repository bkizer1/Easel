/**
 * Easel — ImageProvider registry.
 *
 * A stub `ImageProvider` is registered by default.  A real generation/editing
 * provider (e.g. openai-images) can be registered at runtime if the user has
 * configured an image API key.  The agent's `replace_image` tool calls
 * `getActiveImageProvider().request(...)`.
 *
 * Only the stub is implemented here — the full generation provider lives in
 * `src/main/agents/imageProviders/`.
 */

import type { ImageProvider, ImageRequest, ImageResult } from '@shared/types';
import { createLogger } from '@main/logger';

const log = createLogger('image-provider');

/* -------------------------------------------------------------------------- */
/*  Stub provider (always available)                                           */
/* -------------------------------------------------------------------------- */

const stubProvider: ImageProvider = {
  id: 'stub',
  name: 'Stub (placeholder)',

  isAvailable(): boolean {
    return true;
  },

  async request(input: ImageRequest): Promise<ImageResult> {
    log.info('Stub image provider called — returning placeholder', {
      mode: input.mode,
      prompt: input.prompt.slice(0, 80),
    });
    // Return a 1×1 transparent PNG data URL as a harmless placeholder.
    return {
      id: input.id,
      ok: false,
      error: 'Image generation is not configured. Enable it in Settings and provide an API key.',
    };
  },
};

/* -------------------------------------------------------------------------- */
/*  Registry                                                                   */
/* -------------------------------------------------------------------------- */

let _active: ImageProvider = stubProvider;

/** Register an image provider (called when the user enables image generation). */
export function registerImageProvider(provider: ImageProvider): void {
  log.info('Image provider registered', { id: provider.id, name: provider.name });
  _active = provider;
}

/** Reset to the stub (called when the user disables image generation). */
export function resetImageProvider(): void {
  _active = stubProvider;
}

/** Return the currently active image provider. */
export function getActiveImageProvider(): ImageProvider {
  return _active;
}
