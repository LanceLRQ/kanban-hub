"use client";

import { useTranslations } from "next-intl";
import { Button } from "@/components/ui/button";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogTrigger,
} from "@/components/ui/alert-dialog";
import { useMutation } from "@/lib/client/api";

/** 吊销机器：先确认，再调用 `POST /api/v1/machines/:id/revoke` */
export function RevokeButton({ machineId, machineName }: { machineId: string; machineName: string }) {
  const t = useTranslations("setup");
  const { mutate } = useMutation();

  return (
    <AlertDialog>
      <AlertDialogTrigger asChild>
        <Button type="button" variant="outline" size="sm">
          {t("machines.revoke")}
        </Button>
      </AlertDialogTrigger>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>{t("machines.revokeConfirmTitle", { name: machineName })}</AlertDialogTitle>
          <AlertDialogDescription>{t("machines.revokeConfirmBody")}</AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel>{t("machines.revokeCancel")}</AlertDialogCancel>
          <AlertDialogAction onClick={() => void mutate(`/api/v1/machines/${machineId}/revoke`, "POST")}>
            {t("machines.revokeConfirm")}
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}
