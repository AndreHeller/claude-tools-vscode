// Claude Panel — read-only companion panel pro Claude Code.
// Čte interní soubory Claude Code (~/.claude) a zobrazuje je v sidebaru.
// POZOR: formát je nedokumentovaný interní artefakt — parser je defenzivní,
// při změně tvaru raději zobrazí prázdno než aby spadl.

const vscode = require('vscode');
const fs = require('fs');
const path = require('path');
const os = require('os');

const CLAUDE_HOME = path.join(os.homedir(), '.claude');
const PROJECTS_DIR = path.join(CLAUDE_HOME, 'projects');
const PLANS_DIR = path.join(CLAUDE_HOME, 'plans');

// ---------- pomocné: lokalizace projektové složky ----------

// Claude Code kóduje cwd nahrazením '/' za '-' (ověřeno na živých datech).
function encodeCwd(cwd) {
  return cwd.replace(/\//g, '-');
}

function projectDirForWorkspace() {
  const folders = vscode.workspace.workspaceFolders;
  if (!folders || folders.length === 0) return null;
  const dir = path.join(PROJECTS_DIR, encodeCwd(folders[0].uri.fsPath));
  return fs.existsSync(dir) ? dir : null;
}

// Session považujeme za „živou", pokud do jejího transcriptu přibylo něco
// v posledních 10 minutách (mtime). Slouží jen k odlišení v pickeru.
const LIVE_WINDOW_MS = 10 * 60 * 1000;

// Lehká metadata všech session — JEN z názvu a mtime, BEZ čtení obsahu.
// Kritické: tohle je v hot path (activeSessionFile → Progress/Tools/Usage při
// každém refreshi), takže tady nikdy nesaháme na obsah (transcript má i 20 MB).
function listSessionsMeta(projectDir) {
  let files;
  try {
    files = fs
      .readdirSync(projectDir)
      .filter((f) => f.endsWith('.jsonl'))
      .map((f) => {
        const full = path.join(projectDir, f);
        let mtime = 0;
        try {
          mtime = fs.statSync(full).mtimeMs;
        } catch {
          /* soubor zmizel mezi readdir a stat — ponech mtime=0 */
        }
        return { id: path.basename(f, '.jsonl'), file: full, mtime };
      })
      .sort((a, b) => b.mtime - a.mtime);
  } catch {
    return [];
  }
  const now = Date.now();
  return files.map((s) => ({ ...s, live: now - s.mtime < LIVE_WINDOW_MS }));
}

// Titulek session čteme jen z HLAVIČKY transcriptu (ai-title i první user prompt
// jsou na začátku), takže načteme prvních ~64 KB, ne celý (klidně 20MB) soubor.
// Cache dle mtime; mrtvé session se čtou jen jednou.
const _titleCache = new Map();
function readSessionTitleCheap(file) {
  let mtime;
  try {
    mtime = fs.statSync(file).mtimeMs;
  } catch {
    return null;
  }
  const cached = _titleCache.get(file);
  if (cached && cached.mtime === mtime) return cached.title;

  let title = null;
  let firstPrompt = null;
  try {
    const fd = fs.openSync(file, 'r');
    try {
      const buf = Buffer.alloc(65536);
      const bytes = fs.readSync(fd, buf, 0, buf.length, 0);
      const lines = buf.toString('utf8', 0, bytes).split('\n');
      if (bytes === buf.length) lines.pop(); // poslední řádek může být oříznutý
      for (const line of lines) {
        const hasTitle = !title && line.includes('"ai-title"');
        const hasUser = !firstPrompt && line.includes('"type":"user"');
        if (!hasTitle && !hasUser) continue;
        let rec;
        try {
          rec = JSON.parse(line);
        } catch {
          continue;
        }
        if (rec.type === 'ai-title' && rec.aiTitle && !title) title = rec.aiTitle;
        if (rec.type === 'user' && !firstPrompt) {
          const c = rec.message && rec.message.content;
          if (typeof c === 'string') firstPrompt = c;
          else if (Array.isArray(c)) {
            const t = c.find((x) => x && x.type === 'text');
            if (t) firstPrompt = t.text;
          }
        }
        if (title) break; // ai-title je autoritativní, dál nečti
      }
    } finally {
      fs.closeSync(fd);
    }
  } catch {
    /* nečitelné — vrať fallback */
  }
  const label = title || (firstPrompt ? firstPrompt.replace(/\s+/g, ' ').trim().slice(0, 50) : null);
  _titleCache.set(file, { mtime, title: label });
  return label;
}

// Metadata + titulek (pro picker / QuickPick). Titulek je levný (jen hlavička),
// takže i 45 session je v pohodě; navíc cachovaný dle mtime.
function listAllSessions(projectDir) {
  return listSessionsMeta(projectDir).map((s) => ({
    ...s,
    title: readSessionTitleCheap(s.file) || s.id.slice(0, 8),
  }));
}

// Uložený výběr session (per workspace). Nastaví se z workspaceState v activate().
let _extContext = null;
const SELECTED_SESSION_KEY = 'claudeTools.selectedSession';
function getSelectedSessionId() {
  return _extContext ? _extContext.workspaceState.get(SELECTED_SESSION_KEY) || null : null;
}
function setSelectedSessionId(id) {
  if (_extContext) _extContext.workspaceState.update(SELECTED_SESSION_KEY, id || undefined);
}

// Session, na kterou se váží Progress/Tools/Usage. Sticky: drží uživatelův výběr,
// dokud daná session existuje; jinak (i bez výběru) fallback na nejnovější.
// Tím panel přestane „blikat" mezi paralelními session dle toho, která zapsala poslední.
function activeSessionFile(projectDir) {
  const sessions = listSessionsMeta(projectDir); // jen stat, žádné čtení obsahu
  if (!sessions.length) return null;
  const sel = getSelectedSessionId();
  if (sel) {
    const found = sessions.find((s) => s.id === sel);
    if (found) return found.file;
  }
  return sessions[0].file;
}

// ---------- parsování: poslední TodoWrite v session ----------

// Transcript (.jsonl) je append-only, takže obsahuje VŠECHNY snapshoty TodoWrite
// (každé volání = jeden tool_use blok s celým seznamem + timestamp záznamu).
// Vrací [{ ts, todos }] v pořadí, jak byly zapsány.
function readTodoSnapshots(sessionFile) {
  const snaps = [];
  let content;
  try {
    content = fs.readFileSync(sessionFile, 'utf8');
  } catch {
    return snaps;
  }
  for (const line of content.split('\n')) {
    if (!line.includes('"TodoWrite"')) continue;
    let rec;
    try {
      rec = JSON.parse(line);
    } catch {
      continue;
    }
    const msgContent = rec && rec.message && rec.message.content;
    if (!Array.isArray(msgContent)) continue;
    for (const c of msgContent) {
      if (c && c.type === 'tool_use' && c.name === 'TodoWrite' && c.input && Array.isArray(c.input.todos)) {
        snaps.push({ ts: rec.timestamp, todos: c.input.todos });
      }
    }
  }
  return snaps;
}

// Aktuální stav = poslední snapshot.
function readLatestTodos(sessionFile) {
  const snaps = readTodoSnapshots(sessionFile);
  return snaps.length ? snaps[snaps.length - 1].todos : [];
}

// Seskupí po sobě jdoucí snapshoty do logických seznamů: nová dávka začíná,
// jakmile se obsah úkolů kompletně vymění (žádný překryv `content` s předchozím).
function groupTodoSnapshots(snaps) {
  const groups = [];
  let cur = null;
  const keyset = (todos) => new Set(todos.map((t) => t.content));
  for (const s of snaps) {
    const ks = keyset(s.todos);
    if (cur) {
      const prev = keyset(cur.last.todos);
      let overlap = false;
      for (const k of ks) {
        if (prev.has(k)) {
          overlap = true;
          break;
        }
      }
      if (overlap) {
        cur.last = s;
        cur.end = s.ts;
        continue;
      }
    }
    cur = { start: s.ts, end: s.ts, last: s };
    groups.push(cur);
  }
  return groups;
}

// Jeden průchod session souborem: TodoWrite snapshoty + titulek session.
// Titulek = `aiTitle` (pokud Claude vygeneroval), jinak první user prompt.
function readSessionData(file) {
  const snaps = [];
  let title = null;
  let firstPrompt = null;
  let content;
  try {
    content = fs.readFileSync(file, 'utf8');
  } catch {
    return { snaps, title: null };
  }
  for (const line of content.split('\n')) {
    const hasTodo = line.includes('"TodoWrite"');
    const hasTitle = !title && line.includes('"ai-title"');
    const hasUser = !firstPrompt && line.includes('"type":"user"');
    if (!hasTodo && !hasTitle && !hasUser) continue;
    let rec;
    try {
      rec = JSON.parse(line);
    } catch {
      continue;
    }
    if (rec.type === 'ai-title' && rec.aiTitle && !title) title = rec.aiTitle;
    if (rec.type === 'user' && !firstPrompt) {
      const c = rec.message && rec.message.content;
      if (typeof c === 'string') firstPrompt = c;
      else if (Array.isArray(c)) {
        const t = c.find((x) => x && x.type === 'text');
        if (t) firstPrompt = t.text;
      }
    }
    const mc = rec.message && rec.message.content;
    if (Array.isArray(mc)) {
      for (const c of mc) {
        if (c && c.type === 'tool_use' && c.name === 'TodoWrite' && c.input && Array.isArray(c.input.todos)) {
          snaps.push({ ts: rec.timestamp, todos: c.input.todos });
        }
      }
    }
  }
  const label = title || (firstPrompt ? firstPrompt.replace(/\s+/g, ' ').trim().slice(0, 50) : null);
  return { snaps, title: label };
}

// Cache per session soubor (klíč = cesta + mtime). Statické session se parsují
// jen jednou; re-parsuje se jen ta živá.
const _groupCache = new Map();
function getSessionGroups(file) {
  let mtime;
  try {
    mtime = fs.statSync(file).mtimeMs;
  } catch {
    return { groups: [], title: null };
  }
  const cached = _groupCache.get(file);
  if (cached && cached.mtime === mtime) return cached;
  const data = readSessionData(file);
  const entry = { mtime, groups: groupTodoSnapshots(data.snaps), title: data.title };
  _groupCache.set(file, entry);
  return entry;
}

// Sessions projektu, které mají aspoň jednu todo dávku; nejnovější první.
function getProjectSessions(projectDir) {
  let files;
  try {
    files = fs
      .readdirSync(projectDir)
      .filter((f) => f.endsWith('.jsonl'))
      .map((f) => path.join(projectDir, f));
  } catch {
    return [];
  }
  const sessions = [];
  for (const f of files) {
    const { groups, title } = getSessionGroups(f);
    if (!groups.length) continue;
    const id = path.basename(f, '.jsonl');
    sessions.push({
      id,
      file: f,
      title: title || id.slice(0, 8),
      batches: groups, // chronologicky (jak byly zapsány)
      start: groups[0].start,
      end: groups[groups.length - 1].end,
    });
  }
  // ISO timestamp se řadí lexikograficky == chronologicky
  sessions.sort((a, b) => (b.end || '').localeCompare(a.end || ''));
  return sessions;
}

// Skilly a MCP volání použité v session (z tool_use bloků transcriptu).
// Skill: tool_use name 'Skill', input.skill = 'plugin:skill'.
// MCP:   tool_use name 'mcp__<server>__<tool>'.
// Notable vestavěné Claude nástroje, které stojí za zobrazení (ne každý Read/Bash).
const NOTABLE_BUILTIN = new Set(['WebSearch', 'WebFetch']);
// Ikona (codicon) per built-in nástroj — sdíleno principem v tree i webview.
const BUILTIN_ICON = { WebSearch: 'search', WebFetch: 'globe' };

// Volání subagenta jde přes tool 'Task'/'Agent' s input.subagent_type.
const AGENT_TOOLS = new Set(['Task', 'Agent']);
// Vestavěné subagent_type (bez plugin namespace). Cokoliv mimo = vlastní/projektový agent.
const BUILTIN_AGENTS = new Set(['claude', 'general-purpose', 'Explore', 'Plan', 'statusline-setup']);
// Kind agenta z jeho subagent_type: plugin (má namespace `:`), built-in, nebo custom.
function agentKind(type) {
  if (type.includes(':')) return 'plugin';
  if (BUILTIN_AGENTS.has(type)) return 'builtin';
  return 'custom';
}

// Built-in slash příkazy, které nejsou „skill" a jen šumí — do Commands je nedáváme.
const BUILTIN_CMD_DENY = new Set([
  'compact', 'clear', 'resume', 'model', 'config', 'cost', 'status', 'help',
  'login', 'logout', 'exit', 'quit', 'vim', 'doctor', 'init', 'ide', 'mcp',
  'plugin', 'agents', 'hooks', 'context', 'memory', 'add-dir', 'terminal-setup',
]);

function readSessionTools(sessionFile) {
  const skills = new Map(); // name -> count
  const commands = new Map();
  const builtin = new Map();
  const agents = new Map(); // subagent_type -> count
  const mcp = new Map(); // server -> Map(tool -> count)
  const bump = (m, k) => m.set(k, (m.get(k) || 0) + 1);
  let content;
  try {
    content = fs.readFileSync(sessionFile, 'utf8');
  } catch {
    return { skills: [], commands: [], builtin: [], agents: [], mcp: [] };
  }
  for (const line of content.split('\n')) {
    const hasTool = line.includes('tool_use');
    const hasCmd = line.includes('<command-name>');
    if (!hasTool && !hasCmd) continue;
    let r;
    try {
      r = JSON.parse(line);
    } catch {
      continue;
    }
    // Slash příkazy / user-spuštěné skilly (zapsané jako user zpráva s <command-name>).
    if (hasCmd && r.type === 'user') {
      const cc = r.message && r.message.content;
      const s = typeof cc === 'string' ? cc : '';
      const m = s.match(/<command-name>\/?([^<]+)<\/command-name>/);
      if (m) {
        const name = m[1].trim();
        if (name && !BUILTIN_CMD_DENY.has(name)) bump(commands, name);
      }
    }
    const mc = r.message && r.message.content;
    if (!Array.isArray(mc)) continue;
    for (const c of mc) {
      if (!c || c.type !== 'tool_use' || typeof c.name !== 'string') continue;
      if (c.name === 'Skill' && c.input && c.input.skill) {
        bump(skills, c.input.skill);
      } else if (AGENT_TOOLS.has(c.name)) {
        const type = c.input && typeof c.input.subagent_type === 'string' ? c.input.subagent_type : '';
        bump(agents, type || 'claude');
      } else if (c.name.startsWith('mcp__')) {
        const parts = c.name.slice(5).split('__');
        const server = parts[0] || 'mcp';
        const tool = parts.slice(1).join('__');
        if (!mcp.has(server)) mcp.set(server, new Map());
        if (tool) bump(mcp.get(server), tool);
      } else if (NOTABLE_BUILTIN.has(c.name)) {
        bump(builtin, c.name);
      }
    }
  }
  const prettyServer = (s) => s.replace(/^claude_ai_/, '').replace(/_/g, ' ');
  // Map<name,count> → seřazené pole {name, count}.
  const toList = (m) =>
    [...m.entries()].sort((a, b) => a[0].localeCompare(b[0])).map(([name, count]) => ({ name, count }));
  return {
    skills: toList(skills),
    commands: toList(commands),
    builtin: toList(builtin),
    agents: toList(agents),
    mcp: [...mcp.entries()]
      .map(([server, tools]) => ({
        server: prettyServer(server),
        tools: toList(tools),
        count: [...tools.values()].reduce((a, b) => a + b, 0),
      }))
      .sort((a, b) => a.server.localeCompare(b.server)),
  };
}

// ---------- parsování: běžící / dokončení subagenti (async Task/Agent) ----------
//
// Claude Code spouští subagenty ASYNCHRONNĚ na pozadí: tool_result se vrátí HNED
// (status "async_launched"), ne až po dokončení. Párování tool_use↔tool_result
// tedy stav běhu NEurčí. Zdroje pravdy:
//   • spuštění: `toolUseResult.status === 'async_launched'` (agentId, description,
//     resolvedModel, outputFile).
//   • dokončení: <task-notification> s <task-id>…</task-id> + <status>…</status>
//     (+ <summary>) — Claude Code ho zapíše do hlavní session (queue-operation
//     i user zpráva). Sledovaný transcript se tedy o doběhu dozví sám.
//   • subagent_type: z původního `Agent`/`Task` tool_use bloku, spárováno přes
//     tool_use_id (v async_launched výsledku není).

// Z <task-notification> bloku vytáhne task-id → { status, summary }.
function parseTaskNotification(text) {
  if (typeof text !== 'string' || !text.includes('<task-notification>')) return null;
  const id = text.match(/<task-id>([^<]+)<\/task-id>/);
  if (!id) return null;
  const status = text.match(/<status>([^<]+)<\/status>/);
  const summary = text.match(/<summary>([\s\S]*?)<\/summary>/);
  return {
    id: id[1].trim(),
    status: status ? status[1].trim() : 'completed',
    summary: summary ? summary[1].trim() : null,
  };
}

// Poslední akce běžícího agenta z jeho výstupního transcriptu (JSONL v /tmp).
// Čte se jen KONEC souboru (agentní transcript může narůst) — poslední tool_use
// nebo krátký úryvek textu. Vrací např. "Edit stg_deals.sql" nebo "přemýšlí…".
function readAgentLastAction(outputFile) {
  let text;
  try {
    const size = fs.statSync(outputFile).size;
    const want = 65536;
    const start = Math.max(0, size - want);
    const fd = fs.openSync(outputFile, 'r');
    try {
      const buf = Buffer.alloc(size - start);
      const bytes = fs.readSync(fd, buf, 0, buf.length, start);
      text = buf.toString('utf8', 0, bytes);
    } finally {
      fs.closeSync(fd);
    }
  } catch {
    return null;
  }
  const lines = text.split('\n');
  if (firstLineTruncated(lines)) lines.shift(); // první řádek může být oříznutý
  let last = null;
  for (const line of lines) {
    if (!line.includes('tool_use') && !line.includes('"text"')) continue;
    let r;
    try {
      r = JSON.parse(line);
    } catch {
      continue;
    }
    const mc = r.message && r.message.content;
    if (!Array.isArray(mc)) continue;
    for (const c of mc) {
      if (!c) continue;
      if (c.type === 'tool_use' && typeof c.name === 'string') {
        last = agentActionLabel(c);
      } else if (c.type === 'text' && typeof c.text === 'string' && c.text.trim()) {
        last = c.text.replace(/\s+/g, ' ').trim().slice(0, 60);
      }
    }
  }
  return last;
}

// true, pokud první řádek nezačíná '{' (oříznutý začátek po seeku doprostřed souboru).
function firstLineTruncated(lines) {
  return lines.length > 1 && !lines[0].trimStart().startsWith('{');
}

// Krátký lidský popis toho, co tool_use blok dělá: "Edit stg_deals.sql", "Bash", …
function agentActionLabel(c) {
  const inp = c.input || {};
  const base = (p) => (typeof p === 'string' ? p.split('/').pop() : null);
  if (c.name === 'Edit' || c.name === 'Write' || c.name === 'Read') {
    const f = base(inp.file_path);
    return f ? `${c.name} ${f}` : c.name;
  }
  if (c.name === 'Bash') return inp.description ? `Bash: ${inp.description}`.slice(0, 60) : 'Bash';
  if (c.name === 'Grep') return inp.pattern ? `Grep ${inp.pattern}`.slice(0, 60) : 'Grep';
  if (c.name === 'Glob') return inp.pattern ? `Glob ${inp.pattern}`.slice(0, 60) : 'Glob';
  if (c.name === 'Skill' && inp.skill) return `Skill ${inp.skill}`;
  if (c.name.startsWith('mcp__')) return c.name.slice(5).replace(/__/g, ' ');
  return c.name;
}

// Subagenti aktivní session: běžící + dokončení, chronologicky (nejnovější první).
// includeActions=true → u běžících dočte poslední akci z jejich output transcriptu.
function readSessionAgents(sessionFile, includeActions) {
  const byId = new Map(); // agentId -> { id, name, description, model, outputFile, status, summary }
  const notes = new Map(); // agentId -> { status, summary }
  const byToolUse = new Map(); // tool_use_id -> subagent_type (z Agent tool_use)
  let content;
  try {
    content = fs.readFileSync(sessionFile, 'utf8');
  } catch {
    return [];
  }
  for (const line of content.split('\n')) {
    const hasLaunch = line.includes('async_launched');
    const hasNote = line.includes('<task-notification>');
    const hasAgentUse = line.includes('subagent_type');
    if (!hasLaunch && !hasNote && !hasAgentUse) continue;
    let r;
    try {
      r = JSON.parse(line);
    } catch {
      continue;
    }
    // Agent/Task tool_use → mapa tool_use_id → subagent_type.
    const mc = r.message && r.message.content;
    if (Array.isArray(mc)) {
      for (const c of mc) {
        if (c && c.type === 'tool_use' && AGENT_TOOLS.has(c.name) && c.input) {
          if (typeof c.input.subagent_type === 'string') byToolUse.set(c.id, c.input.subagent_type);
        }
      }
    }
    // Spuštění async agenta.
    const tur = r.toolUseResult;
    if (tur && typeof tur === 'object' && tur.status === 'async_launched' && tur.agentId) {
      let toolUseId = null;
      if (Array.isArray(mc)) {
        const res = mc.find((c) => c && c.type === 'tool_result' && c.tool_use_id);
        if (res) toolUseId = res.tool_use_id;
      }
      byId.set(tur.agentId, {
        id: tur.agentId,
        name: byToolUse.get(toolUseId) || 'claude',
        description: tur.description || '',
        model: tur.resolvedModel || null,
        outputFile: tur.outputFile || null,
        status: 'running',
        summary: null,
      });
    }
    // Dokončení (task-notification může být v `content` queue-operation i v user message).
    if (hasNote) {
      const texts = [];
      if (typeof r.content === 'string') texts.push(r.content);
      const umc = r.message && r.message.content;
      if (typeof umc === 'string') texts.push(umc);
      else if (Array.isArray(umc)) for (const c of umc) if (c && typeof c.text === 'string') texts.push(c.text);
      for (const t of texts) {
        const n = parseTaskNotification(t);
        if (n) notes.set(n.id, n);
      }
    }
  }
  // Slouč completion notifikace do agentů.
  const agents = [...byId.values()].map((a) => {
    const n = notes.get(a.id);
    if (n) return { ...a, status: n.status === 'completed' ? 'done' : n.status, summary: n.summary };
    return a;
  });
  // Live akce jen pro běžící (a jen když je vyžádáno).
  if (includeActions) {
    for (const a of agents) {
      if (a.status === 'running' && a.outputFile) a.action = readAgentLastAction(a.outputFile);
    }
  }
  agents.reverse(); // nejnovější spuštěné první
  return agents;
}

// Zkrácený formát tokenů: 528310 → "528k", 1234567 → "1.2M".
function fmtTokens(n) {
  if (!n) return '0';
  if (n >= 1000000) return (n / 1000000).toFixed(1).replace(/\.0$/, '') + 'M';
  if (n >= 1000) return Math.round(n / 1000) + 'k';
  return String(n);
}

// Usage aktivní session z `usage` bloků assistant záznamů.
// Context window = input + cache_creation + cache_read posledního turnu.
function readSessionUsage(sessionFile) {
  let outputTotal = 0;
  let inputTotal = 0;
  let cacheReadTotal = 0;
  let contextTokens = 0;
  let maxContext = 0;
  let model = null;
  let content;
  try {
    content = fs.readFileSync(sessionFile, 'utf8');
  } catch {
    return null;
  }
  for (const line of content.split('\n')) {
    if (!line.includes('"usage"')) continue;
    let r;
    try {
      r = JSON.parse(line);
    } catch {
      continue;
    }
    const m = r.message;
    if (!m || m.role !== 'assistant' || !m.usage) continue;
    const u = m.usage;
    model = m.model || model;
    outputTotal += u.output_tokens || 0;
    inputTotal += u.input_tokens || 0;
    cacheReadTotal += u.cache_read_input_tokens || 0;
    const ctx =
      (u.input_tokens || 0) + (u.cache_creation_input_tokens || 0) + (u.cache_read_input_tokens || 0);
    contextTokens = ctx; // poslední turn = aktuální obsazení
    if (ctx > maxContext) maxContext = ctx;
  }
  if (!model && !contextTokens) return null;
  // Limit nejde z modelu spolehlivě vyčíst (sufix [1m] v transcriptu není). Setting přebije.
  // Auto: Opus i Fable jedou s 1M oknem; jinak fallback dle pozorovaného maxima.
  const cfg = vscode.workspace.getConfiguration('claudeTools').get('contextWindow', 'auto');
  let limit;
  if (cfg === '200000') limit = 200000;
  else if (cfg === '1000000') limit = 1000000;
  else limit = (model && /opus|fable/i.test(model)) || maxContext > 200000 ? 1000000 : 200000;
  return { model, contextTokens, limit, outputTotal, inputTotal, cacheReadTotal };
}

// Najde SKILL.md skillu v plugin cache (nejnovější verze; přeskočí temp_git klony).
function findPluginSkill(skillPart) {
  const root = path.join(CLAUDE_HOME, 'plugins', 'cache');
  let best = null;
  let bestM = 0;
  const stack = [root];
  let guard = 0;
  while (stack.length && guard++ < 20000) {
    const dir = stack.pop();
    let entries;
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const e of entries) {
      const full = path.join(dir, e.name);
      if (e.isDirectory()) {
        if (e.name.startsWith('temp_git')) continue;
        stack.push(full);
      } else if (
        e.name === 'SKILL.md' &&
        path.basename(dir) === skillPart &&
        path.basename(path.dirname(dir)) === 'skills'
      ) {
        let m;
        try {
          m = fs.statSync(full).mtimeMs;
        } catch {
          m = 0;
        }
        if (m > bestM) {
          bestM = m;
          best = full;
        }
      }
    }
  }
  return best;
}

// Resolvuje cestu k SKILL.md podle názvu skillu (local nebo plugin:skill).
function resolveSkillFile(name) {
  const folders = vscode.workspace.workspaceFolders;
  const colon = name.indexOf(':');
  const candidates = [];
  if (colon === -1) {
    if (folders && folders.length) {
      candidates.push(path.join(folders[0].uri.fsPath, '.claude', 'skills', name, 'SKILL.md'));
    }
    candidates.push(path.join(CLAUDE_HOME, 'skills', name, 'SKILL.md'));
  } else {
    const found = findPluginSkill(name.slice(colon + 1));
    if (found) candidates.push(found);
  }
  return candidates.find((c) => fs.existsSync(c)) || null;
}

function fmtTime(ts) {
  try {
    return new Date(ts).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  } catch {
    return '?';
  }
}

function fmtDate(ts) {
  try {
    return new Date(ts).toLocaleDateString();
  } catch {
    return '';
  }
}

// ---------- parsování: MEMORY.md ----------

// Řádky tvaru:  - [Title](file.md) — hook
function readMemory(projectDir) {
  const file = path.join(projectDir, 'memory', 'MEMORY.md');
  let content;
  try {
    content = fs.readFileSync(file, 'utf8');
  } catch {
    return [];
  }
  const out = [];
  const re = /^\s*-\s*\[([^\]]+)\]\(([^)]+)\)\s*(?:[—–-]\s*(.*))?$/;
  for (const line of content.split('\n')) {
    const m = line.match(re);
    if (!m) continue;
    out.push({
      title: m[1].trim(),
      link: m[2].trim(),
      file: path.join(projectDir, 'memory', m[2].trim()),
      hook: (m[3] || '').trim(),
    });
  }
  return out;
}

// Odebere z MEMORY.md indexu řádek odkazující na daný soubor (link).
function removeMemoryIndexLine(indexFile, link) {
  let content;
  try {
    content = fs.readFileSync(indexFile, 'utf8');
  } catch {
    return;
  }
  const kept = content.split('\n').filter((l) => {
    const m = l.match(/\]\(([^)]+)\)/);
    return !(m && m[1].trim() === link);
  });
  try {
    fs.writeFileSync(indexFile, kept.join('\n'));
  } catch {
    /* zápis selhal — ponech beze změny */
  }
}

// ---------- parsování: plans (globální) ----------

function readPlans() {
  let files;
  try {
    files = fs
      .readdirSync(PLANS_DIR)
      .filter((f) => f.endsWith('.md'))
      .map((f) => {
        const full = path.join(PLANS_DIR, f);
        return { full, mtime: fs.statSync(full).mtimeMs };
      })
      .sort((a, b) => b.mtime - a.mtime);
  } catch {
    return [];
  }
  return files.map(({ full }) => {
    let title = path.basename(full, '.md');
    try {
      const head = fs.readFileSync(full, 'utf8').split('\n');
      const h1 = head.find((l) => l.startsWith('# '));
      if (h1) title = h1.replace(/^#\s*/, '').trim();
    } catch {
      /* ponech fallback */
    }
    return { title, file: full };
  });
}

// ---------- TreeDataProvider základ ----------

class BaseProvider {
  constructor() {
    this._onDidChange = new vscode.EventEmitter();
    this.onDidChangeTreeData = this._onDidChange.event;
  }
  refresh() {
    this._onDidChange.fire();
  }
  getTreeItem(item) {
    return item;
  }
}

const STATUS_ICON = {
  completed: new vscode.ThemeIcon('check', new vscode.ThemeColor('charts.green')),
  in_progress: new vscode.ThemeIcon('sync~spin', new vscode.ThemeColor('charts.yellow')),
  pending: new vscode.ThemeIcon('circle-outline'),
};

class ProgressProvider extends BaseProvider {
  getChildren() {
    const projectDir = projectDirForWorkspace();
    if (!projectDir) return [placeholder('No Claude session for this workspace')];
    const session = activeSessionFile(projectDir);
    if (!session) return [placeholder('No session (.jsonl) found')];
    const todos = readLatestTodos(session);
    if (!todos.length) return [placeholder('No todos in the active session')];

    const done = todos.filter((t) => t.status === 'completed').length;
    const summary = new vscode.TreeItem(
      `${done}/${todos.length} done`,
      vscode.TreeItemCollapsibleState.None
    );
    summary.iconPath = new vscode.ThemeIcon('checklist');

    const items = todos.map((t) => {
      const label = t.status === 'in_progress' && t.activeForm ? t.activeForm : t.content;
      const item = new vscode.TreeItem(label, vscode.TreeItemCollapsibleState.None);
      item.iconPath = STATUS_ICON[t.status] || STATUS_ICON.pending;
      item.tooltip = t.content;
      return item;
    });
    return [summary, ...items];
  }
}

// Sbalitelný uzel jedné todo dávky → potomci jsou finální úkoly.
function buildBatchNode(g) {
  const todos = g.last.todos;
  const done = todos.filter((t) => t.status === 'completed').length;
  const complete = todos.length > 0 && done === todos.length;
  const range =
    fmtTime(g.start) === fmtTime(g.end) ? fmtTime(g.start) : `${fmtTime(g.start)}–${fmtTime(g.end)}`;

  const node = new Node(range, COLLAPSED);
  node.description = `${done}/${todos.length}`;
  node.tooltip = todos
    .map((t) => `${t.status === 'completed' ? '✓' : '○'} ${t.content}`)
    .join('\n');
  node.iconPath = complete
    ? new vscode.ThemeIcon('pass-filled', new vscode.ThemeColor('charts.green'))
    : new vscode.ThemeIcon('clock');
  node.children = todos.map((t) => {
    const item = new Node(t.content, LEAF);
    item.iconPath = STATUS_ICON[t.status] || STATUS_ICON.pending;
    item.tooltip = t.content;
    return item;
  });
  return node;
}

// Sbalitelný uzel jedné session → potomci jsou její dávky (nejnovější první).
function buildSessionNode(s, expand) {
  const node = new Node(s.title, expand ? EXPANDED : COLLAPSED);
  node.iconPath = new vscode.ThemeIcon('comment-discussion');
  node.description = `${s.batches.length}×`;
  node.tooltip = `Session ${s.id}`;
  // inline ikonky (viz package.json view/item/context): otevřít session v Claude Code + raw transcript
  node.contextValue = 'sessionNode';
  node.filePath = s.file;
  node.sessionId = s.id;
  node.children = s.batches.slice().reverse().map(buildBatchNode);
  return node;
}

// History panel — Datum → Session → Dávka → úkoly.
class HistoryProvider extends BaseProvider {
  getChildren(element) {
    if (element) return element.children;
    const projectDir = projectDirForWorkspace();
    if (!projectDir) return [placeholder('No Claude session for this workspace')];
    const sessions = getProjectSessions(projectDir);
    if (!sessions.length) return [placeholder('No todo history yet')];

    // Seskupení sessions podle data (datum poslední dávky session);
    // sessions už přišly od nejnovější, takže i data vyjdou od nejnovějšího.
    const byDate = [];
    const index = new Map();
    for (const s of sessions) {
      const d = fmtDate(s.end);
      let bucket = index.get(d);
      if (!bucket) {
        bucket = { date: d, sessions: [] };
        index.set(d, bucket);
        byDate.push(bucket);
      }
      bucket.sessions.push(s);
    }

    return byDate.map((bucket, i) => {
      const dayNode = new Node(bucket.date, i === 0 ? EXPANDED : COLLAPSED);
      dayNode.iconPath = new vscode.ThemeIcon('calendar');
      const batchCount = bucket.sessions.reduce((n, s) => n + s.batches.length, 0);
      dayNode.description = `${bucket.sessions.length} session · ${batchCount}×`;
      dayNode.children = bucket.sessions.map((s, j) => buildSessionNode(s, i === 0 && j === 0));
      return dayNode;
    });
  }
}

// Uzel stromu, který umí nést potomky (pro hierarchické pohledy).
class Node extends vscode.TreeItem {
  constructor(label, collapsibleState) {
    super(label, collapsibleState);
    this.children = [];
  }
}

const COLLAPSED = vscode.TreeItemCollapsibleState.Collapsed;
const EXPANDED = vscode.TreeItemCollapsibleState.Expanded;
const LEAF = vscode.TreeItemCollapsibleState.None;

// Leaf, který po kliknutí otevře soubor.
function fileLeaf(label, file, opts = {}) {
  const item = new Node(label, LEAF);
  item.iconPath = new vscode.ThemeIcon(opts.icon || 'file');
  if (opts.description) item.description = opts.description;
  item.tooltip = opts.tooltip || file;
  if (fs.existsSync(file)) {
    item.command = { command: 'claudePanel.openFile', title: 'Open', arguments: [file] };
  } else {
    item.description = '(missing)';
  }
  return item;
}

// Context panel — dělený podle scope: Global / Project / Local.
// Sjednocuje CLAUDE.md instrukce (vrstvené napříč scope) s projektovou
// auto-memory (MEMORY.md + fact soubory; auto-memory je vždy jen per-projekt).
class ContextProvider extends BaseProvider {
  getChildren(element) {
    if (element) return element.children;

    const roots = [];
    const folders = vscode.workspace.workspaceFolders;
    const wsPath = folders && folders.length ? folders[0].uri.fsPath : null;
    const projectDir = projectDirForWorkspace();

    // --- PERSONAL (user-level, napříč všemi projekty) ---
    const global = new Node('Personal', EXPANDED);
    global.iconPath = new vscode.ThemeIcon('account');
    global.children.push(
      fileLeaf('CLAUDE.md', path.join(CLAUDE_HOME, 'CLAUDE.md'), {
        icon: 'file-text',
        description: '~/.claude',
      })
    );
    // Managed (enterprise) policy — Linux/WSL, jen pokud existuje.
    const managed = '/etc/claude-code/CLAUDE.md';
    if (fs.existsSync(managed)) {
      global.children.push(
        fileLeaf('Managed policy', managed, { icon: 'shield', description: '/etc/claude-code' })
      );
    }
    roots.push(global);

    // --- PROJECT (sdílené s týmem: CLAUDE.md + auto-memory) ---
    const project = new Node('Project', EXPANDED);
    project.iconPath = new vscode.ThemeIcon('root-folder');
    if (wsPath) {
      project.children.push(
        fileLeaf('CLAUDE.md', path.join(wsPath, 'CLAUDE.md'), {
          icon: 'file-text',
          description: '<repo>',
        })
      );
    }
    if (projectDir) {
      const autoMem = new Node('Auto-memory', EXPANDED);
      autoMem.iconPath = new vscode.ThemeIcon('database');
      const indexFile = path.join(projectDir, 'memory', 'MEMORY.md');
      autoMem.children.push(
        fileLeaf('MEMORY.md (index)', indexFile, { icon: 'list-tree', tooltip: indexFile })
      );
      const entries = readMemory(projectDir);
      for (const e of entries) {
        const leaf = fileLeaf(e.title, e.file, { icon: 'book', tooltip: e.hook });
        leaf.description = e.hook;
        // smazatelné přes inline popelnici — smaže fakt soubor i řádek v indexu
        leaf.contextValue = 'deletableFile';
        leaf.filePath = e.file;
        leaf.kind = 'memoryEntry';
        leaf.memoryIndex = indexFile;
        leaf.memoryLink = e.link;
        autoMem.children.push(leaf);
      }
      project.children.push(autoMem);
    }
    if (!project.children.length) project.children.push(placeholder('No project context'));
    roots.push(project);

    // --- LOCAL (jen tento stroj, gitignored) ---
    const local = new Node('Local', COLLAPSED);
    local.iconPath = new vscode.ThemeIcon('device-desktop');
    if (wsPath) {
      local.children.push(
        fileLeaf('CLAUDE.local.md', path.join(wsPath, 'CLAUDE.local.md'), {
          icon: 'file-text',
          description: 'gitignored',
        })
      );
    } else {
      local.children.push(placeholder('No workspace'));
    }
    roots.push(local);

    return roots;
  }
}

class PlansProvider extends BaseProvider {
  getChildren() {
    const plans = readPlans();
    if (!plans.length) return [placeholder('No saved plans')];
    return plans.map((p) => {
      const item = new vscode.TreeItem(p.title, vscode.TreeItemCollapsibleState.None);
      item.description = path.basename(p.file);
      item.iconPath = new vscode.ThemeIcon('notebook');
      item.command = { command: 'claudePanel.openFile', title: 'Otevřít', arguments: [p.file] };
      item.contextValue = 'deletableFile';
      item.filePath = p.file;
      item.kind = 'plan';
      return item;
    });
  }
}

// Tools panel — skilly + MCP použité v aktivní session.
class ToolsProvider extends BaseProvider {
  getChildren(element) {
    if (element) return element.children;
    const projectDir = projectDirForWorkspace();
    if (!projectDir) return [placeholder('No Claude session for this workspace')];
    const session = activeSessionFile(projectDir);
    if (!session) return [placeholder('No session (.jsonl) found')];
    const { skills, commands, builtin, agents, mcp } = readSessionTools(session);
    if (!skills.length && !commands.length && !mcp.length && !builtin.length && !agents.length) {
      return [placeholder('No skills, commands, tools or MCP used in this session')];
    }

    const cnt = (n) => n + '×';
    const roots = [];
    if (skills.length) {
      const g = new Node('Skills', EXPANDED);
      g.iconPath = new vscode.ThemeIcon('extensions');
      g.children = skills.map((s) => {
        const i = new Node(s.name, LEAF);
        i.iconPath = new vscode.ThemeIcon('zap');
        i.description = cnt(s.count);
        i.command = { command: 'claudePanel.openSkill', title: 'Open skill', arguments: [s.name] };
        return i;
      });
      roots.push(g);
    }
    if (commands.length) {
      const g = new Node('Commands', EXPANDED);
      g.iconPath = new vscode.ThemeIcon('terminal');
      g.children = commands.map((c) => {
        const i = new Node('/' + c.name, LEAF);
        i.iconPath = new vscode.ThemeIcon('symbol-event');
        i.description = cnt(c.count);
        return i;
      });
      roots.push(g);
    }
    if (builtin.length) {
      const g = new Node('Built-in', EXPANDED);
      g.iconPath = new vscode.ThemeIcon('tools');
      g.children = builtin.map((b) => {
        const i = new Node(b.name, LEAF);
        i.iconPath = new vscode.ThemeIcon(BUILTIN_ICON[b.name] || 'tools');
        i.description = cnt(b.count);
        return i;
      });
      roots.push(g);
    }
    if (agents.length) {
      const g = new Node('Agents', EXPANDED);
      g.iconPath = new vscode.ThemeIcon('rocket');
      g.children = agents.map((a) => {
        const kind = agentKind(a.name);
        const i = new Node(a.name, LEAF);
        i.iconPath = new vscode.ThemeIcon(kind === 'plugin' ? 'extensions' : kind === 'custom' ? 'person' : 'rocket');
        i.description = (kind === 'builtin' ? 'built-in' : kind) + ' · ' + cnt(a.count);
        return i;
      });
      roots.push(g);
    }
    if (mcp.length) {
      const g = new Node('MCP', EXPANDED);
      g.iconPath = new vscode.ThemeIcon('plug');
      g.children = mcp.map((m) => {
        const sn = new Node(m.server, COLLAPSED);
        sn.iconPath = new vscode.ThemeIcon('server');
        sn.description = `${m.tools.length} tools · ${cnt(m.count)}`;
        sn.children = m.tools.map((t) => {
          const i = new Node(t.name, LEAF);
          i.iconPath = new vscode.ThemeIcon('symbol-method');
          i.description = cnt(t.count);
          return i;
        });
        return sn;
      });
      roots.push(g);
    }
    return roots;
  }
}

// Usage panel — context window + token totals aktivní session.
class UsageProvider extends BaseProvider {
  getChildren(element) {
    if (element) return element.children;
    const projectDir = projectDirForWorkspace();
    if (!projectDir) return [placeholder('No Claude session for this workspace')];
    const session = activeSessionFile(projectDir);
    if (!session) return [placeholder('No session (.jsonl) found')];
    const u = readSessionUsage(session);
    if (!u) return [placeholder('No usage data')];

    const pct = u.limit ? Math.round((u.contextTokens / u.limit) * 100) : 0;
    const items = [];
    if (u.model) {
      const mdl = new vscode.TreeItem(`Model: ${u.model}`, LEAF);
      mdl.iconPath = new vscode.ThemeIcon('chip');
      items.push(mdl);
    }
    const ctx = new vscode.TreeItem(
      `Context: ${fmtTokens(u.contextTokens)} / ${fmtTokens(u.limit)} (${pct}%)`,
      LEAF
    );
    ctx.iconPath = new vscode.ThemeIcon('window');
    items.push(ctx);
    const out = new vscode.TreeItem(`Output: ${fmtTokens(u.outputTotal)} tokens`, LEAF);
    out.iconPath = new vscode.ThemeIcon('arrow-up');
    items.push(out);
    const inp = new vscode.TreeItem(
      `Input: ${fmtTokens(u.inputTotal)} (+ ${fmtTokens(u.cacheReadTotal)} cached)`,
      LEAF
    );
    inp.iconPath = new vscode.ThemeIcon('arrow-down');
    items.push(inp);
    return items;
  }
}

function placeholder(text) {
  const item = new vscode.TreeItem(text, vscode.TreeItemCollapsibleState.None);
  item.iconPath = new vscode.ThemeIcon('info');
  return item;
}

// ---------- webview (skiny compact / cards) ----------

function appearance() {
  return vscode.workspace.getConfiguration('claudeTools').get('appearance', 'cards');
}

// Plochý JSON model pro webview — staví ze stejných read funkcí jako TreeView.
function buildModel() {
  const folders = vscode.workspace.workspaceFolders;
  const wsPath = folders && folders.length ? folders[0].uri.fsPath : null;
  const projectDir = projectDirForWorkspace();

  // SESSIONS: přepínač živých/paralelních session + která je zrovna sledovaná
  const allSessions = projectDir ? listAllSessions(projectDir) : [];
  const activeSession = projectDir ? activeSessionFile(projectDir) : null;
  const activeSessionId = activeSession ? path.basename(activeSession, '.jsonl') : null;

  // PROGRESS
  let todos = [];
  if (activeSession) todos = readLatestTodos(activeSession);
  const progress = {
    done: todos.filter((t) => t.status === 'completed').length,
    total: todos.length,
    items: todos.map((t) => ({ content: t.content, status: t.status, activeForm: t.activeForm })),
  };

  // TOOLS: skilly + MCP použité v aktivní session
  const tools = activeSession ? readSessionTools(activeSession) : { skills: [], commands: [], builtin: [], agents: [], mcp: [] };

  // AGENTS (live): běžící / dokončení async subagenti aktivní session
  const agents = activeSession ? readSessionAgents(activeSession, true) : [];

  // USAGE: context window + token totals aktivní session
  const usage = activeSession ? readSessionUsage(activeSession) : null;

  // HISTORY: Datum → Session → Dávka → úkoly
  const sessions = projectDir ? getProjectSessions(projectDir) : [];
  const history = [];
  const idx = new Map();
  for (const s of sessions) {
    const d = fmtDate(s.end);
    let bucket = idx.get(d);
    if (!bucket) {
      bucket = { date: d, sessions: [] };
      idx.set(d, bucket);
      history.push(bucket);
    }
    bucket.sessions.push({
      id: s.id,
      title: s.title,
      path: s.file,
      batches: s.batches
        .slice()
        .reverse()
        .map((g) => {
          const t = g.last.todos;
          const done = t.filter((x) => x.status === 'completed').length;
          return {
            range: fmtTime(g.start) === fmtTime(g.end) ? fmtTime(g.start) : `${fmtTime(g.start)}–${fmtTime(g.end)}`,
            done,
            total: t.length,
            complete: t.length > 0 && done === t.length,
            tasks: t.map((x) => ({ content: x.content, status: x.status })),
          };
        }),
    });
  }

  // CONTEXT: Global / Project (+ auto-memory) / Local
  const fileItem = (label, desc, p) => ({ label, desc, path: p, exists: fs.existsSync(p) });
  const context = [];
  context.push({ scope: 'Personal', items: [fileItem('CLAUDE.md', '~/.claude', path.join(CLAUDE_HOME, 'CLAUDE.md'))] });
  const projItems = [];
  let memory = [];
  if (wsPath) projItems.push(fileItem('CLAUDE.md', '<repo>', path.join(wsPath, 'CLAUDE.md')));
  if (projectDir) {
    const indexFile = path.join(projectDir, 'memory', 'MEMORY.md');
    projItems.push(fileItem('MEMORY.md (index)', 'auto-memory', indexFile));
    memory = readMemory(projectDir).map((e) => ({
      ...fileItem(e.title, e.hook, e.file),
      del: { kind: 'memoryEntry', index: indexFile, link: e.link },
    }));
  }
  context.push({ scope: 'Project', items: projItems, memory });
  if (wsPath) {
    context.push({ scope: 'Local', items: [fileItem('CLAUDE.local.md', 'gitignored', path.join(wsPath, 'CLAUDE.local.md'))] });
  }

  // PLANS
  const plans = readPlans().map((p) => ({
    label: p.title,
    desc: path.basename(p.file),
    path: p.file,
    exists: true,
    del: { kind: 'plan' },
  }));

  // jen odlehčená metadata pro picker (žádné dávky/tool výpisy)
  const sessionList = allSessions.map((s) => ({ id: s.id, title: s.title, live: s.live, path: s.file }));

  return {
    progress,
    history,
    context,
    plans,
    tools,
    agents,
    usage,
    sessions: sessionList,
    activeSessionId,
    selectedSessionId: getSelectedSessionId(), // null = auto (nejnovější)
    // sekce, které si uživatel trvale schoval (setting) — webview je nevykreslí
    hiddenSections: vscode.workspace.getConfiguration('claudeTools').get('hiddenSections', []),
  };
}

class ClaudeWebviewProvider {
  constructor(extensionUri) {
    this.extensionUri = extensionUri;
    this.view = null;
  }
  resolveWebviewView(view) {
    this.view = view;
    view.webview.options = {
      enableScripts: true,
      localResourceRoots: [vscode.Uri.joinPath(this.extensionUri, 'media')],
    };
    view.webview.html = this._html(view.webview);
    view.webview.onDidReceiveMessage((msg) => this._onMessage(msg));
    // Při návratu viditelnosti (přepnutí tabu) znovu pošli model — jinak zůstane prázdno.
    view.onDidChangeVisibility(() => {
      if (view.visible) this.refresh();
    });
    this.refresh();
  }
  refresh() {
    if (!this.view) return;
    this.view.webview.postMessage({ type: 'render', model: buildModel(), skin: appearance() });
  }
  _html(webview) {
    // cache-buster — ať webview vždy natáhne čerstvé CSS/JS (ne cachované)
    const v = Date.now();
    const css = webview.asWebviewUri(vscode.Uri.joinPath(this.extensionUri, 'media', 'webview.css')) + '?v=' + v;
    const js = webview.asWebviewUri(vscode.Uri.joinPath(this.extensionUri, 'media', 'webview.js')) + '?v=' + v;
    const codicon = webview.asWebviewUri(vscode.Uri.joinPath(this.extensionUri, 'media', 'codicon.css'));
    const csp = `default-src 'none'; style-src ${webview.cspSource}; script-src ${webview.cspSource}; font-src ${webview.cspSource};`;
    return `<!DOCTYPE html><html lang="cs"><head><meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="${csp}">
<link rel="stylesheet" href="${codicon}">
<link rel="stylesheet" href="${css}"></head>
<body><div id="root"></div><script src="${js}"></script></body></html>`;
  }
  _onMessage(msg) {
    if (!msg) return;
    if (msg.type === 'openFile' && msg.path) {
      vscode.window.showTextDocument(vscode.Uri.file(msg.path));
    } else if (msg.type === 'openSession' && msg.id) {
      vscode.commands.executeCommand('claude-vscode.editor.open', msg.id).then(undefined, () => {
        if (msg.path) vscode.window.showTextDocument(vscode.Uri.file(msg.path));
      });
    } else if (msg.type === 'openTranscript' && msg.path) {
      vscode.window.showTextDocument(vscode.Uri.file(msg.path));
    } else if (msg.type === 'openSkill' && msg.name) {
      vscode.commands.executeCommand('claudePanel.openSkill', msg.name);
    } else if (msg.type === 'selectSession') {
      // msg.id může být null → zruší sticky výběr (zpět na nejnovější)
      setSelectedSessionId(msg.id || null);
      vscode.commands.executeCommand('claudePanel.refresh');
    } else if (msg.type === 'delete' && msg.path) {
      // znovupoužij tree delete command (potvrzení + unlink + úklid MEMORY.md indexu + refresh)
      vscode.commands.executeCommand('claudePanel.deleteFile', {
        filePath: msg.path,
        kind: msg.kind,
        memoryIndex: msg.index,
        memoryLink: msg.link,
      });
    }
  }
}

// ---------- aktivace ----------

function activate(context) {
  _extContext = context; // zpřístupní workspaceState pro sticky výběr session
  const progress = new ProgressProvider();
  const history = new HistoryProvider();
  const context_ = new ContextProvider();
  const plans = new PlansProvider();
  const tools = new ToolsProvider();
  const usage = new UsageProvider();
  const webview = new ClaudeWebviewProvider(context.extensionUri);

  context.subscriptions.push(
    vscode.window.registerTreeDataProvider('claudeProgress', progress),
    vscode.window.registerTreeDataProvider('claudeHistory', history),
    vscode.window.registerTreeDataProvider('claudeContext', context_),
    vscode.window.registerTreeDataProvider('claudeSessionTools', tools),
    vscode.window.registerTreeDataProvider('claudeUsage', usage),
    vscode.window.registerTreeDataProvider('claudePlans', plans),
    vscode.window.registerWebviewViewProvider('claudeWebview', webview, {
      webviewOptions: { retainContextWhenHidden: true },
    })
  );

  // Context klíč 'claudeTools.mode' řídí (přes when v package.json), které views se zobrazí.
  const applyMode = () => {
    const a = appearance();
    vscode.commands.executeCommand('setContext', 'claudeTools.mode', a === 'tree' ? 'tree' : 'webview');
  };
  applyMode();
  context.subscriptions.push(
    vscode.workspace.onDidChangeConfiguration((e) => {
      if (e.affectsConfiguration('claudeTools.appearance')) {
        applyMode();
        webview.refresh();
      }
      if (e.affectsConfiguration('claudeTools.contextWindow')) {
        usage.refresh();
        webview.refresh();
      }
      if (e.affectsConfiguration('claudeTools.hiddenSections')) {
        webview.refresh();
      }
    })
  );

  // Live polling běžících subagentů: „právě dělá" se čte z jejich output transcriptů
  // v /tmp, kam fs.watch na projektové složce nedosáhne. Poll běží JEN dokud aspoň
  // jeden agent běží, pak se sám vypne (žádné trvalé čtení velkého transcriptu).
  const LIVE_POLL_MS = 2000;
  let livePoll = null;
  const hasRunningAgents = () => {
    const pd = projectDirForWorkspace();
    if (!pd) return false;
    const s = activeSessionFile(pd);
    return s ? readSessionAgents(s, false).some((a) => a.status === 'running') : false;
  };
  const syncLivePolling = () => {
    const running = hasRunningAgents();
    if (running && !livePoll) {
      livePoll = setInterval(() => {
        webview.refresh();
        if (!hasRunningAgents()) {
          clearInterval(livePoll);
          livePoll = null;
        }
      }, LIVE_POLL_MS);
    } else if (!running && livePoll) {
      clearInterval(livePoll);
      livePoll = null;
    }
  };

  const refreshAll = () => {
    progress.refresh();
    history.refresh();
    context_.refresh();
    tools.refresh();
    usage.refresh();
    plans.refresh();
    webview.refresh();
    syncLivePolling();
  };

  context.subscriptions.push(
    vscode.commands.registerCommand('claudePanel.refresh', refreshAll),
    vscode.commands.registerCommand('claudePanel.selectSession', async () => {
      const projectDir = projectDirForWorkspace();
      if (!projectDir) {
        vscode.window.showInformationMessage('No Claude session for this workspace.');
        return;
      }
      const sessions = listAllSessions(projectDir);
      if (!sessions.length) {
        vscode.window.showInformationMessage('No sessions found for this project.');
        return;
      }
      const activeId = getSelectedSessionId() || sessions[0].id;
      const picks = sessions.map((s) => ({
        label: (s.live ? '$(circle-filled) ' : '$(circle-outline) ') + s.title,
        description:
          (s.id === activeId ? 'tracked · ' : '') + new Date(s.mtime).toLocaleString(),
        id: s.id,
      }));
      // volba pro návrat k automatice (nejnovější)
      picks.push({ label: '$(sync) Auto (nejnovější session)', description: '', id: null });
      const choice = await vscode.window.showQuickPick(picks, {
        placeHolder: 'Vyber session, kterou sledovat v Progress / Tools / Usage',
      });
      if (choice === undefined) return;
      setSelectedSessionId(choice.id);
      refreshAll();
    }),
    vscode.commands.registerCommand('claudePanel.openFile', (file) => {
      vscode.window.showTextDocument(vscode.Uri.file(file));
    }),
    vscode.commands.registerCommand('claudePanel.openTranscript', (node) => {
      if (node && node.filePath) vscode.window.showTextDocument(vscode.Uri.file(node.filePath));
    }),
    vscode.commands.registerCommand('claudePanel.openSkill', (arg) => {
      const name = typeof arg === 'string' ? arg : arg && arg.skillName;
      if (!name) return;
      const file = resolveSkillFile(name);
      if (file) vscode.window.showTextDocument(vscode.Uri.file(file));
      else vscode.window.showWarningMessage(`SKILL.md for "${name}" not found on disk.`);
    }),
    vscode.commands.registerCommand('claudePanel.openInClaude', async (node) => {
      if (!node || !node.sessionId) return;
      try {
        // claude-vscode.editor.open(sessionId, initialPrompt) — otevře session jako editor tab
        await vscode.commands.executeCommand('claude-vscode.editor.open', node.sessionId);
      } catch (e) {
        vscode.window.showWarningMessage(
          'Could not open the session in Claude Code (extension not available?). Opening raw transcript.'
        );
        if (node.filePath) vscode.window.showTextDocument(vscode.Uri.file(node.filePath));
      }
    }),
    vscode.commands.registerCommand('claudePanel.deleteFile', async (node) => {
      if (!node || !node.filePath) return;
      const name = path.basename(node.filePath);
      const choice = await vscode.window.showWarningMessage(
        `Delete "${name}"?`,
        { modal: true, detail: node.filePath },
        'Delete'
      );
      if (choice !== 'Delete') return;
      try {
        fs.unlinkSync(node.filePath);
      } catch (e) {
        vscode.window.showErrorMessage(`Could not delete file: ${e.message}`);
        return;
      }
      // u memory položky odeber i řádek z MEMORY.md indexu, ať nezůstane viset
      if (node.kind === 'memoryEntry' && node.memoryIndex && node.memoryLink) {
        removeMemoryIndexLine(node.memoryIndex, node.memoryLink);
      }
      refreshAll();
    })
  );

  // Sledování změn na disku — debounce, ať se nepřekreslujeme při každém zápisu řádku.
  let timer = null;
  const debounced = () => {
    if (timer) clearTimeout(timer);
    timer = setTimeout(refreshAll, 300);
  };

  const watchers = [];
  const watch = (dir) => {
    try {
      if (fs.existsSync(dir)) {
        const w = fs.watch(dir, { recursive: false }, debounced);
        watchers.push(w);
      }
    } catch {
      /* fs.watch nemusí být na všech platformách stabilní — ignoruj */
    }
  };

  const projectDir = projectDirForWorkspace();
  if (projectDir) {
    watch(projectDir);
    watch(path.join(projectDir, 'memory'));
  }
  watch(PLANS_DIR);

  context.subscriptions.push({
    dispose: () => {
      watchers.forEach((w) => w.close());
      if (livePoll) clearInterval(livePoll);
    },
  });

  refreshAll();
}

function deactivate() {}

module.exports = { activate, deactivate };
