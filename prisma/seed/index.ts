import { PrismaClient } from "@prisma/client";
import bcrypt from "bcryptjs";
import { seedMasterData } from "./master-data";
import { seedSampleData } from "./sample-data";

/**
 * pnpm db:seed             → master data + admin + a small demo set (only if DB has no clients)
 * pnpm db:seed --full      → the larger sample set the automated browser tests use (e2e database)
 * pnpm db:seed --no-sample → master data + admin only (use this for go-live)
 */
const db = new PrismaClient();

async function main() {
  const withSample = !process.argv.includes("--no-sample");
  console.log("→ Master data (settings, departments, sectors, lead sources, services, templates)");
  await seedMasterData(db);

  const email = (process.env.SEED_ADMIN_EMAIL ?? "yogeshwar@rezonest.com").toLowerCase();
  const password = process.env.SEED_ADMIN_PASSWORD ?? "ChangeMe@123";
  let admin = await db.user.findUnique({ where: { email } });
  if (!admin) {
    admin = await db.user.create({
      data: { name: "Yogeshwar", email, passwordHash: await bcrypt.hash(password, 12), role: "ADMIN" },
    });
    console.log(`→ Admin created: ${email}`);
  } else {
    console.log(`→ Admin exists: ${email} (password unchanged)`);
  }

  if (!withSample) return;
  if ((await db.client.count()) > 0) {
    console.log("→ Clients already exist — skipping sample data. Run `pnpm db:wipe-sample` first to reseed.");
    return;
  }
  const profile = process.argv.includes("--full") ? "full" : "demo";
  console.log(profile === "full" ? "→ Full sample data (for automated tests)" : "→ Demo data (4 clients, 4 leads, 4 projects, a few invoices…)");
  await seedSampleData(db, admin.id, profile);
  console.log("✓ Seed complete");
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(() => db.$disconnect());
