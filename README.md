# Claude Tools

Read-only companion panel pro [Claude Code](https://github.com/anthropics/claude-code) ve VS Code. Přidává do sidebaru čtyři pohledy, inspirované widgetem ve web aplikaci claude.ai/code:

- **To Do Progress** — aktuální seznam úkolů (TodoWrite) z běžící session daného workspace, s ikonou stavu (`✓` hotovo / `↻` rozpracováno / `○` čeká) a souhrnem `X/Y` v hlavičce.
- **To Do History** — historie todo dávek napříč všemi sessions projektu (jen sessions, které todo vytvořily), strukturovaná **Datum → Session → Dávka → úkoly**. Dávka = logicky uzavřený seznam (nová začíná, když se obsah úkolů kompletně vymění). Session má titulek z `aiTitle`, jinak z prvního promptu. Ukazuje i opuštěné/nedokončené dávky — věrně podle transcriptu.
- **Instructions** — instrukce + paměť dělené podle scope:
  - **Personal** — `~/.claude/CLAUDE.md` (+ managed policy `/etc/claude-code/CLAUDE.md`, pokud existuje).
  - **Project** — `<repo>/CLAUDE.md` + **Auto-memory** (projektový `MEMORY.md` index + jednotlivé fact soubory).
  - **Local** — `<repo>/CLAUDE.local.md` (gitignored, jen tento stroj).
- **Tools** — skilly a MCP použité v aktivní session (Skills + MCP servery a jejich tooly), z `tool_use` bloků transcriptu.
- **Plans** — uložené plány z `~/.claude/plans/`; klik otevře plán.

Klik na položku otevře příslušný soubor. Panel se sám obnovuje při změnách na disku (sleduje session `.jsonl`, `memory/` a `plans/`), plus tlačítko **Obnovit** v hlavičce.

## Vzhled (setting `claudeTools.appearance`)

- **`tree`** (default) — nativní VS Code TreeView (čtyři samostatné views, inline akce, plná integrace).
- **`compact`** — webview, úsporný seznam (vše v jednom pohledu).
- **`cards`** — webview, karty ve stylu cowork widgetu.

Webview skiny sdílí stejnou datovou vrstvu jako TreeView; přepnutí je okamžité. Mazání (popelnice) je zatím jen v `tree` módu.

## Jak to funguje (zdroje dat)

Claude Code nemá veřejné API pro tahle data — extension čte přímo jeho interní soubory v `~/.claude/`:

| Pohled | Zdroj |
|---|---|
| Progress | `~/.claude/projects/<cwd-s-pomlčkami>/<nejnovější>.jsonl` → poslední `tool_use` blok `TodoWrite` (posílá vždy celý seznam) |
| Context · Global | `~/.claude/CLAUDE.md`, `/etc/claude-code/CLAUDE.md` |
| Context · Project | `<repo>/CLAUDE.md` + `~/.claude/projects/<cwd-s-pomlčkami>/memory/MEMORY.md` (+ fact soubory) |
| Context · Local | `<repo>/CLAUDE.local.md` |
| Plans | `~/.claude/plans/*.md` (globální, titulek = první `#` heading) |

Cesta projektové složky vzniká nahrazením `/` za `-` v absolutní cestě workspace.

## Mazání

Položky **Plans** a **Auto-memory fakty** mají na hover ikonu popelnice. Smazání je za potvrzovacím dialogem:

- **Plan** — smaže soubor `~/.claude/plans/<…>.md`.
- **Auto-memory fakt** — smaže fakt soubor **i jeho řádek v `MEMORY.md` indexu** (jinak by položka v panelu zůstala viset jako „(chybí)").

`MEMORY.md` index, `CLAUDE.md` instrukce a Progress/History položky smazat nelze.

> **Varování:** formát těchto souborů je **nedokumentovaný interní artefakt** Claude Code. Při změně formátu se může pohled vyprázdnit (parser je defenzivní — raději prázdno než pád). Čtení je převažující režim; jediný zápis je mazání popelnicí (viz výše) — a to vždy jen po potvrzení.

## Spuštění (dev)

1. Otevři tuto složku ve VS Code.
2. Stiskni **F5** → spustí se Extension Development Host s načteným panelem.
3. V novém okně otevři projekt, kde běží Claude Code → ikona „Claude Tools" v Activity Baru.

## Instalace natrvalo

```bash
npm install -g @vscode/vsce
vsce package          # vytvoří claude-tools-0.1.0.vsix
code --install-extension claude-tools-0.1.0.vsix
```
