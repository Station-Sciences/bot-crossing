# Astronautas residentes + terminal no Windows

Duas mudanças no Bot Crossing. Escritas contra o código real do repo (`main`, 9 commits).

## Instalar

```
cp server/harnesses/automations.mjs  <seu-fork>/server/harnesses/
cp server/lib/win-terminal.mjs       <seu-fork>/server/lib/
cd <seu-fork> && git apply /caminho/patch.diff
```

O `patch.diff` toca dois arquivos: `server/harnesses/index.mjs` (uma linha, registrar o
adapter) e `server/api.mjs` (a função `present`).

Depois, apontando pra sua pasta de automações:

```
set BOT_CROSSING_AUTOMATIONS=C:\Users\wendel\automacoes
npm run dev
```

Cada subpasta direta vira um astronauta. Sem subpasta, sem astronauta.

## Peça 1 — o astronauta residente

`server/harnesses/automations.mjs` é um harness adapter como qualquer outro, só que responde
"quais automações existem" em vez de "quais threads existem". O resultado sai no formato
`Thread`, então o resto do app não sabe a diferença — nada em `src/` mudou.

O que isso te dá:

- **O boneco é permanente.** Ele está no mapa mesmo que você nunca tenha aberto uma sessão ali.
- **Ele martela sozinho.** O adapter lê `~/.claude/sessions/*.json` — os arquivos de processo
  vivo do Claude Code — e casa por diretório de trabalho. Terminal aberto na pasta =
  `running: true` = animação de martelar com faíscas. Fechou o terminal, para no próximo poll.
  Uma sessão numa subpasta também conta.
- **O prédio cresce.** `sizeBytes` é a soma dos arquivos no nível raiz da pasta. Só o nível
  raiz, de propósito: andar na árvore inteira colocaria um `node_modules` no caminho do poll.
- **Nome e descrição opcionais.** Um `automation.json` dentro da pasta com `{title, description}`
  sobrescreve o nome da pasta. Arquivo ausente ou quebrado é o caso normal, não é erro.

Um detalhe sobre o qual você decide depois: com o adapter `claude-code` também ligado, uma
pasta com sessão aberta ganha **dois** astronautas — o residente martelando e a thread real.
Se preferir um só, comente `claudeCode` no `index.mjs` e o residente fica sozinho.

## Peça 2 — abrir terminal no Windows

O repo já sabia abrir terminal, mas só no Linux: `present()` em `api.mjs` faz
`if (process.platform !== 'linux')` e exige um deep link, e todo o `openInTerminal` vive num
arquivo de trivia de desktop Linux (`xdg.mjs`).

O patch:

- Adiciona `server/lib/win-terminal.mjs`, o equivalente Windows. Tenta `wt.exe -d <cwd> <cmd>`
  primeiro e cai pra `cmd.exe /c start "" cmd /k <cmd>`. Processo detached e `unref`'d, pra
  que o terminal sobreviva ao request e não segure o dev server aberto.
- Reescreve o ramo não-Linux de `present()`: deep link continua vindo primeiro (quem tem app
  registrado continua abrindo no app), e **só então** um `command` vai pro terminal.
- Extrai as checagens de pasta que estavam inline no ramo Linux para uma função `inTerminal()`,
  porque agora as duas plataformas precisam delas.

O `claude` é resolvido contra o seu PATH, com `PATHEXT` respeitado — no Windows o binário é
`claude.cmd`, e o `findExecutable` do repo procura o nome literal.

## Verificado

O passo 3 do contrato em `server/harnesses/README.md`:

```
BOT_CROSSING_AUTOMATIONS=/tmp/autos node -e 'import("./server/scan.mjs").then(async m => {
  const t = (await m.scanThreads()).filter(x => x.harness === "automations")
  console.log(t.length, "residentes"); console.dir(t[0], { depth: 4 })
})'
```

3 pastas → 3 residentes, nenhum campo `undefined`, `automation.json` aplicado, e um arquivo
de sessão viva apontando pra uma das pastas virou `running: true` só naquela. `node --check`
limpo nos quatro arquivos.

O que **não** foi testado aqui: `win-terminal.mjs` rodando de verdade — este container é
Linux. O caminho do `wt.exe` e o do `cmd.exe` você confirma na primeira vez que clicar.
