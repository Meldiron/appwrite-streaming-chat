// The "model" both chat functions use.
//
// With OPENAI_API_KEY set on the function it streams a real answer through the
// Vercel AI SDK, exactly like the launch blog post. Without a key it falls back
// to a simulated model that streams a canned answer token by token, so the
// demo never depends on conference Wi-Fi or an API quota.

import { streamText } from 'ai';
import { createOpenAI } from '@ai-sdk/openai';

const SYSTEM =
  'You are a friendly assistant in a live conference demo. Answer in two to four short paragraphs of plain text. No markdown headings, no lists.';

/**
 * @param {{ role: 'user' | 'assistant', content: string }[]} messages
 * @returns {AsyncIterable<string>} text chunks
 */
export function streamAnswer(messages) {
  if (process.env.OPENAI_API_KEY) {
    const openai = createOpenAI({ apiKey: process.env.OPENAI_API_KEY });
    const result = streamText({
      model: openai(process.env.OPENAI_MODEL || 'gpt-5-mini'),
      system: SYSTEM,
      messages,
      providerOptions: { openai: { reasoningEffort: 'minimal' } },
    });
    return result.textStream;
  }
  return simulate(messages.at(-1)?.content ?? '');
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// Like a real model, the simulator keeps generating on its own clock, even
// while the caller is busy (say, writing to a database). Tokens produced in
// the meantime are handed over together on the next read.
function simulate(prompt) {
  const tokens = cannedAnswer(prompt).match(/\s*\S{1,4}|\s+/g) ?? [];
  const queue = [];
  let done = false;
  let wake = null;

  (async () => {
    await sleep(500 + Math.random() * 300); // "thinking"
    for (const token of tokens) {
      queue.push(token);
      wake?.();
      await sleep(14 + Math.random() * 26);
    }
    done = true;
    wake?.();
  })();

  return (async function* () {
    while (true) {
      if (queue.length) {
        yield queue.splice(0).join('');
        continue;
      }
      if (done) return;
      await new Promise((resolve) => (wake = resolve));
      wake = null;
    }
  })();
}

const ANSWERS = [
  {
    match: /stream|five|chunk/i,
    text: `Imagine you ask a friend to tell you a story. One way: your friend goes into another room, writes the whole story down, walks back and hands you the finished paper. You sit there waiting, staring at the door, not knowing if anything is happening.

The other way: your friend just starts talking. You hear the first sentence right away, and the rest keeps coming while they think of it. The story takes the same time to tell, but you are listening from the very first second.

HTTP streaming is the second friend. The server sends each piece of the answer the moment it is ready, and the browser shows it straight away, so the page feels alive instead of frozen.`,
  },
  {
    match: /haiku|cold start/i,
    text: `Container wakes up,
yawns through three hundred milliseconds,
first byte, finally.

Here is a second one, since the first was quick:

Request at midnight,
the function was fast asleep,
streaming wakes it up.`,
  },
  {
    match: /rollout|breaking|api change|deprecat/i,
    text: `Start by versioning the change instead of replacing the old behaviour. Ship the new shape under a v2 endpoint or behind a version header, and keep v1 working exactly as it is. Add a Deprecation header and a Sunset date to every v1 response, so clients see the deadline in their own logs.

Next, find out who is actually affected. Log every v1 call with its API key or client ID, and reach out to your biggest consumers directly before you announce anything publicly. Breaking changes rarely hurt because of the integrations you know about; they hurt because of the three nobody remembered.

Then roll out in stages. Publish the migration guide, release SDK versions that support both shapes, and watch v1 traffic week by week. Remove v1 only when its traffic is close to zero, and when you do, return a clear error that links to the guide instead of a silent 404.`,
  },
  {
    match: /index|database/i,
    text: `A database without an index is a library without a catalogue. To find one book, you walk every shelf and read every spine. That works with a hundred books and falls apart with a million.

An index is a sorted list that points to where each row lives. Looking something up becomes a few jumps through that sorted list instead of a full walk, which is why a query can go from seconds to milliseconds.

The trade-off is that every write now updates the index too, and the index takes space. So you index the columns you filter and sort on, not every column you have.`,
  },
];

function cannedAnswer(prompt) {
  const found = ANSWERS.find((answer) => answer.match.test(prompt));
  if (found) return found.text;
  return `Good question. This demo is running in offline mode, so instead of a real model you are reading a pre-written answer, streamed one small piece at a time.

That is actually the point of the demo: watch how the text appears. Every few characters travel from the function to your browser as soon as they exist, instead of waiting for the full answer.

Set OPENAI_API_KEY on the function and the same code streams a real answer to “${prompt.slice(0, 80)}” instead.`;
}
