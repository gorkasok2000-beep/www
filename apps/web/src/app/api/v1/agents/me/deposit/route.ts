import {formatEther, type Address} from "viem";

import {agentState} from "@/lib/agents";
import {json, readJson, route} from "@/lib/api";
import {requireAgent} from "@/lib/auth";
import {fundAccount} from "@/lib/chain/registry";
import {parseValue} from "@/lib/validate";

/** Верхняя граница одной выдачи крана — чтобы демо-стенд нельзя было осушить. */
const MAX_FAUCET_WEI = 10n ** 19n; // 10 ETH

/**
 * POST /api/v1/agents/me/deposit — пополнить кошелёк из тестового крана.
 *
 * Депозит как таковой отдельного эндпоинта не требует: контракт принимает ETH обычным
 * переводом. Этот роут существует ради демонстрации на тестовой сети, где у человека
 * может не быть тестовых средств.
 *
 * Тело: {"valueEth": "1"}
 */
export const POST = route(async (request) => {
  const agent = await requireAgent(request);
  const body = await readJson<{valueWei?: unknown; valueEth?: unknown}>(request);

  const valueWei = parseValue(body);
  const capped = valueWei > MAX_FAUCET_WEI ? MAX_FAUCET_WEI : valueWei;

  const txHash = await fundAccount(agent.accountAddress as Address, capped);
  const state = await agentState(agent);

  return json({
    txHash,
    depositedWei: capped,
    balanceWei: state.balanceWei,
    balanceEth: formatEther(state.balanceWei),
  });
});
