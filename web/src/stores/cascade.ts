/**
 * The rules one level of the selection rail follows.
 *
 * Extracted from the store so they can be reasoned about — and tested —
 * without a component, a router or a network. They are the specified
 * behaviour of the console's dropdowns, and every clause has a reason:
 *
 *  - One option selects itself, and says so. A silent selection is
 *    indistinguishable from a choice the user made and forgot making.
 *  - Several options wait. Guessing spends the customer's money on streams at
 *    a site nobody asked about.
 *  - No options select nothing, so the level can say "none here" rather than
 *    looking like it is still loading.
 *  - A selection that is still valid survives a refresh. A background reload
 *    must not move what somebody is watching.
 *  - A level that gains options keeps its value but stops calling it
 *    automatic — an agent enrolling should not silently relabel a choice.
 */
export interface Settled {
  value: string | null;
  /** True when this level chose for the user rather than the other way round. */
  automatic: boolean;
}

export function settleLevel(current: string | null, options: string[]): Settled {
  if (current !== null && options.includes(current)) {
    // Still valid. It is only "automatic" while it remains the sole answer.
    return { value: current, automatic: options.length === 1 };
  }
  if (options.length === 1) {
    return { value: options[0]!, automatic: true };
  }
  return { value: null, automatic: false };
}

/**
 * What a level should say about itself.
 *
 * Waiting, having nothing, and having something unchosen look alike in a
 * dropdown and are entirely different situations. Naming which one is the
 * whole reason this line exists.
 */
export function levelStatus(state: {
  blockedBy?: string | null;
  loading?: boolean;
  options: number;
  selected: boolean;
  automatic?: boolean;
}): string {
  if (state.blockedBy) return `Choose a ${state.blockedBy} first`;
  if (state.loading) return 'Loading…';
  if (state.options === 0) return 'None here';
  if (state.automatic && state.selected) return 'Only one — selected for you';
  if (!state.selected) return `${state.options} to choose from`;
  return `${state.options} available`;
}

/**
 * Guards a level against a slow answer to a question nobody is asking any more.
 *
 * Selecting a premises and then an agent puts two camera queries in flight at
 * once, and the wider one is the slower one precisely because it returns more
 * rows. Without this, that abandoned answer lands last and wins, and an
 * operator who selected one agent is shown another agent's cameras — a real
 * failure at ten thousand cameras, and invisible at three.
 *
 * Each request takes a ticket; only the newest ticket for a level may write.
 */
export function createLatest() {
  const issued = new Map<string, number>();
  return {
    /** Claims a level for a new request, invalidating any still in flight. */
    begin(level: string): number {
      const next = (issued.get(level) ?? 0) + 1;
      issued.set(level, next);
      return next;
    },
    /** Whether this request is still the one whose answer matters. */
    current(level: string, ticket: number): boolean {
      return issued.get(level) === ticket;
    },
  };
}
