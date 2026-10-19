import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";

export default defineConfig({
  plugins: [react(), tailwindcss()],
  resolve: { conditions: ["development", "browser", "module"] },
  clearScreen: false,
  server: {
    port: 1420,
    strictPort: true,
    // Tauri watches Rust; Vite must skip locked build/runtime files and test artifacts.
    watch: { ignored: ["**/src-tauri/**", "**/resources/**", "**/test-results/**"] },
  },
});
