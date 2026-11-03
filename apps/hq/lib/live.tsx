"use client";

import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import type { JarvisEvent } from "@jarvis/core";
import { api, wsUrl } from "./api";
import type { State, ChatMessage, Approval, ActivityEntry } from "./types";

interface Live {
  state: State | null;
  connected: boolean;
  error?: string;
  messages: ChatMessage[];
  pending: Approval[];
  activity: ActivityEntry[];
  refresh: () => Promise<void>;
  setMessages: (fn: (m: ChatMessage[]) => ChatMessage[]) => void;
  setPending: (fn: (a: Approval[]) => Approval[]) => void;
}

const Ctx = createContext<Live | null>(null);

export function LiveProvider({ children }: { children: ReactNode }) {
  const [state, setState] = useState<State | null>(null);
  const [connected, setConnected] = useState(false);
  const [error, setError] = useState<string>();
  const [messages, setMessagesState] = useState<ChatMessage[]>([]);
  const [pending, setPendingState] = useState<Approval[]>([]);
  const [activity, setActivity] = useState<ActivityEntry[]>([]);
  const wsRef = useRef<WebSocket | null>(null);
  const [wsGen, setWsGen] = useState(0);

  const refresh = useCallback(async () => {
    try {
      const [s, chat, appr, act] = await Promise.all([
        api<State>("/api/state"),
        api<{ messages: ChatMessage[] }>("/api/chat?limit=200"),
        api<{ approvals: Approval[] }>("/api/approvals?status=pending"),
        api<{ entries: ActivityEntry[] }>("/api/activity?limit=100"),
      ]);
      setState(s);
      setMessagesState(chat.messages);
      setPendingState(appr.approvals);
      setActivity(act.entries);
      setError(undefined);
      if (wsRef.current?.readyState !== WebSocket.OPEN) setWsGen((g) => g + 1);
    } catch (e) {
      setError((e as Error).message);
    }
  }, []);

  useEffect(() => { void refresh(); }, [refresh]);

  useEffect(() => {
    let stop = false, retry = 1000, ws: WebSocket | null = null, timer: ReturnType<typeof setTimeout> | undefined;
    const connect = () => {
      if (stop) return;
      try { ws = new WebSocket(wsUrl()); } catch { timer = setTimeout(connect, retry); return; }
      wsRef.current = ws;
      ws.onopen = () => { setConnected(true); retry = 1000; };
      ws.onclose = () => { setConnected(false); if (!stop) { timer = setTimeout(connect, retry); retry = Math.min(retry * 2, 15000); } };
      ws.onerror = () => ws?.close();
      ws.onmessage = (ev) => {
        if (ev.data === "pong") return;
        let e: JarvisEvent | { type: "hello"; status: State["status"]; agents: State["agents"]; usage: State["usage"] };
        try { e = JSON.parse(ev.data); } catch { return; }
        if (e.type === "hello") { setState((s) => (s ? { ...s, status: e.status, agents: e.agents, usage: e.usage } : s)); return; }
        switch (e.type) {
          case "agent.status":
            setState((s) => s && { ...s, agents: s.agents.map((a) => (a.id === e.agentId ? { ...a, status: e.status, detail: e.detail, lastRunAt: e.status === "idle" ? e.at : a.lastRunAt } : a)) });
            break;
          case "chat.message":
            setMessagesState((m) => (m.some((x) => x.id === e.message.id) ? m : [...m, e.message].slice(-500)));
            break;
          case "approval.new":
            setPendingState((p) => [e.approval, ...p.filter((x) => x.id !== e.approval.id)]);
            setState((s) => s && { ...s, pendingApprovals: s.pendingApprovals + 1 });
            break;
          case "approval.decided":
            setPendingState((p) => p.filter((x) => x.id !== e.approval.id));
            setState((s) => s && { ...s, pendingApprovals: Math.max(0, s.pendingApprovals - 1) });
            break;
          case "activity":
            setActivity((a) => [e.entry, ...a].slice(0, 300));
            break;
          case "usage":
            setState((s) => s && { ...s, usage: e.usage });
            break;
          case "system":
            setState((s) => s && { ...s, status: e.status });
            break;
        }
      };
    };
    connect();
    const ping = setInterval(() => { if (ws?.readyState === WebSocket.OPEN) ws.send("ping"); }, 25000);
    return () => { stop = true; clearInterval(ping); if (timer) clearTimeout(timer); ws?.close(); };
  }, [wsGen]);

  const value = useMemo<Live>(() => ({
    state, connected, error, messages, pending, activity, refresh,
    setMessages: (fn) => setMessagesState(fn),
    setPending: (fn) => setPendingState(fn),
  }), [state, connected, error, messages, pending, activity, refresh]);

  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

export function useLive(): Live {
  const v = useContext(Ctx);
  if (!v) throw new Error("useLive outside LiveProvider");
  return v;
}
