/**
 * Помилка адаптера: сирий запис не вдалося перетворити в Listing.
 * Окремий клас, щоб агрегатор міг відрізнити «один битий запис» (пропустити й порахувати)
 * від справжньої помилки в коді (впасти). Перевіряється через `e instanceof AdapterError`.
 */
export class AdapterError extends Error {
  constructor(
    readonly key: string,
    readonly reason: string,
  ) {
    super(`${key}: ${reason}`);
    this.name = "AdapterError";
  }
}
