export * from "./types.js";
export { memoryStore } from "./memory.js";
export { postgresStore } from "./postgres.js";

import { memoryStore } from "./memory.js";
import { postgresStore } from "./postgres.js";
import type { Store } from "./types.js";

/** Postgres when DATABASE_URL is set (unless JARVIS_STORE=memory); otherwise a JSON-backed memory store. */
export function storeFromEnv(): Store {
  const pick = process.env.JARVIS_STORE ?? (process.env.DATABASE_URL ? "postgres" : "memory");
  if (pick === "postgres") return postgresStore();
  return memoryStore(process.env.JARVIS_DATA_FILE ?? "data/jarvis.json");
}
