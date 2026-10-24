"use client";

import { type FormEvent, useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { toast } from "sonner";
import { BookOpen, LifeBuoy, Mail } from "lucide-react";
import { cardClass, controlClass, focusClass, FormActions, PageEmpty, PageError, PageHeader, PageSkeleton, pillClass, SectionTitle } from "@/components/account/chrome";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Textarea } from "@/components/ui/textarea";
import { api } from "@/lib/api";
import { type HelpPayload } from "@/lib/account";
import { errorMessage } from "@/lib/utils";

export default function HelpPage() {
  const [help, setHelp] = useState<HelpPayload | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [email, setEmail] = useState("");
  const [topic, setTopic] = useState("account");
  const [message, setMessage] = useState("");
  const [sent, setSent] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const next = await api<HelpPayload>("/api/help");
      setHelp(next);
      setTopic(next.topics[0] ?? "account");
      setError(null);
    } catch (caught) {
      setHelp(null);
      setError(errorMessage(caught, "Could not load help."));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  async function submit(event: FormEvent) {
    event.preventDefault();
    try {
      await api("/api/support", { method: "POST", body: JSON.stringify({ email, topic, message }) });
      setSent(true);
      setMessage("");
      toast.success("Message sent.");
    } catch (caught) {
      toast.error(errorMessage(caught, "Could not send the message."));
    }
  }

  return (
    <div data-testid="help-page" className="flex flex-col gap-[var(--space-section)]">
      <PageHeader title="Help" subtitle="Answers, the docs, and a note to the owner." />
      {loading ? <PageSkeleton /> : null}
      {error ? <PageError title="Could not load help." detail={error} onRetry={() => void load()} /> : null}
      {help ? (
        <>
          <section className="flex flex-col gap-[var(--space-label)]">
            <SectionTitle icon={<LifeBuoy className="size-4" aria-hidden="true" />}>FAQ</SectionTitle>
            {help.faq.length === 0 ? (
              <PageEmpty title="No questions yet" detail="Check the docs while the FAQ is empty." />
            ) : (
              <div data-testid="faq-list" className="flex flex-col gap-[var(--space-card)]">
                {help.faq.map((item) => (
                  <article key={item.id} className={`${cardClass} p-[var(--space-inset)]`}>
                    <h4 className="text-sm font-medium">{item.question}</h4>
                    <p className="mt-2 text-sm text-muted-foreground">{item.answer}</p>
                  </article>
                ))}
              </div>
            )}
          </section>
          <section className={`${cardClass} p-[var(--space-inset)]`}>
            <SectionTitle icon={<BookOpen className="size-4" aria-hidden="true" />}>Docs</SectionTitle>
            <ul className="mt-3 flex flex-col gap-2">
              {help.docs.map((doc) => (
                <li key={doc.href}>
                  <Link href={doc.href} className={`${controlClass} ${focusClass} flex min-h-11 flex-col justify-center border border-border px-3 py-2 transition-colors hover:bg-accent`}>
                    <span className="text-sm font-medium">{doc.title}</span>
                    <span className="text-xs text-muted-foreground">{doc.detail}</span>
                  </Link>
                </li>
              ))}
            </ul>
          </section>
          <section className={`${cardClass} p-[var(--space-inset)]`}>
            <SectionTitle icon={<Mail className="size-4" aria-hidden="true" />}>Contact</SectionTitle>
            {sent ? (
              <div className="mt-3" data-testid="contact-sent">
                <PageEmpty title="Message sent" detail="The owner can read it from the support inbox." action={<Button type="button" variant="outline" className={pillClass} onClick={() => setSent(false)}>Send another</Button>} />
              </div>
            ) : (
              <form data-testid="contact-form" className="mt-4 grid gap-4" onSubmit={(event) => void submit(event)}>
                <div className="grid gap-2">
                  <Label htmlFor="contact-email">Email</Label>
                  <Input id="contact-email" data-testid="contact-email" className={`${controlClass} min-h-11`} type="email" required value={email} onChange={(event) => setEmail(event.target.value)} />
                </div>
                <div className="grid gap-2">
                  <Label>Topic</Label>
                  <Select value={topic} onValueChange={setTopic}>
                    <SelectTrigger data-testid="contact-topic" className={`${controlClass} min-h-11`}>
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      {help.topics.map((item) => (
                        <SelectItem key={item} value={item}>
                          {item}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>
                <div className="grid gap-2">
                  <Label htmlFor="contact-message">Message</Label>
                  <Textarea id="contact-message" data-testid="contact-message" className={`${controlClass} min-h-28`} required value={message} onChange={(event) => setMessage(event.target.value)} />
                </div>
                <FormActions>
                  <Button data-testid="contact-send" type="submit" className={pillClass}>
                    Send
                  </Button>
                </FormActions>
              </form>
            )}
          </section>
        </>
      ) : null}
    </div>
  );
}
