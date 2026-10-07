// A missing session is an orphan, not a reason to block uploads for other sessions.
export async function drainSegments(segments, { inflight, upload, deleteSegment, onUploaded, onOrphan }) {
  let failed = false;
  for (const seg of segments) {
    if (inflight.has(seg.key)) continue;
    inflight.add(seg.key);
    try {
      const res = await upload(seg);
      if (res.ok) {
        await deleteSegment(seg.key);
        onUploaded(seg);
      } else if (res.status === 404) {
        onOrphan(seg);
        failed = true;
        continue;
      } else {
        failed = true;
        break;
      }
    } catch {
      failed = true;
      break;
    } finally {
      inflight.delete(seg.key);
    }
  }
  return failed;
}
