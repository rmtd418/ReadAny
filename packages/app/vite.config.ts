import path from "path";
import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

// @ts-expect-error process is a nodejs global
const host = process.env.TAURI_DEV_HOST;
const foliateJsRoot = path.resolve(__dirname, "../foliate-js");

// https://vite.dev/config/
export default defineConfig(async () => ({
  plugins: [
    {
      name: "readany-local-foliate-js",
      enforce: "pre",
      resolveId(id) {
        if (id === "foliate-js") return foliateJsRoot;
        if (id.startsWith("foliate-js/")) {
          return path.resolve(foliateJsRoot, id.slice("foliate-js/".length));
        }
        return null;
      },
    },
    react(),
    tailwindcss(),
  ],
  worker: {
    format: "es",
  },
  resolve: {
    alias: [
      { find: "@", replacement: path.resolve(__dirname, "./src") },
      {
        find: /^foliate-js\/(.+)$/,
        replacement: `${foliateJsRoot}/$1`,
      },
      { find: "foliate-js", replacement: foliateJsRoot },
      // Map @pdfjs/* to foliate-js vendored pdfjs (v4.7, compatible with foliate-js)
      { find: "@pdfjs", replacement: path.resolve(foliateJsRoot, "vendor/pdfjs") },
    ],
    dedupe: ["i18next", "react-i18next", "react", "react-dom"],
  },
  optimizeDeps: {
    // Exclude foliate-js pdf.js from pre-bundling so that @pdfjs alias works
    exclude: ["foliate-js/pdf.js"],
  },
  clearScreen: false,
  server: {
    port: 1420,
    strictPort: true,
    host: host || false,
    hmr: host
      ? {
          protocol: "ws",
          host,
          port: 1421,
        }
      : undefined,
    watch: {
      ignored: ["**/src-tauri/**"],
    },
  },
}));
