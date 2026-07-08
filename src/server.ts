import cors from "@fastify/cors";
import Fastify from "fastify";

import { parseEnv, type AppConfig } from "./config/env.js";
import { registerRoutes } from "./http/routes.js";

export async function buildApp(overrides: Partial<AppConfig> = {}) {
  const config: AppConfig = {
    ...parseEnv(),
    ...overrides
  };
  if (config.mode === "sepolia") {
    throw new Error("Sepolia writer is not implemented yet");
  }
  const app = Fastify({
    logger: config.logLevel === "silent" ? false : { level: config.logLevel }
  });

  await app.register(cors, { origin: true });
  await registerRoutes(app, config);

  return app;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const config = parseEnv();
  const app = await buildApp(config);
  await app.listen({ host: "0.0.0.0", port: config.port });
}
