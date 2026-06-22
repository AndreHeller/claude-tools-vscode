# Claude Tools

Read-only companion panel pro [Claude Code](https://github.com/anthropics/claude-code) ve VS Code. Přidává do sidebaru šest pohledů, inspirovaných widgetem ve web aplikaci claude.ai/code:

- **To Do Progress** — aktuální seznam úkolů (TodoWrite) z běžící session daného workspace, s ikonou stavu (`✓` hotovo / `↻` rozpracováno / `○` čeká) a souhrnem `X/Y` v hlavičce.
- **To Do History** — historie todo dávek napříč všemi sessions projektu (jen sessions, které todo vytvořily), strukturovaná **Datum → Session → Dávka → úkoly**. Dávka = logicky uzavřený seznam (nová začíná, když se obsah úkolů kompletně vymění). Session má titulek z `aiTitle`, jinak z prvního promptu. Ukazuje i opuštěné/nedokončené dávky — věrně podle transcriptu.
- **Tools** — co se v aktivní session použilo, u každé položky **počet volání** (`6×`): **Skills**, **Commands** (slash příkazy), **Built-in** (WebSearch/WebFetch), **Agents** (subagenti přes Task/Agent — odlišení `plugin` / `built-in` / `custom` podle `subagent_type`) a **MCP** servery + jejich tooly. Z `tool_use` bloků a `<command-name>` v transcriptu.
- **Usage** — model, **context window** (+ bar a `%`), a token totals (output / input + cache) ze `usage` bloků session. Limit okna řídí setting `claudeTools.contextWindow` (auto: Opus → 1M).
- **Brain** — instrukce + paměť dělené podle scope:
  - **Personal** — `~/.claude/CLAUDE.md` (+ managed policy `/etc/claude-code/CLAUDE.md`, pokud existuje).
  - **Project** — `<repo>/CLAUDE.md` + **Auto-memory** (projektový `MEMORY.md` index + jednotlivé fact soubory).
  - **Local** — `<repo>/CLAUDE.local.md` (gitignored, jen tento stroj).
- **Plans** — uložené plány z `~/.claude/plans/`; klik otevře plán. (V tree módu skryté defaultně — zapneš přes „…" menu panelu.)

Klik na položku (soubor, skill) ho otevře; u session v To Do History jsou inline ikony „otevřít v Claude Code" + „raw transcript". Panel se sám obnovuje při změnách na disku, plus tlačítko **Obnovit** v hlavičce.

## Vzhled (setting `claudeTools.appearance`)

- **`cards`** (default) — webview, karty ve stylu cowork widgetu.
- **`compact`** — webview, úsporný seznam (vše v jednom pohledu).
- **`tree`** — nativní VS Code TreeView (šest samostatných views, plná integrace, jednotlivé views lze rozmístit do víc panelů).

Webview skiny sdílí stejnou datovou vrstvu jako TreeView; přepnutí je okamžité. V širokém kontejneru (dolní panel) se webview přeskládá do dlaždic.

## Jak to funguje (zdroje dat)

Claude Code nemá veřejné API pro tahle data — extension čte přímo jeho interní soubory v `~/.claude/`:

| Pohled | Zdroj |
|---|---|
| To Do Progress | aktivní `.jsonl` → poslední `tool_use` blok `TodoWrite` (posílá vždy celý seznam) |
| To Do History | **všechny** `.jsonl` v projektové složce → todo dávky seskupené Datum → Session → Dávka |
| Tools | aktivní `.jsonl` → `Skill` / `mcp__*` / `WebSearch…` / `Task`+`Agent` (`subagent_type`) tool_use + `<command-name>` (slash) |
| Usage | aktivní `.jsonl` → `usage` bloky assistant zpráv (context window, tokeny) |
| Brain | `~/.claude/CLAUDE.md`, `/etc/claude-code/CLAUDE.md`, `<repo>/CLAUDE.md`, `<repo>/CLAUDE.local.md`, `…/memory/MEMORY.md` (+ fact soubory) |
| Plans | `~/.claude/plans/*.md` (globální, titulek = první `#` heading) |

„Aktivní" session = nejnovější (`mtime`) `.jsonl` v projektové složce.

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
