# rescue-tool-calls

**Recover tool calls that a local or cheap LLM wrote as plain text instead of using the tool-calling API.**

Zero dependencies. Works in Node and the browser. ~120 lines. MIT.

---

## The problem

You built an AI agent. It works great on GPT-4 or Claude. Then you switch to a **local model**
(Ollama, llama.cpp) to save money or keep data private — and your tools stop firing.

The reason: instead of returning a proper structured tool call, the model just **prints the call
as text** in its reply, like this:

```
Sure, let me check the weather.
{"name": "get_weather", "parameters": {"city": "Paris"}}
```

or in some models:

```
<tool_call>get_weather<arg_key>city</arg_key><arg_value>Paris</arg_value>
```

Your code looks at `message.tool_calls`, finds it empty, and the tool never runs. The user just
sees a blob. This happens constantly with local models and some cheaper cloud models.

## The fix

`rescue-tool-calls` reads that text and pulls the real tool call back out — so your agent keeps
working no matter which model you point it at.

```bash
npm install rescue-tool-calls
```

## Usage (the one function you want)

Pass the model's reply message and the list of tools you offered. It uses the **structured**
tool call if the model made one, and only **falls back to the text** if it didn't:

```js
import { resolveToolCalls } from 'rescue-tool-calls';

const message = await callYourModel();       // e.g. an Ollama / OpenAI chat message
const toolNames = ['get_weather', 'search'];

const calls = resolveToolCalls(message, toolNames);
// -> [{ id: 'rtc_0', name: 'get_weather', input: { city: 'Paris' } }]

for (const call of calls) {
  const result = await runTool(call.name, call.input);
  // ...feed result back to the model
}
```

That's it. Drop it in where you currently read `message.tool_calls`.

## Also available

Parse straight from a raw text string (when you only have the content):

```js
import { parseToolCalls } from 'rescue-tool-calls';

parseToolCalls('blah blah {"name":"search","arguments":{"q":"cats"}}', ['search']);
// -> [{ id: 'rtc_0', name: 'search', input: { q: 'cats' } }]
```

Options:

```js
parseToolCalls(text, toolNames, { all: true }); // return every call found, not just the first
parseToolCalls(text);                            // no tool list: accept any plausible call
```

## Pass your tool definitions, not `t => t.name`

You can hand the tool list over in whatever shape you already keep it:

```js
parseToolCalls(text, ['search']);                                        // strings
parseToolCalls(text, [{ name: 'search', input_schema: {...} }]);         // Anthropic / native
parseToolCalls(text, [{ type: 'function', function: { name: 'search' } }]); // OpenAI / Ollama
```

**This exists because of a real bug.** A caller mapped an OpenAI-shaped tool list with
`tools.map(t => t.name)` — but there the name lives at `t.function.name`, so every entry
became `undefined`. The allow-list then matched nothing, a perfectly valid rescued call was
thrown away, and the user was told the model's reply "came out malformed". Nothing logged a
problem, because from the library's side the caller had simply allowed no tools.

So now: if you pass a **non-empty** tool list and no name can be read from any entry, that is
treated as a caller mistake rather than a policy. The library warns, and does not filter:

```js
parseToolCalls(text, brokenList, { onWarn: (msg) => log.warn(msg) });
```

An **explicitly empty** array (`[]`) still means "allow nothing" and is respected.

## Debugging a misbehaving agent

`inspectToolCalls` tells you *why* nothing ran — because these look identical from the outside
and are completely different bugs:

```js
import { inspectToolCalls } from 'rescue-tool-calls';

inspectToolCalls('{"name":"browse_web","arguments":{}}', ['web_search']);
// -> { calls: [], rejected: ['browse_web'], sawToolLikeText: true }
//    the model invented a tool you never offered (stale list, or hallucinated name)

inspectToolCalls('I think the answer is 42.', ['web_search']);
// -> { calls: [], rejected: [], sawToolLikeText: false }
//    the model just answered in prose — nothing to rescue
```

## What it handles

- ✅ Plain JSON printed in the reply: `{"name":..., "parameters":...}`
- ✅ JSON buried inside prose or ` ```json ` fences
- ✅ Curly braces **inside string values** (a naive regex breaks here — this doesn't)
- ✅ `arguments` given as a JSON *string* (auto-parsed)
- ✅ Mistral-style `[TOOL_CALLS][ ... ]` arrays
- ✅ XML-ish `<tool_call>name<arg_key>..<arg_value>..`
- ✅ Key aliases: `name`/`function.name`/`tool`, `parameters`/`arguments`/`input`/`args`
- ✅ Ignores calls to tools you didn't offer (no false positives)
- ✅ Tool lists in **any** shape: strings, `{name}`, or OpenAI `{function:{name}}`
- ✅ Warns instead of silently rejecting when the tool list can't be read

## Why trust it

It's extracted from a production personal-AI agent that runs entirely on local models, where this
exact problem had to be solved for the agent to work at all. Every case above has a test:

```bash
npm test
```

## License

MIT © Khai Bustos
