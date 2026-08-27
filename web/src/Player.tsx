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
export function Player({ src, muted = true, onUndecodable, onUnavailable }: PlayerProps) {
  const videoRef = useRef<HTMLVideoElement>(null);
  const [status, setStatus] = useState<'starting' | 'playing' | 'failed'>('starting');

  useEffect(() => {
    const video = videoRef.current;
    if (!video) return;
    setStatus('starting');

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
      manifestLoadingMaxRetry: 8,
      manifestLoadingRetryDelay: 1000,
      levelLoadingMaxRetry: 8,
      fragLoadingMaxRetry: 6,
    });

    let mediaRecoveries = 0;
    let settled = false;

    hls.on(Hls.Events.MANIFEST_PARSED, () => {
      video.play().catch(() => {
        /* autoplay refusal is not fatal; the poster stays until the user clicks */
      });
    });
    hls.on(Hls.Events.FRAG_BUFFERED, () => setStatus('playing'));

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
    return () => hls.destroy();
  }, [src, onUndecodable, onUnavailable]);

  return (
    <div className="player">
      <video ref={videoRef} muted={muted} playsInline controls={false} />
      {status !== 'playing' && (
        <div className="player-overlay">
          {status === 'starting' ? 'Starting stream…' : 'Unavailable'}
        </div>
      )}
    </div>
  );
}
