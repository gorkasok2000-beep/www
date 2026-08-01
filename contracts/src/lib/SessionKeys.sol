// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {BaseAccount} from "@account-abstraction/contracts/core/BaseAccount.sol";

/**
 * @title SessionKeys
 * @notice Ограниченные ключи подписи: платформа действует от имени агента, но только
 *         в выданных владельцем границах.
 *
 * @dev Смысл в том, чтобы владелец кошелька не отдавал никому главный ключ. Вместо этого
 *      он регистрирует отдельный ключ со сроком, бюджетом и (по желанию) списком получателей.
 *      Компрометация того, кто держит session key, стоит бюджета ключа, а не всех средств.
 *
 *      Все проверки выполняются на фазе ВАЛИДАЦИИ UserOperation, а не исполнения:
 *
 *      1. так операция отбраковывается бандлером до попадания в блок и не жжёт газ;
 *      2. так исключён подвох с несколькими операциями одного кошелька в одном бандле —
 *         EntryPoint валидирует всю пачку и только потом исполняет её, поэтому «кто
 *         подписал текущую операцию», сохранённое между фазами (хоть в transient storage),
 *         к моменту исполнения уже относилось бы к последней провалидированной операции.
 *
 *      Следствие: бюджет списывается при валидации. Если операция потом развалится на
 *      исполнении, потраченное из бюджета не возвращается — как и газ. Это осознанный
 *      выбор в пользу простоты и безопасности.
 *
 *      Ограничение области видимости: ключ считает только ETH, переданный в `value`.
 *      Переводы ERC-20 идут внутри calldata и этим бюджетом не покрываются — для них
 *      понадобится разбор вызова токена, это отдельная задача.
 */
library SessionKeys {
    /**
     * @param validAfter        не раньше этого времени (0 — сразу)
     * @param validUntil        не позже; 0 означает, что ключа нет — вечных ключей не бывает
     * @param budgetWei         сколько всего разрешено потратить этим ключом
     * @param spentWei          сколько уже потрачено
     * @param targetsRestricted платить можно только адресам из списка ключа
     */
    struct Key {
        uint48 validAfter;
        uint48 validUntil;
        uint128 budgetWei;
        uint128 spentWei;
        bool targetsRestricted;
    }

    error SessionBudgetExceeded(uint256 requestedWei, uint256 remainingWei);
    error SessionTargetNotAllowed(address target);
    error SessionCallNotAllowed(bytes4 selector);
    error SessionKeyNeedsExpiry();
    error SessionKeyNeedsBudget();

    /// @notice Ключ зарегистрирован и не отозван.
    function exists(Key storage key) internal view returns (bool) {
        return key.validUntil != 0;
    }

    /// @notice Остаток бюджета ключа.
    function remaining(Key storage key) internal view returns (uint256) {
        return key.budgetWei > key.spentWei ? key.budgetWei - key.spentWei : 0;
    }

    /// @notice Списывает трату из бюджета ключа; при нехватке откатывает операцию.
    function consume(Key storage key, uint256 valueWei) internal {
        uint256 left = remaining(key);
        require(valueWei <= left, SessionBudgetExceeded(valueWei, left));

        // Приведение безопасно: valueWei <= left <= budgetWei, а бюджет — uint128.
        // forge-lint: disable-next-line(unsafe-typecast)
        key.spentWei = key.spentWei + uint128(valueWei);
    }

    // ---------------------------------------------------------------------
    // Разбор callData операции
    // ---------------------------------------------------------------------

    /**
     * @notice Достаёт из callData список вызовов, которые собирается сделать кошелёк.
     * @dev Session key имеет право ровно на два метода — `execute` и `executeBatch`.
     *      Любой другой вызов (смена правил, вывод депозита, апгрейд, регистрация
     *      новых ключей) для него закрыт: иначе ограниченный ключ смог бы расширить
     *      сам себя. Владельцу этот разбор не нужен — у него полные права.
     */
    function decodeCalls(bytes calldata callData) internal pure returns (BaseAccount.Call[] memory calls) {
        require(callData.length >= 4, SessionCallNotAllowed(bytes4(0)));
        bytes4 selector = bytes4(callData[:4]);

        if (selector == BaseAccount.execute.selector) {
            (address target, uint256 value, bytes memory data) =
                abi.decode(callData[4:], (address, uint256, bytes));

            calls = new BaseAccount.Call[](1);
            calls[0] = BaseAccount.Call({target: target, value: value, data: data});
            return calls;
        }

        if (selector == BaseAccount.executeBatch.selector) {
            return abi.decode(callData[4:], (BaseAccount.Call[]));
        }

        revert SessionCallNotAllowed(selector);
    }
}
