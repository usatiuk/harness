import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig({
  plugins: [react()],
  resolve: { conditions: ["development", "browser", "import", "default"] },
  clearScreen: false,
  server: {
    port: 1420,
    strictPort: true,
    // Tauri watches Rust; Vite must skip locked build/runtime files and test artifacts.
    watch: { ignored: ["**/src-tauri/**", "**/resources/**", "**/test-results/**"] },
  },
});
