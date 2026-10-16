import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { readConfig } from "./config";
import { Store } from "./db/store";
import { seedDemo } from "./demo/seed";
import { Runtime } from "./runtime";
import { createApp } from "./server/app";
import index from "./web/index.html";

const config = readConfig();
if (config.databasePath !== ":memory:") mkdirSync(dirname(config.databasePath), { recursive: true });
const store = new Store(config.databasePath);
if (config.demo) await seedDemo(store);
const runtime = new Runtime(store, config);
const handle = createApp(runtime);

const server = Bun.serve({
  port: config.port,
  development: process.env.NODE_ENV !== "production" && { hmr: true, console: true },
  idleTimeout: 0,
  routes: {
    "/api/*": handle,
    "/mcp": handle,
    "/*": index,
  },
});

runtime.start();
console.log(JSON.stringify({ level: "info", message: "Replyfold is running", url: config.publicUrl, port: server.port, demo: config.demo, model: runtime.model.name }));

for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.on(signal, () => {
    runtime.stop();
    void server.stop().then(() => {
      store.close();
      process.exit(0);
    });
  });
}
