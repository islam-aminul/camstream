/**
 * Whether this browser can decode what a camera emits.
 *
 * A deliberate mirror of infra/lambda/shared/playability.ts. The two are
 * separate builds and cannot share a module, and the rule has to hold on both
 * sides: the console decides what to offer, the control plane decides what to
 * publish, and a divergence shows up as a viewer being offered a rendition
 * that never arrives.
 *
 * The codec name alone does not answer the question. H.264 High 10 — which
 * some cameras emit by default and call plain "H.264" in their own web UI —
 * reports as h264 and is decoded by no browser at all.
 */

const UNPLAYABLE_H264_PROFILES = new Set([
  'high 10',
  'high 10 intra',
  'high 4:2:2',
  'high 4:2:2 intra',
  'high 4:4:4 predictive',
  'high 4:4:4 intra',
  'cavlc 4:4:4',
]);

export function isH264(codec: string | undefined): boolean {
  const value = (codec ?? 'h264').toLowerCase();
  return value === 'h264' || value === 'avc' || value === 'avc1';
}

/**
 * An unrecognised profile counts as playable: guessing the other way would
 * transcode streams that never needed it, on hardware that may have no
 * encoder to do it with.
 */
export function isUnplayableH264(codec: string | undefined, profile: string | undefined): boolean {
  return isH264(codec) && UNPLAYABLE_H264_PROFILES.has((profile ?? '').toLowerCase().trim());
}

export function canDecode(
  codec: string | undefined,
  profile: string | undefined,
  viewerCodecs: string[],
): boolean {
  if (isH264(codec)) return !isUnplayableH264(codec, profile);
  return viewerCodecs.map((c) => c.toLowerCase()).includes((codec ?? '').toLowerCase());
}

/**
 * Whether transcoding would produce something this viewer could play.
 *
 * The transcode target is 8-bit H.264, so it helps exactly when the viewer can
 * decode that and cannot decode the source.
 */
export function transcodeWouldHelp(
  codec: string | undefined,
  profile: string | undefined,
  viewerCodecs: string[],
): boolean {
  if (canDecode(codec, profile, viewerCodecs)) return false;
  return viewerCodecs.map((c) => c.toLowerCase()).includes('h264');
}

/**
 * Codec names probed against the browser, in the vocabulary the agent reports.
 *
 * ffprobe names are what the control plane compares against, so H.265 is
 * offered as both "hevc" and "h265" — the agent reports the former and some
 * cameras label themselves the latter, and being wrong here means transcoding
 * a stream the browser could have played natively.
 */
const PROBES: { name: string; mime: string }[] = [
  { name: 'h264', mime: 'video/mp4; codecs="avc1.42E01E"' },
  { name: 'hevc', mime: 'video/mp4; codecs="hvc1.1.6.L93.B0"' },
  { name: 'h265', mime: 'video/mp4; codecs="hvc1.1.6.L93.B0"' },
  { name: 'av1', mime: 'video/mp4; codecs="av01.0.05M.08"' },
  { name: 'vp9', mime: 'video/mp4; codecs="vp09.00.10.08"' },
];

/**
 * What this browser reports it can decode.
 *
 * Takes the predicate rather than reaching for MediaSource, so the answer can
 * be tested and so a browser without MSE degrades to the H.264 floor instead
 * of throwing on page load.
 */
export function probeCodecs(isTypeSupported?: (mime: string) => boolean): string[] {
  if (typeof isTypeSupported !== 'function') return ['h264'];
  const found = PROBES.filter((p) => {
    try {
      return isTypeSupported(p.mime);
    } catch {
      return false;
    }
  }).map((p) => p.name);
  // H.264 is the floor every player assumes; claiming less than it would ask
  // the edge to transcode H.264 into H.264.
  return found.includes('h264') ? found : ['h264', ...found];
}

/** The probe bound to this browser, or the floor where MSE is absent. */
export function browserCodecs(): string[] {
  const mse = typeof MediaSource !== 'undefined' ? MediaSource : undefined;
  return probeCodecs(mse ? (mime: string) => mse.isTypeSupported(mime) : undefined);
}
