import { rmSync } from "node:fs";
import { fileURLToPath, URL } from "node:url";
import { resolve as resolvePath } from "node:path";
import react from "@vitejs/plugin-react";
import { defineConfig, type Plugin } from "vite";
import { sites } from "./build/sites-vite-plugin";

function stripServerSecrets(): Plugin {
  return {
    name: "strip-server-secrets",
    apply: "build",
    closeBundle() {
      rmSync(resolvePath("dist/server/.dev.vars"), { force: true });
    },
  };
}

export default defineConfig(async ({ mode }) => {
  process.env.WRANGLER_WRITE_LOGS ??= "false";
  process.env.WRANGLER_LOG_PATH ??= ".wrangler/logs";
  process.env.MINIFLARE_REGISTRY_PATH ??= ".wrangler/registry";
  const deploymentPlugins: Plugin[] = [];
  if (mode !== "test") {
    const { cloudflare } = await import("@cloudflare/vite-plugin");
    deploymentPlugins.push(...cloudflare({ viteEnvironment: { name: "server" } }));
  }

  return {
    plugins: [react(), sites(), ...deploymentPlugins, stripServerSecrets()],
    resolve: { alias: { "@": fileURLToPath(new URL(".", import.meta.url)) } },
    build: { target: "es2022", sourcemap: true },
    base: mode === "github-pages" ? "/financial-management/" : "/",
    server: { port: 5173 },
  };
});
