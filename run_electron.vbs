Set WshShell = CreateObject("WScript.Shell")
Set fso = CreateObject("Scripting.FileSystemObject")

' Get the directory of this VBScript file
scriptDir = fso.GetParentFolderName(WScript.ScriptFullName)
WshShell.CurrentDirectory = scriptDir

' Check if hide_cli.flag exists
If fso.FileExists("hide_cli.flag") Then
    ' Run silently (0 = hide window)
    WshShell.Run "cmd.exe /c run_electron.bat", 0, False
Else
    ' Run normally (1 = activate and display window)
    WshShell.Run "cmd.exe /c run_electron.bat", 1, False
End If
