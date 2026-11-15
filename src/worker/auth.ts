export interface AuthEnv {
  ACCESS_AUD?: string;
  ACCESS_ISSUER?: string;
  ENVIRONMENT?: string;
  LOCAL_DEV_AUTH_BYPASS?: string;
  MACHINE_TOKENS_JSON?: string;
  MCP_TOKEN_SHA256?: string;
}

interface JwtHeader {
  alg?: string;
  kid?: string;
}

interface JwtClaims {
  aud?: string | string[];
  exp?: number;
  iss?: string;
}

interface Jwk {
  kid?: string;
  kty?: string;
  n?: string;
  e?: string;
}

const encoder = new TextEncoder();
let jwksCache: { expiresAt: number; keys: Jwk[]; issuer: string } | null = null;

export function localBypass(env: AuthEnv): boolean {
  return env.ENVIRONMENT === "local" && env.LOCAL_DEV_AUTH_BYPASS === "true";
}

export async function sha256Hex(value: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", encoder.encode(value));
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

export function timingSafeEqual(left: string, right: string): boolean {
  if (left.length !== right.length) return false;
  let diff = 0;
  for (let i = 0; i < left.length; i += 1) diff |= left.charCodeAt(i) ^ right.charCodeAt(i);
  return diff === 0;
}

export async function machineFromToken(request: Request, env: AuthEnv): Promise<string | null> {
  if (localBypass(env) && env.MACHINE_TOKENS_JSON === undefined) return "machine-a";
  const header = request.headers.get("authorization") ?? "";
  if (!header.startsWith("Bearer ")) return null;
  const token = header.slice("Bearer ".length);
  if (!token || !env.MACHINE_TOKENS_JSON) return null;
  let mapping: unknown;
  try {
    mapping = JSON.parse(env.MACHINE_TOKENS_JSON);
  } catch {
    return null;
  }
  if (typeof mapping !== "object" || mapping === null) return null;
  const hash = await sha256Hex(token);
  for (const [machine, expected] of Object.entries(mapping)) {
    if (typeof expected === "string" && timingSafeEqual(hash, expected.toLowerCase())) {
      return machine;
    }
  }
  return null;
}

export async function mcpAuthorized(request: Request, env: AuthEnv): Promise<boolean> {
  if (localBypass(env) && env.MCP_TOKEN_SHA256 === undefined) return true;
  const header = request.headers.get("authorization") ?? "";
  if (!header.startsWith("Bearer ") || !env.MCP_TOKEN_SHA256) return false;
  const hash = await sha256Hex(header.slice("Bearer ".length));
  return timingSafeEqual(hash, env.MCP_TOKEN_SHA256.toLowerCase());
}

function base64UrlJson<T>(value: string): T {
  const padded = value
    .replace(/-/g, "+")
    .replace(/_/g, "/")
    .padEnd(Math.ceil(value.length / 4) * 4, "=");
  return JSON.parse(atob(padded)) as T;
}

function base64UrlBytes(value: string): Uint8Array<ArrayBuffer> {
  const padded = value
    .replace(/-/g, "+")
    .replace(/_/g, "/")
    .padEnd(Math.ceil(value.length / 4) * 4, "=");
  const binary = atob(padded);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

async function accessKeys(issuer: string): Promise<Jwk[]> {
  if (jwksCache && jwksCache.issuer === issuer && jwksCache.expiresAt > Date.now()) {
    return jwksCache.keys;
  }
  const response = await fetch(`${issuer.replace(/\/$/, "")}/cdn-cgi/access/certs`);
  if (!response.ok) throw new Error("access certs unavailable");
  const parsed: unknown = await response.json();
  const keys =
    typeof parsed === "object" && parsed !== null && "keys" in parsed
      ? ((parsed as { keys: Jwk[] }).keys ?? [])
      : Array.isArray(parsed)
        ? (parsed as Jwk[])
        : [];
  jwksCache = { expiresAt: Date.now() + 10 * 60 * 1000, issuer, keys };
  return keys;
}

export async function accessAuthorized(request: Request, env: AuthEnv): Promise<boolean> {
  if (localBypass(env)) return true;
  if (!env.ACCESS_ISSUER || !env.ACCESS_AUD) return false;
  const cookie = request.headers.get("cookie") ?? "";
  const cookieToken = cookie
    .split(";")
    .map((part) => part.trim())
    .find((part) => part.startsWith("CF_Authorization="))
    ?.slice("CF_Authorization=".length);
  const token = request.headers.get("cf-access-jwt-assertion") ?? cookieToken;
  if (!token) return false;
  const parts = token.split(".");
  if (parts.length !== 3) return false;
  try {
    const header = base64UrlJson<JwtHeader>(parts[0] as string);
    const claims = base64UrlJson<JwtClaims>(parts[1] as string);
    if (header.alg !== "RS256") return false;
    if (claims.iss !== env.ACCESS_ISSUER) return false;
    const audiences = Array.isArray(claims.aud) ? claims.aud : [claims.aud];
    if (!audiences.includes(env.ACCESS_AUD)) return false;
    if (!claims.exp || claims.exp * 1000 <= Date.now()) return false;
    const keys = await accessKeys(env.ACCESS_ISSUER);
    const jwk = keys.find((key) => key.kid === header.kid) ?? keys[0];
    if (!jwk) return false;
    const key = await crypto.subtle.importKey(
      "jwk",
      jwk as JsonWebKey,
      { hash: "SHA-256", name: "RSASSA-PKCS1-v1_5" },
      false,
      ["verify"],
    );
    return await crypto.subtle.verify(
      "RSASSA-PKCS1-v1_5",
      key,
      base64UrlBytes(parts[2] as string),
      encoder.encode(`${parts[0]}.${parts[1]}`),
    );
  } catch {
    return false;
  }
}
