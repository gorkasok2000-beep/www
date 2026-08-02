#!/usr/bin/env node
/**
 * Заглушка ERC-4337 бандлера для сквозной проверки.
 *
 * Зачем. `RpcBundler` в `apps/web/src/lib/chain/relayer.ts` написан давно и до сих пор ни
 * разу не исполнялся: весь путь `pnpm e2e` идёт через `LocalHandleOpsBundler`, который
 * зовёт `EntryPoint.handleOps` изнутри приложения. То есть код, который поедет в тестовую
 * сеть, не проверен вообще — а именно в нём живёт перебор эндпоинтов и различение
 * «бандлер отверг» и «до бандлера не достучались».
 *
 * Что это. Настоящий JSON-RPC-сервер с методами `eth_sendUserOperation`,
 * `eth_getUserOperationReceipt` и `eth_estimateUserOperationGas`. Внутри — тот же
 * `handleOps` от EOA оператора: для EntryPoint это ровно тот же путь исполнения, что и
 * у настоящего бандлера. Пула и симуляции по ERC-7562 здесь нет — они не нужны, чтобы
 * проверить клиентскую половину.
 *
 * Режим `reject` заставляет заглушку отвечать JSON-RPC-ошибкой: так проверяется, что
 * отвергнутая операция НЕ уезжает к следующему бандлеру в списке.
 */
import {createServer} from "node:http";

import {concatHex, createPublicClient, createWalletClient, http, numberToHex, pad, parseAbi} from "viem";
import {privateKeyToAccount} from "viem/accounts";
import {foundry} from "viem/chains";

const ENTRY_POINT_ABI = parseAbi([
  "struct PackedUserOperation { address sender; uint256 nonce; bytes initCode; bytes callData; bytes32 accountGasLimits; uint256 preVerificationGas; bytes32 gasFees; bytes paymasterAndData; bytes signature; }",
  "function handleOps(PackedUserOperation[] ops, address beneficiary)",
  "function getUserOpHash(PackedUserOperation userOp) view returns (bytes32)",
]);

/**
 * Обратная сборка PackedUserOperation из «распакованного» формата JSON-RPC.
 *
 * Бандлеры принимают операцию плоской, контракт — с упакованными парами uint128 в
 * bytes32. Порядок внутри пар важен: старшая половина `accountGasLimits` — это
 * verification, старшая половина `gasFees` — приоритетная комиссия.
 */
function pack(op) {
  const half = (value) => pad(numberToHex(BigInt(value)), {size: 16});

  return {
    sender: op.sender,
    nonce: BigInt(op.nonce),
    initCode: op.initCode ?? "0x",
    callData: op.callData,
    accountGasLimits: concatHex([half(op.verificationGasLimit), half(op.callGasLimit)]),
    preVerificationGas: BigInt(op.preVerificationGas),
    gasFees: concatHex([half(op.maxPriorityFeePerGas), half(op.maxFeePerGas)]),
    paymasterAndData: op.paymasterAndData ?? "0x",
    signature: op.signature,
  };
}

/**
 * @param {object} options
 * @param {number} options.port
 * @param {`0x${string}`} options.entryPoint
 * @param {`0x${string}`} options.privateKey ключ EOA, который шлёт handleOps
 * @param {"accept"|"reject"} [options.mode] `reject` — отвечать JSON-RPC-ошибкой
 * @param {string} [options.rpcUrl]
 */
export async function startStubBundler({port, entryPoint, privateKey, mode = "accept", rpcUrl}) {
  const url = rpcUrl ?? "http://127.0.0.1:8545";
  const account = privateKeyToAccount(privateKey);
  const pub = createPublicClient({chain: foundry, transport: http(url)});
  const wallet = createWalletClient({account, chain: foundry, transport: http(url)});

  /** userOpHash -> txHash. Настоящий бандлер держит то же самое, только в своём хранилище. */
  const receipts = new Map();
  const seen = [];

  const server = createServer((request, response) => {
    let raw = "";
    request.on("data", (chunk) => (raw += chunk));
    request.on("end", async () => {
      let id = 1;
      const reply = (payload) => {
        response.writeHead(200, {"content-type": "application/json"});
        response.end(JSON.stringify({jsonrpc: "2.0", id, ...payload}));
      };

      try {
        const {method, params, id: requestId} = JSON.parse(raw);
        id = requestId ?? 1;
        seen.push(method);

        if (mode === "reject") {
          // Так выглядит отказ настоящего бандлера: операция рассмотрена и не принята.
          reply({error: {code: -32500, message: "AA24 signature error"}});
          return;
        }

        if (method === "eth_estimateUserOperationGas") {
          reply({
            result: {
              callGasLimit: numberToHex(300_000),
              verificationGasLimit: numberToHex(300_000),
              preVerificationGas: numberToHex(80_000),
            },
          });
          return;
        }

        if (method === "eth_sendUserOperation") {
          const op = pack(params[0]);
          const userOpHash = await pub.readContract({
            address: entryPoint,
            abi: ENTRY_POINT_ABI,
            functionName: "getUserOpHash",
            args: [op],
          });

          const txHash = await wallet.writeContract({
            address: entryPoint,
            abi: ENTRY_POINT_ABI,
            functionName: "handleOps",
            args: [[op], account.address],
          });
          await pub.waitForTransactionReceipt({hash: txHash});

          receipts.set(userOpHash, txHash);
          reply({result: userOpHash});
          return;
        }

        if (method === "eth_getUserOperationReceipt") {
          const txHash = receipts.get(params[0]);
          reply({result: txHash ? {receipt: {transactionHash: txHash}} : null});
          return;
        }

        reply({error: {code: -32601, message: `Метод ${method} заглушкой не поддержан`}});
      } catch (error) {
        // Ошибка самой заглушки — не отказ бандлера; отдаём 500, чтобы клиент счёл
        // эндпоинт недоступным, а не операцию отвергнутой.
        response.writeHead(500, {"content-type": "application/json"});
        response.end(JSON.stringify({error: String(error)}));
      }
    });
  });

  await new Promise((resolve) => server.listen(port, "127.0.0.1", resolve));

  return {
    url: `http://127.0.0.1:${port}`,
    calls: seen,
    close: () => new Promise((resolve) => server.close(resolve)),
  };
}
