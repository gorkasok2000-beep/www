import {createAgent} from "@/lib/agents";
import {json, readJson, route} from "@/lib/api";
import {API_KEY_COOKIE} from "@/lib/auth";
import {
  assertSignerUrlResolvesPublic,
  parseAddress,
  parseMode,
  parseRules,
  parseSignerUrl,
  parseWhitelist,
} from "@/lib/validate";

/**
 * POST /api/v1/agents — регистрация агента.
 *
 * Никаких проверок личности: указываешь имя и режим — получаешь кошелёк. API-ключ
 * возвращается ровно один раз, повторно его посмотреть нельзя.
 *
 * Необязательное поле `owner` — адрес, которым агент будет подписывать свои операции.
 * Если он указан, приватного ключа у платформы не появляется вовсе: она либо просит
 * подпись у `signerUrl`, либо ждёт, когда владелец выдаст ей session key. Если не
 * указан — ключ генерирует сервер (прототипный путь, см. `lib/agents.ts`).
 *
 * Тело:
 *   {
 *     "handle": "orion",
 *     "mode": "AUTONOMOUS_ENTITY" | "HUMAN_CUSTODIAN",
 *     "owner": "0x…",
 *     "signerUrl": "https://agent.example/sign",
 *     "rules": {"limitEth": "0.5", "periodSeconds": 86400, "whitelistEnabled": true},
 *     "whitelist": ["0x…"]
 *   }
 */
export const POST = route(async (request) => {
  const body = await readJson<{
    handle?: string;
    mode?: string;
    owner?: unknown;
    signerUrl?: unknown;
    rules?: unknown;
    whitelist?: unknown;
  }>(request);

  const mode = parseMode(body.mode);
  const isCustodial = mode === "HUMAN_CUSTODIAN";

  // Имя хоста проверяется резолвом: фильтра по IP-литералу мало, если домен
  // указывает внутрь инфраструктуры.
  const signerUrl = parseSignerUrl(body.signerUrl);
  if (signerUrl) {
    await assertSignerUrlResolvesPublic(signerUrl);
  }

  const {agent, apiKey} = await createAgent({
    handle: String(body.handle ?? ""),
    mode,
    owner: body.owner === undefined ? undefined : parseAddress(body.owner, "owner"),
    signerUrl,
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
      signerMode: agent.signerMode,
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
