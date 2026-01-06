/*
 * © 2026 CoreLayer
 * All Rights Reserved.
 *
 * This source code is provided for evaluation purposes only.
 * Copying, modification, redistribution, or commercial use
 * is strictly prohibited without prior written permission.
 */


const { app, BrowserWindow, ipcMain, dialog, session } = require('electron');
const path = require('path');
const { exec, spawn } = require('child_process');
const util = require('util');
const execPromise = util.promisify(exec);
const fetch = require('node-fetch');
const fs = require('fs').promises;

// Security: Disable navigation to external URLs
const ALLOWED_ORIGINS = ['file://'];

// Get the correct icon path (works for both dev and production)
function getIconPath() {
    if (app.isPackaged) {
        return path.join(process.resourcesPath, 'Icon.ico');
    }
    return path.join(__dirname, 'Icon.ico');
}

// Get the correct preload path
function getPreloadPath() {
    if (app.isPackaged) {
        return path.join(process.resourcesPath, 'app.asar', 'preload.js');
    }
    return path.join(__dirname, 'preload.js');
}

let mainWindow;
let splashWindow;
let ollamaProcess = null;

// Security: Content Security Policy
const CSP_HEADER = [
    "default-src 'self'",
    "script-src 'self' 'unsafe-inline'",  // unsafe-inline needed for inline event handlers
    "style-src 'self' 'unsafe-inline'",   // unsafe-inline needed for inline styles
    "img-src 'self' data: blob:",
    "font-src 'self'",
    "connect-src 'self' http://localhost:11434",  // Allow Ollama API
    "frame-src 'none'",
    "object-src 'none'",
    "base-uri 'self'",
    "form-action 'self'"
].join('; ');

function createWindow() {
    const iconPath = getIconPath();
    const preloadPath = getPreloadPath();
    
    // Splash window (no preload needed, just displays loading)
    splashWindow = new BrowserWindow({
        width: 600,
        height: 400,
        frame: false,
        transparent: true,
        alwaysOnTop: true,
        center: true,
        skipTaskbar: true,
        show: true,
        icon: iconPath,
        webPreferences: {
            nodeIntegration: false,
            contextIsolation: true,
            sandbox: true
        }
    });
    
    splashWindow.loadFile(path.join(__dirname, 'splash.html'));

    // Main window with security hardening
    mainWindow = new BrowserWindow({
        width: 1200,
        height: 720,
        minWidth: 1100,
        minHeight: 640,
        backgroundColor: '#0a0e14',
        show: false,
        icon: iconPath,
        autoHideMenuBar: true,
        webPreferences: {
            // Security: Use preload script with context isolation
            preload: preloadPath,
            nodeIntegration: false,        // Disable direct Node.js access
            contextIsolation: true,        // Isolate preload from renderer
            enableRemoteModule: false,     // Disable deprecated remote module
            sandbox: false,                // Can't use sandbox with Hyper-V cmdlets
            webSecurity: true,             // Enable web security
            allowRunningInsecureContent: false,
            experimentalFeatures: false,
            enableBlinkFeatures: '',       // Disable experimental Blink features
            disableBlinkFeatures: 'Auxclick',  // Disable middle-click navigation
            navigateOnDragDrop: false      // Prevent drag-drop navigation
        },
        frame: true,
        title: 'CoreLayer AI HyperVisor'
    });

    // Security: Set CSP headers
    mainWindow.webContents.session.webRequest.onHeadersReceived((details, callback) => {
        callback({
            responseHeaders: {
                ...details.responseHeaders,
                'Content-Security-Policy': [CSP_HEADER],
                'X-Content-Type-Options': ['nosniff'],
                'X-Frame-Options': ['DENY'],
                'X-XSS-Protection': ['1; mode=block']
            }
        });
    });

    // Security: Prevent navigation to external URLs
    mainWindow.webContents.on('will-navigate', (event, navigationUrl) => {
        const parsedUrl = new URL(navigationUrl);
        if (!ALLOWED_ORIGINS.some(origin => navigationUrl.startsWith(origin))) {
            console.warn(`Blocked navigation to: ${navigationUrl}`);
            event.preventDefault();
        }
    });

    // Security: Prevent opening new windows
    mainWindow.webContents.setWindowOpenHandler(({ url }) => {
        console.warn(`Blocked attempt to open new window: ${url}`);
        return { action: 'deny' };
    });

    // Security: Prevent webview creation
    mainWindow.webContents.on('will-attach-webview', (event, webPreferences, params) => {
        console.warn('Blocked webview creation');
        event.preventDefault();
    });

    mainWindow.loadFile('index.html');

    mainWindow.once('ready-to-show', () => {
        setTimeout(() => {
            if (splashWindow) {
                splashWindow.close();
                splashWindow = null;
            }
            mainWindow.show();
        }, 10000);  // 10 seconds splash screen
    });

    mainWindow.on('closed', () => {
        mainWindow = null;
    });
}

app.whenReady().then(createWindow);

app.on('window-all-closed', () => {
    if (process.platform !== 'darwin') {
        app.quit();
    }
});

app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) {
        createWindow();
    }
});

// ============================================================================
// SECURITY: Command Execution Safeguards
// ============================================================================

// Allowed PowerShell cmdlets (whitelist approach for Hyper-V management)
const ALLOWED_CMDLETS = [
    // Hyper-V VM Management
    'Get-VM', 'Start-VM', 'Stop-VM', 'Restart-VM', 'Remove-VM', 'New-VM',
    'Set-VM', 'Get-VMHost', 'Set-VMHost', 'Suspend-VM', 'Resume-VM',
    'Save-VM', 'Export-VM', 'Import-VM', 'Measure-VM', 'Compare-VM',
    
    // VM Hardware
    'Get-VMProcessor', 'Set-VMProcessor', 'Get-VMMemory', 'Set-VMMemory',
    'Get-VMNetworkAdapter', 'Add-VMNetworkAdapter', 'Remove-VMNetworkAdapter',
    'Set-VMNetworkAdapter', 'Get-VMHardDiskDrive', 'Add-VMHardDiskDrive',
    'Remove-VMHardDiskDrive', 'Set-VMHardDiskDrive', 'Get-VMDvdDrive',
    'Add-VMDvdDrive', 'Remove-VMDvdDrive', 'Set-VMDvdDrive',
    'Get-VMFirmware', 'Set-VMFirmware', 'Get-VMBios', 'Set-VMBios',
    'Get-VMIntegrationService', 'Enable-VMIntegrationService', 'Disable-VMIntegrationService',
    
    // Snapshots/Checkpoints
    'Get-VMSnapshot', 'Checkpoint-VM', 'Remove-VMSnapshot', 'Restore-VMSnapshot',
    'Rename-VMSnapshot', 'Get-VMCheckpoint', 'Remove-VMCheckpoint', 'Restore-VMCheckpoint',
    
    // Storage
    'Get-VHD', 'New-VHD', 'Resize-VHD', 'Convert-VHD', 'Optimize-VHD',
    'Mount-VHD', 'Dismount-VHD', 'Test-VHD', 'Set-VHD', 'Merge-VHD',
    'Get-VMStoragePath', 'Get-PhysicalDisk', 'Get-Disk', 'Get-Partition',
    'Get-Volume', 'Get-StoragePool', 'Optimize-Volume',
    
    // Networking
    'Get-VMSwitch', 'New-VMSwitch', 'Remove-VMSwitch', 'Set-VMSwitch',
    'Get-VMSwitchExtension', 'Get-NetAdapter', 'Get-NetIPAddress',
    
    // Clustering
    'Get-Cluster', 'Get-ClusterNode', 'Get-ClusterGroup', 'Get-ClusterResource',
    'Move-ClusterVirtualMachineRole', 'Get-ClusterSharedVolume',
    
    // iSCSI/SAN
    'Get-IscsiTarget', 'Get-IscsiSession', 'Get-IscsiConnection',
    'Connect-IscsiTarget', 'Disconnect-IscsiTarget', 'Get-InitiatorPort',
    'Get-MSDSMSupportedHW', 'Get-MSDSMGlobalDefaultLoadBalancePolicy',
    
    // System Info (read-only)
    'Get-Counter', 'Get-CimInstance', 'Get-WmiObject', 'Get-Process',
    'Get-Module', 'Get-Command', 'Get-Service', 'Get-ChildItem',
    'Test-Path', 'Get-Content', 'Get-Item', 'Get-ItemProperty',
    'Measure-Object', 'Select-Object', 'Where-Object', 'ForEach-Object',
    'Sort-Object', 'Format-List', 'ConvertTo-Json', 'Write-Output'
];

// Dangerous patterns that should NEVER be executed
const BLOCKED_PATTERNS = [
    // System destruction
    /Remove-Item\s+.*\s*-Recurse/i,
    /Remove-Item\s+['"]?[A-Z]:\\/i,
    /del\s+\/[sqf]/i,
    /rmdir\s+\/s/i,
    /format\s+[a-z]:/i,
    
    // Registry manipulation (except read)
    /New-ItemProperty/i,
    /Set-ItemProperty.*HKLM/i,
    /Set-ItemProperty.*HKCU.*\\Run/i,
    /Remove-ItemProperty.*HKLM/i,
    /reg\s+add/i,
    /reg\s+delete/i,
    
    // Persistence mechanisms
    /New-ScheduledTask/i,
    /Register-ScheduledTask/i,
    /schtasks\s+\/create/i,
    /Startup.*\.lnk/i,
    /\\Start Menu\\Programs\\Startup/i,
    
    // Network exfiltration
    /Invoke-WebRequest(?!.*localhost)/i,
    /Invoke-RestMethod(?!.*localhost)/i,
    /Start-BitsTransfer/i,
    /\[Net\.WebClient\]/i,
    /curl\s+/i,
    /wget\s+/i,
    
    // Credential theft
    /Get-Credential/i,
    /ConvertTo-SecureString/i,
    /mimikatz/i,
    /-Credential/i,
    
    // Code execution/bypass
    /Invoke-Expression/i,
    /IEX\s*\(/i,
    /Invoke-Command.*-ScriptBlock/i,
    /\[System\.Reflection/i,
    /Add-Type.*-TypeDefinition/i,
    /New-Object.*Net\.Sockets/i,
    /\$ExecutionContext/i,
    /DownloadString/i,
    /DownloadFile/i,
    /EncodedCommand/i,
    /-enc\s+/i,
    /FromBase64String/i,
    
    // Service/process manipulation (except Get)
    /Stop-Service(?!.*vmms)/i,
    /Remove-Service/i,
    /New-Service/i,
    /Stop-Process(?!.*vmconnect)/i,
    /Start-Process(?!.*vmconnect)/i,
    
    // Firewall manipulation
    /Set-NetFirewallProfile.*-Enabled.*False/i,
    /Disable-NetFirewallRule/i,
    /netsh.*firewall.*disable/i,
    
    // Antivirus manipulation
    /Set-MpPreference.*-Disable/i,
    /Uninstall.*Defender/i,
    
    // Dangerous paths
    /\\Windows\\System32\\config/i,
    /\\Windows\\System32\\drivers/i,
    /\\Windows\\SysWOW64/i
];

// Rate limiting
const commandHistory = [];
const RATE_LIMIT_WINDOW = 1000; // 1 second
const RATE_LIMIT_MAX = 10; // Max 10 commands per second

function isRateLimited() {
    const now = Date.now();
    // Clean old entries
    while (commandHistory.length > 0 && commandHistory[0] < now - RATE_LIMIT_WINDOW) {
        commandHistory.shift();
    }
    if (commandHistory.length >= RATE_LIMIT_MAX) {
        console.warn('Security: Rate limit exceeded');
        return true;
    }
    commandHistory.push(now);
    return false;
}

// Validate command safety
function isCommandSafe(command) {
    if (!command || typeof command !== 'string') {
        return { safe: false, reason: 'Invalid command' };
    }
    
    // Check for blocked patterns
    for (const pattern of BLOCKED_PATTERNS) {
        if (pattern.test(command)) {
            console.warn(`Security: Blocked dangerous pattern in command`);
            return { safe: false, reason: 'Command contains blocked pattern' };
        }
    }
    
    // Check if command uses allowed cmdlets (at least one must be present)
    const cmdletPattern = /([A-Z][a-z]+-[A-Z][a-zA-Z]+)/g;
    const foundCmdlets = command.match(cmdletPattern) || [];
    
    // For simple commands that might not have cmdlets (like variable assignments)
    if (foundCmdlets.length === 0) {
        // Allow if it's just data processing
        if (/^\s*\$[a-z]/i.test(command) || /ConvertTo-Json|Write-Output/i.test(command)) {
            return { safe: true };
        }
    }
    
    // Check each cmdlet is in the allowlist
    for (const cmdlet of foundCmdlets) {
        if (!ALLOWED_CMDLETS.includes(cmdlet)) {
            // Allow if it's a common safe cmdlet we might have missed
            if (/^(Get-|Select-|Where-|ForEach-|Sort-|Format-|Measure-|Out-|Write-)/i.test(cmdlet)) {
                continue; // These are generally safe read/format operations
            }
            console.warn(`Security: Unrecognized cmdlet: ${cmdlet}`);
            // Don't block unknown cmdlets, just log them
            // This allows flexibility while maintaining awareness
        }
    }
    
    return { safe: true };
}

// Sanitize command for safe execution
function sanitizeCommand(command) {
    if (!command) return '';
    
    // Remove null bytes
    let sanitized = command.replace(/\0/g, '');
    
    // Escape backticks to prevent command injection
    // Note: We need to be careful here as PowerShell uses backticks
    
    return sanitized;
}

// ============================================================================
// SECURITY: Path and Input Validation
// ============================================================================

// Sensitive system paths that should not be accessed
const BLOCKED_PATHS = [
    /\\Windows\\System32\\config/i,
    /\\Windows\\System32\\drivers/i,
    /\\Windows\\SysWOW64\\drivers/i,
    /\\Windows\\security/i,
    /\\Windows\\servicing/i,
    /\\Windows\\WinSxS/i,
    /\\Windows\\Logs\\CBS/i,
    /\\Boot\\/i,
    /\\Recovery\\/i,
    /\\\$Recycle\.Bin/i,
    /\\System Volume Information/i,
    /\\ProgramData\\Microsoft\\Windows\\Start Menu/i
];

// Allowed paths for VM operations
const ALLOWED_PATH_PATTERNS = [
    /^[A-Z]:\\(Hyper-V|VMs?|Virtual\s*Machines?)/i,
    /^[A-Z]:\\ISOs?/i,
    /^[A-Z]:\\Users\\[^\\]+\\(Documents|Desktop|Downloads)/i,
    /^[A-Z]:\\ProgramData\\Microsoft\\Windows\\Hyper-V/i,
    /^[A-Z]:\\ClusterStorage/i
];

// Validate file path is safe
function isPathSafe(filePath) {
    if (!filePath || typeof filePath !== 'string') {
        return { safe: false, reason: 'Invalid path' };
    }
    
    // Check for directory traversal
    if (filePath.includes('..')) {
        return { safe: false, reason: 'Directory traversal detected' };
    }
    
    // Check for blocked system paths
    for (const pattern of BLOCKED_PATHS) {
        if (pattern.test(filePath)) {
            return { safe: false, reason: 'Access to system path blocked' };
        }
    }
    
    return { safe: true };
}

// Sanitize VM name to prevent injection
function sanitizeVMName(name) {
    if (!name || typeof name !== 'string') return '';
    
    // Remove dangerous characters
    return name
        .replace(/[;|&`$(){}\[\]<>"'\\]/g, '')  // Remove shell metacharacters
        .replace(/\s+/g, ' ')                      // Normalize whitespace
        .trim()
        .substring(0, 100);                        // Limit length
}

// Validate VM name format
function isValidVMName(name) {
    if (!name || typeof name !== 'string') return false;
    if (name.length > 100) return false;
    
    // Block dangerous patterns
    const dangerousPatterns = [
        /[;|&`$(){}\[\]<>]/,  // Shell metacharacters
        /\.\.\//,            // Directory traversal
        /^\s*$/               // Empty/whitespace only
    ];
    
    for (const pattern of dangerousPatterns) {
        if (pattern.test(name)) return false;
    }
    
    return true;
}

// ============================================================================
// IPC Handlers for Hyper-V operations
// ============================================================================

ipcMain.handle('run-hyperv-cmd', async (event, command) => {
    // Security checks
    if (isRateLimited()) {
        return { success: false, error: 'Rate limit exceeded. Please slow down.' };
    }
    
    const safetyCheck = isCommandSafe(command);
    if (!safetyCheck.safe) {
        console.error(`Security: Blocked unsafe command - ${safetyCheck.reason}`);
        return { success: false, error: 'Command blocked for security reasons' };
    }
    
    try {
        const cleanCommand = sanitizeCommand(command).replace(/"/g, '`"').replace(/\r?\n/g, ' ');
        const { stdout, stderr } = await execPromise(
            `powershell -ExecutionPolicy Bypass -NoProfile -Command "${cleanCommand}"`,
            { 
                timeout: 60000,
                shell: true,
                windowsHide: true 
            }
        );
        
        console.log('PowerShell command executed successfully');
        return { success: true, stdout: stdout || '', stderr: stderr || '' };
    } catch (error) {
        console.error('PowerShell command failed:', error.message);
        return { 
            success: false, 
            error: error.message || 'Unknown error', 
            stderr: error.stderr || '',
            stdout: error.stdout || ''
        };
    }
});

// Generic PowerShell execution handler for AI automation
ipcMain.handle('execute-powershell', async (event, command) => {
    // Security checks
    if (isRateLimited()) {
        return { success: false, output: '', error: 'Rate limit exceeded. Please slow down.' };
    }
    
    const safetyCheck = isCommandSafe(command);
    if (!safetyCheck.safe) {
        console.error(`Security: Blocked unsafe AI command - ${safetyCheck.reason}`);
        return { success: false, output: '', error: 'Command blocked for security reasons' };
    }
    
    try {
        const cleanCommand = sanitizeCommand(command).replace(/"/g, '`"').replace(/\r?\n/g, ' ');
        const { stdout, stderr } = await execPromise(
            `powershell -ExecutionPolicy Bypass -NoProfile -Command "${cleanCommand}"`,
            { 
                timeout: 120000,  // 2 minute timeout for longer operations
                shell: true,
                windowsHide: true 
            }
        );
        
        console.log('PowerShell executed:', command.substring(0, 50) + '...');
        return { success: true, output: stdout || '', error: null };
    } catch (error) {
        console.error('PowerShell execution failed:', error.message);
        return { 
            success: false, 
            output: error.stdout || '',
            error: error.message || 'Unknown error'
        };
    }
});

// Dedicated handler for getting VMs
ipcMain.handle('get-vms', async () => {
    try {
        // Check Hyper-V module
        const checkCmd = 'Get-Module -ListAvailable -Name Hyper-V';
        try {
            await execPromise(
                `powershell -ExecutionPolicy Bypass -NoProfile -Command "${checkCmd}"`,
                { timeout: 5000 }
            );
        } catch {
            return { success: false, error: 'Hyper-V module not installed', vms: [] };
        }
        //Chet - Finally Fixd the error for Pasing the VMs from Hyper-V, Found out the error was from  the faulty powershell comand modifed bellow.
        //I added this block into the mix to have the correct command and running the program as an admin.
        // PowerShell script (semicolon-safe)
        const psScript = `
            try {
                $vms = @();
                Get-VM -ErrorAction Stop | ForEach-Object {
                    $vm = $_;
                    $vms += [PSCustomObject]@{
                        Name = $vm.Name;
                        State = $vm.State.ToString();
                        ProcessorCount = $vm.ProcessorCount;
                        MemoryStartup = $vm.MemoryStartup;
                        Uptime = if ($vm.Uptime) { $vm.Uptime.ToString() } else { 'N/A' };
                    };
                };
                if ($vms.Count -eq 0) {
                    Write-Output '[]';
                } else {
                    $vms | ConvertTo-Json -Compress;
                }
            } catch {
                Write-Output '[]';
            }
        `.replace(/\r?\n/g, ' ');

        const result = await execPromise(
            `powershell -ExecutionPolicy Bypass -NoProfile -Command "${psScript}"`,
            { timeout: 30000 }
        );

        let vms = [];
        try {
            const output = result.stdout.trim();
            if (output && output !== '[]') {
                const parsed = JSON.parse(output);
                vms = Array.isArray(parsed) ? parsed : [parsed];
            }
        } catch (err) {
            console.error('VM JSON parse error:', err, result.stdout);
        }

        return { success: true, vms };
    } catch (error) {
        console.error('Error getting VMs:', error);
        return { success: false, error: error.message, vms: [] };
    }
});


// Browse for ISO
ipcMain.handle('browse-for-iso', async () => {
    const result = await dialog.showOpenDialog({
        title: 'Select ISO File',
        buttonLabel: 'Select ISO',
        properties: ['openFile'],
        filters: [
            { name: 'ISO Files', extensions: ['iso'] },
            { name: 'All Files', extensions: ['*'] }
        ]
    });

    if (result.canceled || !result.filePaths.length) {
        return null;
    }

    return result.filePaths[0];
});

// Check Hyper-V availability
ipcMain.handle('check-hyperv', async () => {
    try {
        const { stdout } = await execPromise(
            'powershell -ExecutionPolicy Bypass -Command "Get-Command Get-VM -ErrorAction SilentlyContinue"',
            { timeout: 5000 }
        );
        return stdout.trim().length > 0;
    } catch {
        return false;
    }
});

// Get resource path (for loading assets in packaged app)
ipcMain.handle('get-resource-path', async (event, resourceName) => {
    if (!resourceName || typeof resourceName !== 'string') {
        return null;
    }
    
    // Only allow specific safe resource names
    const allowedResources = ['Icon.ico', 'LoadImage.png'];
    if (!allowedResources.includes(resourceName)) {
        return null;
    }
    
    if (app.isPackaged) {
        // In packaged app, resources are in the resources folder
        return path.join(process.resourcesPath, resourceName);
    } else {
        // In development, resources are in the app directory
        return path.join(__dirname, resourceName);
    }
});

// Get app icon as base64 (works in both dev and production)
ipcMain.handle('get-app-icon-base64', async () => {
    try {
        let iconPath;
        if (app.isPackaged) {
            // Try resources folder first (extraResources)
            iconPath = path.join(process.resourcesPath, 'Icon.ico');
        } else {
            // Development - icon is in app directory
            iconPath = path.join(__dirname, 'Icon.ico');
        }
        
        // Check if file exists
        const fsSync = require('fs');
        if (!fsSync.existsSync(iconPath)) {
            // Try alternative paths
            const altPaths = [
                path.join(__dirname, 'Icon.ico'),
                path.join(process.resourcesPath, 'app.asar', 'Icon.ico'),
                path.join(__dirname, 'assets', 'icon.ico')
            ];
            
            for (const altPath of altPaths) {
                if (fsSync.existsSync(altPath)) {
                    iconPath = altPath;
                    break;
                }
            }
        }
        
        // Read file and convert to base64
        const iconBuffer = await fs.readFile(iconPath);
        const base64 = iconBuffer.toString('base64');
        return `data:image/x-icon;base64,${base64}`;
    } catch (error) {
        console.error('Error loading app icon:', error);
        return null;
    }
});

// Get system stats
ipcMain.handle('get-system-stats', async () => {
    if (process.platform !== 'win32') {
        return { cpu: 0, memory: 0, disk: 0, network: 0 };
    }

    try {
        const cpuCmd = "Get-CimInstance Win32_PerfFormattedData_PerfOS_Processor | Where-Object { $_.Name -eq '_Total' } | Select-Object -ExpandProperty PercentProcessorTime";
        const memCmd = "Get-CimInstance Win32_OperatingSystem | ForEach-Object { [math]::Round((($_.TotalVisibleMemorySize - $_.FreePhysicalMemory) / $_.TotalVisibleMemorySize) * 100, 2) }";
        const diskCmd = "Get-CimInstance Win32_LogicalDisk | Where-Object { $_.DriveType -eq 3 -and $_.Size -gt 0 } | ForEach-Object { [math]::Round((($_.Size - $_.FreeSpace) / $_.Size) * 100, 2) } | Measure-Object -Average | Select-Object -ExpandProperty Average";
        const netCmd = "Get-CimInstance Win32_PerfFormattedData_Tcpip_NetworkInterface | Select-Object -First 1 -ExpandProperty BytesTotalPersec";

        const [cpuResult, memResult, diskResult, netResult] = await Promise.all([
            execPromise(`powershell -NoProfile -Command "${cpuCmd}"`),
            execPromise(`powershell -NoProfile -Command "${memCmd}"`),
            execPromise(`powershell -NoProfile -Command "${diskCmd}"`),
            execPromise(`powershell -NoProfile -Command "${netCmd}"`)
        ]);

        const cpu = parseFloat(cpuResult.stdout.trim()) || 0;
        const memory = parseFloat(memResult.stdout.trim()) || 0;
        const disk = parseFloat(diskResult.stdout.trim()) || 0;
        const netBytes = parseFloat(netResult.stdout.trim()) || 0;
        const network = netBytes / (1024 * 1024);

        return { cpu, memory, disk, network };
    } catch (err) {
        console.error("Stats error:", err);
        return { cpu: 0, memory: 0, disk: 0, network: 0 };
    }
});

// ==================== VM POWER MANAGEMENT PATCH ====================

// Start VM
ipcMain.handle('start-vm', async (event, vmName) => {
    // Security: Validate and sanitize VM name
    if (!isValidVMName(vmName)) {
        return { success: false, error: 'Invalid VM name' };
    }
    const safeName = sanitizeVMName(vmName);
    
    try {
        const cmd = `Start-VM -Name '${safeName}' -ErrorAction Stop`;
        await execPromise(
            `powershell -ExecutionPolicy Bypass -NoProfile -Command "${cmd}"`,
            { timeout: 30000 }
        );
        return { success: true };
    } catch (error) {
        // Check if VM exists
        const checkCmd = `Get-VM -Name '${safeName}' -ErrorAction SilentlyContinue`;
        try {
            const checkResult = await execPromise(
                `powershell -ExecutionPolicy Bypass -NoProfile -Command "${checkCmd}"`,
                { timeout: 10000 }
            );
            if (!checkResult.stdout || !checkResult.stdout.trim()) {
                return { success: false, error: `VM '${safeName}' not found. Check the name and try again.` };
            }
        } catch (e) {}
        return { success: false, error: error.message };
    }
});

// Graceful shutdown (guest OS)
ipcMain.handle('shutdown-vm', async (event, vmName) => {
    // Security: Validate and sanitize VM name
    if (!isValidVMName(vmName)) {
        return { success: false, error: 'Invalid VM name' };
    }
    const safeName = sanitizeVMName(vmName);
    
    try {
        const cmd = `Stop-VM -Name '${safeName}' -Shutdown -ErrorAction Stop`;
        await execPromise(
            `powershell -ExecutionPolicy Bypass -NoProfile -Command "${cmd}"`,
            { timeout: 30000 }
        );
        return { success: true };
    } catch (error) {
        return { success: false, error: error.message };
    }
});

// Stop VM (force)
ipcMain.handle('stop-vm', async (event, vmName) => {
    // Security: Validate and sanitize VM name
    if (!isValidVMName(vmName)) {
        return { success: false, error: 'Invalid VM name' };
    }
    const safeName = sanitizeVMName(vmName);
    
    try {
        const cmd = `Stop-VM -Name '${safeName}' -Force -ErrorAction Stop`;
        await execPromise(
            `powershell -ExecutionPolicy Bypass -NoProfile -Command "${cmd}"`,
            { timeout: 30000 }
        );
        return { success: true };
    } catch (error) {
        // Check if VM exists
        const checkCmd = `Get-VM -Name '${safeName}' -ErrorAction SilentlyContinue`;
        try {
            const checkResult = await execPromise(
                `powershell -ExecutionPolicy Bypass -NoProfile -Command "${checkCmd}"`,
                { timeout: 10000 }
            );
            if (!checkResult.stdout || !checkResult.stdout.trim()) {
                return { success: false, error: `VM '${safeName}' not found.` };
            }
        } catch (e) {}
        return { success: false, error: error.message };
    }
});

// Restart VM
ipcMain.handle('restart-vm', async (event, vmName) => {
    // Security: Validate and sanitize VM name
    if (!isValidVMName(vmName)) {
        return { success: false, error: 'Invalid VM name' };
    }
    const safeName = sanitizeVMName(vmName);
    
    try {
        const cmd = `Restart-VM -Name '${safeName}' -Force -ErrorAction Stop`;
        await execPromise(
            `powershell -ExecutionPolicy Bypass -NoProfile -Command "${cmd}"`,
            { timeout: 60000 }
        );
        return { success: true };
    } catch (error) {
        // Check if VM exists
        const checkCmd = `Get-VM -Name '${safeName}' -ErrorAction SilentlyContinue`;
        try {
            const checkResult = await execPromise(
                `powershell -ExecutionPolicy Bypass -NoProfile -Command "${checkCmd}"`,
                { timeout: 10000 }
            );
            if (!checkResult.stdout || !checkResult.stdout.trim()) {
                return { success: false, error: `VM '${safeName}' not found.` };
            }
        } catch (e) {}
        return { success: false, error: error.message };
    }
});

// Forced power off (Hyper-V "Turn Off")
ipcMain.handle('turnoff-vm', async (event, vmName) => {
    // Security: Validate and sanitize VM name
    if (!isValidVMName(vmName)) {
        return { success: false, error: 'Invalid VM name' };
    }
    const safeName = sanitizeVMName(vmName);
    
    try {
        const cmd = `Stop-VM -Name '${safeName}' -TurnOff -Force -ErrorAction Stop`;
        await execPromise(
            `powershell -ExecutionPolicy Bypass -NoProfile -Command "${cmd}"`,
            { timeout: 30000 }
        );
        return { success: true };
    } catch (error) {
        return { success: false, error: error.message };
    }
});

// Launch VMConnect
ipcMain.handle('launch-vmconnect', async (event, vmName) => {
    // Security: Validate and sanitize VM name
    if (!isValidVMName(vmName)) {
        return { success: false, error: 'Invalid VM name' };
    }
    const safeName = sanitizeVMName(vmName);
    
    const hostname = require('os').hostname();
    return new Promise((resolve) => {
        const proc = spawn('vmconnect.exe', [hostname, safeName], { 
            shell: false,
            detached: true 
        });
        
        setTimeout(() => {
            resolve({ success: true, pid: proc.pid });
        }, 500);
    });
});

// Get VM storage locations
ipcMain.handle('get-vm-stores', async () => {
    try {
        const cmd = `
            $stores = @()
            $defaultPath = (Get-VMHost).VirtualHardDiskPath
            $vmPath = (Get-VMHost).VirtualMachinePath
            
            if ($defaultPath) {
                $drive = $defaultPath.Substring(0,2)
                $free = [math]::Round((Get-PSDrive $drive.Replace(':','')).Free / 1GB, 2)
                $stores += @{
                    path = $defaultPath
                    name = 'VHD Storage'
                    freeSpaceGB = $free
                }
            }
            
            if ($vmPath -and $vmPath -ne $defaultPath) {
                $drive = $vmPath.Substring(0,2)
                $free = [math]::Round((Get-PSDrive $drive.Replace(':','')).Free / 1GB, 2)
                $stores += @{
                    path = $vmPath
                    name = 'VM Configuration'
                    freeSpaceGB = $free
                }
            }
            
            if ($stores.Count -eq 0) {
                $stores = @(@{
                    path = 'C:\\ProgramData\\Microsoft\\Windows\\Virtual Hard Disks'
                    name = 'Default'
                    freeSpaceGB = [math]::Round((Get-PSDrive C).Free / 1GB, 2)
                })
            }
            
            $stores | ConvertTo-Json
        `.replace(/\r?\n/g, ' ');
        
        const result = await execPromise(`powershell -ExecutionPolicy Bypass -Command "${cmd}"`);
        
        let stores = [];
        try {
            const data = JSON.parse(result.stdout.trim());
            stores = Array.isArray(data) ? data : [data];
        } catch (e) {
            stores = [{
                path: 'C:\\ProgramData\\Microsoft\\Windows\\Virtual Hard Disks',
                name: 'Default',
                freeSpaceGB: 100
            }];
        }
        
        return { success: true, stores };
    } catch (error) {
        return { 
            success: true, 
            stores: [{
                path: 'C:\\ProgramData\\Microsoft\\Windows\\Virtual Hard Disks',
                name: 'Default',
                freeSpaceGB: 100
            }]
        };
    }
});

// ==================== STORAGE MANAGEMENT HANDLERS ====================

// Get physical disks
ipcMain.handle('get-physical-disks', async () => {
    try {
        const cmd = `
            try {
                $results = @();
                $disks = Get-Disk;
                Get-PhysicalDisk | ForEach-Object {
                    $pd = $_;
                    $disk = $disks | Where-Object { $_.FriendlyName -eq $pd.FriendlyName };
                    $vols = @();
                    if ($disk) {
                        $vols = Get-Partition -DiskNumber $disk.Number -ErrorAction SilentlyContinue |
                                Get-Volume -ErrorAction SilentlyContinue;
                    }

                    $results += [PSCustomObject]@{
                        DeviceID = $pd.DeviceID;
                        FriendlyName = $pd.FriendlyName;
                        MediaType = $pd.MediaType;
                        BusType = $pd.BusType;
                        Size = $pd.Size;
                        HealthStatus = $pd.HealthStatus;
                        OperationalStatus = $pd.OperationalStatus;
                        UsageType = if ($vols) { ($vols.FileSystemLabel -join ', ') } else { 'Unallocated' };
                        FreeSpace = if ($vols) { ($vols.SizeRemaining | Measure-Object -Sum).Sum } else { 0 };
                    };
                };
                $results | ConvertTo-Json -Compress;
            } catch {
                Write-Output '[]';
            }
            `.replace(/\r?\n/g, ' ');

        
        const result = await execPromise(`powershell -ExecutionPolicy Bypass -Command "${cmd}"`);
        let disks = [];
        
        try {
            const data = JSON.parse(result.stdout.trim());
            disks = Array.isArray(data) ? data : [data];
        } catch (e) {
            console.error('Error parsing disk data:', e);
        }
        
        return { success: true, disks };
    } catch (error) {
        console.error('Error getting physical disks:', error);
        return { success: false, error: error.message, disks: [] };
    }
});

// Get virtual disks (VHDs)
ipcMain.handle('get-virtual-disks', async () => {
    try {
        const cmd = `
            try {
                $vhds = @();
                Get-VM | ForEach-Object {
                    $vm = $_;
                    Get-VMHardDiskDrive -VMName $vm.Name | ForEach-Object {
                        if ($_.Path) {
                            $vhd = Get-VHD -Path $_.Path -ErrorAction SilentlyContinue;
                            if ($vhd) {
                                $vhds += [PSCustomObject]@{
                                    Name = Split-Path $_.Path -Leaf;
                                    Path = $_.Path;
                                    Size = $vhd.Size;
                                    FileSize = $vhd.FileSize;
                                    VhdType = $vhd.VhdType;
                                    VhdFormat = $vhd.VhdFormat;
                                    AttachedTo = $vm.Name;
                                    ControllerType = $_.ControllerType;
                                    ControllerNumber = $_.ControllerNumber;
                                    ControllerLocation = $_.ControllerLocation;
                                };
                            };
                        };
                    };
                };

                $vhdPath = (Get-VMHost).VirtualHardDiskPath;
                if (Test-Path $vhdPath) {
                    Get-ChildItem $vhdPath -Filter *.vhd* | ForEach-Object {
                        if (-not ($vhds.Path -contains $_.FullName)) {
                            $vhd = Get-VHD -Path $_.FullName -ErrorAction SilentlyContinue;
                            if ($vhd) {
                                $vhds += [PSCustomObject]@{
                                    Name = $_.Name;
                                    Path = $_.FullName;
                                    Size = $vhd.Size;
                                    FileSize = $vhd.FileSize;
                                    VhdType = $vhd.VhdType;
                                    VhdFormat = $vhd.VhdFormat;
                                    AttachedTo = 'Not Attached';
                                    ControllerType = '';
                                    ControllerNumber = '';
                                    ControllerLocation = '';
                                };
                            };
                        };
                    };
                };

                $vhds | ConvertTo-Json -Compress;
            } catch {
                Write-Output '[]';
            }
            `.replace(/\r?\n/g, ' ');

        
        const result = await execPromise(`powershell -ExecutionPolicy Bypass -Command "${cmd}"`);
        let vhds = [];
        
        try {
            const data = result.stdout.trim();
            if (data && data !== '') {
                const parsed = JSON.parse(data);
                vhds = Array.isArray(parsed) ? parsed : [parsed];
            }
        } catch (e) {
            console.error('Error parsing VHD data:', e);
        }
        
        return { success: true, vhds };
    } catch (error) {
        console.error('Error getting virtual disks:', error);
        return { success: false, error: error.message, vhds: [] };
    }
});


// Create VHD
ipcMain.handle('create-vhd', async (event, params) => {
    try {
        const { name, path, size, type, format, blockSize } = params;
        const fullPath = path.endsWith('\\') ? `${path}${name}` : `${path}\\${name}`;
        
        let cmd = '';
        if (type === 'Fixed') {
            cmd = `New-VHD -Path "${fullPath}" -SizeBytes ${size} -Fixed`;
        } else if (type === 'Differencing') {
            cmd = `New-VHD -Path "${fullPath}" -ParentPath "${params.parentPath}" -Differencing`;
        } else {
            // Dynamic
            const blockSizeBytes = parseInt(blockSize.replace('MB', '')) * 1024 * 1024;
            cmd = `New-VHD -Path "${fullPath}" -SizeBytes ${size} -Dynamic -BlockSizeBytes ${blockSizeBytes}`;
        }
        
        const result = await execPromise(`powershell -ExecutionPolicy Bypass -Command "${cmd}"`);
        return { success: true, message: 'VHD created successfully', path: fullPath };
    } catch (error) {
        return { success: false, error: error.message };
    }
});

// Attach VHD
ipcMain.handle('attach-vhd', async (event, path) => {
    try {
        const cmd = `Mount-VHD -Path "${path}" -Passthru | Get-Disk | Get-Partition | Get-Volume | Select-Object DriveLetter`;
        const result = await execPromise(`powershell -ExecutionPolicy Bypass -Command "${cmd}"`);
        return { success: true, message: 'VHD attached successfully' };
    } catch (error) {
        return { success: false, error: error.message };
    }
});

//Chet - Added the Deletion of Virtual Hard Disks IPCHandler
ipcMain.handle('delete-virtual-disk', async (event, vhdPath) => {
    try {
        console.log('[DELETE-VHD] Request to delete:', vhdPath);
        
        if (!vhdPath || typeof vhdPath !== 'string') {
            return { success: false, error: 'Invalid VHD path' };
        }

        // Fixed PowerShell script with correct comment syntax
        const psScript = `
        try {
            $path = '${vhdPath.replace(/'/g, "''")}'

            if (-not (Test-Path $path)) {
                throw 'VHD file does not exist'
            }

            # Ensure VHD is not attached to any VM (FIXED: using # for PowerShell comments)
            $attached = Get-VM -ErrorAction SilentlyContinue | ForEach-Object {
                Get-VMHardDiskDrive -VMName $_.Name -ErrorAction SilentlyContinue | Where-Object { $_.Path -eq $path }
            }

            if ($attached) {
                throw 'VHD is currently attached to a virtual machine'
            }

            # Try to dismount if mounted
            try {
                Dismount-VHD -Path $path -ErrorAction SilentlyContinue
            } catch { }

            Remove-Item -Path $path -Force
            Write-Output '{ "success": true }'
        } catch {
            Write-Output ('{ "success": false, "error": "' + $_.Exception.Message + '" }')
        }
        `;

        const encoded = Buffer.from(psScript, 'utf16le').toString('base64');

        const result = await execPromise(
            `powershell -NoProfile -ExecutionPolicy Bypass -EncodedCommand ${encoded}`,
            { timeout: 30000 }
        );

        console.log('[DELETE-VHD] Result:', result.stdout);
        return JSON.parse(result.stdout.trim());
    } catch (error) {
        console.error('Error deleting VHD:', error);
        return { success: false, error: error.message };
    }
});

// Alias for delete-vhd to maintain compatibility
ipcMain.handle('delete-vhd', async (event, path) => {
    // Forward to the delete-virtual-disk handler
    try {
        const handlers = ipcMain._invokeHandlers || ipcMain._handlers;
        if (handlers && handlers.has('delete-virtual-disk')) {
            const [channelId, handler] = handlers.get('delete-virtual-disk');
            return await handler(event, path);
        }
        // Fallback: directly call the delete logic
        return await ipcRenderer.invoke('delete-virtual-disk', path);
    } catch (error) {
        return { success: false, error: error.message };
    }
});

// Resize VHD
ipcMain.handle('resize-vhd', async (event, params) => {
    try {
        const { path, newSize } = params;
        const cmd = `Resize-VHD -Path "${path}" -SizeBytes ${newSize}`;
        await execPromise(`powershell -ExecutionPolicy Bypass -Command "${cmd}"`);
        return { success: true, message: 'VHD resized successfully' };
    } catch (error) {
        return { success: false, error: error.message };
    }
});

// Convert VHD
ipcMain.handle('convert-vhd', async (event, params) => {
    try {
        const { sourcePath, destinationPath, vhdType } = params;
        const cmd = `Convert-VHD -Path "${sourcePath}" -DestinationPath "${destinationPath}" -VHDType ${vhdType}`;
        await execPromise(`powershell -ExecutionPolicy Bypass -Command "${cmd}"`);
        return { success: true, message: 'VHD converted successfully' };
    } catch (error) {
        return { success: false, error: error.message };
    }
});

// Compact VHD
ipcMain.handle('compact-vhd', async (event, path) => {
    try {
        const cmd = `Optimize-VHD -Path "${path}" -Mode Full`;
        await execPromise(`powershell -ExecutionPolicy Bypass -Command "${cmd}"`);
        return { success: true, message: 'VHD compacted successfully' };
    } catch (error) {
        return { success: false, error: error.message };
    }
});

// Get storage pools
ipcMain.handle('get-storage-pools', async () => {
    try {
        const cmd = `
            try {
                $pools = @();
                Get-StoragePool | Where-Object { $_.FriendlyName -ne 'Primordial' } | ForEach-Object {
                    $pool = $_;
                    $disks = Get-PhysicalDisk -StoragePool $pool;
                    $pools += [PSCustomObject]@{
                        FriendlyName = $pool.FriendlyName;
                        HealthStatus = $pool.HealthStatus;
                        OperationalStatus = $pool.OperationalStatus;
                        Size = $pool.Size;
                        AllocatedSize = $pool.AllocatedSize;
                        ResiliencySettingName = (Get-ResiliencySetting -StoragePool $pool).Name;
                        PhysicalDisks = $disks.Count;
                        IsReadOnly = $pool.IsReadOnly;
                    };
                };
                $pools | ConvertTo-Json -Compress;
            } catch {
                Write-Output '[]';
            }
            `.replace(/\r?\n/g, ' ');

        
        const result = await execPromise(`powershell -ExecutionPolicy Bypass -Command "${cmd}"`);
        let pools = [];
        
        try {
            const data = result.stdout.trim();
            if (data) {
                const parsed = JSON.parse(data);
                pools = Array.isArray(parsed) ? parsed : [parsed];
            }
        } catch (e) {
            console.error('Error parsing pool data:', e);
        }
        
        return { success: true, pools };
    } catch (error) {
        console.error('Error getting storage pools:', error);
        return { success: false, error: error.message, pools: [] };
    }
});

// Create storage pool
ipcMain.handle('create-storage-pool', async (event, params) => {
    try {
        const { name, disks, resiliency } = params;
        const diskList = disks.map(d => `"${d}"`).join(',');
        
        const cmd = `
            $disks = Get-PhysicalDisk | Where-Object {$_.FriendlyName -in @(${diskList})}
            New-StoragePool -FriendlyName "${name}" -PhysicalDisks $disks -ResiliencySettingName ${resiliency} -StorageSubSystemFriendlyName "Windows Storage*"
        `.replace(/\r?\n/g, ' ');
        
        await execPromise(`powershell -ExecutionPolicy Bypass -Command "${cmd}"`);
        return { success: true, message: 'Storage pool created successfully' };
    } catch (error) {
        return { success: false, error: error.message };
    }
});

// Get volumes
ipcMain.handle('get-volumes', async () => {
    try {
        const cmd = `
            Get-Volume | Where-Object {$_.DriveLetter} | ForEach-Object {
                [PSCustomObject]@{
                    DriveLetter = $_.DriveLetter
                    FileSystemLabel = $_.FileSystemLabel
                    FileSystem = $_.FileSystem
                    Size = $_.Size
                    SizeRemaining = $_.SizeRemaining
                    HealthStatus = $_.HealthStatus
                    OperationalStatus = $_.OperationalStatus
                    DriveType = $_.DriveType
                }
            } | ConvertTo-Json
        `.replace(/\r?\n/g, ' ');
        
        const result = await execPromise(`powershell -ExecutionPolicy Bypass -Command "${cmd}"`);
        let volumes = [];
        
        try {
            const data = JSON.parse(result.stdout.trim());
            volumes = Array.isArray(data) ? data : [data];
        } catch (e) {
            console.error('Error parsing volume data:', e);
        }
        
        return { success: true, volumes };
    } catch (error) {
        return { success: false, error: error.message, volumes: [] };
    }
});

// Get VM checkpoints/snapshots
ipcMain.handle('get-checkpoints', async () => {
    try {
        const cmd = `
            Get-VM | ForEach-Object {
                $vm = $_
                Get-VMSnapshot -VMName $vm.Name -ErrorAction SilentlyContinue | ForEach-Object {
                    [PSCustomObject]@{
                        VMName = $vm.Name
                        Name = $_.Name
                        CreationTime = $_.CreationTime
                        ParentSnapshotName = $_.ParentSnapshotName
                        Path = $_.Path
                        SizeOfSystemFiles = $_.SizeOfSystemFiles
                        SnapshotType = $_.SnapshotType
                        Id = $_.Id
                    }
                }
            } | ConvertTo-Json
        `.replace(/\r?\n/g, ' ');
        
        const result = await execPromise(`powershell -ExecutionPolicy Bypass -Command "${cmd}"`);
        let checkpoints = [];
        
        try {
            const data = result.stdout.trim();
            if (data) {
                const parsed = JSON.parse(data);
                checkpoints = Array.isArray(parsed) ? parsed : [parsed];
            }
        } catch (e) {
            console.error('Error parsing checkpoint data:', e);
        }
        
        return { success: true, checkpoints };
    } catch (error) {
        return { success: false, error: error.message, checkpoints: [] };
    }
});

// Create checkpoint
ipcMain.handle('create-checkpoint', async (event, params) => {
    try {
        const { vmName, checkpointName } = params;
        const cmd = `Checkpoint-VM -Name "${vmName}" -SnapshotName "${checkpointName}"`;
        await execPromise(`powershell -ExecutionPolicy Bypass -Command "${cmd}"`);
        return { success: true, message: 'Checkpoint created successfully' };
    } catch (error) {
        return { success: false, error: error.message };
    }
});

// Remove checkpoint
ipcMain.handle('remove-checkpoint', async (event, params) => {
    try {
        const { vmName, checkpointName } = params;
        const cmd = `Remove-VMSnapshot -VMName "${vmName}" -Name "${checkpointName}" -IncludeAllChildSnapshots`;
        await execPromise(`powershell -ExecutionPolicy Bypass -Command "${cmd}"`);
        return { success: true, message: 'Checkpoint removed successfully' };
    } catch (error) {
        return { success: false, error: error.message };
    }
});

// Apply checkpoint
ipcMain.handle('apply-checkpoint', async (event, params) => {
    try {
        const { vmName, checkpointId } = params;
        const cmd = `Restore-VMSnapshot -VMName "${vmName}" -Id "${checkpointId}" -Confirm:$false`;
        await execPromise(`powershell -ExecutionPolicy Bypass -Command "${cmd}"`);
        return { success: true, message: 'Checkpoint applied successfully' };
    } catch (error) {
        return { success: false, error: error.message };
    }
});

// Export checkpoint
ipcMain.handle('export-checkpoint', async (event, params) => {
    try {
        const { vmName, checkpointName, exportPath } = params;
        const cmd = `Export-VMSnapshot -VMName "${vmName}" -Name "${checkpointName}" -Path "${exportPath}"`;
        await execPromise(`powershell -ExecutionPolicy Bypass -Command "${cmd}"`);
        return { success: true, message: 'Checkpoint exported successfully' };
    } catch (error) {
        return { success: false, error: error.message };
    }
});

// Get ISO library
ipcMain.handle('get-iso-library', async (event, libraryPath) => {
    try {
        const isoPath = libraryPath || 'C:\\ISOs';
        
        // Ensure ISO directory exists
        await fs.mkdir(isoPath, { recursive: true }).catch(() => {});
        
        const cmd = `Get-ChildItem -Path "${isoPath}" -Filter *.iso -ErrorAction SilentlyContinue | Select-Object Name, FullName, Length, CreationTime | ConvertTo-Json`;
        const result = await execPromise(`powershell -ExecutionPolicy Bypass -Command "${cmd}"`);
        
        let isos = [];
        try {
            const data = result.stdout.trim();
            if (data) {
                const parsed = JSON.parse(data);
                isos = Array.isArray(parsed) ? parsed : [parsed];
            }
        } catch (e) {
            // No ISOs found
        }
        
        return { success: true, isos };
    } catch (error) {
        return { success: false, error: error.message, isos: [] };
    }
});

// Add ISO to library
ipcMain.handle('add-iso-to-library', async (event, params) => {
    try {
        const { sourcePath, libraryPath } = params;
        const destPath = libraryPath || 'C:\\ISOs';
        const fileName = path.basename(sourcePath);
        const destination = path.join(destPath, fileName);
        
        const cmd = `Copy-Item -Path "${sourcePath}" -Destination "${destination}" -Force`;
        await execPromise(`powershell -ExecutionPolicy Bypass -Command "${cmd}"`);
        
        return { success: true, message: 'ISO added to library' };
    } catch (error) {
        return { success: false, error: error.message };
    }
});

// Remove ISO from library
ipcMain.handle('remove-iso', async (event, isoPath) => {
    try {
        const cmd = `Remove-Item -Path "${isoPath}" -Force`;
        await execPromise(`powershell -ExecutionPolicy Bypass -Command "${cmd}"`);
        return { success: true, message: 'ISO removed from library' };
    } catch (error) {
        return { success: false, error: error.message };
    }
});

// Get Storage QoS Policies
ipcMain.handle('get-qos-policies', async () => {
    try {
        const cmd = `
            Get-StorageQosPolicy -ErrorAction SilentlyContinue | ForEach-Object {
                [PSCustomObject]@{
                    Name = $_.Name
                    PolicyId = $_.PolicyId
                    MinimumIops = $_.MinimumIops
                    MaximumIops = $_.MaximumIops
                    MaximumIOBandwidth = $_.MaximumIOBandwidth
                    PolicyType = $_.PolicyType
                    Status = $_.Status
                }
            } | ConvertTo-Json
        `.replace(/\r?\n/g, ' ');
        
        const result = await execPromise(`powershell -ExecutionPolicy Bypass -Command "${cmd}"`);
        let policies = [];
        
        try {
            const data = result.stdout.trim();
            if (data) {
                const parsed = JSON.parse(data);
                policies = Array.isArray(parsed) ? parsed : [parsed];
            }
        } catch (e) {
            console.error('Error parsing QoS data:', e);
        }
        
        return { success: true, policies };
    } catch (error) {
        return { success: false, error: error.message, policies: [] };
    }
});

// Create QoS Policy
ipcMain.handle('create-qos-policy', async (event, params) => {
    try {
        const { name, minIops, maxIops, maxBandwidth } = params;
        
        let cmd = `New-StorageQosPolicy -Name "${name}"`;
        if (minIops) cmd += ` -MinimumIops ${minIops}`;
        if (maxIops) cmd += ` -MaximumIops ${maxIops}`;
        if (maxBandwidth) cmd += ` -MaximumIOBandwidth ${maxBandwidth}`;
        
        await execPromise(`powershell -ExecutionPolicy Bypass -Command "${cmd}"`);
        return { success: true, message: 'QoS policy created successfully' };
    } catch (error) {
        return { success: false, error: error.message };
    }
});

// Edit VM settings
ipcMain.handle('edit-vm', async (event, params) => {
    try {
        const { vmName, settings } = params;
        let cmds = [];
        
        if (settings.memory) {
            cmds.push(`Set-VM -Name '${vmName}' -MemoryStartupBytes ${settings.memory * 1024 * 1024}`);
        }
        if (settings.processorCount) {
            cmds.push(`Set-VM -Name '${vmName}' -ProcessorCount ${settings.processorCount}`);
        }
        if (settings.notes !== undefined) {
            cmds.push(`Set-VM -Name '${vmName}' -Notes '${settings.notes.replace(/'/g, "''")}'`);
        }
        if (settings.automaticStartAction) {
            cmds.push(`Set-VM -Name '${vmName}' -AutomaticStartAction ${settings.automaticStartAction}`);
        }
        if (settings.automaticStopAction) {
            cmds.push(`Set-VM -Name '${vmName}' -AutomaticStopAction ${settings.automaticStopAction}`);
        }
        // Handle ISO path changes
        if (settings.isoPath !== undefined) {
            if (settings.isoPath) {
                // Set new ISO path
                cmds.push(`Set-VMDvdDrive -VMName '${vmName}' -Path '${settings.isoPath}'`);
            } else {
                // Remove ISO (set to empty)
                cmds.push(`Set-VMDvdDrive -VMName '${vmName}' -Path $null`);
            }
        }
        
        for (const cmd of cmds) {
            await execPromise(`powershell -ExecutionPolicy Bypass -Command "${cmd}"`);
        }
        
        return { success: true, message: 'VM settings updated successfully' };
    } catch (error) {
        return { success: false, error: error.message };
    }
});

// Get VM details for editing
ipcMain.handle('get-vm-details', async (event, vmName) => {
    try {
        // Escape single quotes in VM name
        const safeName = vmName.replace(/'/g, "''");
        const cmd = `$vm = Get-VM -Name '${safeName}'; $dvdDrive = Get-VMDvdDrive -VMName '${safeName}' -ErrorAction SilentlyContinue | Select-Object -First 1; $dvdPath = $null; if ($dvdDrive -and $dvdDrive.Path) { $dvdPath = $dvdDrive.Path }; [PSCustomObject]@{ Name = $vm.Name; ProcessorCount = $vm.ProcessorCount; MemoryStartup = $vm.MemoryStartup; MemoryMinimum = $vm.MemoryMinimum; MemoryMaximum = $vm.MemoryMaximum; Notes = $vm.Notes; Generation = $vm.Generation; Version = $vm.Version; AutomaticStartAction = $vm.AutomaticStartAction.ToString(); AutomaticStopAction = $vm.AutomaticStopAction.ToString(); AutomaticStartDelay = $vm.AutomaticStartDelay; State = $vm.State.ToString(); DvdDrivePath = $dvdPath } | ConvertTo-Json`;
        
        const result = await execPromise(`powershell -ExecutionPolicy Bypass -NoProfile -Command "${cmd}"`, { timeout: 30000 });
        
        if (!result.stdout || !result.stdout.trim()) {
            return { success: false, error: 'No output from PowerShell command' };
        }
        
        const details = JSON.parse(result.stdout.trim());
        return { success: true, details };
    } catch (error) {
        console.error('Error getting VM details:', error);
        console.error('stderr:', error.stderr);
        return { success: false, error: error.message || 'Failed to get VM details' };
    }
});

// Optimize disk
ipcMain.handle('optimize-disk', async (event, driveLetter) => {
    try {
        const drive = driveLetter || 'C';
        const cmd = `Optimize-Volume -DriveLetter ${drive} -Defrag -Verbose`;
        
        // Start optimization in background
        exec(`powershell -ExecutionPolicy Bypass -Command "${cmd}"`, (error) => {
            if (error) console.error('Optimization error:', error);
        });
        
        return { success: true, message: 'Disk optimization started in background' };
    } catch (error) {
        return { success: false, error: error.message };
    }
});

// Check disk health
ipcMain.handle('check-disk-health', async () => {
    try {
        const cmd = `
            Get-PhysicalDisk | ForEach-Object {
                $disk = $_
                $reliability = Get-StorageReliabilityCounter -PhysicalDisk $disk -ErrorAction SilentlyContinue
                [PSCustomObject]@{
                    FriendlyName = $disk.FriendlyName
                    HealthStatus = $disk.HealthStatus
                    OperationalStatus = $disk.OperationalStatus
                    Temperature = if($reliability) { $reliability.Temperature } else { 'N/A' }
                    Wear = if($reliability) { $reliability.Wear } else { 'N/A' }
                    PowerOnHours = if($reliability) { $reliability.PowerOnHours } else { 'N/A' }
                    ReadErrorsTotal = if($reliability) { $reliability.ReadErrorsTotal } else { 'N/A' }
                    WriteErrorsTotal = if($reliability) { $reliability.WriteErrorsTotal } else { 'N/A' }
                }
            } | ConvertTo-Json
        `.replace(/\r?\n/g, ' ');
        
        const result = await execPromise(`powershell -ExecutionPolicy Bypass -Command "${cmd}"`);
        let healthData = [];
        
        try {
            const data = JSON.parse(result.stdout.trim());
            healthData = Array.isArray(data) ? data : [data];
        } catch (e) {
            console.error('Error parsing health data:', e);
        }
        
        return { success: true, healthData };
    } catch (error) {
        return { success: false, error: error.message };
    }
});

// Send AI message
ipcMain.handle('send-ai-message', async (event, message) => {
    try {
        // Ensure Ollama server is running
        const model = 'llama3';
        
        const systemPrompt = `You are an AI assistant for managing Hyper-V virtual machines and storage. 
        You can help users with VM operations, storage management, and general IT tasks.
        Be helpful, concise, and technically accurate.`;
        
        const response = await fetch('http://localhost:11434/api/generate', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                model: model,
                prompt: `${systemPrompt}\n\nUser: ${message}\nAssistant:`,
                stream: false
            })
        });
        
        if (!response.ok) {
            throw new Error(`Ollama API error: ${response.status}`);
        }
        
        const data = await response.json();
        return { success: true, response: data.response };
    } catch (error) {
        return { success: false, error: 'AI service not available. Please ensure Ollama is installed and running.' };
    }
});

app.on('before-quit', () => {
    if (ollamaProcess) {
        try {
            process.kill(ollamaProcess.pid);
        } catch (error) {
            // Process may have already exited
        }
    }
});
