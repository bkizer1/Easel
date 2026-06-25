# Contributing to Easel

Thank you for your interest in contributing to Easel! This guide covers development setup, code standards, testing, and the PR process.

---

## Developer Setup

### Prerequisites

- **Node.js 20+** (verify: `node --version`)
- **npm 10+** (verify: `npm --version`)
- **Git** (verify: `git --version`)
- A code editor (VS Code recommended; includes TypeScript, ESLint plugins)

### Clone & Install

```bash
git clone https://github.com/bkizer1/Easel.git
cd Easel
npm install
```

### Run Development Build

```bash
npm run dev
```

This launches Easel with hot-reload: changes to source files recompile and reload the Electron app automatically.

### Build for Production

```bash
npm run build
```

Outputs to `dist/`. App is signed/packaged per platform.

---

## Code Standards

### TypeScript

- **Strict mode everywhere:** `strict: true` in `tsconfig.json`. No `any` types.
- **Explicit over implicit:** Prefer `| null` to optional chaining; avoid `as` casts without justification.
- **Comments at the why level:** Explain design decisions and non-obvious logic, not what the code literally does.

Example:

```typescript
// Good: explains intent
// We use an internal easel ref to isolate checkpoints from the user's own git branches,
// so undo never interferes with their uncommitted work.
const easelRef = 'refs/easel/checkpoints'

// Avoid: just restates the code
const easelRef = 'refs/easel/checkpoints' // Set easel ref to refs/easel/checkpoints
```

### React Components

- **Functional, hook-based:** No class components.
- **Zustand for state:** All shared state lives in `store.ts` via `useEaselStore()`.
- **Component composition:** Break UI into small, focused components (`PreviewPane`, `Toolbar`, `ChatPanel`, etc.).
- **Props over globals:** Pass data as props; avoid global mutable state.

Example:

```typescript
// Good
function Button({ onClick, disabled, children }: Props) {
  return <button onClick={onClick} disabled={disabled}>{children}</button>
}

// Avoid: side effects in render
function Button({ onClick }: Props) {
  console.log('rendering button')  // ← move to useEffect
  return <button onClick={onClick}>Click</button>
}
```

### Main Process

- **Async/await for I/O:** Use `async`/`await` over callbacks.
- **Validate inbound IPC:** All handlers check payload shapes before acting.
- **Log with AgentLogger:** Don't use `console` in agent code; use the injected logger.
- **Path safety:** All file operations resolved through `ProjectFs` (path sandbox).

### File Organization

```
src/
├── shared/          ← Type contracts only (no runtime logic)
├── main/            ← Node.js code (filesystem, git, IPC handlers, agents)
├── preload/         ← Electron bridge (contextBridge, minimal)
├── renderer/        ← React UI (no Node access)
└── ...
```

**Import boundaries (enforced by ESLint):**
- Renderer ↔ Preload ↔ Main (all typed via shared/)
- Renderer cannot import from main
- Main cannot import from renderer
- preload only imports shared types and electron libs

### Commit Conventions

Use [Conventional Commits](https://www.conventionalcommits.org/):

```
type(scope): subject

body

footer
```

**Types:** `feat`, `fix`, `docs`, `style`, `refactor`, `perf`, `test`, `chore`

**Scopes:** `agent`, `renderer`, `ipc`, `inspector`, `settings`, `checkpoints`, `git`, `vite-plugin`, `architecture`, `deps`

**Examples:**

```
feat(agent): add support for multi-file edits via file-search tool

fix(inspector): handle dynamically inserted elements in element-from-point

docs(architecture): clarify checkpoint ref isolation strategy

chore(deps): bump @anthropic-ai/sdk to 0.10.0
```

---

## Testing (Upcoming)

Testing infrastructure will be added in v1.1. For now:

- **Manual testing:** Spin up `npm run dev`, open a test project, exercise the feature.
- **Linting:** `npm run lint` catches most issues.
- **Type checking:** `npm run typecheck` catches type errors.

### Recommended test scenarios

When adding a feature, manually test:

1. **Happy path:** Normal usage (e.g., select element, type instruction, see edit).
2. **Edge cases:** Empty input, special characters, very long instructions.
3. **Error paths:** Dev server down, invalid API key, malformed response from agent.
4. **Cross-platform:** Test on macOS, Windows, Linux if possible (or use CI).

---

## Project Structure & Key Files

See [FILE_MANIFEST.md](docs/FILE_MANIFEST.md) for the exhaustive breakdown.

**Key areas for contribution:**

- **Agent backends:** `src/main/agents/{claudeAgentSdk,anthropicApi}.ts` — swap/improve backend logic
- **UI components:** `src/renderer/components/` — fix bugs, improve UX
- **IPC contract:** `src/shared/ipc.ts` — add new channels for new features
- **Vite plugin:** `packages/vite-plugin-inspector/src/` — improve element source mapping
- **Documentation:** `docs/` — clarify architecture, fix outdated info

---

## PR Process

### Before You Start

1. Check open issues and PRs to avoid duplicating work.
2. For large features, open an issue first to discuss the design (saves effort later).

### Making a PR

1. **Fork the repo** and create a feature branch:
   ```bash
   git checkout -b feat/your-feature
   ```

2. **Write code** following the standards above.

3. **Test locally:**
   ```bash
   npm run lint          # Fix any lint errors
   npm run typecheck     # Resolve type errors
   npm run dev           # Manual testing
   ```

4. **Commit with conventional messages:**
   ```bash
   git add .
   git commit -m "feat(scope): clear, descriptive message"
   ```

5. **Push and open a PR:**
   ```bash
   git push origin feat/your-feature
   ```

### PR Checklist

- [ ] Code follows standards (TS strict, no `any`, clear comments)
- [ ] Linting passes: `npm run lint`
- [ ] Type checking passes: `npm run typecheck`
- [ ] Manual testing done (describe in PR)
- [ ] Commit messages are conventional
- [ ] Documentation updated (if adding a feature)
- [ ] No breaking changes, or migration plan provided

### PR Review

- Maintainers review for code quality, architecture fit, and correctness.
- Respond to feedback promptly; aim for discussion, not defensiveness.
- Once approved, a maintainer merges the PR.

---

## Architecture & Design

Before making large changes, read:

- **[ARCHITECTURE.md](docs/ARCHITECTURE.md)** — System design, process model, edit pipeline
- **[FILE_MANIFEST.md](docs/FILE_MANIFEST.md)** — Every file's purpose and dependencies
- **[REQUIREMENTS.md](docs/REQUIREMENTS.md)** — Product spec, user stories, constraints

### Adding a Feature

1. **Define the contract:** Add types to `src/shared/types.ts` if needed.
2. **Add IPC channel** in `src/shared/ipc.ts` (if main ↔ renderer communication).
3. **Implement in main** (`src/main/`): handle the IPC channel, filesystem work, etc.
4. **Implement in renderer** (`src/renderer/`): UI, call `window.easel.*`.
5. **Update docs:** Reflect the change in ARCHITECTURE.md, FILE_MANIFEST.md, README.

### Modifying the Agent

Agents implement the `AgentBackend` interface (`src/shared/agent.ts`). To add a tool:

1. Define the tool schema in `src/main/agents/tools.ts`.
2. Implement the handler (uses `ProjectFs` for safety).
3. Both backends (`claudeAgentSdk.ts`, `anthropicApi.ts`) register and dispatch the tool.
4. Update `src/shared/types.ts` `AgentEvent` if new event types are needed.

---

## Performance & Debugging

### Dev Tools

Easel runs as an Electron app with DevTools available:

1. In development mode (`npm run dev`), press **Ctrl+Shift+I** (or Cmd+Option+I on macOS) to open DevTools.
2. Check the Console for errors or logs.
3. Use the Network tab to monitor API calls to Anthropic.

### Profiling

To profile the renderer (React):

1. Open DevTools → **Performance** tab
2. Click **Record**, perform an action, click **Stop**
3. Analyze the flame chart for slow operations

### Agent Debugging

Enable detailed logging in Settings → "Detailed Logging" (post-MVP feature). Logs are written to a file for inspection.

### Breakpoints

In VS Code:

1. Add a `debugger` statement in your code.
2. Launch the debugger (`Debug > Start Debugging`).
3. Reload the app (Ctrl+R).
4. Execution pauses at the breakpoint.

---

## Reporting Issues

If you find a bug or have a feature request:

1. Check [existing issues](https://github.com/bkizer1/Easel/issues) first.
2. Open a new issue with:
   - **Clear title:** e.g., "ElementSelect doesn't work with dynamically added buttons"
   - **Steps to reproduce:** Exact steps to trigger the issue
   - **Expected vs. actual:** What should happen vs. what does happen
   - **Screenshots/video:** If helpful
   - **Environment:** OS (macOS/Windows/Linux), Easel version, Node version

---

## Roadmap & Priorities

See [ROADMAP.md](docs/ROADMAP.md) for the phased delivery plan. Contributions that address high-priority items (MVP scope) are especially welcome.

**Current focus (M3, Q3 2026):** Polish, undo/redo, settings, cross-platform testing, docs, and release prep.

---

## License & Contributor Agreement

Easel is dual-licensed: the **app** under **AGPL-3.0-or-later**, and the
`@easel/vite-plugin-inspector` package under **MIT** — see [LICENSING.md](LICENSING.md).

By contributing, you agree to the [Contributor License Agreement](CLA.md). It's a
lightweight DCO sign-off that keeps copyright consolidated, so Easel can stay open
source **and** be offered under a commercial license. Sign off your commits:

```bash
git commit -s -m "feat(scope): your change"
```

---

## Questions?

- **Slack/Discord:** (to be added)
- **GitHub Discussions:** (to be added)
- **Email:** blake.kizer@gmail.com

Welcome, and happy coding!
