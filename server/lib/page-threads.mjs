/**
 * What `/api/threads` hands the page.
 *
 * Archived threads are most of any real store — 76 of 85 on one machine, 219 of 266 on
 * another — and the map draws none of them. Sending them whole every poll was most of the
 * response. But the page does need *some* of them: the ones archived here are what its
 * un-archive list offers back, and restoring one has to clear every id the server matched it
 * on (`archivedAs`). So those are sent as a stub carrying exactly that, and nothing else —
 * a few hundred bytes each, where a whole thread is over a kilobyte.
 *
 * Threads archived in their harness's own app are not sent at all. The colony never writes a
 * harness, so it has nothing to offer back for them.
 */

/** The fields the page's archive list and un-archive need. */
function stub(thread) {
  return {
    id: thread.id,
    harness: thread.harness,
    project: thread.project,
    title: thread.title,
    lastActivityAt: thread.lastActivityAt,
    archived: true,
    archivedInHarness: false,
    archivedAs: thread.archivedAs,
  }
}

/** Live threads whole, the colony's own archives as stubs, harness archives not at all. */
export function threadsForPage(threads) {
  const out = []
  for (const t of threads) {
    if (!t.archived) out.push(t)
    else if (t.archivedInHarness === false) out.push(stub(t))
  }
  return out
}
