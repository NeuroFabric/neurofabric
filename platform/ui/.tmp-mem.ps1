Get-Process | Sort-Object WorkingSet64 -Descending | Select-Object -First 12 Name, Id, @{N='WS_MB';E={[math]::Round($_.WorkingSet64/1MB,1)}} | Format-Table -AutoSize
