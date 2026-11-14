// Klient webview pohledu Claude Tools. Dostává model + skin z extension,
// renderuje sekce Progress / History / Context / Plans, stav sbalení drží
// v paměti (přežije re-render při refreshi).
(function () {
  const vscode = acquireVsCodeApi();
  let model = null;
  let skin = 'compact';
  let seeded = false;

  const saved = vscode.getState();
  const collapsed = new Set(saved && saved.collapsed ? saved.collapsed : []);
  // Skupiny, které jsou zavřené, dokud je někdo sám neotevře. Nejde to řešit přes
  // seed() — ten proběhne jednou za život panelu, takže u dřív nainstalované
  // verze se nový klíč do `collapsed` nikdy nedostane a archiv by zůstal otevřený.
  const DEFAULT_CLOSED = new Set(['t:tasks:hist']);
  const isDefaultClosed = (key) => DEFAULT_CLOSED.has(key) || key.startsWith('t:task:');
  const opened = new Set(saved && saved.opened ? saved.opened : []);
  if (saved && saved.seeded) seeded = true;

  function persist() {
    vscode.setState({ collapsed: [...collapsed], opened: [...opened], seeded: true });
  }
  function isOpen(key) {
    if (isDefaultClosed(key)) return opened.has(key);
    return !collapsed.has(key);
  }
  function toggle(key) {
    const set = isDefaultClosed(key) ? opened : collapsed;
    if (set.has(key)) set.delete(key);
    else set.add(key);
    persist();
    render();
  }

  function esc(s) {
    return String(s == null ? '' : s)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  }

  function fmtTok(n) {
    if (!n) return '0';
    if (n >= 1000000) return (n / 1000000).toFixed(1).replace(/\.0$/, '') + 'M';
    if (n >= 1000) return Math.round(n / 1000) + 'k';
    return String(n);
  }

  // Při prvním modelu nastav rozumné defaulty sbalení (jako TreeView).
  function seed() {
    if (seeded || !model) return;
    seeded = true;
    (model.history || []).forEach((day, di) => {
      if (di > 0) collapsed.add('d:' + day.date);
      (day.sessions || []).forEach((s) => {
        (s.batches || []).forEach((_, bi) => collapsed.add('b:' + s.id + ':' + bi));
      });
    });
    collapsed.add('c:Personal');
    collapsed.add('c:Local');
    collapsed.add('c:Project:mem');
    ((model.tools && model.tools.mcp) || []).forEach((m) => collapsed.add('t:mcp:' + m.server));
    persist();
  }

  function caret(key) {
    return '<span class="caret codicon codicon-chevron-' + (isOpen(key) ? 'down' : 'right') + '"></span>';
  }

  function group(key, headerInner, bodyHtml, extraHeaderClass) {
    const open = isOpen(key);
    return (
      '<div class="group">' +
      '<div class="ghdr ' + (extraHeaderClass || '') + '" data-toggle="' + esc(key) + '">' +
      caret(key) + headerInner + '</div>' +
      '<div class="gbody"' + (open ? '' : ' hidden') + '>' + bodyHtml + '</div>' +
      '</div>'
    );
  }

  function fileRow(it) {
    const icon = '<span class="ico codicon codicon-file"></span>';
    const descText = it.exists ? it.desc || '' : '(missing)';
    const txt =
      '<span class="txt"><span class="lbl">' + esc(it.label) + '</span>' +
      (descText ? '<span class="desc">' + esc(descText) + '</span>' : '') +
      '</span>';
    let del = '';
    if (it.del) {
      del =
        '<button class="del" title="Delete" data-del-path="' + esc(it.path) + '"' +
        ' data-del-kind="' + esc(it.del.kind) + '"' +
        (it.del.index ? ' data-del-index="' + esc(it.del.index) + '"' : '') +
        (it.del.link ? ' data-del-link="' + esc(it.del.link) + '"' : '') +
        '><i class="codicon codicon-trash"></i></button>';
    }
    const cls = it.exists ? 'row file' : 'row file missing';
    const open = it.exists ? ' data-open="' + esc(it.path) + '"' : '';
    return '<div class="' + cls + '"' + open + '>' + icon + txt + del + '</div>';
  }

  function taskRow(t) {
    const st = t.status || 'pending';
    const icon = st === 'completed' ? 'check' : st === 'in_progress' ? 'circle-filled' : 'circle-outline';
    const cls = st === 'completed' ? 'st-done' : st === 'in_progress' ? 'st-prog' : 'st-pend';
    return (
      '<div class="row task t-' + st + '"><span class="ico ' + cls + ' codicon codicon-' + icon + '"></span>' +
      '<span class="lbl">' + esc(t.content) + '</span></div>'
    );
  }

  // Přepínač session — jen když projekt běží ve víc session NARÁZ (2+ živé).
  // Archiv session sem nepatří (na ten je tlačítko Select Session → QuickPick).
  // Volba zafixuje (sticky) sledovanou session pro Progress / Tools / Usage.
  // „Živá" = běží její proces (~/.claude/sessions/<pid>.json), ne že nedávno
  // zapsala do transcriptu — session, kde Claude čeká na tvůj vstup, je živá taky.
  function renderSessionPicker() {
    const list = model.sessions || [];
    const active = model.activeSessionId;
    const selected = model.selectedSessionId; // null = auto režim
    // živé + případně právě sledovaná (i když už doběhla), ať je vidět co sleduješ
    const shown = list.filter((s) => s.live || s.id === active);
    if (shown.length < 2) return '';
    const opts = shown
      .map((s) => {
        // v auto režimu je vybraná položka „Auto", ne konkrétní session
        const sel = selected != null && s.id === selected ? ' selected' : '';
        // ● pracuje · ○ čeká na vstup · ◌ už neběží (jen dosledovávaná)
        const dot = !s.live ? '◌ ' : s.status === 'busy' ? '● ' : '○ ';
        return '<option value="' + esc(s.id) + '"' + sel + '>' + dot + esc(s.title) + '</option>';
      })
      .join('');
    const autoSel = selected == null ? ' selected' : '';
    return (
      '<div class="session-picker">' +
      '<span class="sp-label codicon codicon-comment-discussion"></span>' +
      '<select class="sp-select" id="sessionSelect">' +
      '<option value="__auto__"' + autoSel + '>↻ Auto (nejnovější)</option>' +
      opts +
      '</select>' +
      '</div>'
    );
  }

  // Hlášky hooků (systemMessage) — to, co SessionStart/Stop hook vypíše do terminálu.
  function renderNotifications() {
    const ic = { warning: 'warning', error: 'error' };
    return (model.notifications || [])
      .map((n) => {
        const sev = n.severity || 'info';
        const title = esc(n.hook + (n.time ? ' · ' + n.time : ''));
        return (
          '<div class="row notif notif-' + sev + '" title="' + title + '">' +
          '<span class="ico codicon codicon-' + (ic[sev] || 'info') + '"></span>' +
          '<span class="lbl">' + esc(n.text) + '</span>' +
          (n.count > 1 ? '<span class="meta">' + n.count + '×</span>' : '') +
          '<button class="del" title="Dismiss" data-dismiss="' + esc(n.dismissKey) + '"><i class="codicon codicon-close"></i></button>' +
          '</div>'
        );
      })
      .join('');
  }

  function renderProgress() {
    const p = model.progress;
    if (!p || !p.total) {
      return '<div class="empty-hint">No to-dos yet — they show up as Claude works in this session.</div>';
    }
    const items = p.items
      .map((t) => taskRow({ content: t.status === 'in_progress' && t.activeForm ? t.activeForm : t.content, status: t.status }))
      .join('');
    return '<div class="progress-list">' + items + '</div>';
  }

  function renderHistory() {
    if (!model.history || !model.history.length) return '<div class="empty">No history yet</div>';
    return model.history
      .map((day) => {
        const batchCount = day.sessions.reduce((n, s) => n + s.batches.length, 0);
        const sessionsHtml = day.sessions
          .map((s) => {
            const batchesHtml = s.batches
              .map((b, bi) => {
                const hdr =
                  (b.complete
                    ? '<span class="ico st-done codicon codicon-check"></span>'
                    : '<span class="ico st-prog codicon codicon-clock"></span>') +
                  '<span class="lbl">' + esc(b.range) + '</span><span class="meta">' + b.done + '/' + b.total + '</span>';
                const tasks = b.tasks.map(taskRow).join('');
                return group('b:' + s.id + ':' + bi, hdr, tasks);
              })
              .join('');
            const sHdr =
              '<span class="ico codicon codicon-comment-discussion"></span><span class="lbl">' + esc(s.title) + '</span>' +
              '<span class="meta">' + s.batches.length + '×</span>' +
              '<span class="actions">' +
              '<button data-session="' + esc(s.id) + '" data-path="' + esc(s.path) + '" title="Open in Claude Code"><i class="codicon codicon-comment-discussion"></i></button>' +
              '<button data-transcript="' + esc(s.path) + '" title="Raw transcript"><i class="codicon codicon-file-code"></i></button>' +
              '</span>';
            return group('s:' + s.id, sHdr, batchesHtml);
          })
          .join('');
        const dHdr = '<span class="ico codicon codicon-calendar"></span><span class="lbl">' + esc(day.date) + '</span>' +
          '<span class="meta">' + day.sessions.length + ' session · ' + batchCount + '×</span>';
        return group('d:' + day.date, dHdr, sessionsHtml);
      })
      .join('');
  }

  function renderContext() {
    return (model.context || [])
      .map((sc) => {
        let body = (sc.items || []).map(fileRow).join('');
        if (sc.memory && sc.memory.length) {
          const memBody = sc.memory.map(fileRow).join('');
          body += group('c:' + sc.scope + ':mem', '<span class="ico codicon codicon-database"></span><span class="lbl">Auto-memory</span>', memBody);
        }
        const sIcon = sc.scope === 'Personal' ? 'account' : sc.scope === 'Local' ? 'device-desktop' : 'folder';
        const hdr = '<span class="ico codicon codicon-' + sIcon + '"></span><span class="lbl">' + esc(sc.scope) + '</span>';
        return group('c:' + sc.scope, hdr, body);
      })
      .join('');
  }

  function renderTools() {
    const t = model.tools;
    const has =
      t &&
      (t.skills.length ||
        (t.commands && t.commands.length) ||
        t.mcp.length ||
        (t.builtin && t.builtin.length) ||
        (t.agents && t.agents.length));
    if (!has) {
      return '<div class="empty-hint">No skills, commands, tools or MCP used in this session.</div>';
    }
    const cnt = (n) => '<span class="meta">' + n + '×</span>';
    let html = '';
    if (t.skills.length) {
      const body = t.skills
        .map(
          (s) =>
            '<div class="row clickable" data-skill="' + esc(s.name) + '"><span class="ico codicon codicon-zap"></span><span class="lbl">' + esc(s.name) + '</span>' + cnt(s.count) + '</div>'
        )
        .join('');
      html += group('t:skills', '<span class="ico codicon codicon-extensions"></span><span class="lbl">Skills</span>', body);
    }
    if (t.commands && t.commands.length) {
      const body = t.commands
        .map((c) => '<div class="row"><span class="ico codicon codicon-symbol-event"></span><span class="lbl">/' + esc(c.name) + '</span>' + cnt(c.count) + '</div>')
        .join('');
      html += group('t:commands', '<span class="ico codicon codicon-terminal"></span><span class="lbl">Commands</span>', body);
    }
    if (t.builtin && t.builtin.length) {
      const icons = { WebSearch: 'search', WebFetch: 'globe' };
      const body = t.builtin
        .map((b) => '<div class="row"><span class="ico codicon codicon-' + (icons[b.name] || 'tools') + '"></span><span class="lbl">' + esc(b.name) + '</span>' + cnt(b.count) + '</div>')
        .join('');
      html += group('t:builtin', '<span class="ico codicon codicon-tools"></span><span class="lbl">Built-in</span>', body);
    }
    if (t.agents && t.agents.length) {
      const BUILTIN_AGENTS = ['claude', 'general-purpose', 'Explore', 'Plan', 'statusline-setup'];
      const kindOf = (a) => (a.indexOf(':') >= 0 ? 'plugin' : BUILTIN_AGENTS.indexOf(a) >= 0 ? 'builtin' : 'custom');
      const ico = { plugin: 'extensions', custom: 'person', builtin: 'rocket' };
      const body = t.agents
        .map((a) => {
          const k = kindOf(a.name);
          const meta = (k === 'builtin' ? 'built-in' : k) + ' · ' + a.count + '×';
          return (
            '<div class="row"><span class="ico codicon codicon-' +
            ico[k] +
            '"></span><span class="lbl">' +
            esc(a.name) +
            '</span><span class="meta">' +
            meta +
            '</span></div>'
          );
        })
        .join('');
      html += group('t:agents', '<span class="ico codicon codicon-rocket"></span><span class="lbl">Agents</span>', body);
    }
    if (t.mcp.length) {
      const servers = t.mcp
        .map((m) => {
          const tools = m.tools
            .map((tool) => '<div class="row"><span class="ico codicon codicon-symbol-method"></span><span class="lbl">' + esc(tool.name) + '</span>' + cnt(tool.count) + '</div>')
            .join('');
          return group(
            't:mcp:' + m.server,
            '<span class="ico codicon codicon-server"></span><span class="lbl">' + esc(m.server) + '</span><span class="meta">' + m.tools.length + ' · ' + m.count + '×</span>',
            tools
          );
        })
        .join('');
      html += group('t:mcp', '<span class="ico codicon codicon-plug"></span><span class="lbl">MCP</span>', servers);
    }
    return html;
  }

  // Živí subagenti (async Task/Agent): běžící se spinnerem + „právě dělá", pak
  // dokončení / selhání. Cowork-styl přehled souběžné práce hlavního Clauda.
  function renderAgents() {
    const list = model.agents || [];
    if (!list.length) return '<div class="empty-hint">No subagents in this session.</div>';
    const rank = { running: 0, done: 1 }; // běžící nahoře; failed/ostatní dolů
    const sorted = list.slice().sort((a, b) => (rank[a.status] ?? 2) - (rank[b.status] ?? 2));
    const st = {
      running: { ico: 'loading codicon-modifier-spin', cls: 'agent-running' },
      done: { ico: 'pass-filled', cls: 'agent-done' },
    };
    const rows = sorted
      .map((a) => {
        const s = st[a.status] || { ico: 'error', cls: 'agent-failed' };
        const title = esc(a.name + (a.model ? ' · ' + a.model : '') + (a.summary ? '\n' + a.summary : ''));
        const label = esc(a.description || a.name);
        const meta = esc(a.name);
        // běžící → live akce; dokončený → nic (summary „Agent X finished" jen duplikuje
        // popis); selhalý/jiný → summary nese důvod (např. session limit), ten ukážeme
        const action =
          a.status === 'running'
            ? a.action
              ? '<div class="agent-action">▸ ' + esc(a.action) + '</div>'
              : ''
            : a.status === 'done'
              ? ''
              : a.summary
                ? '<div class="agent-action agent-summary">' + esc(a.summary) + '</div>'
                : '';
        return (
          '<div class="agent ' + s.cls + '" title="' + title + '">' +
          '<div class="row"><span class="ico codicon codicon-' + s.ico + '"></span>' +
          '<span class="lbl">' + label + '</span><span class="meta">' + meta + '</span></div>' +
          action +
          '</div>'
        );
      })
      .join('');
    // wrapper → v širokém panelu z něj CSS udělá grid dlaždic (viz @media)
    return '<div class="agent-list">' + rows + '</div>';
  }

  // Prompt cache: odpočet jen v posledních CACHE_WARN_MIN minutách a jen když by
  // studený start stál aspoň CACHE_WARN_USD — údaj, který svítí pořád, časem nikdo
  // nevnímá. Jinak tlumeně „warm · N min". Stejný práh $ drží extension.js (tree).
  const CACHE_WARN_MIN = 25;
  const CACHE_WARN_USD = 1;

  function fmtClock(ts) {
    return new Date(ts).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  }

  function cacheRow(c, now) {
    const left = c.expiresAt - now;
    const cost = '~$' + c.coldUsd.toFixed(2);
    const isPricey = c.coldUsd >= CACHE_WARN_USD;
    const mins = Math.ceil(left / 60000);
    let text;
    let cls = '';
    // texty krátké — sidebar bývá úzký; cena je celá v tooltipu
    if (left <= 0) {
      text = isPricey ? 'cold · next ' + cost : 'cold';
      if (isPricey) cls = ' crit';
    } else if (isPricey && mins <= CACHE_WARN_MIN) {
      text = 'expires in ' + mins + ' min';
      cls = mins <= 5 ? ' crit' : ' warn';
    } else {
      text = 'warm · ' + (mins >= 60 ? Math.floor(mins / 60) + ' h ' : '') + (mins % 60) + ' min';
    }
    const tip =
      'Prompt cache (TTL ' + c.ttl + ') expires at ' + fmtClock(c.expiresAt) + '. ' +
      'Next message re-sends ' + fmtTok(c.tokens) + ' tokens: ~$' + c.warmUsd.toFixed(2) +
      ' while warm, ' + cost + ' once cold (API list price).';
    return (
      '<div class="row cache-row' + cls + '" title="' + esc(tip) + '">' +
      '<span class="ico codicon codicon-watch"></span><span class="lbl">Prompt cache</span>' +
      '<span class="meta">' + esc(text) + '</span></div>'
    );
  }

  // Odpočet běží i bez změny na disku (session v klidu = žádný refresh z extension).
  // Mění se jen text a třída — přepis celého řádku by každý tik zavřel otevřený tooltip.
  setInterval(() => {
    const el = document.querySelector('.cache-row');
    const c = model && model.usage && model.usage.cache;
    if (!el || !c) return;
    const tmp = document.createElement('div');
    tmp.innerHTML = cacheRow(c, Date.now());
    const row = tmp.firstElementChild;
    el.className = row.className;
    el.querySelector('.meta').textContent = row.querySelector('.meta').textContent;
  }, 30000);

  function renderUsage() {
    const u = model.usage;
    if (!u) return '<div class="empty-hint">No usage data yet.</div>';
    const pct = u.limit ? Math.round((u.contextTokens / u.limit) * 100) : 0;
    const level = pct >= 80 ? ' crit' : pct >= 50 ? ' warn' : '';
    return (
      (u.model
        ? '<div class="row"><span class="ico codicon codicon-chip"></span><span class="lbl">Model</span><span class="meta">' + esc(u.model) + '</span></div>'
        : '') +
      '<div class="row"><span class="ico codicon codicon-window"></span><span class="lbl">Context window</span>' +
      '<span class="meta">' + fmtTok(u.contextTokens) + ' / ' + fmtTok(u.limit) + ' · ' + pct + '%</span></div>' +
      '<progress class="ctxbar' + level + '" max="100" value="' + Math.min(100, pct) + '"></progress>' +
      (u.cache ? cacheRow(u.cache, Date.now()) : '') +
      '<div class="row"><span class="ico codicon codicon-arrow-up"></span><span class="lbl">Output</span>' +
      '<span class="meta">' + fmtTok(u.outputTotal) + '</span></div>' +
      '<div class="row"><span class="ico codicon codicon-arrow-down"></span><span class="lbl">Input (+cached)</span>' +
      '<span class="meta">' + fmtTok(u.inputTotal) + ' (+' + fmtTok(u.cacheReadTotal) + ')</span></div>'
    );
  }

  function renderPlans() {
    if (!model.plans || !model.plans.length) return '<div class="empty">No plans</div>';
    return model.plans.map(fileRow).join('');
  }

  // Hlídače na pozadí (Monitor): na rozdíl od subagenta nekončí jedním výsledkem,
  // ale hlásí se opakovaně — proto je těžiště dlaždice timeline událostí.
  const TASK_EVENTS_SHOWN = 6;

  function fmtClock(ts) {
    if (!ts) return '';
    const d = new Date(ts);
    return String(d.getHours()).padStart(2, '0') + ':' + String(d.getMinutes()).padStart(2, '0');
  }

  function fmtDur(ms) {
    if (!ms || ms < 0) return '';
    const min = Math.round(ms / 60000);
    if (min < 1) return 'míň než min';
    if (min < 60) return min + ' min';
    const h = Math.floor(min / 60);
    const rest = min % 60;
    return rest ? h + ' h ' + rest + ' min' : h + ' h';
  }

  // Dlaždice jednoho hlídače: hlavička se vejde na řádek, hlášení jsou uvnitř
  // a rozbalí se klikem — u hlídače, který běží hodiny, by jinak seznam utekl.
  function taskTile(t, st) {
    const look = st[t.status] || st.ended;
    const now = Date.now();
    // hlavička: jak dlouho běží · kolik nahlásil · kdy skončí
    const head = [];
    if (t.status === 'running' && t.startedAt) head.push(fmtDur(now - t.startedAt));
    if (t.events.length) head.push(t.events.length + '×');
    if (t.status === 'running') {
      if (t.expiresAt) head.push(t.expiresAt > now ? 'vyprší za ' + fmtDur(t.expiresAt - now) : 'vyprší');
      else if (t.persistent) head.push('do konce session');
    }
    // podrobnosti dovnitř, ať hlavička zůstane krátká
    const sub = [];
    if (t.interval) sub.push('á ' + t.interval + 's');
    if (t.session) sub.push('↗ ' + t.session);
    const subLine = sub.length ? '<div class="task-src">' + esc(sub.join(' · ')) + '</div>' : '';
    const shown = t.events.slice(-TASK_EVENTS_SHOWN);
    const hidden = t.events.length - shown.length;
    const more = hidden > 0 ? '<div class="task-more">+ ' + hidden + ' starších</div>' : '';
    const timeline = t.events.length
      ? '<div class="task-events">' +
        more +
        shown
          .map(
            (e) =>
              '<div class="task-event"><span class="task-at">' +
              esc(fmtClock(e.at)) +
              '</span><span class="task-text">' +
              esc(e.text.replace(/\s*\n+\s*/g, ' · ')) +
              '</span></div>'
          )
          .join('') +
        '</div>'
      : '<div class="task-events task-quiet">zatím nic nehlásil</div>';
    // Zastavit jde jen hlídač, jehož proces se podařilo najít — bez PID by
    // tlačítko nemělo co zabít.
    const kill =
      t.status === 'running' && t.pid
        ? '<button class="task-kill" title="Zastavit hlídač" data-kill="' + esc(t.pid) + '"' +
          ' data-kill-pgid="' + esc(t.pgid || '') + '"' +
          ' data-kill-desc="' + esc(t.description) + '"' +
          ' data-kill-cmd="' + esc(String(t.procCommand || '').slice(0, 400)) + '">' +
          '<i class="codicon codicon-debug-stop"></i></button>'
        : '';
    const hdr =
      '<span class="ico codicon codicon-' + look.ico + '"></span>' +
      '<span class="lbl">' + esc(t.description) + '</span>' +
      (head.length ? '<span class="meta">' + esc(head.join(' · ')) + '</span>' : '') +
      kill;
    return '<div class="task ' + look.cls + '">' + group('t:task:' + t.id, hdr, subLine + timeline) + '</div>';
  }

  // Hlídače na pozadí (Monitor). Nahoře jen ty, co OPRAVDU běží — doběhlé a ty
  // bez tepu jsou pod sbalenou historií, jinak se to, co běží, ztratí v archivu.
  function renderTasks() {
    const list = model.tasks || [];
    const st = {
      running: { ico: 'pulse', cls: 'task-running' },
      stopped: { ico: 'debug-stop', cls: 'task-stopped' },
      expired: { ico: 'watch', cls: 'task-over' },
      ended: { ico: 'circle-slash', cls: 'task-over' },
    };
    const live = list.filter((t) => t.status === 'running');
    const past = list.filter((t) => t.status !== 'running');
    let html = live.length
      ? live.map((t) => taskTile(t, st)).join('')
      : '<div class="empty-hint">Právě nic nehlídá.</div>';
    if (past.length) {
      const hdr =
        '<span class="ico codicon codicon-history"></span><span class="lbl">Historie</span>' +
        '<span class="meta">' + past.length + '</span>';
      html += group('t:tasks:hist', hdr, past.map((t) => taskTile(t, st)).join(''));
    }
    return '<div class="task-list">' + html + '</div>';
  }

  function section(title, key, bodyHtml, meta) {
    const open = isOpen(key);
    const metaHtml = meta ? '<span class="meta">' + esc(meta) + '</span>' : '';
    return (
      '<div class="section">' +
      '<div class="ghdr section-hdr" data-toggle="' + esc(key) + '">' +
      caret(key) + '<span class="lbl">' + esc(title) + '</span>' + metaHtml + '</div>' +
      '<div class="gbody"' + (open ? '' : ' hidden') + '>' + bodyHtml + '</div>' +
      '</div>'
    );
  }

  function render() {
    const root = document.getElementById('root');
    document.body.className = 'skin-' + skin;
    if (!model) {
      root.innerHTML = '';
      return;
    }
    const p = model.progress;
    const pMeta = p && p.total ? p.done + '/' + p.total : '';
    // Agents sekci ukazujeme jen když v session nějací subagenti jsou.
    const agents = model.agents || [];
    let agentsSection = '';
    if (agents.length) {
      const running = agents.filter((a) => a.status === 'running').length;
      const done = agents.filter((a) => a.status === 'done').length;
      const failed = agents.filter((a) => a.status !== 'running' && a.status !== 'done').length;
      const parts = [];
      if (running) parts.push(running + ' running');
      if (done) parts.push(done + ' done');
      if (failed) parts.push(failed + ' failed');
      agentsSection = section('Agents', 'sec:agents', renderAgents(), parts.join(' · '));
    }
    // sekce, které si uživatel trvale schoval přes setting claudeTools.hiddenSections
    const hidden = new Set(model.hiddenSections || []);
    const secs = [];
    // Notifications úplně nahoře, ale jen když session nějaké hook hlášky má.
    const notifs = model.notifications || [];
    if (!hidden.has('notifications') && notifs.length) {
      secs.push(section('Notifications', 'sec:notifications', renderNotifications(), String(notifs.length)));
    }
    if (!hidden.has('progress')) secs.push(section('To Do Progress', 'sec:progress', renderProgress(), pMeta));
    if (!hidden.has('history')) secs.push(section('To Do History', 'sec:history', renderHistory()));
    if (!hidden.has('tools')) secs.push(section('Tools', 'sec:tools', renderTools()));
    if (!hidden.has('agents')) secs.push(agentsSection); // '' když session nemá agenty
    // Tasks jen když v session nějaký monitor byl (stejně jako Agents).
    const tasks = model.tasks || [];
    if (!hidden.has('tasks') && tasks.length) {
      const running = tasks.filter((t) => t.status === 'running').length;
      secs.push(section('Tasks', 'sec:tasks', renderTasks(), running ? running + ' running' : ''));
    }
    if (!hidden.has('usage')) secs.push(section('Usage', 'sec:usage', renderUsage()));
    if (!hidden.has('brain')) secs.push(section('Brain', 'sec:context', renderContext()));
    if (!hidden.has('plans')) secs.push(section('Plans', 'sec:plans', renderPlans()));
    root.innerHTML = renderSessionPicker() + secs.join('');
  }

  document.getElementById('root').addEventListener('click', (e) => {
    const t = e.target.closest('[data-kill],[data-del-path],[data-skill],[data-session],[data-transcript],[data-open],[data-toggle],[data-dismiss]');
    if (!t) return;
    // musí být dřív než data-toggle — tlačítko sedí uvnitř skládací hlavičky
    if (t.dataset.kill !== undefined) {
      e.stopPropagation();
      vscode.postMessage({
        type: 'killTask',
        pid: Number(t.dataset.kill),
        pgid: t.dataset.killPgid ? Number(t.dataset.killPgid) : null,
        description: t.dataset.killDesc || '',
        command: t.dataset.killCmd || '',
      });
      return;
    }
    if (t.dataset.skill !== undefined) {
      vscode.postMessage({ type: 'openSkill', name: t.dataset.skill });
      return;
    }
    if (t.dataset.dismiss !== undefined) {
      vscode.postMessage({ type: 'dismissNotification', key: t.dataset.dismiss });
      e.stopPropagation();
      return;
    }
    if (t.dataset.delPath !== undefined) {
      vscode.postMessage({
        type: 'delete',
        path: t.dataset.delPath,
        kind: t.dataset.delKind,
        index: t.dataset.delIndex,
        link: t.dataset.delLink,
      });
      e.stopPropagation();
      return;
    }
    if (t.dataset.session !== undefined) {
      vscode.postMessage({ type: 'openSession', id: t.dataset.session, path: t.dataset.path });
      e.stopPropagation();
      return;
    }
    if (t.dataset.transcript !== undefined) {
      vscode.postMessage({ type: 'openTranscript', path: t.dataset.transcript });
      e.stopPropagation();
      return;
    }
    if (t.dataset.open !== undefined) {
      vscode.postMessage({ type: 'openFile', path: t.dataset.open });
      return;
    }
    if (t.dataset.toggle !== undefined) {
      toggle(t.dataset.toggle);
    }
  });

  // Přepnutí sledované session přes dropdown (change, ne click).
  document.getElementById('root').addEventListener('change', (e) => {
    const sel = e.target.closest('#sessionSelect');
    if (!sel) return;
    vscode.postMessage({ type: 'selectSession', id: sel.value === '__auto__' ? null : sel.value });
  });

  window.addEventListener('message', (e) => {
    const m = e.data;
    if (m && m.type === 'render') {
      model = m.model;
      skin = m.skin;
      seed();
      render();
    }
  });
})();
