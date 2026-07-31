// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {Script} from "forge-std/Script.sol";
import {console} from "forge-std/console.sol";

import {EntryPoint} from "@account-abstraction/contracts/core/EntryPoint.sol";
import {IEntryPoint} from "@account-abstraction/contracts/interfaces/IEntryPoint.sol";

import {AgentAccountFactory} from "../src/AgentAccountFactory.sol";
import {AgentRegistry} from "../src/AgentRegistry.sol";

/**
 * @notice Деплой стенда Synth Wallet.
 *
 * @dev Порядок важен: фабрика знает реестр (адреса кошельков считаются с его участием),
 *      а реестр знает фабрику. Разрываем цикл одноразовым `setRegistry` сразу после деплоя,
 *      до создания первого кошелька.
 *
 *      EntryPoint не деплоится, если по адресу из `ENTRYPOINT` уже есть код — в тестовых
 *      сетях это канонический контракт от авторов стандарта. Локально (anvil) поднимаем
 *      собственную копию из референсного пакета.
 *
 *      Переменные окружения:
 *        PRIVATE_KEY — ключ деплойера (обязателен)
 *        ENTRYPOINT  — адрес EntryPoint; по умолчанию канонический v0.9
 *        ADMIN       — владелец реестра (право заморозки); по умолчанию адрес деплойера
 */
contract Deploy is Script {
    /// @dev Канонический EntryPoint v0.9.0 из eth-infinitism/account-abstraction.
    address internal constant CANONICAL_ENTRYPOINT = 0x433709009B8330FDa32311DF1C2AFA402eD8D009;

    function run() external {
        uint256 deployerKey = vm.envUint("PRIVATE_KEY");
        address deployer = vm.addr(deployerKey);
        address admin = vm.envOr("ADMIN", deployer);
        address entryPointAddr = vm.envOr("ENTRYPOINT", CANONICAL_ENTRYPOINT);

        vm.startBroadcast(deployerKey);

        IEntryPoint entryPoint;
        bool entryPointDeployed;
        if (entryPointAddr.code.length == 0) {
            // Локальная сеть: канонического EntryPoint здесь нет, поднимаем свой.
            entryPoint = IEntryPoint(address(new EntryPoint()));
            entryPointDeployed = true;
        } else {
            entryPoint = IEntryPoint(entryPointAddr);
        }

        AgentAccountFactory factory = new AgentAccountFactory(entryPoint);
        AgentRegistry registry = new AgentRegistry(factory, admin);
        factory.setRegistry(address(registry));

        vm.stopBroadcast();

        console.log("chainId          ", block.chainid);
        console.log("deployer         ", deployer);
        console.log("admin            ", admin);
        console.log("entryPoint       ", address(entryPoint), entryPointDeployed ? "(deployed)" : "(existing)");
        console.log("factory          ", address(factory));
        console.log("accountImpl      ", address(factory.accountImplementation()));
        console.log("registry         ", address(registry));

        _writeDeployment(address(entryPoint), address(factory), address(registry), admin);
    }

    /// @dev Адреса складываются в `deployments/<chainId>.json` — оттуда их читает веб-приложение.
    function _writeDeployment(address entryPoint, address factory, address registry, address admin)
        internal
    {
        string memory json = "deployment";
        vm.serializeUint(json, "chainId", block.chainid);
        vm.serializeAddress(json, "entryPoint", entryPoint);
        vm.serializeAddress(json, "factory", factory);
        vm.serializeAddress(json, "admin", admin);
        string memory out = vm.serializeAddress(json, "registry", registry);

        string memory path =
            string.concat(vm.projectRoot(), "/deployments/", vm.toString(block.chainid), ".json");
        vm.writeJson(out, path);

        console.log("written to       ", path);
    }
}
