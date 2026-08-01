// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {BaseAccount} from "@account-abstraction/contracts/core/BaseAccount.sol";
import {IEntryPoint} from "@account-abstraction/contracts/interfaces/IEntryPoint.sol";

import {SynthWalletTest} from "./SynthWalletTest.t.sol";
import {AgentAccount} from "../src/AgentAccount.sol";
import {SpendingRules} from "../src/lib/SpendingRules.sol";

contract AgentAccountTest is SynthWalletTest {
    function _custodialWithLimit(uint128 limitWei, uint64 periodSeconds)
        internal
        returns (AgentAccount account)
    {
        SpendingRules.Config memory rules = SpendingRules.Config({
            limitWei: limitWei, periodSeconds: periodSeconds, whitelistEnabled: false
        });
        account = _registerCustodial("atlas", rules, _noWhitelist(), 0);
        vm.deal(address(account), 100 ether);
    }

    // ------------------------------------------------------------------
    // Депозит и вывод
    // ------------------------------------------------------------------

    function test_DepositAndWithdraw() public {
        AgentAccount account = _registerAutonomous("orion");

        // Депозит — обычный перевод на адрес кошелька.
        vm.deal(stranger, 5 ether);
        vm.prank(stranger);
        (bool ok,) = address(account).call{value: 5 ether}("");
        assertTrue(ok);
        assertEq(address(account).balance, 5 ether);

        // Вывод — исполнение от имени владельца-агента.
        vm.prank(agentOwner);
        account.execute(merchant, 2 ether, "");

        assertEq(address(account).balance, 3 ether);
        assertEq(merchant.balance, 2 ether);
    }

    /// @dev Депозит на газ в EntryPoint — унаследован из SimpleAccount без изменений.
    function test_EntryPointDeposit() public {
        AgentAccount account = _registerAutonomous("orion");

        vm.deal(stranger, 1 ether);
        vm.prank(stranger);
        account.addDeposit{value: 0.5 ether}();

        assertEq(account.getDeposit(), 0.5 ether);
    }

    function test_PublicTransactionLog() public {
        AgentAccount account = _registerAutonomous("orion");
        vm.deal(address(account), 5 ether);

        vm.expectEmit(true, true, true, true, address(account));
        emit AgentAccount.AgentTransaction(address(account), merchant, 1 ether, bytes4(0), block.timestamp);

        vm.prank(agentOwner);
        account.execute(merchant, 1 ether, "");
    }

    // ------------------------------------------------------------------
    // Лимиты
    // ------------------------------------------------------------------

    function test_PerTransactionLimit() public {
        AgentAccount account = _custodialWithLimit(1 ether, 0);

        vm.prank(agentOwner);
        account.execute(merchant, 1 ether, "");

        vm.prank(agentOwner);
        vm.expectRevert(
            abi.encodeWithSelector(SpendingRules.SpendLimitExceeded.selector, 1 ether + 1, 1 ether)
        );
        account.execute(merchant, 1 ether + 1, "");
    }

    function test_PeriodLimitAccumulates() public {
        AgentAccount account = _custodialWithLimit(1 ether, 1 days);

        vm.prank(agentOwner);
        account.execute(merchant, 0.6 ether, "");
        assertEq(account.spendingRemaining(), 0.4 ether);

        vm.prank(agentOwner);
        vm.expectRevert(
            abi.encodeWithSelector(SpendingRules.SpendLimitExceeded.selector, 0.5 ether, 0.4 ether)
        );
        account.execute(merchant, 0.5 ether, "");
    }

    function test_PeriodLimitResetsAfterWindow() public {
        AgentAccount account = _custodialWithLimit(1 ether, 1 days);

        vm.prank(agentOwner);
        account.execute(merchant, 1 ether, "");
        assertEq(account.spendingRemaining(), 0);

        vm.warp(block.timestamp + 1 days);
        assertEq(account.spendingRemaining(), 1 ether);

        vm.prank(agentOwner);
        account.execute(merchant, 1 ether, "");
        assertEq(merchant.balance, 2 ether);
    }

    /// @dev Батч не должен быть способом обойти лимит: расход считается накопительно.
    function test_BatchSharesTheSameLimit() public {
        AgentAccount account = _custodialWithLimit(1 ether, 1 days);

        BaseAccount.Call[] memory calls = new BaseAccount.Call[](2);
        calls[0] = BaseAccount.Call({target: merchant, value: 0.6 ether, data: ""});
        calls[1] = BaseAccount.Call({target: merchant, value: 0.6 ether, data: ""});

        vm.prank(agentOwner);
        vm.expectRevert(
            abi.encodeWithSelector(SpendingRules.SpendLimitExceeded.selector, 0.6 ether, 0.4 ether)
        );
        account.executeBatch(calls);
    }

    function test_NoLimitForAutonomousEntity() public {
        AgentAccount account = _registerAutonomous("orion");
        vm.deal(address(account), 100 ether);

        vm.prank(agentOwner);
        account.execute(merchant, 100 ether, "");

        assertEq(merchant.balance, 100 ether);
        assertEq(account.spendingRemaining(), type(uint256).max);
    }

    // ------------------------------------------------------------------
    // Whitelist
    // ------------------------------------------------------------------

    function test_WhitelistBlocksUnknownRecipient() public {
        SpendingRules.Config memory rules =
            SpendingRules.Config({limitWei: 0, periodSeconds: 0, whitelistEnabled: true});
        address[] memory whitelist = new address[](1);
        whitelist[0] = merchant;

        AgentAccount account = _registerCustodial("atlas", rules, whitelist, 0);
        vm.deal(address(account), 10 ether);

        vm.prank(agentOwner);
        account.execute(merchant, 1 ether, "");

        vm.prank(agentOwner);
        vm.expectRevert(abi.encodeWithSelector(AgentAccount.RecipientNotWhitelisted.selector, stranger));
        account.execute(stranger, 1 ether, "");
    }

    function test_CustodianUpdatesWhitelist() public {
        SpendingRules.Config memory rules =
            SpendingRules.Config({limitWei: 0, periodSeconds: 0, whitelistEnabled: true});
        AgentAccount account = _registerCustodial("atlas", rules, _noWhitelist(), 0);
        vm.deal(address(account), 10 ether);

        vm.prank(custodian);
        account.setWhitelisted(stranger, true);

        vm.prank(agentOwner);
        account.execute(stranger, 1 ether, "");
        assertEq(stranger.balance, 1 ether);
    }

    // ------------------------------------------------------------------
    // Права на правила
    // ------------------------------------------------------------------

    function test_RevertWhen_AgentChangesItsOwnRules() public {
        AgentAccount account = _custodialWithLimit(1 ether, 1 days);

        vm.prank(agentOwner);
        vm.expectRevert(abi.encodeWithSelector(AgentAccount.NotCustodian.selector, agentOwner, custodian));
        account.setRules(_noRules());
    }

    function test_RevertWhen_SettingRulesOnAutonomousEntity() public {
        AgentAccount account = _registerAutonomous("orion");

        vm.prank(agentOwner);
        vm.expectRevert(AgentAccount.RulesRequireCustodian.selector);
        account.setRules(_noRules());
    }

    function test_CustodianRelaxesLimit() public {
        AgentAccount account = _custodialWithLimit(1 ether, 1 days);

        vm.prank(custodian);
        account.setRules(
            SpendingRules.Config({limitWei: 10 ether, periodSeconds: 1 days, whitelistEnabled: false})
        );

        vm.prank(agentOwner);
        account.execute(merchant, 5 ether, "");
        assertEq(merchant.balance, 5 ether);
    }

    // ------------------------------------------------------------------
    // Заморозка
    // ------------------------------------------------------------------

    function test_FrozenAccountCannotSpend() public {
        AgentAccount account = _registerAutonomous("orion");
        vm.deal(address(account), 5 ether);

        vm.prank(admin);
        registry.setFrozen(address(account), true);

        vm.prank(agentOwner);
        vm.expectRevert(AgentAccount.AccountFrozen.selector);
        account.execute(merchant, 1 ether, "");

        // Заморозка обратима — после разморозки трата проходит.
        vm.prank(admin);
        registry.setFrozen(address(account), false);

        vm.prank(agentOwner);
        account.execute(merchant, 1 ether, "");
        assertEq(merchant.balance, 1 ether);
    }

    /// @dev Замороженный кошелёк не может сменить реализацию даже руками владельца:
    ///      иначе блокировка обходилась бы апгрейдом на реализацию без контроля реестра.
    function test_RevertWhen_FrozenAccountUpgrades() public {
        AgentAccount account = _registerAutonomous("orion");
        AgentAccount newImplementation = new AgentAccount(IEntryPoint(address(entryPoint)));

        vm.prank(admin);
        registry.setFrozen(address(account), true);

        vm.prank(agentOwner);
        vm.expectRevert(AgentAccount.AccountFrozen.selector);
        account.upgradeToAndCall(address(newImplementation), "");

        // После разморозки апгрейд снова возможен — ограничение обратимо.
        vm.prank(admin);
        registry.setFrozen(address(account), false);

        vm.prank(agentOwner);
        account.upgradeToAndCall(address(newImplementation), "");
    }

    // ------------------------------------------------------------------
    // Инициализация
    // ------------------------------------------------------------------

    function test_RevertWhen_UsingSimpleAccountInitializer() public {
        AgentAccount account = _registerAutonomous("orion");

        vm.expectRevert(AgentAccount.UseInitializeAgent.selector);
        account.initialize(stranger);
    }

    function test_RevertWhen_ReinitializingAgent() public {
        AgentAccount account = _registerAutonomous("orion");

        vm.expectRevert();
        account.initializeAgent(stranger, address(0), address(registry), _noRules(), _noWhitelist());
    }
}
