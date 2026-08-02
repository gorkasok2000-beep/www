import {formatEther, type Address} from "viem";

import type {Agent, Invoice} from "@/generated/prisma";

import {AgentError} from "./agent-error";
import {db} from "./db";

/**
 * Счета: платёж, инициированный получателем.
 *
 * Агент видит сумму, адрес и назначение, решает, платить ли, и платит по идентификатору
 * счёта. Идемпотентность здесь получается сама собой: у счёта одна оплата, ключом служит
 * сам его идентификатор, и повторный запрос вернёт первый результат.
 *
 * Счёт — это просьба, а не право списать: платит агент, границы кошелька действуют как
 * обычно. Никакого «списания по счёту» в контракте нет и не предполагается.
 */

const DEFAULT_TTL_SECONDS = 24 * 60 * 60;
const MAX_TTL_SECONDS = 30 * 24 * 60 * 60;

export async function issueInvoice(
  agent: Agent,
  params: {valueWei: bigint; to?: Address; memo?: string; ttlSeconds?: number},
): Promise<Invoice> {
  if (params.valueWei <= 0n) {
    throw new AgentError("Сумма счёта должна быть больше нуля.", 400);
  }

  const ttl = params.ttlSeconds ?? DEFAULT_TTL_SECONDS;
  if (!Number.isFinite(ttl) || ttl <= 0 || ttl > MAX_TTL_SECONDS) {
    throw new AgentError(`Срок жизни счёта: от 1 секунды до ${MAX_TTL_SECONDS} секунд.`, 400);
  }

  return db.invoice.create({
    data: {
      issuerAgentId: agent.id,
      // По умолчанию платить нужно на кошелёк выставившего — самый частый случай.
      to: params.to ?? agent.accountAddress,
      valueWei: params.valueWei.toString(),
      memo: params.memo?.slice(0, 200) || null,
      expiresAt: new Date(Date.now() + ttl * 1000),
    },
  });
}

/**
 * Счёт по идентификатору.
 *
 * Просроченный `OPEN` переводится в `EXPIRED` при первом же чтении: отдельного
 * планировщика в прототипе нет, а показывать истёкший счёт открытым нельзя.
 */
export async function readInvoice(id: string): Promise<Invoice> {
  const invoice = await db.invoice.findUnique({where: {id}});
  if (!invoice) {
    throw new AgentError(`Счёт ${id} не найден.`, 404);
  }

  if (invoice.status === "OPEN" && invoice.expiresAt.getTime() <= Date.now()) {
    return db.invoice.update({where: {id}, data: {status: "EXPIRED"}});
  }

  return invoice;
}

/** Счёт, готовый к оплате. Всё остальное — отказ с внятной причиной. */
export async function requirePayableInvoice(id: string): Promise<Invoice> {
  const invoice = await readInvoice(id);

  switch (invoice.status) {
    case "OPEN":
      return invoice;
    case "PAYING":
      throw new AgentError(`Счёт ${id} уже оплачивается другим платежом.`, 409);
    case "PAID":
      throw new AgentError(`Счёт ${id} уже оплачен.`, 409);
    case "EXPIRED":
      throw new AgentError(`Срок оплаты счёта ${id} истёк.`, 410);
    default:
      throw new AgentError(`Счёт ${id} отменён.`, 409);
  }
}

export async function listInvoices(agent: Agent, limit = 50): Promise<Invoice[]> {
  return db.invoice.findMany({
    where: {issuerAgentId: agent.id},
    orderBy: {createdAt: "desc"},
    take: limit,
  });
}

export function invoiceView(invoice: Invoice) {
  return {
    id: invoice.id,
    status: invoice.status.toLowerCase(),
    to: invoice.to,
    valueWei: invoice.valueWei,
    valueEth: formatEther(BigInt(invoice.valueWei)),
    memo: invoice.memo,
    expiresAt: invoice.expiresAt.toISOString(),
    createdAt: invoice.createdAt.toISOString(),
    paidAt: invoice.paidAt?.toISOString() ?? null,
  };
}
