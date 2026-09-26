// WT-8 third pass (docs/reviews/phase-1-security.md, "Third pass / verdict"). Asserts the SECURE
// behaviour; a failing test is an open finding.
import { env } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { ensureUserByEmail } from "../../src/auth/users";
import type { Bindings } from "../../src/env";
import app from "../../src/index";
import { TEST_ORIGIN } from "../auth-fixtures";

let n = 0;
const nextIp = () => {
  n += 1;
  return `100.100.${Math.floor(n / 250)}.${(n % 250) + 1}`;
};

function post(path: string, body: unknown, e: Bindings, ip = nextIp()) {
  return app.request(
    path,
    {
      method: "POST",
      headers: { "content-type": "application/json", "cf-connecting-ip": ip, origin: TEST_ORIGIN },
      body: JSON.stringify(body),
    },
    e,
  );
}

describe("T-2 (Medium): other clients can burn the owner's code before it is used", () => {
  it("three wrong guesses from three unrelated clients do not invalidate the owner's code", async () => {
    const email = "review-burn@example.test";
    await ensureUserByEmail(env, email);
    const sent: { to: string; text: string }[] = [];
    const e = {
      ...env,
      EMAIL: {
        send: async (m: { to: string; text: string }) => {
          sent.push(m);
          return { messageId: `m-${sent.length}` };
        },
      } as unknown as SendEmail,
    } satisfies Bindings;
    const ownerIp = nextIp();
    expect(
      (
        await post(
          "/api/auth/email-otp/send-verification-otp",
          { email, type: "sign-in" },
          e,
          ownerIp,
        )
      ).status,
    ).toBe(200);
    const code = sent.at(-1)?.text.match(/\b(\d{6})\b/)?.[1] ?? "";
    const wrong = code === "000000" ? "111111" : "000000";
    for (let i = 0; i < 3; i += 1) {
      await post("/api/auth/sign-in/email-otp", { email, otp: wrong }, e);
    }
    const owner = await post("/api/auth/sign-in/email-otp", { email, otp: code }, e, ownerIp);
    expect(owner.status).toBe(200);
  });
});
