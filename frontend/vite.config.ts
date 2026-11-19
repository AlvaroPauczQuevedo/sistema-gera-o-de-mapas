import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import cesium from "vite-plugin-cesium";
import { VitePWA } from "vite-plugin-pwa";

// base relativa: o build funciona em qualquer subcaminho (ex.: GitHub Pages).
export default defineConfig({
  base: "./",
  plugins: [
    react(),
    cesium(),
    // Aplicativo instalável e utilizável sem internet (seção 19). Guarda o app e os dados
    // territoriais já visitados; mapas de fundo e relevo do Cesium ion exigem conexão.
    VitePWA({
      registerType: "autoUpdate",
      manifest: {
        name: "Gêmeos Digitais Regionais", short_name: "Gêmeos Digitais",
        description: "Inteligência geográfica e monitoramento para Defesa Civil",
        lang: "pt-BR", display: "standalone", background_color: "#0b1220", theme_color: "#111a2e",
        start_url: ".", icons: [{ src: "icone.svg", sizes: "any", type: "image/svg+xml", purpose: "any" }],
      },
      workbox: {
        globPatterns: ["**/*.{js,css,html,svg}"],
        maximumFileSizeToCacheInBytes: 8 * 1024 * 1024,
        globIgnores: ["cesium/**"],
        runtimeCaching: [
          { urlPattern: ({ url }) => url.pathname.includes("/cesium/"), handler: "CacheFirst",
            options: { cacheName: "cesium", expiration: { maxEntries: 600 } } },
          // Monitoramento: sempre tenta a rede; sem conexão usa o último salvo (a tela mostra a idade).
          { urlPattern: ({ url }) => url.pathname.endsWith("/monitoramento.json"), handler: "NetworkFirst",
            options: { cacheName: "monitoramento", networkTimeoutSeconds: 8 } },
          { urlPattern: ({ url }) => url.pathname.includes("/data/"), handler: "StaleWhileRevalidate",
            options: { cacheName: "dados-territoriais", expiration: { maxEntries: 200 } } },
          // Mapa de fundo: só o que já foi visto, revalidando (política de uso dos tiles do OSM).
          { urlPattern: ({ url }) => url.hostname.endsWith("tile.openstreetmap.org"), handler: "StaleWhileRevalidate",
            options: { cacheName: "mapa-base", expiration: { maxEntries: 2000, maxAgeSeconds: 7 * 86400 } } },
        ],
      },
    }),
  ],
});
