import { useEffect, useMemo, useState, type ReactNode } from 'react';
import { Player } from './Player';
import { cameraKey, manifestFor, playsNatively, transcodeWouldHelp, type Camera, type DeclinedTranscode } from './api';

/**
 * How many cameras one page shows, and so how many streams a viewer causes.
 *
 * This is a cost control before it is a layout choice. Every tile on screen is
 * an ffmpeg process at the customer's edge and a steady trickle of S3 requests,
 * so a page is a screenful and never an estate. It also stays inside what the
 * control plane will accept from one viewer.
 */
export const PAGE_SIZES = [12, 24, 48] as const;

export type Status = 'all' | 'live' | 'offline' | 'attention';

interface Props {
  cameras: Camera[];
  transcoding: string[];
  undecodable: string[];
  unavailable: string[];
  queued: DeclinedTranscode[];
  onSelect: (camera: Camera) => void;
  onTranscode: (camera: Camera) => void;
  onUndecodable: (camera: Camera) => void;
  onUnavailable: (camera: Camera) => void;
  /** The page currently on screen, so demand can follow it. */
  onVisible: (keys: string[]) => void;
  /** The premises and agent selectors, rendered into the toolbar. */
  picker: ReactNode;
}

/** Whether a camera needs an operator to look at it rather than just watch it. */
function needsAttention(camera: Camera, undecodable: string[], unavailable: string[], transcoding: string[]) {
  if (!camera.online) return false;
  if (unavailable.includes(camera.cameraId)) return true;
  if (undecodable.includes(camera.cameraId)) return true;
  return !playsNatively(camera) && !transcoding.includes(camera.cameraId);
}

export function CameraGrid({
  cameras, transcoding, undecodable, unavailable, queued,
  onSelect, onTranscode, onUndecodable, onUnavailable, onVisible, picker,
}: Props) {
  const [query, setQuery] = useState('');
  const [status, setStatus] = useState<Status>('all');
  const [pageSize, setPageSize] = useState<number>(24);
  const [page, setPage] = useState(0);

  const matching = useMemo(() => {
    const needle = query.trim().toLowerCase();
    const filtered = cameras.filter((camera) => {
      if (status === 'live' && !camera.online) return false;
      if (status === 'offline' && camera.online) return false;
      if (status === 'attention'
          && !needsAttention(camera, undecodable, unavailable, transcoding)) return false;
      if (!needle) return true;
      // Searching the id and the site too: an operator chasing a fault has the
      // camera's identifier or the building's name, rarely its display name.
      return [camera.displayName, camera.cameraId, camera.siteName, camera.premisesId]
        .some((field) => field?.toLowerCase().includes(needle));
    });

    // Working cameras first, then by where they are, then by name.
    //
    // Online-first matters more than it looks: a site with a handful of live
    // cameras among a hundred decommissioned ones would otherwise open on a
    // wall of dead tiles, with the pictures somebody actually came to watch
    // several pages in. Location still orders the rest, because "Lobby" exists
    // at every site and a name alone does not say which one this is.
    return filtered.sort((a, b) =>
      Number(b.online) - Number(a.online)
      || (a.siteName ?? a.thingName).localeCompare(b.siteName ?? b.thingName)
      || a.displayName.localeCompare(b.displayName));
  }, [cameras, query, status, undecodable, unavailable, transcoding]);

  const pages = Math.max(1, Math.ceil(matching.length / pageSize));
  const current = Math.min(page, pages - 1);
  const shown = matching.slice(current * pageSize, current * pageSize + pageSize);

  // Narrowing the set should put you at the start of it, not on page nine of
  // a list that no longer has nine pages.
  useEffect(() => { setPage(0); }, [query, status, pageSize, cameras.length]);

  // Demand follows exactly what is rendered. The join is a cheap way to avoid
  // re-announcing on every render when the page has not actually changed.
  const keys = shown.map(cameraKey);
  const signature = keys.join(',');
  useEffect(() => { onVisible(signature ? signature.split(',') : []); }, [signature, onVisible]);

  const counts = useMemo(() => ({
    all: cameras.length,
    live: cameras.filter((c) => c.online).length,
    offline: cameras.filter((c) => !c.online).length,
    attention: cameras.filter((c) => needsAttention(c, undecodable, unavailable, transcoding)).length,
  }), [cameras, undecodable, unavailable, transcoding]);

  const tileMin = pageSize === 12 ? 380 : pageSize === 24 ? 280 : 200;

  return (
    <>
      <div className="toolbar">
        {picker}

        <div className="search">
          <svg className="search-icon" viewBox="0 0 16 16" width="14" height="14" aria-hidden="true">
            <circle cx="7" cy="7" r="4.5" fill="none" stroke="currentColor" strokeWidth="1.5" />
            <path d="M10.5 10.5 L14 14" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
          </svg>
          <input
            type="search"
            value={query}
            placeholder="Search cameras, sites…"
            onChange={(e) => setQuery(e.target.value)}
            aria-label="Search cameras"
          />
        </div>

        <div className="chips" role="group" aria-label="Filter by status">
          {([
            ['all', 'All'], ['live', 'Online'], ['offline', 'Offline'], ['attention', 'Needs attention'],
          ] as [Status, string][]).map(([key, label]) => (
            <button
              key={key}
              type="button"
              className={`chip${status === key ? ' on' : ''}`}
              aria-pressed={status === key}
              onClick={() => setStatus(key)}
            >
              {label}<span className="chip-count">{counts[key]}</span>
            </button>
          ))}
        </div>

        <span className="topbar-spacer" />

        <div className="density" role="group" aria-label="Tiles per page">
          {PAGE_SIZES.map((size) => (
            <button
              key={size}
              type="button"
              className={pageSize === size ? 'on' : ''}
              aria-pressed={pageSize === size}
              onClick={() => setPageSize(size)}
            >
              {size}
            </button>
          ))}
        </div>

        <span className="toolbar-count">
          {matching.length === 0
            ? 'nothing to show'
            : `${current * pageSize + 1}–${current * pageSize + shown.length} of ${matching.length}`}
        </span>

        {pages > 1 && (
          <div className="row tight">
            <button className="btn small" disabled={current === 0} onClick={() => setPage(current - 1)}>‹</button>
            <span className="toolbar-count">{current + 1}/{pages}</span>
            <button className="btn small" disabled={current >= pages - 1} onClick={() => setPage(current + 1)}>›</button>
          </div>
        )}
      </div>

      <div className="grid" style={{ ['--tile-min' as string]: `${tileMin}px` }}>
        {matching.length === 0 && (
          <div className="empty">
            <strong>No cameras match</strong>
            {cameras.length === 0
              ? 'Nothing is reporting in yet.'
              : 'Try a different search, or clear the filters.'}
          </div>
        )}

        {shown.map((camera) => {
          const isQueued = queued.find((q) => q.cameraId === camera.cameraId);
          const isTranscoding = transcoding.includes(camera.cameraId);
          const decodes = (playsNatively(camera) && !undecodable.includes(camera.cameraId)) || isTranscoding;
          const playable = camera.online && decodes && !isQueued && !unavailable.includes(camera.cameraId);

          return (
            <button
              key={cameraKey(camera)}
              type="button"
              className="tile"
              disabled={!playable}
              onClick={() => playable && onSelect(camera)}
            >
              <div className="tile-media">
                {!camera.online ? (
                  <div className="player-overlay offline-tile">
                    <CameraGlyph />
                    <span>Offline</span>
                  </div>
                ) : isQueued ? (
                  <TranscodeQueued limit={isQueued.limit} />
                ) : unavailable.includes(camera.cameraId) ? (
                  <div className="player-overlay unplayable">
                    <span>Not being published</span>
                    <small>
                      The agent is connected but this camera is not streaming — it may be
                      unreachable or refusing connections.
                    </small>
                  </div>
                ) : decodes ? (
                  <>
                    <span className="live-badge"><span className="dot" />Live</span>
                    <Player
                      src={manifestFor(camera, 'sub', isTranscoding)}
                      showDelay
                      onUndecodable={() => onUndecodable(camera)}
                      onUnavailable={() => onUnavailable(camera)}
                    />
                  </>
                ) : (
                  <Unplayable camera={camera} onTranscode={() => onTranscode(camera)} />
                )}
              </div>

              <div className="tile-bar">
                <span className={`dot ${camera.online ? 'ok' : 'off'}`} />
                <span className="tile-name">{camera.displayName}</span>
                {isTranscoding && <span className="badge accent">transcoded</span>}
                {/* Where it is, not how big it is: every camera on a site tends
                    to report the same resolution, and "Lobby" exists at all of
                    them — so location is what actually distinguishes tiles. */}
                <span className="tile-sub">{camera.siteName || camera.resolution}</span>
              </div>
            </button>
          );
        })}
      </div>
    </>
  );
}

/**
 * Offered rather than applied.
 *
 * Transcoding runs on the customer's own hardware and costs CPU there, so a
 * browser's limitations are surfaced as a choice with its price stated.
 */
export function Unplayable({ camera, onTranscode }: { camera: Camera; onTranscode: () => void }) {
  const possible = transcodeWouldHelp(camera);
  // Naming the profile matters when it is the profile that is unplayable:
  // "cannot play H264" reads as nonsense to someone whose browser plays H.264
  // perfectly well, and hides that the camera is set to a 10-bit mode.
  const format = [
    (camera.sourceCodec ?? '').toUpperCase(),
    camera.sourceCodecProfile ? `(${camera.sourceCodecProfile})` : '',
  ].filter(Boolean).join(' ');

  return (
    <div className="player-overlay unplayable">
      <span>This browser cannot play {format}</span>
      {possible ? (
        <>
          <button
            type="button"
            className="btn small"
            onClick={(e) => { e.stopPropagation(); onTranscode(); }}
          >
            Transcode on the agent
          </button>
          <small>Converts to H.264 on the recorder. Uses CPU at the site.</small>
        </>
      ) : (
        <small>No other rendition would help — try Safari or Chrome.</small>
      )}
    </div>
  );
}

/**
 * The site is already transcoding as much as it is allowed to.
 *
 * Said plainly, with the limit and where it is changed, because the viewer
 * cannot act on this themselves and the alternative — a stream that never
 * arrives — sends them looking for a fault that is not there.
 */
export function TranscodeQueued({ limit }: { limit: number }) {
  return (
    <div className="player-overlay unplayable">
      <span>Waiting for a transcoding slot</span>
      <small>
        {limit === 0
          ? 'This site is set not to transcode. An administrator can allow it.'
          : `This site transcodes ${limit} camera${limit === 1 ? '' : 's'} at a time, and `
            + `${limit === 1 ? 'that slot is' : 'those slots are'} in use. Close another `
            + 'transcoded camera, or ask an administrator to raise the limit.'}
      </small>
    </div>
  );
}

/** A camera outline, so an offline tile still reads as a camera. */
function CameraGlyph() {
  return (
    <svg viewBox="0 0 24 24" width="26" height="26" aria-hidden="true" fill="none"
         stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round">
      <path d="M2.5 7.5h11v9h-11z" />
      <path d="M13.5 11l5-3v8l-5-3z" />
      <circle cx="8" cy="12" r="2.2" />
    </svg>
  );
}
