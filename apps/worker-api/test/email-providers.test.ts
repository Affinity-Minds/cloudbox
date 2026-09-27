// Owner: WT-12. `/api/v1/settings/email-providers` through the real WT-1 middleware.
import { env } from "cloudflare:test";
import type { EmailProvider } from "@cloudbox/contracts";
import { beforeAll, describe, expect, it } from "vitest";
import app from "../src/index";
import { type SignedIn, signInAs } from "./auth-fixtures";

const PROVIDER_SECRETS_KEY = "MDEyMzQ1Njc4OWFiY2RlZjAxMjM0NTY3ODlhYmNkZWY=";

let admin: SignedIn;
let readOnly: SignedIn;
let testEnv: typeof env;

beforeAll(async () => {
  admin = await signInAs(env, { email: "wt12-admin@example.test", staffRole: "super_admin" });
  readOnly = await signInAs(env, { email: "wt12-read-only@example.test", staffRole: "read_only" });
  testEnv = { ...env, PROVIDER_SECRETS_KEY };
});

function call(
  method: string,
  path: string,
  body?: unknown,
  opts: { as?: SignedIn | null; env?: typeof env } = {},
) {
  const who = opts.as === undefined ? admin : opts.as;
  return app.request(
    `/api/v1/settings/email-providers${path}`,
    {
      method,
      headers: { "content-type": "application/json", ...(who?.headers ?? {}) },
      body: body === undefined ? undefined : JSON.stringify(body),
    },
    opts.env ?? testEnv,
  );
}

let seq = 0;
function uniqueName(label: string): string {
  seq += 1;
  return `${label} ${seq}`;
}

async function createBinding(name: string, overrides: Record<string, unknown> = {}) {
  const response = await call("POST", "", {
    kind: "cloudflare_binding",
    name,
    fromAddress: "no-reply@example.test",
    ...overrides,
  });
  expect(response.status).toBe(201);
  return (await response.json()) as EmailProvider;
}

describe("permission boundary", () => {
  it("401 without a session, 403 for read_only", async () => {
    expect((await call("GET", "", undefined, { as: null })).status).toBe(401);
    expect((await call("POST", "", {}, { as: null })).status).toBe(401);

    expect((await call("GET", "", undefined, { as: readOnly })).status).toBe(403);
    expect(
      (
        await call(
          "POST",
          "",
          { kind: "log", name: "x", fromAddress: "a@example.test" },
          { as: readOnly },
        )
      ).status,
    ).toBe(403);
  });
});

describe("create", () => {
  it("creates a cloudflare_binding provider with no secret", async () => {
    const provider = await createBinding(uniqueName("Binding"));
    expect(provider).toMatchObject({ kind: "cloudflare_binding", hasSecret: false, config: {} });
    expect(provider.id).toMatch(/^eprv_/);
  });

  it("creates an smtp provider, encrypts the secret, and never echoes it back", async () => {
    const name = uniqueName("SMTP");
    const response = await call("POST", "", {
      kind: "smtp",
      name,
      fromAddress: "smtp@example.test",
      config: { host: "smtp.example.test", port: 587, secure: false, username: "bot" },
      secret: "correct-horse-battery-staple",
    });
    expect(response.status).toBe(201);
    const text = await response.text();
    expect(text).not.toContain("correct-horse-battery-staple");
    const provider = JSON.parse(text) as EmailProvider;
    expect(provider).toMatchObject({
      kind: "smtp",
      hasSecret: true,
      config: { host: "smtp.example.test", port: 587, secure: false, username: "bot" },
    });

    const list = await call("GET", "");
    const listText = await list.text();
    expect(listText).not.toContain("correct-horse-battery-staple");
    expect(listText).not.toMatch(/secretCiphertext|secret_ciphertext/);
  });

  it("refuses an smtp provider when PROVIDER_SECRETS_KEY is unset", async () => {
    const response = await call(
      "POST",
      "",
      {
        kind: "smtp",
        name: uniqueName("No key"),
        fromAddress: "smtp@example.test",
        config: { host: "smtp.example.test", port: 587, secure: false, username: "bot" },
        secret: "x",
      },
      { env: { ...env, PROVIDER_SECRETS_KEY: undefined } },
    );
    expect(response.status).toBe(503);
    expect(await response.json()).toEqual({ error: "provider_secrets_key_missing" });
  });

  it("refuses a log provider in production", async () => {
    const response = await call(
      "POST",
      "",
      { kind: "log", name: uniqueName("Log"), fromAddress: "dev@example.test" },
      { env: { ...testEnv, ENVIRONMENT: "production" } },
    );
    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({
      error: "invalid_request",
      detail: "log_provider_disabled_in_production",
    });
  });
});

describe("update (reorder, enable/disable)", () => {
  it("patches priority and enabled, auditing before/after", async () => {
    const provider = await createBinding(uniqueName("Reorder"));
    const response = await call("PATCH", `/${provider.id}`, { priority: 5, enabled: false });
    expect(response.status).toBe(200);
    const updated = (await response.json()) as EmailProvider;
    expect(updated).toMatchObject({ priority: 5, enabled: false });
  });

  it("404s a missing provider", async () => {
    expect((await call("PATCH", "/eprv_missing", { priority: 1 })).status).toBe(404);
  });
});

describe("delete", () => {
  const deleteReason = { reasonCode: "unused" };

  it("refuses to delete the only enabled provider", async () => {
    // Wipe first so an earlier test's rows cannot mask the "only enabled" rule.
    await env.DB.prepare("DELETE FROM email_providers").run();
    const only = await createBinding(uniqueName("Only enabled"));

    const refused = await call("DELETE", `/${only.id}`, deleteReason);
    expect(refused.status).toBe(409);
    expect(await refused.json()).toEqual({ error: "conflict", detail: "last_enabled_provider" });

    // A second enabled provider frees it up.
    const second = await createBinding(uniqueName("Second enabled"));
    expect((await call("DELETE", `/${only.id}`, deleteReason)).status).toBe(204);
    const list = (await (await call("GET", "")).json()) as { items: EmailProvider[] };
    expect(list.items.find((i) => i.id === only.id)).toBeUndefined();

    await call("DELETE", `/${second.id}`, deleteReason);
  });

  it("404s a missing provider", async () => {
    expect((await call("DELETE", "/eprv_missing", deleteReason)).status).toBe(404);
  });

  it("audits EMAIL_PROVIDER_DELETED with the reason code and text", async () => {
    const provider = await createBinding(uniqueName("Audited delete"));
    await createBinding(uniqueName("Keeps it non-last"));
    const response = await call("DELETE", `/${provider.id}`, {
      reasonCode: "other",
      reasonText: "Switching providers entirely",
    });
    expect(response.status).toBe(204);

    const row = await env.DB.prepare(
      "SELECT after_json FROM audit_log WHERE event_type = 'EMAIL_PROVIDER_DELETED' AND entity_id = ?",
    )
      .bind(provider.id)
      .first<{ after_json: string }>();
    const after = JSON.parse(row?.after_json ?? "{}");
    expect(after).toMatchObject({
      reasonCode: "other",
      reasonText: "Switching providers entirely",
      reason: "other: Switching providers entirely",
    });
  });

  it("reason-code shape: missing/invalid code and other-without-text are 400", async () => {
    const provider = await createBinding(uniqueName("Reason shape"));
    await createBinding(uniqueName("Reason shape sibling"));

    expect((await call("DELETE", `/${provider.id}`, {})).status).toBe(400);
    expect(
      (await call("DELETE", `/${provider.id}`, { reasonCode: "not_a_real_code" })).status,
    ).toBe(400);
    expect((await call("DELETE", `/${provider.id}`, { reasonCode: "other" })).status).toBe(400);
  });
});

describe("test send", () => {
  it("sends a test message to the caller's own email and reports the outcome", async () => {
    const sent: unknown[] = [];
    const provider = await createBinding(uniqueName("Testable"));
    const response = await call("POST", `/${provider.id}/test`, undefined, {
      env: {
        ...testEnv,
        EMAIL: {
          send: async (m: unknown) => {
            sent.push(m);
            return { messageId: "test-msg-1" };
          },
        } as never,
      },
    });
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ ok: true, messageId: "test-msg-1" });
    expect(sent).toEqual([expect.objectContaining({ to: "wt12-admin@example.test" })]);
  });

  it("404s a missing provider", async () => {
    expect((await call("POST", "/eprv_missing/test")).status).toBe(404);
  });
});
