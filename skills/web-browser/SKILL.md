---
name: web-browser
description: "Browse and interact with web pages: navigate, read content, click, fill forms, screenshot, inspect console and network requests. Prefers Safari via its built-in MCP server (safaridriver --mcp) for general browsing and reading sites; falls back to Google Chrome via the Chrome DevTools Protocol (CDP) scripts when Safari is unavailable or when the task needs Chrome-only features (cookies, storage, file upload, drag, performance traces, logged-in profile, interactive element picking, persistent network logs)."
license: Stolen from Mario
---

# Web Browser Skill

Two backends. Pick one per task, then stick with it for the whole task so
state (tabs, logs, page) stays in one place.

## Choosing a backend

Use **Safari** (`scripts/safari.js`) by default for:
- Searching the web, reading/summarizing pages, following links
- Clicking, typing, filling forms, scrolling, hovering, selecting menu items
- Screenshots, console messages, listing/counting network requests,
  inspecting a single request's headers/body
- Tabs, viewport size, print/screen media emulation, JS dialogs

Use **Chrome** (scripts in `./scripts/`) when:
- Safari isn't available: `./scripts/safari.js start` fails (not macOS,
  Safari older than 27, or automation not enabled)
- The task involves **cookies or storage** (beyond what `document.cookie` /
  `localStorage` in JS can do), **file upload**, **drag and drop**, or
  **performance traces**
- The user needs their **logged-in Chrome profile** (`start.js --profile`)
- The user wants to **pick elements by clicking** (`pick.js`)
- The user wants **network/console logs persisted to disk** across commands,
  or explicit tracking of failed requests (Chrome logs `loadingFailed`;
  untested whether Safari lists failures). See "Network request counting"
  below.

If the user names a browser, use that one.

### Is Safari available?

Run `./scripts/safari.js start`. If it fails, use Chrome and tell the user
once how to enable Safari: Safari 27+ → Settings → Developer → check
**"Allow remote automation and external agents"** (if there's no Developer
tab, enable Settings → Advanced → "Show features for web developers" first).

---

## Safari (`scripts/safari.js`)

Wraps Safari's built-in MCP server (`/usr/bin/safaridriver --mcp`). A
background daemon keeps one session alive, so every call shares the same
agent window, tabs, and console/network buffers. Safari shows a banner on
that window. The session doesn't see the user's Safari logins or
cookies, but the user's installed Safari extensions do run in it.

```bash
./scripts/safari.js start            # open the agent window (any tool call also auto-starts)
./scripts/safari.js status
./scripts/safari.js stop             # close the session (exits on its own after 30 min idle)
./scripts/safari.js tools            # list tools
./scripts/safari.js tools get_page_content   # full input schema for one tool
./scripts/safari.js <tool> [--key value ...] ['{"json":"args"}']
```

Arguments: `--key value` (the value is parsed as JSON when it can be, so
`--clear false` gives a boolean), a JSON object, or both. Use a JSON object
when an argument is nested (`page_interactions`, `filter`). A flag with no
value means `true`. Output is the tool's text, usually JSON. The exit code
is 1 on a tool error.

### Rules
- `navigate_to_url` waits for load and returns page content, so you usually
  don't need a separate `get_page_content` right after.
- Read pages with `get_page_content`, not screenshots or JS. The default
  `textTree` format gives `uid=N` element IDs for interaction. For
  reading/summarizing, use `--format markdown --region entire_page`.
  Output ≥32 kB is written to a temp file; the path is returned.
- Interact with `page_interactions`: a batch of steps, each with `type`
  (`click | type | keyPress | scroll | selectText | selectMenuItem | hover |
  highlightText`), a `purpose`, and a target (`node` uid, visible `text`, or
  `point`). Returns a diff of what changed.
- `evaluate_javascript` runs as a **function body, so use `return`**.
  `$uid(42)` gets the element with uid 42. Use `--frameId` for iframes.
- `screenshot` writes a PNG and prints its path (`--full_page` for the whole
  page). The `node` option is currently a no-op.

### Examples

```bash
./scripts/safari.js navigate_to_url --url https://example.com
./scripts/safari.js get_page_content --format markdown --region entire_page
./scripts/safari.js page_interactions '{"interactions":[{"type":"click","text":"Sign in","purpose":"open login"}]}'
./scripts/safari.js page_interactions '{"interactions":[{"type":"type","node":42,"value":"hello","pressReturn":true,"purpose":"search"}]}'
./scripts/safari.js evaluate_javascript --expression 'return document.title'
./scripts/safari.js screenshot --full_page
./scripts/safari.js browser_console_messages --level_filter '["error","warn"]'
./scripts/safari.js list_network_requests --clear true   # read and reset
./scripts/safari.js list_network_requests '{"filter":{"status_min":400}}'
./scripts/safari.js get_network_request --request_id 0.693
```

### Tool reference
| Need | Tool |
|---|---|
| Open URL | `navigate_to_url --url U [--tab_uuid T]` |
| Wait after a navigation | `wait_for_navigation [--timeout_seconds N]` |
| URL / title / loading state | `page_info` |
| Read page | `get_page_content [--format F --region R --nodeIds N ...]` |
| Click / type / scroll / etc. | `page_interactions '{"interactions":[...]}'` |
| Run JS | `evaluate_javascript --expression 'return ...'` |
| Screenshot | `screenshot [--full_page]` |
| Console | `browser_console_messages [--clear false --level_filter [...] --limit N]` |
| Network list | `list_network_requests [--clear true --filter {...} --since ISO]` |
| One request in detail | `get_network_request --request_id ID` |
| alert/confirm/prompt | `browser_dialogs --action list\|respond\|dismiss` |
| Tabs | `list_tabs`, `create_tab`, `switch_tab --handle H`, `close_tab --handle H` |
| Viewport / media | `set_viewport_size --width W --height H`, `set_emulated_media --media print` |

### Cookie banners
There's no built-in tool. Read the page, then click the accept/reject button
with `page_interactions`, by `node` uid or `text`.

---

## Chrome (CDP scripts)

All commands run from `./scripts/` (run `npm install` there once).

### Start Chrome

```bash
./scripts/start.js              # Fresh profile
./scripts/start.js --profile    # Copy your profile (cookies, logins)
```

Starts Chrome on `:9222` with remote debugging (reuses it if already up).
Non-standard install: `BROWSER_BIN=/path/to/chrome ./scripts/start.js`

### Navigate

```bash
./scripts/nav.js https://example.com
./scripts/nav.js https://example.com --new
```

### Evaluate JavaScript

```bash
./scripts/eval.js 'document.title'
./scripts/eval.js 'JSON.stringify(Array.from(document.querySelectorAll("a")).map(a => ({ text: a.textContent.trim(), href: a.href })))'
```

Runs in the active tab (async context, expression — no `return` needed).
Use single quotes around the argument. Use this for cookies
(`document.cookie`), storage, and anything else CDP-reachable in-page.

### Screenshot

```bash
./scripts/screenshot.js
```

Screenshots the viewport; prints a temp file path.

### Pick Elements

```bash
./scripts/pick.js "Click the submit button"
```

Interactive picker for the user. Click to select, Cmd/Ctrl+Click to
multi-select, Enter to finish.

### Dismiss Cookie Dialogs

```bash
./scripts/nav.js https://example.com && ./scripts/dismiss-cookies.js
./scripts/dismiss-cookies.js --reject   # Reject where possible
```

### Background Logging (Console + Errors + Network)

Started automatically by `start.js`; writes JSONL per tab to
`~/.cache/agent-web/logs/YYYY-MM-DD/<targetId>.jsonl`.

```bash
./scripts/watch.js               # start manually
./scripts/logs-tail.js           # dump current log
./scripts/logs-tail.js --follow  # follow
./scripts/net-summary.js         # request/response counts, statuses, failures
```

### Not covered by the scripts

There are no scripts for performance traces, file upload, or drag and
drop. Write a short one-off Node script that imports `connect` from
`scripts/cdp.js` and sends the CDP commands you need (`Tracing.*`,
`DOM.setFileInputFiles`, `Input.dispatchDragEvent`, `Network.getCookies`,
`DOMStorage.*`).

---

## Network request counting

Both backends can count requests.

**Safari:** `list_network_requests` returns `{count, requests[]}`. Each
request includes method, url, status, mime_type, response_size_bytes,
initiator, and start time. Filter with `{method, status_min, status_max,
url_substring}` or `--since`. Notes:
- `safari.js start` uses up the session's first navigation on
  `about:blank`, because Safari doesn't capture requests from the
  navigation that opens the agent window. Page loads after that are
  counted.
- The list is **not** cleared when you read it unless you pass
  `--clear true`. (Console messages are the opposite: they clear on read by
  default.) To count exactly one page load: `list_network_requests --clear
  true` (throw the output away), then navigate, then `list_network_requests`.
- The count includes requests from the user's installed Safari extensions
  (`safari-web-extension://…`) and `data:` URLs. Filter by host when you
  need the site-only count.
- `duration_ms` was 0 for every request when tested, so don't use it for
  timing.

**Chrome:** after `start.js`, every request, response, and failure is
logged to disk. `net-summary.js` prints the totals and a breakdown by
status, and lists failures. Notes:
- The raw count includes browser-internal noise: new-tab-page,
  `chrome://resources`, favicon, and `data:` URLs. Filter by host in the
  JSONL when you need the site-only count.
- Logs are per tab and persist across commands. `net-summary.js` reads the
  most recently modified log; use `--file` to pick another one.
