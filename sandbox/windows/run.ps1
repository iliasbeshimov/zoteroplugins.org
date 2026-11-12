<#
Zotero Atlas's windows on a real Windows desktop: is each window's title bar, close button
included, on screen, and do Escape and Ctrl+W close the Atlas window? Starts Zotero with Atlas and
the test driver (driver/) in a new profile, photographs the screen at each step, and writes
summary.json (and a table for the GitHub job summary).

The screen is set to 1280x720 first: what a 1080p screen at 150% scaling leaves a window, the
usual Windows laptop.

  pwsh sandbox/windows/run.ps1 -Zotero C:\zotero\zotero.exe -Xpi zotero-atlas-1.0.1.xpi -Out out
  -MustPass  exit 1 when a check fails (for the build under test; the released one may fail)
#>
param(
  [Parameter(Mandatory)] [string] $Zotero,
  [Parameter(Mandatory)] [string] $Xpi,
  [Parameter(Mandatory)] [string] $Out,
  [int] $Width = 1280,
  [int] $Height = 720,
  [switch] $MustPass
)
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Windows.Forms, System.Drawing
Add-Type -TypeDefinition @'
using System;
using System.Text;
using System.Collections.Generic;
using System.Runtime.InteropServices;

public static class Win {
  [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Ansi)]
  public struct DEVMODE {
    [MarshalAs(UnmanagedType.ByValTStr, SizeConst = 32)] public string dmDeviceName;
    public short dmSpecVersion, dmDriverVersion, dmSize, dmDriverExtra;
    public int dmFields, dmPositionX, dmPositionY, dmDisplayOrientation, dmDisplayFixedOutput;
    public short dmColor, dmDuplex, dmYResolution, dmTTOption, dmCollate;
    [MarshalAs(UnmanagedType.ByValTStr, SizeConst = 32)] public string dmFormName;
    public short dmLogPixels;
    public int dmBitsPerPel, dmPelsWidth, dmPelsHeight, dmDisplayFlags, dmDisplayFrequency;
    public int dmICMMethod, dmICMIntent, dmMediaType, dmDitherType, dmReserved1, dmReserved2;
    public int dmPanningWidth, dmPanningHeight;
  }
  [StructLayout(LayoutKind.Sequential)]
  public struct RECT { public int Left, Top, Right, Bottom; }
  public delegate bool EnumProc(IntPtr h, IntPtr l);

  [DllImport("user32.dll", CharSet = CharSet.Ansi)] static extern bool EnumDisplaySettings(string dev, int mode, ref DEVMODE dm);
  [DllImport("user32.dll", CharSet = CharSet.Ansi)] static extern int ChangeDisplaySettings(ref DEVMODE dm, int flags);
  [DllImport("user32.dll")] static extern bool EnumWindows(EnumProc f, IntPtr l);
  [DllImport("user32.dll", CharSet = CharSet.Unicode)] static extern int GetWindowText(IntPtr h, StringBuilder s, int n);
  [DllImport("user32.dll")] static extern bool IsWindowVisible(IntPtr h);
  [DllImport("user32.dll")] static extern uint GetWindowThreadProcessId(IntPtr h, out uint pid);
  [DllImport("user32.dll")] static extern bool GetWindowRect(IntPtr h, out RECT r);
  [DllImport("dwmapi.dll")] static extern int DwmGetWindowAttribute(IntPtr h, int attr, out RECT r, int size);
  [DllImport("user32.dll")] static extern bool SystemParametersInfo(int action, int p, ref RECT r, int f);
  [DllImport("user32.dll")] static extern bool SetForegroundWindow(IntPtr h);
  [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
  [DllImport("user32.dll")] static extern void keybd_event(byte vk, byte scan, int flags, IntPtr extra);
  [DllImport("user32.dll")] public static extern bool SetProcessDPIAware();

  public static int SetResolution(int w, int h) {
    DEVMODE dm = new DEVMODE();
    dm.dmSize = (short)Marshal.SizeOf(typeof(DEVMODE));
    if (!EnumDisplaySettings(null, -1, ref dm)) return -99;
    dm.dmPelsWidth = w;
    dm.dmPelsHeight = h;
    dm.dmFields = 0x80000 | 0x100000; // DM_PELSWIDTH | DM_PELSHEIGHT
    return ChangeDisplaySettings(ref dm, 0);
  }

  public static string Title(IntPtr h) {
    StringBuilder s = new StringBuilder(512);
    GetWindowText(h, s, s.Capacity);
    return s.ToString();
  }

  // Visible top-level windows of these processes (all of them if null), front to back.
  public static List<IntPtr> Windows(uint[] pids) {
    List<IntPtr> found = new List<IntPtr>();
    HashSet<uint> want = pids == null ? null : new HashSet<uint>(pids);
    EnumWindows(delegate (IntPtr h, IntPtr l) {
      uint pid;
      GetWindowThreadProcessId(h, out pid);
      if ((want == null || want.Contains(pid)) && IsWindowVisible(h)) found.Add(h);
      return true;
    }, IntPtr.Zero);
    return found;
  }

  public static uint Owner(IntPtr h) {
    uint pid;
    GetWindowThreadProcessId(h, out pid);
    return pid;
  }

  // The window as drawn, without the invisible resize borders (DWMWA_EXTENDED_FRAME_BOUNDS).
  public static RECT Frame(IntPtr h) {
    RECT r;
    if (DwmGetWindowAttribute(h, 9, out r, Marshal.SizeOf(typeof(RECT))) != 0) GetWindowRect(h, out r);
    return r;
  }

  public static RECT WorkArea() {
    RECT r = new RECT();
    SystemParametersInfo(0x30, 0, ref r, 0); // SPI_GETWORKAREA: the screen less the taskbar
    return r;
  }

  // A process in the background may not bring a window forward; a tap of Alt lets it.
  public static void Focus(IntPtr h) {
    keybd_event(0x12, 0, 0, IntPtr.Zero);
    SetForegroundWindow(h);
    keybd_event(0x12, 0, 2, IntPtr.Zero);
  }
}
'@
[void][Win]::SetProcessDPIAware()

function Rect($r) { [ordered]@{ left = $r.Left; top = $r.Top; right = $r.Right; bottom = $r.Bottom } }

function Shot([string] $path) {
  $b = [System.Windows.Forms.SystemInformation]::VirtualScreen
  $bmp = New-Object System.Drawing.Bitmap $b.Width, $b.Height
  $g = [System.Drawing.Graphics]::FromImage($bmp)
  $g.CopyFromScreen($b.Left, $b.Top, 0, 0, $bmp.Size)
  $bmp.Save($path, [System.Drawing.Imaging.ImageFormat]::Png)
  $g.Dispose()
  $bmp.Dispose()
}

function Describe([IntPtr] $h) {
  if ($h -eq [IntPtr]::Zero) { return '(none)' }
  $name = (Get-Process -Id ([Win]::Owner($h)) -ErrorAction SilentlyContinue).ProcessName
  "'$([Win]::Title($h))' ($name)"
}

function AtlasWindow {
  $pids = [uint32[]]@(Get-Process zotero -ErrorAction SilentlyContinue | ForEach-Object { $_.Id })
  if (-not $pids) { return $null }
  foreach ($h in [Win]::Windows($pids)) {
    if ([Win]::Title($h) -eq 'Zotero Atlas') { return $h }
  }
  return $null
}

# --- the screen ---------------------------------------------------------------------------------
$rc = [Win]::SetResolution($Width, $Height)
Start-Sleep -Seconds 2
$screen = [System.Windows.Forms.Screen]::PrimaryScreen
Write-Host "Resolution change to ${Width}x${Height}: $rc (0 = done). Screen $($screen.Bounds.Width)x$($screen.Bounds.Height), work area $($screen.WorkingArea)"

# Windows 11 runners can show the "Choose privacy settings for your device" setup screen over
# everything, and it takes the keyboard. Turn it off and close it.
try {
  $oobe = 'HKLM:\SOFTWARE\Policies\Microsoft\Windows\OOBE'
  New-Item -Force $oobe | Out-Null
  Set-ItemProperty $oobe -Name DisablePrivacyExperience -Value 1 -Type DWord
} catch { Write-Host "Couldn't turn off the privacy screen: $_" }
Get-Process WWAHost, CloudExperienceHostBroker, UserOOBEBroker -ErrorAction SilentlyContinue | Stop-Process -Force
Start-Sleep -Seconds 1
Write-Host "Visible windows: $((@([Win]::Windows($null)) | ForEach-Object { Describe $_ }) -join '; ')"

# --- a new profile with Atlas and the driver -------------------------------------------------
$Out = [IO.Path]::GetFullPath($Out)
$P = Join-Path $Out 'profile'
$D = Join-Path $Out 'data'
$IO = Join-Path $Out 'io'
$Shots = Join-Path $Out 'shots'
foreach ($dir in $P, $D, $IO, $Shots, (Join-Path $P 'extensions')) { New-Item -ItemType Directory -Force $dir | Out-Null }
$dataDir = $D -replace '\\', '\\'
[IO.File]::WriteAllText((Join-Path $P 'user.js'), @"
user_pref("extensions.zotero.dataDir", "$dataDir");
user_pref("extensions.zotero.useDataDir", true);
user_pref("extensions.zotero.firstRun2", false);
user_pref("extensions.zotero.firstRunGuidance", false);
user_pref("extensions.zotero.automaticScraperUpdates", false);
user_pref("extensions.zotero.sync.autoSync", false);
user_pref("extensions.zotero.httpServer.enabled", false);
user_pref("extensions.zotero.reportTranslationFailure", false);
user_pref("extensions.autoDisableScopes", 0);
user_pref("extensions.enabledScopes", 15);
user_pref("extensions.update.enabled", false);
user_pref("app.update.enabled", false);
user_pref("app.update.auto", false);
user_pref("app.update.disabledForTesting", true);
user_pref("toolkit.telemetry.enabled", false);
user_pref("datareporting.policy.dataSubmissionEnabled", false);
"@)
Copy-Item $Xpi (Join-Path $P 'extensions\atlas@zoteroatlas.com.xpi')
# A proxy file: the add-on is the folder it names.
$driver = (Resolve-Path (Join-Path $PSScriptRoot 'driver')).Path + '\'
[IO.File]::WriteAllText((Join-Path $P 'extensions\atlas-windows-driver@zoteroplugins.invalid'), $driver)

# --- run -------------------------------------------------------------------------------------
$env:ATLAS_WIN_IO = $IO
$zotero = Start-Process -FilePath $Zotero -ArgumentList @('-profile', "`"$P`"", '-no-remote') -PassThru
Write-Host "Zotero started (pid $($zotero.Id))"

$os = [ordered]@{}
$handled = @{}
$deadline = (Get-Date).AddMinutes(10)
$finished = Join-Path $IO 'finished.json'
Start-Sleep -Seconds 20
Shot (Join-Path $Shots '00-zotero.png')
while ((Get-Date) -lt $deadline -and -not (Test-Path $finished)) {
  foreach ($f in Get-ChildItem $IO -Filter 'ready-*.json') {
    if ($handled.ContainsKey($f.Name)) { continue }
    try { $r = Get-Content $f.FullName -Raw | ConvertFrom-Json } catch { continue } # still being written
    $handled[$f.Name] = $true
    $step = $r.step
    $n = '{0:d2}' -f ($handled.Count)
    $h = AtlasWindow
    $work = [Win]::WorkArea()
    $info = [ordered]@{ found = [bool]$h; workArea = Rect $work }
    if ($h) {
      $frame = [Win]::Frame($h)
      $info.frame = Rect $frame
      # The close button is in the title bar's top-right corner: both must be inside the work area.
      $info.titleBarOnScreen = ($frame.Top -ge $work.Top) -and ($frame.Left -ge $work.Left) -and ($frame.Right -le $work.Right)
      $info.closeButtonOnScreen = ($frame.Top -ge $work.Top) -and ($frame.Right -le $work.Right)
    }
    Shot (Join-Path $Shots "$n-$step-1-open.png")
    if ($h) { [Win]::Focus($h); Start-Sleep -Milliseconds 400 }
    $front = [Win]::GetForegroundWindow()
    $info.focused = $h -and ($front -eq $h)
    if (-not $info.focused) { $info.inFront = Describe $front }
    [System.Windows.Forms.SendKeys]::SendWait($r.key)
    New-Item -ItemType File -Force (Join-Path $IO "acted-$step") | Out-Null
    Start-Sleep -Milliseconds 1000
    Shot (Join-Path $Shots "$n-$step-2-after-key.png")
    $os[$step] = $info
    Write-Host "$step : $($info | ConvertTo-Json -Compress -Depth 4)"
  }
  Start-Sleep -Milliseconds 250
}
Start-Sleep -Seconds 1
Get-Process zotero -ErrorAction SilentlyContinue | Stop-Process -Force

# --- what it found ---------------------------------------------------------------------------
$driverOut = if (Test-Path $finished) { Get-Content $finished -Raw | ConvertFrom-Json } else { $null }
$checks = @()
function Check([string] $name, [bool] $ok, [string] $detail) {
  $script:checks += [ordered]@{ check = $name; ok = $ok; detail = $detail }
}
if (-not $driverOut) {
  Check 'run finished' $false 'the driver never wrote finished.json'
} else {
  foreach ($e in $driverOut.errors) { Check 'driver error' $false $e }
  $by = @{}
  foreach ($r in $driverOut.results) { $by[$r.step] = $r }
  foreach ($step in 'firstrun', 'escape') {
    $o = $os[$step]
    if (-not $o -or -not $o.found) { Check "$step window found" $false 'no window titled Zotero Atlas'; continue }
    Check "$step title bar on screen" ([bool]$o.closeButtonOnScreen) ("window top {0}, right {1}; work area top {2}, right {3}" -f $o.frame.top, $o.frame.right, $o.workArea.top, $o.workArea.right)
  }
  $first = $by['firstrun']
  if ($first -and -not $first.missing) { Check 'Enter closes the first-run screen' ([bool]$first.closed) '' }
  Check 'first-run answer kept as "Don''t send"' ($by['answers'].usage -eq 'no') "usage = $($by['answers'].usage)"
  Check 'Escape closes the Atlas window' ([bool]$by['escape'].closed) ''
  Check 'Ctrl+W closes the Atlas window' ([bool]$by['ctrl-w'].closed) ''
  $s = $by['escape-search']
  Check 'Escape in a filled search box empties it and keeps the window' ((-not $s.closed) -and ($s.searchAfter -eq '')) "closed=$($s.closed) search='$($s.searchAfter)'"
  $p = $by['dropdown'].popup
  $painted = { param($c) $c -and $c -ne 'rgba(0, 0, 0, 0)' -and $c -ne 'transparent' }
  $opaque = $p -and ($p.state -eq 'open') -and ((& $painted $p.host) -or (& $painted $p.content))
  Check 'The "All jobs" list opens with a background' ([bool]$opaque) "state=$($p.state) host=$($p.host) content=$($p.content) appearance=$($p.appearance)"
  Check 'Each option in the list shows its text once' ($p -and $p.texts -eq 1) "texts shown in the first option: $($p.texts)"
  foreach ($step in 'firstrun', 'escape', 'ctrl-w', 'dropdown', 'escape-search') {
    if ($os[$step] -and -not $os[$step].focused) { Write-Host "::warning::$step window wasn't in front when the key was pressed" }
  }
}

$summary = [ordered]@{
  zotero = $Zotero
  xpi = (Split-Path $Xpi -Leaf)
  screen = "$($screen.Bounds.Width)x$($screen.Bounds.Height)"
  workArea = "$($screen.WorkingArea)"
  resolutionChange = $rc
  checks = $checks
  windows = $os
  driver = $driverOut
}
$summary | ConvertTo-Json -Depth 8 | Set-Content -Encoding utf8 (Join-Path $Out 'summary.json')

$md = @("### $(Split-Path $Xpi -Leaf) on $($summary.screen) (work area $($summary.workArea))", '', '| Check | Result | Detail |', '|---|---|---|')
foreach ($c in $checks) { $md += "| $($c.check) | $(if ($c.ok) { 'pass' } else { '**FAIL**' }) | $($c.detail) |" }
$md -join "`n" | Write-Host
if ($env:GITHUB_STEP_SUMMARY) { ($md -join "`n") + "`n" | Add-Content $env:GITHUB_STEP_SUMMARY }

$failed = @($checks | Where-Object { -not $_.ok }).Count
if ($MustPass -and $failed) { Write-Host "$failed check(s) failed"; exit 1 }
exit 0
