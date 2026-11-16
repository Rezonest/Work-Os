import fs from "node:fs";

/**
 * The browser tests' own database. Set E2E_DATABASE_URL to choose it; otherwise it's your DATABASE_URL
 * (from the environment or .env) with the database name changed to rezonest_workos_e2e.
 * Create it once, empty: createdb rezonest_workos_e2e
 */
export function e2eDatabaseUrl(): string {
  if (process.env.E2E_DATABASE_URL) return process.env.E2E_DATABASE_URL;
  let base = process.env.DATABASE_URL_APP ?? "";
  if (!base && fs.existsSync(".env")) {
    const line = fs.readFileSync(".env", "utf8").split(/\r?\n/).find((l) => l.startsWith("DATABASE_URL="));
    base = line?.slice("DATABASE_URL=".length).trim().replace(/^"|"$/g, "") ?? "";
  }
  if (!base) base = "postgresql://rezonest:rezonest@localhost:5432/rezonest_workos";
  const url = new URL(base);
  url.pathname = "/rezonest_workos_e2e";
  return url.toString();
}
