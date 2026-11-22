import { defineConfig } from "vite";
import { cloudflare } from "@cloudflare/vite-plugin";

export default defineConfig({
  plugins: [cloudflare()],
  environments: {
    client: {
      build: {
        rolldownOptions: {
          input: { main: "index.html", ringfall: "ringfall/index.html" },
        },
      },
    },
  },
});
