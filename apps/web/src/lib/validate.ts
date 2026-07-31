import {isAddress, parseEther, type Address} from "viem";

import {AgentError, AGENT_MODES, type AgentMode} from "./agents";
import type {RulesInput} from "./chain/registry";

/** Разбор входных данных API без внешних зависимостей — прототипу хватает. */

export function parseAddress(value: unknown, field: string): Address {
  if (typeof value !== "string" || !isAddress(value)) {
    throw new AgentError(`Поле ${field} должно быть Ethereum-адресом.`, 400);
  }
  return value;
}

export function parseMode(value: unknown): AgentMode {
  if (typeof value !== "string" || !AGENT_MODES.includes(value as AgentMode)) {
    throw new AgentError(`Поле mode должно быть одним из: ${AGENT_MODES.join(", ")}.`, 400);
  }
  return value as AgentMode;
}

/**
 * Сумма принимается либо в wei (`valueWei`), либо в ETH (`valueEth`) — агенту удобнее
 * первое, человеку в форме второе.
 */
export function parseValue(body: {valueWei?: unknown; valueEth?: unknown}): bigint {
  if (typeof body.valueWei === "string" || typeof body.valueWei === "number") {
    try {
      const value = BigInt(body.valueWei);
      if (value < 0n) {
        throw new Error();
      }
      return value;
    } catch {
      throw new AgentError("Поле valueWei должно быть неотрицательным целым числом.", 400);
    }
  }

  if (typeof body.valueEth === "string" || typeof body.valueEth === "number") {
    try {
      return parseEther(String(body.valueEth));
    } catch {
      throw new AgentError("Поле valueEth должно быть числом в ETH.", 400);
    }
  }

  throw new AgentError("Укажите сумму: valueWei или valueEth.", 400);
}

export function parseRules(value: unknown): RulesInput {
  if (typeof value !== "object" || value === null) {
    throw new AgentError("Поле rules должно быть объектом.", 400);
  }

  const raw = value as {limitEth?: unknown; limitWei?: unknown; periodSeconds?: unknown; whitelistEnabled?: unknown};

  const limitWei =
    raw.limitEth === undefined && raw.limitWei === undefined
      ? 0n
      : parseValue({valueWei: raw.limitWei, valueEth: raw.limitEth});

  const periodSeconds = raw.periodSeconds === undefined ? 0n : BigInt(Number(raw.periodSeconds));
  if (periodSeconds < 0n) {
    throw new AgentError("Поле periodSeconds не может быть отрицательным.", 400);
  }

  return {
    limitWei,
    periodSeconds,
    whitelistEnabled: Boolean(raw.whitelistEnabled),
  };
}

export function parseWhitelist(value: unknown): Address[] {
  if (value === undefined || value === null) {
    return [];
  }
  if (!Array.isArray(value)) {
    throw new AgentError("Поле whitelist должно быть массивом адресов.", 400);
  }
  return value.map((entry, index) => parseAddress(entry, `whitelist[${index}]`));
}
