import {
  BaseError,
  ContractFunctionRevertedError,
  decodeErrorResult,
  formatEther,
  type Hex,
} from "viem";

import {AgentError} from "@/lib/agent-error";

import {agentAccountAbi, agentRegistryAbi} from "./abis";

/**
 * Перевод ошибок контракта в человеческий текст.
 *
 * Кастомные ошибки `AgentAccount` — это и есть правила из ТЗ. Агенту (и человеку в
 * дашборде) важно понимать, почему трата не прошла: превышен лимит, адрес не в
 * whitelist или кошелёк заморожен. Без этого перевода наружу уходит «execution reverted».
 */
function describe(errorName: string | undefined, args: readonly unknown[] = []): AgentError {
  switch (errorName) {
    case "SpendLimitExceeded": {
      const [requested, remaining] = args as [bigint, bigint];
      return new AgentError(
        `Превышен лимит трат: запрошено ${formatEther(requested)} ETH, ` +
          `доступно ${formatEther(remaining)} ETH.`,
        403,
      );
    }
    case "RecipientNotWhitelisted": {
      const [target] = args as [string];
      return new AgentError(`Получатель ${target} не в whitelist.`, 403);
    }
    case "AccountFrozen":
      return new AgentError("Кошелёк заморожен администратором.", 403);
    case "NotCustodian":
      return new AgentError("Менять правила может только кастодиан.", 403);
    case "RulesRequireCustodian":
      return new AgentError(
        "У автономного агента нет кастодиана — правила для него недоступны.",
        400,
      );
    case "HandleAlreadyTaken":
      return new AgentError("Такое имя агента уже занято.", 409);
    case "EmptyHandle":
      return new AgentError("Имя агента не может быть пустым.", 400);
    case undefined:
      return new AgentError("Контракт отклонил операцию.", 400);
    default:
      return new AgentError(`Контракт отклонил операцию: ${errorName}.`, 400);
  }
}

/** Ошибка из симуляции или отправки транзакции. */
export function toAgentError(error: unknown): AgentError {
  if (error instanceof AgentError) {
    return error;
  }

  if (error instanceof BaseError) {
    const revert = error.walk((e) => e instanceof ContractFunctionRevertedError);
    if (revert instanceof ContractFunctionRevertedError && revert.data) {
      return describe(revert.data.errorName, revert.data.args ?? []);
    }
    return new AgentError(error.shortMessage || error.message, 400);
  }

  return new AgentError(error instanceof Error ? error.message : "Неизвестная ошибка", 500);
}

/**
 * Ошибка из события `UserOperationRevertReason`: EntryPoint не пробрасывает revert
 * наружу, а кладёт его в лог, поэтому сырые байты приходится декодировать вручную.
 */
export function fromRevertData(data: Hex | undefined): AgentError {
  if (!data || data === "0x") {
    return new AgentError("Операция отклонена контрактом без указания причины.", 400);
  }

  try {
    const decoded = decodeErrorResult({abi: [...agentAccountAbi, ...agentRegistryAbi], data});
    return describe(decoded.errorName, decoded.args ?? []);
  } catch {
    return new AgentError("Операция отклонена контрактом.", 400);
  }
}
