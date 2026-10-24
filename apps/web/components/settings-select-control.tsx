"use client";

import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";

export type SettingsSelectProps = {
  value: string;
  onValueChange: (value: string) => void;
  options: Array<{ value: string; label: string }>;
  disabled?: boolean;
  id?: string;
  className?: string;
  "data-testid"?: string;
  "aria-label"?: string;
};
export function SettingsSelectControl({ value, onValueChange, options, disabled, ...trigger }: SettingsSelectProps) {
  return <Select value={value} onValueChange={onValueChange} disabled={disabled}>
    <SelectTrigger {...trigger}><SelectValue /></SelectTrigger>
    <SelectContent>{options.map(option => <SelectItem key={option.value} value={option.value}>{option.label}</SelectItem>)}</SelectContent>
  </Select>;
}
