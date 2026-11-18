import './style.css';
import { Client, Functions, TablesDB, Realtime, Channel, Query, ID, ExecutionMethod, type Models } from 'appwrite';
import {
  ENDPOINT,
  PROJECT_ID,
  DATABASE_ID,
  TABLE_ID,
  REALTIME_FUNCTION_ID,
  STREAM_URL,
  SUGGESTIONS,
} from './config';

const client = new Client().setEndpoint(ENDPOINT).setProject(PROJECT_ID);
const functions = new Functions(client);
const tables = new TablesDB(client);
const realtime = new Realtime(client);

type Kind = 'realtime' | 'stream';
type Mode = Kind | 'both';

type Message = {
  id: string;
  role: 'user' | 'assistant';
  content: string;
  status?: string;
  createdAt: string;
};

type Row = Models.Row & {
  conversationId: string;
  role: 'user' | 'assistant';
  content?: string | null;
  status?: string | null;
  writes?: number | null;
};

// ---------------------------------------------------------------- helpers

const $ = <T extends HTMLElement>(selector: string, root: ParentNode = document) => root.querySelector(selector) as T;

// No localStorage, no cookies, no sign-in. The Database + Realtime conversation
// lives in the URL (?chat=…) so a refresh finds it again; the streamed chat lives
// only in memory, so a refresh starts empty.
function urlParam(key: string) {
  return new URLSearchParams(location.search).get(key);
}

function writeUrl(params: Record<string, string | null>) {
  const search = new URLSearchParams(location.search);
  for (const [key, value] of Object.entries(params)) {
    if (value === null) search.delete(key);
    else search.set(key, value);
  }
  history.replaceState(null, '', `?${search.toString()}`);
}

function formatMs(ms: number | null) {
  if (ms === null) return '–';
  return ms < 1000 ? `${Math.round(ms)} ms` : `${(ms / 1000).toFixed(2)} s`;
}

// ---------------------------------------------------------------- panel

const COPY: Record<Kind, { eyebrow: string; title: string; flow: string; counter: string }> = {
  realtime: {
    eyebrow: 'Before',
    title: 'Database + Realtime',
    flow: 'createExecution() → updateRow() × N → Realtime',
    counter: 'Realtime events',
  },
  stream: {
    eyebrow: 'After',
    title: 'Streamed response',
    flow: 'fetch(function domain) → res.sendStream()',
    counter: 'Chunks received',
  },
};

class ChatPanel {
  readonly el: HTMLElement;
  private list: HTMLElement;
  private messages: Message[] = [];
  private bubbles = new Map<string, HTMLElement>();
  private conversationId: string;
  private busy = false;
  private abort: AbortController | null = null;
  private run: { startedAt: number; first: number | null; count: number } | null = null;

  constructor(readonly kind: Kind) {
    this.conversationId = (kind === 'realtime' && urlParam('chat')) || ID.unique();
    const copy = COPY[kind];
    this.el = document.createElement('section');
    this.el.className = `panel panel-${kind}`;
    this.el.innerHTML = `
      <header class="panel-head">
        <div>
          <p class="eyebrow">${copy.eyebrow}<span class="u">_</span></p>
          <h2>${copy.title}</h2>
          <p class="flow">${copy.flow}</p>
        </div>
        <div class="actions">
          ${kind === 'stream' ? '<button type="button" class="ghost stop" hidden>Stop</button>' : ''}
          <button type="button" class="ghost new">New chat</button>
        </div>
      </header>
      <dl class="metrics">
        <div><dt>First token</dt><dd data-m="first">–</dd></div>
        <div><dt>Total</dt><dd data-m="total">–</dd></div>
        <div><dt>Database writes</dt><dd data-m="writes">–</dd></div>
        <div><dt>${copy.counter}</dt><dd data-m="count">–</dd></div>
      </dl>
      <div class="messages" aria-live="polite"></div>`;
    this.list = $('.messages', this.el);
    $('.new', this.el).addEventListener('click', () => this.reset());
    if (kind === 'stream') $('.stop', this.el).addEventListener('click', () => this.abort?.abort());
  }

  private metric(name: 'first' | 'total' | 'writes' | 'count', value: string) {
    $(`[data-m="${name}"]`, this.el).textContent = value;
  }

  private clearMetrics() {
    for (const name of ['first', 'total', 'writes', 'count'] as const) this.metric(name, '–');
  }

  async load() {
    // The streamed chat stores nothing, and a fresh realtime chat has nothing yet
    if (this.kind === 'stream' || !urlParam('chat')) return this.render();
    const { rows } = await tables.listRows<Row>({
      databaseId: DATABASE_ID,
      tableId: TABLE_ID,
      queries: [Query.equal('conversationId', this.conversationId), Query.orderAsc('$createdAt'), Query.limit(100)],
    });
    this.messages = rows.map(toMessage);
    this.render();
    const streaming = rows.find((row) => row.status === 'streaming');
    if (streaming) {
      // Refreshed mid-answer: the row is still being written, Realtime catches us up
      this.metric('writes', String(streaming.writes ?? '–'));
      this.setBusy(true);
    }
  }

  reset() {
    this.abort?.abort();
    this.conversationId = ID.unique();
    if (this.kind === 'realtime') writeUrl({ chat: null });
    this.messages = [];
    this.run = null;
    this.clearMetrics();
    this.setBusy(false);
    this.render();
  }

  // ------------------------------------------------------------ rendering

  private render() {
    this.list.replaceChildren();
    this.bubbles.clear();
    if (this.messages.length === 0) {
      const empty = document.createElement('p');
      empty.className = 'empty';
      empty.textContent = 'No messages yet. Pick a prompt below.';
      this.list.append(empty);
      return;
    }
    for (const message of this.messages) this.list.append(this.bubble(message));
    this.scroll();
  }

  private bubble(message: Message) {
    const el = document.createElement('div');
    el.className = `msg msg-${message.role}`;
    el.textContent = message.content;
    el.classList.toggle('is-streaming', message.status === 'streaming' || message.status === 'pending');
    this.bubbles.set(message.id, el);
    return el;
  }

  private upsert(message: Message) {
    const index = this.messages.findIndex((m) => m.id === message.id);
    if (index === -1) {
      this.messages.push(message);
      this.messages.sort((a, b) => a.createdAt.localeCompare(b.createdAt));
      this.render();
      return;
    }
    this.messages[index] = message;
    const el = this.bubbles.get(message.id);
    if (el) {
      el.textContent = message.content;
      el.classList.toggle('is-streaming', message.status === 'streaming' || message.status === 'pending');
      this.scroll();
    }
  }

  private remove(id: string) {
    this.messages = this.messages.filter((m) => m.id !== id);
  }

  private removeLocal(prefix: string) {
    this.messages = this.messages.filter((m) => !m.id.startsWith(prefix));
  }

  private scroll() {
    this.list.scrollTop = this.list.scrollHeight;
  }

  private setBusy(busy: boolean) {
    this.busy = busy;
    this.el.classList.toggle('is-busy', busy);
    const stop = this.el.querySelector<HTMLButtonElement>('.stop');
    if (stop) stop.hidden = !busy;
  }

  isBusy() {
    return this.busy;
  }

  // ------------------------------------------------------------ BEFORE: Database + Realtime

  onRealtimeRow(row: Row, event: string) {
    if (this.kind !== 'realtime' || row.conversationId !== this.conversationId) return;
    if (event.endsWith('.delete')) return;

    if (row.role === 'user') this.removeLocal('local-user-');
    if (row.role === 'assistant') this.removeLocal('local-wait-');
    this.upsert(toMessage(row));

    if (row.role !== 'assistant') return;
    this.metric('writes', String(row.writes ?? '–'));

    if (this.run) {
      this.run.count++;
      this.metric('count', String(this.run.count));
      if (this.run.first === null && row.content) {
        this.run.first = performance.now() - this.run.startedAt;
        this.metric('first', formatMs(this.run.first));
      }
      if (row.status !== 'streaming') {
        this.metric('total', formatMs(performance.now() - this.run.startedAt));
        this.run = null;
      }
    }
    if (row.status !== 'streaming') this.setBusy(false);
  }

  private async sendRealtime(prompt: string) {
    writeUrl({ chat: this.conversationId });
    await functions.createExecution({
      functionId: REALTIME_FUNCTION_ID,
      body: JSON.stringify({ conversationId: this.conversationId, prompt }),
      async: true,
      method: ExecutionMethod.POST,
      headers: { 'content-type': 'application/json' },
    });
  }

  // ------------------------------------------------------------ AFTER: streamed response

  private async sendStream(prompt: string, run: string) {
    this.abort = new AbortController();

    // The conversation so far, from memory: nothing is stored anywhere
    const messages = this.messages
      .filter((m) => m.content && !m.id.startsWith('local-wait-') && !m.id.startsWith('local-error-'))
      .map(({ role, content }) => ({ role, content }));

    const response = await fetch(STREAM_URL, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ messages }),
      signal: this.abort.signal,
    });
    if (!response.ok || !response.body) throw new Error(`Function returned ${response.status}`);

    this.remove(`local-wait-${run}`);
    const answer: Message = { id: `local-answer-${run}`, role: 'assistant', content: '', status: 'streaming', createdAt: `~${run}-c` };
    this.upsert(answer);

    const reader = response.body.pipeThrough(new TextDecoderStream()).getReader();
    try {
      while (true) {
        const { value, done } = await reader.read();
        if (done) break;
        answer.content += value;
        this.upsert({ ...answer });
        if (this.run) {
          this.run.count++;
          this.metric('count', String(this.run.count));
          if (this.run.first === null && value.trim()) {
            this.run.first = performance.now() - this.run.startedAt;
            this.metric('first', formatMs(this.run.first));
          }
        }
      }
    } catch (err) {
      if ((err as Error).name !== 'AbortError') throw err;
      answer.content += ' [stopped]';
    } finally {
      this.upsert({ ...answer, status: 'done' });
      if (this.run) this.metric('total', formatMs(performance.now() - this.run.startedAt));
      this.run = null;
      this.abort = null;
      this.setBusy(false);
    }
  }

  // ------------------------------------------------------------ send

  async send(prompt: string) {
    if (this.busy) return;
    this.setBusy(true);
    this.clearMetrics();
    this.metric('count', '0');
    if (this.kind === 'stream') this.metric('writes', '0');
    this.run = { startedAt: performance.now(), first: null, count: 0 };

    // Local placeholders sort after every saved row ("~" > digits) until replaced
    const run = String(++runCounter).padStart(4, '0');
    this.upsert({ id: `local-user-${run}`, role: 'user', content: prompt, createdAt: `~${run}-a` });
    this.upsert({ id: `local-wait-${run}`, role: 'assistant', content: '', status: 'pending', createdAt: `~${run}-b` });

    try {
      if (this.kind === 'realtime') await this.sendRealtime(prompt);
      else await this.sendStream(prompt, run);
    } catch (err) {
      console.error(err);
      this.remove(`local-wait-${run}`);
      this.upsert({ id: `local-error-${run}`, role: 'assistant', content: `Something went wrong: ${(err as Error).message}`, createdAt: `~${run}-c` });
      this.run = null;
      this.setBusy(false);
    }
  }
}

let runCounter = 0;

function toMessage(row: Row): Message {
  return { id: row.$id, role: row.role, content: row.content ?? '', status: row.status ?? undefined, createdAt: row.$createdAt };
}

// ---------------------------------------------------------------- app

const panels: Record<Kind, ChatPanel> = {
  realtime: new ChatPanel('realtime'),
  stream: new ChatPanel('stream'),
};

function currentMode(): Mode {
  const mode = new URLSearchParams(location.search).get('mode');
  return mode === 'realtime' || mode === 'stream' ? mode : 'both';
}

function activePanels(mode = currentMode()): ChatPanel[] {
  return mode === 'both' ? [panels.realtime, panels.stream] : [panels[mode]];
}

function applyMode(mode: Mode) {
  const host = $('#panels');
  host.className = `panels mode-${mode}`;
  host.replaceChildren(...activePanels(mode).map((panel) => panel.el));
  document.querySelectorAll<HTMLAnchorElement>('.tabs a').forEach((a) => {
    a.setAttribute('aria-current', a.dataset.mode === mode ? 'page' : 'false');
  });
}

document.querySelectorAll<HTMLAnchorElement>('.tabs a').forEach((a) => {
  a.addEventListener('click', (event) => {
    event.preventDefault();
    const mode = a.dataset.mode as Mode;
    writeUrl({ mode });
    applyMode(mode);
  });
});

const input = $<HTMLInputElement>('#prompt');
const chips = $('#chips');
for (const text of SUGGESTIONS) {
  const chip = document.createElement('button');
  chip.type = 'button';
  chip.className = 'chip';
  chip.textContent = text;
  chip.addEventListener('click', () => submit(text));
  chips.append(chip);
}

function submit(prompt: string) {
  const text = prompt.trim();
  if (!text) return;
  const targets = activePanels().filter((panel) => !panel.isBusy());
  if (targets.length === 0) return;
  input.value = '';
  // Same prompt, same moment, both architectures
  for (const panel of targets) void panel.send(text);
}

$('#composer').addEventListener('submit', (event) => {
  event.preventDefault();
  submit(input.value);
});

async function start() {
  applyMode(currentMode());

  // Subscribe BEFORE anything is sent, so no early row update is missed
  await realtime.subscribe(Channel.tablesdb(DATABASE_ID).table(TABLE_ID).row(), (response) => {
    const event = response.events[0] ?? '';
    panels.realtime.onRealtimeRow(response.payload as unknown as Row, event);
  });

  await Promise.all([panels.realtime.load(), panels.stream.load()]);
}

start().catch((err) => {
  console.error(err);
  document.body.insertAdjacentHTML('afterbegin', `<p class="fatal">Could not connect: ${(err as Error).message}</p>`);
});
