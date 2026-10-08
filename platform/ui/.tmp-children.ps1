$parent = 19836
Get-CimInstance Win32_Process -Filter "ParentProcessId=$parent" | Select-Object ProcessId, Name, CommandLine | Format-List
"---- vite/node children ----"
Get-CimInstance Win32_Process -Filter "Name='node.exe'" | Where-Object { $_.CommandLine -match 'vite' } | Select-Object ProcessId, CommandLine | Format-List
