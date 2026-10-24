"use client";

import { toast } from "sonner";
import { BotAvatar } from "@/components/bot-avatar";
import { Command, CommandEmpty, CommandGroup, CommandInput, CommandItem, CommandList } from "@/components/ui/command";
import { Dialog, DialogContent, DialogTitle } from "@/components/ui/dialog";
import { applyTheme, type ThemeMode } from "@/lib/theme";

export function AppCommandPalette({ bots, go, onOpenChange, onCreate }: {
  bots: Array<{ id: string; name: string; role: string; avatarShape: string; avatarColor: string }>;
  go: (path: string) => void;
  onOpenChange: (open: boolean) => void;
  onCreate: () => void;
}) {
  return (
        <Dialog open onOpenChange={onOpenChange}>
          <DialogContent data-testid="command-palette" className="overflow-hidden p-0 sm:max-w-lg">
            <DialogTitle className="sr-only">Command palette</DialogTitle>
            <Command>
              <CommandInput placeholder="Jump to a teammate or run a command" />
              <CommandList>
                <CommandEmpty>No matches.</CommandEmpty>
                <CommandGroup heading="Teammates">
                  {bots.map((bot) => (
                    <CommandItem key={bot.id} value={`${bot.name} ${bot.role}`} onSelect={() => go(`/bots/${bot.id}`)}>
                      <BotAvatar botId={bot.id} shape={bot.avatarShape} color={bot.avatarColor} size={24} />{bot.name}
                      <span className="ml-2 truncate text-xs text-muted-foreground">{bot.role}</span>
                    </CommandItem>
                  ))}
                </CommandGroup>
                <CommandGroup heading="Actions">
                  <CommandItem onSelect={() => go("/settings")}>Open settings</CommandItem>
                  <CommandItem
                    onSelect={() => {
                      onOpenChange(false);
                      onCreate();
                    }}
                  >
                    New teammate
                  </CommandItem>
                  {(["dark", "light", "system"] as ThemeMode[]).map((mode) => (
                    <CommandItem
                      key={mode}
                      onSelect={() => {
                        applyTheme(mode);
                        onOpenChange(false);
                        toast.success(`Theme set to ${mode}.`);
                      }}
                    >
                      Theme {mode}
                    </CommandItem>
                  ))}
                </CommandGroup>
              </CommandList>
            </Command>
          </DialogContent>
        </Dialog>
  );
}
