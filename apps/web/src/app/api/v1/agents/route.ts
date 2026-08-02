import {createAgent} from "@/lib/agents";
import {json, readJson, route} from "@/lib/api";
import {API_KEY_COOKIE} from "@/lib/auth";
import {
  assertUrlResolvesPublic,
  parseAddress,
  parseMode,
  parseRules,
  parseSignerUrl,
  parseWebhookUrl,
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
 * Необязательное поле `webhookUrl` — эндпоинт агента для уведомлений о смене статуса
 * платежей и счетов (см. `lib/webhooks.ts`). Секрет подписи возвращается один раз,
 * как и API-ключ.
 *
 * Тело:
 *   {
 *     "handle": "orion",
 *     "mode": "AUTONOMOUS_ENTITY" | "HUMAN_CUSTODIAN",
 *     "owner": "0x…",
 *     "signerUrl": "https://agent.example/sign",
 *     "webhookUrl": "https://agent.example/webhooks",
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
    webhookUrl?: unknown;
    rules?: unknown;
    whitelist?: unknown;
  }>(request);

  const mode = parseMode(body.mode);
  const isCustodial = mode === "HUMAN_CUSTODIAN";

  // Имя хоста проверяется резолвом: фильтра по IP-литералу мало, если домен
  // указывает внутрь инфраструктуры.
  const signerUrl = parseSignerUrl(body.signerUrl);
  if (signerUrl) {
    await assertUrlResolvesPublic(signerUrl, "signerUrl");
  }
  const webhookUrl = parseWebhookUrl(body.webhookUrl);
  if (webhookUrl) {
    await assertUrlResolvesPublic(webhookUrl, "webhookUrl");
  }

  const {agent, apiKey, webhookSecret} = await createAgent({
    handle: String(body.handle ?? ""),
    mode,
    owner: body.owner === undefined ? undefined : parseAddress(body.owner, "owner"),
    signerUrl,
    webhookUrl,
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
      // Секрет подписи вебхуков — тоже один раз: в базе он лежит зашифрованным,
      // и повторно его не показать.
      ...(webhookSecret ? {webhookSecret} : {}),
      note: webhookSecret
        ? "Сохраните apiKey и webhookSecret: они показываются только сейчас."
        : "Сохраните apiKey: он показывается только сейчас.",
    },
    {status: 201},
  );

  // Тот же ключ кладём в httpOnly-cookie — так дашборд открывается сразу после
  // регистрации, не заставляя человека вставлять ключ руками.
  response.cookies.set(API_KEY_COOKIE, apiKey, {
    httpOnly: true,
    sameSite: "lax",
    // В проде кука уходит только по HTTPS. Локально её пришлось бы отключать: по http
    // браузер `secure`-куку просто не сохранит, и дашборд не открылся бы после регистрации.
    secure: process.env.NODE_ENV === "production",
    path: "/",
    maxAge: 60 * 60 * 24 * 30,
  });

  return response;
});
