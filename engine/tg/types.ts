/**
 * @module
 * Minimal Telegram Bot API subset used by the daemon. Only the fields we
 * actually read are typed — intentional, so unexpected TG additions never
 * fail our deserialization.
 */

export interface TgChat {
  id: number;
}

export interface TgMessage {
  message_id: number;
  chat: TgChat;
  message_thread_id?: number;
  text?: string;
}

export interface TgUpdate {
  update_id: number;
  message?: TgMessage;
}

export interface TgResponse<T> {
  ok: boolean;
  result?: T;
  description?: string;
  error_code?: number;
}

export interface TgGetMeResult {
  id: number;
  is_bot: boolean;
  username?: string;
}
