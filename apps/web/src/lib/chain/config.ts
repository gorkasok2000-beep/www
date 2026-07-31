import {existsSync, readFileSync} from "node:fs";
import {join} from "node:path";

import {arbitrumSepolia, baseSepolia, foundry, type Chain} from "viem/chains";

import {CHAIN_ID} from "@/lib/env";

/** Сети, с которыми умеет работать прототип. Мейннета среди них нет намеренно. */
const CHAINS: Record<number, Chain> = {
  [foundry.id]: foundry,
  [baseSepolia.id]: baseSepolia,
  [arbitrumSepolia.id]: arbitrumSepolia,
};

export function activeChain(): Chain {
  const chain = CHAINS[CHAIN_ID];
  if (!chain) {
    throw new Error(
      `Сеть ${CHAIN_ID} не поддерживается. Доступны: ${Object.keys(CHAINS).join(", ")}.`,
    );
  }
  return chain;
}

export type Deployment = {
  chainId: number;
  entryPoint: `0x${string}`;
  factory: `0x${string}`;
  registry: `0x${string}`;
  admin: `0x${string}`;
};

let cached: Deployment | undefined;

/**
 * Адреса контрактов берутся из `contracts/deployments/<chainId>.json`, который
 * пишет `forge script Deploy`. Так фронтенд и API всегда смотрят на тот же стенд,
 * что был задеплоен последним, без ручного копирования адресов.
 */
export function deployment(): Deployment {
  if (cached) {
    return cached;
  }

  const path = join(process.cwd(), "..", "..", "contracts", "deployments", `${CHAIN_ID}.json`);
  if (!existsSync(path)) {
    throw new Error(
      `Нет файла деплоя ${path}. Запустите anvil и \`pnpm deploy:local\` из корня репозитория.`,
    );
  }

  cached = JSON.parse(readFileSync(path, "utf8")) as Deployment;
  return cached;
}
