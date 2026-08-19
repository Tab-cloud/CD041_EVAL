import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig({
  plugins: [react()],
  clearScreen: false,
  build: {
    rollupOptions: {
      output: {
        manualChunks(id) {
          if (!id.includes("node_modules")) return
          if (/[\\/]node_modules[\\/](react|react-dom|scheduler)[\\/]/.test(id)) return "react-vendor"
          if (id.includes("@tauri-apps")) return "tauri-vendor"
          const markdownPackages = [
            "react-markdown", "remark-", "rehype-", "unified", "micromark", "mdast", "hast", "unist",
            "vfile", "property-information", "space-separated-tokens", "comma-separated-tokens",
          ]
          if (markdownPackages.some((name) => id.includes(name))) return "markdown-vendor"
        },
      },
    },
  },
  server: {
    port: 5173,
    strictPort: true,
    watch: { ignored: ["**/src-tauri/**"] },
  },
});
