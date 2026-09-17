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
  if (saved && saved.seeded) seeded = true;

  function persist() {
    vscode.setState({ collapsed: [...collapsed], seeded: true });
  }
  function isOpen(key) {
    return !collapsed.has(key);
  }
  function toggle(key) {
    if (collapsed.has(key)) collapsed.delete(key);
    else collapsed.add(key);
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

  function renderUsage() {
    const u = model.usage;
    if (!u) return '<div class="empty-hint">No usage data yet.</div>';
    const pct = u.limit ? Math.round((u.contextTokens / u.limit) * 100) : 0;
    return (
      (u.model
        ? '<div class="row"><span class="ico codicon codicon-chip"></span><span class="lbl">Model</span><span class="meta">' + esc(u.model) + '</span></div>'
        : '') +
      '<div class="row"><span class="ico codicon codicon-window"></span><span class="lbl">Context window</span>' +
      '<span class="meta">' + fmtTok(u.contextTokens) + ' / ' + fmtTok(u.limit) + ' · ' + pct + '%</span></div>' +
      '<progress class="ctxbar" max="100" value="' + Math.min(100, pct) + '"></progress>' +
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

  function renderTasks() {
    const list = model.tasks || [];
    if (!list.length) return '<div class="empty-hint">No background monitors in this session.</div>';
    const rank = { running: 0, stopped: 1, expired: 2, ended: 3 };
    const sorted = list.slice().sort((a, b) => (rank[a.status] ?? 4) - (rank[b.status] ?? 4));
    const st = {
      running: { ico: 'pulse', cls: 'task-running' },
      stopped: { ico: 'debug-stop', cls: 'task-stopped' },
      expired: { ico: 'watch', cls: 'task-over' },
      ended: { ico: 'circle-slash', cls: 'task-over' },
    };
    const now = Date.now();
    return (
      '<div class="task-list">' +
      sorted
        .map((t) => {
          let s = st[t.status] || st.ended;
          if (t.status === 'running' && t.stale) s = { ico: 'warning', cls: 'task-stale' };
          // meta: jak dlouho hlídá · jak často · kolik toho nahlásil.
          // U stale se doba běhu vynechává — „běží 72 h" u mrtvého hlídače lže.
          const parts = [];
          if (t.status === 'running' && !t.stale && t.startedAt) parts.push(fmtDur(now - t.startedAt));
          if (t.interval) parts.push('á ' + t.interval + 's');
          if (t.events.length) parts.push(t.events.length + '×');
          // hlídač z jiné session než sledované — ať je jasné, odkud je
          if (t.session) parts.push('↗ ' + t.session);
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
          // stale je odhad z toho, kdy monitor naposled zapsal — ne jistota
          const quiet = t.stale ? fmtDur(now - (t.lastBeat || t.startedAt)) : '';
          const warn = t.stale
            ? '<div class="task-warn">bez tepu ' + esc(quiet) + ' — nejspíš už neběží</div>'
            : '';
          return (
            '<div class="task ' + s.cls + '">' +
            '<div class="row"><span class="ico codicon codicon-' + s.ico + '"></span>' +
            '<span class="lbl">' + esc(t.description) + '</span>' +
            (parts.length ? '<span class="meta">' + esc(parts.join(' · ')) + '</span>' : '') +
            '</div>' +
            warn +
            timeline +
            '</div>'
          );
        })
        .join('') +
      '</div>'
    );
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
      const running = tasks.filter((t) => t.status === 'running' && !t.stale).length;
      const stale = tasks.filter((t) => t.status === 'running' && t.stale).length;
      const over = tasks.length - running - stale;
      const tParts = [];
      if (running) tParts.push(running + ' running');
      if (stale) tParts.push(stale + ' stale');
      if (over) tParts.push(over + ' done');
      secs.push(section('Tasks', 'sec:tasks', renderTasks(), tParts.join(' · ')));
    }
    if (!hidden.has('usage')) secs.push(section('Usage', 'sec:usage', renderUsage()));
    if (!hidden.has('brain')) secs.push(section('Brain', 'sec:context', renderContext()));
    if (!hidden.has('plans')) secs.push(section('Plans', 'sec:plans', renderPlans()));
    root.innerHTML = renderSessionPicker() + secs.join('');
  }

  document.getElementById('root').addEventListener('click', (e) => {
    const t = e.target.closest('[data-del-path],[data-skill],[data-session],[data-transcript],[data-open],[data-toggle],[data-dismiss]');
    if (!t) return;
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
