/** Next 启动钩子：每个服务端实例启动时执行一次。 */
export async function register(): Promise<void> {
  // Edge Runtime 没有文件系统，也不是 kanban-hub 的运行形态
  if (process.env.NEXT_RUNTIME !== "nodejs") return;

  const { enforceSelfCheck } = await import("./server/selfcheck");
  await enforceSelfCheck();
}
