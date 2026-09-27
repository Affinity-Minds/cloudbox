// WT-14 (ADR 0011): server licence keys — staff batches, redemption at onboarding.
import { env } from "cloudflare:test";
import type {
  CreateOwnTenantResponse,
  GenerateLicenseKeysResponse,
  LicenseKeysResponse,
} from "@cloudbox/contracts";
import { describe, expect, it } from "vitest";
import { sha256Hex } from "../src/crypto";
import app from "../src/index";
import { LICENSE_KEY_PATTERN } from "../src/onboarding/license-keys";
import { signInAs, TEST_ORIGIN } from "./fixtures";

let ipSeq = 0;
const nextIp = () => `198.18.0.${++ipSeq}`;

function post(path: string, body: unknown, headers: Record<string, string> = {}, ip = nextIp()) {
  return app.request(
    path,
    {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "cf-connecting-ip": ip,
        origin: TEST_ORIGIN,
        ...headers,
      },
      body: JSON.stringify(body),
    },
    env,
  );
}
const get = (path: string, headers: Record<string, string> = {}) =>
  app.request(path, { headers }, env);

const staff = (role: "super_admin" | "admin" | "support" | "read_only") =>
  signInAs(env, { email: `lk-${role}@example.test`, staffRole: role });

async function generate(quantity: number, extra: object = {}) {
  const { headers } = await staff("super_admin");
  const res = await post(
    "/api/v1/license-keys/batches",
    { planCode: "cloudbox-6", quantity, batchLabel: "Store A — Sept", ...extra },
    headers,
  );
  expect(res.status).toBe(201);
  return (await res.json()) as GenerateLicenseKeysResponse;
}

const redeem = (headers: Record<string, string>, code: string, ip?: string) =>
  post(
    "/api/v1/onboarding/redeem",
    { code, displayName: "Bought at Store A", timezone: "Asia/Kolkata" },
    headers,
    ip,
  );

describe("licence key batches (staff)", () => {
  it("returns N unique keys once and stores only their hashes", async () => {
    const batch = await generate(25);
    expect(batch.count).toBe(25);
    const codes = batch.keys.map((k) => k.code);
    expect(new Set(codes).size).toBe(25);
    for (const key of batch.keys) {
      expect(key.code).toMatch(LICENSE_KEY_PATTERN);
      expect(key.last4).toBe(key.code.slice(-4));
    }
    const { results } = await env.DB.prepare("SELECT * FROM license_keys WHERE batch_id = ?1")
      .bind(batch.batchId)
      .all<Record<string, unknown>>();
    expect(results).toHaveLength(25);
    const stored = JSON.stringify(results);
    for (const key of batch.keys) {
      expect(stored).not.toContain(key.code);
      expect(results.find((r) => r.id === key.id)?.code_hash).toBe(await sha256Hex(key.code));
    }
    expect(results.every((r) => r.status === "unredeemed")).toBe(true);

    const auditRows = await env.DB.prepare(
      "SELECT after_json FROM audit_log WHERE event_type = 'LICENSE_KEYS_GENERATED' AND entity_id = ?1",
    )
      .bind(batch.batchId)
      .all<{ after_json: string }>();
    expect(auditRows.results).toHaveLength(1);
    expect(JSON.parse(auditRows.results[0]?.after_json ?? "{}")).toMatchObject({
      count: 25,
      planCode: "cloudbox-6",
      batchLabel: "Store A — Sept",
    });
    const allAudit = JSON.stringify(
      (await env.DB.prepare("SELECT * FROM audit_log").all()).results,
    );
    for (const code of codes) expect(allAudit).not.toContain(code);
  });

  it("generates up to 500 in one call", async () => {
    const batch = await generate(500);
    expect(batch.keys).toHaveLength(500);
    const n = await env.DB.prepare("SELECT count(*) AS n FROM license_keys WHERE batch_id = ?1")
      .bind(batch.batchId)
      .first<{ n: number }>();
    expect(n?.n).toBe(500);
    const { headers } = await staff("super_admin");
    expect(
      (
        await post(
          "/api/v1/license-keys/batches",
          { planCode: "cloudbox-6", quantity: 501, batchLabel: "too many" },
          headers,
        )
      ).status,
    ).toBe(400);
  });

  it("offers the same keys as CSV with Accept: text/csv", async () => {
    const { headers } = await staff("super_admin");
    const res = await post(
      "/api/v1/license-keys/batches",
      { planCode: "cloudbox-6", quantity: 3, batchLabel: 'csv, "quoted"' },
      { ...headers, accept: "text/csv" },
    );
    expect(res.status).toBe(201);
    expect(res.headers.get("content-type")).toContain("text/csv");
    const lines = (await res.text()).trim().split("\n");
    expect(lines[0]).toBe("key,last4,plan,batch,expires_at");
    expect(lines).toHaveLength(4);
    expect(lines[1]).toMatch(/^CBX-LIC-[0-9A-Z-]+,[0-9A-Z]{4},cloudbox-6,"csv, ""quoted""",$/);
  });

  it("lists keys without the code or hash, filterable by batch, status and last four", async () => {
    const batch = await generate(2);
    const { headers } = await staff("support");
    const res = await get(`/api/v1/license-keys?batch=${batch.batchId}`, headers);
    expect(res.status).toBe(200);
    const text = await res.text();
    for (const key of batch.keys) expect(text).not.toContain(key.code);
    expect(text).not.toContain("codeHash");
    expect(text).not.toContain("code_hash");
    const body = JSON.parse(text) as LicenseKeysResponse;
    expect(body.items.map((i) => i.id).sort()).toEqual(batch.keys.map((k) => k.id).sort());
    expect(body.batches.find((b) => b.batchId === batch.batchId)).toMatchObject({
      total: 2,
      unredeemed: 2,
    });
    const byLast4 = (await (
      await get(`/api/v1/license-keys?last4=${batch.keys[0]?.last4}`, headers)
    ).json()) as LicenseKeysResponse;
    expect(byLast4.items.map((i) => i.id)).toContain(batch.keys[0]?.id);
  });

  it("permission boundaries: read_only and customers cannot generate or revoke", async () => {
    const body = { planCode: "cloudbox-6", quantity: 1, batchLabel: "x" };
    expect((await post("/api/v1/license-keys/batches", body)).status).toBe(401);
    const readOnly = await staff("read_only");
    expect((await post("/api/v1/license-keys/batches", body, readOnly.headers)).status).toBe(403);
    const customer = await signInAs(env, { email: "lk-customer@example.test" });
    expect((await post("/api/v1/license-keys/batches", body, customer.headers)).status).toBe(401);
    expect((await get("/api/v1/license-keys", customer.headers)).status).toBe(401);

    const batch = await generate(1);
    const id = batch.keys[0]?.id;
    const admin = await staff("admin"); // admin lacks license.revoke (seed)
    expect(
      (await post(`/api/v1/license-keys/${id}/revoke`, { reason: "lost card" }, admin.headers))
        .status,
    ).toBe(403);
    const superAdmin = await staff("super_admin");
    expect(
      (await post(`/api/v1/license-keys/${id}/revoke`, { reason: "x" }, superAdmin.headers)).status,
    ).toBe(400);
    expect(
      (await post(`/api/v1/license-keys/${id}/revoke`, { reason: "lost card" }, superAdmin.headers))
        .status,
    ).toBe(204);
    const again = await post(
      `/api/v1/license-keys/${id}/revoke`,
      { reason: "lost card" },
      superAdmin.headers,
    );
    expect(again.status).toBe(409);
  });
});

describe("licence key redemption at onboarding", () => {
  it("creates the tenant, the caller as owner and a pending subscription, and marks the key", async () => {
    const batch = await generate(1);
    const key = batch.keys[0];
    if (!key) throw new Error("no key");
    const buyer = await signInAs(env, { email: "lk-buyer@example.test" });
    // Case, spacing and dashes as typed from a card do not matter (review P2-8).
    const typed = ` ${key.code.toLowerCase().replaceAll("-", " ").replace("cbx lic", "cbxlic")} `;
    const res = await redeem(buyer.headers, typed);
    expect(res.status).toBe(201);
    const { tenantId, tenantCode } = (await res.json()) as CreateOwnTenantResponse;
    expect(tenantCode).toMatch(/^CBX-\d{5}$/);

    expect(
      await env.DB.prepare("SELECT status, primary_contact_email FROM tenants WHERE id = ?1")
        .bind(tenantId)
        .first(),
    ).toEqual({ status: "provisioning", primary_contact_email: "lk-buyer@example.test" });
    expect(
      await env.DB.prepare(
        "SELECT user_id, standing, status FROM tenant_memberships WHERE tenant_id = ?1",
      )
        .bind(tenantId)
        .first(),
    ).toEqual({ user_id: buyer.userId, standing: "owner", status: "active" });
    const sub = await env.DB.prepare(
      "SELECT id, plan_code, status, valid_from, valid_until FROM subscriptions WHERE tenant_id = ?1",
    )
      .bind(tenantId)
      .first<{ id: string }>();
    expect(sub).toMatchObject({
      plan_code: "cloudbox-6",
      status: "pending",
      valid_from: null,
      valid_until: null,
    });
    expect(
      await env.DB.prepare(
        "SELECT status, redeemed_tenant_id, redeemed_by_email FROM license_keys WHERE id = ?1",
      )
        .bind(key.id)
        .first(),
    ).toEqual({
      status: "redeemed",
      redeemed_tenant_id: tenantId,
      redeemed_by_email: "lk-buyer@example.test",
    });

    const events = await env.DB.prepare(
      "SELECT event_type, source, actor_id FROM audit_log WHERE correlation_id = (SELECT correlation_id FROM audit_log WHERE event_type = 'LICENSE_KEY_REDEEMED' AND entity_id = ?1) ORDER BY event_type",
    )
      .bind(key.id)
      .all<{ event_type: string; source: string; actor_id: string }>();
    expect(events.results).toEqual([
      { event_type: "LICENSE_KEY_REDEEMED", source: "license_redemption", actor_id: buyer.userId },
      { event_type: "SUBSCRIPTION_CHANGED", source: "license_key", actor_id: buyer.userId },
      { event_type: "TENANT_CREATED", source: "license_redemption", actor_id: buyer.userId },
      { event_type: "USER_INVITED", source: "license_redemption", actor_id: buyer.userId },
    ]);
    expect(sub?.id).toBeTruthy();
  });

  it("a used, expired, revoked or made-up key all fail identically", async () => {
    const batch = await generate(3, {
      expiresAt: new Date(Date.now() + 60_000).toISOString(),
    });
    const [used, expired, revoked] = batch.keys;
    if (!used || !expired || !revoked) throw new Error("keys");
    const buyer = await signInAs(env, { email: "lk-identical@example.test" });
    expect((await redeem(buyer.headers, used.code)).status).toBe(201);
    await env.DB.prepare("UPDATE license_keys SET expires_at = ?1 WHERE id = ?2")
      .bind(new Date(Date.now() - 1000).toISOString(), expired.id)
      .run();
    const { headers } = await staff("super_admin");
    await post(`/api/v1/license-keys/${revoked.id}/revoke`, { reason: "store returned" }, headers);

    const answers = [];
    for (const code of [
      used.code,
      expired.code,
      revoked.code,
      "CBX-LIC-00000-00000-00000-00000",
      "nonsense",
    ]) {
      const res = await redeem(buyer.headers, code);
      answers.push({ status: res.status, body: await res.text() });
    }
    expect(new Set(answers.map((a) => JSON.stringify(a))).size).toBe(1);
    expect(answers[0]).toEqual({
      status: 400,
      body: JSON.stringify({ error: "invalid_license_key" }),
    });
    // Nothing was created by the refusals.
    expect(
      (
        await env.DB.prepare("SELECT count(*) AS n FROM tenant_memberships WHERE user_id = ?1")
          .bind(buyer.userId)
          .first<{ n: number }>()
      )?.n,
    ).toBe(1);
  });

  it("needs a customer session and is rate-limited per session and per client", async () => {
    expect((await redeem({}, "CBX-LIC-00000-00000-00000-00000")).status).toBe(401);
    const staffSession = await staff("super_admin");
    expect((await redeem(staffSession.headers, "CBX-LIC-00000-00000-00000-00000")).status).toBe(
      401,
    );

    const buyer = await signInAs(env, { email: "lk-limit@example.test" });
    const statuses: number[] = [];
    for (let i = 0; i < 11; i += 1) {
      statuses.push((await redeem(buyer.headers, "CBX-LIC-00000-00000-00000-00000")).status);
    }
    expect(statuses.slice(0, 10).every((s) => s === 400)).toBe(true);
    expect(statuses[10]).toBe(429);

    const ip = nextIp();
    const perClient: number[] = [];
    for (let i = 0; i < 21; i += 1) {
      const other = await signInAs(env, { email: `lk-client-${i}@example.test` });
      perClient.push((await redeem(other.headers, "CBX-LIC-00000-00000-00000-00000", ip)).status);
    }
    expect(perClient.at(-1)).toBe(429);
  });
});
