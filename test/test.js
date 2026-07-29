import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseToolCalls, resolveToolCalls, extractJsonFragments } from '../src/index.js';

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
