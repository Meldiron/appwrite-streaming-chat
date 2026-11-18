# Appwrite streaming chat: Database + Realtime vs streamed response

The same AI chat built two ways on [Appwrite](https://appwrite.io), side by side, with live metrics. A demo for [streamed responses in Appwrite Functions and Sites](https://appwrite.io/blog/post/announcing-streaming-responses).

**Live demo:** https://stream-1811-chat.appwrite.network/?mode=both (`?mode=realtime` or `?mode=stream` shows one side)

| | Database + Realtime | Streamed response |
| --- | --- | --- |
| How the answer travels | function writes it into a row, browser listens over Realtime | function streams its HTTP response, browser reads it with `fetch` |
| Database writes per answer | about 25 (one per 100 ms flush) | 0 |
| Refresh in the middle of an answer | comes back and keeps typing | gone (nothing is stored) |
| Stop button | needs a cancel flag | `AbortController` |

## What's inside

```
functions/chat-realtime/   Database + Realtime: async execution, writes the answer into a row while the model generates
functions/chat-stream/     Streamed response: res.sendStream() over an async generator, stores nothing
site/                      Vite + TypeScript client with both panels and live metrics (first token, writes, events/chunks)
```

The heart of each version:

```js
// functions/chat-realtime: every flush is a write and a Realtime event
for await (const chunk of textStream) {
  content += chunk;
  await db.updateRow({ ...row, data: { content } });
}

// functions/chat-stream: every chunk goes straight to the browser
async function* answer() {
  for await (const chunk of textStream) yield chunk;
}
return res.sendStream(answer(), 200, { 'content-type': 'text/plain; charset=utf-8' });
```

```ts
// site: read the streamed body
const res = await fetch(STREAM_URL, { method: 'POST', body: JSON.stringify({ messages }) });
for await (const chunk of res.body.pipeThrough(new TextDecoderStream())) {
  bubble.textContent += chunk;
}
```

Both functions share `src/model.js`. With `OPENAI_API_KEY` set it streams a real answer through the [Vercel AI SDK](https://ai-sdk.dev) (`OPENAI_MODEL`, default `gpt-5-mini`). Without a key it uses a simulated model that streams canned answers on its own clock, so the demo never depends on conference Wi-Fi.

## Run it on your own Appwrite project

1. **Database:** create a TablesDB database `chat` with a table `messages` (permission `read("any")`) and these columns: `conversationId` (varchar 64, required), `role` (enum `user`, `assistant`, required), `content` (longtext), `status` (enum `streaming`, `done`, `error`, default `done`), `mode` (enum `realtime`, `stream`, required), `writes` (integer), `firstTokenMs` (integer), `totalMs` (integer), plus a key index on `conversationId`.
2. **Functions** (Node.js 22, entrypoint `src/main.js`, build command `npm install`):
   - `chat-realtime`: execute `any`, scopes `rows.read` and `rows.write`, timeout 120 s.
   - `chat-stream`: execute `any`, timeout 60 s, and add a function domain. It must be called on its domain: `createExecution` does not stream.
   - Optionally set `OPENAI_API_KEY` on both.
3. **Site:** point `site/src/config.ts` at your endpoint, project ID and the `chat-stream` domain, then deploy `site/` as a static Vite site (`npm install`, `npm run build`, output `./dist`) and add its hostname as a web platform.

Limits worth knowing: a stream through a function domain ends at the shorter of the function timeout and 60 s; on Sites it's 30 s.

## Related

- Streamed HTML with Astro on Appwrite Sites: https://github.com/meldiron/appwrite-streaming-astro
- Announcement: https://appwrite.io/blog/post/announcing-streaming-responses
