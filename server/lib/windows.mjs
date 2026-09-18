/**
 * Windows desktop plumbing: put the window that hosts a given process in front.
 *
 * The sibling of `xdg.mjs`, for the same reason — a page of OS trivia with nothing to do with
 * HTTP, and nothing in here knows about a particular harness. An adapter hands the server a pid;
 * the server decides whether fronting its window is the right way to answer "open this".
 *
 * The pid itself has no window — it is a CLI process. The window belongs to whatever terminal is
 * hosting it, which is some ancestor: the shell's parent is Windows Terminal, VS Code, an IDE.
 * So the walk goes *up* the parent chain until a process with a real main window appears, and
 * fronts that. The Claude desktop app is deliberately stepped over: a process hosted by the app
 * itself is the app's to present, and the deep link does that better than raw window fronting.
 */
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'

const execFileAsync = promisify(execFile)

/**
 * Enumerating every process (`Get-CimInstance Win32_Process`) is the slow half, a second or two
 * on a busy machine; the rest is instant. The budget covers that with room, because past it the
 * caller falls back to the deep link — a worse answer than a fronted window, but never a hang.
 */
const FOCUS_TIMEOUT_MS = 8000

/** How many parents to visit before concluding nothing on the chain owns a window. */
const MAX_HOPS = 16

/**
 * `SetForegroundWindow` alone is refused when the caller is a background process — Windows
 * reserves focus-stealing for whoever the user is interacting with. A transient Alt keypress
 * (0xA4, down then up) is the documented-by-folklore exemption: a process that just sent input
 * counts as interacting. Restore-first matters too: fronting a minimized window leaves it
 * minimized, just "active" in the taskbar.
 */
const script = (pid) => `
$ErrorActionPreference = 'SilentlyContinue'
$parent = @{}
foreach ($p in Get-CimInstance Win32_Process) { $parent[[int]$p.ProcessId] = [int]$p.ParentProcessId }
Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
public static class BotCrossingFocus {
  [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr h);
  [DllImport("user32.dll")] public static extern bool ShowWindowAsync(IntPtr h, int cmd);
  [DllImport("user32.dll")] public static extern bool IsIconic(IntPtr h);
  [DllImport("user32.dll")] public static extern void keybd_event(byte key, byte scan, uint flags, UIntPtr extra);
}
'@
$cur = ${pid}
for ($i = 0; $i -lt ${MAX_HOPS} -and $cur -gt 0; $i++) {
  $proc = Get-Process -Id $cur
  if ($proc -and $proc.MainWindowHandle -ne [IntPtr]::Zero) {
    # The first *windowed* ancestor decides. The Claude app means the thread is the app's own —
    # its deep link presents it better; explorer is the chain's root, and fronting a stray File
    # Explorer window would be plain wrong. Either way: stop, let the caller fall back.
    if ($proc.ProcessName -eq 'claude' -or $proc.ProcessName -eq 'explorer') { exit 1 }
    $h = $proc.MainWindowHandle
    if ([BotCrossingFocus]::IsIconic($h)) { [BotCrossingFocus]::ShowWindowAsync($h, 9) | Out-Null }
    [BotCrossingFocus]::keybd_event(0xA4, 0, 0, [UIntPtr]::Zero)
    [BotCrossingFocus]::keybd_event(0xA4, 0, 2, [UIntPtr]::Zero)
    [BotCrossingFocus]::SetForegroundWindow($h) | Out-Null
    'focused'
    exit 0
  }
  if (-not $parent.ContainsKey($cur)) { break }
  $next = $parent[$cur]
  if ($next -eq $cur) { break }
  $cur = $next
}
exit 1
`

/**
 * Front the window hosting `pid`. True only when a window was actually found and told to come
 * forward; false covers everything else — wrong platform, a chain with no window on it (a
 * detached process, or one hosted by the Claude desktop app), or PowerShell being unavailable.
 * The caller treats false as "use the URL instead", so failing quietly is the whole contract.
 */
export async function focusWindowOfPid(pid) {
  if (process.platform !== 'win32') return false
  if (!Number.isInteger(pid) || pid <= 0) return false
  try {
    // -EncodedCommand sidesteps every quoting rule cmd and PowerShell disagree on.
    const encoded = Buffer.from(script(pid), 'utf16le').toString('base64')
    const { stdout } = await execFileAsync(
      'powershell.exe',
      ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-EncodedCommand', encoded],
      { timeout: FOCUS_TIMEOUT_MS, windowsHide: true }
    )
    return stdout.includes('focused')
  } catch {
    return false
  }
}
