// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {SynthWalletTest} from "./SynthWalletTest.t.sol";
import {AgentAccount} from "../src/AgentAccount.sol";
import {AgentAccountFactory} from "../src/AgentAccountFactory.sol";
import {SpendingRules} from "../src/lib/SpendingRules.sol";

contract AgentAccountFactoryTest is SynthWalletTest {
    function test_CounterfactualAddressMatchesDeployment() public {
        address predicted = factory.getAddress(agentOwner, address(0), _noRules(), _noWhitelist(), 42);

        address account =
            registry.registerAgent("orion", agentOwner, address(0), _noRules(), _noWhitelist(), 42);

        assertEq(account, predicted);
    }

    function test_DifferentSaltGivesDifferentAccount() public {
        address first = registry.registerAgent("a1", agentOwner, address(0), _noRules(), _noWhitelist(), 0);
        address second = registry.registerAgent("a2", agentOwner, address(0), _noRules(), _noWhitelist(), 1);

        assertTrue(first != second);
    }

    /// @dev Создавать аккаунты может только реестр (или senderCreator EntryPoint'а
    ///      в штатном initCode-флоу ERC-4337).
    function test_RevertWhen_CreatingAccountDirectly() public {
        // Адрес читаем заранее: внешний вызов внутри expectRevert съел бы prank.
        address senderCreator = address(factory.senderCreator());

        vm.prank(stranger);
        vm.expectRevert(
            abi.encodeWithSelector(
                AgentAccountFactory.NotAuthorizedCreator.selector, stranger, senderCreator, address(registry)
            )
        );
        factory.createAccount(agentOwner, address(0), _noRules(), _noWhitelist(), 0);
    }

    function test_RevertWhen_RegistrySetTwice() public {
        vm.expectRevert(
            abi.encodeWithSelector(AgentAccountFactory.RegistryAlreadySet.selector, address(registry))
        );
        factory.setRegistry(stranger);
    }

    function test_RevertWhen_NonDeployerSetsRegistry() public {
        AgentAccountFactory fresh = new AgentAccountFactory(entryPoint);

        vm.prank(stranger);
        vm.expectRevert(
            abi.encodeWithSelector(AgentAccountFactory.NotDeployer.selector, stranger, address(this))
        );
        fresh.setRegistry(stranger);
    }

    /// @dev Имплементация за прокси не должна быть инициализируемой напрямую.
    function test_ImplementationIsLocked() public {
        AgentAccount implementation = factory.accountImplementation();

        vm.expectRevert();
        implementation.initializeAgent(stranger, address(0), address(registry), _noRules(), _noWhitelist());
    }
}
