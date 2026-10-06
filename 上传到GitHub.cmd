@echo off
rem ===========================================================================
rem  jp-learn -- upload local changes to GitHub (one-click wizard)
rem
rem  !! COMMENTS IN THIS FILE MUST BE ASCII (English). DO NOT ADD CHINESE HERE. !!
rem  Why: cmd.exe parses a .cmd file using the *system* code page (GBK on a
rem  zh-CN box), not UTF-8.  This file is UTF-8, so a Chinese comment gets cut
rem  into wrong bytes under GBK and can produce a stray & or | that cmd then
rem  tries to RUN -- flooding the window with "not recognized as an internal
rem  or external command".  Same rule and same reason as the launcher .cmd in
rem  this folder.  Chinese *is* fine inside `echo "..."` below, because the
rem  very first thing this script does is `chcp 65001`.
rem  Full write-up: the startup-notes markdown file in this folder, section 2.
rem ===========================================================================
chcp 65001 >nul
setlocal EnableExtensions
cd /d "%~dp0"

rem ---------- Locate git ----------
rem A .cmd double-clicked from Explorer inherits the PATH that Explorer had at
rem launch time, which may PREDATE a fresh Git install (Explorer does not pick
rem up a new machine PATH until it restarts).  So we look in the usual install
rem locations as well instead of trusting PATH alone.
set "GITEXE="
where git >nul 2>nul
if not errorlevel 1 set "GITEXE=git"
if not defined GITEXE if exist "%ProgramFiles%\Git\cmd\git.exe" set "GITEXE=%ProgramFiles%\Git\cmd\git.exe"
if not defined GITEXE if exist "%LOCALAPPDATA%\Programs\Git\cmd\git.exe" set "GITEXE=%LOCALAPPDATA%\Programs\Git\cmd\git.exe"
if not defined GITEXE goto :no_git

rem ---------- Must be a real repo that has a remote ----------
"%GITEXE%" rev-parse --is-inside-work-tree >nul 2>nul
if errorlevel 1 goto :no_repo
"%GITEXE%" remote get-url origin >nul 2>nul
if errorlevel 1 goto :no_remote
for /f "delims=" %%u in ('"%GITEXE%" remote get-url origin 2^>nul') do set "REMOTEURL=%%u"

echo.
echo ============================================================
echo   上传改动到 GitHub
echo ============================================================
echo.
echo   仓库：%REMOTEURL%
echo.

rem ---------- 1. Stage everything that .gitignore allows ----------
echo   [1/5] 正在扫描改动...
"%GITEXE%" add -A
if errorlevel 1 goto :failed

rem ---------- 2. Safety net: the API key file must never be staged ----------
rem config.local.json holds a plaintext AI key and is .gitignore'd.  If it ever
rem shows up as staged (someone ran `git add -f`, or an ignore rule was edited
rem away), stop BEFORE the commit: once pushed, the key is public forever and
rem deleting the file later does not remove it from history.
"%GITEXE%" diff --cached --name-only | findstr /i /c:"config.local.json" >nul
if not errorlevel 1 (
    echo.
    echo   [已中止] 检测到 config.local.json 进入了待提交区！
    echo.
    echo   这个文件里是你的 AI 密钥，一旦推上去就等于公开了，
    echo   而且之后删掉文件也抹不掉历史记录。
    echo.
    echo   正常情况下它被 .gitignore 排除，不该出现在这里。
    echo   请检查 .gitignore，也不要用 git add -f 强制添加它。
    echo.
    goto :aborted
)

rem ---------- 3. Is there anything to upload at all? ----------
set "ANYCHANGE="
for /f "delims=" %%c in ('"%GITEXE%" diff --cached --name-only') do set "ANYCHANGE=1"
if not defined ANYCHANGE (
    echo.
    echo   没有检测到任何改动 —— 本地和上次提交一模一样，没什么可传的。
    echo.
    echo   如果你确实改了文件却没被识别，检查一下它是否被 .gitignore 排除了。
    echo.
    pause
    exit /b 0
)

echo         将被上传的文件：
"%GITEXE%" diff --cached --name-status
echo.

rem ---------- 4. Ask for a commit message ----------
rem Default is a timestamp; the exact clock format comes from PowerShell so we
rem do not depend on the locale-specific %DATE% / %TIME% layout.
for /f "delims=" %%t in ('powershell.exe -NoProfile -NonInteractive -Command "Get-Date -Format 'yyyy-MM-dd HH:mm'" 2^>nul') do set "STAMP=%%t"
if not defined STAMP set "STAMP=更新"
set "DEFAULTMSG=更新 %STAMP%"
set "MSG="
echo   [2/5] 为这次改动写一句说明（直接按回车 = 使用默认值 %DEFAULTMSG%）
echo.
set /p "MSG=        说明: "
if not defined MSG set "MSG=%DEFAULTMSG%"
rem A literal " in the message would terminate the -m "..." argument early and
rem let the rest be parsed as more arguments.  Strip them and explain.
set "MSG=%MSG:"=%"
echo.
echo         提交说明：%MSG%
echo.

rem ---------- 5. Commit, then push ----------
echo   [3/5] 正在提交到本地仓库...
"%GITEXE%" commit -m "%MSG%"
if errorlevel 1 goto :failed

echo.
echo   [4/5] 正在上传到 GitHub...
echo.
echo         如果弹出 GitHub 登录窗口，请在弹出的窗口里完成授权。
echo         授权过一次之后，以后就不用再登录了。
echo.
"%GITEXE%" push
if errorlevel 1 goto :push_failed

echo.
echo   [5/5] 完成
echo.
echo ============================================================
echo   上传成功
echo ============================================================
echo.
echo   在浏览器里查看你的仓库：
echo       %REMOTEURL:.git=%
echo.
pause
exit /b 0

rem ===========================================================================
rem  Error paths
rem ===========================================================================

:no_git
echo.
echo ============================================================
echo   [错误] 找不到 Git
echo ============================================================
echo.
echo   这台电脑上似乎还没有安装 Git，或者这个脚本没找到它。
echo.
echo   安装一次即可，在 PowerShell 里执行：
echo       winget install --id Git.Git -e
echo.
echo   装完之后如果还是提示找不到，请重启一次电脑（或重启资源管理器），
echo   让新的 PATH 生效，然后再双击本文件。
echo.
pause
exit /b 1

:no_repo
echo.
echo ============================================================
echo   [错误] 这个文件夹还不是 Git 仓库
echo ============================================================
echo.
echo   本脚本必须在已初始化过的项目目录里运行。
echo   正常情况下它就在项目根目录（和 server.js 同级），
echo   请确认你没有把它复制到别的地方。
echo.
echo   如果确实需要重新初始化，在项目目录执行：
echo       git init -b main
echo       git remote add origin ^<你的仓库地址^>
echo.
pause
exit /b 1

:no_remote
echo.
echo ============================================================
echo   [错误] 没有配置远程仓库（origin）
echo ============================================================
echo.
echo   本地仓库存在，但还不知道要传到哪个 GitHub 地址。
echo   在项目目录执行下面这一行（把地址换成你自己的）：
echo.
echo       git remote add origin https://github.com/你的用户名/仓库名.git
echo.
pause
exit /b 1

:aborted
echo ------------------------------------------------------------
echo   已中止，什么都没有提交，也什么都没有上传。
echo ------------------------------------------------------------
echo.
pause
exit /b 1

:failed
echo.
echo ------------------------------------------------------------
echo   操作未完成 —— 上一步报了什么，看上面的信息。
echo ------------------------------------------------------------
echo.
pause
exit /b 1

:push_failed
echo.
echo ------------------------------------------------------------
echo   提交成功，但上传失败了
echo ------------------------------------------------------------
echo.
echo   好消息：本次改动已经安全地提交到本地仓库，随时可以再传一次，
echo   不会丢。重新双击本文件即可重试。
echo.
echo   常见原因和处理办法：
echo.
echo     1^) 登录没完成，或之前的凭据过期了
echo        重新运行本脚本，再走一次弹出的登录窗口。
echo.
echo     2^) GitHub 上有了你本地没有的新提交（比如你在网页上改过文件）
echo        先执行  git pull --rebase  再重试。
echo.
echo     3^) 网络连不上 github.com
echo        用浏览器打开 https://github.com 确认能访问；
echo        如果你平时需要代理才能上网，还要给 git 单独配一次代理：
echo            git config --global http.proxy http://127.0.0.1:端口号
echo.
echo     4^) 有单个文件超过 100 MB
echo        GitHub 会直接拒收。检查是不是把 runtime\ 或 发布\ 提交了
echo        —— 这两个目录本该被 .gitignore 排除。
echo.
pause
exit /b 1
