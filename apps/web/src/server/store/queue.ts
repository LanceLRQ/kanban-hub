/**
 * 单一写入队列（规格 6.3）：所有写操作依次执行，前一个结束（成功或失败）后才开始下一个。
 * M7 的备份也作为队列里的一项执行，执行期间写入自然暂停。
 * 注意：任务里不能等待再次 run() 排进来的任务，否则会互相等待。
 */
export class WriteQueue {
  private tail: Promise<unknown> = Promise.resolve();
  private pending = 0;

  run<T>(job: () => Promise<T>): Promise<T> {
    this.pending += 1;
    const result = this.tail.then(job).finally(() => {
      this.pending -= 1;
    });
    // 队列本身不因为某个任务失败而中断
    this.tail = result.catch(() => undefined);
    return result;
  }

  /** 排队中和执行中的任务数 */
  get size(): number {
    return this.pending;
  }

  /** 等已经排队的任务全部结束 */
  async idle(): Promise<void> {
    await this.tail;
  }
}
