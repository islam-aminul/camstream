/**
 * Which parts of the selection rail a page actually reads.
 *
 * The rail is one component on every page, which is what keeps a site selected
 * as you move between them. The cost is that it offered every level everywhere:
 * the agents page listed agents in a table and also asked you to choose one in
 * the sidebar, and the set-up page — whose whole job is finding cameras that
 * are not registered yet — offered a dropdown of the ones that already are.
 *
 * A control that cannot affect the page in front of you is not a neutral
 * extra. It invites a click, and the click appears to do nothing.
 *
 * The levels are hidden rather than disabled. A disabled dropdown still asks
 * to be clicked and then refuses, which is a worse answer than not raising the
 * question. Nothing is cleared when a level is hidden — the value is still
 * there, still in the URL, and still applies when you return to a page that
 * uses it.
 */
export type Level = 'customer' | 'premises' | 'agent' | 'camera';

const ALL: Level[] = ['customer', 'premises', 'agent', 'camera'];

const BY_PAGE: Record<string, Level[]> = {
  // The wall narrows all the way down: one camera can be shown on its own.
  live: ['customer', 'premises', 'agent', 'camera'],
  // The table is the list of cameras, so a camera dropdown above it would be
  // a second way to do the same thing, with a different result.
  cameras: ['customer', 'premises', 'agent'],
  // Approving a camera that is not registered yet. The registered ones are
  // exactly what this page is not about.
  add: ['customer', 'premises', 'agent'],
  // The table is the list of agents.
  agents: ['customer', 'premises'],
  // Both of these are tenant-wide.
  premises: ['customer'],
  users: ['customer'],
  // Alarms are about this deployment, not about any customer's estate, so the
  // rail has nothing to narrow.
  alerts: [],
};

/** The levels worth showing on a page. Unknown pages get all of them. */
export function levelsFor(page: string | null | undefined): Level[] {
  if (!page) return ALL;
  return BY_PAGE[page] ?? ALL;
}

export function showsLevel(page: string | null | undefined, level: Level): boolean {
  return levelsFor(page).includes(level);
}

/**
 * What the search box should look for here.
 *
 * Searching is the fastest way to reach a camera by name, and useless on a
 * page that cannot show one. Where neither kind of result applies the box
 * itself is not worth the space.
 */
export function searchKinds(page: string | null | undefined): {
  premises: boolean; cameras: boolean; any: boolean;
} {
  const premises = showsLevel(page, 'premises');
  const cameras = showsLevel(page, 'camera');
  return { premises, cameras, any: premises || cameras };
}
