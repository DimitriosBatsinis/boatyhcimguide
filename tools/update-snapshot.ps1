# Optional: refresh the bundled copy of the guide (data/guide.json).
# The site already pulls wiki edits live, so this only matters for first-time
# visitors and offline use. Run from the project folder:
#   powershell -ExecutionPolicy Bypass -File tools\update-snapshot.ps1
$ErrorActionPreference = 'Stop'
$api = 'https://oldschool.runescape.wiki/api.php'
$page = 'Guide:B0aty_HCIM_Guide_V3'
$ua = 'hcim-v3-checklist snapshot script'

$rev = (Invoke-WebRequest -UseBasicParsing -UserAgent $ua "$api`?action=query&prop=revisions&titles=$page&rvprop=ids|timestamp&format=json&formatversion=2").Content | ConvertFrom-Json
$r = $rev.query.pages[0].revisions[0]
$parse = (Invoke-WebRequest -UseBasicParsing -UserAgent $ua "$api`?action=parse&page=$page&prop=wikitext|revid&format=json&formatversion=2").Content | ConvertFrom-Json

$out = [ordered]@{
  revid     = $parse.parse.revid
  timestamp = $r.timestamp
  fetched   = (Get-Date).ToUniversalTime().ToString('o')
  wikitext  = $parse.parse.wikitext
}
$target = Join-Path $PSScriptRoot '..\data\guide.json'
[IO.File]::WriteAllText((Resolve-Path $target), ($out | ConvertTo-Json -Compress -Depth 3), [Text.UTF8Encoding]::new($false))
Write-Host "Saved revision $($out.revid) from $($out.timestamp)"
