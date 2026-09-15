# Sobe o Bot Crossing com os astronautas residentes apontando para as automações da GP.
# Uso: clique-direito > Executar com PowerShell, ou `.\iniciar.ps1` num terminal.
Set-Location -Path $PSScriptRoot
$env:BOT_CROSSING_AUTOMATIONS = "C:\Users\GTI\Documents\Automações da GP\Projetos"
npm run dev
