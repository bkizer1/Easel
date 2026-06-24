/**
 * Easel — image provider for the agent's `replace_image` tool.
 *
 * The default provider handles two real modes:
 *   - `fetch`             : download an image from a URL (no key required).
 *   - `generate` / `edit` : call OpenAI Images when an `image-provider` key is
 *      configured in Settings; otherwise return a clear, actionable error.
 *
 * A different provider (Replicate, a local Stable Diffusion server, …) can be
 * swapped in via `registerImageProvider`.
 */

import type { ImageProvider, ImageRequest, ImageResult } from '@shared/types';
import { createLogger } from '@main/logger';

const log = createLogger('image-provider');

const OPENAI_IMAGES_URL = 'https://api.openai.com/v1/images/generations';

function extFromContentType(ct: string): string {
  if (ct.includes('jpeg') || ct.includes('jpg')) return 'jpg';
  if (ct.includes('webp')) return 'webp';
  if (ct.includes('gif')) return 'gif';
  if (ct.includes('svg')) return 'svg';
  return 'png';
}

async function fetchAsDataUrl(url: string): Promise<ImageResult | null> {
  const res = await fetch(url);
  if (!res.ok) return null;
  const ct = res.headers.get('content-type') ?? 'image/png';
  const buf = Buffer.from(await res.arrayBuffer());
  return {
    id: '',
    ok: true,
    imageDataUrl: `data:${ct};base64,${buf.toString('base64')}`,
    extension: extFromContentType(ct),
  };
}

const defaultProvider: ImageProvider = {
  id: 'default',
  name: 'Fetch + OpenAI Images',

  isAvailable(): boolean {
    return true;
  },

  async request(input: ImageRequest): Promise<ImageResult> {
    try {
      // --- fetch mode: pull an existing image by URL (no key needed) ---------
      if (input.mode === 'fetch') {
        if (!input.sourceUrl) return { id: input.id, ok: false, error: 'fetch mode needs a sourceUrl.' };
        const r = await fetchAsDataUrl(input.sourceUrl);
        if (!r) return { id: input.id, ok: false, error: `Could not fetch ${input.sourceUrl}` };
        return { ...r, id: input.id };
      }

      // --- generate / edit: OpenAI Images (requires a configured key) --------
      const { resolveSecrets } = await import('@main/settings');
      const key = resolveSecrets(['image-provider'])['image-provider'];
      if (!key) {
        return {
          id: input.id,
          ok: false,
          error:
            'No image-generation key configured. Add an OpenAI key in Settings → image provider, or ask for an image by URL (fetch mode).',
        };
      }

      const size = input.width && input.height ? `${input.width}x${input.height}` : '1024x1024';

      const res = await fetch(OPENAI_IMAGES_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${key}` },
        body: JSON.stringify({ model: 'gpt-image-1', prompt: input.prompt, size, n: 1 }),
      });

      if (!res.ok) {
        return { id: input.id, ok: false, error: `Image API ${res.status}: ${await res.text()}` };
      }

      const data = (await res.json()) as { data?: Array<{ b64_json?: string; url?: string }> };
      const first = data.data?.[0];
      if (first?.b64_json) {
        return { id: input.id, ok: true, imageDataUrl: `data:image/png;base64,${first.b64_json}`, extension: 'png' };
      }
      if (first?.url) {
        const r = await fetchAsDataUrl(first.url);
        if (r) return { ...r, id: input.id };
      }
      return { id: input.id, ok: false, error: 'Image API returned no image data.' };
    } catch (err) {
      log.error('Image request failed', { mode: input.mode, err: String(err) });
      return { id: input.id, ok: false, error: String(err) };
    }
  },
};

let _active: ImageProvider = defaultProvider;

/** Register a custom image provider (e.g. Replicate or a local SD server). */
export function registerImageProvider(provider: ImageProvider): void {
  log.info('Image provider registered', { id: provider.id, name: provider.name });
  _active = provider;
}

/** Reset to the built-in default (fetch + OpenAI) provider. */
export function resetImageProvider(): void {
  _active = defaultProvider;
}

/** Return the active image provider. */
export function getActiveImageProvider(): ImageProvider {
  return _active;
}
