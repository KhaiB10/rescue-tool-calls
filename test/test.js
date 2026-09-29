import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseToolCalls, resolveToolCalls, extractJsonFragments, normalizeToolNames, inspectToolCalls } from '../src/index.js';

const TOOLS = ['get_weather', 'search', 'send_email'];

test('plain JSON tool call in text', () => {
  const out = parseToolCalls('{"name":"get_weather","parameters":{"city":"Paris"}}', TOOLS);
  assert.equal(out.length, 1);
  assert.equal(out[0].name, 'get_weather');
  assert.deepEqual(out[0].input, { city: 'Paris' });
});

test('JSON buried in surrounding prose', () => {
  const text = 'Sure! I will check that for you.\n{"name":"search","arguments":{"q":"cats"}}\nDone.';
  const out = parseToolCalls(text, TOOLS);
  assert.equal(out[0].name, 'search');
  assert.deepEqual(out[0].input, { q: 'cats' });
});

test('markdown ```json fence', () => {
  const text = '```json\n{"name":"get_weather","parameters":{"city":"Tokyo"}}\n```';
  const out = parseToolCalls(text, TOOLS);
  assert.deepEqual(out[0].input, { city: 'Tokyo' });
});

test('braces inside string values do not break parsing', () => {
  const text = '{"name":"send_email","parameters":{"body":"use {curly} braces }{ ok"}}';
  const out = parseToolCalls(text, TOOLS);
  assert.equal(out[0].name, 'send_email');
  assert.equal(out[0].input.body, 'use {curly} braces }{ ok');
});

test('arguments given as a JSON string get parsed', () => {
  const text = '{"name":"search","arguments":"{\\"q\\":\\"dogs\\"}"}';
  const out = parseToolCalls(text, TOOLS);
  assert.deepEqual(out[0].input, { q: 'dogs' });
});

test('Mistral-style [TOOL_CALLS] array', () => {
  const text = '[TOOL_CALLS][{"name":"search","arguments":{"q":"weather"}}]';
  const out = parseToolCalls(text, TOOLS);
  assert.equal(out[0].name, 'search');
});

test('XML-ish <tool_call> style', () => {
  const text = '<tool_call>get_weather<arg_key>city</arg_key><arg_value>Berlin</arg_value>';
  const out = parseToolCalls(text, TOOLS);
  assert.equal(out[0].name, 'get_weather');
  assert.equal(out[0].input.city, 'Berlin');
});

test('unknown tool names are ignored (no false positives)', () => {
  const out = parseToolCalls('{"name":"delete_everything","parameters":{}}', TOOLS);
  assert.equal(out.length, 0);
});

test('without a tool list, any plausible call is accepted', () => {
  const out = parseToolCalls('{"name":"anything","parameters":{"x":1}}');
  assert.equal(out[0].name, 'anything');
});

test('all:true returns multiple calls', () => {
  const text = '{"name":"search","arguments":{"q":"a"}} then {"name":"search","arguments":{"q":"b"}}';
  const out = parseToolCalls(text, TOOLS, { all: true });
  assert.equal(out.length, 2);
});

test('resolveToolCalls prefers structured tool_calls', () => {
  const msg = {
    content: '{"name":"get_weather","parameters":{"city":"IGNORED"}}',
    tool_calls: [{ id: 'abc', function: { name: 'search', arguments: '{"q":"real"}' } }],
  };
  const out = resolveToolCalls(msg, TOOLS);
  assert.equal(out[0].name, 'search');
  assert.deepEqual(out[0].input, { q: 'real' });
  assert.equal(out[0].id, 'abc');
});

test('resolveToolCalls falls back to text when no structured calls', () => {
  const msg = { content: '{"name":"get_weather","parameters":{"city":"Oslo"}}', tool_calls: [] };
  const out = resolveToolCalls(msg, TOOLS);
  assert.equal(out[0].input.city, 'Oslo');
});

test('garbage / no tool call returns empty array', () => {
  assert.deepEqual(parseToolCalls('Hello, how can I help you today?', TOOLS), []);
  assert.deepEqual(parseToolCalls('', TOOLS), []);
  assert.deepEqual(parseToolCalls(null, TOOLS), []);
});

test('extractJsonFragments finds multiple objects', () => {
  const frags = extractJsonFragments('a {"x":1} b [1,2,3] c');
  assert.deepEqual(frags, ['{"x":1}', '[1,2,3]']);
});

// ── tool-list shape handling ────────────────────────────────────────────────
// These come from a real production incident, not a thought experiment. An
// agent running a local 24B model emitted a valid call to a tool that existed,
// the allow-list rejected it, and the user was told the reply "came out
// malformed". The cause was the caller mapping OpenAI-shaped tools with
// `t => t.name`, which yields undefined for every entry.

const REAL_ARTIFACT =
  '[{"name": "web_search", "arguments": {"query":"SOL price prediction for August 23, 2026"}}]';

test('real-world artifact: array-wrapped call with arguments', () => {
  const out = parseToolCalls(REAL_ARTIFACT, ['web_search']);
  assert.equal(out.length, 1);
  assert.equal(out[0].name, 'web_search');
  assert.deepEqual(out[0].input, { query: 'SOL price prediction for August 23, 2026' });
});

test('accepts OpenAI-shaped tool definitions directly', () => {
  const openai = [{ type: 'function', function: { name: 'web_search', description: 'search' } }];
  const out = parseToolCalls(REAL_ARTIFACT, openai);
  assert.equal(out[0].name, 'web_search');
});

test('accepts Anthropic/native-shaped tool definitions directly', () => {
  const native = [{ name: 'web_search', input_schema: { type: 'object' } }];
  const out = parseToolCalls(REAL_ARTIFACT, native);
  assert.equal(out[0].name, 'web_search');
});

test('THE INCIDENT: an unreadable tool list warns instead of silently rejecting', () => {
  // exactly what the failing caller produced: OpenAI tools mapped with t => t.name
  const broken = [{ type: 'function', function: { name: 'web_search' } }].map((t) => t.name);
  assert.deepEqual(broken, [undefined]);

  const warnings = [];
  const out = parseToolCalls(REAL_ARTIFACT, broken, { onWarn: (m) => warnings.push(m) });

  assert.equal(out.length, 1, 'a valid call must not be lost to a caller-side shape bug');
  assert.equal(out[0].name, 'web_search');
  assert.equal(warnings.length, 1, 'and the caller must be told');
  assert.match(warnings[0], /could not read a name/i);
});

test('an explicitly empty allow-list still means allow nothing', () => {
  const out = parseToolCalls(REAL_ARTIFACT, []);
  assert.equal(out.length, 0);
});

test('normalizeToolNames reads every common shape', () => {
  const n = normalizeToolNames([
    'a',
    { name: 'b' },
    { type: 'function', function: { name: 'c' } },
    { tool_name: 'd' },
  ]);
  assert.deepEqual([...n.names].sort(), ['a', 'b', 'c', 'd']);
  assert.equal(n.requested, 4);
});

test('normalizeToolNames returns null when no filter was requested', () => {
  assert.equal(normalizeToolNames(undefined), null);
  assert.equal(normalizeToolNames(null), null);
});

// ── inspectToolCalls: telling apart two very different bugs ─────────────────
test('inspect reports a call to a tool that was never offered', () => {
  const text = '{"name":"browse_web","arguments":{"q":"x"}}';   // hallucinated name
  const r = inspectToolCalls(text, ['web_search']);
  assert.equal(r.calls.length, 0);
  assert.deepEqual(r.rejected, ['browse_web']);
  assert.equal(r.sawToolLikeText, true);
});

test('inspect distinguishes prose from a rejected call', () => {
  const r = inspectToolCalls('I think the answer is 42.', ['web_search']);
  assert.equal(r.sawToolLikeText, false);
  assert.deepEqual(r.rejected, []);
});

// ── <function=NAME><parameter=KEY> — Qwen3-Coder, Qwen 3.5+, Granite 4.2 ─────
test('Granite 4.2 / Qwen3-Coder <function=> format (mellea #1689 example)', () => {
  const text = '<tool_call>\n<function=get_weather>\n<parameter=city>\nBoston\n</parameter>\n</function>\n</tool_call>';
  assert.deepEqual(parseToolCalls(text, TOOLS), [{ id: 'rtc_0', name: 'get_weather', input: { city: 'Boston' } }]);
});

test('<function=> values: JSON literals decode, everything else stays a string', () => {
  const text = '<function=read>\n<parameter=filePath>\n/Users/ai/app/index.js\n</parameter>\n'
    + '<parameter=limit>\n15\n</parameter>\n<parameter=offset>\n2969\n</parameter>\n'
    + '<parameter=id>\n007\n</parameter>\n<parameter=opts>\n{"deep": true}\n</parameter>\n</function>';
  const [call] = parseToolCalls(text, ['read']);
  assert.deepEqual(call.input, { filePath: '/Users/ai/app/index.js', limit: 15, offset: 2969, id: '007', opts: { deep: true } });
});

test('<function=> multi-line values keep their inner newlines', () => {
  const text = '<function=send_email>\n<parameter=body>\nHi,\n\nSee you Monday.\n</parameter>\n</function>';
  assert.equal(parseToolCalls(text, TOOLS)[0].input.body, 'Hi,\n\nSee you Monday.');
});

test('<function=> reply cut off mid-call still yields the call', () => {
  const text = "I'll look that up.\n<function=search>\n<parameter=q>\nollama context length";
  assert.deepEqual(parseToolCalls(text, TOOLS)[0], { id: 'rtc_0', name: 'search', input: { q: 'ollama context length' } });
});

test('<function=> respects the allow-list and returns every call with all:true', () => {
  const text = '<function=rm_rf><parameter=path>/</parameter></function>'
    + '<function=search><parameter=q>a</parameter></function><function=get_weather><parameter=city>Oslo</parameter></function>';
  assert.deepEqual(parseToolCalls(text, TOOLS, { all: true }).map(c => c.name), ['search', 'get_weather']);
  assert.deepEqual(inspectToolCalls(text, TOOLS).rejected, ['rm_rf']);
});

test('<function=> in prose that only mentions the syntax is not a call to an unoffered tool', () => {
  assert.deepEqual(parseToolCalls('Qwen writes calls like <function=NAME> blocks.', TOOLS), []);
});

// ── Mistral [TOOL_CALLS]NAME{…} and its drifted forms ───────────────────────
test('Mistral v11 [TOOL_CALLS]NAME[ARGS]{...}', () => {
  const [c] = parseToolCalls('[TOOL_CALLS]get_weather[ARGS]{"city": "Lyon"}', TOOLS);
  assert.deepEqual(c, { id: 'rtc_0', name: 'get_weather', input: { city: 'Lyon' } });
});

test('Mistral drift seen under a truncated prompt: NAME{…}, NAME: {…}, NAME,{…}, NAME\\n{…}', () => {
  for (const t of ['[TOOL_CALLS]search{"q":"x"}', '[TOOL_CALLS]search: {"q":"x"}', '[TOOL_CALLS]search,{"q":"x"}', '[TOOL_CALLS]search\n{"q":"x"}\n```']) {
    assert.deepEqual(parseToolCalls(t, TOOLS)[0]?.input, { q: 'x' }, t);
  }
});

test('Mistral with prose instead of JSON arguments is NOT turned into a call', () => {
  assert.deepEqual(parseToolCalls('[TOOL_CALLS]search: cats and dogs', TOOLS), []);
  assert.deepEqual(parseToolCalls('[TOOL_CALLS]send_email --to="a@b.c"', TOOLS), []);
});

test('Mistral [TOOL_CALLS] to a tool that was not offered is rejected', () => {
  assert.deepEqual(parseToolCalls('[TOOL_CALLS]rm_rf{"path":"/"}', TOOLS), []);
});
