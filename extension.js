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

// ---------- živé session: běžící procesy Claude Code ----------
//
// mtime transcriptu NEŘÍKÁ, jestli session žije: session, ve které Claude čeká na
// vstup, do souboru nepíše, a přesto normálně běží. Pravdivý zdroj je
// ~/.claude/sessions/<pid>.json, který Claude Code píše při startu a při každé
// změně stavu: { pid, sessionId, cwd, status: 'busy' | 'idle', name }.
// Soubory po spadlých procesech ve složce zůstávají, takže PID se musí ověřit.
const SESSIONS_DIR = path.join(CLAUDE_HOME, 'sessions');

// Fallback, když složka sessions/ neexistuje (starší Claude Code): živá = do
// transcriptu přibylo něco za posledních 10 minut.
const LIVE_WINDOW_MS = 10 * 60 * 1000;

// Krátká cache — listSessionsMeta je v hot path (každý refresh panelu), tohle
// čte ~10 malých souborů a volá stat na procesy.
const LIVE_CACHE_MS = 1000;
let _liveCache = { at: 0, map: null };

// sessionId -> { status, name, cwd } pro VŠECHNY právě běžící session (napříč
// projekty; filtr na projekt dělá volající). null = složka sessions/ není k mání.
function liveSessions() {
  const now = Date.now();
  if (now - _liveCache.at < LIVE_CACHE_MS) return _liveCache.map;
  let files;
  try {
    files = fs.readdirSync(SESSIONS_DIR).filter((f) => f.endsWith('.json'));
  } catch {
    _liveCache = { at: now, map: null };
    return null;
  }
  const map = new Map();
  for (const f of files) {
    let d;
    try {
      d = JSON.parse(fs.readFileSync(path.join(SESSIONS_DIR, f), 'utf8'));
    } catch {
      continue; // rozepsaný / poškozený soubor — přeskoč
    }
    if (!d || !d.sessionId || !d.pid) continue;
    try {
      process.kill(d.pid, 0); // signál 0 = jen test existence, proces nic nedostane
    } catch {
      continue; // osiřelý .json po spadlém procesu
    }
    map.set(d.sessionId, {
      pid: d.pid, // rodič hlídačů té session — viz monitorProcess()
      status: d.status === 'busy' ? 'busy' : 'idle',
      name: typeof d.name === 'string' ? d.name : null,
      // 'user' = pojmenoval si ji uživatel, 'derived' = odvodil si ji Claude Code
      // z adresáře (claude-tools-88). Jen to první má přebít titulek z transcriptu.
      nameSource: typeof d.nameSource === 'string' ? d.nameSource : null,
      cwd: typeof d.cwd === 'string' ? d.cwd : null,
      // 'claude-vscode' = session v tabu VS Code (jen ty jde přiřadit k tabu)
      entrypoint: typeof d.entrypoint === 'string' ? d.entrypoint : null,
    });
  }
  _liveCache = { at: now, map };
  return map;
}

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
  const live = liveSessions();
  return files.map((s) => {
    const l = live ? live.get(s.id) : null;
    return {
      ...s,
      live: live ? !!l : now - s.mtime < LIVE_WINDOW_MS,
      status: l ? l.status : null, // 'busy' | 'idle' | null (neběží / neznámo)
      liveName: l ? l.name : null,
      liveNameSource: l ? l.nameSource : null,
      // starší Claude Code entrypoint nezapisoval → nevíme, ber jako VS Code
      vscode: l ? !l.entrypoint || l.entrypoint === 'claude-vscode' : false,
    };
  });
}

// Titulek session. `ai-title` NENÍ spolehlivě na začátku: před ním leží
// attachment záznamy (seznam skillů, deferred tools, instrukce MCP serverů),
// které u firemní sady pluginů zaberou stovky kilobajtů — doloženo session,
// kde první `ai-title` ležel až na 335. kB a v panelu se proto místo titulku
// ukazoval první prompt.
//
// Čte se proto KONEC souboru, kde `ai-title` taky je (zapisuje se opakovaně,
// klidně třistakrát), a jen když se tam nenajde, sáhne se na začátek pro první
// prompt. Celý soubor se nečte nikdy — má i 20 MB.
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
  const OKNO = 262144; // 256 kB z každého konce
  const kusSouboru = (fd, velikost, odKonce) => {
    const delka = Math.min(OKNO, velikost);
    const start = odKonce ? Math.max(0, velikost - delka) : 0;
    const buf = Buffer.alloc(delka);
    const bytes = fs.readSync(fd, buf, 0, delka, start);
    const lines = buf.toString('utf8', 0, bytes).split('\n');
    // Oříznutý řádek na kraji okna se nedá naparsovat — zahoď ten na té straně,
    // kde řez vznikl.
    if (odKonce && start > 0) lines.shift();
    else if (!odKonce && bytes < velikost) lines.pop();
    return lines;
  };
  try {
    const fd = fs.openSync(file, 'r');
    try {
      const velikost = fs.fstatSync(fd).size;
      // Konec souboru: `ai-title` je autoritativní a poslední zapsaný je
      // nejčerstvější, takže se bere ten nejbližší konci.
      const konec = kusSouboru(fd, velikost, true);
      for (let i = konec.length - 1; i >= 0 && !title; i--) {
        const line = konec[i];
        if (!line.includes('"ai-title"')) continue;
        try {
          const rec = JSON.parse(line);
          if (rec.type === 'ai-title' && rec.aiTitle) title = rec.aiTitle;
        } catch {
          /* oříznutý nebo poškozený řádek */
        }
      }
      // Bez titulku padáme na první prompt — ten je na začátku vždy.
      if (!title) {
        for (const line of kusSouboru(fd, velikost, false)) {
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
          if (title) break;
        }
      }
    } finally {
      fs.closeSync(fd);
    }
  } catch {
    /* nečitelné — vrať fallback */
  }
  const label = title || (firstPrompt ? firstPrompt.replace(/\s+/g, ' ').trim().slice(0, 50) : null);
  _titleCache.set(file, { mtime, title: label, ai: !!title });
  return label;
}

// Má session skutečný titulek (`ai-title`), nebo jen první prompt? Tab Claude
// Code se do příchodu titulku jmenuje „Claude Code". Volat po
// readSessionTitleCheap — čte jen jeho cache.
function sessionHasAiTitle(file) {
  const c = _titleCache.get(file);
  return !!(c && c.ai);
}

// Metadata + titulek (pro picker / QuickPick). Titulek je levný (jen hlavička),
// takže i 45 session je v pohodě; navíc cachovaný dle mtime.
function listAllSessions(projectDir) {
  return listSessionsMeta(projectDir).map((s) => ({
    ...s,
    // Jméno, které session dal uživatel, má přednost před `ai-title`
    // z transcriptu: do transcriptu se nezapisuje, takže bez tohohle
    // kroku se přejmenování v přepínači vůbec neprojeví. Jméno odvozené
    // Claude Codem (`derived`, typu `claude-tools-88`) přednost nemá —
    // titulek z transcriptu říká víc.
    title:
      (s.liveNameSource === 'user' && s.liveName) ||
      readSessionTitleCheap(s.file) ||
      s.id.slice(0, 8),
    titled: !!(s.liveNameSource === 'user' && s.liveName) || sessionHasAiTitle(s.file),
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
  return resolveActiveSession(projectDir).file;
}

// Kterou session panel sleduje a proč:
//   pinned — uživatel ji vybral v přepínači (má přednost před vším)
//   tab    — patří k aktivnímu tabu Claude Code
//   newTab — aktivní tab je nová session bez transcriptu → žádná data
//   latest — nic z toho, bere se naposledy změněný transcript
function resolveActiveSession(projectDir) {
  const sessions = listSessionsMeta(projectDir); // jen stat, žádné čtení obsahu
  const sel = getSelectedSessionId();
  if (sel) {
    const found = sessions.find((s) => s.id === sel);
    if (found) return { file: found.file, via: 'pinned' };
  }
  if (_claudeTabLabel) {
    const m = sessionForTab(_claudeTabLabel, listAllSessions(projectDir));
    if (m === NEW_TAB) return { file: null, via: 'newTab' };
    if (m) return { file: m.file, via: 'tab' };
  }
  return { file: sessions.length ? sessions[0].file : null, via: 'latest' };
}

// ---------- session podle aktivního tabu Claude Code ----------
//
// Claude Code neprozradí, kterou session má tab otevřenou. Tab ale nese jako
// název její titulek (`ai-title`, po přejmenování jméno od uživatele), takže se
// páruje podle něj. Při otevření tabu Claude Code titulek zkrátí na 24 znaků
// + „…", pozdější přejmenování tabu už ne. Nová session bez titulku se
// jmenuje „Claude Code". Když párování není jednoznačné, panel zůstane na
// naposledy změněné session — radši známé chování než tipovat.

const CLAUDE_TAB_VIEWTYPE = 'claudeVSCodePanel';
const CLAUDE_TAB_DEFAULT_TITLE = 'Claude Code';
const NEW_TAB = Symbol('newTab');
let _claudeTabLabel = null; // název naposledy aktivního tabu Claude Code

function isClaudeTab(tab) {
  const input = tab && tab.input;
  // webview tab má viewType s prefixem (`mainThreadWebview-claudeVSCodePanel`)
  return !!(input && typeof input.viewType === 'string' && input.viewType.endsWith(CLAUDE_TAB_VIEWTYPE));
}

// Přepočítá sledovaný tab; vrací true, když se změnil. Aktivní tab v aktivní
// skupině vyhrává. Když je aktivní něco jiného (soubor), drží se naposledy
// aktivní tab Claude Code, dokud je otevřený — přepnutí do souboru nemá
// panel přehodit na jinou session.
function updateClaudeTab() {
  const groups = vscode.window.tabGroups;
  const active = groups.activeTabGroup && groups.activeTabGroup.activeTab;
  let label = null;
  if (isClaudeTab(active)) {
    label = active.label;
  } else {
    const open = groups.all.flatMap((g) => g.tabs).filter(isClaudeTab);
    if (_claudeTabLabel && open.some((t) => t.label === _claudeTabLabel)) label = _claudeTabLabel;
    else {
      // sledovaný tab zavřený nebo přejmenovaný → aktivní tab Claude Code jiné skupiny
      const other = groups.all.map((g) => g.activeTab).find(isClaudeTab);
      label = other ? other.label : null;
    }
  }
  const changed = label !== _claudeTabLabel;
  _claudeTabLabel = label;
  return changed;
}

function tabTitleMatches(label, title) {
  if (!title) return false;
  if (label === title) return true;
  return label.length > 1 && label.endsWith('…') && title.startsWith(label.slice(0, -1));
}

// Session k názvu tabu: objekt session, NEW_TAB, nebo null (nevíme).
function sessionForTab(label, sessions) {
  if (label === CLAUDE_TAB_DEFAULT_TITLE) {
    // Tab bez titulku: buď session ještě nemá transcript, nebo ho má, ale
    // `ai-title` zatím nepřišel. Jediná živá VS Code session bez titulku je
    // ta druhá možnost; žádná = nová session. Víc = nevíme.
    const untitled = sessions.filter((s) => s.live && s.vscode && !s.titled);
    if (untitled.length === 1) return untitled[0];
    return untitled.length ? null : NEW_TAB;
  }
  let m = sessions.filter((s) => tabTitleMatches(label, s.title));
  if (m.length > 1) m = m.filter((s) => s.live);
  return m.length === 1 ? m[0] : null;
}

// ---------- transcript: co je zdroj pravdy a co jeho kopie ----------

// Claude Code od 2.1.319 zapisuje vedle vlastní konverzace i kopie odeslaného
// požadavku (`api-request`, `api-request-blob`, `api-request-shape`). Nesou
// tytéž `tool_use` bloky, takže kdo počítá výskyty, napočítá je dvakrát —
// v panelu se to projevilo zdvojenými událostmi hlídačů, `2×` u nástrojů,
// které běžely jednou, a nafouknutým počtem volání v detailu agenta.
//
// Blokuje se celá rodina `api-request*`: je to jeden mechanismus a další
// varianta může přibýt stejně tiše jako tyhle.
function jeKopieRequestu(rec) {
  return !!rec && typeof rec.type === 'string' && rec.type.startsWith('api-request');
}

// Druhá pojistka k té první: `tool_use` id je pro každé volání unikátní, takže
// se dá počítat bez ohledu na to, v jakém záznamu se objeví. Filtr typu chrání
// před kopiemi, tohle před čímkoli, co by nám uniklo.
function novyToolUse(videl, c) {
  if (!c || c.type !== 'tool_use') return false;
  const id = c.id;
  if (!id) return true; // bez id se nedá rozhodnout — radši započítat
  if (videl.has(id)) return false;
  videl.add(id);
  return true;
}

// ---------- parsování: poslední seznam úkolů v session ----------

// Seznam úkolů zapisuje Claude Code dvěma nástroji a formáty se liší:
//
//   TodoWrite                     input.todos  [{ content, status, activeForm }]
//   mcp__ccd_turn__update_plan    input.items  [{ content, status }]  + scope
//
// Poznávají se oba. Nový nástroj `activeForm` nemá, ale všude, kde se čte,
// stojí za `&&` a padá zpátky na `content`, takže chybí bez následku.
// Starší session se tím dál čtou — transcript se zpětně nepřepisuje.
const PLAN_TOOLS = new Set(['TodoWrite', 'mcp__ccd_turn__update_plan']);
const PLAN_MARKERS = ['"TodoWrite"', '"mcp__ccd_turn__update_plan"'];

// Předfiltr řádku před JSON.parse — transcript má klidně 20 MB, takže se
// parsuje jen to, co marker obsahuje.
function lineHasPlan(line) {
  return PLAN_MARKERS.some((m) => line.includes(m));
}

// Položky z jednoho tool_use bloku, nebo null když to není zápis seznamu.
// Prázdné pole je platná odpověď (Claude seznam vyprázdnil), proto se
// nerozlišuje od chybějícího jinak než přes null.
function planItemsOf(c) {
  if (!c || c.type !== 'tool_use' || !PLAN_TOOLS.has(c.name) || !c.input) return null;
  if (Array.isArray(c.input.todos)) return c.input.todos;
  if (Array.isArray(c.input.items)) return c.input.items;
  return null;
}

// Transcript (.jsonl) je append-only, takže obsahuje VŠECHNY snapshoty
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
    if (!lineHasPlan(line)) continue;
    let rec;
    try {
      rec = JSON.parse(line);
    } catch {
      continue;
    }
    if (jeKopieRequestu(rec)) continue;
    const msgContent = rec && rec.message && rec.message.content;
    if (!Array.isArray(msgContent)) continue;
    for (const c of msgContent) {
      const items = planItemsOf(c);
      if (items) snaps.push({ ts: rec.timestamp, todos: items });
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

// Jeden průchod session souborem: snapshoty seznamu úkolů + titulek session.
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
    const hasTodo = lineHasPlan(line);
    const hasTitle = !title && line.includes('"ai-title"');
    const hasUser = !firstPrompt && line.includes('"type":"user"');
    if (!hasTodo && !hasTitle && !hasUser) continue;
    let rec;
    try {
      rec = JSON.parse(line);
    } catch {
      continue;
    }
    if (jeKopieRequestu(rec)) continue;
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
        const items = planItemsOf(c);
        if (items) snaps.push({ ts: rec.timestamp, todos: items });
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
  const videlTool = new Set();
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
    if (jeKopieRequestu(r)) continue;
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
      if (!novyToolUse(videlTool, c)) continue; // kopie téhož volání se nepočítá dvakrát
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
// Metadata subagentů ze složky vedle transcriptu: <session>/subagents/*.meta.json.
// Vznikají VŽDY — i pro agenty spuštěné na popředí, které v hlavním transcriptu
// žádný `async_launched` výsledek nezanechají a dřív se tedy do panelu nedostali.
// Klíčem je toolUseId, přes který se agent páruje s `tool_use` v transcriptu.
function readSubagentMetas(sessionFile) {
  const dir = sessionFile.replace(/\.jsonl$/, '') + '/subagents';
  const out = new Map();
  let files;
  try {
    files = fs.readdirSync(dir).filter((f) => f.endsWith('.meta.json'));
  } catch {
    return out; // starší session složku nemá
  }
  for (const f of files) {
    let d;
    try {
      d = JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8'));
    } catch {
      continue;
    }
    if (!d || !d.toolUseId) continue;
    const jsonl = path.join(dir, f.replace(/\.meta\.json$/, '.jsonl'));
    out.set(d.toolUseId, {
      name: typeof d.agentType === 'string' ? d.agentType : 'claude',
      description: typeof d.description === 'string' ? d.description : '',
      foreground: d.requestShape === 'foreground',
      // model, na kterém agent běžel — bývá jiný než model hlavní session
      // (levnější pro rutinní práci), takže to je první věc, kterou chce
      // člověk vědět, když se ptá „proč mi tohle vyšlo takhle".
      model: typeof d.model === 'string' ? d.model : null,
      builtIn: d.isBuiltIn === true,
      depth: typeof d.spawnDepth === 'number' ? d.spawnDepth : null,
      transcript: fs.existsSync(jsonl) ? jsonl : null,
    });
  }
  return out;
}

// ---------- statistiky z transcriptu agenta ----------

// Doba běhu, spotřeba a nástroje, které agent použil. Čte se jeho vlastní
// `.jsonl` ve složce `subagents/`, který má klidně 700 kB — proto cache podle
// mtime a velikosti: doběhlý agent se spočítá jednou, běžícímu se soubor mění,
// takže se přepočte sám.
const _agentStatsCache = new Map();
function readAgentStats(jsonlPath) {
  let st;
  try {
    st = fs.statSync(jsonlPath);
  } catch {
    return null;
  }
  const klic = st.mtimeMs + ':' + st.size;
  const cached = _agentStatsCache.get(jsonlPath);
  if (cached && cached.klic === klic) return cached.stats;

  let content;
  try {
    content = fs.readFileSync(jsonlPath, 'utf8');
  } catch {
    return null;
  }
  let prvni = null;
  let posledni = null;
  let vstup = 0;
  let vystup = 0;
  let toolCalls = 0;
  const nastroje = new Map();
  const videlToolUse = new Set();
  let report = null;
  let reportZHandbacku = false;
  for (const line of content.split('\n')) {
    if (!line) continue;
    let rec;
    try {
      rec = JSON.parse(line);
    } catch {
      continue;
    }
    if (jeKopieRequestu(rec)) continue;
    if (rec.timestamp) {
      if (!prvni) prvni = rec.timestamp;
      posledni = rec.timestamp;
    }
    const msg = rec.message;
    if (!msg) continue;
    const u = msg.usage;
    if (u) {
      vstup += u.input_tokens || 0;
      vystup += u.output_tokens || 0;
    }
    if (!Array.isArray(msg.content)) continue;
    for (const c of msg.content) {
      if (!c || typeof c !== 'object') continue;
      if (c.type === 'tool_use' && typeof c.name === 'string' && novyToolUse(videlToolUse, c)) {
        toolCalls++;
        nastroje.set(c.name, (nastroje.get(c.name) || 0) + 1);
      }
      // Čím se agent vrátil. Buď to napíše textem, nebo — a to je dnes
      // běžnější — předá přes `SubagentHandback`, kde report leží v
      // `input.message`. Handback má přednost: je to ta odpověď určená
      // volajícímu, kdežto poslední text bývá jen průběžná poznámka.
      if (c.type === 'tool_use' && c.name === 'SubagentHandback' && c.input) {
        const zprava = c.input.message || c.input.report || c.input.summary;
        if (typeof zprava === 'string' && zprava.trim()) {
          report = zprava;
          reportZHandbacku = true;
        }
      }
      if (
        !reportZHandbacku &&
        c.type === 'text' &&
        rec.type === 'assistant' &&
        typeof c.text === 'string' &&
        c.text.trim()
      ) {
        report = c.text;
      }
    }
  }
  const doba =
    prvni && posledni ? Math.max(0, Math.round((Date.parse(posledni) - Date.parse(prvni)) / 1000)) : null;
  const stats = {
    durationSec: Number.isFinite(doba) ? doba : null,
    tokens: vstup + vystup,
    toolCalls,
    // nejčastější nástroje první — v detailu se ukáže jen pár prvních
    tools: [...nastroje.entries()].sort((a, b) => b[1] - a[1]).map(([n, c]) => ({ name: n, count: c })),
    report: report ? report.trim() : null,
  };
  _agentStatsCache.set(jsonlPath, { klic, stats });
  return stats;
}

function readSessionAgents(sessionFile, includeActions) {
  const byId = new Map(); // agentId -> { id, name, description, model, outputFile, status, summary }
  const notes = new Map(); // agentId -> { status, summary }
  const byToolUse = new Map(); // tool_use_id -> subagent_type (z Agent tool_use)
  const launchedAt = new Map(); // tool_use_id -> čas spuštění (pořadí ve výpisu)
  const finished = new Set(); // tool_use_id, na který dorazil tool_result = agent doběhl
  const asyncToolUse = new Set(); // tool_use_id agentů, kteří běží na pozadí
  const metas = readSubagentMetas(sessionFile);
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
    if (jeKopieRequestu(r)) continue;
    // Agent/Task tool_use → mapa tool_use_id → subagent_type.
    const mc = r.message && r.message.content;
    if (Array.isArray(mc)) {
      for (const c of mc) {
        if (c && c.type === 'tool_use' && AGENT_TOOLS.has(c.name) && c.input) {
          if (typeof c.input.subagent_type === 'string') byToolUse.set(c.id, c.input.subagent_type);
          launchedAt.set(c.id, r.timestamp ? Date.parse(r.timestamp) : null);
        }
        // Výsledek agenta v hlavním transcriptu = doběhl. U agenta na popředí je
        // to jediný doklad konce, task-notification k němu žádná nepřijde.
        if (c && c.type === 'tool_result' && c.tool_use_id && metas.has(c.tool_use_id)) {
          finished.add(c.tool_use_id);
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
      if (toolUseId) asyncToolUse.add(toolUseId);
      const am = toolUseId ? metas.get(toolUseId) : null;
      byId.set(tur.agentId, {
        id: tur.agentId,
        toolUseId,
        name: byToolUse.get(toolUseId) || 'claude',
        description: tur.description || '',
        // `resolvedModel` z transcriptu má přednost — je to model, se kterým
        // běh opravdu odešel; meta soubor drží zadanou hodnotu.
        model: tur.resolvedModel || (am && am.model) || null,
        builtIn: am ? am.builtIn : false,
        depth: am ? am.depth : null,
        // Trvalý transcript ze `subagents/` má přednost. `outputFile` z výsledku
        // spuštění leží v /tmp a Claude Code ho při restartu session smaže —
        // doběhlý agent by pak v Historii přišel o dobu běhu, tokeny, nástroje
        // i report a zůstal by mu jen model z meta souboru.
        outputFile: (am && am.transcript) || tur.outputFile || null,
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
  // Slouč completion notifikace do agentů běžících na pozadí.
  const agents = [...byId.values()].map((a) => {
    const n = notes.get(a.id);
    const at = a.toolUseId ? launchedAt.get(a.toolUseId) : null;
    if (n) return { ...a, startedAt: at, status: n.status === 'completed' ? 'done' : n.status, summary: n.summary };
    return { ...a, startedAt: at };
  });

  // Agenti, po kterých v transcriptu žádný `async_launched` nezbyl — běželi na
  // popředí a ví o nich jen jejich meta soubor.
  const live = liveSessions();
  const sessionId = path.basename(sessionFile, '.jsonl');
  const sess = live ? live.get(sessionId) : null;
  const sessionLive = live ? !!sess : true;
  // Agent na popředí běží SYNCHRONNĚ uvnitř turnu, takže v session, která čeká
  // na vstup uživatele (idle), běžet nemůže. Tohle je doklad, ne odhad z ticha.
  const turnRunning = live ? !!sess && sess.status === 'busy' : true;
  for (const [tuid, m] of metas) {
    if (asyncToolUse.has(tuid)) continue; // ten už je ve výpisu z async větve
    if (!byToolUse.has(tuid) && !launchedAt.has(tuid)) continue; // meta bez zadání v transcriptu
    let status = 'running';
    let summary = null;
    if (finished.has(tuid)) status = 'done';
    else if (!sessionLive) {
      // Session skončila dřív, než výsledek dorazil — agent tedy neběží, ale ani
      // nedoběhl. Tvrdit „hotovo" by bylo stejně nepravdivé jako „běží".
      status = 'stopped';
      summary = 'session ended before the result arrived';
    } else if (m.foreground && !turnRunning) {
      status = 'stopped';
      summary = 'did not finish — no result reached the conversation';
    }
    agents.push({
      id: tuid,
      toolUseId: tuid,
      name: m.name || byToolUse.get(tuid) || 'claude',
      description: m.description,
      model: m.model,
      builtIn: m.builtIn,
      depth: m.depth,
      outputFile: m.transcript,
      startedAt: launchedAt.get(tuid) || null,
      status,
      summary,
    });
  }

  // Live akce jen pro běžící (a jen když je vyžádáno).
  if (includeActions) {
    for (const a of agents) {
      if (a.status === 'running' && a.outputFile) a.action = readAgentLastAction(a.outputFile);
      // Statistiky stojí průchod transcriptem agenta, takže jen tady — a díky
      // cache v readAgentStats jen jednou, dokud se soubor nezmění.
      if (a.outputFile) a.stats = readAgentStats(a.outputFile);
    }
  }
  // nejnovější spuštěné první; oba zdroje se tím promíchají správně
  agents.sort((a, b) => (b.startedAt || 0) - (a.startedAt || 0));
  return agents;
}

// ---------- parsování: Servers (dev servery na pozadí) ----------

// Porty, na kterých se opravdu poslouchá, indexované podle PID. `lsof` vrací
// všechno na stroji, takže se výsledek páruje až proti stromu procesů session —
// jinak by panel ukázal cizí Postgres jako „tvůj server".
// null = lsof není k mání; pak se o portu netvrdí nic a bere se zadání.
const LSOF_CACHE_MS = 3000;
let _lsofCache = { at: 0, map: null };
function listeningPorts() {
  const now = Date.now();
  if (_lsofCache.map !== null && now - _lsofCache.at < LSOF_CACHE_MS) return _lsofCache.map;
  let map = null;
  try {
    const out = require('child_process').execFileSync(
      'lsof',
      ['-nP', '-iTCP', '-sTCP:LISTEN'],
      { encoding: 'utf8', timeout: 2500, maxBuffer: 4 * 1024 * 1024 }
    );
    map = new Map();
    for (const line of out.split('\n').slice(1)) {
      const col = line.trim().split(/\s+/);
      if (col.length < 9) continue;
      const pid = +col[1];
      const port = (col[8].match(/:(\d+)$/) || [])[1];
      if (!pid || !port) continue;
      if (!map.has(pid)) map.set(pid, new Set());
      map.get(pid).add(+port);
    }
  } catch {
    map = null; // lsof chybí nebo spadl
  }
  _lsofCache = { at: now, map };
  return map;
}

// Celý podstrom procesu včetně kořene. Server často neposlouchá sám — `npm run
// dev` nastartuje node, `uvicorn` si drží workery —, takže PID z Bash volání
// na portu nesedí a hledat se musí i u potomků.
function processSubtree(rootPid, rows) {
  const deti = new Map();
  for (const r of rows) {
    if (!deti.has(r.ppid)) deti.set(r.ppid, []);
    deti.get(r.ppid).push(r.pid);
  }
  const out = [];
  const fronta = [rootPid];
  const videl = new Set();
  while (fronta.length) {
    const pid = fronta.shift();
    if (videl.has(pid)) continue; // pojistka proti cyklu v ps výstupu
    videl.add(pid);
    out.push(pid);
    for (const d of deti.get(pid) || []) fronta.push(d);
  }
  return out;
}

// Ukončí proces i všechno, co nastartoval.
//
// Posílat signál jedné process group nestačí. Claude Code má ve svém shell
// snapshotu zapnutý `monitor`, takže pod bashem dostane VLASTNÍ skupinu každý
// příkaz zvlášť — wrapper jednu, server v něm druhou. Signál skupině wrapperu
// pak server mine, ten osiří pod initem a protože už není potomkem session,
// panel ho přestane vidět a zastavit nejde vůbec. Doloženo na WSL; pod zsh na
// macOS skupinu sdílejí a jeden signál stačil, takže se na to dalo naletět.
//
// Projde se proto celý strom potomků a signál dostane každá skupina v něm,
// plus jednotlivé procesy jako záloha pro případ, že se strom načíst nedá.
function ukonciStrom(pid, pgid, port) {
  if (!pid && !port) return;
  const rows = processTable();
  const pidy = pid ? (rows ? processSubtree(pid, rows) : [pid]) : [];
  const skupiny = new Set();
  if (rows) {
    for (const r of rows) if (pidy.includes(r.pid) && r.pgid) skupiny.add(r.pgid);
  } else if (pgid) {
    skupiny.add(pgid);
  }
  // Pojistka: nikdy nestřílet do skupiny, ve které běží VS Code (a tím pádem
  // i tenhle panel) nebo Claude Code. Když proces svou skupinu s některým z nich
  // sdílí, signál skupině by vzal i je — ověřeno tvrdě při testu, kdy to
  // položilo shell, ze kterého test běžel. V takovém případě zůstanou jen
  // adresné signály jednotlivým procesům.
  const chranene = new Set();
  const mojeSkupina = (rows || []).find((r) => r.pid === process.pid);
  if (mojeSkupina && mojeSkupina.pgid) chranene.add(mojeSkupina.pgid);
  const live = liveSessions();
  if (live && rows) {
    for (const s of live.values()) {
      const sr = rows.find((r) => r.pid === s.pid);
      if (sr && sr.pgid) chranene.add(sr.pgid);
    }
  }
  for (const g of chranene) skupiny.delete(g);
  let doruceno = 0;
  // Nejdřív skupiny — tím padne i to, co proces spustil a co už ve stromu
  // nemusí být vidět (krátkověké potomky `ps` nestihne zachytit).
  for (const g of skupiny) {
    try {
      process.kill(-g, 'SIGTERM');
      doruceno++;
    } catch {
      /* skupina mezitím skončila, nebo ji systém nezná (Windows) */
    }
  }
  // Pak jednotlivé procesy: na platformě bez process groups je tohle jediná
  // cesta, a i jinde dorazí na to, co skupinový signál minul.
  for (const x of pidy) {
    try {
      process.kill(x, 'SIGTERM');
      doruceno++;
    } catch {
      /* už neběží */
    }
  }
  // Server, který se při zastavení odpojil od wrapperu, ve stromu není — osiří
  // pod initem a adresný signál ho mine. Dohledá se proto podle portu: ten
  // panel změřil, když server ještě běžel, takže míří na správný proces.
  if (port) {
    const ports = listeningPorts();
    if (ports) {
      for (const [drzitel, cisla] of ports) {
        if (!cisla.has(port) || pidy.includes(drzitel)) continue;
        try {
          process.kill(drzitel, 'SIGTERM');
          doruceno++;
        } catch {
          /* mezitím skončil */
        }
      }
    }
  }
  if (!doruceno) throw new Error('none of the processes were still running');
}

// Port ze zadání. Používá se, když proces neběží nebo `lsof` nic nevrátil —
// je to tvrzení autora příkazu, ne měření, takže má nižší váhu.
// Databázové porty v proměnných (`…@localhost:55432/db`) se vynechávají:
// zajímá nás port aplikace, ne její závislosti.
function portFromCommand(command) {
  if (typeof command !== 'string') return null;
  // Pořadí je od nejjednoznačnějšího: explicitní přepínač porazí adresu
  // v proměnné, protože ta může patřit databázi, ne aplikaci.
  const vzory = [
    /--port[= ](\d{2,5})/,
    /--server\.port[= ](\d{2,5})/, // streamlit
    /\s-p[= ](\d{2,5})\b/,
    /\bPORT=(\d{2,5})/,
    /\bhttp\.server\s+(\d{2,5})/, // python -m http.server 8000
    /APP_BASE_URL=https?:\/\/[^\s:]+:(\d{2,5})/,
    /0\.0\.0\.0:(\d{2,5})/,
    /localhost:(\d{2,5})\b/,
  ];
  for (const v of vzory) {
    const m = command.match(v);
    if (m) {
      const n = +m[1];
      if (n > 0 && n < 65536) return n;
    }
  }
  return null;
}

// Otisk serveru pro párování s procesem. Liší se od otisku hlídače tím, jak
// zachází s `cd`: u hlídače je to samostatný přípravný řádek a zahazuje se
// celý, kdežto server se běžně spouští jako `cd /nekam && uvicorn …` na jednom
// řádku — tam se musí odříznout jen ta vedoucí část, ne řádek.
function serverFingerprint(command) {
  if (typeof command !== 'string') return null;
  let best = '';
  for (const raw of command.split('\n')) {
    let line = raw.trim();
    // `cd … &&` na začátku pryč, klidně několikrát za sebou
    let predtim;
    do {
      predtim = line;
      line = line.replace(/^cd\s+[^&;|]+(?:&&|;)\s*/, '').trim();
    } while (line !== predtim);
    if (!line || line.startsWith('cd ')) continue;
    if (/[^\x20-\x7E]/.test(line)) continue; // ps vrací jen ASCII spolehlivě
    if (line.length > best.length) best = line;
  }
  best = best.slice(0, 60);
  return best.length >= 8 ? best : null;
}

// Servery spuštěné v téhle session, běžící i doběhlé. Doběhlý nese
// `status: 'stopped'` — panel ho dá pod sbalenou historii stejně jako
// u hlídačů, aby se všechny tři skupiny v Activity chovaly stejně.
//
// Co se za server považuje: příkaz spuštěný na pozadí (`Bash` s
// `run_in_background`), jehož proces žije a poslouchá na portu. Čekací smyčky
// a dávkové úlohy, kterých je na pozadí většina, tím vypadnou samy — žádný
// seznam povolených příkazů se neudržuje.
const _serverCache = new Map();
function readSessionServers(sessionFile) {
  let st;
  try {
    st = fs.statSync(sessionFile);
  } catch {
    return [];
  }
  const klic = st.mtimeMs + ':' + st.size;
  const cached = _serverCache.get(sessionFile);
  let zadani;
  if (cached && cached.klic === klic) {
    zadani = cached.zadani;
  } else {
    zadani = [];
    let content;
    try {
      content = fs.readFileSync(sessionFile, 'utf8');
    } catch {
      return [];
    }
    const podleToolUse = new Map();
    for (const line of content.split('\n')) {
      if (!line.includes('run_in_background') && !line.includes('taskId')) continue;
      let rec;
      try {
        rec = JSON.parse(line);
      } catch {
        continue;
      }
      if (jeKopieRequestu(rec)) continue;
      const mc = rec.message && rec.message.content;
      if (Array.isArray(mc)) {
        for (const c of mc) {
          if (c && c.type === 'tool_use' && c.name === 'Bash' && c.input && c.input.run_in_background) {
            podleToolUse.set(c.id, {
              command: c.input.command || '',
              description: c.input.description || '',
              startedAt: rec.timestamp ? Date.parse(rec.timestamp) : null,
            });
          }
          // taskId dorazí ve výsledku toho volání
          if (c && c.type === 'tool_result' && c.tool_use_id && podleToolUse.has(c.tool_use_id)) {
            const tur = rec.toolUseResult;
            if (tur && typeof tur === 'object' && tur.taskId) {
              podleToolUse.get(c.tool_use_id).taskId = tur.taskId;
            }
          }
        }
      }
    }
    zadani = [...podleToolUse.values()];
    _serverCache.set(sessionFile, { klic, zadani });
  }
  if (!zadani.length) return [];

  const sessionId = path.basename(sessionFile, '.jsonl');
  const live = liveSessions();
  const sess = live ? live.get(sessionId) : null;
  const rows = sess && sess.pid ? processTable() : null;
  const ports = rows ? listeningPorts() : null;

  const out = [];
  // Týž server bývá v transcriptu spuštěný víckrát (doběhl a pustil se znovu)
  // a všechna ta zadání mají stejný otisk, takže by se spárovala s jedním
  // běžícím procesem a panel by ho ukázal několikrát. Proces se proto přiřadí
  // jen jednou — a prochází se od nejnovějšího zadání, protože to popisuje
  // běh, který opravdu žije.
  const pouzite = new Set();
  for (let i = zadani.length - 1; i >= 0; i--) {
    const z = zadani[i];
    const fp = serverFingerprint(z.command);
    if (!fp) continue;
    const proc = rows
      ? rows.find((r) => r.ppid === sess.pid && !pouzite.has(r.pid) && r.command.includes(fp))
      : null;
    if (proc) pouzite.add(proc.pid);
    let port = null;
    let mereno = false;
    if (proc && ports) {
      for (const pid of processSubtree(proc.pid, rows)) {
        const nalezene = ports.get(pid);
        if (nalezene && nalezene.size) {
          port = [...nalezene].sort((a, b) => a - b)[0];
          mereno = true;
          break;
        }
      }
    }
    if (port == null) port = portFromCommand(z.command);
    // Bez portu to není server, ale pořád je to něco, co běží na pozadí —
    // čekací smyčka, dávka, build. Vrací se taky, jen jako `kind: 'background'`;
    // panel je dá do vlastní skupiny, kde nelže tlačítkem na otevření portu.
    out.push({
      kind: port == null ? 'background' : 'server',
      id: z.taskId || (proc ? String(proc.pid) : 'x' + i),
      status: proc ? 'running' : 'stopped',
      pid: proc ? proc.pid : null,
      // Server dostává vlastní process group, takže jde ukončit i s tím, co
      // nastartoval (npm → node, uvicorn → workery). Bez pgid by signál
      // dostal jen shellový wrapper a server by běžel dál.
      pgid: proc ? proc.pgid : null,
      procCommand: proc ? proc.command : null,
      description: z.description,
      command: z.command,
      startedAt: z.startedAt,
      port,
      // true = port změřený přes lsof, false = vyčtený ze zadání
      measured: mereno,
    });
  }
  out.sort((a, b) => (b.startedAt || 0) - (a.startedAt || 0));
  return out;
}

// ---------- parsování: Monitors (hlídače běžící na pozadí) ----------
//
// Monitor je shellová smyčka, kterou Claude pustí na pozadí, aby hlídala vnější
// stav (review na PR, doběh CI, deploy). Od subagenta se liší tím, že nekončí
// jedním výsledkem — hlásí se opakovaně, takže nese TIMELINE událostí, ne stav.
// Zdroje pravdy:
//   • spuštění: tool_use `Monitor` (description, command) + věta v tool_resultu
//     „Monitor started (task <id>, <režim>)" — task id jinde v datech není.
//   • události: <task-notification> s <event> (subagenti tam mají <status>).
//   • ukončení: tool_use `TaskStop` s input.task_id.
//
// POZOR: tentýž event je v transcriptu několikrát (queue-operation při zařazení
// i vyřízení, attachment `queued_command`, user zpráva) — nutná deduplikace.

const MONITOR_START_RE = /Monitor started \(task ([A-Za-z0-9]+)(?:,\s*([^)]*))?\)/;
// Stejný text po delší pauze = nová událost, ne přepis téže — viz dedup níž.
const TASK_EVENT_DEDUP_MS = 120 * 1000;
// Bez tepu déle než násobek intervalu → monitor je nejspíš po smrti (měkký odhad).
// Otisk hlídače pro hledání v `ps`: nejdelší řádek jeho příkazu, který projde
// beze změny do výpisu procesů. Apostrofy a nové řádky Claude Code při spouštění
// escapuje ('\'' → '"'"', \n → \012), diakritika se v ps nemusí shodovat, a
// řádek s `cd` sedí na kdeco — takové řádky se přeskakují.
function monitorFingerprint(command) {
  if (typeof command !== 'string') return null;
  let best = '';
  for (const raw of command.split('\n')) {
    const line = raw.trim();
    if (!line || line.startsWith('cd ')) continue;
    if (/['\\]/.test(line) || /[^\x20-\x7E]/.test(line)) continue;
    if (line.length > best.length) best = line;
  }
  best = best.slice(0, 60);
  return best.length >= 12 ? best : null;
}

// Tabulka běžících procesů. Cache, ať se `ps` nespouští při každém překreslení.
// null = ps není k mání (jiná platforma, chyba) — pak o běhu nic netvrdíme.
const PS_CACHE_MS = 3000;
let _psCache = { at: 0, rows: null };
function invalidateProcessCache() {
  _psCache = { at: 0, rows: null };
}
function processTable() {
  const now = Date.now();
  if (_psCache.rows !== null && now - _psCache.at < PS_CACHE_MS) return _psCache.rows;
  let rows = null;
  try {
    // -ww = neořezávat příkaz podle šířky terminálu
    const out = require('child_process').execFileSync('ps', ['-ewwo', 'pid=,ppid=,pgid=,command='], {
      encoding: 'utf8',
      timeout: 2000,
      maxBuffer: 8 * 1024 * 1024,
    });
    rows = [];
    for (const line of out.split('\n')) {
      const m = line.match(/^\s*(\d+)\s+(\d+)\s+(\d+)\s+([\s\S]*)$/);
      if (m) rows.push({ pid: +m[1], ppid: +m[2], pgid: +m[3], command: m[4] });
    }
  } catch {
    rows = null;
  }
  _psCache = { at: now, rows };
  return rows;
}

// Proces hlídače. Páruje se dvěma nezávislými znaky: musí být POTOMKEM procesu
// té session (jeho PID je v ~/.claude/sessions/<pid>.json) a jeho příkaz musí
// nést otisk hlídače. Samotný otisk by mohl sednout na cizí proces.
// Vrací { known: false } když se to nedá rozhodnout — chybějící informace se
// nesmí vydávat za doklad, že hlídač neběží.
function monitorProcess(sessionId, command) {
  const fp = monitorFingerprint(command);
  if (!fp) return { known: false, proc: null };
  const live = liveSessions();
  const sess = live ? live.get(sessionId) : null;
  if (!sess || !sess.pid) return { known: false, proc: null };
  const rows = processTable();
  if (!rows) return { known: false, proc: null };
  const proc = rows.find((r) => r.ppid === sess.pid && r.command.includes(fp)) || null;
  return { known: true, proc };
}

// POZN.: dřív se tu z mlčení monitoru usuzovalo, že doběhl. Je to opačně —
// dobře napsaný hlídač hlásí jen ZMĚNY, takže ticho je jeho normální provoz a
// mtime výstupního souboru je čas posledního hlášení, ne tep. Stav se proto
// řídí jen tvrdými doklady konce: TaskStop, hláška Claude Code o vypršení,
// vypršený vlastní timeout a konec session. Monitor zabitý zvenčí nepoznáme.

// Z <task-notification> vytáhne událost monitoru (nemá <status> jako subagent).
function parseTaskEvent(text) {
  if (typeof text !== 'string' || !text.includes('<task-notification>')) return null;
  const id = text.match(/<task-id>([^<]+)<\/task-id>/);
  const ev = text.match(/<event>([\s\S]*?)<\/event>/);
  if (!id || !ev) return null;
  const event = ev[1].trim();
  if (!event) return null;
  return { id: id[1].trim(), event };
}

// Nejčastější `sleep N` v shellovém textu — v chybové větvi bývá vlastní sleep.
function sleepFromShell(text) {
  const counts = new Map();
  for (const m of text.matchAll(/\bsleep\s+(\d+)/g)) {
    const n = parseInt(m[1], 10);
    if (n > 0) counts.set(n, (counts.get(n) || 0) + 1);
  }
  let best = null;
  for (const [n, c] of counts) if (!best || c > best[1]) best = [n, c];
  return best ? best[0] : null;
}

// Interval hlídání: `sleep 60` → 60. Monitor ale často jen spouští skript
// (`bash …/watch_prs.sh`) a smyčka je až uvnitř něj, tak se dočte i ten.
function monitorInterval(command) {
  if (typeof command !== 'string') return null;
  const direct = sleepFromShell(command);
  if (direct) return direct;
  const ref = command.match(/(?:^|\s)(?:bash|sh|zsh)\s+(\/[^\s'"]+)/);
  if (ref) {
    try {
      const st = fs.statSync(ref[1]);
      if (st.isFile() && st.size < 256 * 1024) return sleepFromShell(fs.readFileSync(ref[1], 'utf8'));
    } catch {
      /* skript zmizel (scratchpad se uklízí) — interval prostě neznáme */
    }
  }
  return null;
}

// Režim životnosti z věty tool_resultu. Tři tvary, které Claude Code píše:
//   „persistent — runs until TaskStop or session end"
//   „expires in 30m unless the source ends first; …"
//   „timeout 3600000ms"
function monitorLifetime(mode) {
  if (typeof mode !== 'string') return { persistent: false, ms: null };
  if (mode.includes('persistent')) return { persistent: true, ms: null };
  const min = mode.match(/expires in (\d+)\s*m/);
  if (min) return { persistent: false, ms: parseInt(min[1], 10) * 60 * 1000 };
  const ms = mode.match(/timeout (\d+)\s*ms/);
  if (ms) return { persistent: false, ms: parseInt(ms[1], 10) };
  return { persistent: false, ms: null };
}


// Syrový parse monitorů z transcriptu — bez stavu, který závisí na čase.
// Cachuje se podle mtime+velikosti, protože Monitors se čtou ze VŠECH živých session
// projektu a transcript má klidně pár MB; bez cache by každý refresh znamenal
// přečíst je všechny znovu.
const _monitorCache = new Map(); // soubor -> { mtime, size, parsed }

function emptyMonitorState() {
  return {
    byId: new Map(), // taskId -> { id, description, command, interval, … }
    byToolUse: new Map(), // tool_use_id -> vstup Monitoru (task id je až ve výsledku)
    events: new Map(), // taskId -> [{ at, text }]
    stopped: new Set(), // taskId, na který padl TaskStop
    ended: new Map(), // taskId -> čas, kdy Claude Code ohlásil konec hlídání
  };
}

// Doplní stav o monitory z dalších řádků transcriptu. Je additivní, takže se dá
// volat i jen na nově přibylý kus souboru.
function parseMonitorLines(text, state) {
  const { byId, byToolUse, events, stopped, ended } = state;
  for (const line of text.split('\n')) {
    const hasMonitor = line.includes('Monitor');
    const hasNote = line.includes('<task-notification>');
    const hasStop = line.includes('TaskStop');
    if (!hasMonitor && !hasNote && !hasStop) continue;
    let r;
    try {
      r = JSON.parse(line);
    } catch {
      continue;
    }
    // Kopie požadavku nese tytéž bloky bez časové značky, takže se události
    // hlídače objevovaly dvakrát — jednou s časem a jednou bez něj.
    if (jeKopieRequestu(r)) continue;
    const ts = r.timestamp ? Date.parse(r.timestamp) : null;
    const mc = r.message && r.message.content;
    if (Array.isArray(mc)) {
      for (const c of mc) {
        if (!c) continue;
        // Zadání monitoru — task id tady ještě není, drží se přes tool_use_id.
        if (c.type === 'tool_use' && c.name === 'Monitor' && c.input) {
          byToolUse.set(c.id, {
            description: typeof c.input.description === 'string' ? c.input.description : '',
            command: typeof c.input.command === 'string' ? c.input.command : '',
            at: ts,
          });
        }
        if (c.type === 'tool_use' && c.name === 'TaskStop' && c.input && c.input.task_id) {
          stopped.add(String(c.input.task_id));
        }
        // Výsledek se startovní větou → teprve tady se dozvíme task id.
        // Musí ale patřit ke KONKRÉTNÍMU Monitor tool_use: tutéž větu nese i
        // výstup běžného příkazu, když si někdo transcript grepuje (tahle
        // extension to dělá), a z takového textu by vznikl duch monitoru.
        if (c.type === 'tool_result' && byToolUse.has(c.tool_use_id)) {
          const raw = typeof c.content === 'string' ? c.content : JSON.stringify(c.content || '');
          const m = raw.match(MONITOR_START_RE);
          if (m) {
            const spec = byToolUse.get(c.tool_use_id);
            const life = monitorLifetime(m[2]);
            byId.set(m[1], {
              id: m[1],
              description: spec.description,
              command: spec.command,
              interval: monitorInterval(spec.command),
              persistent: life.persistent,
              lifetimeMs: life.ms,
              startedAt: spec.at || ts,
            });
          }
        }
      }
    }
    // Události: queue-operation (r.content), attachment i user zpráva.
    if (hasNote) {
      const texts = [];
      if (typeof r.content === 'string') texts.push(r.content);
      if (r.attachment && typeof r.attachment.prompt === 'string') texts.push(r.attachment.prompt);
      if (typeof mc === 'string') texts.push(mc);
      else if (Array.isArray(mc)) for (const c of mc) if (c && typeof c.text === 'string') texts.push(c.text);
      for (const t of texts) {
        // Notifikace se <status> místo <event> hlásí konec tasku (doběhl, spadl,
        // byl zastaven) — druhý tvrdý doklad konce vedle hlášky o vypršení.
        const fin = t.match(/<task-id>([^<]+)<\/task-id>[\s\S]*?<status>([^<]+)<\/status>/);
        if (fin) {
          const fid = fin[1].trim();
          if (ts && (!ended.has(fid) || ts < ended.get(fid))) ended.set(fid, ts);
        }
        const e = parseTaskEvent(t);
        if (!e) continue;
        // Hlášky v hranatých závorkách nejsou od hlídače, ale o něm: „[Monitor
        // expired after 30m …]" je tvrdý doklad, že doběhl — lepší než dopočet
        // z timeoutu. Do timeline nepatří, prázdné „[]" taky ne.
        if (/^\[Monitor\b/.test(e.event)) {
          if (ts && (!ended.has(e.id) || ts < ended.get(e.id))) ended.set(e.id, ts);
          continue;
        }
        if (e.event === '[]') continue;
        const list = events.get(e.id) || [];
        // Dedup: tentýž text zapsaný několikrát v rámci jednoho doručení je jedna
        // událost; po delší pauze jde o nový výskyt (monitor hlásí stále stejné).
        const dup = list.find((x) => x.text === e.event && Math.abs((x.at || 0) - (ts || 0)) < TASK_EVENT_DEDUP_MS);
        if (dup) {
          if (ts && (!dup.at || ts < dup.at)) dup.at = ts; // drž nejstarší čas doručení
          continue;
        }
        list.push({ at: ts, text: e.event });
        events.set(e.id, list);
      }
    }
  }
  return state;
}

// Přečte kus souboru [from, to) jako text.
function readRange(file, from, to) {
  const len = to - from;
  if (len <= 0) return '';
  const fd = fs.openSync(file, 'r');
  try {
    const buf = Buffer.alloc(len);
    const bytes = fs.readSync(fd, buf, 0, len, from);
    return buf.toString('utf8', 0, bytes);
  } finally {
    fs.closeSync(fd);
  }
}

// Parse s cache. Transcript je append-only, takže když soubor jen narostl, čte se
// POUZE přírůstek — jinak by každý zápis do běžící session znamenal přeparsovat
// klidně 11 MB při každém refreshi panelu.
function cachedMonitors(sessionFile) {
  let st;
  try {
    st = fs.statSync(sessionFile);
  } catch {
    return emptyMonitorState();
  }
  const hit = _monitorCache.get(sessionFile);
  if (hit && hit.size === st.size && hit.mtime === st.mtimeMs) return hit.state;
  let state;
  let from = 0;
  if (hit && st.size > hit.parsedTo) {
    state = hit.state; // dočítáme, co přibylo za koncem posledního celého řádku
    from = hit.parsedTo;
  } else {
    state = emptyMonitorState(); // první čtení nebo soubor přepsán/zkrácen
  }
  let text;
  try {
    text = readRange(sessionFile, from, st.size);
  } catch {
    return state;
  }
  // Poslední řádek může být rozepsaný — zpracuje se až příště, až bude celý.
  const cut = text.lastIndexOf('\n');
  const usable = cut >= 0 ? text.slice(0, cut + 1) : '';
  parseMonitorLines(usable, state);
  _monitorCache.set(sessionFile, {
    size: st.size,
    mtime: st.mtimeMs,
    parsedTo: from + Buffer.byteLength(usable, 'utf8'),
    state,
  });
  // strop, ať mapa neroste s každou session projektu
  if (_monitorCache.size > 24) _monitorCache.delete(_monitorCache.keys().next().value);
  return state;
}

// Monitory jedné session: nejnovější spuštěné první, každý s timeline událostí.
// sessionLive = běží ještě proces té session (persistent monitor s ní umírá).
function readSessionMonitors(sessionFile, sessionLive) {
  const { byId, events, stopped, ended } = cachedMonitors(sessionFile);
  const now = Date.now();
  const sessionId = path.basename(sessionFile, '.jsonl');
  const monitors = [...byId.values()].map((t) => {
    const list = (events.get(t.id) || []).sort((a, b) => (a.at || 0) - (b.at || 0));
    let status;
    let proc = null; // proces hlídače, když se ho podařilo najít (→ dá se zastavit)
    if (stopped.has(t.id)) status = 'stopped'; // explicitní TaskStop
    else if (ended.has(t.id)) status = 'expired'; // Claude Code ohlásil konec hlídání
    else if (!sessionLive) status = 'ended'; // persistent monitor nepřežije svou session
    else if (t.lifetimeMs && t.startedAt && now > t.startedAt + t.lifetimeMs) status = 'expired';
    else {
      // Session žije a nic konec neohlásilo — což ale neznamená, že smyčka běží:
      // umí odejít i bez oznámení. Poslední slovo má seznam procesů.
      const hit = monitorProcess(sessionId, t.command);
      status = hit.known && !hit.proc ? 'ended' : 'running';
      if (hit.proc) proc = hit.proc;
    }

    return {
      id: t.id,
      description: t.description || 'Monitor ' + t.id,
      interval: t.interval,
      persistent: t.persistent,
      startedAt: t.startedAt,
      // kdy hlídač sám skončí; null u persistent (ten drží až do konce session)
      expiresAt: t.lifetimeMs && t.startedAt ? t.startedAt + t.lifetimeMs : null,
      // podklady pro zastavení: bez PID tlačítko nemá co dělat
      pid: proc ? proc.pid : null,
      pgid: proc ? proc.pgid : null,
      procCommand: proc ? proc.command : null,
      status,
      events: list.map((e) => ({ at: e.at, text: e.text })),
    };
  });
  monitors.reverse(); // nejnovější spuštěné první
  return monitors;
}

// Zkrácený formát tokenů: 528310 → "528k", 1234567 → "1.2M".
function fmtTokens(n) {
  if (!n) return '0';
  if (n >= 1000000) return (n / 1000000).toFixed(1).replace(/\.0$/, '') + 'M';
  if (n >= 1000) return Math.round(n / 1000) + 'k';
  return String(n);
}

// Ceník API v $/MTok (stav 11/2026): [model, základní vstup, čtení z cache].
// Zápis do cache stojí 2× základ při 1h TTL, 1,25× při 5min TTL. První shoda vyhrává.
const CACHE_PRICES = [
  [/fable-5-2|mythos-5-2/, 8, 0.2],
  [/fable-5-1|mythos-5-1/, 10, 0.25],
  [/fable|mythos/, 10, 1],
  [/opus-5-5/, 4, 0.2],
  [/opus/, 5, 0.5],
  [/sonnet-5-5/, 2, 0.1],
  [/sonnet-5/, 2, 0.2],
  [/sonnet/, 3, 0.3],
  [/haiku-5/, 0.1, 0.01],
  [/haiku/, 1, 0.1],
];
// Neznámý model → sazba Opus 5.5.
const CACHE_PRICE_DEFAULT = CACHE_PRICES.find(([re]) => re.test('claude-opus-5-5'));

// Prompt cache: kdy vychladne a kolik by stál studený start. Cache žije TTL od
// ZAČÁTKU posledního požadavku (každé čtení ji obnoví). Začátek má dva zdroje:
// `api-request` záznam (zapisuje ho jen session z VS Code UI a desktop appky)
// a čas user záznamu (prompt / tool_result), který požadavek spustil. Platí
// pozdější z nich: `api-request` zastará, když se session z UI obnoví
// v terminálu, a o právě běžícím požadavku ví zase jen `api-request`.
// TTL z `cacheControl` požadavku, jinak z rozpadu `usage.cache_creation`.
function promptCacheInfo({ lines, lastUsageIdx, lastRequestIdx, ttl, model, tokens }) {
  let apiAt = 0;
  let apiTtl = null;
  if (lastRequestIdx >= 0) {
    try {
      const r = JSON.parse(lines[lastRequestIdx]);
      apiAt = Date.parse(r.timestamp) || 0;
      const cc = Array.isArray(r.cacheControl) ? r.cacheControl : [];
      const last = cc.length ? cc[cc.length - 1].value : null;
      if (last && (last.ttl === '1h' || last.ttl === '5m')) apiTtl = last.ttl;
    } catch {
      /* poškozený řádek — zbude čas z user záznamu */
    }
  }
  let userAt = 0;
  if (lastUsageIdx >= 0) {
    // jen pár řádků zpět, ať se neparsuje celý (velký) transcript
    for (let i = lastUsageIdx - 1; i >= Math.max(0, lastUsageIdx - 200); i--) {
      if (!lines[i].includes('"type":"user"')) continue;
      try {
        const r = JSON.parse(lines[i]);
        // shrnutí po kompakci nese čas shrnuté konverzace, ne požadavku
        if (r.type !== 'user' || r.isSidechain || r.isCompactSummary) continue;
        userAt = Date.parse(r.timestamp) || 0;
        break;
      } catch {
        continue;
      }
    }
  }
  const requestAt = Math.max(apiAt, userAt);
  if (apiTtl && apiAt >= userAt) ttl = apiTtl;
  if (!requestAt || !ttl || !tokens) return null;
  const [, base, read] = CACHE_PRICES.find(([re]) => re.test(model || '')) || CACHE_PRICE_DEFAULT;
  const write = base * (ttl === '1h' ? 2 : 1.25);
  return {
    expiresAt: requestAt + (ttl === '1h' ? 3600 : 300) * 1000,
    ttl,
    tokens,
    coldUsd: (tokens / 1e6) * write,
    warmUsd: (tokens / 1e6) * read,
  };
}

// Reasoning effort: assistant záznamy nesou na nejvyšší úrovni `effort`
// (novější verze i `perTurnEffort`; starší Claude Code, nebo model bez effortu,
// pole nemá vůbec). Hodnoty jsou ověřené na reálných transcriptech; `low` se
// v nich nevyskytl, ale patří do stupnice. Neznámá hodnota = bez štítku.
// `settings.json` jako zdroj nejde: `modelSettings.*.effortLevel` je jen výchozí
// volba pro model, ne to, na čem session skutečně běžela.
const EFFORT_LABELS = new Map([
  ['low', 'Low'],
  ['medium', 'Med'],
  ['high', 'High'],
  ['xhigh', 'XHigh'],
  ['max', 'Max'],
]);

// Usage aktivní session z `usage` bloků assistant záznamů.
// Context window = input + cache_creation + cache_read posledního turnu.
function readSessionUsage(sessionFile) {
  let outputTotal = 0;
  let inputTotal = 0;
  let cacheReadTotal = 0;
  let cacheWriteTotal = 0;
  let contextTokens = 0;
  let lastOutput = 0;
  let maxContext = 0;
  let model = null;
  let ttl = null;
  let lastUsageIdx = -1;
  let lastRequestIdx = -1;
  let effortLabel = null;
  let cwd = null; // kde session právě je (sleduje `cd` i vstup do worktree)
  let firstCwd = null; // kde začala — fallback pro git, když `cwd` není repo
  let content;
  try {
    content = fs.readFileSync(sessionFile, 'utf8');
  } catch {
    return null;
  }
  const lines = content.split('\n');
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    // `type` je u těchto záznamů první klíč → startsWith místo druhého průchodu
    // každým (i mnohamegovým) řádkem; parsuje se až ten poslední (promptCacheInfo)
    if (line.startsWith('{"type":"api-request"')) {
      lastRequestIdx = i;
      continue;
    }
    if (!line.includes('"usage"')) continue;
    let r;
    try {
      r = JSON.parse(line);
    } catch {
      continue;
    }
    const m = r.message;
    if (!m || m.role !== 'assistant' || !m.usage) continue;
    // Syntetická zpráva (API chyba, přerušení) nemá skutečný turn ani model,
    // jen nulové usage — přepsala by kontext na 0 a model na `<synthetic>`.
    if (m.model === '<synthetic>') continue;
    const u = m.usage;
    model = m.model || model;
    outputTotal += u.output_tokens || 0;
    inputTotal += u.input_tokens || 0;
    cacheReadTotal += u.cache_read_input_tokens || 0;
    // Zápis do cache je ta drahá položka: když cache vychladne, celý kontext
    // se uloží znovu za ~1,25 násobku základní sazby. V `input_tokens` se to
    // neobjeví, takže bez tohohle čísla je vychladnutí v panelu neviditelné.
    cacheWriteTotal += u.cache_creation_input_tokens || 0;
    const ctx =
      (u.input_tokens || 0) + (u.cache_creation_input_tokens || 0) + (u.cache_read_input_tokens || 0);
    contextTokens = ctx; // poslední turn = aktuální obsazení
    lastOutput = u.output_tokens || 0;
    if (ctx > maxContext) maxContext = ctx;
    if (!r.isSidechain) {
      lastUsageIdx = i;
      // Přiřazuje se i `null`: po přepnutí na model bez effortu štítek zmizí,
      // místo aby zůstal viset ten z předchozího modelu. Sidechain (subagent)
      // běží na vlastním effortu a nepatří session.
      effortLabel = EFFORT_LABELS.get(r.effort || r.perTurnEffort) || null;
      if (typeof r.cwd === 'string' && r.cwd) {
        cwd = r.cwd;
        if (!firstCwd) firstCwd = r.cwd;
      }
    }
    const cc = u.cache_creation || {};
    if (cc.ephemeral_1h_input_tokens > 0) ttl = '1h';
    else if (cc.ephemeral_5m_input_tokens > 0) ttl = '5m';
  }
  if (!model && !contextTokens) return null;
  // Limit nejde z modelu spolehlivě vyčíst (sufix [1m] v transcriptu není). Setting přebije.
  // Auto: Opus i Fable jedou s 1M oknem; jinak fallback dle pozorovaného maxima.
  const cfg = vscode.workspace.getConfiguration('claudeTools').get('contextWindow', 'auto');
  let limit;
  if (cfg === '200000') limit = 200000;
  else if (cfg === '1000000') limit = 1000000;
  else limit = (model && /opus|fable/i.test(model)) || maxContext > 200000 ? 1000000 : 200000;
  // další požadavek znovu pošle celý kontext + poslední odpověď
  const cache = promptCacheInfo({
    lines,
    lastUsageIdx,
    lastRequestIdx,
    ttl,
    model,
    tokens: contextTokens + lastOutput,
  });
  return {
    model,
    effortLabel, // hotový štítek (Low…Max) pro webview, nebo null
    cwd,
    firstCwd,
    contextTokens,
    limit,
    outputTotal,
    inputTotal,
    cacheReadTotal,
    cacheWriteTotal,
    cache,
  };
}

// ---------- git status pracovní složky session ----------
//
// Rozhoduje se podle něj, kdy pushnout (push pouští CI, kvóta minut je omezená),
// takže nejdůležitější je počet nepushnutých commitů. Čtení je jedno
// `git status --porcelain=v2 --branch` + název repa + počet záznamů ve stashi,
// bez fetche — nic nečeká na síť. „Za upstreamem" je tedy stav z posledního fetche.

const GIT_TTL_MS = 15 * 1000; // nejčastější přepočet; buildModel běží i každé 2 s
const GIT_TIMEOUT_MS = 3000; // obří repo: radši starý údaj než zaseknutý panel
const GIT_CACHE_MAX = 8;

// Porcelain v2 → počty. Čistá funkce, ať jde otestovat bez gitu.
//   # branch.head <název | (detached)>   # branch.oid <sha | (initial)>
//   # branch.upstream <název>            # branch.ab +<před> -<za>   (jen s upstreamem)
//   1|2 <XY> …  změněná / přejmenovaná   u <XY> …  nesloučená   ? <cesta>  nesledovaná
function parseGitStatus(out) {
  const st = {
    branch: null,
    detached: false,
    oid: '',
    upstream: null,
    ahead: null, // null = bez upstreamu (nebo je smazaný) → nepushnuté se nedají spočítat
    behind: null,
    staged: 0,
    modified: 0,
    untracked: 0,
  };
  for (const line of out.split('\n')) {
    if (line.startsWith('# branch.head ')) {
      const h = line.slice(14).trim();
      st.detached = h === '(detached)';
      st.branch = st.detached ? null : h;
    } else if (line.startsWith('# branch.oid ')) {
      const o = line.slice(13).trim();
      st.oid = o === '(initial)' ? '' : o.slice(0, 7);
    } else if (line.startsWith('# branch.upstream ')) {
      st.upstream = line.slice(18).trim();
    } else if (line.startsWith('# branch.ab ')) {
      const m = line.match(/^# branch\.ab \+(\d+) -(\d+)/);
      if (m) {
        st.ahead = +m[1];
        st.behind = +m[2];
      }
    } else if (line.startsWith('1 ') || line.startsWith('2 ')) {
      // XY: X = index (staging), Y = pracovní strom; '.' = beze změny
      if (line[2] !== '.') st.staged++;
      if (line[3] !== '.') st.modified++;
    } else if (line.startsWith('u ')) {
      st.modified++; // konflikt se počítá jednou, ne do staging i do změn
    } else if (line.startsWith('? ')) {
      st.untracked++;
    }
  }
  return st;
}

// `unknown` = nevíme (timeout, přetečený buffer) → volající ponechá starý údaj.
// Jinak selhání znamená „tady repo není" (git končí kódem 128) nebo složka
// zmizela (smazaný worktree) — obojí vede k dalšímu kandidátovi / bez řádku.
function runGit(cwd, args) {
  return new Promise((resolve) => {
    require('child_process').execFile(
      'git',
      // --no-optional-locks: status si jinak sám zapisuje index a mohl by
      // zablokovat uživatelův vlastní git příkaz
      ['--no-optional-locks', ...args],
      { cwd, timeout: GIT_TIMEOUT_MS, maxBuffer: 16 * 1024 * 1024, windowsHide: true, env: { ...process.env, LC_ALL: 'C' } },
      (err, stdout) => {
        if (!err) return resolve({ ok: true, out: stdout });
        resolve({ ok: false, unknown: !!err.killed || err.code === 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER' });
      }
    );
  });
}

// Zkusí složky popořadě (kde session je, pak kde začala); první, která je repo,
// vyhrává. null = žádná není repo, undefined = nevíme.
async function readGit(cwds) {
  for (const cwd of cwds) {
    const r = await runGit(cwd, ['status', '--porcelain=v2', '--branch']);
    if (r.unknown) return undefined;
    if (!r.ok) continue;
    const st = parseGitStatus(r.out);
    // Název repa: session může `cd` odejít do jiného repa (nebo worktree) a podle
    // samotné větve (`main`) by nešlo poznat, čí stav panel ukazuje. U worktree
    // je to název jeho složky, takže se odliší i od hlavního checkoutu.
    const t = await runGit(cwd, ['rev-parse', '--show-toplevel']);
    st.repo = t.ok ? path.basename(t.out.trim()) : null;
    // Bez stashe `rev-list` končí chybou 128 (refs/stash neexistuje) → 0.
    // Stash je sdílený mezi worktrees, počet je tedy za celé repo.
    const s = await runGit(cwd, ['rev-list', '--walk-reflogs', '--count', 'refs/stash']);
    st.stash = s.ok ? parseInt(s.out, 10) || 0 : 0;
    st.cwd = cwd;
    return st;
  }
  return null;
}

// Cache podle kandidátů. buildModel() běží při každém překreslení, takže git se
// tady nikdy nečeká: vrací poslední známý výsledek hned a přepočet (nejvýš jeden
// naráz, nejdřív po GIT_TTL_MS) spustí na pozadí. Když se výsledek změnil,
// zavolá _onGitChange → překreslení. `allowRun` = false (skrytý panel) jen čte.
const _gitCache = new Map();
let _onGitChange = null;

function gitState(cwds, allowRun) {
  if (!cwds.length) return null;
  const key = cwds.join('\n');
  let e = _gitCache.get(key);
  if (!e) {
    e = { at: 0, state: null, running: false };
    _gitCache.set(key, e);
    // cwd se během session mění; staré klíče nechceme držet donekonečna
    while (_gitCache.size > GIT_CACHE_MAX) _gitCache.delete(_gitCache.keys().next().value);
  }
  if (allowRun && !e.running && Date.now() - e.at >= GIT_TTL_MS) {
    e.running = true;
    readGit(cwds)
      .then((state) => {
        e.at = Date.now();
        if (state === undefined) return; // nevíme → ponech starý údaj
        const changed = JSON.stringify(state) !== JSON.stringify(e.state);
        e.state = state;
        if (changed && _onGitChange) _onGitChange();
      })
      .catch(() => {
        e.at = Date.now();
      })
      .finally(() => {
        e.running = false;
      });
  }
  return e.state;
}

// Tlačítko Obnovit: další překreslení přepočítá hned, ne až po TTL.
function invalidateGitCache() {
  for (const e of _gitCache.values()) e.at = 0;
}

// Kde se git čte: kde session právě je; když tam repo není, kde začala.
// Z `sessions/<pid>.json` je start přesný, u doběhlé session zbývá první `cwd`
// z transcriptu.
function gitCandidates(sessionFile, usage) {
  const id = path.basename(sessionFile, '.jsonl');
  const live = liveSessions();
  const l = live ? live.get(id) : null;
  const start = (l && l.cwd) || usage.firstCwd;
  return [usage.cwd, start].filter((c, i, a) => c && a.indexOf(c) === i);
}

// ---------- parsování: hook hlášky (hook_system_message) ----------
//
// Hook může uživateli vypsat hlášku přes {"systemMessage": "..."} — terminál ji
// ukáže hned, ale VS Code UI Claude Code ne. Claude Code ji ovšem zapíše do
// transcriptu jako attachment `hook_system_message`, odsud ji čteme.
// Víceřádkový systemMessage = víc hlášek (po řádcích, stejně jako v terminálu).

const NOTIF_SEVERITY = { '⚠': 'warning', '✖': 'error', '✗': 'error', '❌': 'error' };

// Vodicí symbol (⚠ / ℹ / ✗ …) určí závažnost a z textu se odstraní — ikonu
// kreslí panel/toast sám, jinak by byla dvakrát.
function parseNotifLine(line) {
  const m = line.match(/^([⚠ℹ✖✗❌])️?\s*/);
  if (!m) return { text: line, severity: 'info' };
  return { text: line.slice(m[0].length), severity: NOTIF_SEVERITY[m[1]] || 'info' };
}

// Hlášky hooků aktivní session, nejnovější první. Identický text sbalí do
// jednoho řádku s počtem výskytů — i napříč hooky (stejné varování opakuje
// SessionStart:startup, :resume po reloadu i Stop hook každý turn).
function readSessionNotifications(sessionFile) {
  let content;
  try {
    content = fs.readFileSync(sessionFile, 'utf8');
  } catch {
    return [];
  }
  const byText = new Map(); // text -> { text, severity, hook, event, ts, count }
  for (const line of content.split('\n')) {
    if (!line.includes('"hook_system_message"')) continue;
    let r;
    try {
      r = JSON.parse(line);
    } catch {
      continue;
    }
    const a = r.attachment;
    if (!a || a.type !== 'hook_system_message' || typeof a.content !== 'string') continue;
    const hook = a.hookName || a.hookEvent || 'hook';
    for (const raw of a.content.split('\n')) {
      const t = raw.trim();
      if (!t) continue;
      const { text, severity } = parseNotifLine(t);
      const prev = byText.get(text);
      if (prev) {
        prev.count += 1;
        prev.ts = r.timestamp || prev.ts;
        prev.hook = hook; // poslední výskyt určuje zobrazený zdroj
        prev.event = a.hookEvent || prev.event;
      } else {
        byText.set(text, { text, severity, hook, event: a.hookEvent || '', ts: r.timestamp || null, count: 1 });
      }
    }
  }
  // ISO timestamp se řadí lexikograficky == chronologicky; nejnovější první
  return [...byText.values()].sort((x, y) => String(y.ts || '').localeCompare(String(x.ts || '')));
}

// Zavřené hlášky (křížek v panelu) — do transcriptu se nesahá, klíče
// `sessionId|text` se drží ve workspaceState. Nová session tak startuje čistá
// a zavřená hláška se nevrátí, ani když ji hook zapíše znovu.
const DISMISSED_NOTIF_KEY = 'claudeTools.dismissedNotifications';
function getDismissedNotifications() {
  return _extContext ? _extContext.workspaceState.get(DISMISSED_NOTIF_KEY) || [] : [];
}
function dismissNotification(key) {
  dismissNotifications([key]);
}

// Zavře několik hlášek naráz (tlačítko Clear all). Jedna aktualizace stavu
// místo N za sebou — workspaceState.update je asynchronní, takže sekvence
// jednotlivých zápisů si navzájem přepíše seznam.
function dismissNotifications(keys) {
  if (!_extContext || !keys || !keys.length) return;
  const nove = keys.filter((k) => typeof k === 'string' && k);
  if (!nove.length) return;
  const vyrazene = new Set(nove);
  const kept = getDismissedNotifications().filter((k) => !vyrazene.has(k));
  // neomezenému růstu seznamu brání strop — starší klíče patří mrtvým sessions
  _extContext.workspaceState.update(DISMISSED_NOTIF_KEY, kept.concat(nove).slice(-300));
}

// Hlášky session k zobrazení: načtené z transcriptu minus zavřené uživatelem.
function visibleNotifications(sessionFile) {
  const sid = path.basename(sessionFile, '.jsonl');
  const dismissed = new Set(getDismissedNotifications());
  return readSessionNotifications(sessionFile)
    .map((n) => ({ ...n, dismissKey: sid + '|' + n.text }))
    .filter((n) => !dismissed.has(n.dismissKey));
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

// Notifications panel — hlášky hooků (systemMessage) aktivní session.
const NOTIF_ICON_COLOR = {
  warning: ['warning', 'editorWarning.foreground'],
  error: ['error', 'editorError.foreground'],
  info: ['info', 'editorInfo.foreground'],
};

class NotificationsProvider extends BaseProvider {
  getChildren() {
    const projectDir = projectDirForWorkspace();
    if (!projectDir) return [placeholder('No Claude session for this workspace')];
    const session = activeSessionFile(projectDir);
    if (!session) return [placeholder('No session (.jsonl) found')];
    const notes = visibleNotifications(session);
    if (!notes.length) return [placeholder('No hook messages in this session')];
    return notes.map((n) => {
      const [icon, color] = NOTIF_ICON_COLOR[n.severity] || NOTIF_ICON_COLOR.info;
      const item = new vscode.TreeItem(n.text, vscode.TreeItemCollapsibleState.None);
      item.iconPath = new vscode.ThemeIcon(icon, new vscode.ThemeColor(color));
      item.description = (n.count > 1 ? n.count + '× · ' : '') + n.hook;
      item.tooltip = n.hook + (n.ts ? ' · ' + fmtTime(n.ts) : '') + '\n' + n.text;
      // inline křížek (viz package.json view/item/context)
      item.contextValue = 'dismissableNotification';
      item.dismissKey = n.dismissKey;
      return item;
    });
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
      item.command = { command: 'claudePanel.openFile', title: 'Open', arguments: [p.file] };
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

// Prahy jako webview (media/webview.js): kontext žlutý od 50 %, červený od 80 %;
// cache zvýrazněná, jen když by studený start stál aspoň CACHE_WARN_USD.
const CACHE_WARN_USD = 1;

function ctxColor(pct) {
  if (pct >= 80) return new vscode.ThemeColor('charts.red');
  if (pct >= 50) return new vscode.ThemeColor('charts.yellow');
  return undefined;
}

function cacheTooltip(c) {
  return (
    `Prompt cache (TTL ${c.ttl}) expires at ${fmtTime(c.expiresAt)}.\n` +
    `Next message re-sends ${fmtTokens(c.tokens)} tokens: ` +
    `~$${c.warmUsd.toFixed(2)} while warm, ~$${c.coldUsd.toFixed(2)} once cold (API list price).`
  );
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
    ctx.iconPath = new vscode.ThemeIcon('window', ctxColor(pct));
    items.push(ctx);
    if (u.cache) {
      // TreeView se neobnovuje časovačem → absolutní čas místo odpočtu (nezastará)
      const c = u.cache;
      const isCold = c.expiresAt <= Date.now();
      const cost = `~$${c.coldUsd.toFixed(2)}`;
      const label = isCold
        ? `Cache: cold since ${fmtTime(c.expiresAt)} · next message ${cost}`
        : `Cache: warm until ${fmtTime(c.expiresAt)} · cold start ${cost}`;
      const cch = new vscode.TreeItem(label, LEAF);
      cch.iconPath = new vscode.ThemeIcon(
        'watch',
        isCold && c.coldUsd >= CACHE_WARN_USD ? new vscode.ThemeColor('charts.red') : undefined
      );
      cch.tooltip = cacheTooltip(c);
      items.push(cch);
    }
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
// `gitLive`: panel je vidět → smí se spustit přepočet gitu (jinak jen cache).
function buildModel({ gitLive = false } = {}) {
  const folders = vscode.workspace.workspaceFolders;
  const wsPath = folders && folders.length ? folders[0].uri.fsPath : null;
  const projectDir = projectDirForWorkspace();

  // SESSIONS: přepínač živých/paralelních session + která je zrovna sledovaná
  const allSessions = projectDir ? listAllSessions(projectDir) : [];
  const resolved = projectDir ? resolveActiveSession(projectDir) : { file: null, via: 'latest' };
  const activeSession = resolved.file;
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

  // MONITORS: hlídače na pozadí. Na rozdíl od Agents/Tools se NEomezují na
  // sledovanou session — hlídač na PR běží na pozadí a chceš o něm vědět, i když
  // jsi zrovna přepnutý jinam. Sbírá se tedy ze všech ŽIVÝCH session projektu
  // (+ ze sledované, i kdyby doběhla). Persistent monitor umírá se svou session,
  // takže stav běhu se bez informace o jejím životě určit nedá.
  const liveMap = liveSessions();
  const monitors = [];
  for (const s of allSessions) {
    const alive = liveMap ? liveMap.has(s.id) : s.live;
    if (!alive && s.id !== activeSessionId) continue;
    for (const t of readSessionMonitors(s.file, alive)) {
      // odkud hlídač je — null u sledované session, jinak titulek té cizí
      monitors.push({ ...t, session: s.id === activeSessionId ? null : s.title });
    }
  }
  // nejnovější spuštěné první; do skupin podle stavu je rozvrství až webview
  monitors.sort((a, b) => (b.startedAt || 0) - (a.startedAt || 0));

  // SERVERS: dev servery spuštěné na pozadí. Jako Monitors se sbírají ze všech
  // živých session projektu — server běží dál, i když jsi přepnutý jinam.
  const servers = [];
  const backgrounds = [];
  for (const s of allSessions) {
    const alive = liveMap ? liveMap.has(s.id) : s.live;
    // Běžící mají jen živé session; u sledované se čte i historie, aby skupina
    // nezmizela, jakmile poslední úloha doběhne.
    if (!alive && s.id !== activeSessionId) continue;
    for (const sv of readSessionServers(s.file)) {
      const polozka = { ...sv, session: s.id === activeSessionId ? null : s.title };
      (sv.kind === 'background' ? backgrounds : servers).push(polozka);
    }
  }
  const dleStartu = (a, b) => (b.startedAt || 0) - (a.startedAt || 0);
  servers.sort(dleStartu);
  backgrounds.sort(dleStartu);

  // NOTIFICATIONS: hlášky hooků (systemMessage) aktivní session, bez zavřených
  const notifications = (activeSession ? visibleNotifications(activeSession) : []).map((n) => ({
    text: n.text,
    severity: n.severity,
    hook: n.hook,
    count: n.count,
    time: n.ts ? fmtTime(n.ts) : '',
    dismissKey: n.dismissKey,
  }));

  // USAGE: context window + token totals aktivní session
  const usage = activeSession ? readSessionUsage(activeSession) : null;
  // GIT: hlavička panelu pod sledovanou session. Složku určuje `cwd`
  // z transcriptu, proto se bere z téhož průchodu jako Usage. Schovaný
  // řádek (`hiddenSections: git`) git vůbec nespouští.
  const hidden = vscode.workspace.getConfiguration('claudeTools').get('hiddenSections', []);
  let git = null;
  if (usage) {
    if (!hidden.includes('git')) git = gitState(gitCandidates(activeSession, usage), gitLive);
    // cwd slouží jen k volbě složky pro git, webview je nepotřebuje
    delete usage.cwd;
    delete usage.firstCwd;
  }

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
  const sessionList = allSessions.map((s) => ({
    id: s.id,
    title: s.title,
    live: s.live,
    status: s.status, // 'busy' | 'idle' | null — rozlišení tečky v pickeru
    path: s.file,
    mtime: s.mtime, // stáří doběhlé session v hlavičce
  }));

  return {
    progress,
    history,
    context,
    plans,
    tools,
    agents,
    monitors,
    servers,
    backgrounds,
    notifications,
    usage,
    git,
    sessions: sessionList,
    activeSessionId,
    sessionVia: resolved.via, // pinned | tab | newTab | latest
    selectedSessionId: getSelectedSessionId(), // null = auto (tab Claude Code, jinak nejnovější)
    // sekce, které si uživatel trvale schoval (setting) — webview je nevykreslí
    hiddenSections: hidden,
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
    this.view.webview.postMessage({
      type: 'render',
      model: buildModel({ gitLive: !!this.view.visible }),
      skin: appearance(),
    });
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
    } else if (msg.type === 'killTask' && msg.pid) {
      vscode.commands.executeCommand('claudePanel.killTask', {
        pid: msg.pid,
        pgid: msg.pgid || null,
        description: msg.description || '',
        command: msg.command || '',
        kind: msg.kind === 'server' ? 'server' : 'monitor',
        port: typeof msg.port === 'number' ? msg.port : null,
      });
    } else if (msg.type === 'openUrl' && typeof msg.url === 'string') {
      // Jen localhost — panel otevírá dev servery, ne libovolné odkazy
      // z transcriptu. Kdyby se sem dostalo něco jiného, nic se nestane.
      if (/^https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?(\/|$)/.test(msg.url)) {
        vscode.env.openExternal(vscode.Uri.parse(msg.url));
      }
    } else if (msg.type === 'dismissNotifications' && Array.isArray(msg.keys)) {
      vscode.commands.executeCommand('claudePanel.dismissNotifications', msg.keys);
    } else if (msg.type === 'dismissNotification' && msg.key) {
      vscode.commands.executeCommand('claudePanel.dismissNotification', msg.key);
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
  const notifications = new NotificationsProvider();
  const webview = new ClaudeWebviewProvider(context.extensionUri);
  // git se počítá na pozadí; až doběhne a něco se změnilo, překreslí se panel
  _onGitChange = () => webview.refresh();
  updateClaudeTab();

  context.subscriptions.push(
    vscode.window.registerTreeDataProvider('claudeNotifications', notifications),
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

  // Hook hlášky: context klíč (řídí viditelnost tree view Notifications) + toast.
  // Toast jen pro SessionStart hlášky (Stop apod. běží každý turn — jen do panelu),
  // jen jednou (Set) a jen čerstvé — staré hlášky při aktivaci extension netoastí,
  // zůstávají v sekci Notifications.
  const TOAST_FRESH_MS = 5 * 60 * 1000;
  const toasted = new Set();
  const updateNotifications = () => {
    const pd = projectDirForWorkspace();
    const session = pd ? activeSessionFile(pd) : null;
    const notes = session ? visibleNotifications(session) : [];
    vscode.commands.executeCommand('setContext', 'claudeTools.hasNotifications', notes.length > 0);
    if (!session) return;
    for (const n of notes) {
      if (n.event !== 'SessionStart') continue;
      // klíč bez hooku — stejný text po resume session znovu netoastí
      const key = n.dismissKey;
      if (toasted.has(key)) continue;
      toasted.add(key);
      const age = n.ts ? Date.now() - new Date(n.ts).getTime() : Infinity;
      if (!(age < TOAST_FRESH_MS)) continue;
      // Prefix se zdrojem — toast sám o sobě nemá vizuální vazbu na Claude;
      // vlastní ikonu VS Code v notifikacích nepovoluje, emoji v textu ano.
      const msg = '✳ Claude: ' + n.text;
      if (n.severity === 'error') vscode.window.showErrorMessage(msg);
      else if (n.severity === 'warning') vscode.window.showWarningMessage(msg);
      else vscode.window.showInformationMessage(msg);
    }
  };

  const refreshAll = () => {
    notifications.refresh();
    progress.refresh();
    history.refresh();
    context_.refresh();
    tools.refresh();
    usage.refresh();
    plans.refresh();
    webview.refresh();
    syncLivePolling();
    updateNotifications();
  };

  context.subscriptions.push(
    vscode.commands.registerCommand('claudePanel.refresh', () => {
      invalidateGitCache();
      refreshAll();
    }),
    // Auto sleduje aktivní tab Claude Code. Překresluje se jen při změně
    // sledovaného tabu — onDidChangeTabs chodí i kvůli dirty stavu souborů.
    vscode.window.tabGroups.onDidChangeTabs(() => {
      if (updateClaudeTab()) refreshAll();
    }),
    vscode.window.tabGroups.onDidChangeTabGroups(() => {
      if (updateClaudeTab()) refreshAll();
    }),
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
      picks.push({ label: '$(sync) Auto', description: 'active Claude Code tab, otherwise latest session', id: null });
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
    vscode.commands.registerCommand('claudePanel.dismissNotification', (arg) => {
      const key = typeof arg === 'string' ? arg : arg && arg.dismissKey;
      if (!key) return;
      dismissNotification(key);
      refreshAll();
    }),
    vscode.commands.registerCommand('claudePanel.dismissNotifications', (keys) => {
      if (!Array.isArray(keys) || !keys.length) return;
      dismissNotifications(keys);
      refreshAll();
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
    vscode.commands.registerCommand('claudePanel.killTask', async (arg) => {
      if (!arg || !arg.pid) return;
      const detail =
        (arg.description ? arg.description + '\n\n' : '') +
        'PID ' + arg.pid +
        (arg.command ? '\n\n' + String(arg.command).slice(0, 400) : '');
      const choice = await vscode.window.showWarningMessage(
        arg.kind === 'server' ? 'Stop server?' : 'Stop monitor?',
        { modal: true, detail },
        'Stop'
      );
      if (choice !== 'Stop') return;
      try {
        ukonciStrom(arg.pid, arg.pgid, arg.port || null);
      } catch (e) {
        const co = arg.kind === 'server' ? 'Server' : 'Monitor';
        vscode.window.showErrorMessage(`Could not stop ${co.toLowerCase()}: ${e.message}`);
        return;
      }
      invalidateProcessCache();
      refreshAll();
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
  watch(SESSIONS_DIR); // start/konec session a přechody busy↔idle

  // Živost session je funkce BĚŽÍCÍCH PROCESŮ, ne obsahu souborů: proces může
  // spadnout (kill -9) a svůj .json po sobě nechat, takže žádný zápis na disk
  // takovou změnu neohlásí. Bez tikání by picker visel v posledním stavu —
  // přesně ten bug, kdy přepínač zmizel teprve při nesouvisejícím překreslení.
  const LIVENESS_TICK_MS = 30 * 1000;
  const livenessTick = setInterval(() => {
    webview.refresh();
  }, LIVENESS_TICK_MS);

  context.subscriptions.push({
    dispose: () => {
      watchers.forEach((w) => w.close());
      if (livePoll) clearInterval(livePoll);
      clearInterval(livenessTick);
      _onGitChange = null;
    },
  });

  refreshAll();
}

function deactivate() {}

module.exports = { activate, deactivate };
