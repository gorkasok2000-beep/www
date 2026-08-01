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
    case "SessionBudgetExceeded": {
      const [requested, remaining] = args as [bigint, bigint];
      return new AgentError(
        `Превышен бюджет ключа платформы: запрошено ${formatEther(requested)} ETH, ` +
          `осталось ${formatEther(remaining)} ETH. Средства на кошельке при этом есть — ` +
          `границу задал владелец при выдаче ключа.`,
        403,
      );
    }
    case "SessionTargetNotAllowed": {
      const [target] = args as [string];
      return new AgentError(`Ключ платформы не разрешает платежи на ${target}.`, 403);
    }
    case "SessionCallNotAllowed":
      return new AgentError(
        "Ключ платформы вправе только платить: другие методы кошелька ему закрыты.",
        403,
      );
    case "SessionKeyNeedsExpiry":
      return new AgentError("У ключа должен быть срок действия: вечные ключи запрещены.", 400);
    case "SessionKeyNeedsBudget":
      return new AgentError("У ключа должен быть ненулевой бюджет.", 400);
    case "NotOwnerOrSessionKey":
      return new AgentError("Отозвать ключ может владелец или сам держатель ключа.", 403);
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

/**
 * Коды отказа EntryPoint.
 *
 * Их немного, и каждый означает вполне конкретную вещь, которую агенту полезно знать:
 * подпись не подошла, срок ключа не наступил или уже вышел, на газ не хватает.
 */
function describeFailedOp(reason: string): AgentError {
  if (reason.startsWith("AA24")) {
    return new AgentError(
      "Кошелёк не принял подпись: ключ отозван, неизвестен или кошелёк заморожен.",
      403,
    );
  }
  if (reason.startsWith("AA22") || reason.startsWith("AA27")) {
    return new AgentError("Срок действия ключа не наступил или уже истёк.", 403);
  }
  if (reason.startsWith("AA21")) {
    return new AgentError(
      "На кошельке не хватает средств на газ: пополните баланс или депозит в EntryPoint.",
      402,
    );
  }
  return new AgentError(`EntryPoint отклонил операцию: ${reason}.`, 400);
}

/** Ошибка из симуляции или отправки транзакции. */
export function toAgentError(error: unknown): AgentError {
  if (error instanceof AgentError) {
    return error;
  }

  if (error instanceof BaseError) {
    const revert = error.walk((e) => e instanceof ContractFunctionRevertedError);
    if (revert instanceof ContractFunctionRevertedError && revert.data) {
      const {errorName, args} = revert.data;

      // Отказ на фазе валидации EntryPoint заворачивает в свою ошибку, а настоящую
      // причину кладёт последним аргументом сырыми байтами. Разворачиваем её —
      // иначе наружу ушло бы «AA23 reverted» вместо «превышен бюджет ключа».
      if (errorName === "FailedOpWithRevert") {
        const [, , inner] = (args ?? []) as [bigint, string, Hex];
        return fromRevertData(inner);
      }
      if (errorName === "FailedOp") {
        const [, reason] = (args ?? []) as [bigint, string];
        return describeFailedOp(reason);
      }

      return describe(errorName, args ?? []);
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
