/**
 * Ошибка прикладного уровня с HTTP-статусом. Живёт в отдельном модуле, чтобы её могли
 * использовать и сервисный слой, и слой контрактов, не создавая циклический импорт.
 */
export class AgentError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
    this.name = "AgentError";
  }
}
