// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {Create2} from "@openzeppelin/contracts/utils/Create2.sol";
import {ERC1967Proxy} from "@openzeppelin/contracts/proxy/ERC1967/ERC1967Proxy.sol";

import {IEntryPoint} from "@account-abstraction/contracts/interfaces/IEntryPoint.sol";
import {ISenderCreator} from "@account-abstraction/contracts/interfaces/ISenderCreator.sol";

import {AgentAccount} from "./AgentAccount.sol";
import {SpendingRules} from "./lib/SpendingRules.sol";

/**
 * @title AgentAccountFactory
 * @notice Фабрика кошельков агентов — структурная копия `SimpleAccountFactory` из
 *         eth-infinitism/account-abstraction (ERC1967Proxy + CREATE2, детерминированный адрес).
 *
 * @dev Единственное отличие от референса: в v0.9 `createAccount` разрешён только
 *      `senderCreator`, то есть аккаунт может появиться исключительно через initCode
 *      внутри UserOperation. Нам нужен ещё и прямой путь — регистрация через `AgentRegistry`
 *      по HTTP-запросу, до того как у агента появится хоть какой-то газ. Поэтому вызывать
 *      `createAccount` могут двое: `senderCreator` (штатный путь ERC-4337) и реестр.
 *
 *      ВНИМАНИЕ ДЛЯ АУДИТА: адрес детерминирован по всем аргументам инициализации, включая
 *      `registry`. Реестр задаётся один раз сразу после деплоя фабрики и до создания первого
 *      аккаунта — иначе ранее посчитанные counterfactual-адреса разъедутся.
 */
contract AgentAccountFactory {
    AgentAccount public immutable accountImplementation;
    ISenderCreator public immutable senderCreator;
    address public immutable deployer;

    /// @notice Реестр агентов; задаётся один раз деплойером.
    address public registry;

    event RegistrySet(address indexed registry);

    error NotAuthorizedCreator(address msgSender, address senderCreator, address registry);
    error NotDeployer(address msgSender, address deployer);
    error RegistryAlreadySet(address registry);
    error RegistryNotSet();

    constructor(IEntryPoint anEntryPoint) {
        accountImplementation = new AgentAccount(anEntryPoint);
        senderCreator = anEntryPoint.senderCreator();
        deployer = msg.sender;
    }

    function setRegistry(address aRegistry) external {
        require(msg.sender == deployer, NotDeployer(msg.sender, deployer));
        require(registry == address(0), RegistryAlreadySet(registry));
        registry = aRegistry;
        emit RegistrySet(aRegistry);
    }

    /**
     * @notice Создаёт кошелёк агента и возвращает его адрес.
     * @dev Как и в референсе, возвращает адрес уже существующего аккаунта, чтобы
     *      `entryPoint.getSenderAddress()` работал и до, и после создания.
     */
    function createAccount(
        address owner,
        address custodian,
        SpendingRules.Config calldata rules,
        address[] calldata whitelist,
        uint256 salt
    ) public returns (AgentAccount ret) {
        address registry_ = registry;
        require(registry_ != address(0), RegistryNotSet());
        require(
            msg.sender == address(senderCreator) || msg.sender == registry_,
            NotAuthorizedCreator(msg.sender, address(senderCreator), registry_)
        );

        address addr = getAddress(owner, custodian, rules, whitelist, salt);
        if (addr.code.length > 0) {
            return AgentAccount(payable(addr));
        }

        ret = AgentAccount(
            payable(new ERC1967Proxy{salt: bytes32(salt)}(
                    address(accountImplementation), _initCalldata(owner, custodian, rules, whitelist)
                ))
        );
    }

    /// @notice Counterfactual-адрес кошелька до его создания.
    function getAddress(
        address owner,
        address custodian,
        SpendingRules.Config calldata rules,
        address[] calldata whitelist,
        uint256 salt
    ) public view returns (address) {
        return Create2.computeAddress(
            bytes32(salt),
            keccak256(
                abi.encodePacked(
                    type(ERC1967Proxy).creationCode,
                    abi.encode(
                        address(accountImplementation), _initCalldata(owner, custodian, rules, whitelist)
                    )
                )
            )
        );
    }

    function _initCalldata(
        address owner,
        address custodian,
        SpendingRules.Config calldata rules,
        address[] calldata whitelist
    ) internal view returns (bytes memory) {
        return abi.encodeCall(AgentAccount.initializeAgent, (owner, custodian, registry, rules, whitelist));
    }
}
