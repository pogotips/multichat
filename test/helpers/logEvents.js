// Filters a console.log spy's calls down to structured-log events matching
// `ev`. Skips unparseable lines by default (some tests log ordinary
// human-readable lines alongside structured JSON) rather than throwing —
// a helper that blows up on one bad log line is worse than the inline
// versions it replaces.
export function logEvents(spy, ev) {
  return spy.mock.calls
    .map((c) => {
      try {
        return JSON.parse(c[0]);
      } catch {
        return null;
      }
    })
    .filter((e) => e && e.ev === ev);
}
