// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

/**
 * @title SpendingRules
 * @notice Опциональные правила трат для режима Human Custodian: лимит суммы за скользящее
 *         окно времени и whitelist получателей.
 *
 * @dev Правила проверяются на фазе исполнения (`execute`), а не на фазе валидации UserOp:
 *      в фазе валидации ERC-7562 запрещает читать `block.timestamp`, а окно лимита без
 *      времени не построить. Для прототипа этого достаточно — превышение лимита откатывает
 *      всю операцию.
 *
 *      Окно — «прыгающее» (fixed window), а не истинно скользящее: первая трата после
 *      истечения периода открывает новое окно. Это самый предсказуемый для пользователя
 *      вариант и самый дешёвый по газу.
 */
library SpendingRules {
    /// @notice Настройки, задаваемые кастодианом.
    /// @param limitWei         максимум wei за период; 0 = без ограничения
    /// @param periodSeconds    длина окна; 0 = лимит применяется к каждой отдельной транзакции
    /// @param whitelistEnabled если true, платить можно только адресам из whitelist
    struct Config {
        uint128 limitWei;
        uint64 periodSeconds;
        bool whitelistEnabled;
    }

    /// @notice Состояние текущего окна расходов.
    struct Window {
        uint64 startedAt;
        uint128 spentWei;
    }

    error SpendLimitExceeded(uint256 requestedWei, uint256 remainingWei);

    /**
     * @notice Проверяет трату против лимита и, если лимит периодический, списывает её из окна.
     * @dev Вызывать только из фазы исполнения — использует `block.timestamp`.
     */
    function consume(Config storage config, Window storage window, uint256 valueWei) internal {
        uint128 limit = config.limitWei;
        if (limit == 0) {
            return; // лимит не настроен
        }

        uint64 period = config.periodSeconds;
        if (period == 0) {
            // Лимит на одну транзакцию: состояние окна не нужно.
            require(valueWei <= limit, SpendLimitExceeded(valueWei, limit));
            return;
        }

        uint64 nowTs = uint64(block.timestamp);
        uint128 spent = window.spentWei;
        if (window.startedAt == 0 || nowTs - window.startedAt >= period) {
            window.startedAt = nowTs;
            spent = 0;
        }

        uint256 left = limit > spent ? limit - spent : 0;
        require(valueWei <= left, SpendLimitExceeded(valueWei, left));

        // Безопасно: valueWei <= left <= limit, а limit — uint128.
        window.spentWei = spent + uint128(valueWei);
    }

    /// @notice Сколько ещё можно потратить в текущем окне (для дашборда).
    function remaining(Config storage config, Window storage window) internal view returns (uint256) {
        uint128 limit = config.limitWei;
        if (limit == 0) {
            return type(uint256).max; // без ограничения
        }

        uint64 period = config.periodSeconds;
        if (period == 0) {
            return limit;
        }

        uint64 startedAt = window.startedAt;
        if (startedAt == 0 || uint64(block.timestamp) - startedAt >= period) {
            return limit; // окно истекло — лимит обновится при следующей трате
        }

        uint128 spent = window.spentWei;
        return limit > spent ? limit - spent : 0;
    }
}
