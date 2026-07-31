// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";

import {AgentAccount} from "./AgentAccount.sol";
import {AgentAccountFactory} from "./AgentAccountFactory.sol";
import {AgentMode, modeOf} from "./lib/AgentTypes.sol";
import {SpendingRules} from "./lib/SpendingRules.sol";

/**
 * @title AgentRegistry
 * @notice Точка входа регистрации агентов и источник данных для публичной витрины.
 *
 * @dev Регистрация открыта для всех: никакой проверки личности, как и требует ТЗ —
 *      доверяем действию, а не документам. Единственная привилегия админа — обратимая
 *      заморозка кошелька на случай мошенничества или бага.
 */
contract AgentRegistry is Ownable {
    AgentAccountFactory public immutable factory;

    struct AgentRecord {
        address account;
        address custodian;
        uint64 createdAt;
        bool frozen;
        string handle;
    }

    AgentRecord[] private _agents;

    /// @dev account => индекс в `_agents` + 1 (0 означает «не зарегистрирован»).
    mapping(address => uint256) private _indexOf;

    /// @notice Занятые публичные имена агентов (для витрины).
    mapping(bytes32 => bool) public handleTaken;

    event AgentRegistered(
        address indexed account, address indexed custodian, AgentMode mode, string handle, uint256 timestamp
    );
    event AgentFrozenSet(address indexed account, bool frozen, uint256 timestamp);

    error EmptyHandle();
    error HandleAlreadyTaken(string handle);
    error UnknownAgent(address account);
    error CustodianRequired();

    constructor(AgentAccountFactory aFactory, address admin) Ownable(admin) {
        factory = aFactory;
    }

    // ---------------------------------------------------------------------
    // Регистрация
    // ---------------------------------------------------------------------

    /**
     * @notice Создаёт кошелёк агента и записывает его в реестр.
     * @param handle    публичное имя агента для витрины (уникально)
     * @param owner     ключ, которым агент подписывает свои операции
     * @param custodian кастодиан-человек либо address(0) для Autonomous Entity
     * @param rules     стартовые правила (только для Human Custodian)
     * @param whitelist стартовый whitelist (только для Human Custodian)
     * @param salt      соль CREATE2 — позволяет одному владельцу иметь несколько кошельков
     */
    function registerAgent(
        string calldata handle,
        address owner,
        address custodian,
        SpendingRules.Config calldata rules,
        address[] calldata whitelist,
        uint256 salt
    ) external returns (address account) {
        require(bytes(handle).length != 0, EmptyHandle());
        bytes32 handleKey = keccak256(bytes(handle));
        require(!handleTaken[handleKey], HandleAlreadyTaken(handle));

        account = address(factory.createAccount(owner, custodian, rules, whitelist, salt));

        handleTaken[handleKey] = true;
        _agents.push(
            AgentRecord({
                account: account,
                custodian: custodian,
                createdAt: uint64(block.timestamp),
                frozen: false,
                handle: handle
            })
        );
        _indexOf[account] = _agents.length;

        emit AgentRegistered(account, custodian, modeOf(custodian), handle, block.timestamp);
    }

    // ---------------------------------------------------------------------
    // Администрирование
    // ---------------------------------------------------------------------

    /// @notice Обратимая заморозка кошелька агента.
    function setFrozen(address account, bool value) external onlyOwner {
        uint256 index = _indexOf[account];
        require(index != 0, UnknownAgent(account));

        _agents[index - 1].frozen = value;
        AgentAccount(payable(account)).setFrozen(value);

        emit AgentFrozenSet(account, value, block.timestamp);
    }

    // ---------------------------------------------------------------------
    // Вьюхи для витрины
    // ---------------------------------------------------------------------

    function agentCount() external view returns (uint256) {
        return _agents.length;
    }

    function agentAt(uint256 index) external view returns (AgentRecord memory) {
        return _agents[index];
    }

    function agentOf(address account) external view returns (AgentRecord memory) {
        uint256 index = _indexOf[account];
        require(index != 0, UnknownAgent(account));
        return _agents[index - 1];
    }

    function isRegistered(address account) external view returns (bool) {
        return _indexOf[account] != 0;
    }

    /// @notice Страница реестра — витрина читает агентов пачками, не выгружая всё сразу.
    function agents(uint256 offset, uint256 limit) external view returns (AgentRecord[] memory page) {
        uint256 total = _agents.length;
        if (offset >= total) {
            return new AgentRecord[](0);
        }

        uint256 end = offset + limit;
        if (end > total) {
            end = total;
        }

        page = new AgentRecord[](end - offset);
        for (uint256 i = offset; i < end; i++) {
            page[i - offset] = _agents[i];
        }
    }
}
