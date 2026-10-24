/** Minimum tile width before the row stops adding columns and shows +N. */
export const IMAGE_GRID_GAP = 4;
export const IMAGE_GRID_MIN_TILE = 108;
export const IMAGE_GRID_MAX_COLUMNS = 4;
export const IMAGE_GRID_TILE_HEIGHT = 112;
export const IMAGE_GRID_SINGLE_MAX_HEIGHT = 320;

export function imageGridColumns(width: number, count: number) {
  if (count <= 1) return count;
  const room = Math.max(1, Math.floor((width + IMAGE_GRID_GAP) / (IMAGE_GRID_MIN_TILE + IMAGE_GRID_GAP)));
  return Math.min(count, IMAGE_GRID_MAX_COLUMNS, room);
}
