# @easel/vite-plugin-inspector

A Vite plugin for [Easel](https://github.com/bkizer1/Easel) that instruments JSX/HTML elements with source location metadata.

## Overview

This plugin stamps DOM elements with a `data-easel-source` attribute containing the file path, line number, and column number where the element's opening tag is defined in the source code. This enables Easel's agent to map visual elements back to their source locations with high confidence.

## Installation

```bash
npm install --save-dev @easel/vite-plugin-inspector
```

## Usage

Add the plugin to your `vite.config.ts`:

```typescript
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { easelInspector } from '@easel/vite-plugin-inspector';

export default defineConfig({
  plugins: [
    react(),
    easelInspector(),  // must come after the framework plugin
  ],
});
```

## How It Works

1. The plugin intercepts the Vite build/transform pipeline during development.
2. When it encounters JSX/HTML elements, it:
   - Identifies the opening tag
   - Records the source file, line, and column
   - Injects a `data-easel-source="relativeFile:line:col"` attribute
3. At runtime, Easel's guest inspector (webview-preload) reads these attributes and sends them to the main process.
4. The agent uses them to directly locate the source code to edit, with high confidence.

## Attribute Format

```html
<div data-easel-source="src/components/Hero.tsx:15:2">
  <!-- ... element content ... -->
</div>
```

The format is: `relativeFile:line:col` (all relative to the project root, 1-indexed).

## Fallback

Projects without the plugin installed (or with it disabled) can still use Easel through a **fallback path**: the agent receives a robust CSS selector and visible text snippet, then greps the source to find the element. This is slower but always works. See [`docs/ELEMENT_SOURCE_MAPPING.md`](../../docs/ELEMENT_SOURCE_MAPPING.md) for details.

## Configuration Options

The plugin is automatically dev-only and requires no configuration. It runs exclusively during `vite dev` (when `config.command === 'serve'`) and is completely inactive in production builds.

Optional parameters (rarely needed):

| Option | Type | Default | Purpose |
|--------|------|---------|---------|
| `attributeName` | string | `'data-easel-source'` | Customize the attribute name if it conflicts with your codebase. |
| `debug` | boolean | `false` | Enable console logging of transformed files. |

## Framework Support

- **React** (via JSX): instrumenting `<Component />` and `<div />` tags
- **Vue 3** (via SFC): instrumenting template elements (future)
- **Svelte** (via components): support planned

## Performance Impact

The plugin adds negligible overhead to dev-server startup and hot-reload cycles (only during the transform phase, not at runtime). The injected attributes add a small amount of HTML payload but are stripped in production builds (when `dev: true`).

## Troubleshooting

### Elements don't have `data-easel-source` attributes

1. Confirm the plugin is installed and registered in your `vite.config.ts`.
2. Check that you're in a **development** build (the plugin only instruments dev by default).
3. Hard-reload the browser and check the DOM Inspector.
4. Check the Vite server logs for any plugin errors.

### Attributes point to wrong lines

The plugin records the position of the opening tag. If you have multi-line element declarations, the line number may not be what you expect. File an issue with an example.

## License

MIT

## See Also

- [Easel Documentation: Element Source Mapping](../../docs/ELEMENT_SOURCE_MAPPING.md)
- [react-dev-inspector](https://github.com/zthxxx/react-dev-inspector) (inspiration)
