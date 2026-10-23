// Turns a 5-field cron expression into short words for the Routines list.
const DAYS = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];

function clock(hour: number, minute: number): string {
  const suffix = hour >= 12 ? "PM" : "AM";
  const h = hour % 12 === 0 ? 12 : hour % 12;
  return `${h}:${String(minute).padStart(2, "0")} ${suffix}`;
}

function num(value: string, max: number): number | null {
  if (!/^\d{1,2}$/.test(value)) return null;
  const n = Number(value);
  return n <= max ? n : null;
}

function ordinal(n: number): string {
  const rem = n % 100;
  if (rem >= 11 && rem <= 13) return `${n}th`;
  return `${n}${["th", "st", "nd", "rd"][n % 10 > 3 ? 0 : n % 10]}`;
}

export function cronToWords(cron: string | undefined | null): string {
  const parts = (cron ?? "").trim().split(/\s+/);
  if (parts.length !== 5) return "Custom schedule";
  const [min, hour, dom, mon, dow] = parts;
  const step = /^\*\/(\d{1,2})$/.exec(min);
  if (step && hour === "*" && dom === "*" && mon === "*" && dow === "*") {
    const n = Number(step[1]);
    return n === 1 ? "Every minute" : n > 0 && n < 60 ? `Every ${n} minutes` : "Custom schedule";
  }
  if (min === "*" && hour === "*" && dom === "*" && mon === "*" && dow === "*") return "Every minute";
  const minute = num(min, 59);
  if (minute === null) return "Custom schedule";
  if (hour === "*" && dom === "*" && mon === "*" && dow === "*") return minute === 0 ? "Every hour" : `Every hour at :${String(minute).padStart(2, "0")}`;
  const h = num(hour, 23);
  if (h === null || mon !== "*") return "Custom schedule";
  const at = clock(h, minute);
  if (dom === "*" && dow === "*") return `Every day at ${at}`;
  if (dom === "*" && dow === "1-5") return `Every weekday at ${at}`;
  if (dom === "*" && (dow === "0,6" || dow === "6,0")) return `Every weekend at ${at}`;
  if (dom === "*") {
    const d = num(dow === "7" ? "0" : dow, 6);
    return d === null ? "Custom schedule" : `Every ${DAYS[d]} at ${at}`;
  }
  const day = num(dom, 31);
  if (day !== null && dow === "*" && day >= 1) return `Monthly on the ${ordinal(day)} at ${at}`;
  return "Custom schedule";
}
