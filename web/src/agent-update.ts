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
 */
export function updateRefusal(
  agent: UpdatableAgent,
  currentVersion: string | null,
): string | null {
  if (!agent.online) {
    return 'The agent must be connected to be told';
  }
  if (currentVersion !== null && !!agent.agentVersion && agent.agentVersion === currentVersion) {
    return `Already running ${currentVersion}, the current build`;
  }
  return null;
}
