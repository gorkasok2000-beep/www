import {createAgent} from "@/lib/agents";
import {json, readJson, route} from "@/lib/api";
import {API_KEY_COOKIE} from "@/lib/auth";
import {parseMode, parseRules, parseWhitelist} from "@/lib/validate";

/**
 * POST /api/v1/agents — регистрация агента.
 *
 * Никаких проверок личности: указываешь имя и режим — получаешь кошелёк. API-ключ
 * возвращается ровно один раз, повторно его посмотреть нельзя.
 *
 * Тело:
 *   {
 *     "handle": "orion",
 *     "mode": "AUTONOMOUS_ENTITY" | "HUMAN_CUSTODIAN",
 *     "rules": {"limitEth": "0.5", "periodSeconds": 86400, "whitelistEnabled": true},
 *     "whitelist": ["0x…"]
 *   }
 */
export const POST = route(async (request) => {
  const body = await readJson<{
    handle?: string;
    mode?: string;
    rules?: unknown;
    whitelist?: unknown;
  }>(request);

  const mode = parseMode(body.mode);
  const isCustodial = mode === "HUMAN_CUSTODIAN";

  const {agent, apiKey} = await createAgent({
    handle: String(body.handle ?? ""),
    mode,
    rules: isCustodial && body.rules ? parseRules(body.rules) : undefined,
    whitelist: isCustodial ? parseWhitelist(body.whitelist) : [],
  });

  const response = json(
    {
      handle: agent.handle,
      mode: agent.mode,
      account: agent.accountAddress,
      owner: agent.ownerAddress,
      custodian: agent.custodianAddress,
      apiKey,
      note: "Сохраните apiKey: он показывается только сейчас.",
    },
    {status: 201},
  );

  // Тот же ключ кладём в httpOnly-cookie — так дашборд открывается сразу после
  // регистрации, не заставляя человека вставлять ключ руками.
  response.cookies.set(API_KEY_COOKIE, apiKey, {
    httpOnly: true,
    sameSite: "lax",
    path: "/",
    maxAge: 60 * 60 * 24 * 30,
  });

  return response;
});
