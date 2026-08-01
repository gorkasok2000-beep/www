// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {Script} from "forge-std/Script.sol";
import {console} from "forge-std/console.sol";

import {EntryPoint} from "@account-abstraction/contracts/core/EntryPoint.sol";
import {IEntryPoint} from "@account-abstraction/contracts/interfaces/IEntryPoint.sol";

import {AgentAccountFactory} from "../src/AgentAccountFactory.sol";
import {AgentRegistry} from "../src/AgentRegistry.sol";

/**
 * @notice Детерминированный деплой стенда Synth Wallet.
 *
 * @dev Всё разворачивается через канонический CREATE2-деплойер `0x4e59…56C` с фиксированной
 *      солью. Смысл — один адрес во всех сетях:
 *
 *      - адрес контракта при CREATE2 зависит только от деплойера, соли и кода с аргументами
 *        конструктора, но не от того, кто и когда его отправил, и не от нонса. Поэтому
 *        фабрика и реестр получают одинаковые адреса в Base Sepolia, Arbitrum Sepolia и
 *        локальном anvil;
 *      - фабрика считает адрес кошелька агента тоже через CREATE2 от себя, значит и кошелёк
 *        агента оказывается по одному адресу во всех сетях. Агенту достаточно назвать один
 *        адрес — принимать средства он сможет в любой из поддерживаемых сетей.
 *
 *      Условия, при которых адреса совпадут (нарушение любого из них разводит их в стороны):
 *
 *      1. одинаковая соль (`DEPLOY_SALT`);
 *      2. одинаковый EntryPoint — в тестовых сетях это канонический v0.9;
 *      3. одинаковый `ADMIN` — он входит в аргументы конструктора реестра;
 *      4. одинаковый байткод, то есть та же версия исходников и настройки компилятора.
 *
 *      Скрипт идемпотентен: если по вычисленному адресу уже есть код, деплой пропускается.
 *      Так повторный запуск в той же сети ничего не ломает.
 *
 *      Переменные окружения:
 *        PRIVATE_KEY — ключ отправителя (обязателен)
 *        ENTRYPOINT  — адрес EntryPoint; по умолчанию канонический v0.9
 *        ADMIN       — владелец реестра (право заморозки); по умолчанию адрес отправителя
 *        DEPLOY_SALT — строка-соль; по умолчанию `synth-wallet.v1`
 */
contract Deploy is Script {
    /// @dev Канонический EntryPoint v0.9.0 из eth-infinitism/account-abstraction.
    address internal constant CANONICAL_ENTRYPOINT = 0x433709009B8330FDa32311DF1C2AFA402eD8D009;

    /**
     * @dev Общий для всех сетей CREATE2-деплойер (Arachnid's deterministic deployment proxy).
     *      Его же по умолчанию использует `forge script` для `new X{salt: …}`, и он
     *      предустановлен в anvil.
     */
    address internal constant CREATE2_DEPLOYER = 0x4e59b44847b379578588920cA78FbF26c0B4956C;

    function run() external {
        uint256 deployerKey = vm.envUint("PRIVATE_KEY");
        address sender = vm.addr(deployerKey);
        address admin = vm.envOr("ADMIN", sender);
        address entryPointAddr = vm.envOr("ENTRYPOINT", CANONICAL_ENTRYPOINT);
        bytes32 salt = keccak256(bytes(vm.envOr("DEPLOY_SALT", string("synth-wallet.v1"))));

        require(CREATE2_DEPLOYER.code.length != 0, "CREATE2-deployer 0x4e59...56C not found in this network");

        vm.startBroadcast(deployerKey);

        // 1. EntryPoint. В тестовых сетях он уже есть — берём канонический, чтобы кошельки
        //    работали с тем же контрактом, что и остальная экосистема. Локально поднимаем
        //    копию из референсного пакета, тоже детерминированно.
        bool entryPointDeployed = entryPointAddr.code.length == 0;
        if (entryPointDeployed) {
            entryPointAddr = _deploy2(salt, type(EntryPoint).creationCode);
        }
        IEntryPoint entryPoint = IEntryPoint(entryPointAddr);

        // 2. Фабрика. `admin` в аргументах — тот, кому разрешён единственный `setRegistry`.
        address factoryAddr = _deploy2(
            salt, abi.encodePacked(type(AgentAccountFactory).creationCode, abi.encode(entryPoint, admin))
        );
        AgentAccountFactory factory = AgentAccountFactory(factoryAddr);

        // 3. Реестр. Знает фабрику; обратную связь замыкаем ниже.
        address registryAddr =
            _deploy2(salt, abi.encodePacked(type(AgentRegistry).creationCode, abi.encode(factory, admin)));
        AgentRegistry registry = AgentRegistry(registryAddr);

        // 4. Связываем фабрику с реестром — обязательно до создания первого кошелька:
        //    адрес реестра входит в calldata инициализации, а значит и в адрес аккаунта.
        //    Право на этот вызов есть только у `admin`, поэтому в сетях, где реестр ставит
        //    не отправитель скрипта, шаг просто пропускается.
        if (factory.registry() == address(0) && sender == admin) {
            factory.setRegistry(registryAddr);
        }

        vm.stopBroadcast();

        console.log("chainId          ", block.chainid);
        console.log("sender           ", sender);
        console.log("admin            ", admin);
        console.log("salt             ", vm.toString(salt));
        console.log("entryPoint       ", entryPointAddr, entryPointDeployed ? "(deployed)" : "(existing)");
        console.log("factory          ", factoryAddr);
        console.log("accountImpl      ", address(factory.accountImplementation()));
        console.log("registry         ", registryAddr);
        require(factory.registry() == registryAddr, "factory is bound to a different registry");

        _writeDeployment(entryPointAddr, factoryAddr, registryAddr, admin, salt);
    }

    /**
     * @notice Разворачивает `initCode` по адресу, который зависит только от соли и кода.
     *
     * @dev Деплойер вызывается явно, а не через `new X{salt: …}`: так в коде видно ровно ту
     *      транзакцию, которая уйдёт в сеть. Формат вызова задан самим прокси — `salt`
     *      первыми 32 байтами, дальше initCode; в ответ приходят 20 байт адреса.
     *
     *      Повторный запуск ничего не делает: если код уже есть, возвращается тот же адрес.
     *      Совпадение вычисленного адреса с фактическим проверяется явно — ошибка в
     *      предположениях о деплойере вылезет сразу, а не после регистрации первого агента.
     */
    function _deploy2(bytes32 salt, bytes memory initCode) internal returns (address addr) {
        addr = vm.computeCreate2Address(salt, keccak256(initCode), CREATE2_DEPLOYER);
        if (addr.code.length != 0) {
            return addr;
        }

        (bool ok, bytes memory ret) = CREATE2_DEPLOYER.call(abi.encodePacked(salt, initCode));
        require(ok, "CREATE2 deployment failed");
        require(address(bytes20(ret)) == addr, "CREATE2 address mismatch");
        require(addr.code.length != 0, "CREATE2 deployment produced no code");
    }

    /// @dev Адреса складываются в `deployments/<chainId>.json` — оттуда их читает веб-приложение.
    function _writeDeployment(
        address entryPoint,
        address factory,
        address registry,
        address admin,
        bytes32 salt
    ) internal {
        string memory json = "deployment";
        vm.serializeUint(json, "chainId", block.chainid);
        vm.serializeString(json, "salt", vm.toString(salt));
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
