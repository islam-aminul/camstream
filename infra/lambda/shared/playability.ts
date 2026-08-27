/**
 * Whether a browser can decode what a camera emits.
 *
 * The codec name alone does not answer this. H.264 High 10 — a 10-bit profile
 * some cameras emit by default, and which their own web UI simply calls
 * "H.264" — reports `codec_name: h264` and is decoded by no browser at all.
 * Treating the name as the answer meant such a camera was served its own
 * bytes, played nothing, and was then told no other rendition would help.
 *
 * The web client mirrors this rule. It is duplicated rather than shared
 * because the two are separate builds, and a divergence between them shows up
 * as a viewer being offered a rendition the control plane will not publish.
 */

/**
 * H.264 profiles that carry the codec name but no browser support: the 10-bit
 * and higher-chroma variants. Everything else — Baseline, Main, High — is
 * decoded universally.
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
 * An H.264 stream a browser will refuse.
 *
 * An unrecognised profile counts as playable: guessing the other way would
 * transcode streams that never needed it, on edge hardware that may have no
 * encoder to do it with.
 */
export function isUnplayableH264(codec: string | undefined, profile: string | undefined): boolean {
  return isH264(codec) && UNPLAYABLE_H264_PROFILES.has((profile ?? '').toLowerCase().trim());
}

/**
 * Whether this viewer can decode the camera's own stream.
 *
 * Ordinary H.264 is the universal floor and needs no probing. Anything else
 * has to be in the list the viewer reported — and an exotic H.264 profile is
 * in nobody's list, however much its codec name looks like the floor.
 */
export function canDecode(
  codec: string | undefined,
  profile: string | undefined,
  viewerCodecs: string[],
): boolean {
  if (isH264(codec)) {
    return !isUnplayableH264(codec, profile);
  }
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
  if (canDecode(codec, profile, viewerCodecs)) {
    return false;
  }
  return viewerCodecs.map((c) => c.toLowerCase()).includes('h264');
}
