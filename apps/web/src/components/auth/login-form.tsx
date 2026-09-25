"use client";

import { useState, type FormEvent } from "react";
import { useRouter } from "next/navigation";
import { useTranslations } from "next-intl";
import { rateLimitDetailsSchema } from "@kanban-hub/core/api";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { apiRequest, ApiRequestError } from "@/lib/client/api";

interface LoginResponse {
  user: { id: string; name: string };
}

export function LoginForm({ nextPath }: { nextPath: string }) {
  const router = useRouter();
  const t = useTranslations("login");
  const [password, setPassword] = useState("");
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function handleSubmit(event: FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault();
    setPending(true);
    setError(null);
    try {
      await apiRequest<LoginResponse>("/api/v1/auth/login", { method: "POST", body: { password } });
      router.push(nextPath);
      router.refresh();
    } catch (e) {
      if (!(e instanceof ApiRequestError)) throw e;
      setError(describeError(e, t));
    } finally {
      setPending(false);
    }
  }

  return (
    <form onSubmit={(e) => void handleSubmit(e)} className="flex flex-col gap-3">
      <Input
        type="password"
        placeholder={t("passwordPlaceholder")}
        value={password}
        onChange={(e) => setPassword(e.target.value)}
        autoFocus
        required
      />
      <Button type="submit" disabled={pending || password.length === 0}>
        {pending ? t("submitting") : t("submit")}
      </Button>
      {error !== null && (
        <p role="alert" className="text-sm text-destructive">
          {error}
        </p>
      )}
    </form>
  );
}

function describeError(e: ApiRequestError, t: (key: string, values?: Record<string, string | number | Date>) => string): string {
  if (e.status === 0) return t("errors.network");
  if (e.code === "rate_limited") {
    const parsed = rateLimitDetailsSchema.safeParse(e.details);
    return t("errors.rateLimited", { seconds: parsed.success ? parsed.data.retryAfterSeconds : 60 });
  }
  return e.message;
}
