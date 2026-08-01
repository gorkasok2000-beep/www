// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {Test} from "forge-std/Test.sol";

import {EntryPoint} from "@account-abstraction/contracts/core/EntryPoint.sol";
import {IEntryPoint} from "@account-abstraction/contracts/interfaces/IEntryPoint.sol";
import {PackedUserOperation} from "@account-abstraction/contracts/interfaces/PackedUserOperation.sol";

import {AgentAccount} from "../src/AgentAccount.sol";
import {AgentAccountFactory} from "../src/AgentAccountFactory.sol";
import {AgentRegistry} from "../src/AgentRegistry.sol";
import {SpendingRules} from "../src/lib/SpendingRules.sol";

/**
 * @notice Общая обвязка для тестов: локальный EntryPoint из референсного пакета,
 *         фабрика, реестр и утилиты для сборки/подписи UserOperation.
 */
abstract contract SynthWalletTest is Test {
    EntryPoint internal entryPoint;
    AgentAccountFactory internal factory;
    AgentRegistry internal registry;

    address internal admin = makeAddr("admin");
    address internal custodian = makeAddr("custodian");
    address internal merchant = makeAddr("merchant");
    address internal stranger = makeAddr("stranger");

    address internal agentOwner;
    uint256 internal agentOwnerKey;

    function setUp() public virtual {
        (agentOwner, agentOwnerKey) = makeAddrAndKey("agentOwner");

        entryPoint = new EntryPoint();
        factory = new AgentAccountFactory(IEntryPoint(address(entryPoint)), address(this));
        registry = new AgentRegistry(factory, admin);
        factory.setRegistry(address(registry));
    }

    // ------------------------------------------------------------------
    // Хелперы регистрации
    // ------------------------------------------------------------------

    function _noRules() internal pure returns (SpendingRules.Config memory) {
        return SpendingRules.Config({limitWei: 0, periodSeconds: 0, whitelistEnabled: false});
    }

    function _noWhitelist() internal pure returns (address[] memory) {
        return new address[](0);
    }

    /// @notice Autonomous Entity: кошелёк принадлежит самому агенту, правил нет.
    function _registerAutonomous(string memory handle) internal returns (AgentAccount) {
        address account =
            registry.registerAgent(handle, agentOwner, address(0), _noRules(), _noWhitelist(), 0);
        return AgentAccount(payable(account));
    }

    /// @notice Human Custodian: человек создал кошелёк агенту и задал правила.
    function _registerCustodial(
        string memory handle,
        SpendingRules.Config memory rules,
        address[] memory whitelist,
        uint256 salt
    ) internal returns (AgentAccount) {
        address account = registry.registerAgent(handle, agentOwner, custodian, rules, whitelist, salt);
        return AgentAccount(payable(account));
    }

    // ------------------------------------------------------------------
    // Хелперы UserOperation
    // ------------------------------------------------------------------

    function _packGas(uint256 high, uint256 low) internal pure returns (bytes32) {
        return bytes32((high << 128) | low);
    }

    /// @notice Собирает и подписывает UserOperation от имени владельца-агента.
    function _signedUserOp(address sender, bytes memory callData, uint256 signerKey)
        internal
        view
        returns (PackedUserOperation memory op)
    {
        op = PackedUserOperation({
            sender: sender,
            nonce: entryPoint.getNonce(sender, 0),
            initCode: "",
            callData: callData,
            accountGasLimits: _packGas(500_000, 500_000),
            preVerificationGas: 100_000,
            gasFees: _packGas(1 gwei, 1 gwei),
            paymasterAndData: "",
            signature: ""
        });

        bytes32 userOpHash = entryPoint.getUserOpHash(op);
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(signerKey, userOpHash);
        op.signature = abi.encodePacked(r, s, v);
    }

    /// @notice Прогоняет операцию через EntryPoint — так это происходит и в проде.
    /// @dev EntryPoint v0.9 требует, чтобы `handleOps` вызывал EOA (`tx.origin == msg.sender`),
    ///      поэтому подменяем и отправителя, и tx.origin на адрес «бандлера».
    function _handleOp(PackedUserOperation memory op) internal {
        PackedUserOperation[] memory ops = new PackedUserOperation[](1);
        ops[0] = op;

        address bundler = makeAddr("bundler");
        vm.prank(bundler, bundler);
        entryPoint.handleOps(ops, payable(bundler));
    }

    function _executeCalldata(address target, uint256 value, bytes memory data)
        internal
        pure
        returns (bytes memory)
    {
        return abi.encodeCall(AgentAccount.execute, (target, value, data));
    }
}
