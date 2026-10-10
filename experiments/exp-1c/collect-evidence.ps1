# ===========================================================================
# Experiment 1c - environment evidence. Tiny on purpose.
#
# Five facts the result sheet asks for, read off the machine instead of typed
# from memory, because "NVIDIA, I think the current driver" is not a matrix
# cell. It takes no screenshots, starts nothing, and changes nothing.
#
# IT CANNOT OBSERVE ANY OF THE SEVEN PASS CRITERIA. Every one of those is
# something a person has to look at, and the footer of the file it writes says
# so, because the file is what gets pasted into a thread six weeks later.
#
# A READING THAT FAILS IS RECORDED, NOT DROPPED. The WebView2 Evergreen key is
# absent when the runtime is installed per-user, which is common; a collector
# that omitted the line would hand back a file whose reader cannot tell "not
# installed" from "nobody looked".
# ===========================================================================

# WHY THIS LINE IS LOAD-BEARING, found by running this script before shipping
# it. `Get-ItemProperty` against a missing key raises a NON-TERMINATING error,
# which `try/catch` does not see. Without this, a missing key left the block
# returning $null and the collector printed a confident half-reading -- the
# first draft produced "Windows : build 44" out of a registry it had not read.
# A collector that invents a partial fact is worse than one that fails.
$ErrorActionPreference = "Stop"

function Read-Fact {
    param([string] $Label, [scriptblock] $Block)
    try {
        $value = (& $Block | Out-String).Trim()
        if ([string]::IsNullOrWhiteSpace($value)) { return "$Label : (returned nothing)" }
        return "$Label : " + ($value -replace "`r?`n", "; ")
    } catch {
        # Collapsed to one line for the same reason the value is: this file is
        # a table, and a multi-line exception breaks the column a reader scans.
        $why = ($_.Exception.Message -replace "`r?`n", " ").Trim()
        return "$Label : (unavailable - $why)"
    }
}

$cv = "HKLM:\SOFTWARE\Microsoft\Windows NT\CurrentVersion"
$webview2 = "HKLM:\SOFTWARE\WOW6432Node\Microsoft\EdgeUpdate\Clients\{F3017226-FE2A-4295-8BDF-00C3A9A7E4C5}"

$lines = @()
$lines += "Experiment 1c - machine evidence, " + (Get-Date -Format u)
$lines += ""
$lines += Read-Fact "Windows      " { $p = Get-ItemProperty $cv; "$($p.ProductName) $($p.DisplayVersion) build $([Environment]::OSVersion.Version.Build)" }
$lines += Read-Fact "GPU          " { Get-CimInstance Win32_VideoController | ForEach-Object { "$($_.Name) (driver $($_.DriverVersion))" } }
$lines += Read-Fact "Displays     " { Get-CimInstance Win32_VideoController | ForEach-Object { "$($_.CurrentHorizontalResolution)x$($_.CurrentVerticalResolution) @$($_.CurrentRefreshRate)Hz" } }
$lines += Read-Fact "Scaling (DPI)" { (Get-ItemProperty "HKCU:\Control Panel\Desktop\WindowMetrics" -Name AppliedDPI).AppliedDPI }
$lines += Read-Fact "WebView2     " { (Get-ItemProperty $webview2).pv }
# NEW FOR 1c, and not cosmetic. Composition hosting needs
# ICoreWebView2Environment3, and DirectComposition needs dcomp.dll. If either
# is missing the run is a RUNTIME result rather than a compositing result, and
# the evidence file should be able to say so without anyone guessing.
$lines += Read-Fact "WebView2 user" { (Get-ItemProperty "HKCU:\SOFTWARE\Microsoft\EdgeUpdate\Clients\{F3017226-FE2A-4295-8BDF-00C3A9A7E4C5}").pv }
$lines += Read-Fact "dcomp.dll    " { (Get-Item "$env:SystemRoot\System32\dcomp.dll").VersionInfo.ProductVersion }
$lines += ""
$lines += "NOT COVERED by this file: whether the visual tree built, whether mpv published a"
$lines += "composition swapchain, whether the video was VISIBLE under the overlay, whether"
$lines += "the gradient tinted it, whether the button was clickable, and whether decode"
$lines += "happened in hardware. Those are the experiment. This is the machine it ran on."
$lines += "A green reading here is not a result for any of the eight criteria."
$lines += ""
$lines += "THE DIAGNOSTIC LOG IS THE OTHER HALF. exp-1c-diagnostic.log is written beside"
$lines += "the exe on every run and reports each construction step by name. Read its first"
$lines += "FAIL line before concluding anything, and send it back with this file."

$out = Join-Path $PSScriptRoot "exp-1c-evidence.txt"
$lines | Tee-Object -FilePath $out
Write-Host ""
Write-Host "Written to $out"
