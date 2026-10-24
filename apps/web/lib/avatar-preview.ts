type PreviewListener = (botId: string, preview: string) => void;

const previews = new Map<string, string>();
const listeners = new Set<PreviewListener>();

export function publishAvatarPreview(botId: string, preview: string) {
  if (!botId || previews.get(botId) === preview) return;
  previews.set(botId, preview);
  for (const listener of listeners) listener(botId, preview);
}

export function subscribeAvatarPreview(botId: string, onPreview: (preview: string) => void) {
  onPreview(previews.get(botId) ?? "");
  const listener: PreviewListener = (id, preview) => {
    if (id === botId) onPreview(preview);
  };
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

export function avatarPreviewFor(botId: string) {
  return previews.get(botId) ?? "";
}
