"use client";

import { Plug } from "lucide-react";
import { Button } from "@/components/ui/button";

const variants = [
  ["primary", "default"],
  ["secondary", "secondary"],
  ["ghost", "ghost"],
  ["danger", "destructive"],
] as const;

export default function ButtonContrastPage() {
  return (
    <main data-testid="button-contrast" className="flex flex-col items-start gap-4 bg-background p-8 text-foreground">
      {variants.map(([name, variant]) => (
        <Button key={name} variant={variant} data-testid={`button-${name}`}>
          <Plug />
          {name[0].toUpperCase() + name.slice(1)} label
        </Button>
      ))}
      <Button size="sm" data-testid="button-primary-sm">
        <Plug />
        Connect apps
      </Button>
    </main>
  );
}
