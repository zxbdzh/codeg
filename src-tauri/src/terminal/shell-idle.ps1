$startup = [Threading.EventWaitHandle]::OpenExisting($env:CODEG_IDLE_EVENT)
try {
    if (!$startup.WaitOne(10000)) { throw 'Codeg terminal registration timed out' }
} finally {
    $startup.Dispose()
}
$env:CODEG_IDLE_EVENT = $null

# 进程注册后再加载四级 profile，避免 profile 先启动的后台进程漏出观测范围。
foreach ($codegProfile in @($PROFILE.AllUsersAllHosts, $PROFILE.AllUsersCurrentHost, $PROFILE.CurrentUserAllHosts, $PROFILE.CurrentUserCurrentHost)) {
    if (Test-Path -LiteralPath $codegProfile) {
        try { . $codegProfile } catch { Write-Error $_ -ErrorAction Continue }
    }
}
[Console]::OutputEncoding = [Text.Encoding]::UTF8
$host.UI.RawUI.WindowTitle = 'codeg'
$global:__CodegIdleNonce = $env:CODEG_IDLE_NONCE
$env:CODEG_IDLE_NONCE = $null
$global:__CodegIdlePrompt = $function:prompt
$global:__CodegIdleReadLineWrapper = {
    $codegSuccess = $global:?
    $codegSignal = 'ready'
    if (@(Get-Job | Where-Object { $_.State -notin @('Completed', 'Failed', 'Stopped') }).Count) {
        $codegSignal = 'jobs'
    }
    [Console]::Write([char]27 + ']633;P;CodegIdle=' + $global:__CodegIdleNonce + ':' + $codegSignal + [char]7)
    if (!$codegSuccess) { Write-Error 'failure' -ErrorAction Ignore }
    & $global:__CodegIdleReadLine
}
function global:prompt {
    $codegSuccess = $global:?
    if ($function:PSConsoleHostReadLine -and $function:PSConsoleHostReadLine -ne $global:__CodegIdleReadLineWrapper) {
        $global:__CodegIdleReadLine = $function:PSConsoleHostReadLine
        Set-Item function:global:PSConsoleHostReadLine -Value $global:__CodegIdleReadLineWrapper
    }
    if (!$codegSuccess) { Write-Error 'failure' -ErrorAction Ignore }
    & $global:__CodegIdlePrompt
}
