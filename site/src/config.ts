export const ENDPOINT = 'https://fra.cloud.appwrite.io/v1';
export const PROJECT_ID = 'stream-1811';

export const DATABASE_ID = 'chat';
export const TABLE_ID = 'messages';

// BEFORE: executed through the Functions API (async), answer arrives over Realtime
export const REALTIME_FUNCTION_ID = 'chat-realtime';

// AFTER: called on its own domain, answer arrives as a streamed HTTP body
export const STREAM_URL = 'https://stream-1811-chat.fra.appwrite.run/';

export const SUGGESTIONS = [
  'Plan a rollout for a breaking API change',
  'Explain HTTP streaming like I’m five',
  'Why do databases need indexes?',
  'Write a haiku about cold starts',
];
