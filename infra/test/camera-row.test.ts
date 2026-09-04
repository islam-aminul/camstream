import { describe, it, expect } from 'vitest';
import { cameraRow } from '../lambda/admin/index';

/**
 * A camera's codec comes from the agent, not from the approval.
 *
 * The two records hold different things. The approved record is what an
 * operator decided: a name, an agent, when it entered service. The live record
 * is what the agent found once a stream actually ran - ffprobe reports the
 * codec, its profile and the frame size, and this is the only place any of that
 * is written.
 *
 * The listing read the codec from the approved record, which carries one only
 * if it was known at approval time. At approval nothing has looked at the
 * stream yet, so it never is. The console showed an empty Codec column for
 * every camera, always, and would have kept doing so indefinitely - there is no
 * later write that would ever fill it in.
 *
 * Found by looking at a real record rather than the code: the live record for
 * a publishing camera said `h264`/`high` while the console said nothing, and
 * the listing was already fetching that record to decide whether the camera was
 * publishing at all.
 */
const approved = {
  identity: 'mac-2818fdf1e5be',
  cameraId: 'mac-2818fdf1e5be',
  displayName: 'Front Gate',
  assignedTo: 'acme-ltd--hq-north--gate-house',
  approvedAt: 1_788_403_112,
  approvedBy: 'someone@example.com',
} as never;

describe('a camera row', () => {
  it('takes the codec the agent reported', () => {
    const row = cameraRow(approved, { sourceCodec: 'h264', sourceCodecProfile: 'high' });
    expect(row.sourceCodec).toBe('h264');
  });

  it('says nothing when no agent has reported one', () => {
    // Distinct from "not h264". A camera nobody has watched has no known
    // codec, and inventing one would be worse than the empty column.
    expect(cameraRow(approved, undefined).sourceCodec).toBeNull();
    expect(cameraRow(approved, {}).sourceCodec).toBeNull();
  });

  it('lets an explicitly approved codec win', () => {
    // An operator who set one meant it, and should not be overruled by
    // whatever a particular stream happened to report.
    const pinned = { ...approved, sourceCodec: 'hevc' } as never;
    expect(cameraRow(pinned, { sourceCodec: 'h264' }).sourceCodec).toBe('hevc');
  });

  it('ignores a codec that is not a string', () => {
    // The live record is agent-supplied and typed as unknown here. Anything
    // unexpected has to become absent rather than reach the console as a value
    // it would render as though a camera had reported it.
    expect(cameraRow(approved, { sourceCodec: 42 }).sourceCodec).toBeNull();
    expect(cameraRow(approved, { sourceCodec: '' }).sourceCodec).toBeNull();
    expect(cameraRow(approved, { sourceCodec: null }).sourceCodec).toBeNull();
  });

  it('is publishing exactly when a live record exists', () => {
    expect(cameraRow(approved, { sourceCodec: 'h264' }).publishing).toBe(true);
    expect(cameraRow(approved, undefined).publishing).toBe(false);
    // An empty live record still means an agent is reporting this camera.
    expect(cameraRow(approved, {}).publishing).toBe(true);
  });
});
