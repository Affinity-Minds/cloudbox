/**
 * Wraps a D1 binding and counts round trips: every executed statement (`first`, `all`, `run`,
 * `raw`) and every `batch()` / `exec()` counts once (fast-data-hydration "query-count ceiling").
 */
export type CountingD1 = D1Database & { readonly roundTrips: number };

const EXECUTORS = new Set(["first", "all", "run", "raw"]);

export function countingD1(db: D1Database): CountingD1 {
  let roundTrips = 0;
  const originals = new WeakMap<object, D1PreparedStatement>();

  const wrapStatement = (statement: D1PreparedStatement): D1PreparedStatement => {
    const proxy = new Proxy(statement, {
      get(target, property) {
        const value = Reflect.get(target, property, target);
        if (typeof value !== "function") return value;
        if (property === "bind") {
          return (...args: unknown[]) => wrapStatement(value.apply(target, args));
        }
        if (typeof property === "string" && EXECUTORS.has(property)) {
          return (...args: unknown[]) => {
            roundTrips += 1;
            return value.apply(target, args);
          };
        }
        return value.bind(target);
      },
    });
    originals.set(proxy, statement);
    return proxy;
  };

  return new Proxy(db, {
    get(target, property) {
      if (property === "roundTrips") return roundTrips;
      if (property === "prepare") {
        return (query: string) => wrapStatement(target.prepare(query));
      }
      if (property === "batch") {
        return (statements: D1PreparedStatement[]) => {
          roundTrips += 1;
          return target.batch(statements.map((s) => originals.get(s) ?? s));
        };
      }
      if (property === "exec") {
        return (query: string) => {
          roundTrips += 1;
          return target.exec(query);
        };
      }
      const value = Reflect.get(target, property, target);
      return typeof value === "function" ? value.bind(target) : value;
    },
  }) as CountingD1;
}
