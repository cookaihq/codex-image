# check_update.ps1 — skill 自动检查更新的 Windows/PowerShell 适配器
#
# 该脚本与同目录的 check_update.sh 实现同一份 Git 更新协议：默认只检查，
# 检测到更新返回 10；只有用户确认后传入 -Pull，才允许 merge --ff-only。
# 复制安装（没有 Git 仓根）仍由宿主适配器读取 Skill 的 update.json 处理。

param(
    [switch]$Pull,
    [switch]$Help,
    [string]$ReadVersion
)

$ErrorActionPreference = 'Continue'
$ThrottleSeconds = 21600
$FetchTimeoutMilliseconds = 5000
$ExitUpdateAvailable = 10
$script:PullExitCode = 0

function Write-Usage {
    Write-Output "用法："
    Write-Output "  powershell -ExecutionPolicy Bypass -File scripts/check_update.ps1"
    Write-Output "  powershell -ExecutionPolicy Bypass -File scripts/check_update.ps1 -Pull"
    Write-Output "  powershell -ExecutionPolicy Bypass -File scripts/check_update.ps1 -Help"
    Write-Output ""
    Write-Output "退出码：0 无事发生 / 拉取成功；10 检测到更新；1 拒绝或失败。"
}

function Get-TrimmedEnvValue([string]$Path, [string]$Key) {
    if (-not (Test-Path -LiteralPath $Path -PathType Leaf)) { return $null }
    $result = $null
    foreach ($line in (Get-Content -LiteralPath $Path -Encoding UTF8 -ErrorAction SilentlyContinue)) {
        $text = ([string]$line).Trim()
        if ($text -eq '' -or $text.StartsWith('#')) { continue }
        if ($text.StartsWith('export ')) { $text = $text.Substring(7).Trim() }
        $match = [regex]::Match($text, '^([^=]+?)\s*=\s*(.*)$')
        if (-not $match.Success -or $match.Groups[1].Value.Trim() -ne $Key) { continue }
        $value = $match.Groups[2].Value.Trim()
        if ($value.Length -ge 2 -and (($value.StartsWith('"') -and $value.EndsWith('"')) -or
            ($value.StartsWith("'") -and $value.EndsWith("'")))) {
            $value = $value.Substring(1, $value.Length - 2)
        }
        $result = $value
    }
    return $result
}

function Invoke-GitText([string[]]$Arguments) {
    $output = & git @Arguments 2>$null
    if ($LASTEXITCODE -ne 0) { return $null }
    return (@($output) -join "`n")
}

function Invoke-GitFetchWithTimeout([string]$Root) {
    $info = New-Object System.Diagnostics.ProcessStartInfo
    $info.FileName = 'git'
    $quotedRoot = $Root.Replace('"', '\"')
    $info.Arguments = "-C `"$quotedRoot`" fetch --quiet origin +refs/heads/main:refs/remotes/origin/main"
    $info.UseShellExecute = $false
    $info.CreateNoWindow = $true
    $info.RedirectStandardOutput = $true
    $info.RedirectStandardError = $true
    $info.EnvironmentVariables['GIT_TERMINAL_PROMPT'] = '0'
    try {
        $process = New-Object System.Diagnostics.Process
        $process.StartInfo = $info
        [void]$process.Start()
        # Drain both pipes while waiting so a verbose failure cannot block Git.
        $stdout = $process.StandardOutput.ReadToEndAsync()
        $stderr = $process.StandardError.ReadToEndAsync()
        if (-not $process.WaitForExit($FetchTimeoutMilliseconds)) {
            if ([Environment]::OSVersion.Platform -eq [PlatformID]::Win32NT) {
                try { & taskkill.exe /PID $process.Id /T /F 2>$null | Out-Null } catch {}
            } else {
                try { $process.Kill($true) } catch {}
            }
            if (-not $process.HasExited) { $process.Kill() }
            [void]$process.WaitForExit(1000)
            return $false
        }
        return $process.ExitCode -eq 0
    } catch {
        return $false
    } finally {
        if ($null -ne $process) { $process.Dispose() }
    }
}

function Get-SkillVersion([string]$Text) {
    $lines = $Text -split "`r?`n"
    if ($lines.Count -lt 2 -or $lines[0] -cne '---') { return $null }
    $old = $null; $new = $null; $maps = 0; $inMetadata = $false; $closed = $false
    foreach ($line in $lines[1..($lines.Count - 1)]) {
        if ($line -cmatch '^(---|\.\.\.)[ \t]*$') { $closed = $true; break }
        if ($line -cmatch '^metadata:') {
            $maps++
            if ($maps -gt 1 -or $line -cnotmatch '^metadata:[ \t]*(#.*)?$') { return $null }
            $inMetadata = $true
            continue
        }
        if ($line -cmatch '^[^ \t#]') { $inMetadata = $false }
        $isOld = $line -cmatch '^version:'
        $isNew = $inMetadata -and $line -cmatch '^  version:'
        if (-not $isOld -and -not $isNew) { continue }
        $value = $line.Substring($line.IndexOf(':') + 1).Trim()
        $match = [regex]::Match($value, '^(?:"([^"\r\n]*)"|''([^''\r\n]*)''|([^\s#"'']+))(?:[ \t]+#.*|[ \t]*)$')
        if (-not $match.Success) { return $null }
        $value = @($match.Groups[1..3] | Where-Object { $_.Success })[0].Value
        if ($value -cnotmatch '^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)(?:-([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$') { return $null }
        $pre = $Matches[4]
        if ($pre) {
            foreach ($part in ($pre -split '\.')) { if ($part -cmatch '^0[0-9]+$') { return $null } }
        }
        if ($isOld) {
            if ($null -ne $old) { return $null }
            $old = $value
        } else {
            if ($null -ne $new) { return $null }
            $new = $value
        }
    }
    if (-not $closed -or ($null -eq $old -and $null -eq $new)) { return $null }
    if ($null -ne $old -and $null -ne $new -and $old -cne $new) { return $null }
    if ($null -ne $new) { return $new }
    return $old
}

function Get-FileVersion([string]$Path) {
    if (-not (Test-Path -LiteralPath $Path -PathType Leaf)) { return $null }
    return Get-SkillVersion ((Get-Content -LiteralPath $Path -Raw -Encoding UTF8 -ErrorAction SilentlyContinue))
}

function Invoke-Pull([string]$Root, [string]$Name, [string]$SkillDir) {
    $Branch = Invoke-GitText @('-C', $Root, 'rev-parse', '--abbrev-ref', 'HEAD')
    $Ok = $true
    if ([string]::IsNullOrWhiteSpace($Branch) -or $Branch.Trim() -ne 'main') {
        Write-Output "[$Name] 拒绝拉取：当前分支不是 main（当前 $Branch）"
        $Ok = $false
    }
    $Dirty = Invoke-GitText @('-C', $Root, 'status', '--porcelain', '--untracked-files=no')
    if (-not [string]::IsNullOrWhiteSpace($Dirty)) {
        Write-Output "[$Name] 拒绝拉取：工作树有未提交改动"
        $Ok = $false
    }
    & git -C $Root merge-base --is-ancestor HEAD origin/main 2>$null
    if ($LASTEXITCODE -ne 0) {
        Write-Output "[$Name] 拒绝拉取：本地与 origin/main 已分叉，无法 fast-forward"
        $Ok = $false
    }
    if (-not $Ok) {
        Write-Output "[$Name] 未做任何改动。请处理上述问题后重试。"
        $script:PullExitCode = 1
        return
    }
    $Prefix = Invoke-GitText @('-C', $SkillDir, 'rev-parse', '--show-prefix')
    $SkillMdRel = if ($Prefix) { "$($Prefix.Trim().TrimEnd('/'))/SKILL.md" } else { 'SKILL.md' }
    $RemoteText = Invoke-GitText @('-C', $Root, 'show', "origin/main:$SkillMdRel")
    if (-not (Get-FileVersion (Join-Path $SkillDir 'SKILL.md')) -or -not (Get-SkillVersion $RemoteText)) {
        Write-Output "[$Name] invalid-metadata：拒绝拉取版本缺失、非法或冲突的 Skill"
        $script:PullExitCode = 1
        return
    }
    & git -C $Root merge --ff-only origin/main
    if ($LASTEXITCODE -ne 0) {
        Write-Output "[$Name] 拉取失败：merge --ff-only 未成功，工作树未改变"
        $script:PullExitCode = 1
        return
    }
    $NewVersion = Get-FileVersion (Join-Path $SkillDir 'SKILL.md')
    if ($NewVersion) { Write-Output "[$Name] 已更新到 v$NewVersion" } else { Write-Output "[$Name] 已更新" }
    $script:PullExitCode = 0
}

if ($Help) { Write-Usage; exit 0 }
if ($ReadVersion) {
    $Version = Get-FileVersion $ReadVersion
    if (-not $Version) { Write-Error "invalid-metadata: $ReadVersion"; exit 1 }
    Write-Output $Version
    exit 0
}

$ScriptPath = [IO.Path]::GetFullPath($MyInvocation.MyCommand.Path)
$ScriptsDir = Split-Path -Parent $ScriptPath
$SkillDir = Split-Path -Parent $ScriptsDir
$Name = Split-Path -Leaf $SkillDir
$HomeDir = if ($env:USERPROFILE) { $env:USERPROFILE } else { $HOME }
$ConfigDir = Join-Path $HomeDir ".config\$Name"
$EnvFile = Join-Path $ConfigDir '.env'
$StampFile = Join-Path $ConfigDir '.update-check-stamp'

$SwitchValue = Get-TrimmedEnvValue $EnvFile 'AUTO_UPDATE_CHECK'
if (-not $Pull -and $SwitchValue -eq '0') {
    Write-Output "[$Name] 自动检查更新已关闭（$EnvFile 中 AUTO_UPDATE_CHECK=0）"
    exit 0
}

$Root = Invoke-GitText @('-C', $SkillDir, 'rev-parse', '--show-toplevel')
if ([string]::IsNullOrWhiteSpace($Root)) {
    if ($Pull) {
        Write-Output "[$Name] 拒绝拉取：当前 Skill 不在 Git 检出内，或 Git 无法运行"
        exit 1
    }
    Write-Output "[$Name] 非 git 检出，跳过 Git 更新检查"
    exit 0
}
$Root = $Root.Trim()

if ($Pull) {
    Invoke-Pull $Root $Name $SkillDir
    exit $script:PullExitCode
}

$Now = [DateTimeOffset]::UtcNow.ToUnixTimeSeconds()
if (Test-Path -LiteralPath $StampFile -PathType Leaf) {
    $LastText = (Get-Content -LiteralPath $StampFile -ErrorAction SilentlyContinue | Select-Object -First 1)
    $Last = 0L
    if ([Int64]::TryParse([string]$LastText, [ref]$Last) -and $Now -ge $Last -and ($Now - $Last) -lt $ThrottleSeconds) {
        Write-Output "[$Name] 距上次检查不足 6 小时，跳过"
        exit 0
    }
}
try {
    New-Item -ItemType Directory -Force -Path $ConfigDir -ErrorAction Stop | Out-Null
    Set-Content -LiteralPath $StampFile -Value $Now -Encoding ASCII -ErrorAction Stop
} catch {}

if (-not (Invoke-GitFetchWithTimeout $Root)) {
    Write-Output "[$Name] 更新检查未完成（网络失败、超时或远端不可用）"
    exit 0
}

$BehindText = Invoke-GitText @('-C', $Root, 'rev-list', '--count', 'HEAD..origin/main')
$Behind = 0
if (-not [Int32]::TryParse([string]$BehindText, [ref]$Behind)) {
    Write-Output "[$Name] 更新检查未完成（无法比对 origin/main）"
    exit 0
}
$Prefix = (Invoke-GitText @('-C', $SkillDir, 'rev-parse', '--show-prefix'))
if ($null -eq $Prefix) { $Prefix = '' } else { $Prefix = $Prefix.Trim().TrimEnd('/') }
$SkillMdRel = if ($Prefix) { "$Prefix/SKILL.md" } else { 'SKILL.md' }
$LocalVersion = Get-FileVersion (Join-Path $SkillDir 'SKILL.md')
$RemoteSkillText = Invoke-GitText @('-C', $Root, 'show', "origin/main:$SkillMdRel")
$RemoteVersion = Get-SkillVersion $RemoteSkillText
$VersionClause = ''
if ($LocalVersion -and $RemoteVersion) {
    if ($LocalVersion -eq $RemoteVersion) { $VersionClause = "，版本 v$LocalVersion（未变）" }
    else { $VersionClause = "，版本 v$LocalVersion → v$RemoteVersion" }
} else {
    Write-Output "[$Name] invalid-metadata：本地或远端 Skill 版本缺失、非法或冲突；本次不建议拉取，按当前版本继续"
    exit 0
}

if ($Behind -eq 0) {
    Write-Output "[$Name] 已是最新（版本 v$LocalVersion）"
    exit 0
}

Write-Output "[$Name] 检测到更新：本地落后远端 $Behind 个提交$VersionClause"
$AllText = Invoke-GitText @('-C', $Root, 'log', '--format=%h %s', 'HEAD..origin/main')
$All = @()
if ($AllText) { $All = @($AllText -split "`r?`n" | Where-Object { $_ -ne '' }) }
$MineText = $AllText
if ($Prefix) {
    $MineText = Invoke-GitText @('-C', $Root, 'log', '--format=%h %s', 'HEAD..origin/main', '--', $Prefix)
}
$Mine = @()
if ($MineText) { $Mine = @($MineText -split "`r?`n" | Where-Object { $_ -ne '' }) }
$Others = @($All | Where-Object { $_ -notin $Mine })
if ($Mine.Count -gt 0) {
    Write-Output '本 skill 的更新：'
    $Mine | Select-Object -First 10 | ForEach-Object { Write-Output "  $_" }
    if ($Mine.Count -gt 10) { Write-Output "  另有 $($Mine.Count - 10) 条" }
}
if ($Others.Count -gt 0) {
    Write-Output '同仓其他改动（pull 会一并带入）：'
    $Others | Select-Object -First 10 | ForEach-Object { Write-Output "  $_" }
    if ($Others.Count -gt 10) { Write-Output "  另有 $($Others.Count - 10) 条" }
}
Write-Output '是否拉取？（pull 单位是整个仓，需工作树干净且可 fast-forward）'
exit $ExitUpdateAvailable
