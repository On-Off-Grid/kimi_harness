#!/usr/bin/env node
// pihunt-rag MCP server — zero-dependency stdio JSON-RPC 2.0.
// Bridges pi/subagents to the Python RAG (semantic search over techniques,
// the Memory MCP graph, past findings, and model notes) + write tools to
// record new techniques and graph entities.
//
// It shells out to the RAG venv Python CLI so all the numpy/model2vec work
// stays in Python; this file only does MCP framing + process glue.
import { createInterface } from 'node:readline';
import { spawnSync } from 'node:child_process';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { existsSync } from 'node:fs';

const RAG_HOME = process.env.PIHUNT_RAG_HOME || join(homedir(), '.pi-hunt-rag');
const PY = process.env.PIHUNT_RAG_PYTHON || join(RAG_HOME, '.venv', 'bin', 'python');
const REPO = process.env.PIHUNT_RAG_REPO || (() => {
  const cands = [
    join(homedir(), 'Desktop', 'bbp', '_BU', 'pi-hunt', 'rag'),
    join(homedir(), 'Documents', 'ai', 'pi-Hunt', 'pi-hunt-restore', 'rag'),
    join(homedir(), 'pi-hunt', 'rag'),
    join(homedir(), 'tools', 'pi-hunt', 'rag'),
  ];
  for (const c of cands) { try { if (existsSync(join(c, 'pihunt_rag'))) return c; } catch {} }
  return cands[0];
})();

const SERVER = { name: 'pihunt-rag-mcp', version: '1.0.0' };
const PROTO = '2024-11-05';

const TOOLS = [
  { name: 'rag_search',
    description: 'Semantic search over the pi-hunt knowledge base: top-hacker techniques, the Memory knowledge graph, your past findings, and model notes. Use it to recall how to approach a vuln class, find prior work on a program, or pull reusable heuristics.',
    inputSchema: { type: 'object', properties: {
      query: { type: 'string', description: 'natural-language query' },
      k: { type: 'number', description: 'max results (default 8)' },
      source: { type: 'string', description: 'filter: techniques | memory | findings | model-notes' },
      kind: { type: 'string', description: 'filter by chunk kind, e.g. technique, finding' },
      program: { type: 'string', description: 'filter to a program handle' } },
      required: ['query'] } },
  { name: 'rag_record_technique',
    description: 'Record a reusable technique/heuristic the model learned, for future hunts. Appended to model-notes and immediately indexed for semantic search.',
    inputSchema: { type: 'object', properties: {
      title: { type: 'string' }, body: { type: 'string' } }, required: ['title', 'body'] } },
  { name: 'rag_graph_add',
    description: 'Add an entity to the Memory knowledge graph (memory.jsonl) and index it for semantic search. Use a stable name like "<program>|<asset>|<weakness>|<auth>|<surface>".',
    inputSchema: { type: 'object', properties: {
      name: { type: 'string' }, entityType: { type: 'string' },
      observations: { type: 'array', items: { type: 'string' } } },
      required: ['name', 'entityType', 'observations'] } },
  { name: 'rag_ingest',
    description: 'Re-index the knowledge base. Optionally one source (techniques|memory|findings|model-notes). Run after editing techniques or adding many findings.',
    inputSchema: { type: 'object', properties: { source: { type: 'string' } } } },
  { name: 'rag_stats',
    description: 'Show index stats: embedding backend, dimension, and chunk counts per source.',
    inputSchema: { type: 'object', properties: {} } },
];

const send = (m) => process.stdout.write(JSON.stringify(m) + '\n');

function runPy(args, { jsonOut = true } = {}) {
  const env = { ...process.env, PIHUNT_RAG_HOME: RAG_HOME, PYTHONPATH: REPO,
                HF_HOME: join(RAG_HOME, 'data', 'hf') };
  const r = spawnSync(PY, ['-m', 'pihunt_rag.cli', ...args], {
    env, encoding: 'utf8', maxBuffer: 32 * 1024 * 1024, timeout: 120000 });
  if (r.error) throw new Error(`spawn failed: ${r.error.message}`);
  if (r.status !== 0) throw new Error(`rag cli exited ${r.status}: ${(r.stderr || '').slice(-500)}`);
  const out = (r.stdout || '').trim();
  if (!jsonOut) return out;
  try { return JSON.parse(out); } catch { return out; }
}

function callTool(name, a = {}) {
  if (name === 'rag_search') {
    const args = ['search', String(a.query), '--json', '-k', String(a.k || 8)];
    if (a.source) args.push('--source', String(a.source));
    if (a.kind) args.push('--kind', String(a.kind));
    if (a.program) args.push('--program', String(a.program));
    return runPy(args);
  }
  if (name === 'rag_record_technique')
    return runPy(['record', String(a.title), String(a.body)], { jsonOut: false });
  if (name === 'rag_graph_add') {
    const obs = Array.isArray(a.observations) ? a.observations.map(String) : [String(a.observations)];
    return runPy(['graph-add', String(a.name), String(a.entityType), ...obs], { jsonOut: false });
  }
  if (name === 'rag_ingest')
    return runPy(a.source ? ['ingest', '--source', String(a.source)] : ['ingest']);
  if (name === 'rag_stats') return runPy(['stats']);
  throw new Error(`unknown tool ${name}`);
}

const rl = createInterface({ input: process.stdin, crlfDelay: Infinity });
rl.on('line', (line) => {
  line = line.trim();
  if (!line) return;
  let msg;
  try { msg = JSON.parse(line); } catch { return; }
  const { id, method, params } = msg;
  try {
    if (method === 'initialize') {
      return send({ jsonrpc: '2.0', id, result: {
        protocolVersion: PROTO, capabilities: { tools: {} }, serverInfo: SERVER } });
    }
    if (method === 'tools/list') {
      return send({ jsonrpc: '2.0', id, result: { tools: TOOLS } });
    }
    if (method === 'tools/call') {
      if (!existsSync(PY)) {
        return send({ jsonrpc: '2.0', id, result: {
          content: [{ type: 'text', text: `RAG python venv not found at ${PY}. Run the rag install.` }],
          isError: true } });
      }
      const out = callTool(params?.name, params?.arguments || {});
      const text = typeof out === 'string' ? out : JSON.stringify(out, null, 2);
      return send({ jsonrpc: '2.0', id, result: { content: [{ type: 'text', text }] } });
    }
    if (method && method.startsWith('notifications/')) return; // no-op
    if (id !== undefined) send({ jsonrpc: '2.0', id, error: { code: -32601, message: `method not found: ${method}` } });
  } catch (e) {
    if (id !== undefined)
      send({ jsonrpc: '2.0', id, result: { content: [{ type: 'text', text: `error: ${e.message}` }], isError: true } });
  }
});
