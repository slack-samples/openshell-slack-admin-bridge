// Shared Slack text helpers used by both the approval UI and the audit feed.

// Slack text limits: section/context text 3000, header 150. Callers pass the
// limit; the tail is replaced with a single-character ellipsis so the result is
// never longer than `n`.
export function truncate(s: string, n: number): string {
  if (!s) return s;
  return s.length <= n ? s : `${s.slice(0, n - 1)}…`;
}

// Escape the three characters Slack treats specially in message text so that an
// untrusted value cannot inject a link, a <@mention>, or a <!channel> broadcast.
// This is exactly Slack's own guidance (escape &, < and > and nothing else).
// Formatting glyphs like * _ ~ ` are cosmetic and are intentionally left alone;
// callers that place untrusted text in a code span must additionally neutralize
// backticks to prevent breaking out of the span.
export function escapeMrkdwn(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}
