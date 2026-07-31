// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {IEntryPoint} from "@account-abstraction/contracts/interfaces/IEntryPoint.sol";
import {PackedUserOperation} from "@account-abstraction/contracts/interfaces/PackedUserOperation.sol";

import {SynthWalletTest} from "./SynthWalletTest.t.sol";
import {AgentAccount} from "../src/AgentAccount.sol";
import {SpendingRules} from "../src/lib/SpendingRules.sol";

/**
 * @notice Полный путь ERC-4337: агент подписывает UserOperation своим ключом,
 *         операция проходит через EntryPoint. Именно так работает боевой бандлер,
 *         поэтому правила и заморозка проверяются здесь ещё раз — на настоящем флоу.
 */
contract UserOperationFlowTest is SynthWalletTest {
    function test_AgentPaysThroughEntryPoint() public {
        AgentAccount account = _registerAutonomous("orion");
        vm.deal(address(account), 10 ether);

        PackedUserOperation memory op =
            _signedUserOp(address(account), _executeCalldata(merchant, 1 ether, ""), agentOwnerKey);
        _handleOp(op);

        assertEq(merchant.balance, 1 ether);
    }

    /// @dev Замороженный кошелёк отбраковывается ещё на фазе валидации (AA24),
    ///      то есть настоящий бандлер отклонит операцию до попадания в блок.
    function test_RevertWhen_FrozenAccountSendsUserOp() public {
        AgentAccount account = _registerAutonomous("orion");
        vm.deal(address(account), 10 ether);

        vm.prank(admin);
        registry.setFrozen(address(account), true);

        PackedUserOperation memory op =
            _signedUserOp(address(account), _executeCalldata(merchant, 1 ether, ""), agentOwnerKey);

        vm.expectRevert(abi.encodeWithSelector(IEntryPoint.FailedOp.selector, 0, "AA24 signature error"));
        _handleOp(op);

        assertEq(merchant.balance, 0);
    }

    function test_RevertWhen_ForeignKeySignsUserOp() public {
        AgentAccount account = _registerAutonomous("orion");
        vm.deal(address(account), 10 ether);

        (, uint256 strangerKey) = makeAddrAndKey("strangerSigner");
        PackedUserOperation memory op =
            _signedUserOp(address(account), _executeCalldata(merchant, 1 ether, ""), strangerKey);

        vm.expectRevert(abi.encodeWithSelector(IEntryPoint.FailedOp.selector, 0, "AA24 signature error"));
        _handleOp(op);
    }

    /// @dev Превышение лимита срывается на фазе исполнения: операция попадает в блок,
    ///      но внутренний вызов откатывается и деньги остаются на месте.
    function test_SpendLimitRevertsExecutionPhase() public {
        SpendingRules.Config memory rules =
            SpendingRules.Config({limitWei: 1 ether, periodSeconds: 1 days, whitelistEnabled: false});
        AgentAccount account = _registerCustodial("atlas", rules, _noWhitelist(), 0);
        vm.deal(address(account), 10 ether);

        PackedUserOperation memory op =
            _signedUserOp(address(account), _executeCalldata(merchant, 5 ether, ""), agentOwnerKey);

        vm.expectEmit(true, true, false, false);
        emit IEntryPoint.UserOperationRevertReason(entryPoint.getUserOpHash(op), address(account), 0, "");
        _handleOp(op);

        assertEq(merchant.balance, 0);
    }
}
