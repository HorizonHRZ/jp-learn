@echo off
chcp 65001 >nul
setlocal EnableExtensions
cd /d "%~dp0.."

echo.
echo ============================================================
echo   重建内置数据（词库 / 假名表 / 索引）
echo ============================================================
echo.
echo   第 0 步：确认运行时
echo ------------------------------------------------------------
set "NODEEXE="
if exist "%~dp0..\runtime\node.exe" (
    set "NODEEXE=%~dp0..\runtime\node.exe"
) else (
    where node >nul 2>nul
    if not errorlevel 1 set "NODEEXE=node"
)
if not defined NODEEXE (
    echo   [错误] 找不到 Node。请先运行 tools\get-node-runtime.mjs
    echo           或安装官方 Node LTS：https://nodejs.org/zh-cn/download
    pause
    exit /b 1
)
echo   运行时：%NODEEXE%

echo.
echo   第 1 步：从上游下载原始数据到 data-cache\
echo            （已下载的会跳过；断线可重跑续传）
echo ------------------------------------------------------------
"%NODEEXE%" "%~dp0..\tools\fetch-data.mjs"
if errorlevel 1 (
    echo.
    echo   [警告] 下载有失败项。可以重跑本脚本续传。
    echo          如果你已经有 data-cache\ 里的数据，也可以继续下一步。
    echo.
)

echo.
echo   第 2 步：生成假名 -^> 罗马音表  data\kana\
echo ------------------------------------------------------------
"%NODEEXE%" "%~dp0..\tools\build-romaji.mjs"
if errorlevel 1 goto :failed

echo.
echo   第 3 步：生成词库与索引  data\vocab\  data\index\
echo ------------------------------------------------------------
"%NODEEXE%" "%~dp0..\tools\build-vocab.mjs"
if errorlevel 1 goto :failed

echo.
echo ============================================================
echo   全部完成
echo ============================================================
echo   现在解压/或直接刷新浏览器即可生效。
echo.
pause
exit /b 0

:failed
echo.
echo   [错误] 构建失败，请看上面的报错信息。
echo.
pause
exit /b 1
