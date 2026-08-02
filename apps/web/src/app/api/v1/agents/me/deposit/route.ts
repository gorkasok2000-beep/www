import {formatEther, type Address, type Hex} from "viem";

import {AgentError} from "@/lib/agent-error";
import {agentState} from "@/lib/agents";
import {json, readJson, route} from "@/lib/api";
import {requireAgent} from "@/lib/auth";
import {fundAccount} from "@/lib/chain/registry";
import {db} from "@/lib/db";
import {serverEnv} from "@/lib/env";
import {parseValue} from "@/lib/validate";

/** Верхняя граница одной выдачи крана — чтобы демо-стенд нельзя было осушить. */
const MAX_FAUCET_WEI = 10n ** 19n; // 10 ETH

/** Суточный лимит выдачи на одного агента. */
const DAILY_FAUCET_WEI = 30n * 10n ** 18n; // 30 ETH

/**
 * POST /api/v1/agents/me/deposit — пополнить кошелёк из тестового крана.
 *
 * Депозит как таковой отдельного эндпоинта не требует: контракт принимает ETH обычным
 * переводом. Этот роут существует ради демонстрации на тестовой сети, где у человека
 * может не быть тестовых средств.
 *
 * Кран — точка слива кошелька оператора, поэтому у него несколько рубежей: флаг
 * FAUCET_ENABLED, лимит одной выдачи, суточный лимит на агента и несгораемый
 * резерв оператора в `fundAccount`.
 *
 * Тело: {"valueEth": "1"}
 */
export const POST = route(async (request) => {
  if (!serverEnv.faucetEnabled()) {
    throw new AgentError("Тестовый кран отключён (FAUCET_ENABLED=false).", 403);
  }

  const agent = await requireAgent(request);
  const body = await readJson<{valueWei?: unknown; valueEth?: unknown}>(request);

  const valueWei = parseValue(body);
  const capped = valueWei > MAX_FAUCET_WEI ? MAX_FAUCET_WEI : valueWei;

  // Проверка суточного лимита и запись о выдаче — в одной транзакции с writer-lock,
  // иначе два параллельных запроса оба прошли бы проверку (та же гонка, что и с
  // платежами, см. payments.ts).
  const grant = await db.$transaction(async (tx) => {
    await tx.$executeRaw`UPDATE "Agent" SET "id" = "id" WHERE "id" = ${agent.id}`;

    const recent = await tx.faucetGrant.findMany({
      where: {agentId: agent.id, createdAt: {gte: new Date(Date.now() - 24 * 60 * 60 * 1000)}},
    });
    const spent = recent.reduce((sum, entry) => sum + BigInt(entry.valueWei), 0n);
    if (spent + capped > DAILY_FAUCET_WEI) {
      throw new AgentError("Суточный лимит крана для этого агента исчерпан.", 429);
    }
    return tx.faucetGrant.create({data: {agentId: agent.id, valueWei: capped.toString()}});
  });

  let txHash: Hex;
  try {
    txHash = await fundAccount(agent.accountAddress as Address, capped);
  } catch (error) {
    // Выдача не состоялась — лимит возвращаем агенту.
    await db.faucetGrant.delete({where: {id: grant.id}}).catch(() => {});
    throw error;
  }

  const state = await agentState(agent);

  return json({
    txHash,
    depositedWei: capped,
    balanceWei: state.balanceWei,
    balanceEth: formatEther(state.balanceWei),
  });
});
