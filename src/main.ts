import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { readConfig } from "./config";
import { Store } from "./db/store";
import { demoFetch } from "./demo/apis";
import { seedDemo } from "./demo/seed";
import { Runtime } from "./runtime";
import { createApp } from "./server/app";
import index from "./web/index.html";

const config = readConfig();
if (config.databasePath !== ":memory:") mkdirSync(dirname(config.databasePath), { recursive: true });
const store = new Store(config.databasePath);
if (config.demo) await seedDemo(store);
const runtime = new Runtime(store, config, config.demo ? { fetch: demoFetch } : {});
const handle = createApp(runtime);

const server = Bun.serve({
  port: config.port,
  development: process.env.NODE_ENV !== "production" && { hmr: true, console: true },
  idleTimeout: 0,
  routes: {
    "/api/*": handle,
    "/mcp": handle,
    "/auth/callback": handle,
    "/*": index,
  },
});

runtime.start();
console.log(JSON.stringify({ level: "info", message: "Replyfold is running", url: config.publicUrl, port: server.port, demo: config.demo, model: runtime.ai.active() ? `${runtime.ai.active()!.kind}:${runtime.ai.active()!.model}` : (runtime.envModel?.name ?? "choose one in Settings") }));

for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.on(signal, () => {
    runtime.stop();
    void server.stop().then(() => {
      store.close();
      process.exit(0);
    });
  });
}
