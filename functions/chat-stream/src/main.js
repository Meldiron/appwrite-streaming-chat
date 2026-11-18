// AFTER: the same AI chat with a streamed response.
//
// The client calls this function's domain with fetch() and reads the body as it
// arrives. Tokens go model -> function -> browser with nothing in between.
// Nothing is stored: the browser keeps the conversation in memory and sends it
// with every request, so a refresh starts from an empty chat.

import { streamAnswer } from './model.js';

const CORS = {
  'access-control-allow-origin': '*',
  'access-control-allow-headers': 'content-type',
  'access-control-allow-methods': 'POST, OPTIONS',
};

export default async ({ req, res, error }) => {
  if (req.method === 'OPTIONS') return res.text('', 204, CORS);

  const { messages } = req.bodyJson ?? {};
  if (!Array.isArray(messages) || messages.length === 0) {
    return res.json({ message: 'messages are required.' }, 400, CORS);
  }

  const history = messages.slice(-20).map((message) => ({
    role: message.role === 'assistant' ? 'assistant' : 'user',
    content: String(message.content ?? '').slice(0, 4000),
  }));

  async function* answer() {
    try {
      for await (const chunk of streamAnswer(history)) {
        yield chunk; // straight to the browser
      }
    } catch (err) {
      error(err);
      yield '\n\n[The model stopped early.]';
    }
  }

  return res.sendStream(answer(), 200, {
    ...CORS,
    'content-type': 'text/plain; charset=utf-8',
    'cache-control': 'no-store',
  });
};
