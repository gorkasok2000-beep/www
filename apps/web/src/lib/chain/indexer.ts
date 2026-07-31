import {parseAbiItem, type Address} from "viem";

import {db} from "@/lib/db";

import {publicClient} from "./clients";

/**
 * Индексатор публичного лога.
 *
 * Событие `AgentTransaction` эмитит сам кошелёк, поэтому фильтр по одной теме собирает
 * траты всех агентов сразу — знать список кошельков заранее не нужно. Результат
 * складывается в SQLite, чтобы дашборд и витрина не дёргали ноду на каждый рендер.
 * Источником истины остаётся блокчейн: при расхождении достаточно очистить кэш.
 */
const AGENT_TRANSACTION_EVENT = parseAbiItem(
  "event AgentTransaction(address indexed account, address indexed to, uint256 value, bytes4 selector, uint256 timestamp)",
);

/** Ограничение размера окна: публичные RPC не любят запросы на весь диапазон блоков. */
const MAX_BLOCK_RANGE = 5_000n;

export async function syncTransactionLogs(): Promise<{indexed: number; toBlock: bigint}> {
  const client = publicClient();

  // cacheTime: 0 обязателен. По умолчанию viem кэширует номер блока на время
  // pollingInterval, и сразу после отправки транзакции мы получали бы устаревшую
  // голову — курсор индексатора застревал бы, а свежие траты не попадали в ленту.
  const head = await client.getBlockNumber({cacheTime: 0});

  const state = await db.indexerState.findUnique({where: {id: "default"}});
  const fromBlock = state ? BigInt(state.lastBlockNumber) + 1n : 0n;

  if (fromBlock > head) {
    return {indexed: 0, toBlock: head};
  }

  const toBlock = fromBlock + MAX_BLOCK_RANGE > head ? head : fromBlock + MAX_BLOCK_RANGE;

  const logs = await client.getLogs({event: AGENT_TRANSACTION_EVENT, fromBlock, toBlock});

  let indexed = 0;
  for (const log of logs) {
    const account = log.args.account as Address;
    const agent = await db.agent.findUnique({where: {accountAddress: account}});
    if (!agent) {
      continue; // кошелёк создан в обход нашего API — на витрину такие не попадают
    }

    await db.transactionLog.upsert({
      where: {txHash_logIndex: {txHash: log.transactionHash, logIndex: log.logIndex}},
      create: {
        agentId: agent.id,
        accountAddress: account,
        to: log.args.to as Address,
        valueWei: (log.args.value as bigint).toString(),
        selector: log.args.selector as string,
        txHash: log.transactionHash,
        blockNumber: log.blockNumber.toString(),
        timestamp: new Date(Number(log.args.timestamp as bigint) * 1000),
        logIndex: log.logIndex,
      },
      update: {},
    });
    indexed++;
  }

  await db.indexerState.upsert({
    where: {id: "default"},
    create: {id: "default", lastBlockNumber: toBlock.toString()},
    update: {lastBlockNumber: toBlock.toString()},
  });

  return {indexed, toBlock};
}
