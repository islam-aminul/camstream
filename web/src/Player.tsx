import { useEffect, useRef, useState } from 'react';
import Hls from 'hls.js';

interface PlayerProps {
  src: string;
  muted?: boolean;
  /**
   * The browser accepted the codec when asked but could not actually decode it.
   *
   * Firefox on Windows reports HEVC as supported through Media Foundation and
   * then fails at playback, so capability probing is a hint and playback is the
   * authority. This lets the caller offer a transcode instead of spinning.
   */
  onUndecodable?: () => void;
  /** The stream is not being published — distinct from being unplayable. */
  onUnavailable?: () => void;
  /**
   * Start on the highest rendition rather than climbing to it.
   *
   * Adaptive bitrate begins low by default, which is right for a grid of
   * thumbnails but wrong for a camera someone has deliberately opened: they
   * asked for the detail view, so they should get the detail. ABR can still
   * drop if the connection cannot sustain it.
   */
  preferHighest?: boolean;
}

/** Codec failures are worth reacting to; a missing segment is not. */
function isCodecFailure(details: string): boolean {
  return (
    details === Hls.ErrorDetails.BUFFER_ADD_CODEC_ERROR ||
    details === Hls.ErrorDetails.MANIFEST_INCOMPATIBLE_CODECS_ERROR ||
    details === Hls.ErrorDetails.FRAG_PARSING_ERROR ||
    details === Hls.ErrorDetails.BUFFER_INCOMPATIBLE_CODECS_ERROR
  );
}

/**
 * HLS playback.
 *
 * A stream is published on demand, so the manifest legitimately 404s for the
 * first few seconds after a viewer opens a camera. Those early errors are
 * retried — but not forever: a manifest that never appears means the agent is
 * not publishing, which is a different problem from one that is slow to start,
 * and saying "starting" indefinitely hides it.
 */
export function Player({ src, muted = true, onUndecodable, onUnavailable, preferHighest }: PlayerProps) {
  const videoRef = useRef<HTMLVideoElement>(null);
  const [status, setStatus] = useState<'starting' | 'playing' | 'failed'>('starting');
  // Distinguishing "waiting for the agent" from "have data, decoding" tells a
  // viewer which of the two slow things is happening.
  const [buffering, setBuffering] = useState(false);

  useEffect(() => {
    const video = videoRef.current;
    if (!video) return;
    setStatus('starting');
    setBuffering(false);

    // Safari plays HLS natively and does it with lower overhead than MSE.
    if (!Hls.isSupported()) {
      if (video.canPlayType('application/vnd.apple.mpegurl')) {
        video.src = src;
        const onPlaying = () => setStatus('playing');
        const onError = () => { setStatus('failed'); onUndecodable?.(); };
        video.addEventListener('playing', onPlaying);
        video.addEventListener('error', onError);
        return () => {
          video.removeEventListener('playing', onPlaying);
          video.removeEventListener('error', onError);
        };
      }
      setStatus('failed');
      onUndecodable?.();
      return;
    }

    const hls = new Hls({
      // Sit close to the live edge. Two segments of buffer is the practical
      // floor before stalls outweigh the latency saved.
      liveSyncDurationCount: 2,
      liveMaxLatencyDurationCount: 6,
      lowLatencyMode: false,
      backBufferLength: 10,
      // Nothing exists until the agent is told to publish, and that takes as
      // long as connecting to the camera, filling one segment and uploading
      // it — comfortably over ten seconds on a cold start. Too small a budget
      // reports a healthy camera as absent.
      manifestLoadingMaxRetry: 20,
      manifestLoadingRetryDelay: 1000,
      manifestLoadingMaxRetryTimeout: 4000,
      levelLoadingMaxRetry: 20,
      levelLoadingRetryDelay: 1000,
      fragLoadingMaxRetry: 6,
    });

    let mediaRecoveries = 0;
    let settled = false;

    /**
     * Some browsers accept a codec, load the metadata and then never decode a
     * frame, reporting no error at all. Catching that needs care, because two
     * innocent situations look identical from the outside: segments that have
     * not arrived yet, and autoplay the browser declined to start.
     *
     * So this only fires once data has actually been buffered and the element
     * is genuinely trying to play. Buffered media that a playing element
     * refuses to advance through is a decoder problem; anything else is not.
     */
    let stallTimer: ReturnType<typeof setTimeout> | undefined;
    let buffered = false;
    const armStallWatchdog = () => {
      clearTimeout(stallTimer);
      stallTimer = setTimeout(() => {
        if (settled || video.currentTime > 0) {
          return;
        }
        if (!buffered || video.paused || video.readyState < 2) {
          // Nothing to decode yet, or nobody asked it to — keep waiting.
          armStallWatchdog();
          return;
        }
        settled = true;
        setStatus('failed');
        hls.destroy();
        onUndecodable?.();
      }, 12000);
    };

    hls.on(Hls.Events.MANIFEST_PARSED, () => {
      // Segments exist from here on, so anything after this is decoding.
      armStallWatchdog();
      if (preferHighest && hls.levels.length > 1) {
        hls.startLevel = hls.levels.length - 1;
        hls.nextLevel = hls.levels.length - 1;
      }
      video.play().catch(() => {
        /* autoplay refusal is not fatal; the poster stays until the user clicks */
      });
    });
    hls.on(Hls.Events.FRAG_BUFFERED, () => {
      buffered = true;
      setBuffering(true);
      if (video.currentTime > 0) {
        clearTimeout(stallTimer);
        setStatus('playing');
      }
    });

    hls.on(Hls.Events.ERROR, (_event, data) => {
      // A browser can accept a codec and still fail to decode it, and that
      // shows up here rather than in isTypeSupported.
      if (isCodecFailure(data.details) && !settled) {
        settled = true;
        setStatus('failed');
        hls.destroy();
        onUndecodable?.();
        return;
      }
      if (!data.fatal) return;

      switch (data.type) {
        case Hls.ErrorTypes.NETWORK_ERROR:
          if (data.details === Hls.ErrorDetails.MANIFEST_LOAD_ERROR
              || data.details === Hls.ErrorDetails.MANIFEST_LOAD_TIMEOUT) {
            // The retries are exhausted: nothing is being published here.
            if (!settled) {
              settled = true;
              setStatus('failed');
              hls.destroy();
              onUnavailable?.();
            }
            return;
          }
          hls.startLoad();
          break;
        case Hls.ErrorTypes.MEDIA_ERROR:
          // One recovery attempt; a second failure means the decoder cannot
          // handle this stream rather than that it hiccupped.
          if (mediaRecoveries === 0) {
            mediaRecoveries += 1;
            hls.recoverMediaError();
          } else if (!settled) {
            settled = true;
            setStatus('failed');
            hls.destroy();
            onUndecodable?.();
          }
          break;
        default:
          if (!settled) {
            settled = true;
            setStatus('failed');
            hls.destroy();
            onUnavailable?.();
          }
      }
    });

    hls.loadSource(src);
    hls.attachMedia(video);
    return () => {
      clearTimeout(stallTimer);
      hls.destroy();
    };
  }, [src, onUndecodable, onUnavailable, preferHighest]);

  return (
    <div className="player">
      <video ref={videoRef} muted={muted} playsInline controls={false} />
      {status !== 'playing' && (
        <div className="player-overlay">
          {status === 'failed'
            ? 'Unavailable'
            : buffering
              ? 'Buffering…'
              : 'Starting stream…'}
        </div>
      )}
    </div>
  );
}
