import {zeroAddress, type Address, type Hex} from "viem";
import {generatePrivateKey, privateKeyToAccount} from "viem/accounts";

import type {Agent} from "@/generated/prisma";

import {AgentError} from "./agent-error";
import {toAgentError} from "./chain/errors";
import {syncTransactionLogs} from "./chain/indexer";
import {encodeExecute} from "./chain/userOperation";
import {sendAgentUserOperation} from "./chain/relayer";
import {
  NO_RULES,
  readAgentState,
  registerAgentOnchain,
  setAgentFrozen,
  setWhitelistedOnchain,
  simulateExecute,
  updateRulesOnchain,
  type OnchainAgentState,
  type RulesInput,
} from "./chain/registry";
import {decryptSecret, encryptSecret, generateApiKey, hashApiKey} from "./crypto";
import {db} from "./db";

/** Два сценария из ТЗ. Значения совпадают с порядком enum `AgentMode` в контракте. */
export const AGENT_MODES = ["HUMAN_CUSTODIAN", "AUTONOMOUS_ENTITY"] as const;
export type AgentMode = (typeof AGENT_MODES)[number];

export {AgentError};

/**
 * Регистрация агента.
 *
 * Ключи генерируются на сервере: у агента ещё нет ни кошелька, ни способа подписать
 * первую операцию. Приватный ключ сразу шифруется, наружу отдаётся только адрес
 * и API-ключ — и только один раз.
 */
export async function createAgent(params: {
  handle: string;
  mode: AgentMode;
  rules?: RulesInput;
  whitelist?: Address[];
}): Promise<{agent: Agent; apiKey: string}> {
  const handle = params.handle.trim();
  if (!/^[a-z0-9][a-z0-9-]{1,30}$/i.test(handle)) {
    throw new AgentError(
      "Имя агента: от 2 до 31 символа, латиница, цифры и дефис.",
      400,
    );
  }

  if (await db.agent.findUnique({where: {handle}})) {
    throw new AgentError(`Имя «${handle}» уже занято.`, 409);
  }

  const isCustodial = params.mode === "HUMAN_CUSTODIAN";
  if (!isCustodial && (params.rules || params.whitelist?.length)) {
    throw new AgentError(
      "Правила доступны только в режиме Human Custodian: у автономного агента нет кастодиана.",
      400,
    );
  }

  const ownerKey = generatePrivateKey();
  const owner = privateKeyToAccount(ownerKey).address;

  const custodianKey = isCustodial ? generatePrivateKey() : undefined;
  const custodian = custodianKey ? privateKeyToAccount(custodianKey).address : zeroAddress;

  let account: Address;
  try {
    ({account} = await registerAgentOnchain({
      handle,
      owner,
      custodian,
      rules: isCustodial ? (params.rules ?? NO_RULES) : NO_RULES,
      whitelist: isCustodial ? (params.whitelist ?? []) : [],
      salt: 0n,
    }));
  } catch (error) {
    throw toAgentError(error);
  }

  const apiKey = generateApiKey();

  const agent = await db.agent.create({
    data: {
      handle,
      mode: params.mode,
      accountAddress: account,
      ownerAddress: owner,
      ownerKeyCiphertext: encryptSecret(ownerKey),
      custodianAddress: custodianKey ? custodian : null,
      custodianKeyCiphertext: custodianKey ? encryptSecret(custodianKey) : null,
      apiKeyHash: hashApiKey(apiKey),
    },
  });

  return {agent, apiKey};
}

export async function findAgentByApiKey(apiKey: string): Promise<Agent | null> {
  return db.agent.findUnique({where: {apiKeyHash: hashApiKey(apiKey)}});
}

export async function agentState(agent: Agent): Promise<OnchainAgentState> {
  return readAgentState(agent.accountAddress as Address);
}

/**
 * Агент сам инициирует оплату — центральный сценарий ТЗ.
 *
 * Никаких подтверждений от человека: правила уже зашиты в контракт, и именно он
 * решает, пропустить трату или откатить её.
 */
export async function sendPayment(
  agent: Agent,
  params: {to: Address; valueWei: bigint; data?: Hex},
): Promise<{txHash: Hex}> {
  const ownerKey = decryptSecret(agent.ownerKeyCiphertext) as Hex;
  const account = agent.accountAddress as Address;
  const data = params.data ?? "0x";

  // Сначала сухой прогон: если правило нарушено, агент узнаёт причину до траты газа.
  try {
    await simulateExecute({
      account,
      owner: agent.ownerAddress as Address,
      to: params.to,
      valueWei: params.valueWei,
      data,
    });
  } catch (error) {
    throw toAgentError(error);
  }

  const result = await sendAgentUserOperation({
    sender: account,
    callData: encodeExecute(params.to, params.valueWei, data),
    ownerPrivateKey: ownerKey,
  });

  // Сразу подтягиваем свежий лог, чтобы транзакция появилась в дашборде без задержки.
  await syncTransactionLogs();

  return result;
}

function requireCustodianKey(agent: Agent): Hex {
  if (!agent.custodianKeyCiphertext) {
    throw new AgentError(
      "У автономного агента нет кастодиана — правила для него недоступны.",
      400,
    );
  }
  return decryptSecret(agent.custodianKeyCiphertext) as Hex;
}

export async function updateRules(agent: Agent, rules: RulesInput): Promise<Hex> {
  try {
    return await updateRulesOnchain({
      account: agent.accountAddress as Address,
      custodianPrivateKey: requireCustodianKey(agent),
      rules,
    });
  } catch (error) {
    throw toAgentError(error);
  }
}

export async function setWhitelisted(
  agent: Agent,
  target: Address,
  allowed: boolean,
): Promise<Hex> {
  try {
    return await setWhitelistedOnchain({
      account: agent.accountAddress as Address,
      custodianPrivateKey: requireCustodianKey(agent),
      target,
      allowed,
    });
  } catch (error) {
    throw toAgentError(error);
  }
}

export async function freezeAgent(accountAddress: Address, frozen: boolean): Promise<Hex> {
  const agent = await db.agent.findUnique({where: {accountAddress}});
  if (!agent) {
    throw new AgentError(`Агент ${accountAddress} не найден.`, 404);
  }
  return setAgentFrozen(accountAddress, frozen);
}

/** История трат конкретного агента. */
export async function agentTransactions(agent: Agent, limit = 50) {
  await syncTransactionLogs();
  return db.transactionLog.findMany({
    where: {agentId: agent.id},
    orderBy: {timestamp: "desc"},
    take: limit,
  });
}

/**
 * Публичная лента для витрины: показываем действие, а не личность.
 * Адреса усечены, привязки к API-ключам и владельцам нет.
 */
export async function publicFeed(limit = 30) {
  await syncTransactionLogs();

  const logs = await db.transactionLog.findMany({
    orderBy: {timestamp: "desc"},
    take: limit,
    include: {agent: {select: {handle: true, mode: true}}},
  });

  return logs.map((log) => ({
    handle: log.agent.handle,
    mode: log.agent.mode,
    to: shortenAddress(log.to),
    valueWei: log.valueWei,
    txHash: log.txHash,
    timestamp: log.timestamp.toISOString(),
  }));
}

export async function publicAgents(limit = 24) {
  const agents = await db.agent.findMany({
    orderBy: {createdAt: "desc"},
    take: limit,
    include: {_count: {select: {transactions: true}}},
  });

  return agents.map((agent) => ({
    handle: agent.handle,
    mode: agent.mode,
    account: agent.accountAddress,
    accountShort: shortenAddress(agent.accountAddress),
    transactionCount: agent._count.transactions,
    createdAt: agent.createdAt.toISOString(),
  }));
}

export function shortenAddress(address: string): string {
  return `${address.slice(0, 6)}…${address.slice(-4)}`;
}
