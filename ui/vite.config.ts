import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig({
  plugins: [react()],
  base: "./",
  build: {
    outDir: "dist",
  },
  worker: {
    // Ensure web workers (monaco-yaml yaml.worker) are bundled as ES modules
    format: "es",
  },
});
