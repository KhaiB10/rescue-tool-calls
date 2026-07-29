// rescue-tool-calls — recover tool calls that an LLM wrote as plain TEXT
// instead of using the structured tool-calling API.
//
// Local models (Ollama, llama.cpp) and some cheap cloud models frequently do this:
// they print  {"name":"get_weather","parameters":{"city":"Paris"}}  or
// <tool_call>get_weather<arg_key>city</arg_key><arg_value>Paris</arg_value>  as the
// message content. Your agent then never runs the tool and the user just sees a blob.
// This library salvages those calls so your agent keeps working across any model.
//
// No dependencies. Works in Node and the browser. MIT licensed.

/**
 * Scan text and return every top-level, balanced JSON object/array substring.
 * String-aware, so braces inside quoted strings don't break the balance count.
 * @param {string} text
 * @returns {string[]} JSON substrings, in order of appearance
 */
export function extractJsonFragments(text) {
  const out = [];
  if (typeof text !== 'string') return out;
  for (let i = 0; i < text.length; i++) {
    const open = text[i];
    if (open !== '{' && open !== '[') continue;
    let depth = 0, inStr = false, esc = false;
    for (let j = i; j < text.length; j++) {
      const ch = text[j];
      if (esc) { esc = false; continue; }
      if (ch === '\\') { esc = true; continue; }
      if (ch === '"') inStr = !inStr;
      if (inStr) continue;
      if (ch === '{' || ch === '[') depth++;
      else if (ch === '}' || ch === ']') {
        depth--;
        if (depth === 0) { out.push(text.slice(i, j + 1)); i = j; break; }
      }
    }
  }
  return out;
}

function coerceInput(raw) {
  let input = raw ?? {};
  if (typeof input === 'string') {
    try { input = JSON.parse(input); } catch { input = {}; }
  }
  return (input && typeof input === 'object') ? input : {};
}

/**
 * Parse tool calls out of raw model text.
 *
 * @param {string} text  The model's text output (its "content").
 * @param {string[]|Set<string>} [toolNames]  Names of the tools you offered. If given,
 *   only calls to these names are returned (prevents false positives). If omitted, any
 *   object that looks like a tool call is accepted.
 * @param {object} [options]
 * @param {boolean} [options.all=false]  Return every call found instead of just the first.
 * @returns {{ id: string, name: string, input: object }[]}
 */
export function parseToolCalls(text, toolNames, options = {}) {
  if (!text || typeof text !== 'string') return [];
  const names = toolNames ? new Set(toolNames) : null;
  const all = !!options.all;
  const found = [];

  const push = (o) => {
    if (!o || typeof o !== 'object') return;
    const name = o.name || o.function?.name || o.tool || o.tool_name;
    if (!name) return;
    if (names && !names.has(name)) return;
    const input = coerceInput(
      o.parameters ?? o.arguments ?? o.input ?? o.args ?? o.function?.arguments
    );
    found.push({ id: `rtc_${found.length}`, name, input });
  };

  // 1) JSON object/array fragments anywhere in the text (also covers ```json fences,
  //    Mistral's [TOOL_CALLS] arrays, <tool_call>{...}</tool_call>, etc.)
  for (const frag of extractJsonFragments(text)) {
    let obj;
    try { obj = JSON.parse(frag); } catch { continue; }
    if (Array.isArray(obj)) obj.forEach(push);
    else push(obj);
    if (found.length && !all) break; // first call wins unless caller wants them all
  }

  // 2) XML-ish style:  <tool_call>NAME<arg_key>k</arg_key><arg_value>v</arg_value>...
  if (!found.length && text.includes('<tool_call>')) {
    const tc = text.split('<tool_call>')[1] || '';
    const nm = (tc.match(/^\s*([a-zA-Z_][a-zA-Z0-9_]*)/) || [])[1];
    if (nm && (!names || names.has(nm))) {
      const input = {};
      for (const mt of tc.matchAll(
        /<arg_key>([\s\S]*?)<\/arg_key>\s*<arg_value>([\s\S]*?)(?:<\/arg_value>|$)/g
      )) {
        input[mt[1].trim()] = mt[2];
      }
      found.push({ id: 'rtc_0', name: nm, input });
    }
  }

  return all ? found : found.slice(0, 1);
}

/**
 * The one you probably want: use the model's STRUCTURED tool calls if it produced any,
 * and only fall back to text-salvage when it didn't. So it never fights a well-behaved
 * model, and rescues the ones that misbehave.
 *
 * @param {object} message  A chat message, e.g. OpenAI/Ollama shape
 *   { content?: string, tool_calls?: [{ id?, function: { name, arguments } }] }.
 * @param {string[]|Set<string>} [toolNames]
 * @param {object} [options]  Passed through to parseToolCalls (e.g. { all: true }).
 * @returns {{ id: string, name: string, input: object }[]}
 */
export function resolveToolCalls(message, toolNames, options = {}) {
  if (!message || typeof message !== 'object') return [];

  const structured = message.tool_calls;
  if (Array.isArray(structured) && structured.length) {
    return structured.map((c, i) => ({
      id: c.id || `rtc_${i}`,
      name: c.function?.name || c.name,
      input: coerceInput(c.function?.arguments ?? c.arguments ?? c.input),
    })).filter((c) => c.name);
  }

  return parseToolCalls(message.content || '', toolNames, options);
}

export default { parseToolCalls, resolveToolCalls, extractJsonFragments };
