' ===========================================================================
'  Silent launcher - double-click this to run the app with NO console window.
'
'  !! THIS FILE MUST STAY ASCII-ONLY INSIDE STRING LITERALS. !!
'  WSH reads a .vbs file as ANSI (the system code page, GBK on a zh-CN box),
'  NOT as UTF-8.  A Chinese string literal therefore decodes into wrong bytes,
'  and if one of those bytes is a quote you get "unterminated string constant"
'  reported at a line that looks perfectly fine.  Measured:
'      s = "some chinese"        -> parses (4 chars, lucky bytes)
'      s = "chinese with （）"    -> unterminated string constant
'  So: Chinese is BUILT FROM CODE POINTS with ChrW() where needed.
'  Chinese that a user must READ lives in the .cmd files, which are UTF-8 and
'  run under `chcp 65001`, plus the startup-notes .md next to this file.
'
'  !! THIS FILE MUST ALSO USE CRLF LINE ENDINGS. !!
'  With bare LF, WSH reports a bogus "unterminated string constant" too.
'  The repo's editor writes LF by default - convert after editing.
'
'  What it does
'    1. already running  -> just open the browser (no second server)
'    2. otherwise        -> start the launcher hidden, wait for the port,
'                           open the browser; on failure bring the visible
'                           launcher window forward and say where the log is
'
'  Why a staging .cmd instead of calling the launcher directly:
'    WScript.Shell.Run needs a path (quoted, because it contains spaces) plus
'    a port.  Building that call in VBS needs nested quotes, which is exactly
'    where this file kept breaking.  A .cmd file has no quoting puzzle, and it
'    gives an exit code.  The staging file must never contain a Chinese
'    FILENAME either - cmd.exe misparses those bytes (see the notes .md).
' ===========================================================================
Option Explicit

Dim fso, sh, root, port, tries, stage, logf, f, launcher, freePort

Set fso = CreateObject("Scripting.FileSystemObject")
Set sh  = CreateObject("WScript.Shell")

' Project folder = the folder this file lives in, so the whole package can be
' renamed or moved anywhere.  The launcher name is built here, never typed:
'   启 U+542F + 动 U+52A8  ->  启动.cmd
' (The stopper 停止服务.cmd is only ever double-clicked by the user, so this
'  script does not need its name at all.  A `stopper = ...` line used to sit
'  here; with Option Explicit and no Dim it aborted the whole script with
'  "variable is undefined" - so do not re-add it unless something uses it.)
launcher = ChrW(&H542F) & ChrW(&H52A8) & ".cmd"

root = fso.GetParentFolderName(WScript.ScriptFullName)
sh.CurrentDirectory = root

If Not fso.FileExists(root & "\" & launcher) Then
  MsgBox "Cannot find the launcher next to this file:" & vbCrLf & vbCrLf & _
         launcher & vbCrLf & vbCrLf & _
         "Keep this file inside the application folder.", _
         16, "jp-learn"
  WScript.Quit 2
End If

stage = sh.ExpandEnvironmentStrings("%TEMP%") & "\jp-learn-silent.cmd"
logf  = sh.ExpandEnvironmentStrings("%TEMP%") & "\jp-learn-startup.log"

' ---- 1. Already running?  Then this click is really just "open the page". --
' This is the fix for "a black window pops up every time I open the app": the
' server only needs to start once and stay up.  Probe the default port first,
' then a few more, so a second copy of the app - or an unrelated program
' sitting on 8787 - does not make this click launch nothing at all.
'
' Optional first argument = port, mirroring the launcher's own argument:
'   wscript 静默启动.vbs 8790
' The range scan stays even when a port is given, because "already listening"
' is checked against the given port specifically in that case.
If WScript.Arguments.Count >= 1 Then
  port = WScript.Arguments(0)
  If Not IsNumeric(port) Then port = "8787"
  If PortReady(port) Then
    sh.Run "http://127.0.0.1:" & port & "/", 1, False
    WScript.Quit 0
  End If
Else
  For Each freePort In Array("8787", "8788", "8789", "8790", "8791", "8792", "8793", "8794", "8795")
    If PortReady(freePort) Then
      sh.Run "http://127.0.0.1:" & freePort & "/", 1, False
      WScript.Quit 0
    End If
  Next
  port = "8787"
End If

' ---- 2. Start it hidden ---------------------------------------------------
' ⚠️ ENCODING, MEASURED, DO NOT "FIX" IT:
'   CreateTextFile(..., True) writes UTF-8 (with BOM).  cmd.exe reads a .cmd as
'   the SYSTEM code page (GBK here), so the UTF-8 bytes of the CJK launcher
'   filename turn into garbage and the call fails with "not recognized".
'   CreateTextFile(..., False) writes ANSI - on a zh-CN box that IS GBK, so
'   the CJK filename comes out right.  Unicode=True was tried: cmd cannot
'   parse a UTF-16 .cmd at all (silent fail, no log).
Set f = fso.CreateTextFile(stage, True, False)  ' ANSI = GBK on this machine
f.WriteLine "@echo off"
f.WriteLine "call """ & root & "\" & launcher & """ " & port & " >""" & logf & """ 2>&1"
f.WriteLine "exit /b %ERRORLEVEL%"
f.Close

' 0 = hidden window, True = wait.  The launcher blocks while the server runs,
' so this call returns only once the server stopped or failed.  That is fine:
' we do not use its return value, we poll the port below.
sh.Run "cmd /c """ & stage & """", 0, True

' ---- 3. Wait for the port (up to 25 s), then open the browser -------------
For tries = 1 To 50
  If PortReady(port) Then
    sh.Run "http://127.0.0.1:" & port & "/", 1, False
    WScript.Quit 0
  End If
  WScript.Sleep 500
Next

' ---- 4. Still nothing after 25 s: hand the user the actual error ----------
' The visible launcher has `pause` on every failure path, so its window is
' still there - bring it forward.  NEVER taskkill by window title: that once
' matched an unrelated cmd window belonging to something else on this machine.
' The message is mostly ASCII on purpose; the log line is the actionable part.
On Error Resume Next
sh.AppActivate ChrW(&H542F) & ChrW(&H52A8) & ".cmd"
On Error GoTo 0
MsgBox "The local server did not start within 25 seconds." & vbCrLf & vbCrLf & _
       "The launcher window has been brought to the front - read the error" & vbCrLf & _
       "there.  Most common cause: port " & port & " is taken." & vbCrLf & vbCrLf & _
       "Full log:" & vbCrLf & logf & vbCrLf & vbCrLf & _
       "Next time, double-click the .cmd launcher instead of this file to see" & vbCrLf & _
       "the whole start-up log in a normal window.", _
       48, "jp-learn failed to start"
WScript.Quit 1

' ---------------------------------------------------------------------------
' Is anything LISTENING on this port?
'
' netstat rather than PowerShell: faster to spin up from VBS, and PowerShell
' networking cmdlets fail on some locked-down machines.  Only lines containing
' LISTENING count, otherwise an *outbound* connection to the same port number
' would look like a running server.
Function PortReady(p)
  Dim ex, txt, re
  PortReady = False
  On Error Resume Next
  Set ex = sh.Exec("%ComSpec% /c netstat -ano -p TCP")
  If Err.Number <> 0 Then Exit Function
  txt = ""
  Do While Not ex.StdOut.AtEndOfStream
    txt = txt & ex.StdOut.ReadLine() & vbLf
  Loop
  Set re = New RegExp
  re.Pattern = ":" & p & "\s+.*LISTENING"
  re.IgnoreCase = True
  If re.Test(txt) Then PortReady = True
  On Error GoTo 0
End Function
