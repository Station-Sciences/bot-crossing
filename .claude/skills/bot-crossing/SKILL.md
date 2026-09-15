---
name: bot-crossing
description: Manual completo do BOT CROSSING da GP — colônia 3D (three.js + Vite) onde cada thread de agente de código (Claude Code, Codex, Cursor) e cada AUTOMAÇÃO da GP vira um habitante num mapa hexagonal. Fork do bot-crossing de Jarren Rocks com três adições próprias — harness "automations" (um astronauta residente por pasta de automação), abertura em terminal no Windows, e o planeta "reef" (peixes em vez de astronautas). Invocada com /bot-crossing. Use quando o Wendel (ou o time) for subir o bot, adicionar/renomear uma automação no mapa, mexer no harness de automações, no mundo reef, no servidor/API, ou depurar por que uma automação não aparece ou não "martela".
---

# Bot Crossing da GP

Colônia 3D no navegador. Cada thread de agente de código na máquina é um astronauta (ou, no
planeta reef, um peixe); cada repositório/pasta é uma zona hexagonal. Tudo lê arquivos locais e
**nunca escreve num harness** — o único arquivo escrito é `data/colony.json` (layout + arquivados).

Origem: fork de `github.com/jarrenrocks/bot-crossing` (MIT, arte CC0 de Kay Lousberg).
O README.md do projeto documenta o upstream em detalhe (câmera, render, PBR, navegação A*, etc.);
esta skill cobre **o que a GP fez em cima** e o mapa mental para mexer sem reler tudo.

## 1. Como subir

```powershell
.\iniciar.ps1          # na raiz do projeto
```
Faz: `Set-Location` na raiz, `BOT_CROSSING_AUTOMATIONS = C:\Users\GTI\Documents\Automações da GP\Projetos`, `npm run dev`.

- Node >= 22.13. `npm install` uma vez. `npm test` roda a suíte (`test/*.test.mjs`).
- `npm run dev` é tudo: a API vive dentro do Vite (sem segundo processo). Porta **5274 sempre**.
- **Regra da porta**: antes de reiniciar, derrube o processo antigo:
  ```powershell
  Get-NetTCPConnection -LocalPort 5274 | ForEach-Object { Stop-Process -Id $_.OwningProcess -Force }
  ```
  Nunca deixe o Vite pular para 5275+ (quebra bookmark e o localStorage das settings, que é por origem).
- Build: `npm start` (build + `server/serve.mjs`) ou `npm run serve` se `dist/` já existe.
- Sem `BOT_CROSSING_AUTOMATIONS` o harness de automações se desliga (nenhum residente aparece).

## 2. Arquitetura em uma tela

```
server/
  harnesses/           um adapter por harness — README.md é o CONTRATO (Thread shape)
    index.mjs          registro: HARNESSES = [claudeCode, codex, cursor, automations]
    claude-code.mjs    desktop + CLI; GP: cliBinary() respeita PATHEXT (claude.cmd) e abre terminal no win32
    codex.mjs / cursor.mjs
    automations.mjs    * GP: um astronauta RESIDENTE por subpasta de BOT_CROSSING_AUTOMATIONS
  lib/
    fsutil.mjs         exists, listDirs, listFiles, readHead, findExecutable
    xdg.mjs            Linux: openInTerminal, schemeHasHandler
    win-terminal.mjs   * GP: openInTerminalWindows(argv, cwd) — wt.exe, fallback cmd /c start "" cmd /k
  scan.mjs             pergunta a todo harness detectado, mescla, ordena (agnóstico)
  api.mjs              /api/threads /harnesses /state /open /archive /new-session /reveal
                       GP: present() no win32 prefere command->terminal, deep link é fallback
  serve.mjs            estático do dist
src/
  core/    settings.js (DEFAULTS.planet = 'reef'), engine, camera Google-Earth, tiltshift
  world/   planet.js (presets moon/mars/terra/reef), sky.js, plots.js (style 'reef'), reef.js *,
           buildings.js, kit.js, ship.js, surfaces.js
  agents/  astronauts.js, crew.js (bake de animação), fish.js *, faces, indicators, particles
  game/    colony.js (threads->mundo; _buildInhabitants/_switchBiome *), api.js, merge-state, hidden-projects
  ui/      hud.js, hud-data.js, styles.css
tools/     empacotadores de assets (glb)   public/assets/  spacebase.glb crew.glb forest.glb
data/colony.json   layout + arquivados (gitignored)   docs/reef-world.md   conceito do reef
```
`*` = adição da GP (ainda não commitada em 11/09/2026; `git status` mostra os arquivos).

Regra do upstream que vale manter: tudo que sabe como são os arquivos de um harness fica em
`server/harnesses/`; scanner, API e `src/` só conhecem o **Thread shape** (tabela de campos no
`server/harnesses/README.md`: id, title, preview, project, projectPath, cwd, running, unread,
hasError, archived, sizeBytes, lastActivityAt, canOpen, ref...).

## 3. Harness "automations" (o coração do bot da GP)

`server/harnesses/automations.mjs`. Diferente dos outros adapters (que respondem "quais threads
existem"), ele responde "quais automações existem" e devolve cada uma **no formato de Thread**,
então a colônia desenha sem saber a diferença. O astronauta é permanente: fica na sua zona
tenha ou não sessão aberta.

- **Raiz**: `process.env.BOT_CROSSING_AUTOMATIONS`. Cada subpasta direta = 1 automação = 1 zona.
- **Filtro de nome**: pula pastas iniciadas com `.` e nomes fora do regex `SAFE_SLUG`
  (letras/números Unicode, `_ . @ - espaço ( )`). Nome inválido é pulado, não sanitizado.
  Arquivos (ex.: `.zip`) são ignorados porque só `listDirs` é usado.
- **Id**: `automations:<nome-da-pasta>`. O layout e o arquivo de arquivados são chaveados por
  esse id → **renomear a pasta = perde a zona e o estado de arquivado** (resultado honesto).
- **Metadados opcionais**: `automation.json` na pasta com `{ "title": "...", "description": "..." }`.
  Ausente/mal-formado = sem overrides (título = nome da pasta). Nenhuma automação usa hoje.
- **"Martelando" (running)**: lê `~/.claude/sessions/*.json` (arquivos de processo vivo do
  Claude Code, `{pid, cwd}`), testa `process.kill(pid, 0)` e marca `running` se o `cwd` vivo
  é a pasta da automação **ou uma subpasta dela**. Ou seja: terminal `claude` aberto na pasta
  → astronauta martela; fechou → para. Sessão pré-aquecida ociosa ainda conta (decisão explícita).
  Só Claude Code é observado; Codex/Cursor não acendem residentes.
- **Tamanho do prédio** (`sizeBytes`): soma só dos arquivos do nível raiz da pasta (não desce
  em `node_modules`). Escala log, é só pista visual. `lastActivityAt` = mtime mais novo do nível raiz.
- **Sempre**: `unread:false`, `hasError:false`, `archived:false`, `source:'resident'`, `canOpen:true`.
  Logo residentes nunca mostram `?` nem `!`; só martelam, dormem (3 dias sem mtime) ou passeiam.
- **Abrir / Nova conversa**: não há sessão para resumir, então não há deep link — só um
  comando: `{ argv: [claude(.cmd)], cwd: pasta }`. `claude` é resolvido no PATH do usuário
  consultando `PATHEXT` na ordem (no Windows é `claude.cmd`). Sem `claude` no PATH → erro na UI.
- **Detect**: `ROOT` definido e existente.

### Fluxo de um clique em "Open" no Windows (`server/api.mjs`, função `present()`)
1. Adapter devolve `{ok, command?, url?}`.
2. win32 e há `command` → `inTerminal()` valida cwd (existe, é dir, entrável) → `openInTerminalWindows`.
3. Tenta `wt.exe -d <cwd> <argv>`; senão `cmd.exe /c start "" cmd.exe /k <argv>` (o `""` é o
   título da janela, obrigatório; `/k` mantém a janela aberta para ver erro).
4. Spawn `detached` + `unref` (o terminal sobrevive ao dev server). Falhou e há `url` → deep link.
5. Linux usa `xdg.mjs`; macOS só deep link.

Threads normais do Claude Code (CLI) também abrem em terminal no Windows agora
(`claude --resume <id>`), via `TERMINAL_PLATFORM` em `claude-code.mjs`.

### Adicionar uma automação ao mapa
Crie a subpasta em `...\Automações da GP\Projetos\`. No próximo poll ela aparece com uma zona
nova (pega os hexes livres mais internos). Opcional: `automation.json` para título/descrição.

### Diagnóstico rápido
| Sintoma | Verificar |
| --- | --- |
| Nenhum residente | `BOT_CROSSING_AUTOMATIONS` setado? use `iniciar.ps1`. `GET /api/harnesses` lista `automations`? |
| Automação X não aparece | nome passa em `SAFE_SLUG`? começa com `.`? é pasta (não .zip)? |
| Não martela com terminal aberto | há `~/.claude/sessions/*.json` com `cwd` dentro da pasta e pid vivo? Só Claude Code conta. |
| "claude is not on your PATH" | `where claude` no cmd; adapter procura `claude.com/.exe/.bat/.cmd`. |
| Zona mudou de lugar | pasta renomeada (id mudou) ou `data/colony.json` apagado. |
| Automação sumiu do mapa | 3 dias sem mtime → "dormant", dobrada; volta pela lista no rodapé do sidebar ou desligue "Hide dormant repos". |
| curl POST recusado | server checa `Host` e `Origin`; passe `-H "Origin: http://localhost:5274"`. |

## 4. Planeta "reef" (mundo padrão)

Construído em 11/09/2026 com a skill `agent-session-world`. Conceito e mapeamento completo em
`docs/reef-world.md`. É o **default** (`settings.js: planet: 'reef'`); `Tab` alterna planetas
(moon/mars/terra/reef) ao vivo mantendo as zonas nos mesmos hexes.

- Thread = peixe (espécie/cor hash do id). Zona = laje de rocha com crosta de coral na cor do repo.
  Estrutura por thread = colônia de coral (`createCoral` em `src/world/reef.js`), cresce com o
  mesmo shader "afunda e descarta" dos prédios. Chegada/saída = naufrágio (hatch) no lugar do lander.
- Estados: errado = tomba de lado com pulso vermelho; trabalhando = nariz na areia levantando
  sedimento; celebrando = looping + glitter; esperando = sobe à superfície com coluna de bolhas e `?`;
  dormindo = pousado na areia; resto = passeia na altura de cruzeiro.
- Código: `src/world/reef.js` (corais, naufrágio, feixes de luz, shaders caustics/sway/bio),
  `src/agents/fish.js` (cardume instanciado, mesma interface de `Astronauts`), preset `reef` em
  `planet.js` (`underwater:true, scatter:'coral'`), domo subaquático em `sky.js`, `style:'reef'`
  em `plots.js`, troca de bioma em `colony.js` (`_buildInhabitants`, `_switchBiome`), e
  `main.js` chama `colony.setRig(...)` (não mais `colony.astronauts.setRig`).
- Números (headless, Balanced, 24 threads): Moon 172 draws / 647k tris; Reef 169 / 285k.
- Verificação headless sem a extensão do Chrome: lançar `chrome-headless-shell` do playwright
  com `--remote-debugging-port`, via CDP avaliar `botCrossing.settings.set('planet','reef')`
  e ler `engine.canvas.toDataURL()` (screenshot do compositor sai preto para WebGL; `await`
  de topo precisa de IIFE async).

## 5. Comportamento e UI (resumo do upstream que importa no dia a dia)

Precedência estrita de estado (primeiro que bate vence): Errored `!` → Running `⚒` → PR merged
`✓` → Unread `?` → 3 dias parado (dorme) → resto. Só quem precisa de você ganha badge.

Mapa: 1 zona hex = 1 repo/automação (1 tile por 7 threads, blob contíguo); 1 habitante + 1
estrutura = 1 sessão; tamanho da estrutura = tamanho do transcript (log); layout é "sticky" e
salvo em `data/colony.json` (a zona não muda de lugar quando outro repo cresce).

Teclas: `H` esconde painéis, `S` settings, `N` próximo esperando, `Enter/A` abrir/arquivar,
`V` visto, `C` nova conversa na pasta da zona, `O` órbita, `Tab` planeta, `L` hora do dia,
`P` screenshot, `0` reset, `Esc` desselecionar, `?` ajuda.

Painel direito = repo selecionado (Nova conversa, Explorer, Copiar caminho, threads). Card ao
lado do habitante = a thread (Open / Viewed / Archive / Hide). Repos quietos por 3 dias somem
do mapa por padrão ("Hide dormant repos" em settings); a lista no rodapé do sidebar traz de volta.

Arquivar é só local (`data/colony.json`); o peixe/astronauta volta pro naufrágio/nave.
Apagar `data/colony.json` só perde layout e arquivados; a colônia se reorganiza do zero.

Qualidade: 5 presets (Potato→Ultra); render scale é a maior alavanca; adaptive quality reduz
sozinho abaixo do escolhido; HDR+bloom desligado libera memória.

## 6. Segurança / rede
Liga em `127.0.0.1`, checa `Host` (anti DNS-rebinding) e `Origin` (anti CSRF). Sem senha.
`BOT_CROSSING_HOST=0.0.0.0 npm start` expõe na rede: quem alcança a porta vê títulos, prompts,
caminhos e branches de tudo, e pode abrir terminais na máquina. Só em rede própria.
Lê: registros/transcripts dos harnesses. Escreve: só `data/colony.json`. Envia: nada.

## 7. Onde mexer para cada mudança
| Quero... | Arquivo |
| --- | --- |
| Mudar de onde vêm as automações / regra de "vivo" / título | `server/harnesses/automations.mjs` |
| Trocar terminal usado no Windows ou ordem wt/cmd | `server/lib/win-terminal.mjs` |
| Mudar quando abre terminal vs. app desktop | `server/api.mjs` → `present()` |
| Novo harness | novo arquivo em `server/harnesses/` + 1 linha em `index.mjs` (contrato no README da pasta) |
| Visual do reef (coral, naufrágio, peixe) | `src/world/reef.js`, `src/agents/fish.js` |
| Novo planeta | preset em `src/world/planet.js` (é dado, não código) |
| Planeta padrão, presets de qualidade, "hide dormant" | `src/core/settings.js` |
| Mapeamento estado→animação/comportamento | `src/game/colony.js`, `src/agents/astronauts.js` / `fish.js` |
| Painel/HUD | `src/ui/hud.js`, `hud-data.js` |
| Regenerar glbs | `npm run assets` (precisa dos packs em `assets-src/`) |
| Outro mundo/metáfora do zero | skill `agent-session-world` em `.claude/skills/` |

## 8. Pendências conhecidas (11/09/2026)
- Adições da GP ainda não commitadas (automations, win-terminal, reef, fish, iniciar.ps1, docs).
- Nenhuma automação tem `automation.json` ainda; títulos = nome das pastas.
- Residentes nunca ficam "unread"/"error": não há sinal de "precisa de você" para automações.
- Nomes de pasta iguais em raízes diferentes crescem para a esquerda (`1/foo`, `2/foo`) — só os que colidem.
