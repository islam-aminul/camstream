import { canDecode, transcodeWouldHelp } from './playability';

/**
 * What one tile is doing, and what to tell the person looking at it.
 *
 * A tile that shows nothing is the most common thing an operator will ever
 * see, and the reasons are entirely different from each other: the agent is
 * offline, the stream has been asked for and has not started yet, the browser
 * cannot decode this camera, or the agent has run out of the CPU to transcode
 * it. All four look like a black rectangle unless the rectangle says otherwise.
 *
 * Pure, and tested, because these messages are the product: an operator who is
 * told "agent is already transcoding 2 of 2 streams" can act, and one shown a
 * spinner forever cannot.
 */
export type TileStatus =
  | 'live'
  | 'starting'
  | 'offline'
  | 'unreported'
  | 'undecodable'
  | 'declined'
  | 'capacity';

export interface TileView {
  status: TileStatus;
  message: string;
  /** Whether to offer the "transcode this one" action. */
  offerTranscode: boolean;
}

export interface TileInput {
  /**
   * Whether the agent has ever reported this camera.
   *
   * A camera can be registered and never seen: added to an agent that has not
   * probed it yet, or one whose credentials are wrong. It has no manifest and
   * no reported codec, so there is nothing to play and nothing to diagnose
   * from — but it must still appear, or an operator watching for a camera that
   * will never arrive has nothing on screen to explain the absence.
   */
  reported: boolean;
  /** Whether the agent publishing this camera is connected. */
  agentOnline: boolean;
  sourceCodec: string;
  sourceCodecProfile: string | null;
  /** Codecs this browser reported. */
  viewerCodecs: string[];
  /** Whether the viewer has asked the agent to transcode this camera. */
  transcodeRequested: boolean;
  /** Whether the control plane has asked the agent for this rendition. */
  demanded: boolean;
  /** Whether the agent refused it for want of a transcode slot. */
  declined: boolean;
  /** The agent's concurrent transcode cap, when it said. */
  maxConcurrentTranscodes?: number;
  /** Whether the player has actually rendered a frame. */
  playing: boolean;
  /** Streams this agent is already publishing, against its ceiling. */
  agentStreams?: number;
  agentStreamCeiling?: number;
}

/**
 * The most streams one agent will carry.
 *
 * A hard ceiling, and not the real limit: what an agent can actually sustain
 * depends on its CPU, memory, disk and uplink, and it will run out of those
 * long before it runs out of this. The number exists so the console can refuse
 * clearly rather than let an operator discover the limit as stuttering video.
 */
export const AGENT_STREAM_CEILING = 128;

export function tileView(input: TileInput): TileView {
  if (!input.reported) {
    return {
      status: 'unreported',
      message: 'Registered, but its agent has not reported it yet. '
        + 'Check the camera is reachable and its credentials are right.',
      offerTranscode: false,
    };
  }

  if (!input.agentOnline) {
    return {
      status: 'offline',
      message: 'Its agent is not connected. Nothing can be streamed from this site until it is.',
      offerTranscode: false,
    };
  }

  const playable = canDecode(input.sourceCodec, input.sourceCodecProfile ?? undefined, input.viewerCodecs);

  if (!playable && !input.transcodeRequested) {
    const helps = transcodeWouldHelp(
      input.sourceCodec, input.sourceCodecProfile ?? undefined, input.viewerCodecs);
    const what = describeSource(input.sourceCodec, input.sourceCodecProfile);
    return {
      status: 'undecodable',
      message: helps
        ? `This browser cannot play ${what}. The agent can convert it, using CPU at the site.`
        : `This browser cannot play ${what}, and converting it would not help.`,
      offerTranscode: helps,
    };
  }

  if (input.declined) {
    const cap = input.maxConcurrentTranscodes;
    return {
      status: 'declined',
      message: cap === undefined
        ? 'The agent has no spare capacity to convert this stream. Close another converted camera to free it.'
        : `The agent converts ${cap} stream${cap === 1 ? '' : 's'} at a time and is already at that limit. `
          + 'Close another converted camera to free a slot.',
      offerTranscode: false,
    };
  }

  if (input.agentStreams !== undefined
      && input.agentStreams >= (input.agentStreamCeiling ?? AGENT_STREAM_CEILING)) {
    return {
      status: 'capacity',
      message: `This agent is at its ceiling of ${input.agentStreamCeiling ?? AGENT_STREAM_CEILING} `
        + 'streams. Split the cameras across another agent at this site.',
      offerTranscode: false,
    };
  }

  if (input.playing) {
    return { status: 'live', message: '', offerTranscode: false };
  }

  return {
    status: 'starting',
    message: input.demanded
      ? 'Starting — the agent is being asked for this stream.'
      : 'Waiting for the site to acknowledge this camera.',
    offerTranscode: false,
  };
}

/** Names a source in terms an operator would recognise from the camera's own UI. */
function describeSource(codec: string, profile: string | null): string {
  const name = codec.toLowerCase() === 'hevc' ? 'H.265'
    : codec.toLowerCase() === 'h264' ? 'H.264'
      : codec.toUpperCase();
  return profile ? `${name} ${profile}` : name;
}
