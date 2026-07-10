/**
 * Domestique - files completed bike-race torrent downloads into a Plex-friendly library layout.
 * Copyright (C) 2026  @nordada AKA Chris Reynolds
 *
 * This program is free software: you can redistribute it and/or modify
 * it under the terms of the GNU General Public License as published by
 * the Free Software Foundation, either version 3 of the License, or
 * (at your option) any later version.
 *
 * This program is distributed in the hope that it will be useful,
 * but WITHOUT ANY WARRANTY; without even the implied warranty of
 * MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the
 * GNU General Public License for more details.
 *
 * You should have received a copy of the GNU General Public License
 * along with this program.  If not, see <https://www.gnu.org/licenses/>.
 */

export interface DiscordConfig {
  webhookUrl: string;
  /** Discord user id (snowflake) to @mention on review-worthy notifications. Optional. */
  mentionUserId?: string;
}

export function discordConfigFromEnv(): DiscordConfig | null {
  const webhookUrl = process.env.DISCORD_WEBHOOK_URL;
  if (!webhookUrl) return null;

  return {
    webhookUrl,
    mentionUserId: process.env.DISCORD_MENTION_USER_ID || undefined,
  };
}

// Discord message content is capped at 2000 characters; leave headroom for
// the mention prefix and truncation note rather than cutting it exactly at
// the limit.
const MAX_CONTENT_LENGTH = 1900;

function truncate(message: string): string {
  if (message.length <= MAX_CONTENT_LENGTH) return message;
  return `${message.slice(0, MAX_CONTENT_LENGTH)}\n… (truncated)`;
}

/**
 * Posts a message to the configured Discord webhook. When `mention` is true
 * and a mentionUserId is configured, prefixes the message with a real
 * `<@id>` mention and explicitly whitelists it via allowed_mentions (Discord
 * silently drops mentions in webhook content otherwise); other cases send
 * with mentions suppressed so nothing in the archived-file text (e.g. a
 * literal "@everyone" in a torrent name) can accidentally ping anyone.
 */
export async function sendDiscordNotification(
  discord: DiscordConfig,
  message: string,
  opts: { mention?: boolean } = {}
): Promise<void> {
  const shouldMention = Boolean(opts.mention && discord.mentionUserId);
  const content = truncate(shouldMention ? `<@${discord.mentionUserId}> ${message}` : message);

  const body = {
    content,
    allowed_mentions: shouldMention ? { users: [discord.mentionUserId] } : { parse: [] },
  };

  const res = await fetch(discord.webhookUrl, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    throw new Error(`Discord webhook returned ${res.status} ${res.statusText}`);
  }
}
