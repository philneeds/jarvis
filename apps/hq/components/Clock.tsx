"use client";

import { useEffect, useState } from "react";

const WMO: Record<number, string> = { 0: "clear", 1: "mostly clear", 2: "partly cloudy", 3: "overcast", 45: "fog", 48: "fog", 51: "drizzle", 53: "drizzle", 55: "drizzle", 61: "rain", 63: "rain", 65: "heavy rain", 71: "snow", 73: "snow", 75: "heavy snow", 77: "snow", 80: "showers", 81: "showers", 82: "showers", 85: "snow showers", 86: "snow showers", 95: "thunderstorm", 96: "thunderstorm", 99: "thunderstorm" };

export function Clock({ since }: { since?: string }) {
  const [now, setNow] = useState<Date | null>(null);
  const [wx, setWx] = useState<{ t: number; c: string } | null>(null);
  useEffect(() => {
    setNow(new Date());
    const t = setInterval(() => setNow(new Date()), 1000);
    const lat = process.env.NEXT_PUBLIC_LAT ?? "43.16", lon = process.env.NEXT_PUBLIC_LON ?? "-77.61";
    const load = () => fetch(`https://api.open-meteo.com/v1/forecast?latitude=${lat}&longitude=${lon}&current=temperature_2m,weather_code&temperature_unit=fahrenheit`)
      .then((r) => r.json()).then((j) => setWx({ t: Math.round(j.current.temperature_2m), c: WMO[j.current.weather_code] ?? "" })).catch(() => undefined);
    load();
    const w = setInterval(load, 15 * 60_000);
    return () => { clearInterval(t); clearInterval(w); };
  }, []);
  const city = process.env.NEXT_PUBLIC_CITY ?? "Rochester, NY";
  const sinceText = since ? (() => { const s = (Date.now() - new Date(since).getTime()) / 1000; return s < 3600 ? `${Math.floor(s / 60)}M` : `${Math.floor(s / 3600)}H ${Math.floor((s % 3600) / 60)}M`; })() : null;
  return (
    <div className="flex flex-col items-end gap-1 text-right">
      <span className="display glow font-semibold leading-none tracking-[0.06em] text-[26px] md:text-[36px]" style={{ color: "var(--ink-bright)" }}>
        {now ? now.toLocaleTimeString("en-US", { hour12: false }) : "--:--:--"}
      </span>
      <span className="text-[12px] tracking-[0.18em] uppercase" style={{ color: "#CFE6FF" }}>{now ? now.toLocaleDateString("en-US", { weekday: "short", day: "2-digit", month: "short", year: "numeric" }) : ""}</span>
      <span className="text-[11px] tracking-[0.14em] uppercase" style={{ color: "var(--muted)" }}>{city}{wx ? ` · ${wx.t}° · ${wx.c}` : ""}</span>
      {sinceText && <span className="text-[11px] tracking-[0.14em] uppercase" style={{ color: "var(--muted)" }}>Since you left · {sinceText}</span>}
    </div>
  );
}
