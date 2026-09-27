// Owner: WT-16. Subscribes the Fleet list to `GET /api/v1/realtime/fleet` (the FleetPresence
// Durable Object's WebSocket feed, spec §5.3): a snapshot on connect, then deltas — no polling.
// Reconnects with exponential backoff, and pauses entirely while the tab is hidden (a backgrounded
// Fleet tab has no reason to hold a socket open or to reconnect while nobody can see it).

import type { PresenceMessage } from "@cloudbox/contracts";
import { useEffect, useReducer, useRef, useState } from "react";
import {
  applyPresenceMessage,
  initialPresenceState,
  type PresenceState,
} from "./fleet-presence-reducer";

export type FleetPresenceStatus = "connecting" | "open" | "closed";

const RECONNECT_BASE_MS = 1000;
const RECONNECT_MAX_MS = 30_000;

function socketUrl(path: string): string {
  const protocol = window.location.protocol === "https:" ? "wss:" : "ws:";
  return `${protocol}//${window.location.host}${path}`;
}

export function useFleetPresence(path = "/api/v1/realtime/fleet") {
  const [presence, dispatch] = useReducer(applyPresenceMessage, initialPresenceState);
  const [status, setStatus] = useState<FleetPresenceStatus>("connecting");
  const socketRef = useRef<WebSocket | null>(null);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const attemptRef = useRef(0);
  const stoppedRef = useRef(false);

  useEffect(() => {
    stoppedRef.current = false;

    const clearTimer = () => {
      if (timerRef.current !== null) {
        clearTimeout(timerRef.current);
        timerRef.current = null;
      }
    };

    const disconnect = () => {
      clearTimer();
      socketRef.current?.close();
      socketRef.current = null;
    };

    const scheduleReconnect = () => {
      socketRef.current = null;
      setStatus("closed");
      if (stoppedRef.current || document.hidden) return;
      const delay = Math.min(RECONNECT_BASE_MS * 2 ** attemptRef.current, RECONNECT_MAX_MS);
      attemptRef.current += 1;
      clearTimer();
      timerRef.current = setTimeout(connect, delay);
    };

    function connect() {
      if (stoppedRef.current || document.hidden) return;
      setStatus("connecting");
      const ws = new WebSocket(socketUrl(path));
      socketRef.current = ws;
      ws.addEventListener("open", () => {
        attemptRef.current = 0;
        setStatus("open");
      });
      ws.addEventListener("message", (event: MessageEvent) => {
        try {
          dispatch(JSON.parse(String(event.data)) as PresenceMessage);
        } catch {
          // A malformed frame is not worth tearing the connection down for; the next
          // snapshot/delta corrects the state either way.
        }
      });
      ws.addEventListener("close", scheduleReconnect);
      ws.addEventListener("error", () => ws.close());
    }

    const onVisibilityChange = () => {
      if (document.hidden) {
        disconnect();
      } else if (!socketRef.current) {
        attemptRef.current = 0;
        connect();
      }
    };

    document.addEventListener("visibilitychange", onVisibilityChange);
    connect();

    return () => {
      stoppedRef.current = true;
      document.removeEventListener("visibilitychange", onVisibilityChange);
      disconnect();
    };
  }, [path]);

  return { presence, status };
}

export type { PresenceState };
