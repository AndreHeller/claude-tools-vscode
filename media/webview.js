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
  const DEFAULT_CLOSED = new Set(['t:monitors:hist']);
  const isDefaultClosed = (key) =>
    DEFAULT_CLOSED.has(key) || key.startsWith('t:monitor:') || key.startsWith('a:') || key.startsWith('sv:') || key === 'usage:help';
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
    // Vybraná session musí v nabídce zůstat i po tom, co doběhne — jinak
    // přepínač pod dvěma živými zmizí i s ní a není kudy se vrátit na Auto.
    const shown = list.filter((s) => s.live || s.id === active || s.id === selected);
    // Pod dvěma položkami nemá přepínač co nabízet, ale ve sticky režimu se
    // schovat nesmí: zmizel by jediný ovladač, kterým jde fixace zrušit.
    if (shown.length < 2 && selected == null) return '';
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
  // Detail pod dlaždicí agenta: čím běžel, jak dlouho, co volal a s čím se
  // vrátil. Prázdný řetězec znamená „není co ukázat" — agent, který ještě
  // nic nestihl, se nerozbaluje.
  function agentDetail(a) {
    const s = a.stats;
    const fakta = [];
    if (a.model) fakta.push(['model', a.model]);
    if (s && s.durationSec != null) fakta.push(['běžel', trvani(s.durationSec)]);
    if (s && s.tokens) fakta.push(['tokeny', s.tokens.toLocaleString('cs')]);
    if (a.depth != null && a.depth > 1) fakta.push(['hloubka', String(a.depth)]);
    const radky = fakta
      .map(([k, v]) => '<div class="ad-fact"><span class="ad-k">' + esc(k) + '</span>' +
                       '<span class="ad-v">' + esc(v) + '</span></div>')
      .join('');
    let nastroje = '';
    if (s && s.tools && s.tools.length) {
      const vypis = s.tools.slice(0, 6).map((x) => x.name + '×' + x.count).join(' · ');
      const zbytek = s.tools.length > 6 ? ' +' + (s.tools.length - 6) : '';
      nastroje = '<div class="ad-tools">' + esc(vypis + zbytek) + '</div>';
    }
    const report = s && s.report ? '<div class="ad-report">' + esc(s.report) + '</div>' : '';
    if (!radky && !nastroje && !report) return '';
    return '<div class="agent-detail">' + radky + nastroje + report + '</div>';
  }

  // 51 → „51 s", 185 → „3 m 5 s"
  function trvani(sec) {
    if (sec < 60) return sec + ' s';
    const m = Math.floor(sec / 60);
    const z = sec % 60;
    return z ? m + ' m ' + z + ' s' : m + ' m';
  }

  function renderAgents() {
    const list = model.agents || [];
    if (!list.length) return '<div class="empty-hint">No subagents in this session.</div>';
    const st = {
      running: { ico: 'loading codicon-modifier-spin', cls: 'agent-running' },
      done: { ico: 'pass-filled', cls: 'agent-done' },
    };
    const dlazdice = (a) => {
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
        const hdr =
          '<div class="row"><span class="ico codicon codicon-' + s.ico + '"></span>' +
          '<span class="lbl">' + label + '</span><span class="meta">' + meta + '</span></div>' +
          action;
        const detail = agentDetail(a);
        // Bez detailu zůstává dlaždice jako dřív — nerozbalitelná, bez šipky,
        // ať neslibuje obsah, který nemá.
        const body = detail
          ? group('a:' + a.id, hdr, detail)
          : hdr;
        return '<div class="agent ' + s.cls + '" title="' + title + '">' + body + '</div>';
    };
    const html = zivePlusHistorie(
      list.filter((a) => a.status === 'running'),
      list.filter((a) => a.status !== 'running'),
      dlazdice,
      'a:agents:hist',
      'Právě nic neběží.'
    );
    // wrapper → v širokém panelu z něj CSS udělá grid dlaždic (viz @media)
    return '<div class="agent-list">' + html + '</div>';
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
      // Součty za session stojí pod stavem kontextu a měří něco jiného, takže
      // dostaly vlastní nadpis — jinak to vypadá jako čtyři varianty téhož.
      '<div class="usage-sum-hdr">Za celou session</div>' +
      // Nálepka nese NÁSOBEK základní sazby, ne slovo „levné / drahé" — to
      // neříká vůči čemu. Čísla jdou porovnat mezi sebou na první pohled.
      usageRow('arrow-up', 'Claude napsal', u.outputTotal, '') +
      usageRow('database', 'Přečteno z cache', u.cacheReadTotal, '0,1×') +
      usageRow('save', 'Uloženo do cache', u.cacheWriteTotal, '1,25×') +
      usageRow('arrow-down', 'Mimo cache', u.inputTotal, '1×') +
      usageLegenda()
    );
  }

  // Řádek součtu v Usage. `pozn` je násobek základní sazby — co znamená,
  // vysvětluje legenda pod součty.
  function usageRow(ico, popis, hodnota, pozn) {
    if (hodnota == null) return '';
    const nalepka = pozn ? '<span class="usage-tag">' + esc(pozn) + '</span>' : '';
    return (
      '<div class="row usage-sum">' +
      '<span class="ico codicon codicon-' + ico + '"></span>' +
      '<span class="lbl">' + esc(popis) + '</span>' +
      nalepka +
      '<span class="meta">' + fmtTok(hodnota) + '</span></div>'
    );
  }

  // Vysvětlení čísel. Nativní `title` tooltip se ve webview nezobrazí, takže
  // text patří do panelu — sbalený, aby nepřekážel tomu, kdo ho nepotřebuje.
  function usageLegenda() {
    const body =
      '<div class="usage-help">' +
      '<p>Claude <b>nemá paměť mezi zprávami</b>. Při každém dotazu se mu posílá celá ' +
      'konverzace znovu, takže se čísla nasčítají do milionů, i když konverzace sama je zlomek.</p>' +
      '<p><b>Přečteno z cache</b> je ta část, kterou už jednou zpracoval a jen na ni naváže — ' +
      'desetina ceny. Proto je to číslo obrovské a stojí skoro nic.</p>' +
      '<p><b>Uloženo do cache</b> je uložení konverzace, aby se příště četla levně. Stojí o čtvrtinu ' +
      'víc než běžné zpracování, ale vrátí se to hned další zprávou. <b>Vyskočí, když cache ' +
      'vychladne</b> a celý kontext se musí uložit znovu.</p>' +
      '<p><b>Mimo cache</b> jsou tokeny, které se do cache nevešly — v praxi hlavně tvoje poslední ' +
      'zpráva. Plná sazba, ale je jich málo.</p>' +
      '<p class="usage-help-note">Násobky jsou vůči základní sazbě za vstup. Výstup se účtuje zvlášť a dráž.</p>' +
      '</div>';
    const hdr =
      '<span class="ico codicon codicon-question"></span>' +
      '<span class="lbl">Co ta čísla znamenají</span>';
    return group('usage:help', hdr, body);
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
  function monitorTile(t, st) {
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
    const subLine = sub.length ? '<div class="monitor-src">' + esc(sub.join(' · ')) + '</div>' : '';
    const shown = t.events.slice(-TASK_EVENTS_SHOWN);
    const hidden = t.events.length - shown.length;
    const more = hidden > 0 ? '<div class="monitor-more">+ ' + hidden + ' starších</div>' : '';
    const timeline = t.events.length
      ? '<div class="monitor-events">' +
        more +
        shown
          .map(
            (e) =>
              '<div class="monitor-event"><span class="monitor-at">' +
              esc(fmtClock(e.at)) +
              '</span><span class="monitor-text">' +
              esc(e.text.replace(/\s*\n+\s*/g, ' · ')) +
              '</span></div>'
          )
          .join('') +
        '</div>'
      : '<div class="monitor-events monitor-quiet">zatím nic nehlásil</div>';
    // Zastavit jde jen hlídač, jehož proces se podařilo najít — bez PID by
    // tlačítko nemělo co zabít.
    const kill =
      t.status === 'running' && t.pid
        ? '<button class="monitor-kill" title="Zastavit hlídač" data-kill="' + esc(t.pid) + '"' +
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
    return '<div class="monitor ' + look.cls + '">' + group('t:monitor:' + t.id, hdr, subLine + timeline) + '</div>';
  }

  // Hlídače na pozadí (Monitor). Nahoře jen ty, co OPRAVDU běží — doběhlé a ty
  // bez tepu jsou pod sbalenou historií, jinak se to, co běží, ztratí v archivu.
  // Dev servery běžící na pozadí. Ukazují se jen ty živé — server, který
  // doběhl, není k čemu otevřít, takže by v panelu jen překážel.
  function renderServers() {
    const list = model.servers || [];
    if (!list.length) return '';
    const now = Date.now();
    const dlazdice = (s) => {
          const url = 'http://localhost:' + s.port;
          const head = [];
          if (s.startedAt) head.push('běží ' + fmtDur(now - s.startedAt));
          // Odkud se port vzal, se nezamlčuje: změřený je doklad, že se
          // opravdu poslouchá, kdežto vyčtený ze zadání je jen tvrzení příkazu.
          if (!s.measured) head.push('port ze zadání');
          if (s.session) head.push('↗ ' + s.session);
          const hdr =
            '<span class="ico codicon codicon-globe"></span>' +
            '<span class="lbl">' + esc(s.description || s.command.slice(0, 60)) + '</span>' +
            (head.length ? '<span class="meta">' + esc(head.join(' · ')) + '</span>' : '') +
            // Doběhlý server není k čemu otevřít ani co zastavit — port
            // zůstává jen jako informace, čím běžel.
            (s.status === 'stopped'
              ? '<span class="meta server-port-off">' + esc(':' + s.port) + '</span>'
              : '<button class="server-open" data-url="' + esc(url) + '" title="' + esc(url) + '">' +
                esc(':' + s.port) + '</button>') +
            (s.status === 'stopped' ? '' :
            '<button class="monitor-kill" title="Zastavit server" data-kill="' + esc(s.pid) + '"' +
            ' data-kill-kind="server"' +
            ' data-kill-pgid="' + esc(s.pgid || '') + '"' +
            ' data-kill-desc="' + esc(s.description || '') + '"' +
            ' data-kill-cmd="' + esc(String(s.procCommand || s.command || '').slice(0, 400)) + '">' +
            '<i class="codicon codicon-debug-stop"></i></button>');
          // Pod šipkou celý příkaz — to je u serveru ta „co to vlastně je"
          // informace, kterou se z popisu nedozvíš.
          const telo = '<div class="server-cmd">' + esc(s.command) + '</div>';
          return '<div class="server-tile server-' + esc(s.status || 'running') + '">' +
                 group('sv:' + s.id, hdr, telo) + '</div>';
    };
    const html = zivePlusHistorie(
      list.filter((s) => s.status !== 'stopped'),
      list.filter((s) => s.status === 'stopped'),
      dlazdice,
      'sv:servers:hist',
      'Právě nic neběží.'
    );
    return '<div class="server-list">' + html + '</div>';
  }

  // Tvar, který drží všechny tři skupiny v Activity: nahoře to, co běží,
  // zbytek pod sbalenou Historií. Bez toho se každá chovala jinak — agenti
  // měli doběhlé rovnou v seznamu, hlídači historii zvlášť a servery po
  // doběhnutí zmizely celé.
  function zivePlusHistorie(live, past, dlazdice, klicHistorie, prazdne) {
    let html = live.length
      ? live.map(dlazdice).join('')
      : '<div class="empty-hint">' + esc(prazdne) + '</div>';
    if (past.length) {
      const hdr =
        '<span class="ico codicon codicon-history"></span><span class="lbl">Historie</span>' +
        '<span class="meta">' + past.length + '</span>';
      html += group(klicHistorie, hdr, past.map(dlazdice).join(''));
    }
    return html;
  }

  function renderMonitors() {
    const list = model.monitors || [];
    const st = {
      running: { ico: 'pulse', cls: 'monitor-running' },
      stopped: { ico: 'debug-stop', cls: 'monitor-stopped' },
      expired: { ico: 'watch', cls: 'monitor-over' },
      ended: { ico: 'circle-slash', cls: 'monitor-over' },
    };
    const html = zivePlusHistorie(
      list.filter((t) => t.status === 'running'),
      list.filter((t) => t.status !== 'running'),
      (t) => monitorTile(t, st),
      't:monitors:hist',
      'Právě nic nehlídá.'
    );
    return '<div class="monitor-list">' + html + '</div>';
  }

  // `actions` je hotové HTML tlačítek vpravo v hlavičce. Leží uvnitř prvku
  // s `data-toggle`, takže musí nést vlastní `data-*` — obsluha hledá
  // nejbližší zásah, a ten je pak tlačítko, ne sbalení sekce.
  function section(title, key, bodyHtml, meta, actions) {
    const open = isOpen(key);
    const metaHtml = meta ? '<span class="meta">' + esc(meta) + '</span>' : '';
    return (
      '<div class="section">' +
      '<div class="ghdr section-hdr" data-toggle="' + esc(key) + '">' +
      caret(key) + '<span class="lbl">' + esc(title) + '</span>' + metaHtml +
      (actions || '') + '</div>' +
      '<div class="gbody"' + (open ? '' : ' hidden') + '>' + bodyHtml + '</div>' +
      '</div>'
    );
  }

  // Překreslení jde přes `root.innerHTML`, takže zahodí celý DOM — a s ním
  // rozbalenou nabídku přepínače i focus. Dokud ji má uživatel otevřenou,
  // stačilo cizí session něco zapsat a nabídka se pod rukama zavřela dřív,
  // než stihl kliknout.
  //
  // Rozbalení nativního <select> se z JS zjistit nedá, proto se bere jako
  // otevřený od `mousedown` / `focus` až po `change`, `blur` nebo Escape.
  // Pojistkou je timeout: kdyby žádná z těch událostí nepřišla (uživatel
  // nechá přepínač zafokusovaný a odejde), panel by se jinak zasekl.
  const PICKER_HOLD_MS = 20000;
  let pickerHold = false;
  let pickerHoldTimer = null;
  let renderPending = false;

  function holdPicker() {
    pickerHold = true;
    clearTimeout(pickerHoldTimer);
    pickerHoldTimer = setTimeout(releasePicker, PICKER_HOLD_MS);
  }

  function releasePicker() {
    clearTimeout(pickerHoldTimer);
    pickerHoldTimer = null;
    if (!pickerHold) return;
    pickerHold = false;
    if (renderPending) {
      renderPending = false;
      render();
    }
  }

  // Skupina uvnitř sekce Activity. Od `section()` se liší jen tím, že nese
  // vlastní třídu — odsazení a jemnější hlavičku řeší CSS, chování skládání
  // zůstává stejné, včetně zapamatovaného stavu podle klíče.
  function subSection(title, key, bodyHtml, meta) {
    const open = isOpen(key);
    const metaHtml = meta ? '<span class="meta">' + esc(meta) + '</span>' : '';
    return (
      '<div class="subsection">' +
      '<div class="ghdr subsection-hdr" data-toggle="' + esc(key) + '">' +
      caret(key) + '<span class="lbl">' + esc(title) + '</span>' + metaHtml + '</div>' +
      '<div class="gbody"' + (open ? '' : ' hidden') + '>' + bodyHtml + '</div>' +
      '</div>'
    );
  }

  function render() {
    // Model už je uložený, takže odložené překreslení dožene poslední stav
    // naráz — nefronti se, jen se zapamatuje, že je co dohnat.
    if (pickerHold) {
      renderPending = true;
      return;
    }
    const root = document.getElementById('root');
    document.body.className = 'skin-' + skin;
    if (!model) {
      root.innerHTML = '';
      return;
    }
    const p = model.progress;
    const pMeta = p && p.total ? p.done + '/' + p.total : '';
    const agents = model.agents || [];
    const monitors = model.monitors || [];
    const servers = model.servers || [];
    // sekce, které si uživatel trvale schoval přes setting claudeTools.hiddenSections
    const hidden = new Set(model.hiddenSections || []);
    const secs = [];
    // Notifications úplně nahoře, ale jen když session nějaké hook hlášky má.
    const notifs = model.notifications || [];
    if (!hidden.has('notifications') && notifs.length) {
      const clearAll =
        '<button class="sec-act" data-clear-notifs="1" title="Clear all">' +
        '<i class="codicon codicon-clear-all"></i></button>';
      secs.push(
        section('Notifications', 'sec:notifications', renderNotifications(), String(notifs.length), clearAll)
      );
    }
    if (!hidden.has('progress')) secs.push(section('To Do Progress', 'sec:progress', renderProgress(), pMeta));
    if (!hidden.has('history')) secs.push(section('To Do History', 'sec:history', renderHistory()));
    if (!hidden.has('tools')) secs.push(section('Tools', 'sec:tools', renderTools()));
    // Activity: jedna sekce na otázku „co mi teď běží na pozadí". Uvnitř zůstávají
    // tři skupiny, protože odpovídají na různé druhotné otázky — agent se ptá
    // „s čím se vrátil", hlídač „co ohlásil", server „kam se kliknu". Skupina
    // bez obsahu se nevykreslí, takže nic nezabírá místo nadarmo.
    const skupiny = [];
    // V hlavičce skupiny stojí jen to, co běží. Doběhlé položky mají vlastní
    // počet u řádku Historie, takže by se tu počítaly podruhé — a hlavně by
    // hlavička tvrdila „3 running" nad seznamem, kde neběží nic.
    const bezicichAgentu = agents.filter((a) => a.status === 'running').length;
    const bezicichMonitoru = monitors.filter((m) => m.status === 'running').length;
    const bezicichServeru = servers.filter((s) => s.status !== 'stopped').length;
    const meta = (n) => (n ? n + ' running' : '');
    if (!hidden.has('agents') && agents.length) {
      skupiny.push(subSection('Agents', 'sec:agents', renderAgents(), meta(bezicichAgentu)));
    }
    if (!hidden.has('monitors') && monitors.length) {
      skupiny.push(subSection('Monitors', 'sec:monitors', renderMonitors(), meta(bezicichMonitoru)));
    }
    if (!hidden.has('servers') && servers.length) {
      skupiny.push(subSection('Servers', 'sec:servers', renderServers(), meta(bezicichServeru)));
    }
    if (skupiny.length) {
      const beziCelkem = bezicichAgentu + bezicichMonitoru + bezicichServeru;
      secs.push(
        section('Activity', 'sec:activity', '<div class="activity">' + skupiny.join('') + '</div>',
          beziCelkem ? beziCelkem + ' running' : '')
      );
    }
    if (!hidden.has('usage')) secs.push(section('Usage', 'sec:usage', renderUsage()));
    if (!hidden.has('brain')) secs.push(section('Brain', 'sec:context', renderContext()));
    if (!hidden.has('plans')) secs.push(section('Plans', 'sec:plans', renderPlans()));
    root.innerHTML = renderSessionPicker() + secs.join('');
  }

  document.getElementById('root').addEventListener('click', (e) => {
    const t = e.target.closest('[data-kill],[data-del-path],[data-skill],[data-session],[data-transcript],[data-open],[data-toggle],[data-dismiss],[data-clear-notifs],[data-url]');
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
        kind: t.dataset.killKind || 'monitor',
      });
      return;
    }
    if (t.dataset.skill !== undefined) {
      vscode.postMessage({ type: 'openSkill', name: t.dataset.skill });
      return;
    }
    if (t.dataset.url !== undefined) {
      vscode.postMessage({ type: 'openUrl', url: t.dataset.url });
      e.stopPropagation();
      return;
    }
    if (t.dataset.clearNotifs !== undefined) {
      // Klíče posílá webview, ne extension: zavřít se má přesně to, co má
      // uživatel před sebou, ne co mezitím přibylo.
      const keys = (model.notifications || []).map((n) => n.dismissKey).filter(Boolean);
      if (keys.length) vscode.postMessage({ type: 'dismissNotifications', keys });
      e.stopPropagation();
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

  // Jakmile uživatel na přepínač sáhne, drž překreslování. `mousedown` kvůli
  // myši (nabídka se rozbalí ještě před focusem), `focusin` kvůli klávesnici.
  document.getElementById('root').addEventListener('mousedown', (e) => {
    if (e.target.closest('#sessionSelect')) holdPicker();
  });
  document.getElementById('root').addEventListener('focusin', (e) => {
    if (e.target.closest('#sessionSelect')) holdPicker();
  });
  document.getElementById('root').addEventListener('focusout', (e) => {
    if (e.target.closest('#sessionSelect')) releasePicker();
  });
  document.getElementById('root').addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && e.target.closest('#sessionSelect')) releasePicker();
  });

  // Přepnutí sledované session přes dropdown (change, ne click).
  document.getElementById('root').addEventListener('change', (e) => {
    const sel = e.target.closest('#sessionSelect');
    if (!sel) return;
    // Volba padla, nabídka je zavřená — pusť překreslení, ať se odložený
    // stav dožene hned a nečeká se na blur.
    releasePicker();
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
