/**
 * Whether an agent can usefully be told to update, and why not when it cannot.
 *
 * Two things have to be true: the agent is connected, because the instruction
 * arrives over MQTT and an offline agent will never hear it; and it is not
 * already running the build an Update would install, because telling it to
 * fetch what it is running downloads thirty megabytes and restarts the service
 * to arrive exactly where it started - which on a site with one camera means a
 * gap in the only recording anyone has.
 *
 * The reason is returned rather than a boolean because a greyed control with no
 * explanation invites the same click twice and then a question. Saying "already
 * running 0.1.1, the current build" answers it in place.
 */
export interface UpdatableAgent {
  online?: boolean;
  agentVersion?: string | null;
}

/**
 * @param currentVersion what an Update would install, or null when the control
 *   plane has not said. Null means unknown, not "not current": offering an
 *   update that may be unnecessary is better than hiding one that is needed.
 * @param asked whether this agent has already been told, since the rows on
 *   screen were loaded. See {@link askedRefusal}.
 */
export function updateRefusal(
  agent: UpdatableAgent,
  currentVersion: string | null,
  asked = false,
): string | null {
  // First, and ahead of every other reason. Once an agent has been told, this
  // page knows nothing about what happened next: the fields it is deciding
  // from describe the agent before the instruction, so "connected" and
  // "running 0.1.6" are both about to stop being true. Answering from them
  // would be answering from data that is known to be stale.
  if (asked) {
    return askedRefusal;
  }
  if (!agent.online) {
    return 'The agent must be connected to be told';
  }
  if (currentVersion !== null && !!agent.agentVersion && agent.agentVersion === currentVersion) {
    return `Already running ${currentVersion}, the current build`;
  }
  return null;
}

/**
 * Why a button is disabled after it has been clicked.
 *
 * An update takes tens of seconds: the agent fetches thirty megabytes, stages
 * the jar, exits, and the service manager restarts it. For all of that the row
 * on screen still says what it said before the click - connected, on the old
 * version - so the button would look as clickable as it did the first time.
 *
 * Clicking it again is not harmless. The second instruction arrives while the
 * first download is in flight or while the agent is restarting, and on a site
 * with one camera every restart is a gap in the only recording anyone has.
 *
 * So the button stays disabled until the rows are loaded again, which is the
 * first moment this page has anything new to decide from. It says to refresh
 * rather than merely going grey, because a greyed control with no explanation
 * invites the same question the tooltip exists to answer.
 */
export const askedRefusal = 'Asked to update — refresh to see whether it took';
