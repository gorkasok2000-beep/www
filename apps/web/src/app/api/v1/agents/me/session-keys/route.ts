import {formatEther} from "viem";

import {json, readJson, route} from "@/lib/api";
import {requireAgent} from "@/lib/auth";
import {issueSessionKey, listSessionKeys, revokeSessionKey} from "@/lib/session-keys";
import {parseValue, parseWhitelist} from "@/lib/validate";

/**
 * Ключи ограниченного доступа: право платить от имени кошелька в заданных границах.
 *
 * Зачем это нужно. Пока главный ключ агента лежит на сервере, взлом платформы означает
 * потерю всех средств всех агентов. Session key меняет цену взлома: контракт не даст
 * потратить больше выданного бюджета, позже указанного срока и не тем получателям.
 *
 * Зарегистрировать ключ в кошельке вправе только владелец. Поэтому здесь два пути:
 * если главный ключ ещё у платформы (прототипный режим), она регистрирует ключ сама;
 * если ключ у агента — платформа возвращает готовую транзакцию, владелец отправляет её
 * и зовёт `confirm`.
 */

/**
 * GET /api/v1/agents/me/session-keys — выпущенные ключи и их состояние.
 */
export const GET = route(async (request) => {
  const agent = await requireAgent(request);

  return json({
    account: agent.accountAddress,
    signerMode: agent.signerMode,
    sessionKeys: await listSessionKeys(agent),
  });
});

/**
 * POST /api/v1/agents/me/session-keys — выпустить ключ.
 *
 * Тело: {"budgetEth": "0.5", "ttlSeconds": 86400, "targets": ["0x…"]}
 * Предыдущий действующий ключ при этом отзывается: два живых бюджета одновременно —
 * лишний способ запутаться в том, сколько платформа может потратить.
 */
export const POST = route(async (request) => {
  const agent = await requireAgent(request);
  const body = await readJson<{
    budgetWei?: unknown;
    budgetEth?: unknown;
    ttlSeconds?: unknown;
    targets?: unknown;
  }>(request);

  const budgetWei = parseValue({valueWei: body.budgetWei, valueEth: body.budgetEth});
  const targets = parseWhitelist(body.targets);
  const ttlSeconds = body.ttlSeconds === undefined ? undefined : Number(body.ttlSeconds);

  const issued = await issueSessionKey(agent, {budgetWei, ttlSeconds, targets});
  const registered = issued.record.status === "ACTIVE";

  return json(
    {
      status: registered ? "active" : "pending",
      sessionKey: {
        address: issued.record.address,
        budgetWei: issued.record.budgetWei,
        budgetEth: formatEther(BigInt(issued.record.budgetWei)),
        validUntil: issued.record.validUntil.toISOString(),
        targets,
      },
      txHash: issued.txHash,
      // Владелец отправляет эту транзакцию сам, если главного ключа у платформы нет.
      transaction: registered ? undefined : issued.transaction,
      note: registered
        ? "Ключ зарегистрирован в кошельке — платформа платит им."
        : "Отправьте transaction от имени владельца, затем POST /session-keys/confirm.",
    },
    {status: 201},
  );
});

/**
 * DELETE /api/v1/agents/me/session-keys — отозвать ключ.
 *
 * Работает всегда и без участия владельца: контракт разрешает отзыв держателю ключа,
 * а держатель — платформа. Заметив компрометацию, она обрывает себе доступ немедленно.
 */
export const DELETE = route(async (request) => {
  const agent = await requireAgent(request);
  const {txHash} = await revokeSessionKey(agent);

  return json({status: "revoked", txHash});
});
