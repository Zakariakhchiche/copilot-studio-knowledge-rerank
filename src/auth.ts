import { createRemoteJWKSet, jwtVerify } from "jose";
import type { Request } from "express";

/**
 * Returns the groups of the user who asks, used to filter the index.
 *
 * - "entra": validates the Microsoft Entra ID access token sent by a custom connector with
 *   user authentication, and reads its `groups` claim (enable "groups" in the token
 *   configuration of the app registration).
 * - "demo": trusts the x-demo-groups header. Local tests only: anyone can forge it.
 * - "none": no trimming. Only for a corpus that every agent user may read in full.
 */
export type AuthMode = "entra" | "demo" | "none";

let jwks: ReturnType<typeof createRemoteJWKSet> | undefined;

export async function userGroups(req: Request, env = process.env): Promise<string[] | undefined> {
  const mode = (env.AUTH_MODE ?? "demo") as AuthMode;
  if (mode === "none") return undefined;
  if (mode === "demo") {
    const h = req.header("x-demo-groups");
    return h ? h.split(",").map((g) => g.trim()).filter(Boolean) : [];
  }
  const token = req.header("authorization")?.replace(/^Bearer\s+/i, "");
  if (!token) throw new HttpError(401, "missing bearer token");
  const tenant = env.ENTRA_TENANT_ID;
  if (!tenant || !env.ENTRA_AUDIENCE) throw new HttpError(500, "ENTRA_TENANT_ID and ENTRA_AUDIENCE are required");
  jwks ??= createRemoteJWKSet(new URL(`https://login.microsoftonline.com/${tenant}/discovery/v2.0/keys`));
  const { payload } = await jwtVerify(token, jwks, {
    issuer: `https://login.microsoftonline.com/${tenant}/v2.0`,
    audience: env.ENTRA_AUDIENCE,
  }).catch(() => {
    throw new HttpError(401, "invalid token");
  });
  // Users in too many groups get an overage claim instead of the list: resolve it with
  // Microsoft Graph, or emit app roles instead of groups.
  if ((payload as any)._claim_names?.groups) throw new HttpError(403, "group overage: resolve groups with Microsoft Graph");
  return ((payload as any).groups as string[] | undefined) ?? [];
}

export class HttpError extends Error {
  constructor(
    public status: number,
    message: string,
  ) {
    super(message);
  }
}
