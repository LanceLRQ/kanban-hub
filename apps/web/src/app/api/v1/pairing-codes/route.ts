import { json } from "@/server/api/http";
import { apiRoute } from "@/server/api/route";

export const POST = apiRoute({ auth: "session" }, ({ principal, services }) => {
  const { code, expiresAt } = services.pairing.issue(principal.user.id);
  return json({ code, expiresAt }, { status: 201 });
});
