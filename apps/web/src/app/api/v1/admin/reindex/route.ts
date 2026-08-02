import {json, route} from "@/lib/api";
import {requireAdmin} from "@/lib/auth";
import {syncTransactionLogs} from "@/lib/chain/indexer";

/**
 * POST /api/v1/admin/reindex — пересобрать кэш событий с нуля.
 *
 * README всегда обещал: «источник истины — блокчейн, достаточно очистить кэш». Кнопки
 * для этого не было. Она нужна после реорга, после смены сети или передеплоя контрактов,
 * а ещё это единственный способ убедиться, что кэш вообще пересобираем, — критерий
 * Gate 1 из `handoff/roadmap.md`.
 *
 * Обычная синхронизация (без тела запроса) идёт при каждом чтении истории и сама
 * перечитывает хвост цепи; полный пересбор — операция редкая и дорогая, поэтому она
 * за админ-токеном.
 *
 * Заголовок: X-API-Key: <ADMIN_API_TOKEN>
 */
export const POST = route(async (request) => {
  requireAdmin(request);

  const result = await syncTransactionLogs({rebuild: true});

  return json({
    indexed: result.indexed,
    removed: result.removed,
    toBlock: result.toBlock.toString(),
  });
});
