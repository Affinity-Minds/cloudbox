// Owner: WT-9. Unit tests for the thin REST client (src/network/netbird.ts): request shape,
// retry-with-backoff on 5xx, no retry on 4xx, and that the token never appears in a thrown error.
import { describe, expect, it } from "vitest";
import { createNetbirdClient, NetbirdApiError, netbirdConfig } from "../../src/network/netbird";
import { createFakeNetbirdServer } from "./fake-netbird-server";

const config = { apiUrl: "https://fake.netbird.test", apiToken: "super-secret-token" };

describe("netbirdConfig", () => {
  it("is null when NETBIRD_API_URL is unset (deliverable #3: no-op by default)", () => {
    expect(netbirdConfig({})).toBeNull();
    expect(netbirdConfig({ NETBIRD_API_URL: "" })).toBeNull();
  });

  it("strips a trailing slash and defaults the token to empty", () => {
    expect(netbirdConfig({ NETBIRD_API_URL: "https://net.example.com/" })).toEqual({
      apiUrl: "https://net.example.com",
      apiToken: "",
    });
  });
});

describe("createNetbirdClient — request shape", () => {
  it("sends the token as `Authorization: Token <token>` and never in the URL or body", async () => {
    const server = createFakeNetbirdServer();
    let seenAuth: string | null = null;
    const capturing: typeof fetch = async (input, init) => {
      seenAuth = new Headers(init?.headers).get("authorization");
      return server.fetch(input, init);
    };
    const client = createNetbirdClient(config, capturing);

    await client.createGroup("cbx-server-CBX-00001");

    expect(seenAuth).toBe(`Token ${config.apiToken}`);
    const [request] = server.requests;
    if (!request) throw new Error("expected a recorded request");
    expect(request.path).toBe("/api/groups");
    expect(JSON.stringify(request.body)).not.toContain(config.apiToken);
  });

  it("createSetupKey sends type, expires_in and auto_groups exactly, with usage_limit 1 for one-off", async () => {
    const server = createFakeNetbirdServer();
    const client = createNetbirdClient(config, server.fetch);

    const key = await client.createSetupKey({
      name: "cbx-server-dev_1",
      type: "one-off",
      expiresIn: 86_400,
      autoGroups: ["grp_1"],
    });

    expect(server.requests.at(-1)?.body).toEqual({
      name: "cbx-server-dev_1",
      type: "one-off",
      expires_in: 86_400,
      auto_groups: ["grp_1"],
      usage_limit: 1,
    });
    expect(key.type).toBe("one-off");
    expect(key.auto_groups).toEqual(["grp_1"]);
    expect(key.key).toMatch(/FAKE-SETUP-KEY$/);
  });

  it("findGroupByName filters to an exact match and returns null when absent", async () => {
    const server = createFakeNetbirdServer();
    const client = createNetbirdClient(config, server.fetch);
    await client.createGroup("cbx-server-CBX-00001");
    await client.createGroup("cbx-server-CBX-00001-other"); // must not match as a substring

    const found = await client.findGroupByName("cbx-server-CBX-00001");
    expect(found?.name).toBe("cbx-server-CBX-00001");
    expect(await client.findGroupByName("cbx-server-does-not-exist")).toBeNull();
  });
});

describe("createNetbirdClient — retries and errors", () => {
  it("retries a 5xx with backoff and succeeds once the server recovers", async () => {
    const server = createFakeNetbirdServer();
    server.failNext(503, 2); // fails twice, third attempt (of 4 max) succeeds
    const client = createNetbirdClient(config, server.fetch);

    const group = await client.createGroup("cbx-client-CBX-00001");
    expect(group.name).toBe("cbx-client-CBX-00001");
    // 2 failed attempts + 1 success recorded as requests (the fake server logs every call).
    expect(server.requests).toHaveLength(3);
  });

  it("gives up after exhausting retries on a persistent 5xx", async () => {
    const server = createFakeNetbirdServer();
    server.failNext(500, 10); // more than MAX_ATTEMPTS
    const client = createNetbirdClient(config, server.fetch);

    await expect(client.createGroup("cbx-client-CBX-00002")).rejects.toBeInstanceOf(
      NetbirdApiError,
    );
  });

  it("does not retry a 4xx, and the error never contains the token", async () => {
    const notFound: typeof fetch = async () =>
      new Response(JSON.stringify({ message: "not found" }), { status: 404 });
    const client = createNetbirdClient(config, notFound);

    let callCount = 0;
    const counting: typeof fetch = async (...args) => {
      callCount += 1;
      return notFound(...args);
    };
    const countingClient = createNetbirdClient(config, counting);

    await expect(countingClient.deleteGroup("grp_missing")).rejects.toMatchObject({ status: 404 });
    expect(callCount).toBe(1); // no retry on a 4xx

    try {
      await client.deleteGroup("grp_missing");
      expect.unreachable();
    } catch (error) {
      expect(String(error)).not.toContain(config.apiToken);
    }
  });

  it("a network error (fetch throws) is retried, then surfaced as a NetbirdApiError", async () => {
    const alwaysThrows: typeof fetch = async () => {
      throw new TypeError("connection refused");
    };
    const client = createNetbirdClient(config, alwaysThrows);
    await expect(client.listGroups()).rejects.toBeInstanceOf(NetbirdApiError);
  });
});
