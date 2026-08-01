import {formatEther} from "viem";

import {json, route} from "@/lib/api";
import {requireAgent} from "@/lib/auth";
import {confirmSessionKey} from "@/lib/session-keys";

/**
 * POST /api/v1/agents/me/session-keys/confirm — подтвердить регистрацию ключа.
 *
 * Платформа не верит на слово, что владелец отправил транзакцию: она читает состояние
 * ключа прямо из кошелька. Если ключа там нет — 409 и просьба отправить транзакцию.
 * Если владелец зарегистрировал ключ с другим бюджетом или сроком, чем предлагала
 * платформа, в базу попадают его цифры: границы задаёт контракт.
 */
export const POST = route(async (request) => {
  const agent = await requireAgent(request);
  const key = await confirmSessionKey(agent);

  return json({
    status: key.status.toLowerCase(),
    sessionKey: {
      address: key.address,
      budgetWei: key.budgetWei,
      budgetEth: formatEther(BigInt(key.budgetWei)),
      validUntil: key.validUntil.toISOString(),
      targets: JSON.parse(key.targets) as string[],
    },
  });
});
