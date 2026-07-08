import cors from "@fastify/cors";
import Fastify from "fastify";

import { parseEnv, type AppConfig } from "./config/env.js";
import { OfflineEfsWriter } from "./efs/offline-writer.js";
import { createSepoliaEfsWriter } from "./efs/sepolia-writer.js";
import type { EfsWriter } from "./efs/writer.js";
import { registerRoutes } from "./http/routes.js";

export async function buildApp(overrides: Partial<AppConfig> = {}) {
  const config: AppConfig = {
    ...parseEnv(),
    ...overrides
  };
  const writer = createWriter(config);
  const app = Fastify({
    logger: config.logLevel === "silent" ? false : { level: config.logLevel }
  });

  await app.register(cors, { origin: true });
  await registerRoutes(app, config, writer);

  return app;
}

function createWriter(config: AppConfig): EfsWriter {
  if (config.mode === "offline") {
    return new OfflineEfsWriter();
  }
  if (!config.sepolia.ready) {
    throw new Error(`Sepolia writer requires: ${config.sepolia.missing.join(", ")}`);
  }
  assertNoSampleAuthInSepolia(config);
  return createSepoliaEfsWriter(config);
}

function assertNoSampleAuthInSepolia(config: AppConfig): void {
  const parsed = JSON.parse(config.apiKeysJson) as Record<string, unknown>;
  for (const [apiKey, subject] of Object.entries(parsed)) {
    const isCurrentSample = apiKey === "local-scribe-key" || subject === "api-key:local-scribe-agent";
    if (isCurrentSample) {
      throw new Error("Sepolia mode requires deployment API keys; replace the sample API key first");
    }
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const config = parseEnv();
  const app = await buildApp(config);
  await app.listen({ host: "0.0.0.0", port: config.port });
}
