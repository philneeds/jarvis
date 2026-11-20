/**
 * Text cut into pages that fit the glasses' display, on word boundaries. The sizes are an estimate from the display's
 * pixels (about 14 px a character and 36 px a line on the G2's 576 x 288), with the last line kept for the page count.
 * To tune on the real glasses: display.render can report how much text fitted (includeTextLayout).
 */
export interface Display { width: number; height: number }
export const G2: Display = { width: 576, height: 288 };

export function pageSize(d: Display = G2): { cols: number; rows: number } {
  return { cols: Math.max(16, Math.floor(d.width / 14)), rows: Math.max(2, Math.floor(d.height / 36) - 1) };
}

/** Wrap to lines no wider than cols (a longer word is split), keeping blank lines between paragraphs. */
export function wrap(text: string, cols: number): string[] {
  const out: string[] = [];
  for (const para of text.replace(/\r/g, "").split("\n")) {
    if (!para.trim()) { if (out.length && out[out.length - 1] !== "") out.push(""); continue; }
    let line = "";
    for (let word of para.trim().split(/\s+/)) {
      while (word.length > cols) { if (line) { out.push(line); line = ""; } out.push(word.slice(0, cols)); word = word.slice(cols); }
      if (!line) line = word;
      else if (line.length + 1 + word.length <= cols) line += ` ${word}`;
      else { out.push(line); line = word; }
    }
    if (line) out.push(line);
  }
  while (out.length && out[out.length - 1] === "") out.pop();
  return out;
}

export function paginate(text: string, d: Display = G2): string[] {
  const { cols, rows } = pageSize(d);
  const lines = wrap(text, cols);
  const pages: string[] = [];
  for (let i = 0; i < lines.length; i += rows) {
    const chunk = lines.slice(i, i + rows);
    while (chunk.length && chunk[0] === "") chunk.shift();
    if (chunk.length) pages.push(chunk.join("\n"));
  }
  return pages.length ? pages : [""];
}
