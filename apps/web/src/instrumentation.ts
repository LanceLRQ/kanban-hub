/** Next 启动钩子：每个服务端进程启动时执行一次，执行完之前不处理请求。 */
export async function register(): Promise<void> {
  // Edge Runtime 没有文件系统，也不是 kanban-hub 的运行形态
  if (process.env.NEXT_RUNTIME !== "nodejs") return;

  // 进程相关的 Node API 都在 boot 模块里，这里只做动态导入，否则 Turbopack 会把它们当作 Edge Runtime 代码告警
  const { boot } = await import("./server/boot");
  await boot();
}
