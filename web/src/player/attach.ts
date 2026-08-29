import Hls from 'hls.js';

/**
 * Puts an HLS stream into a <video>, and keeps it there.
 *
 * The awkward part is not playing a manifest — it is that the manifest usually
 * does not exist yet. Asking for a camera is what causes the agent to start
 * publishing it, so the first several requests legitimately 404 and the player
 * must wait rather than give up. hls.js treats a missing manifest as a fatal
 * network error after its own short retry budget, which is correct for a video
 * on a page and wrong for a stream being spun up on demand.
 *
 * Safari plays HLS natively and hls.js refuses to run there; the element is
 * given the URL directly in that case.
 */
export interface Attachment {
  destroy(): void;
}

export interface AttachOptions {
  /** Called the first time a frame is actually available. */
  onPlaying?: () => void;
  /** Called when the stream has failed in a way retrying will not fix. */
  onFatal?: (message: string) => void;
}

/**
 * How long to keep retrying a manifest that is not there yet.
 *
 * Long enough for an agent to be told, start ffmpeg, and publish a first
 * segment — which at a four-second segment length is a handful of seconds,
 * more on a busy site.
 */
const STARTUP_GRACE_MS = 90_000;

export function attach(video: HTMLVideoElement, url: string, options: AttachOptions = {}): Attachment {
  let stopped = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const startedAt = Date.now();

  const onPlaying = () => options.onPlaying?.();
  video.addEventListener('playing', onPlaying);

  if (!Hls.isSupported()) {
    // Safari and iOS: native HLS, no MSE needed.
    video.src = url;
    void video.play().catch(() => {
      // Autoplay refusal is not a stream failure; the element stays muted and
      // the user can start it.
    });
    return {
      destroy() {
        stopped = true;
        video.removeEventListener('playing', onPlaying);
        video.removeAttribute('src');
        video.load();
      },
    };
  }

  const hls = new Hls({
    // A live wall is worth being close to the edge for, but not at the cost of
    // stalling on every hiccup: two segments of buffer at four seconds each.
    liveSyncDurationCount: 2,
    // Segments are small and frequent; a long back-buffer is memory spent on
    // footage nobody is going to scrub back through in a grid.
    backBufferLength: 30,
    enableWorker: true,
    lowLatencyMode: false,
  });

  hls.on(Hls.Events.ERROR, (_event, data) => {
    if (stopped || !data.fatal) return;

    const startingUp = Date.now() - startedAt < STARTUP_GRACE_MS;
    if (data.type === Hls.ErrorTypes.NETWORK_ERROR) {
      if (startingUp) {
        // The usual case: the agent has been asked and has not published yet.
        timer = setTimeout(() => { if (!stopped) hls.loadSource(url); }, 2000);
        return;
      }
      options.onFatal?.('The stream stopped responding.');
      return;
    }
    if (data.type === Hls.ErrorTypes.MEDIA_ERROR) {
      // Usually a decoder hiccup at a discontinuity, and usually recoverable.
      hls.recoverMediaError();
      return;
    }
    options.onFatal?.('This stream could not be played.');
  });

  hls.loadSource(url);
  hls.attachMedia(video);

  return {
    destroy() {
      stopped = true;
      if (timer) clearTimeout(timer);
      video.removeEventListener('playing', onPlaying);
      hls.destroy();
    },
  };
}
