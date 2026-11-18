// BEFORE: AI chat on Databases + Realtime.
//
// The client starts an async execution. This function writes the answer into a
// row while the model is still generating it, and the client watches that row
// over Realtime. A refresh mid-answer is fine: the client re-reads the row and
// keeps listening. The price: one database write (and one Realtime event) per
// flush, for every answer.

import { Client, TablesDB, ID, Query } from 'node-appwrite';
import { streamAnswer } from './model.js';

const DATABASE_ID = 'chat';
const TABLE_ID = 'messages';
const FLUSH_MS = Number(process.env.FLUSH_MS ?? 100); // batch tokens into one write per 100 ms

export default async ({ req, res, error }) => {
  const { conversationId, prompt } = req.bodyJson ?? {};
  if (!conversationId || !prompt) return res.json({ message: 'conversationId and prompt are required.' }, 400);

  const client = new Client()
    .setEndpoint(process.env.APPWRITE_FUNCTION_API_ENDPOINT)
    .setProject(process.env.APPWRITE_FUNCTION_PROJECT_ID)
    .setKey(req.headers['x-appwrite-key']);
  const db = new TablesDB(client); // the table is readable by anyone: no sign-in in this demo

  const history = await loadHistory(db, conversationId);

  await db.createRow({
    databaseId: DATABASE_ID,
    tableId: TABLE_ID,
    rowId: ID.unique(),
    data: { conversationId, role: 'user', content: prompt, mode: 'realtime' },
  });

  const startedAt = Date.now();
  let writes = 2; // the user row above + the empty answer row below
  const answer = await db.createRow({
    databaseId: DATABASE_ID,
    tableId: TABLE_ID,
    rowId: ID.unique(),
    data: { conversationId, role: 'assistant', content: '', status: 'streaming', mode: 'realtime', writes },
  });

  let content = '';
  let firstTokenMs = null;
  let lastFlush = 0;

  try {
    for await (const chunk of streamAnswer([...history, { role: 'user', content: prompt }])) {
      content += chunk;
      firstTokenMs ??= Date.now() - startedAt;

      // Every flush is a database write AND a Realtime event
      if (Date.now() - lastFlush >= FLUSH_MS) {
        writes++;
        await db.updateRow({ databaseId: DATABASE_ID, tableId: TABLE_ID, rowId: answer.$id, data: { content, writes } });
        lastFlush = Date.now();
      }
    }

    writes++;
    await db.updateRow({
      databaseId: DATABASE_ID,
      tableId: TABLE_ID,
      rowId: answer.$id,
      data: { content, status: 'done', writes, firstTokenMs, totalMs: Date.now() - startedAt },
    });
  } catch (err) {
    error(err);
    await db.updateRow({ databaseId: DATABASE_ID, tableId: TABLE_ID, rowId: answer.$id, data: { content, status: 'error' } });
    return res.json({ message: 'Model failed.' }, 500);
  }

  return res.json({ rowId: answer.$id, writes });
};

async function loadHistory(db, conversationId) {
  const { rows } = await db.listRows({
    databaseId: DATABASE_ID,
    tableId: TABLE_ID,
    queries: [Query.equal('conversationId', conversationId), Query.orderAsc('$createdAt'), Query.limit(40)],
  });
  return rows.filter((row) => row.content).map((row) => ({ role: row.role, content: row.content }));
}
