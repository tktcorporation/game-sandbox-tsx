import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { cloudflare } from "@cloudflare/vite-plugin";

export default defineConfig({
  plugins: [react(), cloudflare()],
  build: {
    rollupOptions: {
      treeshake: {
        // Kenney tiles are inert images. Marking them side-effect free lets
        // unused `export { default as wizard } from "./wizard.png"` drop.
        moduleSideEffects(id) {
          return !/\/src\/assets\/kenney(?:\.ts|\/.+\.png)/.test(id);
        },
      },
    },
  },
});
