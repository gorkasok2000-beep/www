import {formatEther} from "viem";

import {agentState} from "@/lib/agents";
import {json, route} from "@/lib/api";
import {requireAgent} from "@/lib/auth";

/**
 * GET /api/v1/agents/me — состояние собственного кошелька: баланс, режим,
 * правила и статус заморозки. Всё читается из контракта, не из базы.
 */
export const GET = route(async (request) => {
  const agent = await requireAgent(request);
  const state = await agentState(agent);

  return json({
    handle: agent.handle,
    mode: agent.mode,
    account: agent.accountAddress,
    owner: agent.ownerAddress,
    custodian: agent.custodianAddress,
    frozen: state.frozen,
    balanceWei: state.balanceWei,
    balanceEth: formatEther(state.balanceWei),
    gasDepositWei: state.gasDepositWei,
    rules: {
      limitWei: state.rules.limitWei,
      limitEth: formatEther(state.rules.limitWei),
      periodSeconds: Number(state.rules.periodSeconds),
      whitelistEnabled: state.rules.whitelistEnabled,
    },
    spendingRemainingWei: state.spendingRemainingWei,
  });
});
