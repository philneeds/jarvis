/** Ventures: every agent belongs to one; a few also work for others. Colors match the HQ design. */
export type VentureId =
  | "root"
  | "command"
  | "personal"
  | "money"
  | "crypto"
  | "philneeds"
  | "acres"
  | "range"
  | "jdpm"
  | "proedge"
  | "lab";

export interface Venture {
  id: VentureId;
  label: string;
  /** Short label used on towers and chips. */
  short: string;
  color: string;
  lead?: string;
  desc?: string;
}

export const VENTURES: Record<VentureId, Venture> = {
  root: { id: "root", label: "Jarvis", short: "JARVIS", color: "#8FA8FF", lead: "jarvis" },
  command: { id: "command", label: "Command center", short: "COMMAND", color: "#8FA8FF", lead: "jarvis" },
  personal: { id: "personal", label: "Personal & health", short: "PERSONAL", color: "#5BE3A0", lead: "lip" },
  money: { id: "money", label: "Money & stocks", short: "MONEY", color: "#F2C14E", lead: "munger" },
  crypto: { id: "crypto", label: "On-chain trading", short: "ON-CHAIN", color: "#B98CFF", lead: "mantis" },
  philneeds: { id: "philneeds", label: "Philneeds brand", short: "PHILNEEDS", color: "#5CC8F5", lead: "nick" },
  acres: { id: "acres", label: "Airdrop Acres", short: "ACRES", color: "#D9A066", lead: "jeff" },
  range: { id: "range", label: "Range.cool", short: "RANGE.COOL", color: "#49E0D6", lead: "poseidon" },
  jdpm: { id: "jdpm", label: "JD PM Renovations", short: "JD PM", color: "#FF5A6A", lead: "stella" },
  proedge: { id: "proedge", label: "ProEdge", short: "PROEDGE", color: "#FF9A3C", lead: "stevon" },
  lab: {
    id: "lab",
    label: "Memecoin Analyzer (name TBD)",
    short: "ANALYZER",
    color: "#FF6EC7",
    desc:
      "New venture, spearheaded by Ansem with Jason and Jason 2.0. They review Discord and chat data, then create, test and backtest AI trading scripts. Findings go to Mantis; if Mantis approves, Mayne executes.",
  },
};

export const VENTURE_IDS = Object.keys(VENTURES) as VentureId[];
