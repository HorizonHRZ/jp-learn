@echo off
rem ===========================================================================
rem  jp-learn - stop the local server
rem
rem  !! COMMENTS HERE MUST BE ASCII. DO NOT ADD CHINESE COMMENTS. !!
rem  cmd.exe parses a .cmd file with the SYSTEM code page (GBK on zh-CN), not
rem  UTF-8.  A Chinese comment gets cut into wrong bytes and can leave a stray
rem  & or | that cmd then RUNS, printing "not recognized as an internal or
rem  external command".  Chinese is only safe inside `echo "..."`, after the
rem  `chcp 65001` below.  Details: the startup-notes markdown file here.
rem
rem  Why this file exists: the silent launcher starts the server with NO
rem  window, so there is nothing to close.  This kills it by matching the
rem  server.js command line - much narrower than "kill every node.exe",
rem  because other node.exe processes here belong to unrelated tools.
rem
rem  Why a helper .ps1 instead of an inline powershell -Command:
rem    The inline form needs WMI filter quotes AND single quotes AND $_ all
rem    escaped through cmd's parser.  Two attempts both died (one gave
rem    "invalid query", one broke on the escaping) - a file has no such
rem    problem.  Measured and kept as a lesson.
rem ===========================================================================
chcp 65001 >nul
setlocal EnableExtensions

set "HELPER=%TEMP%\jp-learn-stop.ps1"
> "%HELPER%" echo $ErrorActionPreference='SilentlyContinue'
>>"%HELPER%" echo $p=@(Get-CimInstance Win32_Process ^| Where-Object { $_.Name -eq 'node.exe' -and $_.CommandLine -like '*server.js*' })
>>"%HELPER%" echo foreach($x in $p){ Stop-Process -Id $x.ProcessId -Force }
>>"%HELPER%" echo $p.Count

set "N="
for /f "delims=" %%c in ('powershell.exe -NoProfile -NonInteractive -ExecutionPolicy Bypass -File "%HELPER%" 2^>nul') do set "N=%%c"

del "%HELPER%" >nul 2>nul

echo.
if "%N%"=="0" (
    echo   没有找到正在运行的服务 —— 可能它本来就没开。
) else (
    if "%N%"=="" (
        echo   停止命令已执行，但没能确认数量（详情请看启动脚本说明）。
    ) else (
        echo   已停止 %N% 个服务进程。
    )
)
echo.
echo   本窗口 3 秒后自动关闭。
timeout /t 3 /nobreak >nul
exit /b 0
