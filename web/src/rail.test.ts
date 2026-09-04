import { describe, it, expect } from 'vitest';
import { levelsFor, showsLevel, searchKinds } from './rail';

/**
 * The rail offered every level on every page, so the agents page asked you to
 * pick an agent in the sidebar while listing agents in a table, and the set-up
 * page offered a dropdown of registered cameras while its entire purpose was
 * the ones that are not registered yet.
 */
describe('rail relevance', () => {
  it('does not offer a camera on the page that lists cameras', () => {
    expect(showsLevel('cameras', 'camera')).toBe(false);
    expect(showsLevel('cameras', 'agent')).toBe(true);
  });

  it('does not offer an agent or a camera on the page that lists agents', () => {
    expect(levelsFor('agents')).toEqual(['customer', 'premises']);
  });

  it('does not offer a camera while approving ones that are not registered', () => {
    expect(showsLevel('add', 'camera')).toBe(false);
    expect(showsLevel('add', 'agent')).toBe(true);
  });

  it('offers everything on the wall, which is the page that narrows to one', () => {
    expect(levelsFor('live')).toEqual(['customer', 'premises', 'agent', 'camera']);
  });

  it('keeps customer everywhere it scopes the page', () => {
    for (const page of ['live', 'cameras', 'add', 'agents', 'premises', 'users']) {
      expect(showsLevel(page, 'customer')).toBe(true);
    }
  });

  it('offers nothing at all on a page about the deployment itself', () => {
    // Alarm recipients are platform-wide. There is no customer, premises,
    // agent or camera to narrow by, so a rail would be four dropdowns that
    // change nothing on screen.
    expect(levelsFor('alerts')).toEqual([]);
    expect(searchKinds('alerts').any).toBe(false);
  });

  it('falls back to the whole rail for a page it has never heard of', () => {
    // A page added later should be over-served rather than silently crippled.
    expect(levelsFor('something-new')).toHaveLength(4);
    expect(levelsFor(undefined)).toHaveLength(4);
  });

  it('hides the search box where neither kind of result could be shown', () => {
    expect(searchKinds('users').any).toBe(false);
    expect(searchKinds('premises').any).toBe(false);
    expect(searchKinds('live')).toEqual({ premises: true, cameras: true, any: true });
    // The cameras page can still be pointed at a site, but a camera result
    // would have nowhere to land.
    expect(searchKinds('cameras')).toEqual({ premises: true, cameras: false, any: true });
  });
});
