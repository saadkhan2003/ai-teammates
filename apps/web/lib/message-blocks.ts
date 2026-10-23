export type QuestionOption = { label: string; style: "primary" | "danger" };

export type MessageBlock =
  | { kind: "text"; text: string }
  | { kind: "question"; prompt: string; options: QuestionOption[]; multiple: boolean; allowCustom: boolean; answer: string[] | null }
  | { kind: "memory"; action: "saved" | "updated" | "forgot" | "suggested" | "blocked"; memoryId?: string; memoryKind?: string; text: string; previous?: string; reason?: string }
  | { kind: "form"; title: string; fields: FormField[] }
  | { kind: "file"; name: string; url?: string; mime?: string }
  | { kind: "image"; name: string; url: string };

export type FormField = { name: string; label: string; secret?: boolean };

function asBlock(value: unknown): MessageBlock | null {
  if (!value || typeof value !== "object") return null;
  const record = value as Record<string, unknown>;
  const type = String(record.type ?? record.kind ?? "");
  if (type === "question") {
    const styles = Array.isArray(record.styles) ? record.styles.map((item) => String(item)) : [];
    const options: QuestionOption[] = [];
    if (Array.isArray(record.options)) {
      record.options.forEach((item, index) => {
        if (typeof item === "string" && item.trim()) {
          options.push({ label: item.trim(), style: styles[index] === "danger" ? "danger" : "primary" });
          return;
        }
        const option = (item ?? {}) as Record<string, unknown>;
        const label = String(option.label ?? option.text ?? "").trim();
        if (!label) return;
        const style = String(option.style ?? styles[index] ?? "") === "danger" ? "danger" : "primary";
        options.push({ label, style });
      });
    }
    let answer: string[] | null = null;
    if (Array.isArray(record.answer)) answer = record.answer.map((item) => String(item)).filter(Boolean);
    else if (typeof record.answer === "string" && record.answer.trim()) answer = [record.answer.trim()];
    return {
      kind: "question",
      prompt: String(record.prompt ?? record.question ?? ""),
      options: options.slice(0, 6),
      multiple: record.multiple === true || record.multi === true,
      allowCustom: record.allowCustom === true || record.allow_custom === true,
      answer,
    };
  }
  if (type === "memory" || type === "note") {
    const action = String(record.action ?? "saved");
    if (!["saved", "updated", "forgot", "suggested", "blocked"].includes(action)) return null;
    return { kind: "memory", action: action as "saved" | "updated" | "forgot" | "suggested" | "blocked", memoryId: String(record.memoryId ?? record.memory_id ?? "") || undefined, memoryKind: String(record.kindName ?? record.memoryKind ?? record.noteKind ?? (record.type === "memory" ? record.kind : "") ?? "") || undefined, text: String(record.content ?? record.text ?? record.fact ?? ""), previous: typeof record.previous === "string" ? record.previous : undefined, reason: typeof record.reason === "string" ? record.reason : undefined };
  }
  if (type === "form" || type === "secure-form") {
    const fields: FormField[] = [];
    if (Array.isArray(record.fields)) {
      for (const field of record.fields) {
        const item = (field ?? {}) as Record<string, unknown>;
        const name = String(item.name ?? "");
        if (!name) continue;
        fields.push({ name, label: String(item.label ?? name), secret: item.secret === true || item.type === "secret" });
      }
    }
    return { kind: "form", title: String(record.title ?? "Secure form"), fields };
  }
  if (type === "file" || type === "attachment") {
    return { kind: "file", name: String(record.name ?? "File"), url: typeof record.url === "string" ? record.url : undefined, mime: typeof record.mime === "string" ? record.mime : undefined };
  }
  if (type === "image") {
    const url = String(record.url ?? "");
    if (!url) return null;
    return { kind: "image", name: String(record.name ?? "Image"), url };
  }
  return null;
}

export function messageBlocks(content: string): MessageBlock[] {
  const trimmed = content.trim();
  if (trimmed.startsWith("{") && trimmed.endsWith("}")) {
    try {
      const block = asBlock(JSON.parse(trimmed));
      if (block) return [block];
    } catch {
      // Plain text that happens to use braces.
    }
  }
  const blocks: MessageBlock[] = [];
  const pattern = /```(question|form|file|image|memory)\n([\s\S]*?)```/g;
  let last = 0;
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(content))) {
    if (match.index > last) blocks.push({ kind: "text", text: content.slice(last, match.index).trim() });
    try {
      const block = asBlock({ type: match[1], ...JSON.parse(match[2]) });
      if (block) blocks.push(block);
      else blocks.push({ kind: "text", text: match[0] });
    } catch {
      blocks.push({ kind: "text", text: match[0] });
    }
    last = match.index + match[0].length;
  }
  const rest = content.slice(last).trim();
  if (rest) blocks.push({ kind: "text", text: rest });
  if (blocks.length === 0) blocks.push({ kind: "text", text: content });
  return blocks.flatMap((block) => (block.kind === "text" ? splitInline(block.text) : [block]));
}

function splitInline(text: string): MessageBlock[] {
  const blocks: MessageBlock[] = [];
  const pattern = /!\[([^\]]*)\]\(([^)\s]+)\)|\[([^\]]+\.(?:png|jpe?g|gif|webp|pdf|txt|csv|zip))\]\(([^)\s]+)\)/gi;
  let last = 0;
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(text))) {
    if (match.index > last) blocks.push({ kind: "text", text: text.slice(last, match.index) });
    if (match[2]) blocks.push({ kind: "image", name: match[1] || "Image", url: match[2] });
    else blocks.push({ kind: "file", name: match[3], url: match[4] });
    last = match.index + match[0].length;
  }
  const rest = text.slice(last);
  if (rest) blocks.push({ kind: "text", text: rest });
  return blocks.length > 0 ? blocks : [{ kind: "text", text }];
}
