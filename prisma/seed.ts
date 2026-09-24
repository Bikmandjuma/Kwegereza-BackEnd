import bcrypt from "bcryptjs";
import { PrismaClient } from "@prisma/client";

const prisma = new PrismaClient();

// The ONLY account that exists by default is SUPER_ADMIN every other
// role (LEADER, ADMIN, or any custom role) is meant to be assigned
// explicitly by that super-admin through the admin panel afterward, never
// pre-created here. A seeded LEADER account with a hardcoded permission
// set used to exist alongside this one, which worked against that exact
// model: it gave the impression role assignment was broken or unnecessary,
// since a privileged account already existed that nobody had actually
// assigned through the real flow.
async function main() {
  const adminEmail = "admin@kwegereza.rw";
  const existing = await prisma.user.findUnique({ where: { email: adminEmail } });
  if (existing) {
    console.log("Seed: admin already exists, skipping.");
    return;
  }

  const passwordHash = await bcrypt.hash("Admin@12345", 12);
  await prisma.user.create({
    data: {
      fullName: "Umuyobozi Mukuru",
      email: adminEmail,
      passwordHash,
      role: "SUPER_ADMIN",
      status: "ACTIVE",
      permissions: JSON.stringify([]), // SUPER_ADMIN bypasses permission checks entirely by role see hasPermission()
    },
  });

  console.log("Seed complete:");
  console.log(`  Super-Admin -> ${adminEmail} / Admin@12345`);
  console.log("  Every other account (LEADER, ADMIN, or a custom role) should be assigned from here Inshingano(Roles) in the admin panel not seeded.");
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
