export function nextComputerView(view) {
  return view === "compact" ? "full" : "compact";
}

export function controlLabel(holder) {
  return holder === "human" ? "You're in control" : "Take control";
}

export function shouldRefreshPreview(compact, visible) {
  return compact && visible;
}

export const COMPUTER_PREVIEW_REFRESH_MS = 3000;
