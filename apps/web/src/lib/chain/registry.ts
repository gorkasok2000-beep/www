import {formatEther, type Address, type Hex} from "viem";

import {agentAccountAbi, agentRegistryAbi} from "./abis";
import {custodianClient, operatorClient, publicClient} from "./clients";
import {activeChain, deployment} from "./config";

/** Правила трат в том виде, в каком их принимает контракт. */
export type RulesInput = {
  limitWei: bigint;
  periodSeconds: bigint;
  whitelistEnabled: boolean;
};

export const NO_RULES: RulesInput = {
  limitWei: 0n,
  periodSeconds: 0n,
  whitelistEnabled: false,
};

/**
 * Регистрация агента в реестре. Газ платит оператор платформы: у нового агента
 * ещё нет средств, а требовать их до создания кошелька — то самое трение, которого
 * проект как раз избегает.
 */
export async function registerAgentOnchain(params: {
  handle: string;
  owner: Address;
  custodian: Address;
  rules: RulesInput;
  whitelist: Address[];
  salt: bigint;
}): Promise<{account: Address; txHash: Hex}> {
  const {registry} = deployment();
  const client = operatorClient();

  const args = [
    params.handle,
    params.owner,
    params.custodian,
    params.rules,
    params.whitelist,
    params.salt,
  ] as const;

  // Симуляция даёт адрес будущего кошелька и заранее ловит понятную ошибку контракта
  // (занятый handle, правила без кастодиана) — до траты газа.
  const {result: account} = await publicClient().simulateContract({
    account: client.account!,
    address: registry,
    abi: agentRegistryAbi,
    functionName: "registerAgent",
    args,
  });

  const txHash = await client.writeContract({
    account: client.account!,
    chain: activeChain(),
    address: registry,
    abi: agentRegistryAbi,
    functionName: "registerAgent",
    args,
  });

  await publicClient().waitForTransactionReceipt({hash: txHash});

  return {account, txHash};
}

/**
 * Сухой прогон траты перед отправкой UserOperation.
 *
 * Симуляция идёт от адреса владельца — `AgentAccount` разрешает этот путь наравне с
 * EntryPoint, поэтому проверяются ровно те же правила. Так агент получает внятный
 * отказ («превышен лимит») вместо потраченного газа и молчаливого revert внутри
 * фазы исполнения ERC-4337.
 */
export async function simulateExecute(params: {
  account: Address;
  owner: Address;
  to: Address;
  valueWei: bigint;
  data: Hex;
}): Promise<void> {
  await publicClient().simulateContract({
    account: params.owner,
    address: params.account,
    abi: agentAccountAbi,
    functionName: "execute",
    args: [params.to, params.valueWei, params.data],
  });
}

/** Замораживает/размораживает кошелёк. Доступно только владельцу реестра. */
export async function setAgentFrozen(account: Address, frozen: boolean): Promise<Hex> {
  const {registry} = deployment();
  const client = operatorClient();

  const txHash = await client.writeContract({
    account: client.account!,
    chain: activeChain(),
    address: registry,
    abi: agentRegistryAbi,
    functionName: "setFrozen",
    args: [account, frozen],
  });

  await publicClient().waitForTransactionReceipt({hash: txHash});
  return txHash;
}

export type OnchainAgentState = {
  balanceWei: bigint;
  balanceEth: string;
  gasDepositWei: bigint;
  frozen: boolean;
  custodian: Address;
  rules: RulesInput;
  spendingRemainingWei: bigint;
};

/** Полное состояние кошелька одним batched-запросом к ноде. */
export async function readAgentState(account: Address): Promise<OnchainAgentState> {
  const client = publicClient();
  const contract = {address: account, abi: agentAccountAbi} as const;

  const [balanceWei, frozen, custodian, rules, spendingRemaining, gasDeposit] = await Promise.all([
    client.getBalance({address: account}),
    client.readContract({...contract, functionName: "frozen"}),
    client.readContract({...contract, functionName: "custodian"}),
    client.readContract({...contract, functionName: "rules"}),
    client.readContract({...contract, functionName: "spendingRemaining"}),
    client.readContract({...contract, functionName: "getDeposit"}),
  ]);

  return {
    balanceWei,
    balanceEth: formatEther(balanceWei),
    gasDepositWei: gasDeposit,
    frozen,
    custodian,
    rules: {
      limitWei: rules[0],
      periodSeconds: BigInt(rules[1]),
      whitelistEnabled: rules[2],
    },
    spendingRemainingWei: spendingRemaining,
  };
}

/** Обновление правил кастодианом. Подписывается ключом кастодиана, не агента. */
export async function updateRulesOnchain(params: {
  account: Address;
  custodianPrivateKey: Hex;
  rules: RulesInput;
}): Promise<Hex> {
  const client = custodianClient(params.custodianPrivateKey);
  await ensureGasAllowance(client.account!.address);

  const txHash = await client.writeContract({
    account: client.account!,
    chain: activeChain(),
    address: params.account,
    abi: agentAccountAbi,
    functionName: "setRules",
    args: [params.rules],
  });

  await publicClient().waitForTransactionReceipt({hash: txHash});
  return txHash;
}

/** Точечное изменение whitelist кастодианом. */
export async function setWhitelistedOnchain(params: {
  account: Address;
  custodianPrivateKey: Hex;
  target: Address;
  allowed: boolean;
}): Promise<Hex> {
  const client = custodianClient(params.custodianPrivateKey);
  await ensureGasAllowance(client.account!.address);

  const txHash = await client.writeContract({
    account: client.account!,
    chain: activeChain(),
    address: params.account,
    abi: agentAccountAbi,
    functionName: "setWhitelisted",
    args: [params.target, params.allowed],
  });

  await publicClient().waitForTransactionReceipt({hash: txHash});
  return txHash;
}

/**
 * Пополнение кошелька из тестового крана.
 *
 * В тестовой сети деньги ненастоящие, поэтому «депозит» в прототипе — это перевод
 * с кошелька оператора. В проде на этом месте будет обычный входящий перевод от
 * пользователя: контракт принимает ETH через `receive()` и никакого API не требует.
 */
export async function fundAccount(account: Address, valueWei: bigint): Promise<Hex> {
  const client = operatorClient();

  const txHash = await client.sendTransaction({
    account: client.account!,
    chain: activeChain(),
    to: account,
    value: valueWei,
  });

  await publicClient().waitForTransactionReceipt({hash: txHash});
  return txHash;
}

/**
 * Запас газа для кастодиана.
 *
 * Кастодиан — обычный EOA, и за изменение правил он платит газ сам. В прототипе этот
 * ключ создаёт сервер, так что средств на нём изначально нет: платформа выдаёт
 * небольшой запас и пополняет его по мере расхода. В проде, где кастодиан подключает
 * собственный кошелёк, этот механизм не нужен.
 */
const CUSTODIAN_GAS_ALLOWANCE = 5n * 10n ** 16n; // 0.05 ETH

async function ensureGasAllowance(address: Address): Promise<void> {
  const balance = await publicClient().getBalance({address});
  if (balance >= CUSTODIAN_GAS_ALLOWANCE / 2n) {
    return;
  }
  await fundAccount(address, CUSTODIAN_GAS_ALLOWANCE);
}

/** Проверяет, разрешён ли получатель, — для страницы правил. */
export async function readWhitelisted(account: Address, target: Address): Promise<boolean> {
  return publicClient().readContract({
    address: account,
    abi: agentAccountAbi,
    functionName: "whitelisted",
    args: [target],
  });
}
