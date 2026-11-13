"use client";

import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import type { JarvisEvent } from "@jarvis/core";
import { api, isPublicPath, post, wsUrl } from "./api";
import type { State, ChatMessage, Approval, ActivityEntry, AttentionItem } from "./types";

interface Live {
  state: State | null;
  connected: boolean;
  error?: string;
  messages: ChatMessage[];
  pending: Approval[];
  attention: AttentionItem[];
  activity: ActivityEntry[];
  /** Agents mid-reply: partial text by run. */
  streams: Record<string, { agentId: string; text: string; at: number }>;
  /** Bumps whenever a venture's numbers or board change. */
  ventureTick: number;
  /** Raw event feed for pages that react to specific events (the always-on device). Returns an unsubscribe. */
  onEvent: (fn: (e: JarvisEvent) => void) => () => void;
  /** Send to Jarvis; resolves with the ack (fast) and a promise of the final answer (slower). */
  send: (text: string, channel?: ChatMessage["channel"], images?: string[], docs?: string[]) => Promise<{ replyTo: string; ack: Promise<ChatMessage | null>; final: Promise<ChatMessage | null> }>;
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
  const [attention, setAttention] = useState<AttentionItem[]>([]);
  const [activity, setActivity] = useState<ActivityEntry[]>([]);
  const [streams, setStreams] = useState<Record<string, { agentId: string; text: string; at: number }>>({});
  const [ventureTick, setVentureTick] = useState(0);
  const listeners = useRef(new Set<(e: JarvisEvent) => void>());
  const waiters = useRef<{ replyTo: string; kinds: string[]; resolve: (m: ChatMessage | null) => void }[]>([]);
  const messagesRef = useRef<ChatMessage[]>([]);
  useEffect(() => { messagesRef.current = messages; }, [messages]);
  const waitForReply = useCallback((replyTo: string, kinds: string[], timeoutMs: number) => new Promise<ChatMessage | null>((resolve) => {
    // A quick reply can land over the websocket before the HTTP response names what to wait for.
    const already = messagesRef.current.find((m) => m.replyTo === replyTo && m.kind && kinds.includes(m.kind));
    if (already) { resolve(already); return; }
    const w = { replyTo, kinds, resolve: (m: ChatMessage | null) => { clearTimeout(t); waiters.current = waiters.current.filter((x) => x !== w); resolve(m); } };
    const t = setTimeout(() => w.resolve(null), timeoutMs);
    waiters.current.push(w);
  }), []);
  const send = useCallback(async (text: string, channel?: ChatMessage["channel"], images?: string[], docs?: string[]) => {
    const r = await post<{ messages: ChatMessage[]; replyTo: string }>("/api/chat", { text, channel, ...(images?.length ? { images } : {}), ...(docs?.length ? { docs } : {}) });
    setMessagesState((m) => { const ids = new Set(m.map((x) => x.id)); return [...m, ...r.messages.filter((x) => !ids.has(x.id))]; });
    // The ack is any reply inside 40 s; the final answer may take a few minutes.
    return { replyTo: r.replyTo, ack: waitForReply(r.replyTo, ["ack", "final"], 40_000), final: waitForReply(r.replyTo, ["final"], 6 * 60_000) };
  }, [waitForReply]);
  const onEvent = useCallback((fn: (e: JarvisEvent) => void) => { listeners.current.add(fn); return () => { listeners.current.delete(fn); }; }, []);
  const wsRef = useRef<WebSocket | null>(null);
  const buildRef = useRef<string | undefined>(undefined);
  const [wsGen, setWsGen] = useState(0);

  const refresh = useCallback(async () => {
    try {
      const [s, chat, appr, act, att] = await Promise.all([
        api<State>("/api/state"),
        api<{ messages: ChatMessage[] }>("/api/chat?limit=200"),
        api<{ approvals: Approval[] }>("/api/approvals?status=pending"),
        // The last 100 entries worth reading; per-run lines would crowd them out (the Activity page fetches those itself).
        api<{ entries: ActivityEntry[] }>("/api/activity?limit=100&exclude=run"),
        api<{ items: AttentionItem[] }>("/api/attention"),
      ]);
      setState(s);
      setMessagesState(chat.messages);
      setPendingState(appr.approvals);
      setAttention(att.items);
      setActivity(act.entries);
      setError(undefined);
      if (wsRef.current?.readyState !== WebSocket.OPEN) setWsGen((g) => g + 1);
    } catch (e) {
      setError((e as Error).message);
    }
  }, []);

  // Nothing to fetch on the public pages (login, about, privacy); it would only 401.
  useEffect(() => { if (typeof window !== "undefined" && isPublicPath(location.pathname)) return; void refresh(); }, [refresh]);

  useEffect(() => {
    if (typeof window !== "undefined" && isPublicPath(location.pathname)) return;
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
        let e: JarvisEvent | { type: "hello"; build?: string; status: State["status"]; agents: State["agents"]; usage: State["usage"] };
        try { e = JSON.parse(ev.data); } catch { return; }
        if (e.type === "hello") {
          // A different build answered than the one this page was loaded from: a deploy happened. Reload so the
          // page's scripts match the server, rather than failing on the next navigation.
          if (e.build && buildRef.current && e.build !== buildRef.current) { location.reload(); return; }
          if (e.build) buildRef.current = e.build;
          setState((s) => (s ? { ...s, status: e.status, agents: e.agents, usage: e.usage } : s));
          return;
        }
        for (const fn of listeners.current) { try { fn(e); } catch { /* a listener's problem */ } }
        switch (e.type) {
          case "agent.status":
            setState((s) => s && { ...s, agents: s.agents.map((a) => (a.id === e.agentId ? { ...a, status: e.status, detail: e.detail, lastRunAt: e.status === "idle" ? e.at : a.lastRunAt } : a)) });
            break;
          case "chat.message":
            setMessagesState((m) => { const next = m.some((x) => x.id === e.message.id) ? m : [...m, e.message].slice(-500); messagesRef.current = next; return next; });
            for (const w of [...waiters.current]) if (e.message.replyTo === w.replyTo && e.message.kind && w.kinds.includes(e.message.kind)) w.resolve(e.message);
            setStreams((st) => { const n = { ...st }; for (const [k, v] of Object.entries(n)) if (v.agentId === (e.message.agentId ?? (e.message.role === "jarvis" ? "jarvis" : v.agentId))) delete n[k]; return n; });
            break;
          case "chat.stream":
            setStreams((st) => ({ ...st, [e.runId]: { agentId: e.agentId, text: (st[e.runId]?.text ?? "") + e.delta, at: Date.now() } }));
            break;
          case "approval.new":
            setPendingState((p) => [e.approval, ...p.filter((x) => x.id !== e.approval.id)]);
            setState((s) => s && { ...s, pendingApprovals: s.pendingApprovals + 1 });
            break;
          case "approval.updated":
            setPendingState((p) => p.map((x) => (x.id === e.approval.id ? e.approval : x)));
            break;
          case "approval.decided":
            setPendingState((p) => p.filter((x) => x.id !== e.approval.id));
            setState((s) => s && { ...s, pendingApprovals: Math.max(0, s.pendingApprovals - 1) });
            break;
          case "activity":
            // A run line also bumps that agent's runs-today count (the towers' height) until the next full refresh.
            if (e.entry.kind === "run") { const id = e.entry.agentId; setState((s) => s && { ...s, agents: s.agents.map((a) => (a.id === id ? { ...a, runsToday: (a.runsToday ?? 0) + 1 } : a)) }); }
            setActivity((a) => [e.entry, ...a].slice(0, 300));
            break;
          case "usage":
            setState((s) => s && { ...s, usage: e.usage });
            break;
          case "system":
            setState((s) => s && { ...s, status: e.status });
            break;
          case "venture":
            setVentureTick((n) => n + 1);
            break;
          case "attention":
            setAttention((list) => {
              if (e.item.status === "done") return list.filter((i) => i.id !== e.item.id);
              // An edit replaces the item where it is; anything else brings it to the top.
              return e.change === "edited" && list.some((i) => i.id === e.item.id) ? list.map((i) => (i.id === e.item.id ? e.item : i)) : [e.item, ...list.filter((i) => i.id !== e.item.id)];
            });
            break;
        }
      };
    };
    connect();
    const ping = setInterval(() => { if (ws?.readyState === WebSocket.OPEN) ws.send("ping"); }, 25000);
    return () => { stop = true; clearInterval(ping); if (timer) clearTimeout(timer); ws?.close(); };
  }, [wsGen]);

  const value = useMemo<Live>(() => ({
    state, connected, error, messages, pending, attention, activity, streams, ventureTick, onEvent, send, refresh,
    setMessages: (fn) => setMessagesState(fn),
    setPending: (fn) => setPendingState(fn),
  }), [state, connected, error, messages, pending, attention, activity, streams, ventureTick, onEvent, send, refresh]);

  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

export function useLive(): Live {
  const v = useContext(Ctx);
  if (!v) throw new Error("useLive outside LiveProvider");
  return v;
}
