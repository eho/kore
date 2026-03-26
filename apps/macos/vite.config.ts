import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { resolve } from "path";

// Output to Kore/Sources/Kore/Resources/ so swift build can bundle it
// When the .app is built via Xcode, the dist/ is copied into the app bundle
export default defineConfig({
  plugins: [react()],
  build: {
    outDir: "dist",
    emptyOutDir: true,
    rollupOptions: {
      input: {
        main: resolve(__dirname, "index.html"),
        settings: resolve(__dirname, "settings.html"),
        onboarding: resolve(__dirname, "onboarding.html"),
      },
    },
  },
  // Base path for assets when loaded from file:// in WKWebView
  base: "./",
});
