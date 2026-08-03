/**
 * Юнит-тесты лимитера — голый `node --test`, без Next.js и базы: модуль
 * `ratelimit.ts` ничего не импортирует из проекта именно ради этой изоляции.
 *
 * Время везде передаётся параметром `now`, поэтому тесты не спят и не зависят от
 * реальных часов.
 *
 * Запуск: pnpm --filter web test
 */
import assert from "node:assert/strict";
import {test} from "node:test";

import {
  checkLimit,
  clearAuthFailures,
  configureAuthLockout,
  isLockedOut,
  recordAuthFailure,
  resetForTests,
  sizeForTests,
} from "./ratelimit";

test("скользящее окно: запросы сверх лимита отклоняются, окно сдвигается", () => {
  resetForTests();
  const t0 = 1_000_000;

  assert.equal(checkLimit("k", 3, 1000, t0).ok, true);
  assert.equal(checkLimit("k", 3, 1000, t0 + 100).ok, true);
  assert.equal(checkLimit("k", 3, 1000, t0 + 200).ok, true);

  // Лимит исчерпан: четвёртый запрос в том же окне отклонён.
  assert.equal(checkLimit("k", 3, 1000, t0 + 300).ok, false);

  // Окно сдвинулось за самый старый запрос — можно снова.
  assert.equal(checkLimit("k", 3, 1000, t0 + 1001).ok, true);
});

test("Retry-After — время до выхода самого старого запроса из окна", () => {
  resetForTests();
  const t0 = 2_000_000;

  checkLimit("k", 1, 10_000, t0);
  const denied = checkLimit("k", 1, 10_000, t0 + 1500);

  assert.equal(denied.ok, false);
  // (10 000 - 1500) / 1000 = 8.5 → округление вверх, чтобы не соврать в меньшую сторону.
  assert.equal(denied.retryAfterSec, 9);

  // Отклонённый запрос сам в окно не попал: лимит всё ещё занят первым запросом.
  const stillDenied = checkLimit("k", 1, 10_000, t0 + 1600);
  assert.equal(stillDenied.ok, false);
  assert.equal(stillDenied.retryAfterSec, 9);
});

test("ключи независимы: лимит одного не трогает другой", () => {
  resetForTests();
  const t0 = 2_500_000;

  checkLimit("a", 1, 1000, t0);
  assert.equal(checkLimit("a", 1, 1000, t0).ok, false);
  assert.equal(checkLimit("b", 1, 1000, t0).ok, true);
});

test("lockout: threshold неудач блокирует IP, успех сбрасывает счётчик", () => {
  resetForTests();
  configureAuthLockout({threshold: 3, windowMs: 60_000, durationMs: 900_000});
  const t0 = 3_000_000;

  recordAuthFailure("1.2.3.4", t0);
  recordAuthFailure("1.2.3.4", t0 + 1);
  assert.equal(isLockedOut("1.2.3.4", t0 + 2), 0);

  // Успешная аутентификация между неудачами — счётчик обнуляется.
  clearAuthFailures("1.2.3.4");
  recordAuthFailure("1.2.3.4", t0 + 3);
  recordAuthFailure("1.2.3.4", t0 + 4);
  assert.equal(isLockedOut("1.2.3.4", t0 + 5), 0);

  // Третья неудача подряд — блокировка на всю длительность.
  recordAuthFailure("1.2.3.4", t0 + 6);
  const retry = isLockedOut("1.2.3.4", t0 + 7);
  assert.ok(retry > 0, "IP заблокирован");
  assert.ok(retry <= 900, "Retry-After не превышает длительность блока");

  // Другой IP не затронут.
  assert.equal(isLockedOut("2.3.4.5", t0 + 7), 0);

  // После окончания блока — снова 0.
  assert.equal(isLockedOut("1.2.3.4", t0 + 7 + 900_001), 0);
});

test("неудачи старше окна подсчёта не приводят к блокировке", () => {
  resetForTests();
  configureAuthLockout({threshold: 2, windowMs: 1000, durationMs: 60_000});
  const t0 = 4_000_000;

  recordAuthFailure("1.1.1.1", t0);
  // Первая неудача уже вышла из окна — это снова первая.
  recordAuthFailure("1.1.1.1", t0 + 2000);
  assert.equal(isLockedOut("1.1.1.1", t0 + 2001), 0);
});

test("периодическая чистка вытесняет устаревшие ключи из всех таблиц", () => {
  resetForTests();
  configureAuthLockout({threshold: 5, windowMs: 1000, durationMs: 5000});
  const t0 = 5_000_000;

  checkLimit("old", 10, 1000, t0);
  recordAuthFailure("9.9.9.9", t0);
  assert.deepEqual(sizeForTests(), {buckets: 1, authFailures: 1, lockouts: 0});

  // Спустя больше интервала чистки (60с) и ширины всех окон любое обращение
  // запускает sweep: протухшие записи исчезают, свежая остаётся.
  checkLimit("new", 10, 1000, t0 + 61_001);
  assert.deepEqual(sizeForTests(), {buckets: 1, authFailures: 0, lockouts: 0});
});

test("мастер-выключатель: при enabled=false лимиты и блокировки — no-op", () => {
  resetForTests();
  configureAuthLockout({enabled: false, threshold: 1, windowMs: 1000, durationMs: 1000});
  const t0 = 6_000_000;

  assert.equal(checkLimit("k", 1, 1000, t0).ok, true);
  assert.equal(checkLimit("k", 1, 1000, t0).ok, true);

  recordAuthFailure("1.2.3.4", t0);
  assert.equal(isLockedOut("1.2.3.4", t0), 0);
});
