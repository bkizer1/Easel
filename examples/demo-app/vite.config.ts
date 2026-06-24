import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// Easel works against any dev server. For pinpoint element→source mapping you can
// also add the (optional) @easel/vite-plugin-inspector plugin here.
export default defineConfig({
  plugins: [react()],
  server: { port: 3000 },
});
