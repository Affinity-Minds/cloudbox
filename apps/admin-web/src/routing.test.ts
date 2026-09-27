// Owner: WT-15. Two structural guarantees for the two front doors (agent-notes ux-patterns "Two
// audiences, two front doors"): the customer portal is never part of the ops console's routeTree
// (so it can never render inside the sidebar shell), and the ops console's Staff screen refuses a
// caller without `staff.manage` before it ever renders.
import { QueryClient } from "@tanstack/react-query";
import { createRouter } from "@tanstack/react-router";
import { describe, expect, it } from "vitest";
import { createCustomerRouter } from "./portal/router";
import { routeTree } from "./routeTree.gen";

function buildOpsRouter() {
  return createRouter({ routeTree, context: { queryClient: new QueryClient() } });
}

describe("/portal/* never renders the ops console chrome", () => {
  it("is entirely absent from the ops console's own (file-based) routeTree", () => {
    const ops = buildOpsRouter();
    const opsPaths = Object.keys(ops.routesByPath);
    expect(opsPaths.some((p) => p === "/portal" || p.startsWith("/portal/"))).toBe(false);
    // Every ops console screen — including the new Staff one — nests under the sidebar shell.
    expect(ops.routesById["/_app/staff"]).toBeDefined();
  });

  it("the customer router's own tree has no route under the ops shell (`/_app`)", () => {
    const customer = createCustomerRouter(new QueryClient());
    const customerIds = Object.keys(customer.routesById);
    expect(customerIds.some((id) => id === "/_app" || id.startsWith("/_app/"))).toBe(false);
    // The five portal screens the brief asks for, all outside any console layout route.
    expect(Object.keys(customer.routesByPath)).toEqual(
      expect.arrayContaining([
        "/portal",
        "/portal/cloudboxes",
        "/portal/members",
        "/portal/subscription",
        "/portal/activate",
      ]),
    );
  });
});

describe("/ops/staff requires staff.manage", () => {
  function sessionWith(permissions: string[]) {
    return {
      user: { id: "u_test", email: "t@example.test", name: "T", staffRole: "admin" as const },
      permissions,
      activeTenantId: null,
    };
  }

  it("beforeLoad redirects away without the permission, and lets a holder through", async () => {
    const ops = buildOpsRouter();
    const staffRoute = ops.routesById["/_app/staff"];
    const beforeLoad = staffRoute?.options.beforeLoad as
      | ((opts: { context: { session: ReturnType<typeof sessionWith> } }) => unknown)
      | undefined;
    expect(typeof beforeLoad).toBe("function");

    let threw: unknown;
    try {
      // biome-ignore lint/style/noNonNullAssertion: asserted defined above.
      beforeLoad!({ context: { session: sessionWith(["tenant.view"]) } });
    } catch (error) {
      threw = error;
    }
    expect(threw).toBeDefined();

    let didNotThrow = true;
    try {
      // biome-ignore lint/style/noNonNullAssertion: asserted defined above.
      beforeLoad!({ context: { session: sessionWith(["tenant.view", "staff.manage"]) } });
    } catch {
      didNotThrow = false;
    }
    expect(didNotThrow).toBe(true);
  });
});
