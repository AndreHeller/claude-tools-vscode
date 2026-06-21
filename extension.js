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

// Nejnovější .jsonl přímo v projektové složce = aktivní session.
function newestSessionFile(projectDir) {
  try {
    const entries = fs
      .readdirSync(projectDir)
      .filter((f) => f.endsWith('.jsonl'))
      .map((f) => {
        const full = path.join(projectDir, f);
        return { full, mtime: fs.statSync(full).mtimeMs };
      })
      .sort((a, b) => b.mtime - a.mtime);
    return entries.length ? entries[0].full : null;
  } catch {
    return null;
  }
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
const NOTABLE_BUILTIN = new Set(['WebSearch', 'WebFetch', 'Task', 'Agent']);
// Ikona (codicon) per built-in nástroj — sdíleno principem v tree i webview.
const BUILTIN_ICON = { WebSearch: 'search', WebFetch: 'globe', Task: 'rocket', Agent: 'rocket' };

// Built-in slash příkazy, které nejsou „skill" a jen šumí — do Commands je nedáváme.
const BUILTIN_CMD_DENY = new Set([
  'compact', 'clear', 'resume', 'model', 'config', 'cost', 'status', 'help',
  'login', 'logout', 'exit', 'quit', 'vim', 'doctor', 'init', 'ide', 'mcp',
  'plugin', 'agents', 'hooks', 'context', 'memory', 'add-dir', 'terminal-setup',
]);

function readSessionTools(sessionFile) {
  const skills = new Set();
  const commands = new Set();
  const builtin = new Set();
  const mcp = new Map(); // server -> Set(tool)
  let content;
  try {
    content = fs.readFileSync(sessionFile, 'utf8');
  } catch {
    return { skills: [], commands: [], builtin: [], mcp: [] };
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
        if (name && !BUILTIN_CMD_DENY.has(name)) commands.add(name);
      }
    }
    const mc = r.message && r.message.content;
    if (!Array.isArray(mc)) continue;
    for (const c of mc) {
      if (!c || c.type !== 'tool_use' || typeof c.name !== 'string') continue;
      if (c.name === 'Skill' && c.input && c.input.skill) {
        skills.add(c.input.skill);
      } else if (c.name.startsWith('mcp__')) {
        const parts = c.name.slice(5).split('__');
        const server = parts[0] || 'mcp';
        const tool = parts.slice(1).join('__');
        if (!mcp.has(server)) mcp.set(server, new Set());
        if (tool) mcp.get(server).add(tool);
      } else if (NOTABLE_BUILTIN.has(c.name)) {
        builtin.add(c.name);
      }
    }
  }
  const prettyServer = (s) => s.replace(/^claude_ai_/, '').replace(/_/g, ' ');
  return {
    skills: [...skills].sort(),
    commands: [...commands].sort(),
    builtin: [...builtin].sort(),
    mcp: [...mcp.entries()]
      .map(([server, tools]) => ({ server: prettyServer(server), tools: [...tools].sort() }))
      .sort((a, b) => a.server.localeCompare(b.server)),
  };
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
  // Auto: Opus jede s 1M oknem; jinak fallback dle pozorovaného maxima.
  const cfg = vscode.workspace.getConfiguration('claudeTools').get('contextWindow', 'auto');
  let limit;
  if (cfg === '200000') limit = 200000;
  else if (cfg === '1000000') limit = 1000000;
  else limit = (model && /opus/i.test(model)) || maxContext > 200000 ? 1000000 : 200000;
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
    const session = newestSessionFile(projectDir);
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
    const session = newestSessionFile(projectDir);
    if (!session) return [placeholder('No session (.jsonl) found')];
    const { skills, commands, builtin, mcp } = readSessionTools(session);
    if (!skills.length && !commands.length && !mcp.length && !builtin.length) {
      return [placeholder('No skills, commands, tools or MCP used in this session')];
    }

    const roots = [];
    if (skills.length) {
      const g = new Node('Skills', EXPANDED);
      g.iconPath = new vscode.ThemeIcon('extensions');
      g.children = skills.map((s) => {
        const i = new Node(s, LEAF);
        i.iconPath = new vscode.ThemeIcon('zap');
        i.command = { command: 'claudePanel.openSkill', title: 'Open skill', arguments: [s] };
        return i;
      });
      roots.push(g);
    }
    if (commands.length) {
      const g = new Node('Commands', EXPANDED);
      g.iconPath = new vscode.ThemeIcon('terminal');
      g.children = commands.map((c) => {
        const i = new Node('/' + c, LEAF);
        i.iconPath = new vscode.ThemeIcon('symbol-event');
        return i;
      });
      roots.push(g);
    }
    if (builtin.length) {
      const g = new Node('Built-in', EXPANDED);
      g.iconPath = new vscode.ThemeIcon('tools');
      g.children = builtin.map((b) => {
        const i = new Node(b, LEAF);
        i.iconPath = new vscode.ThemeIcon(BUILTIN_ICON[b] || 'tools');
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
        sn.description = `${m.tools.length} tools`;
        sn.children = m.tools.map((t) => {
          const i = new Node(t, LEAF);
          i.iconPath = new vscode.ThemeIcon('symbol-method');
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
    const session = newestSessionFile(projectDir);
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

  // PROGRESS
  let todos = [];
  const activeSession = projectDir ? newestSessionFile(projectDir) : null;
  if (activeSession) todos = readLatestTodos(activeSession);
  const progress = {
    done: todos.filter((t) => t.status === 'completed').length,
    total: todos.length,
    items: todos.map((t) => ({ content: t.content, status: t.status, activeForm: t.activeForm })),
  };

  // TOOLS: skilly + MCP použité v aktivní session
  const tools = activeSession ? readSessionTools(activeSession) : { skills: [], commands: [], builtin: [], mcp: [] };

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

  return { progress, history, context, plans, tools, usage };
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
    })
  );

  const refreshAll = () => {
    progress.refresh();
    history.refresh();
    context_.refresh();
    tools.refresh();
    usage.refresh();
    plans.refresh();
    webview.refresh();
  };

  context.subscriptions.push(
    vscode.commands.registerCommand('claudePanel.refresh', refreshAll),
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

  context.subscriptions.push({ dispose: () => watchers.forEach((w) => w.close()) });

  refreshAll();
}

function deactivate() {}

module.exports = { activate, deactivate };
