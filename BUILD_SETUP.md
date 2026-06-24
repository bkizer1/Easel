# Easel Build System Setup

This document describes the build tooling and configuration for Easel.

## Overview

Easel is built with:
- **electron-vite** for bundling Electron main, preload, and renderer processes
- **Vite** for fast dev server and optimized production builds
- **React 18** for the renderer UI
- **TypeScript** (strict mode) across all three contexts
- **Tailwind CSS** for styling
- **electron-builder** for packaging/distribution
- **ESLint + Prettier** for code quality

## Directory Structure

```
/path/to/Easel/
├── src/
│   ├── shared/              # Cross-process type contracts (no runtime code)
│   │   ├── types.ts         # Domain types (Point, BoundingBox, EditRequest, etc.)
│   │   ├── agent.ts         # Agent backend interface contract
│   │   └── ipc.ts           # Typed IPC channel definitions & window.easel API
│   │
│   ├── main/                # Electron main process (Node.js)
│   │   ├── index.ts         # Entry point (app lifecycle, window creation)
│   │   ├── ipc.ts           # IPC handler registration
│   │   ├── window.ts        # BrowserWindow creation, webview setup
│   │   ├── settings.ts      # Settings store, safeStorage integration
│   │   ├── checkpoints.ts   # Git checkpoint management (undo/redo)
│   │   ├── project.ts       # Project detection, dev-server monitoring
│   │   └── agents/          # Agent backend implementations
│   │       ├── index.ts     # Backend registry & factory
│   │       ├── claudeAgentSdk.ts  # Claude Agent SDK implementation
│   │       ├── anthropicApi.ts    # Anthropic Messages API loop
│   │       └── tools.ts     # Shared tools (read_file, edit_file, grep, replace_image)
│   │
│   ├── preload/             # Host preload script (isolated context)
│   │   ├── index.ts         # Exposes window.easel API via contextBridge
│   │   └── webview/
│   │       └── inspector.ts # Guest inspector (injected into <webview>)
│   │
│   └── renderer/            # React UI (browser context)
│       ├── index.html       # HTML entry point
│       ├── main.tsx         # React app entry, mounts to #root
│       ├── App.tsx          # Main component tree
│       ├── store.ts         # Zustand state management
│       ├── components/      # React components
│       │   ├── PreviewPane.tsx
│       │   ├── AnnotationOverlay.tsx
│       │   ├── ElementInspector.tsx
│       │   ├── FreeformCanvas.tsx
│       │   ├── ChatPanel.tsx
│       │   ├── DiffViewer.tsx
│       │   ├── Toolbar.tsx
│       │   ├── SettingsDialog.tsx
│       │   └── VoiceButton.tsx
│       ├── lib/             # Utilities
│       │   ├── selector.ts  # Robust CSS selector generation
│       │   ├── geometry.ts  # BoundingBox, Point calculations
│       │   └── screenshot.ts # Canvas to data-URL conversion
│       └── styles/
│           └── globals.css  # Tailwind directives & globals
│
├── packages/
│   └── vite-plugin-inspector/  # User-installable Vite plugin
│       ├── src/
│       │   └── index.ts        # Plugin implementation (TODO)
│       ├── package.json        # Published to npm as @easel/vite-plugin-inspector
│       ├── tsconfig.json
│       └── README.md           # Installation & usage guide
│
├── docs/
│   ├── REQUIREMENTS.md         # Product specification
│   ├── ARCHITECTURE.md         # System design
│   ├── FILE_MANIFEST.md        # Complete file listing
│   ├── ELEMENT_SOURCE_MAPPING.md # Source mapping strategy
│   ├── ROADMAP.md              # Development plan
│   └── REVIEW_NOTES.md         # Design decisions
│
├── Configuration Files (root)
│   ├── package.json            # Root dependencies, scripts, workspaces, electron-builder config
│   ├── electron.vite.config.ts # Three build targets: main, preload, renderer
│   ├── tsconfig.json           # Root TypeScript config with project references
│   ├── tsconfig.node.json      # Main/preload TypeScript config
│   ├── tsconfig.renderer.json  # Renderer TypeScript config (React + JSX)
│   ├── tailwind.config.ts      # Tailwind theme configuration
│   ├── postcss.config.js       # PostCSS plugin chain
│   ├── .eslintrc.cjs           # ESLint rules (TypeScript + React)
│   ├── .prettierrc             # Code formatter config
│   ├── .editorconfig           # Editor settings (indentation, EOL, etc.)
│   ├── .gitignore              # Git exclusions
│   └── .env.example            # Environment variable template
│
└── Output Directories (generated)
    ├── node_modules/           # Dependencies
    ├── out/                    # electron-vite build output
    │   ├── main/              # Compiled main process
    │   ├── preload/           # Compiled preload script
    │   └── renderer/          # Compiled React app (HTML + JS + CSS)
    ├── dist/                  # electron-builder packages
    └── .turbo/                # Turbo cache (if used)
```

## Scripts

### Development

```bash
# Start dev server with hot-reload
npm run dev

# Type-check without emitting
npm run typecheck

# Watch for TypeScript errors
npm run typecheck:watch

# Lint and fix code style
npm run lint:fix

# Format code with Prettier
npm run format

# Check formatting without changing files
npm run format:check

# Run all pre-commit checks
npm run precommit
```

### Building

```bash
# Build for current platform (after typecheck + lint)
npm run build

# Platform-specific builds
npm run build:mac      # macOS (dmg, zip)
npm run build:win      # Windows (NSIS installer, portable, zip)
npm run build:linux    # Linux (AppImage, deb)

# Build without running electron-builder (just electron-vite)
npm run build:preview
```

## Configuration Details

### package.json

- **name**: `easel` (private monorepo root)
- **type**: `module` (ES modules throughout)
- **workspaces**: Points to `packages/*` (managed by npm)
- **build** section: electron-builder configuration for all platforms
- **dependencies**:
  - `@anthropic-ai/sdk` — Anthropic API client
  - `@anthropic-ai/claude-agent-sdk` — Claude Agent SDK
  - `react`, `react-dom` — UI framework
  - `zustand` — State management
  - `lucide-react` — Icon library
- **devDependencies**: Vite, electron, TypeScript, ESLint, Prettier, etc.

### electron.vite.config.ts

Three separate build targets, each with its own Vite config:

1. **main** (`src/main/index.ts`)
   - Format: CommonJS (for Node.js/Electron)
   - Externals: `electron` (built-in), node modules are bundled
   - Aliases: `@shared`, `@main`

2. **preload** (`src/preload/index.ts`)
   - Format: CommonJS
   - Externals: `electron` (built-in)
   - Aliases: `@shared`, `@preload`

3. **renderer** (`src/renderer/index.html`)
   - Format: ES modules (for browser)
   - Plugins: React JSX plugin, Vite optimizations
   - Aliases: `@shared`, `@renderer`
   - Output: `out/renderer/` (HTML, JS, CSS bundles)

**Webview-Preload Handling**:
- `src/preload/webview/inspector.ts` is built as part of the main bundle.
- At runtime, `src/main/window.ts` loads it and injects it into the `<webview>` guest context via the `preload` attribute.

### TypeScript Configuration

Three separate `tsconfig` files with `references` to enable project-level type-checking:

- **tsconfig.json** (root): Base strict config, defines path aliases
  - References: `tsconfig.node.json`, `tsconfig.renderer.json`
  - Paths: `@shared/*`, `@renderer/*`, `@main/*`, `@preload/*`

- **tsconfig.node.json**: Main + preload context
  - Target: ES2020, module: ESNext
  - Includes: `src/main/**/*`, `src/preload/**/*`, `src/shared/**/*`

- **tsconfig.renderer.json**: Renderer context
  - Target: ES2020, module: ESNext, lib: [ES2020, DOM, DOM.Iterable]
  - JSX: `react-jsx` (automatic, no import React needed)
  - Includes: `src/renderer/**/*`, `src/shared/**/*`

### Tailwind CSS

- **tailwind.config.ts**: Custom theme colors (brand palette), spacing, fonts
- **postcss.config.js**: Tailwind → Autoprefixer pipeline
- **globals.css**: Tailwind directives + custom component classes + scrollbar styles

Content glob: `src/renderer/**/*.{js,ts,jsx,tsx}`

### Code Quality

- **.eslintrc.cjs**: TypeScript strict rules, React hooks rules, Prettier integration
- **.prettierrc**: 2-space indents, single quotes, trailing commas, 100-char line width
- **.editorconfig**: Cross-editor consistency (indent, line endings, trim whitespace)

### electron-builder Configuration

Located in `package.json` under the `"build"` key:

- **App ID**: `com.easel.app`
- **Directories**: output → `dist/`, assets → `assets/`
- **Files**: Include `out/` (built assets), `node_modules/`, `package.json`

**Platform Targets**:

- **macOS** (`build.mac`):
  - Formats: DMG, ZIP
  - Hardened runtime enabled
  - Code signing ready

- **Windows** (`build.win`):
  - Formats: NSIS installer, portable EXE, ZIP
  - NSIS one-click disabled (allow custom install path)
  - Desktop + Start Menu shortcuts

- **Linux** (`build.linux`):
  - Formats: AppImage, DEB
  - Category: Development

### Environment Variables

`.env.example` template:

```bash
ANTHROPIC_API_KEY=sk-ant-...
EASEL_DEFAULT_BACKEND=claude-agent-sdk
EASEL_DEFAULT_MODEL=claude-3-5-sonnet-20241022
EASEL_FEATURE_VOICE_INPUT=true
EASEL_FEATURE_IMAGE_GENERATION=false
EASEL_FEATURE_SHOW_THINKING=true
EASEL_FEATURE_AUTO_CHECKPOINT=true
```

At runtime, the main process reads these from the environment and passes them to the renderer via settings (see `src/main/settings.ts`).

## Build Process

### Cold Build

```bash
npm install          # Install dependencies (workspace-aware)
npm run build        # 1. typecheck
                     # 2. lint
                     # 3. electron-vite build (main, preload, renderer)
                     # 4. electron-builder package
```

Expected output in `dist/`:
- `Easel-*.dmg` (macOS)
- `Easel-*-win.exe` + installer (Windows)
- `Easel-*.AppImage` (Linux)

### Development

```bash
npm run dev          # Watches src/, rebuilds on changes, dev-server at hot-reload port
```

Electron app auto-reloads when:
- Main process changes (reload window)
- Preload changes (reload window)
- Renderer changes (live HMR)

### Type Checking

```bash
npm run typecheck    # tsc --noEmit (checks all three contexts)
npm run typecheck:watch
```

### Linting & Formatting

```bash
npm run lint         # ESLint check (error on warnings)
npm run lint:fix     # Fix auto-fixable issues
npm run format       # Prettier write
npm run format:check # Prettier check
npm run precommit    # Run all quality checks
```

## Dependency Versions (Locked)

All versions are pinned to specific stable releases:

- **Electron**: 32.0.0 (latest stable, auto-updates via `app.whenReady()`)
- **electron-vite**: 2.2.0
- **electron-builder**: 25.1.1
- **React**: 18.3.1
- **TypeScript**: 5.5.4
- **Vite**: 5.3.4
- **Tailwind CSS**: 3.4.7
- **Node**: >= 20.0.0 (for async/await, top-level await)

## Tree-Shaking & Optimization

- Main/preload bundles: External Node/Electron modules (not bundled)
- Renderer bundle:
  - Vite handles automatic code-splitting for large chunks
  - Tailwind purges unused CSS
  - Terser minifies production builds
  - Chunk hashing for long-term cache busting

## Monorepo Workspace

The `packages/` directory contains publishable packages:
- `@easel/vite-plugin-inspector`: Published to npm for users to install in their projects

Each package:
- Has its own `package.json`, `tsconfig.json`, `src/`, `dist/`
- Shares root ESLint/Prettier/TypeScript configs (via `extends` in tsconfig)
- Built independently: `npm run build -w @easel/vite-plugin-inspector`

## Next Steps

After this build setup is complete, the next phase implements:

1. **Main Process** (`src/main/`):
   - Electron app initialization, window lifecycle
   - IPC handler registration
   - Settings store + secrets (safeStorage)
   - Git checkpoint manager
   - Agent backend instantiation

2. **Preload & Webview Inspector** (`src/preload/`):
   - Typed IPC bridge via contextBridge
   - Guest inspector (element hit-testing, selector computation)

3. **Renderer Components** (`src/renderer/`):
   - React component tree
   - Zustand store integration
   - Annotation overlay (Canvas/SVG layer)
   - Chat panel + diff viewer
   - Settings dialog

4. **Agent Backends** (`src/main/agents/`):
   - Claude Agent SDK integration
   - Anthropic Messages API hand-built loop
   - Shared file/grep/image tools

5. **Vite Plugin** (`packages/vite-plugin-inspector/`):
   - AST parsing (Babel)
   - JSX/HTML element instrumentation
   - Source location injection

## References

- [electron-vite Docs](https://electron-vite.org/)
- [Electron Security Best Practices](https://www.electronjs.org/docs/tutorial/security)
- [TypeScript Project References](https://www.typescriptlang.org/docs/handbook/project-references.html)
- [Tailwind CSS](https://tailwindcss.com/)
- [React 18 Docs](https://react.dev/)
