# Claude Tools

Read-only companion panel pro [Claude Code](https://github.com/anthropics/claude-code) ve VS Code. Přidává do sidebaru devět pohledů, inspirovaných widgetem ve web aplikaci claude.ai/code:

- **Notifications** — hlášky hooků (`systemMessage`) z aktivní session — to, co v terminálu vypíše třeba SessionStart hook („⚠ ~/.claude: 66 uncommitted souborů"), ale ve VS Code okně vidět není. Závažnost podle vodicího symbolu (`⚠` warning / `✗` error / jinak info), opakované hlášky (Stop hook každý turn, resume po reloadu) sbalené s počtem `N×`. Křížkem jde hlášku zavřít (transcript zůstává netknutý — zavřené klíče drží workspaceState). Sekce se zobrazí jen, když session nějaké nezavřené hlášky má. Čerstvé hlášky SessionStart hooků navíc vyskočí jako VS Code notifikace (toast) — jednou, staré session při startu extension netoastí.
- **To Do Progress** — aktuální seznam úkolů (TodoWrite) z běžící session daného workspace, s ikonou stavu (`✓` hotovo / `↻` rozpracováno / `○` čeká) a souhrnem `X/Y` v hlavičce.
- **To Do History** — historie todo dávek napříč všemi sessions projektu (jen sessions, které todo vytvořily), strukturovaná **Datum → Session → Dávka → úkoly**. Dávka = logicky uzavřený seznam (nová začíná, když se obsah úkolů kompletně vymění). Session má titulek z `aiTitle`, jinak z prvního promptu. Ukazuje i opuštěné/nedokončené dávky — věrně podle transcriptu.
- **Tools** — co se v aktivní session použilo, u každé položky **počet volání** (`6×`): **Skills**, **Commands** (slash příkazy), **Built-in** (WebSearch/WebFetch), **Agents** (subagenti přes Task/Agent — odlišení `plugin` / `built-in` / `custom` podle `subagent_type`) a **MCP** servery + jejich tooly. Z `tool_use` bloků a `<command-name>` v transcriptu.
- **Agents** — živí subagenti, které hlavní Claude spustil na pozadí (async Task/Agent): **běžící** se spinnerem a s tím, co právě dělají (`▸ Edit stg_deals.sql`), **dokončené** `✓`, **selhané** `✗` i s důvodem. Souhrn `X running · Y done` v hlavičce, každý agent jako orámovaná dlaždice. Panel se během běhu subagentů sám obnovuje (jejich postup se čte z výstupních transcriptů). Jen ve webview skinech (`cards` / `compact`).
- **Tasks** — hlídače, které Claude pustil na pozadí (`Monitor`): shellová smyčka sledující vnější stav, typicky review a CI na pull requestu nebo doběh deploye. Na rozdíl od subagenta nekončí jedním výsledkem, ale hlásí se opakovaně — dlaždice proto nese **timeline událostí** s časy, jak je monitor postupně ohlásil. Jako jediná sekce se **neomezuje na sledovanou session**: hlídač běží na pozadí nezávisle na tom, ve které session zrovna jsi, takže se sbírá ze všech živých session projektu (u cizích je připsané `↗ <session>`). Nahoře jsou **jen běžící hlídače**, doběhlé jsou pod sbalenou **Historií**, ať se to podstatné neztratí v archivu. V hlavičce `X running`, u každého hlídače interval (`á 60s`, vyčtený ze smyčky i z volaného skriptu) a počet hlášení. Stav se řídí doklady konce — zastaven (`TaskStop`), vypršel (hláška Claude Code o konci hlídání, jinak dopočet z timeoutu), ukončen se session (persistent monitor ji nepřežije) — a když žádný není, ověří se proti `ps`, jestli proces hlídače opravdu běží. **Mlčení se za konec nepovažuje:** dobře napsaný hlídač hlásí jen změny, takže ticho je jeho normální provoz. Když `ps` není k mání, hlídač zůstává veden jako běžící — chybějící informace se nepřeklápí na „mrtvý".

  Běžící hlídač jde **zastavit přímo z panelu** (tlačítko na hover, pak potvrzení s příkazem a PID). Ukončuje se jeho process group, takže padne i to, co zrovna spustil. Jediný zápis panelu mimo mazání faktů a plánů — proces se páruje dvěma nezávislými znaky (potomek procesu té session + otisk příkazu), aby nešlo trefit cizí proces. Jen ve webview skinech (`cards` / `compact`).
- **Usage** — model, **context window** (+ bar a `%`; od 50 % žlutý, od 80 % červený), **prompt cache** a token totals (output / input + cache) ze `usage` bloků session. Limit okna řídí setting `claudeTools.contextWindow` (auto: Opus i Fable → 1M).

  **Prompt cache** hlídá, kdy vychladne mezipaměť konverzace. Claude s každou zprávou posílá celou konverzaci znovu; levné je to jen díky cache, která žije TTL (u předplatného 1 h) od začátku posledního požadavku. Po vychladnutí se celá konverzace zapisuje do cache znovu — u dlouhé session je pak další zpráva 20–40× dražší (`~$` podle ceníku API, tooltip ukáže obě ceny). Řádek je tlumený (`warm · 47 min`), dokud nehrozí nic drahého; v posledních 25 minutách, a jen když by studený start stál aspoň 1 $, se z něj stane odpočet (`expires in 12 min`), pod 5 minut a po vychladnutí (`cold · next ~$2.40`) červeně.
- **Brain** — instrukce + paměť dělené podle scope:
  - **Personal** — `~/.claude/CLAUDE.md` (+ managed policy `/etc/claude-code/CLAUDE.md`, pokud existuje).
  - **Project** — `<repo>/CLAUDE.md` + **Auto-memory** (projektový `MEMORY.md` index + jednotlivé fact soubory).
  - **Local** — `<repo>/CLAUDE.local.md` (gitignored, jen tento stroj).
- **Plans** — uložené plány z `~/.claude/plans/`; klik otevře plán. (V tree módu skryté defaultně — zapneš přes „…" menu panelu.)

Klik na položku (soubor, skill) ho otevře; u session v To Do History jsou inline ikony „otevřít v Claude Code" + „raw transcript". Panel se sám obnovuje při změnách na disku, plus tlačítko **Obnovit** v hlavičce.

## Vzhled (setting `claudeTools.appearance`)

- **`cards`** (default) — webview, karty ve stylu cowork widgetu.
- **`compact`** — webview, úsporný seznam (vše v jednom pohledu).
- **`tree`** — nativní VS Code TreeView (sedm samostatných views, plná integrace, jednotlivé views lze rozmístit do víc panelů). Sekce **Agents** a **Tasks** jsou jen ve webview skinech.

Webview skiny sdílí stejnou datovou vrstvu jako TreeView; přepnutí je okamžité. V širokém kontejneru (dolní panel) se webview přeskládá do dlaždic.

Jednotlivé karty jde ve webview trvale schovat settingem `claudeTools.hiddenSections` (zaškrtávací seznam sekcí).

## Jak to funguje (zdroje dat)

Claude Code nemá veřejné API pro tahle data — extension čte přímo jeho interní soubory v `~/.claude/`:

| Pohled | Zdroj |
|---|---|
| Notifications | aktivní `.jsonl` → attachmenty `hook_system_message` (hlášky hooků se `systemMessage`) |
| To Do Progress | aktivní `.jsonl` → poslední `tool_use` blok `TodoWrite` (posílá vždy celý seznam) |
| To Do History | **všechny** `.jsonl` v projektové složce → todo dávky seskupené Datum → Session → Dávka |
| Tools | aktivní `.jsonl` → `Skill` / `mcp__*` / `WebSearch…` / `Task`+`Agent` (`subagent_type`) tool_use + `<command-name>` (slash) |
| Agents | aktivní `.jsonl` → `async_launched` výsledky + `<task-notification>` (běh/doběh) · **plus `<session>/subagents/*.meta.json`**, odkud se berou i agenti spuštění na popředí (ti v transcriptu žádný `async_launched` nezanechají) · živá akce z transcriptu agenta |
| Tasks | **všechny živé** `.jsonl` projektu → `Monitor` tool_use (popis, příkaz) + task id z věty `Monitor started (task …)` ve výsledku · události z `<task-notification>` s `<event>` · konec z `TaskStop` a z hlášky o vypršení · jestli hlídač pořád běží, se ověřuje proti `ps`. Transcript je append-only, takže se po prvním načtení dočítá jen přírůstek. |
| Usage | aktivní `.jsonl` → `usage` bloky assistant zpráv (context window, tokeny) · prompt cache: začátek posledního požadavku jako pozdější z času `api-request` záznamu (zapisuje ho jen session z VS Code UI a desktop appky) a času user záznamu, který požadavek spustil (shrnutí po kompakci se přeskakuje), TTL z `cacheControl` nebo z `usage.cache_creation` · syntetické zprávy po API chybě se nezapočítávají |
| Brain | `~/.claude/CLAUDE.md`, `/etc/claude-code/CLAUDE.md`, `<repo>/CLAUDE.md`, `<repo>/CLAUDE.local.md`, `…/memory/MEMORY.md` (+ fact soubory) |
| Plans | `~/.claude/plans/*.md` (globální, titulek = první `#` heading) |

„Aktivní" session = nejnovější (`mtime`) `.jsonl` v projektové složce.

„Živá" session (pro přepínač souběžných session) = **běží její proces**, ne že nedávno zapsala do transcriptu. Zdrojem je `~/.claude/sessions/<pid>.json` (`sessionId`, `cwd`, `status: busy | idle`); PID se ověřuje, protože soubory po spadlých procesech ve složce zůstávají. Session, ve které Claude čeká na vstup, tedy zůstává živá, i když do transcriptu dlouho nepíše. Tečka v přepínači: `●` pracuje, `○` čeká na vstup, `◌` už neběží (jen dosledovávaná). Bez složky `sessions/` (starší Claude Code) padá detekce zpět na mtime v okně 10 minut.

Cesta projektové složky vzniká nahrazením `/` za `-` v absolutní cestě workspace.

> **Varování:** formát těchto souborů je **nedokumentovaný interní artefakt** Claude Code. Při změně formátu se může pohled vyprázdnit (parser je defenzivní — raději prázdno než pád). Panel je v zásadě read-only; jediný zápis je smazání faktu/plánu přes popelnici, vždy po potvrzení.

## Spuštění (dev)

1. Otevři tuto složku ve VS Code.
2. Stiskni **F5** → spustí se Extension Development Host s načteným panelem.
3. V novém okně otevři projekt, kde běží Claude Code → ikona „Claude Tools" v Activity Baru.

## Instalace

Stáhni `.vsix` z [Releases](https://github.com/AndreHeller/claude-tools-vscode/releases) a nainstaluj:

```bash
code --install-extension claude-tools-<verze>.vsix   # na WSL spusť z WSL terminálu
```

Pak **Developer: Reload Window**. Ikona Claude Tools naběhne v panelu.

### Build z kódu

```bash
npx @vscode/vsce package        # Node 20+
python3 scripts/build_vsix.py   # bez vsce (funguje i na Node 18) → .vsix v kořeni
```
