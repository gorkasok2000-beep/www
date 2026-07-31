import {PrismaClient} from "@/generated/prisma";

/**
 * В dev-режиме Next пересоздаёт модули на каждом хот-релоаде, поэтому клиент
 * кэшируется на globalThis — иначе SQLite быстро упрётся в лимит подключений.
 */
const globalForPrisma = globalThis as unknown as {prisma?: PrismaClient};

export const db = globalForPrisma.prisma ?? new PrismaClient();

if (process.env.NODE_ENV !== "production") {
  globalForPrisma.prisma = db;
}
