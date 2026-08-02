import {keccak256, toHex, zeroAddress, type Address, type Hex} from "viem";
import {generatePrivateKey, privateKeyToAccount} from "viem/accounts";

import type {Agent} from "@/generated/prisma";

import {AgentError} from "./agent-error";
import {toAgentError} from "./chain/errors";
import {syncTransactionLogs} from "./chain/indexer";
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
import {localSigner, remoteSigner, type Signer, type SignerMode} from "./chain/signer";
import {decryptSecret, encryptSecret, generateApiKey, hashApiKey} from "./crypto";
import {db} from "./db";
import {serverEnv} from "./env";
import {activeSessionKeyRecord} from "./session-keys";

/** Два сценария из ТЗ. Значения совпадают с порядком enum `AgentMode` в контракте. */
export const AGENT_MODES = ["HUMAN_CUSTODIAN", "AUTONOMOUS_ENTITY"] as const;
export type AgentMode = (typeof AGENT_MODES)[number];

export {AgentError};

/**
 * Регистрация агента.
 *
 * Главный ключ агента может появиться тремя способами, и от этого зависит, что платформа
 * сможет подписывать:
 *
 *   1. `owner` + `signerUrl` — ключ у агента, подпись он отдаёт по HTTP. Режим REMOTE:
 *      у платформы ключа нет вовсе.
 *   2. `owner` без `signerUrl` — ключ у агента (например, сгенерирован в браузере и
 *      зашифрован парольной фразой). Платить платформа сможет только после того, как
 *      владелец выдаст ей session key.
 *   3. Ничего не передано — ключ генерирует сервер и хранит зашифрованным. Прототипный
 *      путь: удобно для демонстрации, плохо для продакшена. Оставлен ради обратной
 *      совместимости и локальной разработки.
 */
export async function createAgent(params: {
  handle: string;
  mode: AgentMode;
  rules?: RulesInput;
  whitelist?: Address[];
  owner?: Address;
  signerUrl?: string;
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

  if (params.signerUrl && !params.owner) {
    throw new AgentError(
      "Вместе с signerUrl нужен owner: платформа обязана знать, чью подпись проверять.",
      400,
    );
  }

  // Режим SERVER_KEY — прототипный: платформа генерирует и хранит главный ключ агента,
  // то есть может потратить всё. На публичной сети он должен быть закрыт, иначе
  // компрометация сервера стоит средств всех агентов, зарегистрированных таким путём.
  if (!params.owner && !serverEnv.allowServerKeyMode()) {
    throw new AgentError(
      "Укажите owner — адрес, которым агент подписывает свои операции. Хранение главного " +
        "ключа на сервере в этой сети отключено (ALLOW_SERVER_KEY_MODE=false).",
      400,
    );
  }

  // Ключ генерируется на сервере, только если владелец не назвал свой адрес.
  const ownerKey = params.owner ? undefined : generatePrivateKey();
  const owner = params.owner ?? privateKeyToAccount(ownerKey!).address;

  const signerMode: SignerMode = params.signerUrl
    ? "REMOTE"
    : params.owner
      ? "SESSION_KEY"
      : "SERVER_KEY";

  const custodianKey = isCustodial ? generatePrivateKey() : undefined;
  const custodian = custodianKey ? privateKeyToAccount(custodianKey).address : zeroAddress;

  // Соль детерминирована по handle, а не ноль. С нулевой солью адрес кошелька
  // определялся только параметрами инициализации, поэтому второй агент того же
  // владельца с теми же правилами получал ТОТ ЖЕ адрес — и упирался в запрет
  // повторной регистрации в реестре. Соль от имени разводит такие кошельки и при
  // этом остаётся воспроизводимой: адрес можно пересчитать, зная только handle.
  const salt = saltForHandle(handle);

  let account: Address;
  try {
    ({account} = await registerAgentOnchain({
      handle,
      owner,
      custodian,
      rules: isCustodial ? (params.rules ?? NO_RULES) : NO_RULES,
      whitelist: isCustodial ? (params.whitelist ?? []) : [],
      salt,
    }));
  } catch (error) {
    throw toAgentError(error);
  }

  const apiKey = generateApiKey();

  // Кошелёк уже создан в сети, а запись ещё нет: если создание записи упадёт (например,
  // на уникальности `accountAddress`), наружу должен уйти внятный конфликт, а не 500 с
  // деталями базы. Ончейн-состояние при этом остаётся источником истины.
  const agent = await db.agent
    .create({
      data: {
        handle,
        mode: params.mode,
        accountAddress: account,
        salt: salt.toString(),
        ownerAddress: owner,
        signerMode,
        ownerKeyCiphertext: ownerKey ? encryptSecret(ownerKey) : null,
        signerUrl: params.signerUrl ?? null,
        custodianAddress: custodianKey ? custodian : null,
        custodianKeyCiphertext: custodianKey ? encryptSecret(custodianKey) : null,
        apiKeyHash: hashApiKey(apiKey),
      },
    })
    .catch(() => {
      throw new AgentError(
        `Кошелёк ${account} уже зарегистрирован в системе. ` +
          "Выберите другое имя агента: адрес кошелька выводится из него.",
        409,
      );
    });

  return {agent, apiKey};
}

/**
 * Соль CREATE2 для кошелька агента.
 *
 * Берётся из имени: одинаковое имя даёт одинаковый адрес в любой сети, разные имена —
 * разные кошельки даже у одного владельца с одинаковыми правилами.
 */
export function saltForHandle(handle: string): bigint {
  return BigInt(keccak256(toHex(handle.trim().toLowerCase())));
}

export async function findAgentByApiKey(apiKey: string): Promise<Agent | null> {
  return db.agent.findUnique({where: {apiKeyHash: hashApiKey(apiKey)}});
}

export async function agentState(agent: Agent): Promise<OnchainAgentState> {
  return readAgentState(agent.accountAddress as Address);
}

/**
 * Чем платформа подпишет операцию этого агента.
 *
 * Единственное место, где решается вопрос «а есть ли у нас право подписи». Дальше по
 * коду ключа уже нет — есть `Signer`, и он либо работает, либо не был получен.
 */
export async function signerFor(agent: Agent): Promise<Signer> {
  switch (agent.signerMode as SignerMode) {
    case "SERVER_KEY": {
      if (!agent.ownerKeyCiphertext) {
        throw new AgentError("У агента нет ключа на сервере — режим указан неверно.", 500);
      }
      return localSigner(decryptSecret(agent.ownerKeyCiphertext) as Hex, "SERVER_KEY");
    }

    case "REMOTE": {
      if (!agent.signerUrl) {
        throw new AgentError("Для режима REMOTE не задан эндпоинт подписи.", 500);
      }
      return remoteSigner({url: agent.signerUrl, address: agent.ownerAddress as Address});
    }

    case "SESSION_KEY": {
      const key = await activeSessionKeyRecord(agent);
      if (!key) {
        throw new AgentError(
          "У платформы нет действующего ключа для этого кошелька. " +
            "Выпустите его: POST /api/v1/agents/me/session-keys.",
          409,
        );
      }
      return localSigner(decryptSecret(key.privateKeyCiphertext) as Hex, "SESSION_KEY");
    }

    default:
      throw new AgentError(`Неизвестный режим подписи ${agent.signerMode}.`, 500);
  }
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
