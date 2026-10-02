import { WebClient } from "@slack/web-api";
import type { RenderedAudit } from "./blocks";

export function createSlackPoster(
  token: string,
  channel: string,
  onDelivered: (receipt: { channel?: string; ts?: string }) => void,
  slackApiUrl?: string,
): (msg: RenderedAudit) => Promise<void> {
  // SendQueue owns both retry budgets and honors Retry-After. SDK retries
  // underneath it otherwise multiply outages and prevent timely draining.
  const web = new WebClient(token, {
    slackApiUrl, retryConfig: { retries: 0 }, rejectRateLimitedCalls: true,
    timeout: 15_000,
  });
  return async (msg) => {
    const result = await web.chat.postMessage({ channel, text: msg.text, blocks: msg.blocks,
      unfurl_links: false, unfurl_media: false });
    onDelivered({ channel: result.channel, ts: result.ts });
  };
}
