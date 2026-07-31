// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

/**
 * @notice Два сценария владения кошельком из ТЗ.
 *
 * Оба режима используют одну и ту же контрактную логику (`AgentAccount`) — разница
 * только в том, назначен ли кастодиан. Кастодиан не может тратить средства агента,
 * он лишь настраивает ограничения (лимит и whitelist).
 *
 * - HumanCustodian    — человек создал кошелёк своему агенту, `custodian != address(0)`.
 * - AutonomousEntity  — кошелёк принадлежит самому агенту, `custodian == address(0)`,
 *                       правила недоступны в принципе: максимум доверия, минимум трения.
 */
enum AgentMode {
    HumanCustodian,
    AutonomousEntity
}

/// @dev Единая точка вывода режима из состояния аккаунта, чтобы логика не расползалась.
function modeOf(address custodian) pure returns (AgentMode) {
    return custodian == address(0) ? AgentMode.AutonomousEntity : AgentMode.HumanCustodian;
}
