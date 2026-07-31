import {freezeAgent} from "@/lib/agents";
import {json, readJson, route} from "@/lib/api";
import {requireAdmin} from "@/lib/auth";
import {parseAddress} from "@/lib/validate";

/**
 * POST /api/v1/admin/freeze — обратимая заморозка кошелька.
 *
 * Единственная привилегия администратора в системе: на случай мошенничества или бага.
 * Средства при этом не изымаются и никуда не переводятся — только останавливаются траты.
 *
 * Заголовок: X-API-Key: <ADMIN_API_TOKEN>
 * Тело: {"account": "0x…", "frozen": true}
 */
export const POST = route(async (request) => {
  requireAdmin(request);

  const body = await readJson<{account?: unknown; frozen?: unknown}>(request);
  const account = parseAddress(body.account, "account");
  const frozen = body.frozen !== false;

  const txHash = await freezeAgent(account, frozen);

  return json({txHash, account, frozen});
});
