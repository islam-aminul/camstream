import { useEffect, useRef, useState } from 'react';
import Hls from 'hls.js';

interface PlayerProps {
  src: string;
  muted?: boolean;
  onError?: (message: string) => void;
}

/**
 * HLS playback.
 *
 * A stream is published on demand, so the manifest legitimately 404s for the
 * first few seconds after a viewer opens a camera. Those early errors are
 * retried rather than surfaced.
 */
export function Player({ src, muted = true, onError }: PlayerProps) {
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
        video.addEventListener('playing', onPlaying);
        return () => video.removeEventListener('playing', onPlaying);
      }
      setStatus('failed');
      onError?.('This browser cannot play HLS');
      return;
    }

    const hls = new Hls({
      // Sit close to the live edge. Two segments of buffer is the practical
      // floor before stalls outweigh the latency saved.
      liveSyncDurationCount: 2,
      liveMaxLatencyDurationCount: 6,
      lowLatencyMode: false,
      backBufferLength: 10,
      manifestLoadingMaxRetry: 20,
      manifestLoadingRetryDelay: 1000,
      levelLoadingMaxRetry: 20,
      fragLoadingMaxRetry: 6,
    });

    hls.on(Hls.Events.MANIFEST_PARSED, () => {
      video.play().catch(() => {
        /* autoplay refusal is not fatal; the poster stays until the user clicks */
      });
    });
    hls.on(Hls.Events.FRAG_BUFFERED, () => setStatus('playing'));

    hls.on(Hls.Events.ERROR, (_event, data) => {
      if (!data.fatal) return;
      switch (data.type) {
        case Hls.ErrorTypes.NETWORK_ERROR:
          // Covers both the not-yet-published window and transient CDN blips.
          hls.startLoad();
          break;
        case Hls.ErrorTypes.MEDIA_ERROR:
          hls.recoverMediaError();
          break;
        default:
          setStatus('failed');
          onError?.(data.details ?? 'Playback failed');
          hls.destroy();
      }
    });

    hls.loadSource(src);
    hls.attachMedia(video);
    return () => hls.destroy();
  }, [src, onError]);

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
