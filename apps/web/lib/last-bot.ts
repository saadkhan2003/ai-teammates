export type BotRoute = { id: string };

export function lastBotPath(bots: BotRoute[], lastId: string): string | null {
  const bot = bots.find(item => item.id === lastId) ?? bots[0];
  return bot ? `/bots/${encodeURIComponent(bot.id)}` : null;
}
