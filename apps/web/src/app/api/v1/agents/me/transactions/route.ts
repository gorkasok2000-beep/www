import {agentTransactions, sendPayment} from "@/lib/agents";
import {json, readJson, route} from "@/lib/api";
import {requireAgent} from "@/lib/auth";
import {parseAddress, parseValue} from "@/lib/validate";

/**
 * GET /api/v1/agents/me/transactions — история трат кошелька (из публичного лога).
 */
export const GET = route(async (request) => {
  const agent = await requireAgent(request);
  const transactions = await agentTransactions(agent);

  return json({
    account: agent.accountAddress,
    transactions: transactions.map((tx) => ({
      to: tx.to,
      valueWei: tx.valueWei,
      selector: tx.selector,
      txHash: tx.txHash,
      blockNumber: tx.blockNumber,
      timestamp: tx.timestamp.toISOString(),
    })),
  });
});

/**
 * POST /api/v1/agents/me/transactions — агент инициирует оплату сам.
 *
 * Это ключевой эндпоинт ТЗ: ИИ-агент принимает решение о трате и выполняет её одним
 * HTTP-запросом. Разрешение спрашивать не у кого — ограничения уже записаны в контракт,
 * и если трата их нарушает, транзакция откатывается на уровне блокчейна.
 *
 * Тело: {"to": "0x…", "valueEth": "0.05"}  либо  {"to": "0x…", "valueWei": "50000000000000000"}
 * Необязательное поле `data` — calldata, если агент вызывает метод контракта, а не шлёт ETH.
 */
export const POST = route(async (request) => {
  const agent = await requireAgent(request);
  const body = await readJson<{to?: unknown; valueWei?: unknown; valueEth?: unknown; data?: string}>(
    request,
  );

  const to = parseAddress(body.to, "to");
  const valueWei = parseValue(body);

  const {txHash} = await sendPayment(agent, {
    to,
    valueWei,
    data: (body.data as `0x${string}` | undefined) ?? "0x",
  });

  return json({txHash, to, valueWei}, {status: 201});
});
