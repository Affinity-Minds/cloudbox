// WT-10: the two Worker-side additions for CloudBox Server Setup (Windows).
//   GET /api/v1/agent/signing-keys          device Bearer; public ES256 JWKs the agent pins
//   GET /api/v1/onboarding/setup/complete   customer session; WebView2 hand-off page
import { env } from "cloudflare:test";
import type { EnrollResponse } from "@cloudbox/contracts";
import { generateServerSigningKey } from "@cloudbox/licensing-contracts";
import { exportJWK, generateKeyPair } from "jose";
import { describe, expect, it } from "vitest";
import { createDb } from "../src/db/client";
import app from "../src/index";
import { createEnrollmentToken } from "../src/routes/v1/enrollment";
import { signInAs } from "./auth-fixtures";
import { insertTenant } from "./wt3-fixtures";

async function enrolledDevice(ip: string): Promise<EnrollResponse> {
  const { tenantId } = await insertTenant(env);
  const { token } = await createEnrollmentToken(createDb(env.DB), {
    tenantId,
    label: "setup-test",
    expiresInHours: 1,
    createdBy: "user_test",
  });
  const { publicKey } = await generateKeyPair("RS256", { extractable: true });
  const jwk = await exportJWK(publicKey);
  const res = await app.request(
    "/api/v1/agent/enroll",
    {
      method: "POST",
      headers: { "cf-connecting-ip": ip, "content-type": "application/json" },
      body: JSON.stringify({
        token,
        device: {
          hostname: "lab-pc",
          windowsBuild: "10.0.26100",
          agentVersion: "0.1.0",
          keyProtection: "tpm",
          publicKeyJwk: { kty: "RSA", n: jwk.n, e: jwk.e },
        },
      }),
    },
    env,
  );
  expect(res.status).toBe(201);
  return (await res.json()) as EnrollResponse;
}

describe("GET /api/v1/agent/signing-keys", () => {
  it("401s without a device token", async () => {
    expect((await app.request("/api/v1/agent/signing-keys", {}, env)).status).toBe(401);
    const wrong = await app.request(
      "/api/v1/agent/signing-keys",
      { headers: { authorization: "Bearer not-a-token" } },
      env,
    );
    expect(wrong.status).toBe(401);
  });

  it("records the configured key and returns public ES256 JWKs only", async () => {
    const server = await generateServerSigningKey();
    const withKey = { ...env, ENTITLEMENT_SIGNING_JWK: JSON.stringify(server.privateJwk) };
    const device = await enrolledDevice("setup-keys-1");
    const res = await app.request(
      "/api/v1/agent/signing-keys",
      { headers: { authorization: `Bearer ${device.deviceToken}` } },
      withKey,
    );
    expect(res.status).toBe(200);
    expect(res.headers.get("cache-control")).toBe("no-store");
    const body = (await res.json()) as {
      keys: { kid: string; status: string; jwk: Record<string, string> }[];
    };
    const mine = body.keys.find((k) => k.kid === server.kid);
    expect(mine?.status).toBe("active");
    expect(mine?.jwk).toEqual({
      kty: "EC",
      crv: "P-256",
      x: server.publicJwk.x,
      y: server.publicJwk.y,
      kid: server.kid,
      alg: "ES256",
      use: "sig",
    });
    for (const k of body.keys) expect(k.jwk).not.toHaveProperty("d");
  });

  it("serves what is recorded when no signing secret is configured", async () => {
    const device = await enrolledDevice("setup-keys-2");
    const res = await app.request(
      "/api/v1/agent/signing-keys",
      { headers: { authorization: `Bearer ${device.deviceToken}` } },
      { ...env, ENTITLEMENT_SIGNING_JWK: undefined },
    );
    expect(res.status).toBe(200);
    expect(Array.isArray(((await res.json()) as { keys: unknown[] }).keys)).toBe(true);
  });
});

describe("GET /api/v1/onboarding/setup/complete", () => {
  it("401s without a customer session", async () => {
    expect((await app.request("/api/v1/onboarding/setup/complete", {}, env)).status).toBe(401);
  });

  it("401s a staff session (customer surface only)", async () => {
    const staff = await signInAs(env, {
      email: "setup-complete.staff@example.test",
      staffRole: "super_admin",
    });
    const res = await app.request(
      "/api/v1/onboarding/setup/complete",
      { headers: staff.headers },
      env,
    );
    expect(res.status).toBe(401);
  });

  it("posts the signed-in message to the WebView2 host under a nonce CSP, never the session", async () => {
    const customer = await signInAs(env, { email: "setup-complete@example.test" });
    const res = await app.request(
      "/api/v1/onboarding/setup/complete",
      { headers: customer.headers },
      env,
    );
    expect(res.status).toBe(200);
    expect(res.headers.get("cache-control")).toBe("no-store");
    const csp = res.headers.get("content-security-policy") ?? "";
    const nonce = /script-src 'nonce-([0-9a-f]+)'/.exec(csp)?.[1];
    expect(nonce).toBeTruthy();
    const html = await res.text();
    expect(html).toContain(`<script nonce="${nonce}">`);
    expect(html).toContain('"type":"cloudbox.setup.signed-in"');
    expect(html).toContain('"email":"setup-complete@example.test"');
    const sessionValue = /cbx_session=([^;]+)/.exec(customer.cookie)?.[1] ?? "";
    expect(sessionValue.length).toBeGreaterThan(0);
    expect(html).not.toContain(sessionValue);
  });
});
