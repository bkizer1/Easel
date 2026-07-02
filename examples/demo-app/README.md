# Easel demo app — "Nimbus"

A tiny Vite + React landing page to try [Easel](../../README.md) against. It's
deliberately full of things to point at and change.

## Run it

From the repo root:

```bash
cd examples/demo-app
npm install
npm run dev        # serves at http://localhost:3000
```

## Try it in Easel

1. Launch Easel (`npm run dev` from the repo root, or the installed app).
2. In Easel's address bar, type `localhost:3000` and press Enter.
3. Click the folder icon and choose this `examples/demo-app` folder (so the AI can edit its source).
4. Switch to **Select** or **Markup**, point at something, and describe a change:
   - the grey hero subtext → *"make this text white, it's hard to read"*
   - the hero image → *"replace this with a photo of a golden doodle"*
   - the **Get started** button → *"make this green and bigger"*
   - a feature card → *"add a subtle border and round the corners more"*

Watch the edit apply and the page hot-reload. Undo from the toolbar anytime.

## Try State Puppeteer (Easel #17)

Scroll to the **"Manual verification targets"** section at the bottom of the page.
Enable the **State Puppeteer** toggle in Easel's sidebar, then try:

- **Fetch mock** — ask: *"pretend /api/products returns 50 items"*
  The product list currently shows an error (no backend running). The mock intercepts
  `fetch('/api/products')` and returns a JSON array; the list renders each item.

- **State override** — ask: *"show the empty cart state"*
  Easel writes `[]` into the `Cart` component's `items` useState hook (hook index 0).
  The cart collapses to the empty-state view immediately, without a page reload.

### Expected `/api/products` response shape

```json
[
  { "id": 1, "name": "Widget A", "price": 9.99 },
  { "id": 2, "name": "Widget B", "price": 19.99 }
]
```

Each element must have `id` (number or string), `name` (string), and `price` (number).

### Cart state selector

| Property | Value |
|---|---|
| Component display name | `Cart` |
| DOM anchor attribute | `data-easel-component="Cart"` |
| Hook | `useState` — index 0 |
| Value type | `CartItem[]` |
| Empty-state value | `[]` |
