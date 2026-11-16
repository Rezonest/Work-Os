import { execSync } from "node:child_process";
import { e2eDatabaseUrl } from "./e2e-db";

/**
 * Before the browser tests: bring the separate e2e database up to date and refill it with the full
 * sample set, so tests never touch your working data and always start from the same records.
 */
export default function setup() {
  const url = e2eDatabaseUrl();
  if (!/e2e/.test(new URL(url).pathname)) throw new Error("Refusing to reset a database whose name doesn't contain 'e2e'");
  const env = { ...process.env, DATABASE_URL: url };
  const run = (cmd: string) => execSync(cmd, { stdio: "inherit", env });
  run("pnpm exec prisma migrate deploy");
  run("pnpm exec tsx prisma/seed/wipe-sample.ts --yes");
  run("pnpm exec tsx prisma/seed/index.ts --full");
}
