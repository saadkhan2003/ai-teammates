"use client";

import { useEffect, useState } from "react";
import { Trash2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { api } from "@/lib/api";

type LearnedNote = { id: string; kind: string; text: string; source: { messageId?: string; conversationId?: string; excerpt?: string; signal?: string; text?: string } };
const groups = [["preference", "Preferences"], ["quality_bar", "Quality bar"], ["avoid", "Avoid"], ["approved_decision", "Decisions"]];

export function LearnedSection({ botId, onOpenMessage }: { botId: string; onOpenMessage?: () => void }) {
  const [notes, setNotes] = useState<LearnedNote[]>([]);
  const [error, setError] = useState("");
  const [loaded, setLoaded] = useState(false);
  const [deleting, setDeleting] = useState<LearnedNote | null>(null);
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    let alive = true;
    setNotes([]); setLoaded(false); setError(""); setDeleting(null);
    async function refresh() {
      if (document.hidden) return;
      try { const rows = await api<LearnedNote[]>(`/api/bots/${botId}/learned`); if (alive) { setNotes(rows); setLoaded(true); setError(""); } }
      catch { if (alive) { setLoaded(true); setError("Could not load learned notes. Retrying…"); } }
    }
    void refresh();
    const timer = window.setInterval(() => void refresh(), 4000);
    return () => { alive = false; window.clearInterval(timer); };
  }, [botId]);
  async function remove() {
    if (!deleting) return;
    setBusy(true);
    try { await api(`/api/bots/${botId}/learned/${deleting.id}`, { method: "DELETE" }); setNotes(rows => rows.filter(row => row.id !== deleting.id)); setDeleting(null); setError(""); }
    catch { setError("Could not delete this note. Try again."); }
    finally { setBusy(false); }
  }
  return <section data-testid="learned-section" className="min-w-0 border-b border-border px-3 py-3">
    <h2 className="text-[13px] font-medium">What I’ve learned about you</h2>
    {!loaded ? <p className="mt-2 text-xs text-muted-foreground">Loading notes…</p> : !notes.length && !error ? <p className="mt-2 text-[13px] font-normal text-muted-foreground">Your reactions and feedback help me learn your preferences. Nothing learned yet.</p> : null}
    {groups.map(([kind, label]) => {
      const rows = notes.filter(row => row.kind === kind);
      return rows.length ? <div key={kind} className="mt-3"><h3 className="text-xs font-medium text-muted-foreground">{label}</h3><ul className="mt-1 divide-y divide-border">{rows.map(note => <li key={note.id} data-testid="learned-item" className="flex min-w-0 items-start gap-1 py-2">
        <div className="min-w-0 flex-1"><p className="break-words text-[13px] font-normal leading-5">{note.text}</p>{note.source.messageId ? <button type="button" className="mt-1 min-h-8 max-w-full text-left text-xs font-normal text-muted-foreground underline decoration-border underline-offset-2 hover:text-foreground" onClick={() => { onOpenMessage?.(); document.dispatchEvent(new CustomEvent("library:open-message", { detail: note.source.messageId })); }}>
          from your {note.source.signal === "reaction" ? note.source.text : note.source.signal === "pick" ? "choice" : "feedback"} on <span className="break-words">{(note.source.excerpt || "this message").slice(0, 70)}</span>
        </button> : <p className="mt-1 text-xs font-normal text-muted-foreground">from your {note.source.signal === "approval" ? "approval decision" : "feedback"}</p>}</div>
        <Button data-testid="learned-delete" type="button" variant="ghost" size="icon" className="h-11 w-11 shrink-0 rounded-md text-muted-foreground" aria-label="Delete learned note" onClick={() => setDeleting(note)}><Trash2 className="h-3.5 w-3.5" /></Button>
      </li>)}</ul></div> : null;
    })}
    {error ? <p role="alert" className="mt-2 text-xs text-destructive">{error}</p> : null}
    <Dialog open={!!deleting} onOpenChange={open => { if (!open && !busy) setDeleting(null); }}><DialogContent className="max-w-[calc(100%-2rem)] rounded-lg sm:max-w-sm"><DialogHeader><DialogTitle className="text-[15px] font-medium">Delete this learned note?</DialogTitle><DialogDescription className="text-[13px] font-normal">This feedback won’t recreate the note. You can teach me a new preference later.</DialogDescription></DialogHeader><p className="break-words text-[13px] font-normal">{deleting?.text}</p><DialogFooter><Button variant="outline" className="min-h-11 rounded-md" disabled={busy} onClick={() => setDeleting(null)}>Cancel</Button><Button variant="destructive" className="min-h-11 rounded-md" disabled={busy} onClick={() => void remove()}>{busy ? "Deleting…" : "Delete note"}</Button></DialogFooter></DialogContent></Dialog>
  </section>;
}
