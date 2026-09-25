"use client";

import { useCallback } from "react";
import { useRouter } from "next/navigation";
import { useTranslations } from "next-intl";
import { toast } from "sonner";
import type { z } from "zod";
import { apiErrorSchema, type ApiErrorCode } from "@kanban-hub/core/api";
import { sanitizeNextPath } from "./next-path";

/**
 * `/api/v1` 请求失败时抛出的统一错误：`status` 为 0 表示请求根本没送达服务端（网络错误或
 * CORS 之类被浏览器拦下），`code` 只有在服务端按 `apiErrorSchema` 返回错误信封时才有值。
 *
 * `message` 在 `code` 非 null 时是服务端给的、已经是中文的提示，可以直接展示；
 * `status === 0` 或 `code === null`（响应体不是合法的错误信封）时，`message` 只是给开发者
 * 看日志用的英文诊断文本，不面向用户——这个模块是纯 TS 函数，不在 React 渲染上下文里，
 * 拿不到 `useTranslations`，需要展示给用户的文案由调用方（有 next-intl 上下文）翻译好传入，
 * 见 `useMutation` 的实现。
 */
export class ApiRequestError extends Error {
  constructor(
    readonly status: number,
    message: string,
    readonly code: ApiErrorCode | null = null,
    readonly details?: unknown,
  ) {
    super(message);
    this.name = "ApiRequestError";
  }
}

export interface ApiRequestOptions<T> {
  method?: string;
  body?: unknown;
  /** 提供时用它校验并转换成功响应的 JSON；省略时按 `T` 直接断言 */
  schema?: z.ZodType<T>;
}

/**
 * 对 `/api/v1/*` 发起 JSON 请求。成功时按 `schema`（如果给了）解析后返回；
 * 失败时统一抛 `ApiRequestError`：服务端按错误信封（`{ error: { code, message, details } }`）
 * 响应时带上 code/message/details，响应体不是合法 JSON 或不符合信封形状时 `code` 为 null，
 * 请求本身失败（网络错误）时 `status` 为 0。
 */
export async function apiRequest<T = unknown>(path: string, opts: ApiRequestOptions<T> = {}): Promise<T> {
  const { method = "GET", body, schema } = opts;

  let res: Response;
  try {
    res = await fetch(path, {
      method,
      headers: body !== undefined ? { "content-type": "application/json" } : undefined,
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });
  } catch {
    throw new ApiRequestError(0, "network request failed");
  }

  // 204 No Content（例如登出）没有响应体，不尝试解析
  let payload: unknown;
  if (res.status !== 204) {
    try {
      payload = await res.json();
    } catch {
      throw new ApiRequestError(res.status, "response body is not valid JSON");
    }
  }

  if (!res.ok) {
    const parsed = apiErrorSchema.safeParse(payload);
    if (parsed.success) {
      throw new ApiRequestError(res.status, parsed.data.error.message, parsed.data.error.code, parsed.data.error.details);
    }
    throw new ApiRequestError(res.status, "error response does not match the expected envelope");
  }

  return schema ? schema.parse(payload) : (payload as T);
}

/** 400 响应体里 details.issues 是逐条的字段错误描述（core 的 parseInput 产出） */
function extractIssues(details: unknown): string[] {
  if (details && typeof details === "object" && Array.isArray((details as { issues?: unknown }).issues)) {
    return (details as { issues: unknown[] }).issues.filter((v): v is string => typeof v === "string");
  }
  return [];
}

/**
 * 页面写操作的统一入口：成功后 `router.refresh()` 让服务端组件重新读取最新数据；
 * 按“细节·其他错误的提示”的规则处理各类失败，失败时返回 null（调用方不需要再自己 catch）。
 */
export function useMutation() {
  const router = useRouter();
  const t = useTranslations("common");

  const mutate = useCallback(
    async <T = unknown>(path: string, method: string, body?: unknown): Promise<T | null> => {
      try {
        const result = await apiRequest<T>(path, { method, body });
        router.refresh();
        return result;
      } catch (e) {
        if (!(e instanceof ApiRequestError)) throw e;

        if (e.status === 409) {
          toast.error(t("api.conflict"));
          router.refresh();
          return null;
        }
        if (e.status === 401) {
          const next = typeof window !== "undefined" ? sanitizeNextPath(window.location.pathname) : "/";
          router.push(`/login?next=${encodeURIComponent(next)}`);
          return null;
        }
        if (e.status === 400) {
          const issues = extractIssues(e.details);
          toast.error(issues.length > 0 ? issues.join("；") : e.message);
          return null;
        }
        // status 0（网络错误）和 code 为 null（响应体不是预期的错误信封）时，
        // e.message 只是英文诊断文本，不能直接展示给用户
        if (e.status === 0) {
          toast.error(t("api.networkError"));
          return null;
        }
        if (e.code === null) {
          toast.error(t("api.unexpectedResponse"));
          return null;
        }
        toast.error(e.message);
        return null;
      }
    },
    [router, t],
  );

  return { mutate };
}
