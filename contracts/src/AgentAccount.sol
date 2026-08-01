// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {SimpleAccount} from "@account-abstraction/contracts/accounts/SimpleAccount.sol";
import {BaseAccount} from "@account-abstraction/contracts/core/BaseAccount.sol";
import {IEntryPoint} from "@account-abstraction/contracts/interfaces/IEntryPoint.sol";
import {PackedUserOperation} from "@account-abstraction/contracts/interfaces/PackedUserOperation.sol";
import {
    SIG_VALIDATION_FAILED,
    SIG_VALIDATION_SUCCESS,
    _packValidationData
} from "@account-abstraction/contracts/core/Helpers.sol";
import {Exec} from "@account-abstraction/contracts/utils/Exec.sol";
import {ECDSA} from "@openzeppelin/contracts/utils/cryptography/ECDSA.sol";

import {AgentMode, modeOf} from "./lib/AgentTypes.sol";
import {SessionKeys} from "./lib/SessionKeys.sol";
import {SpendingRules} from "./lib/SpendingRules.sol";

/**
 * @title AgentAccount
 * @notice ERC-4337 кошелёк, владельцем которого выступает ИИ-агент.
 *
 * @dev Это расширение канонического `SimpleAccount` из eth-infinitism/account-abstraction
 *      (v0.9.0), а не собственная реализация ERC-4337. Из референса без изменений берутся
 *      валидация подписи, работа с EntryPoint, депозит на газ и UUPS-апгрейд. Сверху
 *      добавлено ровно четыре вещи, требуемые ТЗ:
 *
 *      1. Два сценария владения (см. `AgentTypes.sol`) — через наличие кастодиана.
 *      2. Опциональные правила трат (лимит + whitelist) — только для Human Custodian.
 *      3. Публичный лог транзакций — событие `AgentTransaction` на каждую исходящую трату.
 *      4. Обратимая административная заморозка, управляемая реестром.
 *
 *      Оба сценария из ТЗ используют этот же контракт: у Autonomous Entity кастодиан
 *      равен address(0), и правила для него недоступны на уровне контракта, а не только UI.
 */
contract AgentAccount is SimpleAccount {
    using SpendingRules for SpendingRules.Config;
    using SessionKeys for SessionKeys.Key;

    /// @notice Кастодиан-человек; address(0) => режим Autonomous Entity.
    address public custodian;

    /// @notice Реестр агентов — единственный, кто может замораживать этот кошелёк.
    address public registry;

    /// @notice Заморожен ли кошелёк (обратимо, на случай мошенничества или бага).
    bool public frozen;

    /// @notice Правила трат. Всегда пустые в режиме Autonomous Entity.
    SpendingRules.Config public rules;

    /// @notice Разрешённые получатели, если `rules.whitelistEnabled`.
    mapping(address => bool) public whitelisted;

    SpendingRules.Window private _window;

    /**
     * @notice Ограниченные ключи подписи. Владелец выдаёт их тем, кто действует от его
     *         имени — например платформе, отправляющей операции агента, — и в любой
     *         момент отзывает.
     */
    mapping(address signer => SessionKeys.Key) public sessionKeys;

    /**
     * @notice Поколение списка получателей ключа. Увеличивается при каждой выдаче
     *         ключа (`registerSessionKey`), поэтому targets старых выдач становятся
     *         недостижимы для проверки: читается всегда только текущее поколение.
     * @dev Занимает слот бывшего публичного mapping `sessionKeyTargets` — см. комментарий
     *      у `_sessionKeyTargets`.
     */
    mapping(address signer => uint64) public sessionKeyGeneration;

    /**
     * @notice Разрешённые получатели ключа по поколениям, если `targetsRestricted`.
     * @dev Приватное хранилище: наружу targets отдаёт explicit-геттер `sessionKeyTargets`,
     *      который подставляет ТЕКУЩЕЕ поколение. Поколение инкрементируется при перевыпуске
     *      ключа, поэтому сузить список получателей можно одним `registerSessionKey` —
     *      чистить записи прошлых выдач не нужно, они больше ниоткуда не читаются.
     */
    mapping(address signer => mapping(uint64 generation => mapping(address target => bool))) private
        _sessionKeyTargets;

    /**
     * @notice Публичный лог трат: кто, куда, сколько, когда.
     * @dev `account` дублирует адрес эмитента события — так индексатору витрины не нужно
     *      знать список кошельков заранее, достаточно фильтра по одной теме.
     */
    event AgentTransaction(
        address indexed account, address indexed to, uint256 value, bytes4 selector, uint256 timestamp
    );

    event AgentAccountInitialized(address indexed owner, address indexed custodian, AgentMode mode);
    event RulesUpdated(uint128 limitWei, uint64 periodSeconds, bool whitelistEnabled);
    event WhitelistUpdated(address indexed target, bool allowed);
    event FrozenSet(bool frozen);
    event SessionKeyRegistered(
        address indexed signer,
        uint48 validAfter,
        uint48 validUntil,
        uint128 budgetWei,
        bool targetsRestricted
    );
    event SessionKeyRevoked(address indexed signer);

    error UseInitializeAgent();
    error NotCustodian(address msgSender, address custodian);
    error NotRegistry(address msgSender, address registry);
    error RulesRequireCustodian();
    error AccountFrozen();
    error RecipientNotWhitelisted(address target);
    error NotOwnerOrSessionKey(address msgSender);

    constructor(IEntryPoint anEntryPoint) SimpleAccount(anEntryPoint) {}

    modifier onlyCustodian() {
        _onlyCustodian();
        _;
    }

    function _onlyCustodian() internal view {
        address custodian_ = custodian;
        // В режиме Autonomous Entity кастодиана нет — значит и правил быть не может.
        require(custodian_ != address(0), RulesRequireCustodian());
        require(msg.sender == custodian_, NotCustodian(msg.sender, custodian_));
    }

    // ---------------------------------------------------------------------
    // Инициализация
    // ---------------------------------------------------------------------

    /**
     * @notice Инициализатор `SimpleAccount` отключён: кошелёк агента нельзя создать
     *         без указания режима и реестра.
     */
    function initialize(address) public pure override {
        revert UseInitializeAgent();
    }

    /**
     * @notice Создаёт кошелёк агента.
     * @param anOwner          ключ, которым агент подписывает UserOperation
     * @param aCustodian       кастодиан-человек или address(0) для Autonomous Entity
     * @param aRegistry        реестр, которому разрешена заморозка
     * @param initialRules     стартовые правила; должны быть пустыми без кастодиана
     * @param initialWhitelist стартовый whitelist; должен быть пустым без кастодиана
     */
    function initializeAgent(
        address anOwner,
        address aCustodian,
        address aRegistry,
        SpendingRules.Config calldata initialRules,
        address[] calldata initialWhitelist
    ) public virtual initializer {
        _initialize(anOwner);

        custodian = aCustodian;
        registry = aRegistry;

        if (aCustodian == address(0)) {
            // Autonomous Entity: никаких правил, «мы не спрашиваем документы».
            require(
                initialRules.limitWei == 0 && initialRules.periodSeconds == 0
                    && !initialRules.whitelistEnabled && initialWhitelist.length == 0,
                RulesRequireCustodian()
            );
        } else {
            rules = initialRules;
            for (uint256 i = 0; i < initialWhitelist.length; i++) {
                whitelisted[initialWhitelist[i]] = true;
                emit WhitelistUpdated(initialWhitelist[i], true);
            }
            emit RulesUpdated(
                initialRules.limitWei, initialRules.periodSeconds, initialRules.whitelistEnabled
            );
        }

        emit AgentAccountInitialized(anOwner, aCustodian, modeOf(aCustodian));
    }

    // ---------------------------------------------------------------------
    // Исполнение (переопределяет BaseAccount)
    // ---------------------------------------------------------------------

    /// @notice Исполнить одиночный вызов от имени агента.
    /// @dev Копия базовой реализации `BaseAccount` плюс проверка правил и запись в публичный лог.
    function execute(address target, uint256 value, bytes calldata data) external override {
        _requireForExecute();
        _authorizeSpend(target, value);

        bool ok = Exec.call(target, value, data, gasleft());
        if (!ok) {
            Exec.revertWithReturnData();
        }

        _logTransaction(target, value, data);
    }

    /// @notice Исполнить пачку вызовов от имени агента.
    /// @dev Правила применяются к каждому вызову батча по отдельности, лимит расходуется
    ///      накопительно — иначе батч был бы способом обойти ограничение.
    function executeBatch(Call[] calldata calls) external override {
        _requireForExecute();

        uint256 callsLength = calls.length;
        for (uint256 i = 0; i < callsLength; i++) {
            Call calldata call = calls[i];
            _authorizeSpend(call.target, call.value);

            bool ok = Exec.call(call.target, call.value, call.data, gasleft());
            if (!ok) {
                if (callsLength == 1) {
                    Exec.revertWithReturnData();
                } else {
                    revert ExecuteError(i, Exec.getReturnData(0));
                }
            }

            _logTransaction(call.target, call.value, call.data);
        }
    }

    /**
     * @dev Валидация подписи. Здесь же живут все проверки session key.
     *
     *      Читается только собственный storage аккаунта и разбирается calldata самой
     *      операции — правила ERC-7562 не нарушаются, поэтому настоящий бандлер отбракует
     *      негодную операцию ещё до попадания в блок.
     *
     *      Срок действия ключа НЕ сверяется здесь с `block.timestamp`: в фазе валидации это
     *      запрещено. Вместо этого диапазон возвращается в `validationData`, и его проверяет
     *      сам EntryPoint — штатный механизм ERC-4337.
     */
    function _validateSignature(PackedUserOperation calldata userOp, bytes32 userOpHash)
        internal
        virtual
        override
        returns (uint256 validationData)
    {
        if (frozen) {
            return SIG_VALIDATION_FAILED;
        }

        address signer = ECDSA.recover(userOpHash, userOp.signature);
        if (signer == owner) {
            return SIG_VALIDATION_SUCCESS;
        }

        SessionKeys.Key storage key = sessionKeys[signer];
        if (!key.exists()) {
            return SIG_VALIDATION_FAILED;
        }

        _consumeSessionAllowance(signer, key, userOp.callData);

        return _packValidationData(false, key.validUntil, key.validAfter);
    }

    /**
     * @dev Проверяет, что операция укладывается в границы ключа, и списывает её из бюджета.
     *
     *      Нарушение границ — не «неверная подпись», а именно нарушение выданных условий,
     *      поэтому здесь revert с внятной ошибкой, а не `SIG_VALIDATION_FAILED`.
     */
    function _consumeSessionAllowance(address signer, SessionKeys.Key storage key, bytes calldata callData)
        internal
    {
        BaseAccount.Call[] memory calls = SessionKeys.decodeCalls(callData);

        for (uint256 i = 0; i < calls.length; i++) {
            address target = calls[i].target;
            // Ключу закрыты вызовы самого кошелька и EntryPoint — независимо от списка
            // разрешённых получателей. Иначе через `execute(address(this), 0, …)` ключ
            // вызвал бы методы «только для владельца» (`registerSessionKey`,
            // `upgradeToAndCall`, `withdrawDepositTo`): в `SimpleAccount` onlyOwner
            // пропускает вызов от имени самого аккаунта, а через вызов EntryPoint
            // ключ снял бы депозит на газ в обход своего бюджета.
            require(
                target != address(this) && target != address(entryPoint()),
                SessionKeys.SessionTargetNotAllowed(target)
            );
            if (key.targetsRestricted) {
                // Проверка идёт по ТЕКУЩЕМУ поколению списка: targets от прошлых выдач
                // ключа недействительны после перевыпуска или отзыва.
                // Читаем storage напрямую, а не через external-геттер: self-CALL стоил бы
                // лишний газ на каждый target и добавлял бы риск несовместимости с
                // ERC-7562-трассировщиками бандлеров в фазе валидации.
                require(
                    _sessionKeyTargets[signer][sessionKeyGeneration[signer]][target],
                    SessionKeys.SessionTargetNotAllowed(target)
                );
            }
            key.consume(calls[i].value);
        }
    }

    function _authorizeSpend(address target, uint256 value) internal {
        require(!frozen, AccountFrozen());

        // Правила существуют только в режиме Human Custodian — в Autonomous они пустые.
        if (rules.whitelistEnabled) {
            require(whitelisted[target], RecipientNotWhitelisted(target));
        }
        rules.consume(_window, value);
    }

    function _logTransaction(address target, uint256 value, bytes calldata data) internal {
        // Обрезка до 4 байт намеренная: в лог пишется селектор вызванного метода,
        // а для простого перевода ETH (пустой calldata) — нулевой селектор.
        // forge-lint: disable-next-line(unsafe-typecast)
        bytes4 selector = data.length >= 4 ? bytes4(data) : bytes4(0);
        emit AgentTransaction(address(this), target, value, selector, block.timestamp);
    }

    // ---------------------------------------------------------------------
    // Управление правилами (кастодиан)
    // ---------------------------------------------------------------------

    function setRules(SpendingRules.Config calldata newRules) external onlyCustodian {
        rules = newRules;
        emit RulesUpdated(newRules.limitWei, newRules.periodSeconds, newRules.whitelistEnabled);
    }

    function setWhitelisted(address target, bool allowed) external onlyCustodian {
        whitelisted[target] = allowed;
        emit WhitelistUpdated(target, allowed);
    }

    function setWhitelistedBatch(address[] calldata targets, bool allowed) external onlyCustodian {
        for (uint256 i = 0; i < targets.length; i++) {
            whitelisted[targets[i]] = allowed;
            emit WhitelistUpdated(targets[i], allowed);
        }
    }

    // ---------------------------------------------------------------------
    // Ключи ограниченного доступа (владелец)
    // ---------------------------------------------------------------------

    /**
     * @notice Выдаёт ключ, которым можно платить от имени кошелька в заданных границах.
     * @param signer            адрес ключа, которому выдаются права
     * @param validAfter        не раньше этого времени; 0 — сразу
     * @param validUntil        не позже; ноль запрещён, вечных ключей не бывает
     * @param budgetWei         сколько всего разрешено потратить этим ключом
     * @param allowedTargets    список получателей; пустой — ограничения по адресам нет
     *
     * @dev Повторный вызов для того же адреса перезаписывает условия и обнуляет
     *      израсходованное — так владелец продлевает ключ, не заводя новый. Заодно
     *      перевыпуск заменяет список получателей целиком: начинается новое поколение
     *      (`sessionKeyGeneration`), и разрешения прошлой выдачи больше не действуют.
     */
    function registerSessionKey(
        address signer,
        uint48 validAfter,
        uint48 validUntil,
        uint128 budgetWei,
        address[] calldata allowedTargets
    ) external onlyOwner {
        require(validUntil != 0, SessionKeys.SessionKeyNeedsExpiry());
        require(budgetWei != 0, SessionKeys.SessionKeyNeedsBudget());

        // Новое поколение — до записи targets. Благодаря инкременту список получателей
        // прошлой выдачи автоматически перестаёт действовать: проверка и геттер читают
        // только текущее поколение, а старые записи удалять не нужно.
        uint64 generation = ++sessionKeyGeneration[signer];

        sessionKeys[signer] = SessionKeys.Key({
            validAfter: validAfter,
            validUntil: validUntil,
            budgetWei: budgetWei,
            spentWei: 0,
            targetsRestricted: allowedTargets.length != 0
        });

        for (uint256 i = 0; i < allowedTargets.length; i++) {
            _sessionKeyTargets[signer][generation][allowedTargets[i]] = true;
        }

        emit SessionKeyRegistered(signer, validAfter, validUntil, budgetWei, allowedTargets.length != 0);
    }

    /**
     * @notice Отзывает ключ немедленно.
     * @dev Отозвать может владелец или сам держатель ключа — если он понял, что
     *      скомпрометирован, ему не нужно ждать реакции владельца.
     *
     *      Поколение targets здесь намеренно НЕ инкрементируется: без записи в
     *      `sessionKeys` ключ не проходит валидацию, значит его список получателей
     *      уже недостижим, а следующая выдача (`registerSessionKey`) в любом случае
     *      начнёт новое поколение.
     */
    function revokeSessionKey(address signer) external {
        require(msg.sender == owner || msg.sender == signer, NotOwnerOrSessionKey(msg.sender));

        delete sessionKeys[signer];
        emit SessionKeyRevoked(signer);
    }

    /**
     * @notice Разрешён ли `target` для ключа `signer` в его ТЕКУЩЕМ поколении.
     * @dev Explicit-геттер с той же сигнатурой (и тем же селектором), что была у
     *      публичного mapping `sessionKeyTargets` до перехода на поколения, — web-клиент
     *      и ABI не меняются. Отличия в семантике: targets прошлых выдач ключа здесь
     *      больше не видны, а для отозванного ключа возвращается false — чтобы off-chain
     *      UI не показывал устаревшие разрешения.
     */
    function sessionKeyTargets(address signer, address target) external view returns (bool) {
        return sessionKeys[signer].exists() && _sessionKeyTargets[signer][sessionKeyGeneration[signer]][target];
    }

    /// @notice Остаток бюджета ключа.
    function sessionKeyRemaining(address signer) external view returns (uint256) {
        return sessionKeys[signer].remaining();
    }

    // ---------------------------------------------------------------------
    // Администрирование (реестр)
    // ---------------------------------------------------------------------

    /**
     * @notice Апгрейд реализации запрещён замороженному кошельку.
     * @dev Иначе заблокированный за мошенничество агент увёл бы кошелёк на новую
     *      реализацию в обход реестра. Права на апгрейд не меняются: `super`
     *      сохраняет `onlyProxy` и вызов базового `_authorizeUpgrade`, где права
     *      остаются за владельцем, как в `SimpleAccount` (UUPS).
     *
     *      Проверка вешается на публичный UUPS-метод, а не на `_authorizeUpgrade`:
     *      в account-abstraction v0.9.0 `SimpleAccount._authorizeUpgrade` объявлен
     *      БЕЗ `virtual`, поэтому переопределить его в наследнике нельзя.
     */
    function upgradeToAndCall(address newImplementation, bytes memory data)
        public
        payable
        override
    {
        require(!frozen, AccountFrozen());
        super.upgradeToAndCall(newImplementation, data);
    }

    /// @notice Обратимая заморозка. Вызывается только реестром.
    function setFrozen(bool value) external {
        address registry_ = registry;
        require(msg.sender == registry_, NotRegistry(msg.sender, registry_));
        frozen = value;
        emit FrozenSet(value);
    }

    // ---------------------------------------------------------------------
    // Вьюхи для дашборда
    // ---------------------------------------------------------------------

    function mode() external view returns (AgentMode) {
        return modeOf(custodian);
    }

    /// @notice Остаток лимита в текущем окне; type(uint256).max, если лимита нет.
    function spendingRemaining() external view returns (uint256) {
        return rules.remaining(_window);
    }

    /// @notice Состояние текущего окна расходов (для отображения прогресса).
    function spendingWindow() external view returns (uint64 startedAt, uint128 spentWei) {
        return (_window.startedAt, _window.spentWei);
    }
}
