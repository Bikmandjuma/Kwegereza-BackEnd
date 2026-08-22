import bcrypt from "bcryptjs";
import { PrismaClient } from "@prisma/client";

const prisma = new PrismaClient();

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
      role: "ADMIN",
      status: "ACTIVE",
      permissions: JSON.stringify([
        "student.view",
        "student.approve",
        "student.block",
        "leader.view",
        "leader.create",
      ]),
    },
  });

  const leaderEmail = "leader@kwegereza.rw";
  const leaderHash = await bcrypt.hash("Leader@12345", 12);
  await prisma.user.create({
    data: {
      fullName: "Ustadh Ahmad Mugisha",
      email: leaderEmail,
      passwordHash: leaderHash,
      role: "LEADER",
      status: "ACTIVE",
      permissions: JSON.stringify([
        "student.view",
        "student.approve",
        "classroom.host",
        "analytics.view",
        "ifaida.create",
        "ifaida.update",
        "ifaida.delete",
        "ifaida.publish",
      ]),
    },
  });

  console.log("Seed complete:");
  console.log(`  Admin  -> ${adminEmail} / Admin@12345`);
  console.log(`  Leader -> ${leaderEmail} / Leader@12345`);
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
