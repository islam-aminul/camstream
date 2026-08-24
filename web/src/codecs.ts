/**
 * What this browser can actually decode, probed rather than assumed.
 *
 * The answer drives real cost on the edge: a viewer that reports HEVC support
 * takes the camera's own bytes, and only one that cannot causes an agent to
 * spin up an encoder. Guessing from the user-agent would either transcode
 * needlessly or hand someone a stream they cannot play.
 */

/** Probe strings are the codec's fMP4 sample-entry form, not the container. */
const PROBES: Record<string, string[]> = {
  h264: ['video/mp4; codecs="avc1.42E01E"'],
  // hvc1 and hev1 differ in where parameter sets live; browsers vary, and
  // supporting either is enough to play the stream.
  hevc: ['video/mp4; codecs="hvc1.1.6.L93.B0"', 'video/mp4; codecs="hev1.1.6.L93.B0"'],
  av1: ['video/mp4; codecs="av01.0.05M.08"'],
  vp9: ['video/mp4; codecs="vp09.00.10.08"'],
};

let cached: string[] | undefined;

function canPlay(mimeTypes: string[]): boolean {
  return mimeTypes.some((type) => {
    // MSE is what hls.js uses everywhere except Safari.
    if (typeof MediaSource !== 'undefined' && MediaSource.isTypeSupported?.(type)) {
      return true;
    }
    // Safari plays HLS natively without MSE, so fall back to the element's own
    // opinion — "probably" or "maybe" both mean it will try.
    const probe = document.createElement('video').canPlayType(type);
    return probe === 'probably' || probe === 'maybe';
  });
}

/** Codec names the agent understands, e.g. ["h264","hevc"]. */
export function supportedCodecs(): string[] {
  if (cached) return cached;
  const supported = Object.entries(PROBES)
    .filter(([, types]) => canPlay(types))
    .map(([name]) => name);
  // H.264 is the universal floor; if probing somehow finds nothing, claiming it
  // is safer than claiming nothing and having every camera transcoded.
  cached = supported.length > 0 ? supported : ['h264'];
  return cached;
}

export function supports(codec: string): boolean {
  return supportedCodecs().includes(codec.toLowerCase());
}
