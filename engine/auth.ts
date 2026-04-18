/**
 * @module
 * Whitelist filter applied before any update reaches the IDE. Enforces
 * FR-AUTH: updates from non-whitelisted chats (or, when configured,
 * non-matching message threads) are rejected.
 */

import type { Config } from "./config.ts";
import type { TgUpdate } from "./tg/types.ts";

// FR-AUTH
export function isAllowed(update: TgUpdate, cfg: Config): boolean {
  const msg = update.message;
  if (!msg) return false;
  if (!cfg.allowed_chat_ids.includes(msg.chat.id)) return false;
  if (cfg.allowed_thread_ids && cfg.allowed_thread_ids.length > 0) {
    const tid = msg.message_thread_id;
    if (tid === undefined || !cfg.allowed_thread_ids.includes(tid)) {
      return false;
    }
  }
  return true;
}
