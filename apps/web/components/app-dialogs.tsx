"use client";

import { type FormEvent, useEffect, useState } from "react";
import dynamic from "next/dynamic";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { api } from "@/lib/api";
import { errorMessage } from "@/lib/utils";

const BotAvatarPicker = dynamic(() => import("@/components/bot-avatar-picker").then(module => module.BotAvatarPicker));
const TemplateImport = dynamic(() => import("@/components/template-import").then(module => module.TemplateImport));

export function CreateTeammateDialog({
  open,
  onOpenChange,
  onCreated,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onCreated: () => void;
}) {
  const [name, setName] = useState("");
  const [role, setRole] = useState("");
  const [bio, setBio] = useState("");
  const [instructions, setInstructions] = useState("");
  const [avatarShape, setAvatarShape] = useState("blob3");
  const [avatarColor, setAvatarColor] = useState("#ff3045");
  const [creating, setCreating] = useState(false);
  const [formError, setFormError] = useState<string | null>(null);

  useEffect(() => {
    if (!open || !window.location.hash.startsWith("#template=")) return;
    setValueFromFragment();
  }, [open]);

  function applyTemplate(template: Record<string, unknown>) {
    setName(typeof template.name === "string" ? template.name : "");
    setRole(typeof template.role === "string" ? template.role : "");
    setInstructions(typeof template.instructions === "string" ? template.instructions : "");
    setAvatarShape(typeof template.avatarShape === "string" ? template.avatarShape : "blob3");
    setAvatarColor(typeof template.avatarColor === "string" ? template.avatarColor : "#ff3045");
    setFormError(null);
  }

  async function setValueFromFragment() {
    try {
      const encoded = window.location.hash.slice("#template=".length);
      const json = decodeURIComponent(escape(atob(encoded.replace(/-/g, "+").replace(/_/g, "/"))));
      const clean = await api<Record<string, unknown>>("/api/templates/preview", { method: "POST", body: json });
      applyTemplate(clean);
    } catch (caught) { setFormError(errorMessage(caught, "This template link could not be imported.")); }
  }

  async function createBot(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!name.trim()) {
      setFormError("Give your teammate a name");
      document.getElementById("bot-name")?.focus();
      return;
    }
    setCreating(true);
    setFormError(null);
    try {
      await api("/api/bots", {
        method: "POST",
        body: JSON.stringify({ name: name.trim(), role: role.trim(), instructions: instructions.trim(), avatarShape, avatarColor, ...(bio.trim() ? { bio: bio.trim() } : {}) }),
      });
      setName("");
      setRole("");
      setBio("");
      setInstructions("");
      setAvatarShape("blob3");
      setAvatarColor("#ff3045");
      onOpenChange(false);
      toast.success(`Created ${name}.`);
      window.dispatchEvent(new Event("teammates-bots-changed"));
      onCreated();
    } catch (caught) {
      setFormError(errorMessage(caught, "Could not create that teammate."));
    } finally {
      setCreating(false);
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle data-testid="create-bot-title">Create New Bot</DialogTitle>
          <DialogDescription className="sr-only">Choose an avatar and name your bot. Role and instructions are optional.</DialogDescription>
        </DialogHeader>
        <form data-testid="create-bot-form" className="flex max-h-[80vh] flex-col gap-3 overflow-y-auto" onSubmit={createBot} noValidate>
          <TemplateImport onTemplate={applyTemplate} />
          <BotAvatarPicker shape={avatarShape} color={avatarColor} onChange={(shape, color) => { setAvatarShape(shape); setAvatarColor(color); }} />
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="bot-name">Name your Bot</Label>
            <Input id="bot-name" data-testid="bot-name" placeholder="Name your Bot" value={name} onChange={(event) => { setName(event.target.value); setFormError(null); }} aria-invalid={!!formError && !name.trim()} aria-describedby="bot-name-help bot-form-error" />
            <p id="bot-name-help" className="text-xs text-muted-foreground">Required. What should we call your teammate?</p>
          </div>
          <Collapsible>
          <CollapsibleTrigger type="button" data-testid="bot-advanced-toggle" className="text-sm text-muted-foreground underline">Advanced (optional)</CollapsibleTrigger>
          <CollapsibleContent className="mt-3 grid gap-3">
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="bot-bio">Bio (optional)</Label>
            <Input id="bot-bio" data-testid="bot-bio-input" maxLength={60} value={bio} onChange={(event) => setBio(event.target.value)} placeholder="Short title, up to 60 characters" />
          </div>
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="bot-role" className="flex items-center gap-2">
              <span className="grid h-6 w-6 place-items-center rounded-md bg-primary text-[11px] text-primary-foreground">B</span>
              Title
            </Label>
            <Input id="bot-role" data-testid="bot-role" value={role} onChange={(event) => setRole(event.target.value)} aria-describedby="bot-role-help" />
            <p id="bot-role-help" className="text-xs text-muted-foreground">Optional. Defaults to Teammate.</p>
          </div>
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="bot-instructions" className="flex items-center gap-2">
              <span className="grid h-6 w-6 place-items-center rounded-md bg-primary text-[11px] text-primary-foreground">C</span>
              Instructions
            </Label>
            <Textarea
              id="bot-instructions"
              data-testid="bot-instructions"
              value={instructions}
              onChange={(event) => setInstructions(event.target.value)}
              aria-describedby="bot-instructions-help"
            />
          </div>
          <p id="bot-instructions-help" className="text-xs text-muted-foreground">Optional. Describe their work, preferences, or goals.</p>
          </CollapsibleContent>
          </Collapsible>
          {formError ? (
            <p id="bot-form-error" role="alert" className="text-sm text-destructive">
              {formError}
            </p>
          ) : null}
          <DialogFooter><Button type="button" variant="outline" data-testid="bot-cancel" onClick={() => onOpenChange(false)}>Cancel</Button><Button data-testid="bot-create" type="submit" disabled={creating || !name.trim()}>
            {creating ? "Creating…" : "Create"}
          </Button></DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

const shortcutGroups = [
  ["Essentials", [["Search", "Ctrl K  or  Ctrl Shift F"], ["New Bot", "Ctrl N"], ["Send", "Enter"], ["Go to Bot", "Ctrl 1–9"], ["Compact sidebar", "Ctrl B"], ["Settings", "Ctrl ,"], ["Keyboard shortcuts", "Ctrl /"]]],
  ["Chat", [["Focus chat", "Ctrl I"], ["Find in chat", "Ctrl F"], ["Dictate", "Ctrl D"], ["Add selection to chat", "Ctrl L"]]],
  ["Message", [["Reply (message focused)", "R"], ["React", "E"], ["Copy", "C"], ["More actions", "Enter or Shift F10"], ["Previous / next message", "↑ / ↓"], ["Close menu", "Esc"]]],
  ["Navigation", [["Previous / next Bot", "Alt ↑ / Alt ↓"], ["Back / forward", "Ctrl [ / Ctrl ]"], ["Switch Bots", "Hold Ctrl  Tab"]]],
  ["Panels", [["Details", "Ctrl Alt B"], ["Skills", "Ctrl Shift W"], ["Connect apps", "Ctrl Shift M"]]],
  ["Window", [["Zoom", "Ctrl + / Ctrl − / Ctrl 0"], ["Full screen", "F11"]]],
] as const;

export function ShortcutsDialog({ open, onOpenChange }: { open: boolean; onOpenChange: (open: boolean) => void }) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[85vh] overflow-y-auto sm:max-w-3xl" data-testid="shortcuts-dialog">
        <DialogHeader><DialogTitle>Keyboard shortcuts</DialogTitle></DialogHeader>
        <div className="grid gap-x-10 gap-y-5 sm:grid-cols-2">
          {shortcutGroups.map(([title, entries]) => <section key={title}><h3 className="mb-2 text-sm font-medium">{title}</h3><div className="divide-y divide-border">{entries.map(([label, keys]) => <div key={label} className="flex min-h-10 items-center justify-between gap-3 text-sm"><span>{label}</span><span className="text-xs text-muted-foreground">{keys.split(" ").map((key, index) => <kbd key={`${key}-${index}`} className="ml-1 rounded border border-border bg-muted px-1.5 py-0.5 font-mono">{key}</kbd>)}</span></div>)}</div></section>)}
        </div>
      </DialogContent>
    </Dialog>
  );
}

export function FeedbackDialog({ open, onOpenChange }: { open: boolean; onOpenChange: (open: boolean) => void }) {
  const [message, setMessage] = useState("");
  const [busy, setBusy] = useState(false);
  async function submit(event: FormEvent) {
    event.preventDefault(); setBusy(true);
    try { await api("/api/feedback", { method: "POST", body: JSON.stringify({ message, category: "general" }) }); toast.success("Feedback sent."); setMessage(""); onOpenChange(false); }
    catch (error) { toast.error(errorMessage(error, "Could not send feedback.")); }
    finally { setBusy(false); }
  }
  return <Dialog open={open} onOpenChange={onOpenChange}><DialogContent data-testid="feedback-dialog"><DialogHeader><DialogTitle>Send feedback</DialogTitle><DialogDescription>Share a note with the AI Teammates team.</DialogDescription></DialogHeader><form onSubmit={(event) => void submit(event)} className="space-y-3"><Textarea data-testid="feedback-message" value={message} onChange={event => setMessage(event.target.value)} maxLength={5000} required placeholder="What should we know?" /><Button data-testid="feedback-submit" type="submit" disabled={busy || !message.trim()}>{busy ? "Sending…" : "Send feedback"}</Button></form></DialogContent></Dialog>;
}
