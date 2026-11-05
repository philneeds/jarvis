"use client";

import { createContext, useCallback, useContext, useEffect, useRef, useState, type ReactNode } from "react";
import { post } from "./api";

/** Shows "<what> · Undo" for a few seconds after a delete. The server keeps the deleted thing for a while longer. */
type ShowUndo = (text: string, undoId: string, onUndone?: () => void) => void;

const Ctx = createContext<ShowUndo | null>(null);
const SHOW_MS = 8000;

export function UndoProvider({ children }: { children: ReactNode }) {
  const [toast, setToast] = useState<{ key: number; text: string; undoId?: string; onUndone?: () => void } | null>(null);
  const [busy, setBusy] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const hideLater = useCallback((ms: number) => { clearTimeout(timer.current); timer.current = setTimeout(() => setToast(null), ms); }, []);
  useEffect(() => () => clearTimeout(timer.current), []);

  const show = useCallback<ShowUndo>((text, undoId, onUndone) => {
    setToast({ key: Date.now(), text, undoId, onUndone });
    hideLater(SHOW_MS);
  }, [hideLater]);

  const undo = async () => {
    if (!toast?.undoId) return;
    setBusy(true);
    try {
      await post(`/api/undo/${toast.undoId}`);
      toast.onUndone?.();
      setToast({ key: Date.now(), text: "Restored" });
    } catch {
      setToast({ key: Date.now(), text: "Too late to undo that one" });
    } finally { setBusy(false); hideLater(2500); }
  };

  return (
    <Ctx.Provider value={show}>
      {children}
      <div className="toast-host" role="status" aria-live="polite">
        {toast && (
          <div key={toast.key} className="toast">
            <span className="min-w-0 truncate">{toast.text}</span>
            {toast.undoId && <button className="btn btn-sm btn-primary flex-none" onClick={undo} disabled={busy}>Undo</button>}
            <button className="toast-x flex-none" onClick={() => setToast(null)} aria-label="Dismiss">×</button>
          </div>
        )}
      </div>
    </Ctx.Provider>
  );
}

export function useUndo(): ShowUndo {
  const v = useContext(Ctx);
  if (!v) throw new Error("useUndo outside UndoProvider");
  return v;
}
