/*
 * © 2026 CoreLayer
 * All Rights Reserved.
 *
 * Unauthorized copying, modification, or use is prohibited.
 */

// Diagnostic version of refreshVMs to identify the exact issue
async function refreshVMsDiagnostic() {
    const tbody = document.getElementById('vmTableBody');
    if (!tbody) return;
    
    let diagnosticInfo = [];
    setStatus('Running diagnostics...');
    
    // Step 1: Check if we can invoke IPC at all
    try {
        const testResult = await ipcRenderer.invoke('check-hyperv');
        diagnosticInfo.push(`✅ IPC Communication: Working (Hyper-V: ${testResult ? 'Yes' : 'No'})`);
    } catch (e) {
        diagnosticInfo.push(`❌ IPC Communication: Failed - ${e.message}`);
    }
    
    // Step 2: Try a simple PowerShell command
    try {
        const simpleCmd = 'Write-Output "test"';
        const result = await ipcRenderer.invoke('run-hyperv-cmd', simpleCmd);
        if (result.success) {
            diagnosticInfo.push(`✅ PowerShell: Working`);
        } else {
            diagnosticInfo.push(`❌ PowerShell: Failed - ${result.error}`);
        }
    } catch (e) {
        diagnosticInfo.push(`❌ PowerShell: Exception - ${e.message}`);
    }
    
    // Step 3: Check if Hyper-V module exists
    try {
        const moduleCmd = 'Get-Module -ListAvailable -Name Hyper-V | Select-Object -ExpandProperty Name';
        const result = await ipcRenderer.invoke('run-hyperv-cmd', moduleCmd);
        if (result.success && result.stdout.includes('Hyper-V')) {
            diagnosticInfo.push(`✅ Hyper-V Module: Installed`);
        } else {
            diagnosticInfo.push(`❌ Hyper-V Module: Not found`);
        }
    } catch (e) {
        diagnosticInfo.push(`❌ Hyper-V Module Check: Failed - ${e.message}`);
    }
    
    // Step 4: Try to get VMs with the simplest possible command
    try {
        const vmCmd = 'Get-VM | Select-Object -Property Name';
        const result = await ipcRenderer.invoke('run-hyperv-cmd', vmCmd);
        if (result.success) {
            diagnosticInfo.push(`✅ Get-VM Command: Working`);
            const vmCount = (result.stdout.match(/Name\s+:/g) || []).length;
            diagnosticInfo.push(`ℹ️ VMs Found: ${vmCount}`);
        } else {
            diagnosticInfo.push(`❌ Get-VM Command: Failed`);
            diagnosticInfo.push(`ℹ️ Error: ${result.error || 'Unknown'}`);
            if (result.stderr) {
                diagnosticInfo.push(`ℹ️ Details: ${result.stderr}`);
            }
        }
    } catch (e) {
        diagnosticInfo.push(`❌ Get-VM Exception: ${e.message}`);
    }
    
    // Display diagnostic results
    tbody.innerHTML = `
        <tr>
            <td colspan="5" style="padding: 20px;">
                <div style="color: #00d9ff; margin-bottom: 15px; font-size: 12px;">
                    <strong>Diagnostic Results:</strong>
                </div>
                <div style="color: #e6e6e8; font-size: 11px; line-height: 1.8;">
                    ${diagnosticInfo.join('<br>')}
                </div>
                <div style="margin-top: 20px;">
                    <button onclick="refreshVMs()" style="padding: 5px 15px; background: #00d9ff; border: none; color: #0a0e14; border-radius: 3px; cursor: pointer; font-weight: bold; margin-right: 10px;">
                        Try Normal Refresh
                    </button>
                    <button onclick="refreshVMsDiagnostic()" style="padding: 5px 15px; background: #1a1f26; border: 1px solid #00d9ff; color: #00d9ff; border-radius: 3px; cursor: pointer;">
                        Re-run Diagnostics
                    </button>
                </div>
            </td>
        </tr>
    `;
    
    setStatus('Diagnostics complete');
}

// Add diagnostic button to VM toolbar
window.addEventListener('DOMContentLoaded', () => {
    const vmToolbar = document.querySelector('.vm-toolbar');
    if (vmToolbar && !document.getElementById('diagnosticVMBtn')) {
        const diagBtn = document.createElement('button');
        diagBtn.className = 'toolbar-btn';
        diagBtn.id = 'diagnosticVMBtn';
        diagBtn.innerHTML = '🔍 Diagnose';
        diagBtn.onclick = refreshVMsDiagnostic;
        vmToolbar.appendChild(diagBtn);
    }
});
