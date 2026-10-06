@echo off
rem ===========================================================================
rem  jp-learn one-click launcher
rem
rem  !! COMMENTS IN THIS FILE MUST BE ASCII (English). DO NOT ADD CHINESE HERE. !!
rem  Why: cmd.exe parses a .cmd file using the *system* code page (GBK on a
rem  zh-CN box), not UTF-8.  This file is UTF-8, so a Chinese comment gets
rem  cut into wrong bytes under GBK and can produce a stray & or | that cmd
rem  then tries to RUN -- flooding the window with "not recognized as an
rem  internal or external command".  Measured 2026-10: 33 such error lines
rem  with Chinese comments, 0 after making the comments ASCII.
rem  Chinese is fine inside `echo "..."` below, because the very first thing
rem  this script does is `chcp 65001`.
rem  Full write-up: the startup-notes markdown file in this folder (UTF-8,
rem  never parsed by cmd) -- see its section 2.
rem ===========================================================================
chcp 65001 >nul
setlocal EnableExtensions
cd /d "%~dp0"

rem ---------- Port: first argument, default 8787 ----------
rem Digits only; anything else falls back to 8787 so no junk can reach a URL.
rem (This used to be hard-coded while the trailing hint told users to pass a
rem  port -- the argument was silently ignored.  See the startup-notes .md, s2.)
set "PORT=8787"
if not "%~1"=="" (
    echo %~1| findstr /r "^[0-9][0-9]*$" >nul
    if not errorlevel 1 set "PORT=%~1"
)

set "NODEEXE="

echo.
echo ============================================================
echo   日语学习应用  jp-learn  启动中...
echo ============================================================
echo.

rem ---------- 1. Self-heal: fetch a portable Node if missing ----------
rem runtime\ is a build product.  If this folder was copied somewhere without
rem it, and any usable node exists, download one instead of dead-ending.
if not exist "%~dp0runtime\node.exe" (
    where node >nul 2>nul
    if not errorlevel 1 (
        echo   [1/5] 未发现便携版 Node，正在自动获取 ^(约 90 MB，只需一次^)...
        node "%~dp0tools\get-node-runtime.mjs" --version=v24.21.0
        if errorlevel 1 (
            echo         自动获取失败，改为尝试使用系统里的 Node。
        ) else (
            echo         便携版 Node 已就绪。
        )
    ) else (
        echo   [1/5] 未发现便携版 Node，且没有可用的 node 来执行下载脚本。
    )
) else (
    echo   [1/5] 运行时：项目自带便携版 Node
)

rem ---------- 2. Find Node: bundled portable build first ----------
rem There is no system-wide Node on this machine.  Historically the app relied
rem on a node shim that DSH puts on PATH (pointing into the DSH install dir),
rem so touching DSH broke startup.  Hence runtime\node.exe comes first; the
rem rest are fallbacks only.
if exist "%~dp0runtime\node.exe" (
    set "NODEEXE=%~dp0runtime\node.exe"
) else (
    where node >nul 2>nul
    if not errorlevel 1 (
        set "NODEEXE=node"
        echo   [2/5] 运行时：PATH 中的 node ^(未找到项目自带的 runtime\node.exe^)
    ) else (
        if exist "%ProgramFiles%\nodejs\node.exe" (
            set "NODEEXE=%ProgramFiles%\nodejs\node.exe"
            echo   [2/5] 运行时：%ProgramFiles%\nodejs\node.exe
        ) else (
            if exist "%LOCALAPPDATA%\Programs\nodejs\node.exe" (
                set "NODEEXE=%LOCALAPPDATA%\Programs\nodejs\node.exe"
                echo   [2/5] 运行时：%LOCALAPPDATA%\Programs\nodejs\node.exe
            )
        )
    )
)

if not defined NODEEXE goto :no_node

rem ---------- 3. Make sure that node actually runs ----------
"%NODEEXE%" --version >nul 2>nul
if errorlevel 1 (
    echo.
    echo   [错误] 找到了 "%NODEEXE%"，但它无法执行。
    echo.
    goto :no_node
)
for /f "delims=" %%v in ('"%NODEEXE%" --version 2^>nul') do set "NODEVER=%%v"
echo         版本：%NODEVER%

rem ---------- 4. Port check ----------
set "BUSY="
for /f "delims=" %%p in ('powershell.exe -NoProfile -NonInteractive -ExecutionPolicy Bypass -Command "try{if(Get-NetTCPConnection -LocalPort %PORT% -State Listen -ErrorAction Stop){'BUSY'}}catch{}" 2^>nul') do set "BUSY=%%p"
if defined BUSY (
    echo   [3/5] 端口 %PORT% 已被占用，可能服务已经在运行。
    echo         直接把下面这个地址贴进浏览器即可：
    echo             http://127.0.0.1:%PORT%/
    echo.
    echo         如果那个不是本应用，请先关掉占用 %PORT% 的程序再重试。
    echo.
    set "OPENURL=http://127.0.0.1:%PORT%/"
    goto :open
)
echo   [3/5] 端口 %PORT% 空闲

rem ---------- 5. Start the server (this window IS the server) ----------
rem NOTE ON THE LINES BELOW: they are deliberately ASCII, even though the rest
rem of this file echoes Chinese.  Reason (measured 2026-10): when this launcher
rem runs HIDDEN with its output redirected to a log file (that is exactly what
rem 静默启动.vbs does), cmd.exe reads THIS FILE as GBK while the bytes are
rem UTF-8.  That mismatch split the Chinese line "关闭本窗口即停止服务。"
rem into two commands, so the log grew a spurious line:
rem     '即停止服务。' is not recognized as an internal or external command
rem The app still started fine - it was only ugly noise in the log - but a
rem log that cries wolf is worse than no log, so these echoes are English.
rem (Reproducing it standalone did NOT show the bug: the same echo is fine in
rem  a visible window.  It only showed up under hidden + redirected output,
rem  which is why it survived so long.  The Chinese a user actually READS is
rem  the app's own interface, which is served by server.js as UTF-8 HTML and
rem  is not affected by cmd's code page at all.)
echo   [4/5] Starting local server ...
echo.
echo   source : %~dp0
echo   url    : http://127.0.0.1:%PORT%/
echo   Your study data lives in the browser (IndexedDB), so updating the
echo   code never touches it.
echo   Closing this window stops the server.
echo   Closing the web page also stops it (~90s later) to free memory.
echo   To keep it running instead, set JP_LEARN_NO_IDLE_EXIT=1 first.
echo.
echo ------------------------------------------------------------
echo.

start "" /b cmd /c "timeout /t 2 /nobreak >nul & start "" http://127.0.0.1:%PORT%/"

"%NODEEXE%" "%~dp0server.js" %PORT%
set "EXITCODE=%ERRORLEVEL%"

echo.
echo ------------------------------------------------------------
echo   服务已停止（退出码 %EXITCODE%）。
if not "%EXITCODE%"=="0" (
    echo   如果不是你主动关的，请看上面的报错信息；
    echo   端口被占用时可以换个端口启动：启动.cmd 8790
)
echo.
pause
exit /b %EXITCODE%

:open
start "" "%OPENURL%"
echo ------------------------------------------------------------
echo.
pause
exit /b 0

:no_node
echo.
echo ============================================================
echo   [错误] 找不到可用的 Node.js，应用无法启动
echo ============================================================
echo.
echo   本应用是零依赖的，但仍然需要 Node 来跑本地服务 server.js。
echo.
echo   最省事的办法：在能上网的机器上装一次官方 Node LTS，
echo   然后回到本目录双击本文件，它会自动把便携版 Node 装进 runtime\。
echo       https://nodejs.org/zh-cn/download
echo.
echo   如果本机已经有别的 node（哪怕是别的程序自带的），也可以手动执行：
echo       ^<那个 node^> tools\get-node-runtime.mjs --version=v24.21.0
echo   它会把便携版 Node 下载到 runtime\node.exe（并校验官方 SHA256）。
echo.
pause
exit /b 1
