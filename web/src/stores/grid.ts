/**
 * How many tiles the live view shows, which page of cameras they hold, and
 * what that costs.
 *
 * Pure, and separate from the view, because these are the decisions that spend
 * money. A tile is not a thumbnail: each one is an ffmpeg rendition running on
 * the customer's own hardware and a stream of segment uploads to S3. Sixteen
 * tiles is sixteen of those, and the person choosing needs to be told so at the
 * moment they choose.
 */

/**
 * The tile counts offered.
 *
 * Sixteen is the ceiling by product decision. The steps below it are the ones
 * that tile evenly at common window widths, so a chosen count is usually the
 * count you get rather than a row of orphans.
 */
export const TILE_CHOICES = [1, 4, 6, 9, 12, 16] as const;

export const MAX_TILES = 16;

/**
 * Segment length, in seconds, as the agent publishes it.
 *
 * Must match AgentConfig.segmentDurationMs. It is the dominant cost lever in
 * the whole system — halving it doubles the request bill — so the figure the
 * console quotes is derived from it rather than written down twice.
 */
export const SEGMENT_SECONDS = 4;

/** S3 PUT price per thousand requests, ap-south-1, S3 Standard. */
const PUT_PER_THOUSAND_USD = 0.005;

/**
 * What an hour of one stream costs in S3 requests.
 *
 * Each segment is two PUTs: the segment itself, and the rewritten playlist
 * that names it. Requests are counted and storage is not, because at this
 * segment length requests are two orders of magnitude the larger term — a
 * month of continuous streaming is a few dollars of PUTs against a few cents
 * of storage, since segments are deleted long before they accumulate.
 */
export function hourlyCostUsd(streams: number, segmentSeconds = SEGMENT_SECONDS): number {
  if (streams <= 0) return 0;
  const segmentsPerHour = 3600 / segmentSeconds;
  const puts = streams * segmentsPerHour * 2;
  return (puts / 1000) * PUT_PER_THOUSAND_USD;
}

/**
 * The cost line shown beside the tile selector.
 *
 * Phrased per hour rather than per month because that is the decision being
 * made: someone is about to leave a wall of cameras open on a desk.
 */
export function costNote(streams: number): string {
  if (streams <= 0) return 'Nothing is streaming.';
  const perHour = hourlyCostUsd(streams);
  const each = streams === 1 ? 'stream' : 'streams';
  return `${streams} live ${each} — about $${perHour.toFixed(2)} an hour while open.`;
}

export interface PagePlan<T> {
  items: T[];
  /** The page actually shown, which may not be the one asked for. */
  page: number;
  pages: number;
  from: number;
  to: number;
  total: number;
}

/**
 * The slice of cameras a page holds.
 *
 * Clamps rather than trusting the page number, because the list moves
 * underneath it: cameras are removed, a filter narrows, an agent is picked.
 * Asking for page nine of a list that now has two is an ordinary thing for the
 * UI to do, and the honest answer is the last page rather than an empty grid.
 */
export function pageOf<T>(items: T[], perPage: number, page: number): PagePlan<T> {
  const size = Math.max(1, Math.floor(perPage));
  const total = items.length;
  const pages = Math.max(1, Math.ceil(total / size));
  const clamped = Math.min(Math.max(0, Math.floor(page)), pages - 1);
  const from = clamped * size;
  const slice = items.slice(from, from + size);
  return {
    items: slice,
    page: clamped,
    pages,
    from: total === 0 ? 0 : from + 1,
    to: from + slice.length,
    total,
  };
}

/**
 * The smallest a tile may get before it stops being worth showing.
 *
 * The grid fills by width, so on a narrow window it gives fewer columns than
 * the chosen tile count rather than shrinking them past legibility. The chosen
 * count is a ceiling on the page, not a demand on the layout.
 */
export const MIN_TILE_PX = 240;

/**
 * The CSS track definition for a given tile count.
 *
 * Wider tile counts want a smaller floor: sixteen tiles at 240px each needs a
 * very wide screen, so the floor eases down as the count rises and lets the
 * browser choose the columns.
 */
export function gridTemplate(tiles: number): string {
  const floor = tiles >= 12 ? MIN_TILE_PX : tiles >= 6 ? 300 : 360;
  return `repeat(auto-fill, minmax(min(100%, ${floor}px), 1fr))`;
}
