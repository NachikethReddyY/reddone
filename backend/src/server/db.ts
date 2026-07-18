import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "@prisma/client";

import { getRuntimeConfig } from "./env";
import { AppError } from "./errors";

export class DatabaseUnavailableError extends AppError {
  constructor() {
    super("database_unavailable", "The database is unavailable in demo mode", { retryable: false });
    this.name = "DatabaseUnavailableError";
  }
}

const globalDatabase = globalThis as typeof globalThis & {
  __reddonePrisma?: PrismaClient;
};

export function getDb(): PrismaClient {
  const config = getRuntimeConfig();
  if (!config.database) throw new DatabaseUnavailableError();

  if (!globalDatabase.__reddonePrisma) {
    const adapter = new PrismaPg({ connectionString: config.database.url });
    globalDatabase.__reddonePrisma = new PrismaClient({ adapter });
  }

  return globalDatabase.__reddonePrisma;
}

export function tryGetDb(): PrismaClient | null {
  const config = getRuntimeConfig();
  return config.database ? getDb() : null;
}

export async function disconnectDb(): Promise<void> {
  if (!globalDatabase.__reddonePrisma) return;
  await globalDatabase.__reddonePrisma.$disconnect();
  delete globalDatabase.__reddonePrisma;
}
