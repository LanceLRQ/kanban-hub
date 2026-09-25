/** 文档同步范围相关的常量：规格未规定具体数值，这里统一定下，服务端和 kh 共用 */

/** sync.maxFileSize 的默认上限：5MB */
export const SYNC_DEFAULT_MAX_FILE_SIZE = 5 * 1024 * 1024;

/** sync.maxFileSize 允许的硬上限：20MB。超过这个值，登记位置时服务端也会拒绝 */
export const SYNC_MAX_FILE_SIZE_LIMIT = 20 * 1024 * 1024;

/** 无论仓库配置怎么写，这些 glob 始终被排除在同步范围之外 */
export const SYNC_ALWAYS_EXCLUDE = ["**/node_modules/**", "**/.git/**", "**/.next/**"] as const;
