// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";

import {SynthWalletTest} from "./SynthWalletTest.t.sol";
import {AgentAccount} from "../src/AgentAccount.sol";
import {AgentAccountFactory} from "../src/AgentAccountFactory.sol";
import {AgentRegistry} from "../src/AgentRegistry.sol";
import {AgentMode} from "../src/lib/AgentTypes.sol";
import {SpendingRules} from "../src/lib/SpendingRules.sol";

contract AgentRegistryTest is SynthWalletTest {
    function test_RegisterAutonomousEntity() public {
        AgentAccount account = _registerAutonomous("orion");

        assertEq(account.owner(), agentOwner);
        assertEq(account.custodian(), address(0));
        assertEq(account.registry(), address(registry));
        assertEq(uint256(account.mode()), uint256(AgentMode.AutonomousEntity));

        AgentRegistry.AgentRecord memory record = registry.agentOf(address(account));
        assertEq(record.handle, "orion");
        assertEq(record.custodian, address(0));
        assertFalse(record.frozen);
        assertEq(registry.agentCount(), 1);
    }

    function test_RegisterHumanCustodian() public {
        SpendingRules.Config memory rules =
            SpendingRules.Config({limitWei: 1 ether, periodSeconds: 1 days, whitelistEnabled: true});
        address[] memory whitelist = new address[](1);
        whitelist[0] = merchant;

        AgentAccount account = _registerCustodial("atlas", rules, whitelist, 0);

        assertEq(account.custodian(), custodian);
        assertEq(uint256(account.mode()), uint256(AgentMode.HumanCustodian));
        assertTrue(account.whitelisted(merchant));
        assertFalse(account.whitelisted(stranger));

        (uint128 limitWei, uint64 periodSeconds, bool whitelistEnabled) = account.rules();
        assertEq(limitWei, 1 ether);
        assertEq(periodSeconds, 1 days);
        assertTrue(whitelistEnabled);
    }

    /// @dev Регистрация открыта для всех — никаких проверок личности, как требует ТЗ.
    function test_RegistrationIsPermissionless() public {
        vm.prank(stranger);
        address account =
            registry.registerAgent("nomad", agentOwner, address(0), _noRules(), _noWhitelist(), 0);

        assertTrue(registry.isRegistered(account));
    }

    function test_RevertWhen_HandleAlreadyTaken() public {
        _registerAutonomous("orion");

        vm.expectRevert(abi.encodeWithSelector(AgentRegistry.HandleAlreadyTaken.selector, "orion"));
        registry.registerAgent("orion", agentOwner, address(0), _noRules(), _noWhitelist(), 1);
    }

    /**
     * @dev Фабрика детерминированная: те же параметры и соль возвращают уже созданный
     *      кошелёк. Без проверки его регистрировали бы повторно под другим handle —
     *      и в `_agents` появилась бы вторая запись о том же кошельке.
     */
    function test_RevertWhen_AccountAlreadyRegistered() public {
        AgentAccount account = _registerAutonomous("orion");

        vm.expectRevert(
            abi.encodeWithSelector(AgentRegistry.AgentAlreadyRegistered.selector, address(account))
        );
        registry.registerAgent("orion-copy", agentOwner, address(0), _noRules(), _noWhitelist(), 0);
    }

    function test_RevertWhen_HandleEmpty() public {
        vm.expectRevert(AgentRegistry.EmptyHandle.selector);
        registry.registerAgent("", agentOwner, address(0), _noRules(), _noWhitelist(), 0);
    }

    /// @dev Autonomous Entity не может получить правила даже в обход UI.
    function test_RevertWhen_AutonomousEntityGetsRules() public {
        SpendingRules.Config memory rules =
            SpendingRules.Config({limitWei: 1 ether, periodSeconds: 1 days, whitelistEnabled: false});

        vm.expectRevert(AgentAccount.RulesRequireCustodian.selector);
        registry.registerAgent("rogue", agentOwner, address(0), rules, _noWhitelist(), 0);
    }

    function test_FreezeAndUnfreeze() public {
        AgentAccount account = _registerAutonomous("orion");

        vm.prank(admin);
        registry.setFrozen(address(account), true);

        assertTrue(account.frozen());
        assertTrue(registry.agentOf(address(account)).frozen);

        vm.prank(admin);
        registry.setFrozen(address(account), false);

        assertFalse(account.frozen());
        assertFalse(registry.agentOf(address(account)).frozen);
    }

    function test_RevertWhen_NonAdminFreezes() public {
        AgentAccount account = _registerAutonomous("orion");

        vm.prank(stranger);
        vm.expectRevert(abi.encodeWithSelector(Ownable.OwnableUnauthorizedAccount.selector, stranger));
        registry.setFrozen(address(account), true);
    }

    function test_RevertWhen_FreezingUnknownAgent() public {
        vm.prank(admin);
        vm.expectRevert(abi.encodeWithSelector(AgentRegistry.UnknownAgent.selector, stranger));
        registry.setFrozen(stranger, true);
    }

    /// @dev Заморозка — прерогатива реестра, напрямую её не выставить.
    function test_RevertWhen_SettingFrozenDirectly() public {
        AgentAccount account = _registerAutonomous("orion");

        vm.prank(admin);
        vm.expectRevert(abi.encodeWithSelector(AgentAccount.NotRegistry.selector, admin, address(registry)));
        account.setFrozen(true);
    }

    function test_AgentsPagination() public {
        _registerAutonomous("a1");
        registry.registerAgent("a2", agentOwner, address(0), _noRules(), _noWhitelist(), 1);
        registry.registerAgent("a3", agentOwner, address(0), _noRules(), _noWhitelist(), 2);

        AgentRegistry.AgentRecord[] memory page = registry.agents(1, 10);
        assertEq(page.length, 2);
        assertEq(page[0].handle, "a2");
        assertEq(page[1].handle, "a3");

        assertEq(registry.agents(5, 10).length, 0);
    }
}
