import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import cesium from "vite-plugin-cesium";

// base relativa: o build funciona em qualquer subcaminho (ex.: GitHub Pages).
export default defineConfig({ base: "./", plugins: [react(), cesium()] });
