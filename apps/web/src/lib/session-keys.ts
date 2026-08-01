import {generatePrivateKey, privateKeyToAccount} from "viem/accounts";
import {formatEther, type Address, type Hex} from "viem";

import type {Agent, SessionKey} from "@/generated/prisma";

import {AgentError} from "./agent-error";
import {toAgentError} from "./chain/errors";
import {ensureGasAllowance} from "./chain/registry";
import {
  encodeRegisterSessionKey,
  isSessionTargetAllowed,
  readSessionKey,
  registerSessionKeyAsOwner,
  revokeSessionKeyAsHolder,
  type SessionKeyArgs,
} from "./chain/sessionKeys";
import {decryptSecret, encryptSecret} from "./crypto";
import {db} from "./db";

/**
 * Выпуск и жизненный цикл ключей ограниченного доступа.
 *
 * Смысл всей конструкции: платформа перестаёт держать главный ключ агента. Вместо него
 * она получает ключ с бюджетом, сроком и (по желанию) списком получателей, который
 * владелец регистрирует в своём кошельке и может отозвать в любой момент.
 *
 * Кто что делает:
 *   - платформа генерирует пару ключей и хранит приватную часть — ей же ею подписывать;
 *   - владелец регистрирует публичную часть в контракте. Право на это есть только у него;
 *   - подтверждение платформа не принимает на слово: она читает контракт.
 */

/** Сутки по умолчанию: ключ должен протухать сам, вечных контракт не принимает. */
const DEFAULT_TTL_SECONDS = 24 * 60 * 60;
const MAX_TTL_SECONDS = 90 * 24 * 60 * 60;

export type IssuedSessionKey = {
  record: SessionKey;
  /** Транзакция, которую владельцу нужно отправить, если главного ключа у платформы нет. */
  transaction: {to: Address; data: Hex};
  txHash?: Hex;
};

/**
 * Выпускает ключ и, если может, сразу регистрирует его в контракте.
 *
 * Зарегистрировать ключ вправе только владелец кошелька. Платформа делает это сама
 * только в прототипном режиме SERVER_KEY, где главный ключ всё ещё лежит у неё. Во всех
 * остальных случаях она возвращает готовую транзакцию, а отправляет её владелец.
 */
export async function issueSessionKey(
  agent: Agent,
  params: {budgetWei: bigint; ttlSeconds?: number; targets?: Address[]},
): Promise<IssuedSessionKey> {
  if (params.budgetWei <= 0n) {
    throw new AgentError("Бюджет ключа должен быть больше нуля.", 400);
  }

  const ttl = params.ttlSeconds ?? DEFAULT_TTL_SECONDS;
  if (ttl <= 0 || ttl > MAX_TTL_SECONDS) {
    throw new AgentError(`Срок действия ключа: от 1 секунды до ${MAX_TTL_SECONDS} секунд.`, 400);
  }

  // Действующий ключ отзывается перед выпуском нового: два одновременно живых ключа —
  // два независимых бюджета, и агенту труднее понять, сколько платформа может потратить.
  const current = await activeSessionKeyRecord(agent);
  if (current) {
    await revokeSessionKey(agent);
  }

  const privateKey = generatePrivateKey();
  const address = privateKeyToAccount(privateKey).address;
  const validUntil = Math.floor(Date.now() / 1000) + ttl;
  const targets = params.targets ?? [];

  const args: SessionKeyArgs = {
    signer: address,
    validAfter: 0,
    validUntil,
    budgetWei: params.budgetWei,
    targets,
  };

  const record = await db.sessionKey.create({
    data: {
      agentId: agent.id,
      address,
      privateKeyCiphertext: encryptSecret(privateKey),
      budgetWei: params.budgetWei.toString(),
      validUntil: new Date(validUntil * 1000),
      targets: JSON.stringify(targets),
      status: "PENDING",
    },
  });

  const transaction = {
    to: agent.accountAddress as Address,
    data: encodeRegisterSessionKey(args),
  };

  if (agent.signerMode !== "SERVER_KEY" || !agent.ownerKeyCiphertext) {
    // Главного ключа у платформы нет — регистрирует владелец, дальше зовёт confirm.
    //
    // ПРОТОТИП: за эту транзакцию владелец платит газ сам, со своего EOA. На тестовой
    // сети платформа выдаёт ему небольшой запас — тот же приём, что и для кастодиана,
    // и такой же временный. В проде владелец приходит со своим газом.
    await ensureGasAllowance(agent.ownerAddress as Address);
    return {record, transaction};
  }

  let txHash: Hex;
  try {
    txHash = await registerSessionKeyAsOwner({
      account: agent.accountAddress as Address,
      ownerPrivateKey: decryptSecret(agent.ownerKeyCiphertext) as Hex,
      args,
    });
  } catch (error) {
    await db.sessionKey.delete({where: {id: record.id}});
    throw toAgentError(error);
  }

  const activated = await confirmSessionKey(agent);
  return {record: activated, transaction, txHash};
}

/**
 * Подтверждает регистрацию — чтением контракта, а не по слову вызывающего.
 *
 * Владелец мог отправить транзакцию, мог передумать, мог отправить с другими условиями.
 * Единственный способ узнать правду — спросить кошелёк.
 */
export async function confirmSessionKey(agent: Agent): Promise<SessionKey> {
  const pending = await db.sessionKey.findFirst({
    where: {agentId: agent.id, status: {in: ["PENDING", "ACTIVE"]}},
    orderBy: {createdAt: "desc"},
  });

  if (!pending) {
    throw new AgentError("Для этого агента не выпущено ни одного ключа.", 404);
  }

  const onchain = await readSessionKey(
    agent.accountAddress as Address,
    pending.address as Address,
  );

  if (!onchain.exists) {
    throw new AgentError(
      "Ключ ещё не зарегистрирован в кошельке. Отправьте подготовленную транзакцию от имени владельца.",
      409,
    );
  }

  // Условия берём из контракта: если владелец зарегистрировал ключ с другим бюджетом
  // или сроком, действуют его цифры, а не те, что мы предлагали.
  const updated = await db.sessionKey.update({
    where: {id: pending.id},
    data: {
      status: "ACTIVE",
      activatedAt: pending.activatedAt ?? new Date(),
      budgetWei: onchain.budgetWei.toString(),
      validUntil: new Date(onchain.validUntil * 1000),
    },
  });

  if (agent.signerMode === "SERVER_KEY") {
    return updated;
  }

  await db.agent.update({where: {id: agent.id}, data: {signerMode: "SESSION_KEY"}});
  return updated;
}

/** Действующий ключ по данным базы. Ончейн-проверку делает `signerFor`. */
export async function activeSessionKeyRecord(agent: Agent): Promise<SessionKey | null> {
  return db.sessionKey.findFirst({
    where: {agentId: agent.id, status: "ACTIVE", validUntil: {gt: new Date()}},
    orderBy: {createdAt: "desc"},
  });
}

/**
 * Последний живой ключ, включая ещё не зарегистрированный.
 *
 * Нужен интерфейсу: выпущенный, но не подтверждённый ключ должен быть виден — иначе
 * владелец, не отправивший транзакцию, увидит пустую карточку и не поймёт, что от него
 * ждут действия. Для подписи такой ключ, разумеется, не годится — там `activeSessionKeyRecord`.
 */
export async function latestSessionKeyRecord(agent: Agent): Promise<SessionKey | null> {
  return db.sessionKey.findFirst({
    where: {agentId: agent.id, status: {in: ["PENDING", "ACTIVE"]}, validUntil: {gt: new Date()}},
    orderBy: {createdAt: "desc"},
  });
}

/**
 * Отзыв ключа платформой.
 *
 * Платформа — держатель ключа, а контракт разрешает отзыв держателю наравне с владельцем.
 * Поэтому эта кнопка работает всегда и не требует участия агента.
 */
export async function revokeSessionKey(agent: Agent): Promise<{txHash?: Hex}> {
  const record = await db.sessionKey.findFirst({
    where: {agentId: agent.id, status: {in: ["PENDING", "ACTIVE"]}},
    orderBy: {createdAt: "desc"},
  });

  if (!record) {
    throw new AgentError("У агента нет действующего ключа.", 404);
  }

  let txHash: Hex | undefined;
  const onchain = await readSessionKey(
    agent.accountAddress as Address,
    record.address as Address,
  );

  // Ключ, который так и не зарегистрировали, отзывать в контракте нечего.
  if (onchain.exists) {
    try {
      txHash = await revokeSessionKeyAsHolder({
        account: agent.accountAddress as Address,
        sessionPrivateKey: decryptSecret(record.privateKeyCiphertext) as Hex,
      });
    } catch (error) {
      throw toAgentError(error);
    }
  }

  await db.sessionKey.update({
    where: {id: record.id},
    data: {status: "REVOKED", revokedAt: new Date()},
  });

  return {txHash};
}

/**
 * Предполётная проверка границ ключа.
 *
 * Контракт всё равно проверит их сам — но на фазе валидации, и наружу это выйдет как
 * `FailedOpWithRevert(0, "AA23 reverted", …)` уже после попытки отправки. Здесь та же
 * проверка делается чтением состояния, до траты чего бы то ни было, и агент получает
 * внятный отказ.
 *
 * Данные берутся из контракта, а не из таблицы: владелец мог изменить или отозвать ключ
 * без нашего участия.
 */
export async function assertSessionKeyAllows(params: {
  account: Address;
  signer: Address;
  to: Address;
  valueWei: bigint;
}): Promise<void> {
  const key = await readSessionKey(params.account, params.signer);

  if (!key.exists) {
    throw new AgentError(
      "Ключ платформы отозван в кошельке. Выпустите новый: POST /api/v1/agents/me/session-keys.",
      409,
    );
  }

  const now = Math.floor(Date.now() / 1000);
  if (key.validUntil <= now) {
    throw new AgentError("Срок действия ключа платформы истёк — выпустите новый.", 403);
  }
  if (key.validAfter > now) {
    throw new AgentError("Ключ платформы ещё не вступил в силу.", 403);
  }

  const remaining = key.budgetWei - key.spentWei;
  if (params.valueWei > remaining) {
    throw new AgentError(
      `Превышен бюджет ключа платформы: запрошено ${formatEther(params.valueWei)} ETH, ` +
        `осталось ${formatEther(remaining)} ETH. Средства на кошельке при этом есть — ` +
        `границу задал владелец при выдаче ключа.`,
      403,
    );
  }

  if (key.targetsRestricted) {
    const allowed = await isSessionTargetAllowed(params.account, params.signer, params.to);
    if (!allowed) {
      throw new AgentError(`Ключ платформы не разрешает платежи на ${params.to}.`, 403);
    }
  }
}

/** Ключи агента для кабинета: приватная часть наружу, разумеется, не выдаётся. */
export async function listSessionKeys(agent: Agent) {
  const keys = await db.sessionKey.findMany({
    where: {agentId: agent.id},
    orderBy: {createdAt: "desc"},
    take: 20,
  });

  return keys.map((key) => ({
    address: key.address,
    status: key.status,
    budgetWei: key.budgetWei,
    validUntil: key.validUntil.toISOString(),
    targets: JSON.parse(key.targets) as string[],
    createdAt: key.createdAt.toISOString(),
  }));
}
