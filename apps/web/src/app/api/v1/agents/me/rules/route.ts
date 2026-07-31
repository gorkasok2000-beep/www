import {formatEther} from "viem";

import {agentState, setWhitelisted, updateRules} from "@/lib/agents";
import {json, readJson, route} from "@/lib/api";
import {requireAgent} from "@/lib/auth";
import {parseAddress, parseRules} from "@/lib/validate";

/**
 * PUT /api/v1/agents/me/rules — кастодиан меняет лимит и режим whitelist.
 *
 * Для Autonomous Entity эндпоинт отвечает 400: у такого кошелька кастодиана нет,
 * и контракт откажет в изменении правил независимо от API.
 *
 * Тело: {"limitEth": "0.5", "periodSeconds": 86400, "whitelistEnabled": true}
 */
export const PUT = route(async (request) => {
  const agent = await requireAgent(request);
  const rules = parseRules(await readJson(request));

  const txHash = await updateRules(agent, rules);
  const state = await agentState(agent);

  return json({
    txHash,
    rules: {
      limitWei: state.rules.limitWei,
      limitEth: formatEther(state.rules.limitWei),
      periodSeconds: Number(state.rules.periodSeconds),
      whitelistEnabled: state.rules.whitelistEnabled,
    },
  });
});

/**
 * POST /api/v1/agents/me/rules — добавить или убрать адрес из whitelist.
 * Тело: {"target": "0x…", "allowed": true}
 */
export const POST = route(async (request) => {
  const agent = await requireAgent(request);
  const body = await readJson<{target?: unknown; allowed?: unknown}>(request);

  const target = parseAddress(body.target, "target");
  const allowed = body.allowed !== false;

  const txHash = await setWhitelisted(agent, target, allowed);

  return json({txHash, target, allowed});
});
