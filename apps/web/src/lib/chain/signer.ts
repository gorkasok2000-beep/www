import {recoverAddress, type Address, type Hex} from "viem";
import {privateKeyToAccount} from "viem/accounts";

import {AgentError} from "@/lib/agent-error";

/**
 * Кто и чем подписывает операции агента.
 *
 * Раньше подпись была одним выражением в `userOperation.ts`: платформа брала приватный
 * ключ агента из базы и подписывала им что угодно. Это удобно и опасно — компрометация
 * сервера означала потерю всех средств всех агентов.
 *
 * Здесь подпись становится сменным механизмом. Вызывающий код (сборка UserOperation,
 * оплата, релей) знает только про `Signer` и не знает, где лежит ключ и лежит ли он у
 * нас вообще. Это тот шов, вокруг которого идёт уход от серверного хранения ключей:
 *
 *   SERVER_KEY  — главный ключ агента у платформы. Прототипный режим, остаётся для
 *                 локальной разработки и совместимости с уже созданными агентами.
 *   SESSION_KEY — у платформы ключ с бюджетом, сроком и списком получателей, выданный
 *                 владельцем через `AgentAccount.registerSessionKey`. Главный ключ у
 *                 агента. Компрометация платформы стоит остатка бюджета, а не всего.
 *   REMOTE      — ключа у платформы нет вовсе: хеш операции уходит агенту, тот
 *                 возвращает подпись. Максимум безопасности, требует доступного эндпоинта.
 */
export const SIGNER_MODES = ["SERVER_KEY", "SESSION_KEY", "REMOTE"] as const;
export type SignerMode = (typeof SIGNER_MODES)[number];

export interface Signer {
  readonly mode: SignerMode;
  /** Адрес, который должен получиться при восстановлении подписи. */
  readonly address: Address;
  sign(userOpHash: Hex): Promise<Hex>;
}

/**
 * Подпись локальным приватным ключом.
 *
 * Используется и для главного ключа агента (SERVER_KEY), и для session key: механика
 * одна, разный только объём прав, который за ключом стоит. Разделены они не типом
 * подписи, а тем, что контракт разрешает предъявителю.
 */
export function localSigner(privateKey: Hex, mode: SignerMode = "SERVER_KEY"): Signer {
  const account = privateKeyToAccount(privateKey);

  return {
    mode,
    address: account.address,
    sign: (userOpHash) => account.sign({hash: userOpHash}),
  };
}

/**
 * Подпись на стороне агента.
 *
 * Платформа отправляет POST на `url` с хешом операции и получает подпись. Ключа у неё
 * при этом нет — в этом весь смысл режима.
 *
 * Ответ проверяется: восстановленный из подписи адрес должен совпасть с ожидаемым
 * владельцем. Без этой проверки компрометация эндпоинта (или подмена ответа в пути)
 * позволила бы подсунуть подпись чужого ключа — контракт бы её отверг, но уже после
 * траты газа и с невнятной ошибкой AA24.
 */
export function remoteSigner(params: {
  url: string;
  address: Address;
  timeoutMs?: number;
}): Signer {
  return {
    mode: "REMOTE",
    address: params.address,

    async sign(userOpHash: Hex): Promise<Hex> {
      const response = await fetch(params.url, {
        method: "POST",
        headers: {"content-type": "application/json"},
        body: JSON.stringify({userOpHash, owner: params.address}),
        // Редиректы не обслуживаем: иначе проверку signerUrl на SSRF можно было бы
        // обойти ответом 302 на внутренний адрес.
        redirect: "manual",
        signal: AbortSignal.timeout(params.timeoutMs ?? 10_000),
      }).catch((error: unknown) => {
        throw new AgentError(
          `Не удалось получить подпись у агента (${params.url}): ${String(error)}`,
          502,
        );
      });

      if (response.type === "opaqueredirect" || (response.status >= 300 && response.status < 400)) {
        throw new AgentError("Эндпоинт подписи агента ответил редиректом — это запрещено.", 502);
      }

      if (!response.ok) {
        throw new AgentError(
          `Эндпоинт подписи агента ответил ${response.status}.`,
          502,
        );
      }

      const body = (await response.json().catch(() => ({}))) as {signature?: unknown};
      const signature = body.signature;
      if (typeof signature !== "string" || !/^0x[0-9a-fA-F]{130}$/.test(signature)) {
        throw new AgentError(
          "Эндпоинт подписи агента должен вернуть {\"signature\": \"0x…\"} длиной 65 байт.",
          502,
        );
      }

      const recovered = await recoverAddress({hash: userOpHash, signature: signature as Hex});
      if (recovered.toLowerCase() !== params.address.toLowerCase()) {
        throw new AgentError(
          `Подпись принадлежит ${recovered}, а владелец кошелька — ${params.address}.`,
          502,
        );
      }

      return signature as Hex;
    },
  };
}
