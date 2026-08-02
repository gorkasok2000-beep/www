import {parseAbiItem, type Address} from "viem";

import {db} from "@/lib/db";
import {serverEnv} from "@/lib/env";

import {publicClient} from "./clients";

/**
 * Индексатор публичного лога.
 *
 * Событие `AgentTransaction` эмитит сам кошелёк, поэтому фильтр по одной теме собирает
 * траты всех агентов сразу — знать список кошельков заранее не нужно. Тема при этом
 * проверяет только сигнатуру события, но не эмитента: чужой контракт может выпустить
 * такое же событие от имени нашего кошелька. Поэтому каждый лог дополнительно сверяется
 * по `log.address` — иначе поддельная трата попадала бы в кэш и на витрину. Результат
 * складывается в SQLite, чтобы дашборд и витрина не дёргали ноду на каждый рендер.
 *
 * Курсор устроен так, чтобы кэш сходился после реорга: каждый проход перечитывает хвост
 * глубиной `CONFIRMATION_BLOCKS`, и записи, которых в свежих логах больше нет,
 * удаляются. Без этого осиротевшая трата висела бы на витрине вечно — событие из
 * вытесненного блока уже в кэше, а перечитать этот блок было нечем.
 */
const AGENT_TRANSACTION_EVENT = parseAbiItem(
  "event AgentTransaction(address indexed account, address indexed to, uint256 value, bytes4 selector, uint256 timestamp)",
);

/** Ограничение размера окна: публичные RPC не любят запросы на весь диапазон блоков. */
const MAX_BLOCK_RANGE = 5_000n;

export type SyncResult = {indexed: number; removed: number; toBlock: bigint};

/**
 * @param options.rebuild полный пересбор кэша с нуля — то самое «очистить кэш», которое
 *        README обещает при расхождении с блокчейном
 */
export async function syncTransactionLogs(
  options: {rebuild?: boolean} = {},
): Promise<SyncResult> {
  const client = publicClient();
  const depth = serverEnv.confirmationBlocks();

  // cacheTime: 0 обязателен. По умолчанию viem кэширует номер блока на время
  // pollingInterval, и сразу после отправки транзакции мы получали бы устаревшую
  // голову — курсор индексатора застревал бы, а свежие траты не попадали в ленту.
  const head = await client.getBlockNumber({cacheTime: 0});

  if (options.rebuild) {
    await db.transactionLog.deleteMany({});
    await db.indexerState.deleteMany({});
  }

  const state = options.rebuild
    ? null
    : await db.indexerState.findUnique({where: {id: "default"}});

  // Старт сдвигается назад: хвост цепи перечитывается каждый раз, потому что именно там
  // события могут исчезнуть. Повторное чтение безопасно — записи уникальны по
  // `txHash + logIndex`.
  //
  // Отдельный случай — курсор за головой. Это значит, что цепь укоротилась (реорг
  // глубже, чем мы успели прочитать); тогда перечитывать нужно не только глубину
  // подтверждений, но и всё исчезнувшее, иначе осиротевшие записи останутся вне окна.
  const last = state ? BigInt(state.lastBlockNumber) : -1n;
  const shrunk = last > head ? last - head : 0n;
  const rewind = depth + shrunk;
  const anchor = last > head ? head : last;
  const fromBlock = anchor + 1n > rewind ? anchor + 1n - rewind : 0n;

  if (fromBlock > head) {
    return {indexed: 0, removed: 0, toBlock: head};
  }

  const toBlock = fromBlock + MAX_BLOCK_RANGE > head ? head : fromBlock + MAX_BLOCK_RANGE;
  const logs = await client.getLogs({event: AGENT_TRANSACTION_EVENT, fromBlock, toBlock});

  /** Что реально есть в цепи в перечитанном диапазоне — по нему ищем осиротевшее. */
  const alive = new Set<string>();
  let indexed = 0;

  for (const log of logs) {
    const account = log.args.account as Address;

    // Событие обязан эмитить сам кошелёк: фильтр по topic0 пропустил бы и поддельный
    // AgentTransaction, выпущенный чужим контрактом от имени нашего агента.
    if (log.address.toLowerCase() !== account.toLowerCase()) {
      continue;
    }

    const agent = await db.agent.findUnique({where: {accountAddress: account}});
    if (!agent) {
      continue; // кошелёк создан в обход нашего API — на витрину такие не попадают
    }

    alive.add(`${log.transactionHash}:${log.logIndex}`);
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

  const removed = await dropOrphaned(fromBlock, toBlock, alive);

  await db.indexerState.upsert({
    where: {id: "default"},
    create: {id: "default", lastBlockNumber: toBlock.toString()},
    update: {lastBlockNumber: toBlock.toString()},
  });

  return {indexed, removed, toBlock};
}

/**
 * Удаляет записи перечитанного диапазона, которых в свежих логах не оказалось.
 *
 * Это и есть обработка реорга на стороне витрины: блок вытеснен, событие исчезло,
 * значит трата не состоялась и показывать её нельзя.
 */
async function dropOrphaned(
  fromBlock: bigint,
  toBlock: bigint,
  alive: Set<string>,
): Promise<number> {
  // Номера блоков хранятся строками, поэтому диапазон отбираем в коде, а не запросом:
  // строковое сравнение «10» < «9» дало бы неверную выборку.
  const cached = await db.transactionLog.findMany({
    select: {id: true, txHash: true, logIndex: true, blockNumber: true},
    orderBy: {timestamp: "desc"},
    take: 1000,
  });

  const orphaned = cached.filter((row) => {
    const block = BigInt(row.blockNumber);
    if (block < fromBlock || block > toBlock) {
      return false;
    }
    return !alive.has(`${row.txHash}:${row.logIndex}`);
  });

  if (orphaned.length === 0) {
    return 0;
  }

  await db.transactionLog.deleteMany({where: {id: {in: orphaned.map((row) => row.id)}}});
  return orphaned.length;
}
