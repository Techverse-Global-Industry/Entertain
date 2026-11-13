import { createHmac, randomUUID, timingSafeEqual } from "node:crypto";

const issuer = "promote";
const audience = "promote-api";
const sessionLifetime = 7 * 86400;

export function createSessionJwt(
  userId,
  signingKey,
  issuedAt = Math.floor(Date.now() / 1000),
) {
  const header = Buffer.from(
      JSON.stringify({ alg: "HS256", typ: "JWT" }),
    ).toString("base64url"),
    payload = Buffer.from(
      JSON.stringify({
        sub: userId,
        jti: randomUUID(),
        iss: issuer,
        aud: audience,
        iat: issuedAt,
        exp: issuedAt + sessionLifetime,
      }),
    ).toString("base64url"),
    content = `${header}.${payload}`,
    signature = createHmac("sha256", signingKey)
      .update(content)
      .digest("base64url");
  return `${content}.${signature}`;
}

export function verifySessionJwt(
  token,
  signingKey,
  now = Math.floor(Date.now() / 1000),
) {
  if (typeof token !== "string" || token.length > 4096) return null;
  const parts = token.split(".");
  if (
    parts.length !== 3 ||
    parts.some((part) => !/^[A-Za-z0-9_-]+$/.test(part))
  )
    return null;
  const [encodedHeader, encodedPayload, encodedSignature] = parts,
    content = `${encodedHeader}.${encodedPayload}`,
    expected = createHmac("sha256", signingKey).update(content).digest(),
    received = Buffer.from(encodedSignature, "base64url");
  if (
    received.length !== expected.length ||
    !timingSafeEqual(expected, received)
  )
    return null;
  let header, payload;
  try {
    header = JSON.parse(Buffer.from(encodedHeader, "base64url").toString());
    payload = JSON.parse(Buffer.from(encodedPayload, "base64url").toString());
  } catch {
    return null;
  }
  if (
    header?.alg !== "HS256" ||
    header?.typ !== "JWT" ||
    payload?.iss !== issuer ||
    payload?.aud !== audience ||
    typeof payload?.sub !== "string" ||
    !payload.sub ||
    typeof payload?.jti !== "string" ||
    !payload.jti ||
    !Number.isSafeInteger(payload.iat) ||
    !Number.isSafeInteger(payload.exp) ||
    payload.iat > now + 60 ||
    payload.exp <= now ||
    payload.exp - payload.iat !== sessionLifetime
  )
    return null;
  return payload;
}
