' ===========================================================================
'  Desktop shortcut installer for jp-learn.
'
'  WHAT IT DOES
'    Creates a shortcut on the current user's Desktop that points at the silent
'    launcher (.vbs) next to this file.  Double-clicking that shortcut starts
'    the app with no console window and opens the browser.  (The silent
'    launcher is idempotent: if the server is already up it just opens the
'    browser.)
'
'  WHY A SHORTCUT INSTEAD OF COPYING THE .VBS TO THE DESKTOP
'    A copy on the Desktop would break: the launcher finds its own folder via
'    WScript.ScriptFullName and expects the .cmd launcher and runtime\ to be
'    beside it.  A shortcut keeps one copy of the app and just adds an extra
'    way to click it, so the folder stays movable/renamable.
'
'  !! KEEP THIS WHOLE FILE ASCII-ONLY.  THIS FILE MUST BE CRLF. !!
'    WSH reads .vbs as ANSI (the system code page, GBK on a zh-CN box), NOT as
'    UTF-8.  A Chinese string literal decodes to wrong bytes and, if one of
'    them is a quote, you get "unterminated string constant" reported at a
'    line that looks perfectly fine.  So every Chinese character used below is
'    BUILT FROM ITS CODE POINT with ChrW().  Do not "simplify" this.
'    With bare LF, WSH reports the same bogus error.  Keep CRLF.
'
'    Comments are kept ASCII too, purely so that "grep this folder for
'    non-ASCII bytes" stays a meaningful check.  A comment is safe in
'    practice, but a file with zero non-ASCII bytes cannot be misread at all.
'
'    Code points used here (verified against PowerShell):
'      65E5 8BED 5B66 4E60   -> shortcut name ("ri yu xue xi")
'      9759 9ED8 542F 52A8   -> the silent launcher's name ("jing mo qi dong")
'    Chinese a human must READ lives in the .md notes and .cmd files, which
'    are UTF-8 under `chcp 65001`.
'
'  Safe to run twice: it just overwrites the same shortcut.
' ===========================================================================
Option Explicit

Dim fso, sh, root, target, linkPath, sc, desktop, name, vbName, icon, msg

Set fso = CreateObject("Scripting.FileSystemObject")
Set sh  = CreateObject("WScript.Shell")

root = fso.GetParentFolderName(WScript.ScriptFullName)

' The silent launcher, next to this file.  Built, never typed (see header).
vbName = ChrW(&H9759) & ChrW(&H9ED8) & ChrW(&H542F) & ChrW(&H52A8) & ".vbs"
target = root & "\" & vbName

If Not fso.FileExists(target) Then
  MsgBox "Cannot find the silent launcher next to this file:" & vbCrLf & vbCrLf & _
         vbName & vbCrLf & vbCrLf & _
         "Keep this installer inside the application folder.", _
         16, "jp-learn"
  WScript.Quit 2
End If

desktop  = sh.SpecialFolders("Desktop")
name     = ChrW(&H65E5) & ChrW(&H8BED) & ChrW(&H5B66) & ChrW(&H4E60)   ' shortcut name
linkPath = desktop & "\" & name & ".lnk"

' Target = the .vbs itself.  Windows runs a .lnk-to-.vbs through wscript.exe
' (the default handler), which is exactly what a double-click does - so there
' is no need to spell out wscript.exe and pass an argument, which would mean
' more nested quoting inside a file that parses as ANSI.
'
' Icon: imageres.dll index 165 is the "web page / globe" glyph - it reads as
' "this opens a local web page", which is what actually happens.  A generic
' shell32 index would look like a folder or an unknown file type.
icon = sh.ExpandEnvironmentStrings("%SystemRoot%") & "\System32\imageres.dll,165"

On Error Resume Next
Set sc = sh.CreateShortcut(linkPath)
If Err.Number <> 0 Then
  MsgBox "Could not create the shortcut." & vbCrLf & vbCrLf & _
         "Path: " & linkPath & vbCrLf & _
         "Error: " & Err.Description, 16, "jp-learn"
  WScript.Quit 3
End If

sc.TargetPath       = target
sc.WorkingDirectory = root
sc.IconLocation     = icon
sc.Description      = "jp-learn local study app"
sc.Save
If Err.Number <> 0 Then
  MsgBox "Could not save the shortcut." & vbCrLf & vbCrLf & _
         "Path: " & linkPath & vbCrLf & _
         "Error: " & Err.Description, 16, "jp-learn"
  WScript.Quit 4
End If
On Error GoTo 0

If Not fso.FileExists(linkPath) Then
  MsgBox "The shortcut was not created (no error reported)." & vbCrLf & vbCrLf & _
         linkPath, 16, "jp-learn"
  WScript.Quit 5
End If

msg = "Desktop shortcut created:" & vbCrLf & vbCrLf & _
      linkPath & vbCrLf & vbCrLf & _
      "Double-click it to start the app.  It opens the browser by itself," & vbCrLf & _
      "so you can then use your browser bookmark as usual." & vbCrLf & vbCrLf & _
      "Safe to run this installer again any time." & vbCrLf & _
      "To remove it, just delete the shortcut from the Desktop."
MsgBox msg, 64, "jp-learn"

' Tell the caller (and the self-test) exactly what we produced.
WScript.Echo linkPath
WScript.Quit 0
