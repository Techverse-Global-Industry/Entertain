import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createSessionJwt, verifySessionJwt } from "../server/auth.mjs";
import { createApp } from "../server/index.mjs";

test("JWT sessions reject tampering and expiration", () => {
  const issuedAt = 1_800_000_000,
    token = createSessionJwt("user-1", "test-signing-key", issuedAt);
  assert.equal(verifySessionJwt(token, "test-signing-key", issuedAt).sub, "user-1");
  assert.equal(verifySessionJwt(token, "different-key", issuedAt), null);
  assert.equal(verifySessionJwt(token, "test-signing-key", issuedAt + 7 * 86400), null);
});

test("JWT sessions and Google OAuth enforce verification and PKCE", async () => {
  const dataDir = mkdtempSync(join(tmpdir(), "promote-auth-")),
    clientId = "test-client.apps.googleusercontent.com",
    redirectUri = "http://localhost/api/auth/google/callback";
  let pendingNonce = "",
    pendingChallenge = "",
    rejectAudience = false;
  const runtime = createApp({
    dataDir,
    scheduler: false,
    googleOAuthConfig: {
      clientId,
      clientSecret: "test-client-secret",
      redirectUri,
    },
    googleFetch: async (input, init = {}) => {
      const url = new URL(input);
      if (url.pathname === "/token") {
        assert.equal(init.method, "POST");
        const form = new URLSearchParams(init.body);
        assert.equal(form.get("client_id"), clientId);
        assert.equal(form.get("redirect_uri"), redirectUri);
        assert.equal(
          createHash("sha256")
            .update(form.get("code_verifier"))
            .digest("base64url"),
          pendingChallenge,
        );
        return Response.json({ id_token: "mock-google-id-token" });
      }
      if (url.pathname === "/tokeninfo") {
        assert.equal(url.searchParams.get("id_token"), "mock-google-id-token");
        return Response.json({
          aud: rejectAudience ? "wrong-client" : clientId,
          iss: "https://accounts.google.com",
          nonce: pendingNonce,
          exp: String(Math.floor(Date.now() / 1000) + 300),
          sub: "google-subject-1",
          email: "google-user@example.test",
          email_verified: "true",
          name: "Google User",
        });
      }
      throw new Error("Unexpected Google endpoint.");
    },
  });
  const server = runtime.app.listen(0, "127.0.0.1");
  await new Promise((resolve) => server.once("listening", resolve));
  const origin = `http://127.0.0.1:${server.address().port}`,
    csrfHeaders = { "X-Promote-Request": "1" },
    cookieFrom = (headers, name) =>
      headers
        .getSetCookie()
        .map((value) => value.split(";")[0])
        .find((value) => value.startsWith(`${name}=`)),
    cookieValue = (cookie, name) =>
      cookie
        .split("; ")
        .find((value) => value.startsWith(`${name}=`))
        ?.slice(name.length + 1);
  const startGoogle = async (returnTo = "/workspaces") => {
    const response = await fetch(
      `${origin}/api/auth/google?return=${encodeURIComponent(returnTo)}`,
      { redirect: "manual" },
    );
    assert.equal(response.status, 302);
    const authorization = new URL(response.headers.get("location")),
      cookies = response.headers.getSetCookie(),
      cookie = cookies.map((value) => value.split(";")[0]).join("; ");
    pendingNonce = cookieValue(cookie, "promote_oauth_nonce");
    pendingChallenge = authorization.searchParams.get("code_challenge");
    assert.equal(authorization.origin, "https://accounts.google.com");
    assert.equal(authorization.searchParams.get("state"), cookieValue(cookie, "promote_oauth_state"));
    assert.equal(authorization.searchParams.get("nonce"), pendingNonce);
    assert.equal(
      authorization.searchParams.get("code_challenge_method"),
      "S256",
    );
    assert.ok(
      cookies.every((value) => /HttpOnly/i.test(value) && /SameSite=Lax/i.test(value)),
    );
    return { authorization, cookie };
  };
  const finishGoogle = (cookie, state) =>
    fetch(
      `${origin}/api/auth/google/callback?code=mock-code&state=${encodeURIComponent(state)}`,
      { headers: { Cookie: cookie }, redirect: "manual" },
    );
  try {
    const setup = await fetch(`${origin}/api/setup`, {
      method: "POST",
      headers: {
        ...csrfHeaders,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        name: "Test Administrator",
        email: "admin@example.test",
        password: "Test-admin-password-2026",
      }),
    });
    assert.equal(setup.status, 201);
    let sessionCookie = cookieFrom(setup.headers, "promote_session");
    assert.ok(sessionCookie);
    assert.equal(sessionCookie.split(".").length, 3);

    const passwordLogin = await fetch(`${origin}/api/auth/login`, {
      method: "POST",
      headers: {
        ...csrfHeaders,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        email: "admin@example.test",
        password: "Test-admin-password-2026",
      }),
    });
    assert.equal(passwordLogin.status, 200);
    sessionCookie = cookieFrom(passwordLogin.headers, "promote_session");
    const validSession = await fetch(`${origin}/api/auth/me`, {
      headers: { Cookie: sessionCookie },
    });
    assert.equal((await validSession.json()).user.email, "admin@example.test");
    const tampered = `${sessionCookie.slice(0, -1)}${sessionCookie.endsWith("a") ? "b" : "a"}`,
      rejectedSession = await fetch(`${origin}/api/auth/me`, {
        headers: { Cookie: tampered },
      });
    assert.equal((await rejectedSession.json()).user, null);

    const csrfFlow = await startGoogle("https://attacker.example/");
    assert.equal(
      csrfFlow.authorization.searchParams.get("redirect_uri"),
      redirectUri,
    );
    const rejectedState = await finishGoogle(
      csrfFlow.cookie,
      "attacker-controlled-state",
    );
    assert.equal(rejectedState.status, 403);

    const unsafeReturnFlow = await startGoogle("/\\attacker.example"),
      unsafeReturn = await finishGoogle(
        unsafeReturnFlow.cookie,
        unsafeReturnFlow.authorization.searchParams.get("state"),
      );
    assert.equal(unsafeReturn.status, 303);
    assert.equal(unsafeReturn.headers.get("location"), "/workspaces");

    const flow = await startGoogle("/dashboard/mchenry"),
      callback = await finishGoogle(
        flow.cookie,
        flow.authorization.searchParams.get("state"),
      );
    assert.equal(callback.status, 303);
    assert.equal(callback.headers.get("location"), "/dashboard/mchenry");
    const googleSession = cookieFrom(callback.headers, "promote_session");
    assert.ok(googleSession);
    const profile = await fetch(`${origin}/api/auth/me`, {
      headers: { Cookie: googleSession },
    });
    assert.equal((await profile.json()).user.email, "google-user@example.test");

    rejectAudience = true;
    const invalidIdentityFlow = await startGoogle(),
      invalidIdentity = await finishGoogle(
        invalidIdentityFlow.cookie,
        invalidIdentityFlow.authorization.searchParams.get("state"),
      );
    assert.equal(invalidIdentity.status, 401);
    assert.equal(
      cookieFrom(invalidIdentity.headers, "promote_session"),
      undefined,
    );
  } finally {
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
    runtime.close();
    rmSync(dataDir, { recursive: true, force: true });
  }
});
