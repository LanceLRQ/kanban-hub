"use client";

import { useCallback, useRef } from "react";
import { useMutation } from "@/lib/client/api";

interface PatchState {
  path: string;
  /** 本组件最近一次成功保存拿到的 version；页面刷新前，它可能比 props 里的新 */
  version: number;
  /** 同一实体的保存串行执行，后一次总是带上前一次保存后的 version */
  chain: Promise<unknown>;
}

/**
 * 对同一个实体（任务、容器、项目）的 PATCH：请求体自动带上已知的最新 version。
 *
 * 连续保存（例如快速勾选两项清单）时，第二次请求发出前页面可能还没刷新，props 里的 version
 * 仍是旧的；这里把保存串起来，并记住上一次成功响应里的 version，避免自己和自己冲突。
 * 失败（含 409）时返回 null，提示与刷新由 `useMutation` 统一处理。
 */
export function useVersionedPatch(path: string, version: number) {
  const { mutate } = useMutation();
  const state = useRef<PatchState>({ path, version, chain: Promise.resolve() });

  return useCallback(
    <T extends { version: number }>(body: Record<string, unknown>): Promise<T | null> => {
      const run = async (): Promise<T | null> => {
        const s = state.current;
        if (s.path !== path) {
          s.path = path;
          s.version = version;
        }
        const result = await mutate<T>(path, "PATCH", { ...body, version: Math.max(version, s.version) });
        if (result && state.current.path === path) state.current.version = Math.max(state.current.version, result.version);
        return result;
      };
      const next = state.current.chain.then(run, run);
      state.current.chain = next.catch(() => undefined);
      return next;
    },
    [mutate, path, version],
  );
}
