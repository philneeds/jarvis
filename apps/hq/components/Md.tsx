import { Fragment, type ReactNode } from "react";

/** Tiny markdown: headings, bullets, bold, inline code, fenced code. No HTML, so nothing an agent says can inject markup. */
export function Md({ text }: { text: string }) {
  const out: ReactNode[] = [];
  const lines = text.split("\n");
  let i = 0, key = 0;
  const inline = (s: string): ReactNode[] => {
    const parts: ReactNode[] = [];
    const re = /(\*\*[^*]+\*\*|`[^`]+`)/g;
    let last = 0, m: RegExpExecArray | null;
    while ((m = re.exec(s))) {
      if (m.index > last) parts.push(s.slice(last, m.index));
      const t = m[0];
      parts.push(t.startsWith("`") ? <code key={key++}>{t.slice(1, -1)}</code> : <b key={key++}>{t.slice(2, -2)}</b>);
      last = m.index + t.length;
    }
    if (last < s.length) parts.push(s.slice(last));
    return parts;
  };
  while (i < lines.length) {
    const l = lines[i]!;
    if (l.startsWith("```")) {
      const buf: string[] = []; i++;
      while (i < lines.length && !lines[i]!.startsWith("```")) buf.push(lines[i++]!);
      i++; out.push(<pre key={key++}>{buf.join("\n")}</pre>); continue;
    }
    const h = l.match(/^#{1,6}\s+(.*)$/);
    if (h) { out.push(<h4 key={key++}>{inline(h[1]!)}</h4>); i++; continue; }
    if (/^\s*[-*•]\s+/.test(l)) {
      const items: ReactNode[] = [];
      while (i < lines.length && /^\s*[-*•]\s+/.test(lines[i]!)) items.push(<li key={key++}>{inline(lines[i++]!.replace(/^\s*[-*•]\s+/, ""))}</li>);
      out.push(<ul key={key++}>{items}</ul>); continue;
    }
    if (/^\s*\d+[.)]\s+/.test(l)) {
      const items: ReactNode[] = [];
      while (i < lines.length && /^\s*\d+[.)]\s+/.test(lines[i]!)) items.push(<li key={key++}>{inline(lines[i++]!.replace(/^\s*\d+[.)]\s+/, ""))}</li>);
      out.push(<ol key={key++} style={{ margin: "2px 0", paddingLeft: 18 }}>{items}</ol>); continue;
    }
    out.push(<Fragment key={key++}>{inline(l)}{i < lines.length - 1 ? "\n" : null}</Fragment>);
    i++;
  }
  return <span className="md">{out}</span>;
}
