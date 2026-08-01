import type {Address} from "viem";

import type {Agent} from "@/generated/prisma";

import {estimatePaymentCost} from "./chain/gas";
import {readSessionKey} from "./chain/sessionKeys";
import type {SignerMode} from "./chain/signer";
import {latestSessionKeyRecord} from "./session-keys";

/**
 * Данные кабинета, которых нет ни в контракте, ни в базе по отдельности.
 *
 * Кабинет должен отвечать на два вопроса, которые до сих пор были видны только из кода:
 * чем платформа подписывает операции этого кошелька и сколько ей ещё позволено потратить.
 */

export type SessionKeyOverview = {
  address: Address;
  budgetWei: bigint;
  spentWei: bigint;
  remainingWei: bigint;
  validUntil: Date;
  targetsRestricted: boolean;
  /** Ключ есть в базе, но в контракте его нет — владелец не зарегистрировал или отозвал. */
  registered: boolean;
};

export type SigningOverview = {
  mode: SignerMode;
  owner: Address;
  signerUrl: string | null;
  sessionKey: SessionKeyOverview | null;
  /** Может ли платформа прямо сейчас подписать платёж. */
  canPay: boolean;
};

export async function signingOverview(agent: Agent): Promise<SigningOverview> {
  const mode = agent.signerMode as SignerMode;
  const base = {
    mode,
    owner: agent.ownerAddress as Address,
    signerUrl: agent.signerUrl,
  };

  if (mode !== "SESSION_KEY") {
    // SERVER_KEY и REMOTE подписывают главным ключом — ключи платформы им не нужны.
    return {...base, sessionKey: null, canPay: true};
  }

  // Берём и неподтверждённый ключ тоже: владелец должен видеть, что от него ждут
  // транзакции, а не пустую карточку.
  const record = await latestSessionKeyRecord(agent);
  if (!record) {
    return {...base, sessionKey: null, canPay: false};
  }

  // Границы читаются из контракта: владелец мог изменить или отозвать ключ без нас.
  const onchain = await readSessionKey(
    agent.accountAddress as Address,
    record.address as Address,
  );

  return {
    ...base,
    sessionKey: {
      address: record.address as Address,
      budgetWei: onchain.budgetWei,
      spentWei: onchain.spentWei,
      remainingWei: onchain.budgetWei > onchain.spentWei ? onchain.budgetWei - onchain.spentWei : 0n,
      validUntil: new Date(onchain.validUntil * 1000),
      targetsRestricted: onchain.targetsRestricted,
      registered: onchain.exists,
    },
    canPay: onchain.exists,
  };
}

export type GasOutlook = {
  /** Примерная стоимость одной операции при текущей цене газа. */
  operationCostWei: bigint;
  /** Сколько операций кошелёк ещё потянет. */
  operationsLeft: number;
  /** Хватает ли средств хотя бы на одну. */
  enough: boolean;
};

/**
 * Два порога вместо одного баланса.
 *
 * Кошелёк платит за газ сам — своим депозитом в EntryPoint или балансом. Поэтому
 * непустой баланс ещё не значит, что операция пройдёт, и агенту нужно видеть отдельно
 * «хватит на газ».
 */
export async function gasOutlook(state: {
  balanceWei: bigint;
  gasDepositWei: bigint;
}): Promise<GasOutlook> {
  const {costWei} = await estimatePaymentCost();
  const available = state.balanceWei + state.gasDepositWei;

  return {
    operationCostWei: costWei,
    operationsLeft: costWei === 0n ? 0 : Number(available / costWei),
    enough: available >= costWei,
  };
}
