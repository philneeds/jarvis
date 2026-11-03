import { drizzle } from "drizzle-orm/postgres-js";
import { migrate } from "drizzle-orm/postgres-js/migrator";
import postgres from "postgres";
import { fileURLToPath } from "node:url";
import path from "node:path";

const url = process.env.DATABASE_URL;
if (!url) {
  console.error("DATABASE_URL is not set");
  process.exit(1);
}
const client = postgres(url, { max: 1, prepare: false });
const db = drizzle(client);
const here = path.dirname(fileURLToPath(import.meta.url));
// Works from src/ (tsx) and from dist/ (node).
const migrationsFolder = path.resolve(here, "..", "..", "drizzle");
await migrate(db, { migrationsFolder });
console.log("migrations applied from", migrationsFolder);
await client.end();
