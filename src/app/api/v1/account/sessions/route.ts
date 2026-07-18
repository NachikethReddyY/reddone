import { maskIpAddress } from "@/server/account";
import { getAuth, getAuthenticatedSession } from "@/server/better-auth";
import { isDemoMode } from "@/server/env";
import { route } from "@/workflows/http";

export function GET(request: Request) {
  return route(request, async () => {
    if (isDemoMode()) {
      return {
        items: [{
          id: "demo-session",
          current: true,
          ipAddress: "127.0.0.xxx",
          userAgent: "ReDDone populated product demo",
          createdAt: "2026-07-17T00:00:00.000Z",
          updatedAt: new Date().toISOString(),
          expiresAt: "2099-12-31T23:59:59.000Z",
        }],
      };
    }
    const current = await getAuthenticatedSession(request);
    if (!current?.session.id) throw new Error("Current session not found.");
    const sessions = await getAuth().api.listSessions({ headers: request.headers });
    return {
      items: sessions.map((session) => ({
        id: session.id,
        current: session.id === current.session.id,
        ipAddress: maskIpAddress(session.ipAddress ?? null),
        userAgent: session.userAgent?.slice(0, 1_000) ?? null,
        createdAt: session.createdAt.toISOString(),
        updatedAt: session.updatedAt.toISOString(),
        expiresAt: session.expiresAt.toISOString(),
      })),
    };
  });
}
