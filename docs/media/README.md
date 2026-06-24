# Media assets

This folder holds images used by the project README.

- **`banner.svg`** — the hero banner (committed, used at the top of the README).

## Adding screenshots

The README has a **Screenshots** section with image slots that are commented out.
To enable them, drop PNGs here with these exact names and uncomment the matching
lines in the root `README.md`:

| File                  | Suggested shot                                                        |
| --------------------- | --------------------------------------------------------------------- |
| `screenshot-app.png`  | The full app: toolbar + address bar + live preview + chat panel       |
| `screenshot-select.png` | Element-select mode with a target highlighted + an instruction typed |
| `screenshot-markup.png` | Freeform markup — an ellipse/arrow drawn on the page                |
| `screenshot-diff.png` | A completed edit: chat result + diff + the page hot-reloaded          |

Tips for crisp screenshots:
- Use a real project (e.g. the one you're editing) so it looks alive.
- Capture the window at ~1600×1000 for a sharp 2× retina image.
- Keep the jade accent visible (toolbar, send button) — it's the brand.

## Recording the demo GIF (`demo.gif`)

The single best conversion asset is a ~10-second loop of **one edit**. On macOS:

**Easiest — [Kap](https://getkap.co) (free, open source):**
1. `brew install --cask kap` (or download from getkap.co).
2. Open Kap and drag the capture frame over the Easel window.
3. Record the loop: point at the grey text → type *"make this white"* → Enter →
   the diff streams in → the page hot-reloads. Keep it under ~12 seconds.
4. Stop → **Export → GIF** → save as `docs/media/demo.gif`.

**No install — built-in macOS screen recording:**
1. `Cmd+Shift+5` → record a selected portion of the screen → do the edit → stop.
2. Convert the `.mov` to a GIF with ffmpeg (`brew install ffmpeg`):
   ```bash
   ffmpeg -i screen.mov -vf "fps=12,scale=1280:-1:flags=lanczos" docs/media/demo.gif
   ```

Then enable it in the root `README.md` **Screenshots** section — replace the
banner there with `![Easel demo](docs/media/demo.gif)`.

