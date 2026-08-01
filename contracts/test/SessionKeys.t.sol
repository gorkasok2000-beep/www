// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {BaseAccount} from "@account-abstraction/contracts/core/BaseAccount.sol";
import {IEntryPoint} from "@account-abstraction/contracts/interfaces/IEntryPoint.sol";
import {PackedUserOperation} from "@account-abstraction/contracts/interfaces/PackedUserOperation.sol";
import {IStakeManager} from "@account-abstraction/contracts/interfaces/IStakeManager.sol";
import {SimpleAccount} from "@account-abstraction/contracts/accounts/SimpleAccount.sol";
import {UUPSUpgradeable} from "@openzeppelin/contracts/proxy/utils/UUPSUpgradeable.sol";

import {SynthWalletTest} from "./SynthWalletTest.t.sol";
import {AgentAccount} from "../src/AgentAccount.sol";
import {SessionKeys} from "../src/lib/SessionKeys.sol";
import {SpendingRules} from "../src/lib/SpendingRules.sol";

/**
 * @notice Ключи ограниченного доступа: владелец кошелька выдаёт право платить от его имени,
 *         не отдавая главный ключ.
 *
 * @dev Проверяется не библиотека в вакууме, а поведение на настоящем пути ERC-4337 —
 *      операция подписывается session key и идёт через EntryPoint. Только так видно,
 *      на какой фазе срывается нарушение и что именно увидит бандлер:
 *
 *      - нарушение границ ключа (бюджет, получатель, разрешённый метод) — фаза валидации,
 *        `FailedOpWithRevert(0, "AA23 reverted", …)`, операция вообще не попадёт в блок;
 *      - срок действия ключа — тоже валидация, но проверяет его сам EntryPoint:
 *        `FailedOp(0, "AA22 expired or not due")`;
 *      - неизвестный или отозванный ключ неотличим от чужой подписи —
 *        `FailedOp(0, "AA24 signature error")`;
 *      - правила кастодиана — фаза исполнения, как и для владельца.
 */
contract SessionKeysTest is SynthWalletTest {
    /// @dev Держатель session key: платформа, отправляющая операции за агента.
    address internal platform;
    uint256 internal platformKey;

    uint48 internal constant KEY_LIFETIME = 1 days;

    function setUp() public override {
        super.setUp();
        (platform, platformKey) = makeAddrAndKey("platform");

        // Стартовое время anvil — 1 секунда от эпохи; для срока действия ключей нужны
        // осмысленные метки, иначе `validAfter` в прошлом просто некуда поместить.
        vm.warp(1_700_000_000);
    }

    // ------------------------------------------------------------------
    // Хелперы
    // ------------------------------------------------------------------

    /// @notice Выдаёт `platform` ключ с бюджетом и сроком «сутки от текущего момента».
    function _grant(AgentAccount account, uint128 budgetWei, address[] memory targets) internal {
        vm.prank(agentOwner);
        account.registerSessionKey(platform, 0, uint48(block.timestamp) + KEY_LIFETIME, budgetWei, targets);
    }

    function _targets(address one) internal pure returns (address[] memory list) {
        list = new address[](1);
        list[0] = one;
    }

    function _batchCalldata(BaseAccount.Call[] memory calls) internal pure returns (bytes memory) {
        return abi.encodeCall(AgentAccount.executeBatch, (calls));
    }

    /**
     * @notice Собирает операцию «заплатить `value` в пользу `to`», подписанную ключом платформы.
     * @dev Именно собирает, а не отправляет: сборка читает нонс из EntryPoint, то есть делает
     *      внешний вызов, и поставленный заранее `vm.expectRevert` списался бы на него.
     *      Поэтому в тестах на отказ операция готовится до объявления ожидаемой ошибки.
     */
    function _sessionOp(AgentAccount account, address to, uint256 value)
        internal
        view
        returns (PackedUserOperation memory)
    {
        return _signedUserOp(address(account), _executeCalldata(to, value, ""), platformKey);
    }

    /// @notice Платит ключом платформы, ожидая успеха.
    function _payAsSessionKey(AgentAccount account, address to, uint256 value) internal {
        _handleOp(_sessionOp(account, to, value));
    }

    /// @dev Нарушение границ ключа: EntryPoint заворачивает revert валидации в AA23.
    function _expectValidationRevert(bytes memory inner) internal {
        vm.expectRevert(
            abi.encodeWithSelector(IEntryPoint.FailedOpWithRevert.selector, 0, "AA23 reverted", inner)
        );
    }

    function _expectFailedOp(bytes memory reason) internal {
        vm.expectRevert(abi.encodeWithSelector(IEntryPoint.FailedOp.selector, 0, reason));
    }

    /// @notice Кошелёк агента с деньгами и уже выданным ключом платформы.
    function _fundedWithKey(uint128 budgetWei) internal returns (AgentAccount account) {
        account = _registerAutonomous("orion");
        vm.deal(address(account), 10 ether);
        _grant(account, budgetWei, _noWhitelist());
    }

    // ------------------------------------------------------------------
    // Штатный путь
    // ------------------------------------------------------------------

    function test_SessionKeyPaysWithinBudget() public {
        AgentAccount account = _fundedWithKey(1 ether);

        _payAsSessionKey(account, merchant, 0.4 ether);

        assertEq(merchant.balance, 0.4 ether);
        assertEq(account.sessionKeyRemaining(platform), 0.6 ether);
    }

    /// @dev Бюджет ключа — накопительный, а не «на операцию»: иначе ограничение
    ///      обходилось бы дроблением платежа.
    function test_SessionKeyBudgetAccumulates() public {
        AgentAccount account = _fundedWithKey(1 ether);

        _payAsSessionKey(account, merchant, 0.4 ether);
        _payAsSessionKey(account, merchant, 0.4 ether);

        assertEq(merchant.balance, 0.8 ether);
        assertEq(account.sessionKeyRemaining(platform), 0.2 ether);

        PackedUserOperation memory op = _sessionOp(account, merchant, 0.3 ether);
        _expectValidationRevert(
            abi.encodeWithSelector(SessionKeys.SessionBudgetExceeded.selector, 0.3 ether, 0.2 ether)
        );
        _handleOp(op);
    }

    function test_SessionKeyPaysListedTarget() public {
        AgentAccount account = _registerAutonomous("orion");
        vm.deal(address(account), 10 ether);
        _grant(account, 1 ether, _targets(merchant));

        _payAsSessionKey(account, merchant, 0.5 ether);

        assertEq(merchant.balance, 0.5 ether);
    }

    /// @dev Батч расходует бюджет по каждому вызову отдельно — как и лимит кастодиана.
    function test_SessionKeyBatchConsumesEachCall() public {
        AgentAccount account = _fundedWithKey(1 ether);

        BaseAccount.Call[] memory calls = new BaseAccount.Call[](2);
        calls[0] = BaseAccount.Call({target: merchant, value: 0.3 ether, data: ""});
        calls[1] = BaseAccount.Call({target: stranger, value: 0.3 ether, data: ""});

        _handleOp(_signedUserOp(address(account), _batchCalldata(calls), platformKey));

        assertEq(merchant.balance, 0.3 ether);
        assertEq(stranger.balance, 0.3 ether);
        assertEq(account.sessionKeyRemaining(platform), 0.4 ether);
    }

    /// @dev Батч не может стать лазейкой: сумма вызовов считается против того же бюджета.
    function test_RevertWhen_SessionKeyBatchExceedsBudget() public {
        AgentAccount account = _fundedWithKey(1 ether);

        BaseAccount.Call[] memory calls = new BaseAccount.Call[](2);
        calls[0] = BaseAccount.Call({target: merchant, value: 0.6 ether, data: ""});
        calls[1] = BaseAccount.Call({target: merchant, value: 0.6 ether, data: ""});

        PackedUserOperation memory op = _signedUserOp(address(account), _batchCalldata(calls), platformKey);
        _expectValidationRevert(
            abi.encodeWithSelector(SessionKeys.SessionBudgetExceeded.selector, 0.6 ether, 0.4 ether)
        );
        _handleOp(op);

        assertEq(merchant.balance, 0);
    }

    /// @notice Повторная выдача ключа перезаписывает условия и обнуляет израсходованное.
    function test_ReRegisterResetsSpentBudget() public {
        AgentAccount account = _fundedWithKey(1 ether);

        _payAsSessionKey(account, merchant, 0.9 ether);
        assertEq(account.sessionKeyRemaining(platform), 0.1 ether);

        _grant(account, 2 ether, _noWhitelist());
        assertEq(account.sessionKeyRemaining(platform), 2 ether);
    }

    // ------------------------------------------------------------------
    // Границы ключа
    // ------------------------------------------------------------------

    function test_RevertWhen_SessionKeyExceedsBudget() public {
        AgentAccount account = _fundedWithKey(1 ether);

        PackedUserOperation memory op = _sessionOp(account, merchant, 2 ether);
        _expectValidationRevert(
            abi.encodeWithSelector(SessionKeys.SessionBudgetExceeded.selector, 2 ether, 1 ether)
        );
        _handleOp(op);

        assertEq(merchant.balance, 0);
    }

    function test_RevertWhen_SessionKeyPaysUnlistedTarget() public {
        AgentAccount account = _registerAutonomous("orion");
        vm.deal(address(account), 10 ether);
        _grant(account, 1 ether, _targets(merchant));

        PackedUserOperation memory op = _sessionOp(account, stranger, 0.1 ether);
        _expectValidationRevert(
            abi.encodeWithSelector(SessionKeys.SessionTargetNotAllowed.selector, stranger)
        );
        _handleOp(op);

        assertEq(stranger.balance, 0);
    }

    /**
     * @notice Ключ не может расширить сам себя.
     * @dev Ключ вправе вызывать только `execute` и `executeBatch`. Без этой проверки
     *      он вызвал бы `registerSessionKey` — метод доступен самому кошельку, а операция
     *      исполняется именно от его имени, — и выписал бы себе бюджет побольше.
     */
    function test_RevertWhen_SessionKeyRegistersAnotherKey() public {
        AgentAccount account = _fundedWithKey(1 ether);

        bytes memory callData = abi.encodeCall(
            AgentAccount.registerSessionKey,
            (platform, 0, uint48(block.timestamp) + KEY_LIFETIME, 100 ether, _noWhitelist())
        );

        PackedUserOperation memory op = _signedUserOp(address(account), callData, platformKey);
        _expectValidationRevert(
            abi.encodeWithSelector(
                SessionKeys.SessionCallNotAllowed.selector, AgentAccount.registerSessionKey.selector
            )
        );
        _handleOp(op);

        assertEq(account.sessionKeyRemaining(platform), 1 ether);
    }

    /// @dev Тот же запрет закрывает и вывод депозита из EntryPoint — минуя `execute`,
    ///      а значит и минуя бюджет ключа.
    function test_RevertWhen_SessionKeyWithdrawsDeposit() public {
        AgentAccount account = _fundedWithKey(1 ether);

        bytes memory callData = abi.encodeCall(SimpleAccount.withdrawDepositTo, (payable(platform), 1 ether));

        PackedUserOperation memory op = _signedUserOp(address(account), callData, platformKey);
        _expectValidationRevert(
            abi.encodeWithSelector(
                SessionKeys.SessionCallNotAllowed.selector, SimpleAccount.withdrawDepositTo.selector
            )
        );
        _handleOp(op);
    }

    // ------------------------------------------------------------------
    // Привилегированные цели закрыты даже через execute
    // ------------------------------------------------------------------

    /**
     * @dev Раньше проверка разрешённых методов смотрела только на селектор самой
     *      операции: `execute(address(this), 0, registerSessionKey(...))` проходил
     *      валидацию с нулевым расходом бюджета, а на исполнении onlyOwner пускал
     *      вызов от имени самого аккаунта. Теперь адрес кошелька как цель запрещён.
     */
    function test_RevertWhen_SessionKeyCallsRegisterSessionKeyThroughSelf() public {
        AgentAccount account = _fundedWithKey(1 ether);

        bytes memory inner = abi.encodeCall(
            AgentAccount.registerSessionKey,
            (platform, 0, uint48(block.timestamp) + KEY_LIFETIME, 100 ether, _noWhitelist())
        );
        bytes memory callData = _executeCalldata(address(account), 0, inner);

        PackedUserOperation memory op = _signedUserOp(address(account), callData, platformKey);
        _expectValidationRevert(
            abi.encodeWithSelector(SessionKeys.SessionTargetNotAllowed.selector, address(account))
        );
        _handleOp(op);

        assertEq(account.sessionKeyRemaining(platform), 1 ether);
    }

    /// @dev Тот же запрет закрывает апгрейд реализации: цель снова сам кошелёк.
    function test_RevertWhen_SessionKeyCallsUpgradeThroughSelf() public {
        AgentAccount account = _fundedWithKey(1 ether);

        bytes memory inner = abi.encodeCall(UUPSUpgradeable.upgradeToAndCall, (stranger, ""));
        bytes memory callData = _executeCalldata(address(account), 0, inner);

        PackedUserOperation memory op = _signedUserOp(address(account), callData, platformKey);
        _expectValidationRevert(
            abi.encodeWithSelector(SessionKeys.SessionTargetNotAllowed.selector, address(account))
        );
        _handleOp(op);
    }

    /// @dev И вывод депозита на газ: через self-call он шёл бы мимо бюджета ключа.
    function test_RevertWhen_SessionKeyCallsWithdrawDepositThroughSelf() public {
        AgentAccount account = _fundedWithKey(1 ether);

        bytes memory inner = abi.encodeCall(SimpleAccount.withdrawDepositTo, (payable(platform), 1 ether));
        bytes memory callData = _executeCalldata(address(account), 0, inner);

        PackedUserOperation memory op = _signedUserOp(address(account), callData, platformKey);
        _expectValidationRevert(
            abi.encodeWithSelector(SessionKeys.SessionTargetNotAllowed.selector, address(account))
        );
        _handleOp(op);
    }

    /// @dev EntryPoint как цель тоже запрещён: иначе `withdrawTo` снял бы депозит напрямую.
    function test_RevertWhen_SessionKeyCallsEntryPoint() public {
        AgentAccount account = _fundedWithKey(1 ether);

        // `withdrawTo` живёт в IStakeManager, который расширяет IEntryPoint.
        bytes memory inner = abi.encodeCall(IStakeManager.withdrawTo, (payable(platform), 1 ether));
        bytes memory callData = _executeCalldata(address(entryPoint), 0, inner);

        PackedUserOperation memory op = _signedUserOp(address(account), callData, platformKey);
        _expectValidationRevert(
            abi.encodeWithSelector(SessionKeys.SessionTargetNotAllowed.selector, address(entryPoint))
        );
        _handleOp(op);
    }

    // ------------------------------------------------------------------
    // Срок действия
    // ------------------------------------------------------------------

    function test_RevertWhen_SessionKeyExpired() public {
        AgentAccount account = _fundedWithKey(1 ether);

        vm.warp(block.timestamp + KEY_LIFETIME + 1);

        PackedUserOperation memory op = _sessionOp(account, merchant, 0.1 ether);
        _expectFailedOp("AA22 expired or not due");
        _handleOp(op);

        assertEq(merchant.balance, 0);
    }

    function test_RevertWhen_SessionKeyNotYetValid() public {
        AgentAccount account = _registerAutonomous("orion");
        vm.deal(address(account), 10 ether);

        vm.prank(agentOwner);
        account.registerSessionKey(
            platform,
            uint48(block.timestamp) + 1 hours,
            uint48(block.timestamp) + KEY_LIFETIME,
            1 ether,
            _noWhitelist()
        );

        PackedUserOperation memory op = _sessionOp(account, merchant, 0.1 ether);
        _expectFailedOp("AA22 expired or not due");
        _handleOp(op);

        assertEq(merchant.balance, 0);
    }

    // ------------------------------------------------------------------
    // Отзыв и неизвестные ключи
    // ------------------------------------------------------------------

    function test_RevertWhen_UnknownSessionKey() public {
        AgentAccount account = _registerAutonomous("orion");
        vm.deal(address(account), 10 ether);

        // Ключ никто не выдавал: для кошелька это просто чужая подпись.
        PackedUserOperation memory op = _sessionOp(account, merchant, 0.1 ether);
        _expectFailedOp("AA24 signature error");
        _handleOp(op);
    }

    function test_RevertWhen_SessionKeyRevokedByOwner() public {
        AgentAccount account = _fundedWithKey(1 ether);

        vm.expectEmit(true, false, false, false, address(account));
        emit AgentAccount.SessionKeyRevoked(platform);
        vm.prank(agentOwner);
        account.revokeSessionKey(platform);

        PackedUserOperation memory op = _sessionOp(account, merchant, 0.1 ether);
        _expectFailedOp("AA24 signature error");
        _handleOp(op);
    }

    /// @dev Держатель ключа отзывает себя сам: поняв, что скомпрометирован, он не должен
    ///      ждать реакции владельца.
    function test_SessionKeyHolderRevokesItself() public {
        AgentAccount account = _fundedWithKey(1 ether);

        vm.prank(platform);
        account.revokeSessionKey(platform);

        assertEq(account.sessionKeyRemaining(platform), 0);

        PackedUserOperation memory op = _sessionOp(account, merchant, 0.1 ether);
        _expectFailedOp("AA24 signature error");
        _handleOp(op);
    }

    function test_RevertWhen_StrangerRevokesSessionKey() public {
        AgentAccount account = _fundedWithKey(1 ether);

        vm.prank(stranger);
        vm.expectRevert(abi.encodeWithSelector(AgentAccount.NotOwnerOrSessionKey.selector, stranger));
        account.revokeSessionKey(platform);
    }

    // ------------------------------------------------------------------
    // Выдача ключа
    // ------------------------------------------------------------------

    function test_RegisterSessionKeyEmitsEvent() public {
        AgentAccount account = _registerAutonomous("orion");
        uint48 validUntil = uint48(block.timestamp) + KEY_LIFETIME;

        vm.expectEmit(true, false, false, true, address(account));
        emit AgentAccount.SessionKeyRegistered(platform, 0, validUntil, 1 ether, true);

        vm.prank(agentOwner);
        account.registerSessionKey(platform, 0, validUntil, 1 ether, _targets(merchant));

        assertTrue(account.sessionKeyTargets(platform, merchant));
        assertFalse(account.sessionKeyTargets(platform, stranger));
    }

    /// @dev Вечных ключей не бывает — иначе забытый ключ остаётся действующим навсегда.
    function test_RevertWhen_SessionKeyWithoutExpiry() public {
        AgentAccount account = _registerAutonomous("orion");

        vm.prank(agentOwner);
        vm.expectRevert(SessionKeys.SessionKeyNeedsExpiry.selector);
        account.registerSessionKey(platform, 0, 0, 1 ether, _noWhitelist());
    }

    /// @dev Нулевой бюджет означал бы ключ без ограничения по сумме, а не запрет трат.
    function test_RevertWhen_SessionKeyWithoutBudget() public {
        AgentAccount account = _registerAutonomous("orion");

        vm.prank(agentOwner);
        vm.expectRevert(SessionKeys.SessionKeyNeedsBudget.selector);
        account.registerSessionKey(platform, 0, uint48(block.timestamp) + KEY_LIFETIME, 0, _noWhitelist());
    }

    function test_RevertWhen_StrangerRegistersSessionKey() public {
        AgentAccount account = _registerAutonomous("orion");

        vm.prank(stranger);
        vm.expectRevert(
            abi.encodeWithSelector(SimpleAccount.NotOwner.selector, stranger, address(account), agentOwner)
        );
        account.registerSessionKey(
            platform, 0, uint48(block.timestamp) + KEY_LIFETIME, 1 ether, _noWhitelist()
        );
    }

    /// @dev Кастодиан правилами распоряжается, а ключами — нет: ключи выдаёт владелец.
    function test_RevertWhen_CustodianRegistersSessionKey() public {
        AgentAccount account = _registerCustodial("atlas", _noRules(), _noWhitelist(), 0);

        vm.prank(custodian);
        vm.expectRevert(
            abi.encodeWithSelector(SimpleAccount.NotOwner.selector, custodian, address(account), agentOwner)
        );
        account.registerSessionKey(
            platform, 0, uint48(block.timestamp) + KEY_LIFETIME, 1 ether, _noWhitelist()
        );
    }

    // ------------------------------------------------------------------
    // Ключ не обходит ограничения кошелька
    // ------------------------------------------------------------------

    /**
     * @dev Бюджет ключа и лимит кастодиана — независимые границы, применяется меньшая.
     *      Лимит проверяется на фазе исполнения, поэтому операция попадает в блок,
     *      но перевод откатывается.
     */
    function test_SessionKeyDoesNotBypassCustodianLimit() public {
        SpendingRules.Config memory rules =
            SpendingRules.Config({limitWei: 1 ether, periodSeconds: 1 days, whitelistEnabled: false});
        AgentAccount account = _registerCustodial("atlas", rules, _noWhitelist(), 0);
        vm.deal(address(account), 10 ether);
        _grant(account, 5 ether, _noWhitelist());

        PackedUserOperation memory op =
            _signedUserOp(address(account), _executeCalldata(merchant, 2 ether, ""), platformKey);

        vm.expectEmit(true, true, false, false);
        emit IEntryPoint.UserOperationRevertReason(entryPoint.getUserOpHash(op), address(account), 0, "");
        _handleOp(op);

        assertEq(merchant.balance, 0);
    }

    function test_SessionKeyDoesNotBypassWhitelist() public {
        SpendingRules.Config memory rules =
            SpendingRules.Config({limitWei: 0, periodSeconds: 0, whitelistEnabled: true});
        AgentAccount account = _registerCustodial("atlas", rules, _targets(merchant), 0);
        vm.deal(address(account), 10 ether);

        // Ключ без ограничения по получателям — единственный барьер здесь whitelist кошелька.
        _grant(account, 5 ether, _noWhitelist());

        PackedUserOperation memory op =
            _signedUserOp(address(account), _executeCalldata(stranger, 1 ether, ""), platformKey);

        vm.expectEmit(true, true, false, false);
        emit IEntryPoint.UserOperationRevertReason(entryPoint.getUserOpHash(op), address(account), 0, "");
        _handleOp(op);

        assertEq(stranger.balance, 0);
    }

    /// @dev Заморозка отбраковывает операцию на валидации — независимо от того, чем подписано.
    function test_RevertWhen_FrozenAccountUsesSessionKey() public {
        AgentAccount account = _fundedWithKey(1 ether);

        vm.prank(admin);
        registry.setFrozen(address(account), true);

        PackedUserOperation memory op = _sessionOp(account, merchant, 0.1 ether);
        _expectFailedOp("AA24 signature error");
        _handleOp(op);

        assertEq(merchant.balance, 0);
    }
}
