/*
 * © 2026 CoreLayer
 * All Rights Reserved.
 *
 * Unauthorized copying, modification, or use is prohibited.
 */

/**
 * CoreLayer AI HyperVisor - Renderer Process
 * 
 * Security: Uses secure IPC bridge exposed via preload script
 * All IPC calls go through window.api which validates channels
 */

// Security: Create ipcRenderer-compatible wrapper using secure API bridge
// This allows existing code to work with minimal changes while using the secure bridge
const ipcRenderer = {
    invoke: async (channel, ...args) => {
        if (typeof window.api !== 'undefined') {
            return await window.api.invoke(channel, ...args);
        }
        throw new Error('Secure API bridge not available');
    },
    send: (channel, ...args) => {
        if (typeof window.api !== 'undefined') {
            window.api.send(channel, ...args);
        }
    },
    on: (channel, callback) => {
        if (typeof window.api !== 'undefined') {
            return window.api.on(channel, callback);
        }
        return () => {};
    }
};

// Security: Escape HTML to prevent XSS attacks
function escapeHtml(str) {
    if (typeof str !== 'string') return str;
    const div = document.createElement('div');
    div.textContent = str;
    return div.innerHTML;
}

// Security: Sanitize input for PowerShell commands
function sanitizeForPowerShell(str) {
    if (typeof str !== 'string') return '';
    // Escape single quotes by doubling them
    return str.replace(/'/g, "''");
}

// Security: Validate paths to prevent directory traversal
function isPathSafe(path) {
    if (typeof path !== 'string') return false;
    return !path.includes('..') && !path.includes('//');
}

// Load app icon for About page
async function loadAboutPageIcon() {
    const logoImg = document.getElementById('aboutLogoImg');
    if (!logoImg) return;
    
    try {
        // Get icon as base64 from main process
        const base64Icon = await ipcRenderer.invoke('get-app-icon-base64');
        if (base64Icon) {
            logoImg.src = base64Icon;
            logoImg.style.display = 'block';
        } else {
            // Fallback to CSS-styled logo
            showFallbackLogo(logoImg);
        }
    } catch (error) {
        console.error('Error loading app icon:', error);
        showFallbackLogo(logoImg);
    }
}

// Show fallback styled logo if icon fails to load
function showFallbackLogo(logoImg) {
    logoImg.style.display = 'none';
    const parent = logoImg.parentElement;
    if (parent && !parent.querySelector('.fallback-logo')) {
        const fallback = document.createElement('div');
        fallback.className = 'fallback-logo';
        fallback.innerHTML = '<div class="logo-icon">⬡</div>';
        fallback.style.cssText = `
            width: 80px; height: 80px;
            background: linear-gradient(135deg, #00d9ff 0%, #0099cc 100%);
            border-radius: 18px; display: flex; align-items: center; justify-content: center;
            box-shadow: 0 8px 32px rgba(0, 217, 255, 0.35);
        `;
        fallback.querySelector('.logo-icon').style.cssText = `
            font-size: 42px; color: #0a0e14;
        `;
        parent.appendChild(fallback);
    }
}

// App State
let hypervAvailable = false;
let sidebarExpanded = true;
let currentView = 'dashboard';
let selectedVM = null;
let statsHistory = {
    cpu: Array(60).fill(0),
    memory: Array(60).fill(0),
    disk: Array(60).fill(0),
    network: Array(60).fill(0)
};

// Storage Management State
let currentStorageCategory = 'host';
let currentStorageTab = 'physical';
let currentHypervTab = 'vhds';
let selectedISO = null;
let selectedVHD = null;
let selectedVhdPath = null;
let selectedPool = null;
let selectedVolume = null;
let selectedCheckpoint = null;
let isoLibraryPath = 'C:\\ISOs';

// Initialize App
async function initApp() {
    try {
        console.log('Initializing application...');
        
        // Load app icon for About page
        loadAboutPageIcon();
        
        // Load and apply saved settings first
        loadAndApplySettings();
        
        // Check Hyper-V availability
        hypervAvailable = await ipcRenderer.invoke('check-hyperv');
        
        if (!hypervAvailable) {
            setStatus('Hyper-V not available - Running in limited mode');
            console.warn('Hyper-V is not available');
        } else {
            setStatus('Connected to Hyper-V');
        }
        
        // Set up event listeners with error handling
        setupEventListeners();
        
        // Start stats loop
        startStatsLoop();
        
        // Initialize dashboard view and set active state
        switchView('dashboard');
        
        // Load VMs if on VMs view
        if (currentView === 'vms') {
            refreshVMs();
        }
        
        console.log('Application initialized successfully');
    } catch (error) {
        console.error('Error initializing app:', error);
        setStatus('Error initializing application');
    }
}

// Load and apply settings at startup
function loadAndApplySettings() {
    try {
        const savedSettings = localStorage.getItem('corelayer-settings');
        if (savedSettings) {
            const settings = JSON.parse(savedSettings);
            applySettings(settings);
            window.appSettings = settings;
        } else {
            const defaults = getDefaultSettings();
            applySettings(defaults);
            window.appSettings = defaults;
        }
    } catch (error) {
        console.error('Error loading settings at startup:', error);
        const defaults = getDefaultSettings();
        applySettings(defaults);
        window.appSettings = defaults;
    }
}

// Setup Event Listeners with error handling
function setupEventListeners() {
    try {
        // Sidebar toggle
        const toggleBtn = document.getElementById('toggleSidebar');
        if (toggleBtn) {
            toggleBtn.addEventListener('click', toggleSidebar);
        }
        
        // Sidebar buttons
        document.querySelectorAll('.sidebar-btn').forEach(btn => {
            btn.addEventListener('click', (e) => {
                const view = e.currentTarget.dataset.view;
                if (view) switchView(view);
            });
        });
        
        // Quick action buttons
        document.querySelectorAll('.action-btn').forEach(btn => {
            btn.addEventListener('click', (e) => {
                const action = e.currentTarget.dataset.action;
                if (action) handleQuickAction(action);
            });
        });
        
        // ✅ UPDATED: Chet - Implemented VM Toolbar buttons
        const vmButtons = {
            'createVMBtn': showCreateVMDialog,
            'startVMBtn': startVM,
            'consoleVMBtn': consoleVM,

            // 🔧 ADDED
            'shutdownVMBtn': shutdownVM,
            'turnOffVMBtn': turnOffVM,

            'stopVMBtn': stopVM,
            'deleteVMBtn': deleteVM,
            'refreshVMBtn': refreshVMs,
            'snapshotVMBtn': showSnapshotDialog,
            'editVMBtn': showEditVMDialog
        };
        for (const [id, handler] of Object.entries(vmButtons)) {
            const btn = document.getElementById(id);
            if (btn) {
                btn.addEventListener('click', () => handler());
            }
        }

        // ==================== VM POWER ACTIONS ====================
        
        async function shutdownVM() {
            if (!selectedVM) {
                alert('Please select a VM');
                return;
            }
        
            if (shouldConfirmAction() && !confirm(`Shut down ${selectedVM} (guest OS shutdown)?`)) return;
        
            const taskId = createTask('Shut Down Virtual Machine', selectedVM);
            
            try {
                updateTaskProgress(taskId, 30);
                const result = await ipcRenderer.invoke('shutdown-vm', selectedVM);
                updateTaskProgress(taskId, 100);
                
                if (!result.success) {
                    completeTask(taskId, false);
                    alert(`Shutdown failed: ${result.error}`);
                } else {
                    completeTask(taskId, true);
                    showNotification(`${selectedVM} is shutting down`, 'success');
                    refreshVMs();
                }
            } catch (error) {
                completeTask(taskId, false);
                console.error('Error shutting down VM:', error);
            }
        }
        
        async function turnOffVM() {
            if (!selectedVM) {
                alert('Please select a VM');
                return;
            }
        
            // Always confirm force turn off for safety
            if (!confirm(`FORCE turn off ${selectedVM}? This may cause data loss.`)) return;
        
            const taskId = createTask('Force Turn Off Virtual Machine', selectedVM);
            
            try {
                updateTaskProgress(taskId, 30);
                const result = await ipcRenderer.invoke('turnoff-vm', selectedVM);
                updateTaskProgress(taskId, 100);
                
                if (!result.success) {
                    completeTask(taskId, false);
                    alert(`Turn off failed: ${result.error}`);
                } else {
                    completeTask(taskId, true);
                    showNotification(`${selectedVM} has been turned off`, 'success');
                    refreshVMs();
                }
            } catch (error) {
                completeTask(taskId, false);
                console.error('Error turning off VM:', error);
            }
        }

        // Console into VM (opens VMConnect)
        async function consoleVM() {
            if (!selectedVM) {
                alert('Please select a VM to connect to');
                return;
            }
            
            try {
                setStatus(`Opening console for ${selectedVM}...`);
                const result = await ipcRenderer.invoke('launch-vmconnect', selectedVM);
                if (result.success) {
                    showNotification(`Console opened for ${selectedVM}`, 'success');
                    setStatus('Ready');
                } else {
                    alert(`Failed to open console: ${result.error || 'Unknown error'}`);
                    setStatus('Ready');
                }
            } catch (error) {
                console.error('Error opening VM console:', error);
                alert('Failed to open VM console');
                setStatus('Ready');
            }
        }
         
        // Browse ISO button
        const browseBtn = document.getElementById('browseISOButton');
        if (browseBtn) {
            browseBtn.addEventListener('click', browseForISO);
        }

        // Create VM Dialog
        const vmDialogButtons = {
            'closeCreateVM': hideCreateVMDialog,
            'cancelCreateVM': hideCreateVMDialog,
            'confirmCreateVM': createVM
        };
        
        for (const [id, handler] of Object.entries(vmDialogButtons)) {
            const btn = document.getElementById(id);
            if (btn) {
                btn.addEventListener('click', () => handler());
            }
        }
        
        // Memory and Disk sliders
        const memSlider = document.getElementById('vmMemory');
        if (memSlider) {
            memSlider.addEventListener('input', (e) => {
                const label = document.getElementById('memoryLabel');
                if (label) label.textContent = e.target.value;
            });
        }
        
        const diskSlider = document.getElementById('vmDisk');
        if (diskSlider) {
            diskSlider.addEventListener('input', (e) => {
                const label = document.getElementById('diskLabel');
                if (label) label.textContent = e.target.value;
            });
        }
        
        // VM table row selection
        const vmTableBody = document.getElementById('vmTableBody');
        if (vmTableBody) {
            vmTableBody.addEventListener('click', (e) => {
                const row = e.target.closest('tr');
                if (row && row.dataset.vmName) {
                    document.querySelectorAll('#vmTableBody tr').forEach(r => r.classList.remove('selected'));
                    row.classList.add('selected');
                    selectedVM = row.dataset.vmName;
                }
            });

            // Double-click to connect to VM
            vmTableBody.addEventListener('dblclick', async (e) => {
                const row = e.target.closest('tr');
                if (row && row.dataset.vmName) {
                    try {
                        await ipcRenderer.invoke('launch-vmconnect', row.dataset.vmName);
                    } catch (error) {
                        console.error('Error launching VMConnect:', error);
                    }
                }
            });
        }
        
        // AI Chat
        const chatSendBtn = document.getElementById('chatSendBtn');
        if (chatSendBtn) {
            chatSendBtn.addEventListener('click', () => sendAIMessage());
        }
        
        const chatClearBtn = document.getElementById('chatClearBtn');
        if (chatClearBtn) {
            chatClearBtn.addEventListener('click', () => clearChat());
        }
        
        const chatInput = document.getElementById('chatInput');
        if (chatInput) {
            chatInput.addEventListener('keypress', (e) => {
                if (e.key === 'Enter' && !e.shiftKey) {
                    e.preventDefault();
                    sendAIMessage();
                }
            });
        }

        // Storage event listeners
        setupStorageEventListeners();
        
        // Tasks panel event listeners
        setupTasksPanel();
        
    } catch (error) {
        console.error('Error setting up event listeners:', error);
    }
}

// Setup Storage Event Listeners
function setupStorageEventListeners() {
    try {
        // Storage category tabs
        document.querySelectorAll('.storage-category-tab').forEach(tab => {
            tab.addEventListener('click', (e) => {
                const category = e.currentTarget.dataset.category;
                if (category) switchStorageCategory(category);
            });
        });

        // Storage tabs
        document.querySelectorAll('.storage-tab').forEach(tab => {
            tab.addEventListener('click', (e) => {
                const tabName = e.currentTarget.dataset.tab;
                if (tabName) {
                    if (currentStorageCategory === 'host') {
                        switchHostStorageTab(tabName);
                    } else {
                        switchHypervStorageTab(tabName);
                    }
                }
            });
        });

        // Host Storage buttons
        const hostStorageButtons = {
            'refreshDisksBtn': refreshPhysicalDisks,
            'diskDetailsBtn': showDiskDetails,
            'optimizeBtn': optimizeDisk,
            'diskHealthBtn': checkDiskHealth,
            'refreshSANBtn': refreshSANStorage,
            'discoverSANBtn': discoverSANTargets,
            'sanPathsBtn': showSANPaths,
            'sanHealthBtn': checkSANHealth,
            'createPoolBtn': showCreatePoolDialog,
            'addDiskToPoolBtn': addDiskToPool,
            'removeFromPoolBtn': removeDiskFromPool,
            'refreshPoolsBtn': refreshStoragePools,
            'newVolumeBtn': showCreateVolumeDialog,
            'resizeVolumeBtn': resizeVolume,
            'formatVolumeBtn': formatVolume,
            'refreshVolumesBtn': refreshVolumes
        };

        // Hyper-V Storage buttons
        const hypervStorageButtons = {
            'createVHDBtn': showCreateVHDDialog,
            'attachVHDBtn': attachVHD,
            'detachVHDBtn': deleteVHD,  // Note: button says "Delete" but ID is "detachVHDBtn"
            'resizeVHDBtn': showResizeVHDDialog,
            'convertVHDBtn': showConvertVHDDialog,
            'compactVHDBtn': compactVHD,
            'refreshVHDBtn': refreshVirtualDisks,
            'addVMStoreBtn': addVMStore,
            'removeVMStoreBtn': removeVMStore,
            'migrateVMStoreBtn': migrateVMStore,
            'refreshVMStoresBtn': refreshVMStores,
            'cleanupCheckpointsBtn': cleanupCheckpoints,
            'mergeCheckpointsBtn': mergeCheckpoints,
            'exportCheckpointBtn': exportCheckpoint,
            'refreshCheckpointsBtn': refreshCheckpoints,
            'addISOBtn': addISO,
            'downloadISOBtn': downloadISO,
            'removeISOBtn': removeISO,
            'refreshISOBtn': refreshISOLibrary,
            'changeISOPathBtn': changeISOLibraryPath,
            'createQosPolicyBtn': showCreateQosDialog,
            'editQosPolicyBtn': editQosPolicy,
            'deleteQosPolicyBtn': deleteQosPolicy,
            'refreshQosBtn': refreshQosPolicies
        };

        // Attach all storage button handlers
        for (const [id, handler] of Object.entries({...hostStorageButtons, ...hypervStorageButtons})) {
            const btn = document.getElementById(id);
            if (btn) {
                btn.addEventListener('click', () => handler());
            }
        }

        // VHD Dialog events
        const vhdDialogButtons = {
            'closeCreateVHD': hideCreateVHDDialog,
            'cancelCreateVHD': hideCreateVHDDialog,
            'confirmCreateVHD': createVHD
        };

        for (const [id, handler] of Object.entries(vhdDialogButtons)) {
            const btn = document.getElementById(id);
            if (btn) {
                btn.addEventListener('click', () => handler());
            }
        }

        // Edit VM Dialog events
        const editVMDialogButtons = {
            'closeEditVM': hideEditVMDialog,
            'cancelEditVM': hideEditVMDialog,
            'confirmEditVM': saveEditVMChanges,
            'browseEditVMISO': browseEditVMISO,
            'clearEditVMISO': clearEditVMISO
        };

        for (const [id, handler] of Object.entries(editVMDialogButtons)) {
            const btn = document.getElementById(id);
            if (btn) {
                btn.addEventListener('click', () => handler());
            }
        }

        // Edit VM Memory slider
        const editVMMemorySlider = document.getElementById('editVMMemory');
        if (editVMMemorySlider) {
            editVMMemorySlider.addEventListener('input', (e) => {
                const label = document.getElementById('editVMMemoryLabel');
                if (label) label.textContent = e.target.value;
            });
        }

        // Snapshot Dialog events
        const snapshotDialogButtons = {
            'closeSnapshotDialog': hideSnapshotDialog,
            'cancelSnapshotDialog': hideSnapshotDialog,
            'confirmSnapshotAction': confirmSnapshotAction,
            'snapshotCreateBtn': () => setSnapshotAction('create'),
            'snapshotApplyBtn': () => setSnapshotAction('apply'),
            'snapshotDeleteBtn': () => setSnapshotAction('delete')
        };

        for (const [id, handler] of Object.entries(snapshotDialogButtons)) {
            const btn = document.getElementById(id);
            if (btn) {
                btn.addEventListener('click', () => handler());
            }
        }

        // VHD size slider
        const vhdSizeSlider = document.getElementById('vhdSize');
        if (vhdSizeSlider) {
            vhdSizeSlider.addEventListener('input', (e) => {
                const label = document.getElementById('vhdSizeLabel');
                if (label) label.textContent = e.target.value;
            });
        }

        // VHD table row selection
        const vhdTableBody = document.getElementById('vhdTableBody');
        if (vhdTableBody) {
            vhdTableBody.addEventListener('click', (e) => {
                const row = e.target.closest('tr');
                if (row && row.dataset.vhdPath) {
                    document.querySelectorAll('#vhdTableBody tr').forEach(r => r.classList.remove('selected'));
                    row.classList.add('selected');
                    selectedVHD = row.dataset.vhdPath;
                }
            });
        }
        
    } catch (error) {
        console.error('Error setting up storage event listeners:', error);
    }
}

// Sidebar Functions
function toggleSidebar() {
    sidebarExpanded = !sidebarExpanded;
    const sidebar = document.getElementById('sidebar');
    if (sidebar) {
        sidebar.classList.toggle('collapsed');
    }
}

// View Switching
function switchView(viewName) {
    currentView = viewName;
    
    // Update sidebar button active state
    document.querySelectorAll('.sidebar-btn').forEach(btn => {
        btn.classList.toggle('active', btn.dataset.view === viewName);
    });
    
    // Hide all views
    document.querySelectorAll('.content-view').forEach(view => {
        view.classList.add('hidden');
    });
    
    // Show selected view
    const viewMap = {
        'dashboard': 'dashboardView',
        'vms': 'vmsView',
        'storage': 'storageView',
        'ai': 'aiView',
        'clustering': 'clusteringView',
        'settings': 'settingsView'
    };
    
    const titleMap = {
        'dashboard': 'Dashboard',
        'vms': 'Virtual Machines',
        'storage': 'Storage Management',
        'ai': 'AI Assistant',
        'clustering': 'Clustering',
        'settings': 'Settings'
    };
    
    const viewElement = document.getElementById(viewMap[viewName]);
    if (viewElement) {
        viewElement.classList.remove('hidden');
    }
    
    const titleElement = document.getElementById('headerTitle');
    if (titleElement) {
        titleElement.textContent = titleMap[viewName] || viewName;
    }
    
    // Load data for specific views
    if (viewName === 'vms') {
        refreshVMs();
        addDiagnosticButton();
    } else if (viewName === 'storage') {
        initStorageView();
    } else if (viewName === 'clustering') {
        initClusterTools();
    } else if (viewName === 'settings') {
        initSettingsView();
    }
}

// Quick Actions
function handleQuickAction(action) {
    switch(action) {
        case 'create-vm':
        case 'manage-vms':
            switchView('vms');
            break;
        case 'storage':
            switchView('storage');
            break;
        case 'ai-assistant':
            switchView('ai');
            break;
        case 'clustering':
            switchView('clustering');
            break;
        case 'patching':
            switchView('patching');
            break;
    }
}

// Status Functions
function setStatus(text) {
    const statusElement = document.getElementById('headerStatus');
    if (statusElement) {
        statusElement.textContent = text;
    }
}

// Stats Loop with error handling
async function startStatsLoop() {
    setInterval(async () => {
        try {
            const stats = await ipcRenderer.invoke('get-system-stats');

            if (stats) {
                // Update history
                statsHistory.cpu.shift();
                statsHistory.cpu.push(stats.cpu || 0);
                statsHistory.memory.shift();
                statsHistory.memory.push(stats.memory || 0);
                statsHistory.disk.shift();
                statsHistory.disk.push(stats.disk || 0);
                statsHistory.network.shift();
                statsHistory.network.push(stats.network || 0);
                
                // Update graphs
                updateGraph('cpuCanvas', 'cpuValue', statsHistory.cpu, stats.cpu || 0, '%', '#0fb0e0ff');
                updateGraph('memCanvas', 'memValue', statsHistory.memory, stats.memory || 0, '%', '#f3ff4dff');
                updateGraph('diskCanvas', 'diskValue', statsHistory.disk, stats.disk || 0, '%', '#0be716ff');
                updateGraph('netCanvas', 'netValue', statsHistory.network, stats.network || 0, 'MB/s', '#f00e0eff');
            }
        } catch (error) {
            console.error('Error updating stats:', error);
        }
    }, 2000);
}

// Graph Drawing
function updateGraph(canvasId, valueId, history, currentValue, unit, color) {
    try {
        const canvas = document.getElementById(canvasId);
        if (!canvas) return;
        
        const ctx = canvas.getContext('2d');
        if (!ctx) return;
        
        const width = canvas.width = canvas.offsetWidth;
        const height = canvas.height = canvas.offsetHeight;
        
        // Clear canvas
        ctx.fillStyle = '#0f1419';
        ctx.fillRect(0, 0, width, height);
        
        // Draw graph
        ctx.strokeStyle = color;
        ctx.lineWidth = 2;
        ctx.beginPath();
        
        const step = width / (history.length - 1);
        const maxValue = Math.max(...history, 100);
        
        history.forEach((value, index) => {
            const x = index * step;
            const y = height - ((value || 0) / maxValue) * height;
            
            if (index === 0) {
                ctx.moveTo(x, y);
            } else {
                ctx.lineTo(x, y);
            }
        });
        
        ctx.stroke();
        
        // Update value display
        const valueElement = document.getElementById(valueId);
        if (valueElement) {
            valueElement.textContent = `${(currentValue || 0).toFixed(1)} ${unit}`;
        }
    } catch (error) {
        console.error('Error updating graph:', error);
    }
}

// VM Management Functions
async function refreshVMs() {
    const tbody = document.getElementById('vmTableBody');
    if (!tbody) return;
    
    setStatus('Loading VMs...');
    tbody.innerHTML = '<tr><td colspan="5" style="text-align: center; color: #8a8a8d;">Loading virtual machines...</td></tr>';
    
    try {
        const result = await ipcRenderer.invoke('get-vms');
        
        if (result && result.success) {
            const vms = result.vms || [];
            
            tbody.innerHTML = '';
            
            if (vms.length === 0) {
                tbody.innerHTML = '<tr><td colspan="5" style="text-align: center; color: #8a8a8d;">No virtual machines found</td></tr>';
                setStatus('No VMs found');
            } else {
                vms.forEach(vm => {
                    const row = document.createElement('tr');
                    row.dataset.vmName = vm.Name;

                    const memoryMB = vm.MemoryStartup ? Math.round(vm.MemoryStartup / 1024 / 1024) : 0;
                    const uptime = vm.Uptime || 'N/A';
                    const state = vm.State || 'Unknown';
                    const cpus = vm.ProcessorCount || 1;

                    row.innerHTML = `
                        <td>${escapeHtml(vm.Name)}</td>
                        <td style="color: ${state === 'Running' ? '#00ffaa' : '#8a8a8d'}">${state}</td>
                        <td>${cpus}</td>
                        <td>${memoryMB}</td>
                        <td>${uptime}</td>
                    `;

                    tbody.appendChild(row);
                });
                setStatus(`${vms.length} VM(s) loaded`);
            }
        } else {
            const errorMsg = result?.error || 'Unable to connect to Hyper-V';
            console.error('VM loading failed:', errorMsg);
            tbody.innerHTML = `
                <tr>
                    <td colspan="5" style="text-align: center; padding: 20px;">
                        <div style="color: #ff6b6b; margin-bottom: 10px;">Failed to load VMs</div>
                        <div style="color: #8a8a8d; font-size: 11px; line-height: 1.5;">
                            ${escapeHtml(errorMsg).replace(/\n/g, '<br>')}
                        </div>
                        <button onclick="refreshVMs()" style="margin-top: 10px; padding: 5px 10px; background: #1a1f26; border: 1px solid #00d9ff; color: #00d9ff; border-radius: 3px; cursor: pointer;">
                            Retry
                        </button>
                    </td>
                </tr>
            `;
            setStatus('Error loading VMs');
        }
    } catch (error) {
        console.error('Error in refreshVMs:', error);
        tbody.innerHTML = `
            <tr>
                <td colspan="5" style="text-align: center; padding: 20px;">
                    <div style="color: #ff6b6b; margin-bottom: 10px;">Error connecting to Hyper-V</div>
                    <div style="color: #8a8a8d; font-size: 11px;">
                        Please ensure:<br>
                        1. You are running as Administrator<br>
                        2. Hyper-V is installed and enabled<br>
                        3. Hyper-V services are running
                    </div>
                </td>
            </tr>
        `;
        setStatus('Connection error');
    }
}

// VM Operations
async function startVM() {
    if (!selectedVM) {
        alert('Please select a VM to start');
        return;
    }

    if (shouldConfirmAction() && !confirm(`Start VM: ${selectedVM}?`)) {
        return;
    }

    const taskId = createTask('Start Virtual Machine', selectedVM);
    setStatus(`Starting VM: ${selectedVM}...`);
    
    try {
        // Simulate progress
        updateTaskProgress(taskId, 20);
        updateTaskProgress(taskId, 50);
        const result = await ipcRenderer.invoke('start-vm', selectedVM);
        updateTaskProgress(taskId, 90);

        if (result && result.success) {
            updateTaskProgress(taskId, 100);
            completeTask(taskId, true);
            setStatus('VM started successfully');
            showNotification(`${selectedVM} started successfully`, 'success');
            setTimeout(() => refreshVMs(), 2000);
        } else {
            completeTask(taskId, false);
            const errorMsg = result?.error || 'Unknown error';
            alert(`Failed to start VM: ${errorMsg}`);
            setStatus('Failed to start VM');
        }
    } catch (error) {
        completeTask(taskId, false);
        console.error('Error starting VM:', error);
        setStatus('Error starting VM');
    }
}

async function stopVM() {
    if (!selectedVM) {
        alert('Please select a VM to stop');
        return;
    }

    if (shouldConfirmAction() && !confirm(`Are you sure you want to stop ${selectedVM}?`)) {
        return;
    }
    
    const taskId = createTask('Stop Virtual Machine', selectedVM);
    setStatus(`Stopping VM: ${selectedVM}...`);
    
    try {
        updateTaskProgress(taskId, 20);
        updateTaskProgress(taskId, 50);
        const result = await ipcRenderer.invoke('stop-vm', selectedVM);
        updateTaskProgress(taskId, 90);

        if (result && result.success) {
            updateTaskProgress(taskId, 100);
            completeTask(taskId, true);
            setStatus('VM stopped successfully');
            showNotification(`${selectedVM} stopped`, 'success');
            setTimeout(() => refreshVMs(), 2000);
        } else {
            completeTask(taskId, false);
            const errorMsg = result?.error || 'Unknown error';
            alert(`Failed to stop VM: ${errorMsg}`);
            setStatus('Failed to stop VM');
        }
    } catch (error) {
        completeTask(taskId, false);
        console.error('Error stopping VM:', error);
        setStatus('Error stopping VM');
    }
}

async function deleteVM() {
    if (!selectedVM) {
        alert('Please select a VM to delete');
        return;
    }

    // Always confirm delete for safety
    if (!confirm(`Are you sure you want to delete ${selectedVM}? This action cannot be undone.`)) {
        return;
    }
    
    const taskId = createTask('Delete Virtual Machine', selectedVM);
    setStatus(`Deleting VM: ${selectedVM}...`);
    
    try {
        updateTaskProgress(taskId, 10);
        const stopCmd = `Stop-VM -Name '${selectedVM}' -Force -ErrorAction SilentlyContinue`;
        await ipcRenderer.invoke('run-hyperv-cmd', stopCmd);
        updateTaskProgress(taskId, 40);
        
        const deleteCmd = `Remove-VM -Name '${selectedVM}' -Force -ErrorAction SilentlyContinue`;
        updateTaskProgress(taskId, 70);
        const result = await ipcRenderer.invoke('run-hyperv-cmd', deleteCmd);
        updateTaskProgress(taskId, 100);

        if (result && result.success) {
            completeTask(taskId, true);
            showNotification(`${selectedVM} deleted`, 'success');
            selectedVM = null;
            setStatus('VM deleted successfully');
            setTimeout(() => refreshVMs(), 1000);
        } else {
            completeTask(taskId, false);
            alert(`Failed to delete VM: ${result?.error || 'Unknown error'}`);
            setStatus('Failed to delete VM');
        }
    } catch (error) {
        completeTask(taskId, false);
        console.error('Error deleting VM:', error);
        setStatus('Error deleting VM');
    }
}

// Snapshot Management
let snapshotAction = null;
let snapshotList = [];
let selectedSnapshotIndex = null;

async function showSnapshotDialog() {
    if (!selectedVM) {
        alert('Please select a VM to manage snapshots');
        return;
    }
    
    // Reset state
    snapshotAction = null;
    selectedSnapshotIndex = null;
    
    // Update dialog
    const vmNameSpan = document.getElementById('snapshotVMName');
    if (vmNameSpan) vmNameSpan.textContent = selectedVM;
    
    // Hide snapshot name input
    const nameGroup = document.getElementById('snapshotNameGroup');
    if (nameGroup) nameGroup.style.display = 'none';
    
    // Hide confirm button
    const confirmBtn = document.getElementById('confirmSnapshotAction');
    if (confirmBtn) confirmBtn.style.display = 'none';
    
    // Load snapshots
    await loadSnapshotList();
    
    // Show dialog
    const dialog = document.getElementById('snapshotDialog');
    if (dialog) dialog.classList.remove('hidden');
}

function hideSnapshotDialog() {
    const dialog = document.getElementById('snapshotDialog');
    if (dialog) dialog.classList.add('hidden');
}

async function loadSnapshotList() {
    const container = document.getElementById('snapshotListContainer');
    if (!container) return;
    
    container.innerHTML = '<div style="color: #666; text-align: center; padding: 20px;">Loading snapshots...</div>';
    
    try {
        const result = await ipcRenderer.invoke('get-checkpoints');
        if (result.success && result.checkpoints) {
            snapshotList = result.checkpoints.filter(cp => cp.VMName === selectedVM);
            
            if (snapshotList.length === 0) {
                container.innerHTML = '<div style="color: #666; text-align: center; padding: 20px;">No snapshots found for this VM</div>';
                return;
            }
            
            container.innerHTML = snapshotList.map((cp, idx) => `
                <div class="snapshot-item" data-index="${idx}" style="padding: 10px; margin: 4px 0; background: rgba(0,217,255,0.05); border-radius: 6px; cursor: pointer; border: 2px solid transparent;" onmouseover="this.style.background='rgba(0,217,255,0.1)'" onmouseout="this.style.background=this.classList.contains('selected')?'rgba(0,217,255,0.15)':'rgba(0,217,255,0.05)'">
                    <div style="font-weight: 500; color: #fff;">${cp.Name}</div>
                    <div style="font-size: 11px; color: #888; margin-top: 4px;">Created: ${new Date(cp.CreationTime).toLocaleString()}</div>
                </div>
            `).join('');
            
            // Add click handlers for selection
            container.querySelectorAll('.snapshot-item').forEach(item => {
                item.addEventListener('click', () => {
                    container.querySelectorAll('.snapshot-item').forEach(i => {
                        i.classList.remove('selected');
                        i.style.borderColor = 'transparent';
                        i.style.background = 'rgba(0,217,255,0.05)';
                    });
                    item.classList.add('selected');
                    item.style.borderColor = '#00d9ff';
                    item.style.background = 'rgba(0,217,255,0.15)';
                    selectedSnapshotIndex = parseInt(item.dataset.index);
                    
                    // Show confirm button if we have an action
                    if (snapshotAction === 'apply' || snapshotAction === 'delete') {
                        const confirmBtn = document.getElementById('confirmSnapshotAction');
                        if (confirmBtn) confirmBtn.style.display = 'block';
                    }
                });
            });
        } else {
            container.innerHTML = '<div style="color: #666; text-align: center; padding: 20px;">No snapshots found</div>';
        }
    } catch (error) {
        console.error('Error loading snapshots:', error);
        container.innerHTML = '<div style="color: #ff6b6b; text-align: center; padding: 20px;">Error loading snapshots</div>';
    }
}

function setSnapshotAction(action) {
    snapshotAction = action;
    selectedSnapshotIndex = null;
    
    const nameGroup = document.getElementById('snapshotNameGroup');
    const confirmBtn = document.getElementById('confirmSnapshotAction');
    const container = document.getElementById('snapshotListContainer');
    
    // Reset selection
    if (container) {
        container.querySelectorAll('.snapshot-item').forEach(i => {
            i.classList.remove('selected');
            i.style.borderColor = 'transparent';
            i.style.background = 'rgba(0,217,255,0.05)';
        });
    }
    
    if (action === 'create') {
        if (nameGroup) nameGroup.style.display = 'block';
        if (confirmBtn) {
            confirmBtn.style.display = 'block';
            confirmBtn.textContent = 'Create Snapshot';
        }
    } else {
        if (nameGroup) nameGroup.style.display = 'none';
        if (confirmBtn) {
            confirmBtn.style.display = 'none';
            confirmBtn.textContent = action === 'apply' ? 'Apply Snapshot' : 'Delete Snapshot';
        }
    }
}

async function confirmSnapshotAction() {
    if (!snapshotAction) return;
    
    if (snapshotAction === 'create') {
        const nameInput = document.getElementById('snapshotNameInput');
        const snapshotName = nameInput?.value?.trim();
        if (!snapshotName) {
            alert('Please enter a snapshot name');
            return;
        }
        await createSnapshot(selectedVM, snapshotName);
        if (nameInput) nameInput.value = '';
        await loadSnapshotList();
        setSnapshotAction(null);
    } else if (snapshotAction === 'apply' && selectedSnapshotIndex !== null) {
        const snapshot = snapshotList[selectedSnapshotIndex];
        if (snapshot) {
            await applySnapshotById(snapshot);
            hideSnapshotDialog();
        }
    } else if (snapshotAction === 'delete' && selectedSnapshotIndex !== null) {
        const snapshot = snapshotList[selectedSnapshotIndex];
        if (snapshot && confirm(`Delete snapshot "${snapshot.Name}"?`)) {
            await deleteSnapshotByName(snapshot.Name);
            await loadSnapshotList();
            setSnapshotAction(null);
        }
    }
}

async function createSnapshot(vmName, snapshotName) {
    setStatus('Creating snapshot...');
    try {
        const result = await ipcRenderer.invoke('create-checkpoint', { vmName, checkpointName: snapshotName });
        if (result.success) {
            showNotification('Snapshot created successfully', 'success');
            setStatus('Ready');
        } else {
            alert(`Failed to create snapshot: ${result.error}`);
        }
    } catch (error) {
        console.error('Error creating snapshot:', error);
        alert('Error creating snapshot');
    }
}

async function applySnapshotById(snapshot) {
    setStatus('Applying snapshot...');
    try {
        const result = await ipcRenderer.invoke('apply-checkpoint', { 
            vmName: selectedVM, 
            checkpointId: snapshot.Id 
        });
        
        if (result.success) {
            showNotification('Snapshot applied successfully', 'success');
            setStatus('Ready');
            refreshVMs();
        } else {
            alert(`Failed to apply snapshot: ${result.error}`);
        }
    } catch (error) {
        console.error('Error applying snapshot:', error);
        alert('Error applying snapshot');
    }
}

async function deleteSnapshotByName(snapshotName) {
    setStatus('Deleting snapshot...');
    try {
        const result = await ipcRenderer.invoke('remove-checkpoint', { 
            vmName: selectedVM, 
            checkpointName: snapshotName 
        });
        
        if (result.success) {
            showNotification('Snapshot deleted successfully', 'success');
            setStatus('Ready');
        } else {
            alert(`Failed to delete snapshot: ${result.error}`);
        }
    } catch (error) {
        console.error('Error deleting snapshot:', error);
        alert('Error deleting snapshot');
    }
}

async function viewSnapshots() {
    // Just open the dialog - it shows all snapshots
    await showSnapshotDialog();
}

// Edit VM Settings
async function showEditVMDialog() {
    if (!selectedVM) {
        alert('Please select a VM to edit');
        return;
    }
    
    try {
        const result = await ipcRenderer.invoke('get-vm-details', selectedVM);
        if (!result.success) {
            alert('Failed to get VM details');
            return;
        }
        
        const vm = result.details;
        const memoryMB = Math.round((vm.MemoryStartup || 0) / 1024 / 1024);
        
        // Populate the dialog fields
        const nameInput = document.getElementById('editVMName');
        const cpuInput = document.getElementById('editVMCPUs');
        const memoryInput = document.getElementById('editVMMemory');
        const memoryLabel = document.getElementById('editVMMemoryLabel');
        const autoStartSelect = document.getElementById('editVMAutoStart');
        const isoInput = document.getElementById('editVMISO');
        const notesInput = document.getElementById('editVMNotes');
        
        if (nameInput) nameInput.value = vm.Name;
        if (cpuInput) cpuInput.value = vm.ProcessorCount || 2;
        if (memoryInput) {
            memoryInput.value = memoryMB || 2048;
            if (memoryLabel) memoryLabel.textContent = memoryMB || 2048;
        }
        if (autoStartSelect) autoStartSelect.value = vm.AutomaticStartAction || 'Nothing';
        if (isoInput) isoInput.value = vm.DvdDrivePath || '';
        if (notesInput) notesInput.value = vm.Notes || '';
        
        // Show the dialog
        const dialog = document.getElementById('editVMDialog');
        if (dialog) {
            dialog.classList.remove('hidden');
        }
    } catch (error) {
        console.error('Error editing VM:', error);
        alert('Error loading VM settings');
    }
}

function hideEditVMDialog() {
    const dialog = document.getElementById('editVMDialog');
    if (dialog) {
        dialog.classList.add('hidden');
    }
}

async function browseEditVMISO() {
    try {
        const result = await ipcRenderer.invoke('browse-for-iso');
        if (result) {
            const isoInput = document.getElementById('editVMISO');
            if (isoInput) isoInput.value = result;
        }
    } catch (error) {
        console.error('Error browsing for ISO:', error);
    }
}

function clearEditVMISO() {
    const isoInput = document.getElementById('editVMISO');
    if (isoInput) isoInput.value = '';
}

async function saveEditVMChanges() {
    const cpuInput = document.getElementById('editVMCPUs');
    const memoryInput = document.getElementById('editVMMemory');
    const autoStartSelect = document.getElementById('editVMAutoStart');
    const isoInput = document.getElementById('editVMISO');
    const notesInput = document.getElementById('editVMNotes');
    
    const settings = {};
    
    if (cpuInput && cpuInput.value) {
        settings.processorCount = parseInt(cpuInput.value);
    }
    if (memoryInput && memoryInput.value) {
        settings.memory = parseInt(memoryInput.value);
    }
    if (autoStartSelect && autoStartSelect.value) {
        settings.automaticStartAction = autoStartSelect.value;
    }
    if (isoInput) {
        settings.isoPath = isoInput.value || null; // null means remove ISO
    }
    if (notesInput) {
        settings.notes = notesInput.value;
    }
    
    hideEditVMDialog();
    await updateVMSettings(settings);
}

async function updateVMSettings(settings) {
    setStatus('Updating VM settings...');
    try {
        const result = await ipcRenderer.invoke('edit-vm', { 
            vmName: selectedVM, 
            settings 
        });
        
        if (result.success) {
            alert('VM settings updated successfully');
            setStatus('Ready');
            refreshVMs();
        } else {
            alert(`Failed to update VM settings: ${result.error}`);
            setStatus('Error updating settings');
        }
    } catch (error) {
        console.error('Error updating VM settings:', error);
        setStatus('Error');
    }
}

// VM Creation
function showCreateVMDialog() {
    const dialog = document.getElementById('createVMDialog');
    if (dialog) {
        dialog.classList.remove('hidden');
        loadVMStorageLocations();
    }
}

function hideCreateVMDialog() {
    const dialog = document.getElementById('createVMDialog');
    if (dialog) {
        dialog.classList.add('hidden');
    }
}

async function loadVMStorageLocations() {
    try {
        const select = document.getElementById('vmStorageLocation');
        if (!select) return;
        
        const result = await ipcRenderer.invoke('get-vm-stores');
        
        if (result && result.success && result.stores) {
            select.innerHTML = '';
            result.stores.forEach(store => {
                const option = document.createElement('option');
                option.value = store.path;
                option.textContent = `${store.name} (${store.freeSpaceGB}GB free)`;
                select.appendChild(option);
            });
        } else {
            select.innerHTML = '<option value="default">Default Location</option>';
        }
    } catch (error) {
        console.error('Error loading VM storage locations:', error);
    }
}

async function createVM() {
    const name = document.getElementById('vmName')?.value;
    const osType = document.getElementById('vmOSType')?.value;
    const memory = document.getElementById('vmMemory')?.value;
    const cpus = document.getElementById('vmCPUs')?.value;
    const diskSize = document.getElementById('vmDisk')?.value;
    const storageLocation = document.getElementById('vmStorageLocation')?.value;
    const isoPath = document.getElementById('vmISO')?.value;
    const enableNetwork = document.getElementById('vmNetwork')?.checked;

    if (!name) {
        alert('Please enter a VM name');
        return;
    }

    const taskId = createTask('Create Virtual Machine', name);
    setStatus('Creating VM...');
    hideCreateVMDialog();

    try {
        updateTaskProgress(taskId, 10);
        const generation = (osType?.includes('Windows 11') || osType?.includes('Windows Server 2022')) ? 2 : 1;
        const isLinux = osType?.includes('Ubuntu') || osType?.includes('Linux') || osType?.includes('Debian') || osType?.includes('CentOS');

        const vhdPath = storageLocation === 'default' 
            ? `C:\\ProgramData\\Microsoft\\Windows\\Virtual Hard Disks\\${name}.vhdx`
            : `${storageLocation}\\${name}\\${name}.vhdx`;

        updateTaskProgress(taskId, 20);
        
        // Build the VM creation command
        let cmd = `New-VM -Name '${name}' -Generation ${generation} -MemoryStartupBytes ${memory * 1024 * 1024} -NewVHDPath '${vhdPath}' -NewVHDSizeBytes ${diskSize * 1024 * 1024 * 1024};`;
        cmd += ` Set-VM -Name '${name}' -ProcessorCount ${cpus};`;
        
        if (enableNetwork) {
            cmd += ` Add-VMNetworkAdapter -VMName '${name}';`;
        }
        
        // Add DVD drive with ISO
        if (isoPath) {
            if (generation === 2) {
                // Gen 2: Add SCSI DVD drive and set path
                cmd += ` Add-VMDvdDrive -VMName '${name}' -Path '${isoPath}';`;
            } else {
                // Gen 1: Set IDE DVD drive path
                cmd += ` Set-VMDvdDrive -VMName '${name}' -Path '${isoPath}';`;
            }
        }
        
        // Configure boot order to boot from DVD first
        if (generation === 2) {
            // Gen 2: Disable Secure Boot for Linux, set DVD as first boot device
            if (isLinux) {
                cmd += ` Set-VMFirmware -VMName '${name}' -EnableSecureBoot Off;`;
            }
            // Set boot order: DVD first (if ISO attached)
            if (isoPath) {
                cmd += ` $dvd = Get-VMDvdDrive -VMName '${name}'; if($dvd) { Set-VMFirmware -VMName '${name}' -FirstBootDevice $dvd };`;
            }
        } else {
            // Gen 1: Set boot order to CD first
            cmd += ` Set-VMBios -VMName '${name}' -StartupOrder @('CD','IDE','LegacyNetworkAdapter','Floppy');`;
        }

        updateTaskProgress(taskId, 40);
        const result = await ipcRenderer.invoke('run-hyperv-cmd', cmd);
        updateTaskProgress(taskId, 90);

        if (result && result.success) {
            updateTaskProgress(taskId, 100);
            completeTask(taskId, true);
            setStatus('VM created successfully');
            showNotification(`${name} created successfully`, 'success');
            setTimeout(() => refreshVMs(), 2000);
            
            // Clear form
            const vmNameInput = document.getElementById('vmName');
            const vmISOInput = document.getElementById('vmISO');
            if (vmNameInput) vmNameInput.value = '';
            if (vmISOInput) vmISOInput.value = '';
        } else {
            completeTask(taskId, false);
            alert(`Failed to create VM: ${result?.error || 'Unknown error'}`);
            setStatus('Failed to create VM');
        }
    } catch (error) {
        completeTask(taskId, false);
        console.error('Error creating VM:', error);
        setStatus('Error creating VM');
    }
}

async function browseForISO() {
    try {
        const result = await ipcRenderer.invoke('browse-for-iso');
        if (result) {
            const isoInput = document.getElementById('vmISO');
            if (isoInput) isoInput.value = result;
        }
    } catch (error) {
        console.error('Error browsing for ISO:', error);
    }
}

// Storage Management Functions
function initStorageView() {
    switchStorageCategory('host');
}

function switchStorageCategory(category) {
    currentStorageCategory = category;
    
    // Update category tabs
    document.querySelectorAll('.storage-category-tab').forEach(tab => {
        tab.classList.remove('active');
    });
    const activeTab = document.querySelector(`.storage-category-tab[data-category="${category}"]`);
    if (activeTab) {
        activeTab.classList.add('active');
    }
    
    // Hide all category contents
    document.querySelectorAll('.storage-category-content').forEach(content => {
        content.classList.add('hidden');
    });
    
    // Show selected category content
    if (category === 'host') {
        const hostContent = document.getElementById('hostStorageContent');
        if (hostContent) {
            hostContent.classList.remove('hidden');
        }
        switchHostStorageTab('physical');
    } else {
        const hypervContent = document.getElementById('hypervStorageContent');
        if (hypervContent) {
            hypervContent.classList.remove('hidden');
        }
        switchHypervStorageTab('vhds');
    }
}

function switchHostStorageTab(tabName) {
    currentStorageTab = tabName;
    
    // Update tab buttons within host storage
    const hostContent = document.getElementById('hostStorageContent');
    if (hostContent) {
        hostContent.querySelectorAll('.storage-tab').forEach(tab => {
            tab.classList.remove('active');
        });
        const activeTab = hostContent.querySelector(`.storage-tab[data-tab="${tabName}"]`);
        if (activeTab) {
            activeTab.classList.add('active');
        }
    }
    
    // Hide all tab contents
    document.querySelectorAll('#hostStorageContent .storage-tab-content').forEach(content => {
        content.classList.add('hidden');
    });
    
    // Show selected tab content
    const tabMap = {
        'physical': 'physicalTab',
        'san': 'sanTab',
        'pools': 'poolsTab',
        'volumes': 'volumesTab'
    };
    
    const tabElement = document.getElementById(tabMap[tabName]);
    if (tabElement) {
        tabElement.classList.remove('hidden');
    }
    
    // Load data for the tab
    switch(tabName) {
        case 'physical':
            refreshPhysicalDisks();
            break;
        case 'san':
            refreshSANStorage();
            break;
        case 'pools':
            refreshStoragePools();
            break;
        case 'volumes':
            refreshVolumes();
            break;
    }
}

function switchHypervStorageTab(tabName) {
    currentHypervTab = tabName;
    
    // Update tab buttons within Hyper-V storage
    const hypervContent = document.getElementById('hypervStorageContent');
    if (hypervContent) {
        hypervContent.querySelectorAll('.storage-tab').forEach(tab => {
            tab.classList.remove('active');
        });
        const activeTab = hypervContent.querySelector(`.storage-tab[data-tab="${tabName}"]`);
        if (activeTab) {
            activeTab.classList.add('active');
        }
    }
    
    // Hide all tab contents
    document.querySelectorAll('#hypervStorageContent .storage-tab-content').forEach(content => {
        content.classList.add('hidden');
    });
    
    // Show selected tab content
    const tabMap = {
        'vhds': 'vhdsTab',
        'vmstores': 'vmstoresTab',
        'checkpoints': 'checkpointsTab',
        'iso': 'isoTab',
        'qos': 'qosTab'
    };
    
    const tabElement = document.getElementById(tabMap[tabName]);
    if (tabElement) {
        tabElement.classList.remove('hidden');
    }
    
    // Load data for the tab
    switch(tabName) {
        case 'vhds':
            refreshVirtualDisks();
            break;
        case 'vmstores':
            refreshVMStores();
            break;
        case 'checkpoints':
            refreshCheckpoints();
            break;
        case 'iso':
            refreshISOLibrary();
            break;
        case 'qos':
            refreshQosPolicies();
            break;
    }
}

// Physical Disks Functions
async function refreshPhysicalDisks() {
    const container = document.getElementById('physicalDisksList');
    if (!container) return;
    
    container.innerHTML = '<div style="color: #8a8a8d; padding: 20px;">Loading physical disks...</div>';
    
    try {
        const result = await ipcRenderer.invoke('get-physical-disks');
        
        if (result.success && result.disks.length > 0) {
            container.innerHTML = '';
            
            result.disks.forEach(disk => {
                const sizeGB = (disk.Size / (1024 ** 3)).toFixed(2);
                const freeGB = (disk.FreeSpace / (1024 ** 3)).toFixed(2);
                const usedPercent = disk.Size > 0 ? ((disk.Size - disk.FreeSpace) / disk.Size * 100).toFixed(1) : 0;
                
                const diskCard = document.createElement('div');
                diskCard.className = 'disk-card';
                diskCard.innerHTML = `
                    <h4>Disk ${disk.DeviceID}: ${escapeHtml(disk.FriendlyName)}</h4>
                    <div class="disk-info">
                        <span>Type: ${disk.MediaType || 'Unknown'}</span>
                        <span>Bus: ${disk.BusType || 'Unknown'}</span>
                        <span>Health: <span style="color: ${disk.HealthStatus === 'Healthy' ? '#00ffaa' : '#ff6b6b'}">${disk.HealthStatus}</span></span>
                    </div>
                    <div class="disk-usage">
                        <div class="disk-usage-bar">
                            <div class="disk-usage-fill" style="width: ${usedPercent}%"></div>
                        </div>
                        <div class="disk-usage-text">${freeGB} GB free of ${sizeGB} GB</div>
                    </div>
                `;
                container.appendChild(diskCard);
            });
        } else {
            container.innerHTML = '<div style="color: #8a8a8d; padding: 20px;">No physical disks found or unable to access disk information</div>';
        }
    } catch (error) {
        console.error('Error refreshing physical disks:', error);
        container.innerHTML = '<div style="color: #ff6b6b; padding: 20px;">Error loading physical disks</div>';
    }
}

async function showDiskDetails() {
    try {
        const result = await ipcRenderer.invoke('get-physical-disks');
        if (result.success && result.disks.length > 0) {
            const diskList = result.disks.map(d => 
                `Disk ${d.DeviceID}: ${d.FriendlyName}\n` +
                `  • Media: ${d.MediaType}\n` +
                `  • Bus: ${d.BusType}\n` +
                `  • Size: ${(d.Size / (1024 ** 3)).toFixed(2)} GB\n` +
                `  • Health: ${d.HealthStatus}\n` +
                `  • Status: ${d.OperationalStatus}`
            ).join('\n\n');
            
            alert(`Physical Disk Details:\n\n${diskList}`);
        }
    } catch (error) {
        alert('Error getting disk details');
    }
}

async function optimizeDisk() {
    const drive = prompt('Enter drive letter to optimize (e.g., C):');
    if (drive && /^[A-Z]$/i.test(drive)) {
        setStatus('Starting disk optimization...');
        try {
            const result = await ipcRenderer.invoke('optimize-disk', drive.toUpperCase());
            if (result.success) {
                alert(`Disk optimization started for drive ${drive.toUpperCase()}:\nThis may take several minutes.`);
                setStatus('Optimization running in background');
            } else {
                alert(`Failed to start optimization: ${result.error}`);
            }
        } catch (error) {
            alert('Error starting disk optimization');
        }
    } else {
        alert('Invalid drive letter');
    }
}

async function checkDiskHealth() {
    setStatus('Checking disk health...');
    try {
        const result = await ipcRenderer.invoke('check-disk-health');
        if (result.success && result.healthData.length > 0) {
            const healthInfo = result.healthData.map(disk => 
                `${disk.FriendlyName}:\n` +
                `  • Health: ${disk.HealthStatus}\n` +
                `  • Temperature: ${disk.Temperature !== 'N/A' ? disk.Temperature + '°C' : 'N/A'}\n` +
                `  • Power-On Hours: ${disk.PowerOnHours !== 'N/A' ? disk.PowerOnHours : 'N/A'}\n` +
                `  • Wear Level: ${disk.Wear !== 'N/A' ? disk.Wear + '%' : 'N/A'}\n` +
                `  • Read Errors: ${disk.ReadErrorsTotal !== 'N/A' ? disk.ReadErrorsTotal : '0'}\n` +
                `  • Write Errors: ${disk.WriteErrorsTotal !== 'N/A' ? disk.WriteErrorsTotal : '0'}`
            ).join('\n\n');
            
            alert(`Disk Health Report:\n\n${healthInfo}`);
            setStatus('Ready');
        } else {
            alert('Unable to retrieve disk health information');
            setStatus('Health check failed');
        }
    } catch (error) {
        console.error('Error checking disk health:', error);
        alert('Error checking disk health');
        setStatus('Error');
    }
}

// SAN Storage Functions
async function refreshSANStorage() {
    const container = document.getElementById('sanStorageList');
    if (!container) return;
    
    container.innerHTML = '<div style="color: #888; text-align: center; padding: 40px;">Scanning for SAN storage devices...</div>';
    setStatus('Scanning SAN storage...');
    
    try {
        // Get iSCSI targets
        const iscsiResult = await ipcRenderer.invoke('execute-powershell', 
            'Get-IscsiTarget -ErrorAction SilentlyContinue | Select-Object NodeAddress, IsConnected, NumberOfConnections | ConvertTo-Json');
        
        // Get iSCSI sessions
        const sessionsResult = await ipcRenderer.invoke('execute-powershell',
            'Get-IscsiSession -ErrorAction SilentlyContinue | Select-Object TargetNodeAddress, InitiatorPortalAddress, TargetPortalAddress, IsConnected, IsPersistent, NumberOfConnections | ConvertTo-Json');
        
        // Get MPIO paths
        const mpioResult = await ipcRenderer.invoke('execute-powershell',
            'Get-MSDSMSupportedHW -ErrorAction SilentlyContinue | ConvertTo-Json');
        
        // Get Fibre Channel HBAs
        const fcResult = await ipcRenderer.invoke('execute-powershell',
            'Get-InitiatorPort -ErrorAction SilentlyContinue | Where-Object {$_.ConnectionType -eq "Fibre Channel"} | Select-Object NodeAddress, PortAddress, ConnectionType, OperationalStatus | ConvertTo-Json');
        
        // Get SAN disks (disks connected via iSCSI or FC)
        const sanDisksResult = await ipcRenderer.invoke('execute-powershell',
            'Get-Disk | Where-Object {$_.BusType -eq "iSCSI" -or $_.BusType -eq "Fibre Channel" -or $_.BusType -eq "SAS"} | Select-Object Number, FriendlyName, BusType, Size, HealthStatus, OperationalStatus | ConvertTo-Json');
        
        let iscsiTargets = [];
        let sessions = [];
        let fcPorts = [];
        let sanDisks = [];
        let mpioHW = [];
        
        if (iscsiResult.success && iscsiResult.output) {
            try { 
                const parsed = JSON.parse(iscsiResult.output);
                iscsiTargets = Array.isArray(parsed) ? parsed : [parsed];
            } catch(e) {}
        }
        
        if (sessionsResult.success && sessionsResult.output) {
            try {
                const parsed = JSON.parse(sessionsResult.output);
                sessions = Array.isArray(parsed) ? parsed : [parsed];
            } catch(e) {}
        }
        
        if (fcResult.success && fcResult.output) {
            try {
                const parsed = JSON.parse(fcResult.output);
                fcPorts = Array.isArray(parsed) ? parsed : [parsed];
            } catch(e) {}
        }
        
        if (sanDisksResult.success && sanDisksResult.output) {
            try {
                const parsed = JSON.parse(sanDisksResult.output);
                sanDisks = Array.isArray(parsed) ? parsed : [parsed];
            } catch(e) {}
        }
        
        if (mpioResult.success && mpioResult.output) {
            try {
                const parsed = JSON.parse(mpioResult.output);
                mpioHW = Array.isArray(parsed) ? parsed : [parsed];
            } catch(e) {}
        }
        
        // Update stat cards
        const iscsiCount = document.getElementById('sanIscsiCount');
        const fcCount = document.getElementById('sanFcCount');
        const lunCount = document.getElementById('sanLunCount');
        const mpioCount = document.getElementById('sanMpioCount');
        
        if (iscsiCount) iscsiCount.textContent = sessions.length || '0';
        if (fcCount) fcCount.textContent = fcPorts.length || '0';
        if (lunCount) lunCount.textContent = sanDisks.length || '0';
        if (mpioCount) mpioCount.textContent = mpioHW.length || '0';
        
        // Build display
        let html = '';
        
        // iSCSI Sessions Section
        if (sessions.length > 0) {
            html += `
                <div style="margin-bottom: 20px;">
                    <h4 style="color: #00d9ff; margin-bottom: 12px; border-bottom: 1px solid rgba(0,217,255,0.2); padding-bottom: 8px;">🌐 iSCSI Sessions</h4>
                    <div style="display: grid; gap: 8px;">
            `;
            sessions.forEach(s => {
                html += `
                    <div style="background: rgba(0,217,255,0.05); padding: 12px; border-radius: 8px; border-left: 3px solid ${s.IsConnected ? '#00ffaa' : '#ff6b6b'};">
                        <div style="font-weight: 500; color: #fff; margin-bottom: 4px;">${s.TargetNodeAddress || 'Unknown Target'}</div>
                        <div style="font-size: 12px; color: #888;">
                            Portal: ${s.TargetPortalAddress || 'N/A'} | 
                            Status: <span style="color: ${s.IsConnected ? '#00ffaa' : '#ff6b6b'}">${s.IsConnected ? 'Connected' : 'Disconnected'}</span> |
                            Persistent: ${s.IsPersistent ? 'Yes' : 'No'}
                        </div>
                    </div>
                `;
            });
            html += '</div></div>';
        }
        
        // Fibre Channel Section
        if (fcPorts.length > 0) {
            html += `
                <div style="margin-bottom: 20px;">
                    <h4 style="color: #00d9ff; margin-bottom: 12px; border-bottom: 1px solid rgba(0,217,255,0.2); padding-bottom: 8px;">🔵 Fibre Channel Ports</h4>
                    <div style="display: grid; gap: 8px;">
            `;
            fcPorts.forEach(p => {
                html += `
                    <div style="background: rgba(0,217,255,0.05); padding: 12px; border-radius: 8px; border-left: 3px solid ${p.OperationalStatus === 'Up' ? '#00ffaa' : '#ff6b6b'};">
                        <div style="font-weight: 500; color: #fff; margin-bottom: 4px;">WWN: ${p.NodeAddress || 'Unknown'}</div>
                        <div style="font-size: 12px; color: #888;">
                            Port: ${p.PortAddress || 'N/A'} | 
                            Status: <span style="color: ${p.OperationalStatus === 'Up' ? '#00ffaa' : '#ff6b6b'}">${p.OperationalStatus || 'Unknown'}</span>
                        </div>
                    </div>
                `;
            });
            html += '</div></div>';
        }
        
        // SAN Disks Section
        if (sanDisks.length > 0) {
            html += `
                <div style="margin-bottom: 20px;">
                    <h4 style="color: #00d9ff; margin-bottom: 12px; border-bottom: 1px solid rgba(0,217,255,0.2); padding-bottom: 8px;">💾 SAN LUNs / Disks</h4>
                    <div style="display: grid; gap: 8px;">
            `;
            sanDisks.forEach(d => {
                const sizeGB = d.Size ? (d.Size / (1024 ** 3)).toFixed(2) : '0';
                html += `
                    <div style="background: rgba(0,217,255,0.05); padding: 12px; border-radius: 8px; border-left: 3px solid ${d.HealthStatus === 'Healthy' ? '#00ffaa' : '#ff6b6b'};">
                        <div style="font-weight: 500; color: #fff; margin-bottom: 4px;">Disk ${d.Number}: ${d.FriendlyName || 'SAN Disk'}</div>
                        <div style="font-size: 12px; color: #888;">
                            Bus: ${d.BusType || 'Unknown'} | 
                            Size: ${sizeGB} GB |
                            Health: <span style="color: ${d.HealthStatus === 'Healthy' ? '#00ffaa' : '#ff6b6b'}">${d.HealthStatus || 'Unknown'}</span>
                        </div>
                    </div>
                `;
            });
            html += '</div></div>';
        }
        
        if (!html) {
            html = `
                <div style="text-align: center; padding: 40px; color: #888;">
                    <div style="font-size: 48px; margin-bottom: 16px;">💾</div>
                    <h3 style="color: #fff; margin-bottom: 8px;">No SAN Storage Detected</h3>
                    <p>No iSCSI targets, Fibre Channel HBAs, or SAN disks were found.</p>
                    <p style="margin-top: 12px;">To connect to SAN storage:</p>
                    <ul style="text-align: left; display: inline-block; margin-top: 8px;">
                        <li>Configure iSCSI Initiator in Server Manager</li>
                        <li>Install Fibre Channel HBA drivers</li>
                        <li>Configure MPIO for multipath I/O</li>
                    </ul>
                </div>
            `;
        }
        
        container.innerHTML = html;
        setStatus('Ready');
        
    } catch (error) {
        console.error('Error refreshing SAN storage:', error);
        container.innerHTML = '<div style="color: #ff6b6b; text-align: center; padding: 40px;">Error scanning SAN storage</div>';
        setStatus('Error');
    }
}

async function discoverSANTargets() {
    setStatus('Discovering SAN targets...');
    
    const dialogHtml = `
        <div class="dialog-overlay" id="sanDiscoverModal" style="display: flex; position: fixed; top: 0; left: 0; right: 0; bottom: 0; background: rgba(0,0,0,0.7); z-index: 9999; align-items: center; justify-content: center;">
            <div class="dialog" style="background: #1a1f26; padding: 24px; border-radius: 12px; min-width: 400px;">
                <h3 style="margin: 0 0 16px 0; color: #fff;">Discover iSCSI Targets</h3>
                <div class="form-group" style="margin-bottom: 16px;">
                    <label style="display: block; margin-bottom: 8px; color: #888;">Target Portal Address:</label>
                    <input type="text" id="sanTargetPortal" class="form-input" style="width: 100%; padding: 10px; background: #0f1419; border: 1px solid #333; border-radius: 6px; color: #fff;" placeholder="e.g., 192.168.1.100">
                </div>
                <div class="form-group" style="margin-bottom: 16px;">
                    <label style="display: block; margin-bottom: 8px; color: #888;">Port (default 3260):</label>
                    <input type="number" id="sanTargetPort" class="form-input" style="width: 100%; padding: 10px; background: #0f1419; border: 1px solid #333; border-radius: 6px; color: #fff;" value="3260">
                </div>
                <div style="display: flex; gap: 12px; justify-content: flex-end;">
                    <button onclick="document.getElementById('sanDiscoverModal').remove(); setStatus('Ready');" style="padding: 10px 20px; background: #333; border: none; border-radius: 6px; color: #fff; cursor: pointer;">Cancel</button>
                    <button onclick="executeSANDiscovery()" style="padding: 10px 20px; background: #00d9ff; border: none; border-radius: 6px; color: #000; cursor: pointer; font-weight: 500;">Discover</button>
                </div>
            </div>
        </div>
    `;
    document.body.insertAdjacentHTML('beforeend', dialogHtml);
}

async function executeSANDiscovery() {
    const portal = document.getElementById('sanTargetPortal')?.value;
    const port = document.getElementById('sanTargetPort')?.value || '3260';
    
    if (!portal) {
        alert('Please enter a target portal address');
        return;
    }
    
    document.getElementById('sanDiscoverModal')?.remove();
    setStatus(`Discovering targets at ${portal}...`);
    
    try {
        // Discover targets
        const discoverCmd = `New-IscsiTargetPortal -TargetPortalAddress '${portal}' -TargetPortalPortNumber ${port} -ErrorAction Stop`;
        const result = await ipcRenderer.invoke('execute-powershell', discoverCmd);
        
        if (result.success) {
            // Get discovered targets
            const targetsCmd = `Get-IscsiTarget | Select-Object NodeAddress, IsConnected | ConvertTo-Json`;
            const targetsResult = await ipcRenderer.invoke('execute-powershell', targetsCmd);
            
            showNotification(`Successfully discovered targets at ${portal}`, 'success');
            await refreshSANStorage();
        } else {
            alert(`Discovery failed: ${result.error || 'Unknown error'}`);
        }
    } catch (error) {
        alert(`Error discovering targets: ${error.message}`);
    }
    setStatus('Ready');
}

async function showSANPaths() {
    setStatus('Getting MPIO paths...');
    
    try {
        const result = await ipcRenderer.invoke('execute-powershell',
            'mpclaim -s -d 2>&1; Get-MPIOSetting 2>&1 | Out-String');
        
        let info = 'MPIO Path Information:\n\n';
        
        if (result.success && result.output) {
            info += result.output;
        } else {
            info += 'MPIO may not be installed or no multipath disks are present.\n\n';
            info += 'To install MPIO:\n';
            info += '1. Open Server Manager\n';
            info += '2. Add Roles and Features\n';
            info += '3. Select "Multipath I/O" feature\n';
        }
        
        alert(info);
    } catch (error) {
        alert('Error getting MPIO information');
    }
    setStatus('Ready');
}

async function checkSANHealth() {
    setStatus('Checking SAN health...');
    
    try {
        // Check iSCSI service
        const iscsiService = await ipcRenderer.invoke('execute-powershell',
            'Get-Service -Name MSiSCSI -ErrorAction SilentlyContinue | Select-Object Status, StartType | ConvertTo-Json');
        
        // Check iSCSI sessions health
        const sessionsHealth = await ipcRenderer.invoke('execute-powershell',
            'Get-IscsiSession -ErrorAction SilentlyContinue | Select-Object IsConnected, NumberOfConnections | ConvertTo-Json');
        
        let healthReport = '🏥 SAN Health Report\n\n';
        
        // iSCSI Service Status
        if (iscsiService.success && iscsiService.output) {
            try {
                const svc = JSON.parse(iscsiService.output);
                const status = svc.Status === 4 ? 'Running' : 'Stopped';
                healthReport += `iSCSI Initiator Service: ${status}\n`;
                healthReport += `Start Type: ${svc.StartType === 2 ? 'Automatic' : 'Manual'}\n\n`;
            } catch(e) {
                healthReport += 'iSCSI Service: Not installed\n\n';
            }
        } else {
            healthReport += 'iSCSI Service: Not available\n\n';
        }
        
        // Sessions Health
        if (sessionsHealth.success && sessionsHealth.output) {
            try {
                const sessions = JSON.parse(sessionsHealth.output);
                const sessionArr = Array.isArray(sessions) ? sessions : [sessions];
                const connected = sessionArr.filter(s => s.IsConnected).length;
                const total = sessionArr.length;
                healthReport += `iSCSI Sessions: ${connected}/${total} connected\n`;
            } catch(e) {
                healthReport += 'iSCSI Sessions: None\n';
            }
        } else {
            healthReport += 'iSCSI Sessions: None active\n';
        }
        
        healthReport += '\n✅ Health check complete';
        
        alert(healthReport);
    } catch (error) {
        alert('Error checking SAN health');
    }
    setStatus('Ready');
}

// Storage Pools Functions
async function refreshStoragePools() {
    const container = document.getElementById('storagePoolsList');
    if (!container) return;
    
    container.innerHTML = '<div style="color: #8a8a8d; padding: 20px;">Loading storage pools...</div>';
    
    try {
        const result = await ipcRenderer.invoke('get-storage-pools');
        
        if (result.success && result.pools.length > 0) {
            container.innerHTML = '';
            
            result.pools.forEach(pool => {
                const sizeGB = (pool.Size / (1024 ** 3)).toFixed(2);
                const allocatedGB = (pool.AllocatedSize / (1024 ** 3)).toFixed(2);
                const usedPercent = pool.Size > 0 ? (pool.AllocatedSize / pool.Size * 100).toFixed(1) : 0;
                
                const poolCard = document.createElement('div');
                poolCard.className = 'pool-card';
                poolCard.innerHTML = `
                    <h4>${escapeHtml(pool.FriendlyName)}</h4>
                    <div class="pool-info">
                        <span>Health: <span style="color: ${pool.HealthStatus === 'Healthy' ? '#00ffaa' : '#ff6b6b'}">${pool.HealthStatus}</span></span>
                        <span>Disks: ${pool.PhysicalDisks}</span>
                        <span>Resiliency: ${pool.ResiliencySettingName || 'None'}</span>
                    </div>
                    <div class="disk-usage">
                        <div class="disk-usage-bar">
                            <div class="disk-usage-fill" style="width: ${usedPercent}%"></div>
                        </div>
                        <div class="disk-usage-text">${allocatedGB} GB allocated of ${sizeGB} GB</div>
                    </div>
                `;
                container.appendChild(poolCard);
            });
        } else {
            container.innerHTML = '<div style="color: #8a8a8d; padding: 20px;">No storage pools found</div>';
        }
    } catch (error) {
        console.error('Error refreshing storage pools:', error);
        container.innerHTML = '<div style="color: #ff6b6b; padding: 20px;">Error loading storage pools</div>';
    }
}

function showCreatePoolDialog() {
    const name = prompt('Enter pool name:');
    if (name) {
        alert('To create a storage pool:\n\n1. Open Server Manager\n2. Go to File and Storage Services\n3. Select Storage Pools\n4. Create a new pool with available disks\n\nNote: Creating pools requires specific disk configurations.');
    }
}

function addDiskToPool() {
    alert('To add disks to a pool:\n\n1. Select the pool in Server Manager\n2. Add Physical Disk from the Tasks menu\n3. Select available disks to add');
}

function removeDiskFromPool() {
    alert('To remove disks from a pool:\n\n1. Select the disk in Server Manager\n2. Remove from the Tasks menu\n3. Wait for data to be moved to other disks');
}

// Volumes Functions
async function refreshVolumes() {
    const container = document.getElementById('volumesList');
    if (!container) return;
    
    container.innerHTML = '<div style="color: #8a8a8d; padding: 20px;">Loading volumes...</div>';
    
    try {
        const result = await ipcRenderer.invoke('get-volumes');
        
        if (result.success && result.volumes.length > 0) {
            container.innerHTML = '';
            
            result.volumes.forEach(volume => {
                const sizeGB = (volume.Size / (1024 ** 3)).toFixed(2);
                const freeGB = (volume.SizeRemaining / (1024 ** 3)).toFixed(2);
                const usedPercent = volume.Size > 0 ? ((volume.Size - volume.SizeRemaining) / volume.Size * 100).toFixed(1) : 0;
                
                const volumeCard = document.createElement('div');
                volumeCard.className = 'volume-card';
                volumeCard.innerHTML = `
                    <h4>Drive ${volume.DriveLetter}: ${volume.FileSystemLabel || 'Local Disk'}</h4>
                    <div class="volume-info">
                        <span>File System: ${volume.FileSystem}</span>
                        <span>Type: ${volume.DriveType}</span>
                        <span>Health: <span style="color: ${volume.HealthStatus === 'Healthy' ? '#00ffaa' : '#ff6b6b'}">${volume.HealthStatus}</span></span>
                    </div>
                    <div class="disk-usage">
                        <div class="disk-usage-bar">
                            <div class="disk-usage-fill" style="width: ${usedPercent}%"></div>
                        </div>
                        <div class="disk-usage-text">${freeGB} GB free of ${sizeGB} GB</div>
                    </div>
                `;
                container.appendChild(volumeCard);
            });
        } else {
            container.innerHTML = '<div style="color: #8a8a8d; padding: 20px;">No volumes found</div>';
        }
    } catch (error) {
        console.error('Error refreshing volumes:', error);
        container.innerHTML = '<div style="color: #ff6b6b; padding: 20px;">Error loading volumes</div>';
    }
}

function showCreateVolumeDialog() {
    alert('To create a new volume:\n\n1. Open Disk Management (diskmgmt.msc)\n2. Right-click unallocated space\n3. Select "New Simple Volume"\n4. Follow the wizard');
}

function resizeVolume() {
    alert('To resize a volume:\n\n1. Open Disk Management\n2. Right-click the volume\n3. Select "Extend Volume" or "Shrink Volume"\n4. Follow the wizard\n\nNote: You can only extend into unallocated space');
}

function formatVolume() {
    const drive = prompt('Enter drive letter to format (WARNING: This will erase all data):');
    if (drive) {
        alert(`To format drive ${drive}:

1. Open Disk Management
2. Right-click drive ${drive}
3. Select "Format"
4. Choose file system and allocation unit size

WARNING: This will erase all data!`);
    }
}

// Virtual Disks (VHDs) Functions
async function refreshVirtualDisks() {
    const tbody = document.getElementById('vhdTableBody');
    if (!tbody) return;
    
    tbody.innerHTML = '<tr><td colspan="7" style="text-align: center; color: #8a8a8d;">Loading virtual disks...</td></tr>';
    
    try {
        const result = await ipcRenderer.invoke('get-virtual-disks');
        
        if (result.success && result.vhds.length > 0) {
            tbody.innerHTML = '';
            
            result.vhds.forEach(vhd => {
                const row = document.createElement('tr');
                row.dataset.vhdPath = vhd.Path;
                
                const sizeGB = (vhd.Size / (1024 ** 3)).toFixed(2);
                const fileSizeGB = (vhd.FileSize / (1024 ** 3)).toFixed(2);
                
                row.innerHTML = `
                    <td>${escapeHtml(vhd.Name)}</td>
                    <td title="${escapeHtml(vhd.Path)}">${escapeHtml(vhd.Path.substring(0, 30))}...</td>
                    <td>${sizeGB}</td>
                    <td>${fileSizeGB}</td>
                    <td>${vhd.VhdType}</td>
                    <td style="color: ${vhd.AttachedTo !== 'Not Attached' ? '#00ffaa' : '#8a8a8d'}">${vhd.AttachedTo}</td>
                    <td>${vhd.VhdFormat}</td>
                `;
                
                tbody.appendChild(row);
            });
        } else {
            tbody.innerHTML = '<tr><td colspan="7" style="text-align: center; color: #8a8a8d;">No virtual disks found</td></tr>';
        }
    } catch (error) {
        console.error('Error refreshing virtual disks:', error);
        tbody.innerHTML = '<tr><td colspan="7" style="text-align: center; color: #ff6b6b;">Error loading virtual disks</td></tr>';
    }
}

function showCreateVHDDialog() {
    const dialog = document.getElementById('createVHDDialog');
    if (dialog) {
        dialog.classList.remove('hidden');
    }
}

function hideCreateVHDDialog() {
    const dialog = document.getElementById('createVHDDialog');
    if (dialog) {
        dialog.classList.add('hidden');
    }
}

async function createVHD() {
    const name = document.getElementById('vhdName')?.value;
    const format = document.getElementById('vhdFormat')?.value;
    const type = document.getElementById('vhdType')?.value;
    const size = document.getElementById('vhdSize')?.value;
    const blockSize = document.getElementById('vhdBlockSize')?.value;
    
    if (!name) {
        alert('Please enter a VHD name');
        return;
    }
    
    const fileName = name.endsWith(`.${format.toLowerCase()}`) ? name : `${name}.${format.toLowerCase()}`;
    const sizeBytes = size * 1024 * 1024 * 1024;
    
    const taskId = createTask('Create Virtual Hard Disk', fileName);
    setStatus('Creating VHD...');
    hideCreateVHDDialog();
    
    try {
        updateTaskProgress(taskId, 10);
        const storeResult = await ipcRenderer.invoke('get-vm-stores');
        const defaultPath = storeResult.stores[0]?.path || 'C:\\ProgramData\\Microsoft\\Windows\\Virtual Hard Disks';
        
        updateTaskProgress(taskId, 30);
        const result = await ipcRenderer.invoke('create-vhd', {
            name: fileName,
            path: defaultPath,
            size: sizeBytes,
            type: type,
            format: format,
            blockSize: blockSize
        });
        updateTaskProgress(taskId, 90);
        
        if (result.success) {
            updateTaskProgress(taskId, 100);
            completeTask(taskId, true);
            showNotification('VHD created successfully', 'success');
            setStatus('VHD created');
            refreshVirtualDisks();
        } else {
            completeTask(taskId, false);
            alert(`Failed to create VHD: ${result.error}`);
            setStatus('Failed to create VHD');
        }
    } catch (error) {
        completeTask(taskId, false);
        console.error('Error creating VHD:', error);
        alert('Error creating VHD');
        setStatus('Error');
    }
}

async function attachVHD() {
    if (!selectedVHD) {
        alert('Please select a VHD to attach');
        return;
    }
    
    setStatus('Attaching VHD...');
    try {
        const result = await ipcRenderer.invoke('attach-vhd', selectedVHD);
        if (result.success) {
            alert('VHD attached successfully');
            setStatus('Ready');
            refreshVirtualDisks();
        } else {
            alert(`Failed to attach VHD: ${result.error}`);
        }
    } catch (error) {
        alert('Error attaching VHD');
    }
}

async function deleteVHD() {
    if (!selectedVHD) {
        alert('Please select a VHD to delete');
        return;
    }
    
    // Add confirmation dialog for safety
    if (!confirm(`Are you sure you want to delete this VHD?

${selectedVHD}

This action cannot be undone!`)) {
        return;
    }
    
    setStatus('Deleting VHD...');
    try {
        // Fixed: Use correct IPC handler name 'delete-virtual-disk'
        const result = await ipcRenderer.invoke('delete-virtual-disk', selectedVHD);
        if (result.success) {
            alert('VHD deleted successfully');
            selectedVHD = null; // Clear selection after successful deletion
            setStatus('Ready');
            refreshVirtualDisks();
        } else {
            alert(`Failed to delete VHD: ${result.error}`);
            setStatus('Failed to delete VHD');
        }
    } catch (error) {
        console.error('Error deleting VHD:', error);
        alert('Error deleting VHD: ' + error.message);
        setStatus('Error');
    }
}

function showResizeVHDDialog() {
    if (!selectedVHD) {
        alert('Please select a VHD to resize');
        return;
    }
    
    // Create a simple input dialog
    const dialogHtml = `
        <div class="dialog-overlay" id="resizeVHDModal" style="display: flex; position: fixed; top: 0; left: 0; right: 0; bottom: 0; background: rgba(0,0,0,0.7); z-index: 9999; align-items: center; justify-content: center;">
            <div class="dialog" style="background: #1a1f26; padding: 24px; border-radius: 12px; min-width: 350px;">
                <h3 style="margin: 0 0 16px 0; color: #fff;">Resize VHD</h3>
                <p style="color: #8a8a8d; margin-bottom: 12px;">Current VHD: ${selectedVHD.split('\\').pop()}</p>
                <div style="margin-bottom: 16px;">
                    <label style="color: #fff; display: block; margin-bottom: 8px;">New Size (GB):</label>
                    <input type="number" id="resizeVHDInput" min="1" value="100" style="width: 100%; padding: 10px; background: #0d1117; border: 1px solid #30363d; border-radius: 6px; color: #fff;">
                </div>
                <div style="display: flex; gap: 12px; justify-content: flex-end;">
                    <button onclick="document.getElementById('resizeVHDModal').remove()" style="padding: 10px 20px; background: #30363d; border: none; border-radius: 6px; color: #fff; cursor: pointer;">Cancel</button>
                    <button onclick="executeResizeVHD()" style="padding: 10px 20px; background: #00d9ff; border: none; border-radius: 6px; color: #000; cursor: pointer;">Resize</button>
                </div>
            </div>
        </div>
    `;
    document.body.insertAdjacentHTML('beforeend', dialogHtml);
    document.getElementById('resizeVHDInput').focus();
}

function executeResizeVHD() {
    const input = document.getElementById('resizeVHDInput');
    const modal = document.getElementById('resizeVHDModal');
    const newSize = parseInt(input.value);
    
    if (newSize && newSize > 0) {
        modal.remove();
        resizeVHD(newSize * 1024 * 1024 * 1024);
    } else {
        alert('Please enter a valid size');
    }
}

async function resizeVHD(newSizeBytes) {
    setStatus('Resizing VHD...');
    try {
        const result = await ipcRenderer.invoke('resize-vhd', {
            path: selectedVHD,
            newSize: newSizeBytes
        });
        
        if (result.success) {
            alert('VHD resized successfully');
            setStatus('Ready');
            refreshVirtualDisks();
        } else {
            alert(`Failed to resize VHD: ${result.error}`);
        }
    } catch (error) {
        alert('Error resizing VHD');
    }
}

function showConvertVHDDialog() {
    if (!selectedVHD) {
        alert('Please select a VHD to convert');
        return;
    }
    
    // Create a simple selection dialog
    const dialogHtml = `
        <div class="dialog-overlay" id="convertVHDModal" style="display: flex; position: fixed; top: 0; left: 0; right: 0; bottom: 0; background: rgba(0,0,0,0.7); z-index: 9999; align-items: center; justify-content: center;">
            <div class="dialog" style="background: #1a1f26; padding: 24px; border-radius: 12px; min-width: 350px;">
                <h3 style="margin: 0 0 16px 0; color: #fff;">Convert VHD</h3>
                <p style="color: #8a8a8d; margin-bottom: 12px;">Current VHD: ${selectedVHD.split('\\').pop()}</p>
                <div style="margin-bottom: 16px;">
                    <label style="color: #fff; display: block; margin-bottom: 8px;">Convert to:</label>
                    <select id="convertVHDType" style="width: 100%; padding: 10px; background: #0d1117; border: 1px solid #30363d; border-radius: 6px; color: #fff;">
                        <option value="Dynamic">Dynamic (Thin Provisioned)</option>
                        <option value="Fixed">Fixed Size</option>
                    </select>
                </div>
                <div style="display: flex; gap: 12px; justify-content: flex-end;">
                    <button onclick="document.getElementById('convertVHDModal').remove()" style="padding: 10px 20px; background: #30363d; border: none; border-radius: 6px; color: #fff; cursor: pointer;">Cancel</button>
                    <button onclick="executeConvertVHD()" style="padding: 10px 20px; background: #00d9ff; border: none; border-radius: 6px; color: #000; cursor: pointer;">Convert</button>
                </div>
            </div>
        </div>
    `;
    document.body.insertAdjacentHTML('beforeend', dialogHtml);
}

function executeConvertVHD() {
    const select = document.getElementById('convertVHDType');
    const modal = document.getElementById('convertVHDModal');
    const vhdType = select.value;
    
    modal.remove();
    const destPath = selectedVHD.replace(/\.(vhd|vhdx)$/i, `_converted.${selectedVHD.endsWith('.vhdx') ? 'vhdx' : 'vhd'}`);
    convertVHD(destPath, vhdType);
}

async function convertVHD(destPath, vhdType) {
    setStatus('Converting VHD...');
    try {
        const result = await ipcRenderer.invoke('convert-vhd', {
            sourcePath: selectedVHD,
            destinationPath: destPath,
            vhdType: vhdType
        });
        
        if (result.success) {
            alert('VHD converted successfully');
            setStatus('Ready');
            refreshVirtualDisks();
        } else {
            alert(`Failed to convert VHD: ${result.error}`);
        }
    } catch (error) {
        alert('Error converting VHD');
    }
}

async function compactVHD() {
    if (!selectedVHD) {
        alert('Please select a VHD to compact');
        return;
    }
    
    if (confirm('Compact this VHD? This will reduce its file size.')) {
        setStatus('Compacting VHD...');
        try {
            const result = await ipcRenderer.invoke('compact-vhd', selectedVHD);
            if (result.success) {
                alert('VHD compacted successfully');
                setStatus('Ready');
                refreshVirtualDisks();
            } else {
                alert(`Failed to compact VHD: ${result.error}`);
            }
        } catch (error) {
            alert('Error compacting VHD');
        }
    }
}

// VM Stores Functions
async function refreshVMStores() {
    const container = document.getElementById('vmStoresList');
    if (!container) return;
    
    container.innerHTML = '<div style="color: #8a8a8d; padding: 20px;">Loading VM stores...</div>';
    
    try {
        const result = await ipcRenderer.invoke('get-vm-stores');
        
        if (result.success && result.stores.length > 0) {
            container.innerHTML = '';
            
            result.stores.forEach(store => {
                const storeCard = document.createElement('div');
                storeCard.className = 'pool-card';
                storeCard.innerHTML = `
                    <h4>${escapeHtml(store.name)}</h4>
                    <div class="pool-info">
                        <span>Path: ${escapeHtml(store.path)}</span>
                        <span>Free Space: ${store.freeSpaceGB} GB</span>
                    </div>
                `;
                container.appendChild(storeCard);
            });
        } else {
            container.innerHTML = '<div style="color: #8a8a8d; padding: 20px;">No VM stores configured</div>';
        }
    } catch (error) {
        console.error('Error refreshing VM stores:', error);
        container.innerHTML = '<div style="color: #ff6b6b; padding: 20px;">Error loading VM stores</div>';
    }
}

function addVMStore() {
    alert(`To add a VM store:

1. Create the desired directory
2. Open Hyper-V Manager
3. Go to Hyper-V Settings
4. Update Virtual Machines or Virtual Hard Disks path

The default paths can be configured in Settings > Hyper-V.`);
}

function removeVMStore() {
    alert('To remove a VM store:\n\n1. Move all VMs from the store\n2. Update Hyper-V Settings\n3. Remove the old path\n\nNote: Ensure all VMs are moved first!');
}

function migrateVMStore() {
    if (!selectedVM) {
        alert('Please select a VM to migrate');
        return;
    }
    
    alert(`To migrate ${selectedVM}:

1. Use Hyper-V Manager > Move option
2. Or export the VM and re-import at new location
3. Storage migration can be done via the Clustering tab

For live migration, use the Clustering > Migrations section.`);
}

// Checkpoints Functions
async function refreshCheckpoints() {
    const container = document.getElementById('checkpointsList');
    if (!container) return;
    
    container.innerHTML = '<div style="color: #8a8a8d; padding: 20px;">Loading checkpoints...</div>';
    
    try {
        const result = await ipcRenderer.invoke('get-checkpoints');
        
        if (result.success && result.checkpoints.length > 0) {
            container.innerHTML = '';
            
            // Group checkpoints by VM
            const vmCheckpoints = {};
            result.checkpoints.forEach(cp => {
                if (!vmCheckpoints[cp.VMName]) {
                    vmCheckpoints[cp.VMName] = [];
                }
                vmCheckpoints[cp.VMName].push(cp);
            });
            
            for (const [vmName, checkpoints] of Object.entries(vmCheckpoints)) {
                const vmSection = document.createElement('div');
                vmSection.className = 'checkpoint-vm-section';
                vmSection.innerHTML = `<h4>${escapeHtml(vmName)}</h4>`;
                
                checkpoints.forEach(cp => {
                    const cpCard = document.createElement('div');
                    cpCard.className = 'checkpoint-card';
                    cpCard.dataset.checkpointId = cp.Id;
                    cpCard.dataset.vmName = cp.VMName;
                    cpCard.innerHTML = `
                        <div class="checkpoint-info">
                            <span class="checkpoint-name">${escapeHtml(cp.Name)}</span>
                            <span class="checkpoint-date">${new Date(cp.CreationTime).toLocaleString()}</span>
                            <span class="checkpoint-size">${(cp.SizeOfSystemFiles / (1024 ** 2)).toFixed(2)} MB</span>
                        </div>
                    `;
                    vmSection.appendChild(cpCard);
                });
                
                container.appendChild(vmSection);
            }
            
            // Add click handlers
            document.querySelectorAll('.checkpoint-card').forEach(card => {
                card.addEventListener('click', function() {
                    document.querySelectorAll('.checkpoint-card').forEach(c => c.classList.remove('selected'));
                    this.classList.add('selected');
                    selectedCheckpoint = {
                        id: this.dataset.checkpointId,
                        vmName: this.dataset.vmName
                    };
                });
            });
        } else {
            container.innerHTML = '<div style="color: #8a8a8d; padding: 20px;">No checkpoints found</div>';
        }
    } catch (error) {
        console.error('Error refreshing checkpoints:', error);
        container.innerHTML = '<div style="color: #ff6b6b; padding: 20px;">Error loading checkpoints</div>';
    }
}

async function cleanupCheckpoints() {
    if (confirm('Remove all checkpoints older than 30 days?')) {
        setStatus('Cleaning up old checkpoints...');
        // In production, this would remove old checkpoints
        alert('Checkpoint cleanup would remove old checkpoints.\nThis is a safety feature to prevent accidental deletion.');
        setStatus('Ready');
    }
}

async function mergeCheckpoints() {
    if (!selectedCheckpoint) {
        alert('Please select a checkpoint to merge');
        return;
    }
    
    if (confirm('Merge this checkpoint with its parent?')) {
        alert('Checkpoint merging would combine snapshots.\nUse Remove-VMSnapshot with PowerShell for actual merging.');
    }
}

async function exportCheckpoint() {
    if (!selectedCheckpoint) {
        alert('Please select a checkpoint to export');
        return;
    }
    
    const exportPath = prompt('Enter export path:');
    if (exportPath) {
        setStatus('Exporting checkpoint...');
        try {
            const result = await ipcRenderer.invoke('export-checkpoint', {
                vmName: selectedCheckpoint.vmName,
                checkpointName: 'Selected Checkpoint',
                exportPath: exportPath
            });
            
            if (result.success) {
                alert('Checkpoint exported successfully');
                setStatus('Ready');
            } else {
                alert(`Export failed: ${result.error}`);
            }
        } catch (error) {
            alert('Error exporting checkpoint');
        }
    }
}

// ISO Library Functions
async function refreshISOLibrary() {
    const grid = document.getElementById('isoGrid');
    if (!grid) return;
    
    grid.innerHTML = '<div style="color: #8a8a8d; padding: 20px; grid-column: 1/-1;">Loading ISO library...</div>';
    
    try {
        const result = await ipcRenderer.invoke('get-iso-library', isoLibraryPath);
        
        if (result.success && result.isos.length > 0) {
            grid.innerHTML = '';
            
            result.isos.forEach(iso => {
                const isoCard = document.createElement('div');
                isoCard.className = 'iso-card';
                isoCard.dataset.isoPath = iso.FullName;
                
                const sizeGB = (iso.Length / (1024 ** 3)).toFixed(2);
                
                isoCard.innerHTML = `
                    <div class="iso-icon">💿</div>
                    <div class="iso-name">${escapeHtml(iso.Name)}</div>
                    <div class="iso-size">${sizeGB} GB</div>
                `;
                
                isoCard.addEventListener('click', function() {
                    document.querySelectorAll('.iso-card').forEach(c => c.classList.remove('selected'));
                    this.classList.add('selected');
                    selectedISO = this.dataset.isoPath;
                });
                
                grid.appendChild(isoCard);
            });
        } else {
            grid.innerHTML = `
                <div style="color: #8a8a8d; padding: 20px; grid-column: 1/-1; text-align: center;">
                    No ISOs found in library<br>
                    <small>Library path: ${isoLibraryPath}</small>
                </div>
            `;
        }
    } catch (error) {
        console.error('Error refreshing ISO library:', error);
        grid.innerHTML = '<div style="color: #ff6b6b; padding: 20px; grid-column: 1/-1;">Error loading ISO library</div>';
    }
}

async function addISO() {
    try {
        const sourcePath = await ipcRenderer.invoke('browse-for-iso');
        if (sourcePath) {
            setStatus('Adding ISO to library...');
            const result = await ipcRenderer.invoke('add-iso-to-library', {
                sourcePath: sourcePath,
                libraryPath: isoLibraryPath
            });
            
            if (result.success) {
                alert('ISO added to library');
                setStatus('Ready');
                refreshISOLibrary();
            } else {
                alert(`Failed to add ISO: ${result.error}`);
            }
        }
    } catch (error) {
        alert('Error adding ISO');
    }
}

function downloadISO() {
    alert(
        'Popular ISO Download Sources:\n\n' +
        '• Windows: https://www.microsoft.com/software-download\n' +
        '• Ubuntu: https://ubuntu.com/download\n' +
        '• CentOS: https://www.centos.org/download\n' +
        '• Debian: https://www.debian.org/distrib\n\n' +
        'Download ISOs and add them to the library using the Add ISO button.'
    );
}

async function removeISO() {
    if (!selectedISO) {
        alert('Please select an ISO to remove');
        return;
    }
    
    if (confirm('Remove this ISO from the library?')) {
        try {
            const result = await ipcRenderer.invoke('remove-iso', selectedISO);
            if (result.success) {
                selectedISO = null;
                alert('ISO removed from library');
                refreshISOLibrary();
            } else {
                alert(`Failed to remove ISO: ${result.error}`);
            }
        } catch (error) {
            alert('Error removing ISO');
        }
    }
}

function changeISOLibraryPath() {
    const newPath = prompt('Enter new ISO library path:', isoLibraryPath);
    if (newPath && newPath !== isoLibraryPath) {
        isoLibraryPath = newPath;
        refreshISOLibrary();
    }
}

// QoS Policies Functions
async function refreshQosPolicies() {
    const container = document.getElementById('qosPoliciesList');
    if (!container) return;
    
    container.innerHTML = '<div style="color: #8a8a8d; padding: 20px;">Loading QoS policies...</div>';
    
    try {
        const result = await ipcRenderer.invoke('get-qos-policies');
        
        if (result.success && result.policies.length > 0) {
            container.innerHTML = '';
            
            result.policies.forEach(policy => {
                const policyCard = document.createElement('div');
                policyCard.className = 'qos-policy-card';
                policyCard.innerHTML = `
                    <h4>${escapeHtml(policy.Name)}</h4>
                    <div class="qos-info">
                        <span>Min IOPS: ${policy.MinimumIops || 'Not set'}</span>
                        <span>Max IOPS: ${policy.MaximumIops || 'Not set'}</span>
                        <span>Max Bandwidth: ${policy.MaximumIOBandwidth ? (policy.MaximumIOBandwidth / (1024 ** 2)).toFixed(2) + ' MB/s' : 'Not set'}</span>
                        <span>Status: <span style="color: ${policy.Status === 'OK' ? '#00ffaa' : '#ff6b6b'}">${policy.Status}</span></span>
                    </div>
                `;
                container.appendChild(policyCard);
            });
        } else {
            container.innerHTML = '<div style="color: #8a8a8d; padding: 20px;">No QoS policies found</div>';
        }
    } catch (error) {
        console.error('Error refreshing QoS policies:', error);
        container.innerHTML = '<div style="color: #ff6b6b; padding: 20px;">Error loading QoS policies (may require Storage QoS feature)</div>';
    }
}

function showCreateQosDialog() {
    const name = prompt('Enter QoS policy name:');
    if (!name) return;
    
    const minIops = prompt('Enter minimum IOPS (or leave empty):');
    const maxIops = prompt('Enter maximum IOPS (or leave empty):');
    const maxBandwidth = prompt('Enter max bandwidth in MB/s (or leave empty):');
    
    createQosPolicy({
        name: name,
        minIops: minIops ? parseInt(minIops) : null,
        maxIops: maxIops ? parseInt(maxIops) : null,
        maxBandwidth: maxBandwidth ? parseInt(maxBandwidth) * 1024 * 1024 : null
    });
}

async function createQosPolicy(params) {
    setStatus('Creating QoS policy...');
    try {
        const result = await ipcRenderer.invoke('create-qos-policy', params);
        if (result.success) {
            alert('QoS policy created successfully');
            setStatus('Ready');
            refreshQosPolicies();
        } else {
            alert(`Failed to create policy: ${result.error}`);
        }
    } catch (error) {
        alert('Error creating QoS policy');
    }
}

function editQosPolicy() {
    alert('To edit a QoS policy:\n\n1. Use PowerShell: Set-StorageQosPolicy\n2. Or use Windows Admin Center\n3. Navigate to Storage QoS settings');
}

function deleteQosPolicy() {
    alert('To delete a QoS policy:\n\n1. Use PowerShell: Remove-StorageQosPolicy\n2. Ensure no VHDs are using the policy\n3. Or use Windows Admin Center');
}

// AI Assistant Functions

// AI Automation - Command mappings for automated actions
const AI_COMMANDS = {
    // VM Operations
    'start_vm': { action: 'startVMByName', description: 'Start a virtual machine' },
    'stop_vm': { action: 'stopVMByName', description: 'Stop a virtual machine' },
    'create_vm': { action: 'showCreateVMDialogAuto', description: 'Create a new virtual machine' },
    'delete_vm': { action: 'deleteVMByName', description: 'Delete a virtual machine' },
    'list_vms': { action: 'listAllVMs', description: 'List all virtual machines' },
    'vm_status': { action: 'getVMStatus', description: 'Get VM status' },
    'restart_vm': { action: 'restartVMByName', description: 'Restart a virtual machine' },
    'snapshot_vm': { action: 'createSnapshotByName', description: 'Create a VM snapshot' },
    
    // Storage Operations
    'create_vhd': { action: 'showCreateVHDDialogAuto', description: 'Create a virtual hard disk' },
    'list_storage': { action: 'listStorageInfo', description: 'List storage information' },
    
    // System Operations
    'system_stats': { action: 'getSystemStats', description: 'Get system performance stats' },
    'refresh_vms': { action: 'refreshVMsAuto', description: 'Refresh VM list' },
    
    // Navigation
    'go_dashboard': { action: 'navigateTo', params: 'dashboard', description: 'Go to dashboard' },
    'go_vms': { action: 'navigateTo', params: 'vms', description: 'Go to VMs view' },
    'go_storage': { action: 'navigateTo', params: 'storage', description: 'Go to storage view' },
    'go_settings': { action: 'navigateTo', params: 'settings', description: 'Go to settings' },
    'go_clustering': { action: 'navigateTo', params: 'clustering', description: 'Go to clustering view' },
    
    // Cluster Management Operations
    'cluster_status': { action: 'getClusterStatus', description: 'Get cluster status' },
    'list_clusters': { action: 'listClusters', description: 'List all clusters' },
    'list_nodes': { action: 'listClusterNodes', description: 'List cluster nodes' },
    'validate_cluster': { action: 'validateClusterAuto', description: 'Validate cluster configuration' },
    'enable_clustering': { action: 'enableClusteringAuto', description: 'Enable clustering feature' },
    
    // Migration Operations
    'live_migrate': { action: 'liveMigrateVM', description: 'Live migrate a VM' },
    'quick_migrate': { action: 'quickMigrateVM', description: 'Quick migrate a VM' },
    'storage_migrate': { action: 'storageMigrateVM', description: 'Migrate VM storage' },
    'migration_status': { action: 'getMigrationStatus', description: 'Get migration status' },
    
    // Node Operations
    'node_info': { action: 'getNodeInfo', description: 'Get node information' },
    'host_info': { action: 'getHostInfo', description: 'Get host information' }
};

// Create a ChatGPT-style message row
function createChatMessageRow(type, content, options = {}) {
    const row = document.createElement('div');
    row.className = `chat-message-row ${type}`;
    
    // Avatar
    const avatar = document.createElement('div');
    avatar.className = `chat-avatar ${type === 'user' ? 'user-avatar' : 'ai-avatar'}`;
    avatar.textContent = type === 'user' ? '👤' : '⚡';
    
    // Content container
    const contentDiv = document.createElement('div');
    contentDiv.className = 'chat-message-content';
    
    // Message text
    const textDiv = document.createElement('div');
    textDiv.className = 'chat-message-text';
    textDiv.textContent = content;
    contentDiv.appendChild(textDiv);
    
    // Add action indicator if this is an action message
    if (options.actionIndicator) {
        const actionDiv = document.createElement('div');
        actionDiv.className = 'chat-action-indicator';
        actionDiv.id = options.actionId || '';
        actionDiv.innerHTML = `<span class="action-icon">⟳</span> <span class="action-text">${options.actionIndicator}</span>`;
        contentDiv.appendChild(actionDiv);
    }
    
    // Add feedback buttons for assistant messages (not for thinking/action)
    if (type === 'assistant' && !options.noFeedback) {
        const actionsDiv = document.createElement('div');
        actionsDiv.className = 'chat-message-actions';
        actionsDiv.innerHTML = `
            <button class="chat-feedback-btn" onclick="handleFeedback(this, 'up')" title="Good response">👍</button>
            <button class="chat-feedback-btn" onclick="handleFeedback(this, 'down')" title="Bad response">👎</button>
        `;
        contentDiv.appendChild(actionsDiv);
    }
    
    row.appendChild(avatar);
    row.appendChild(contentDiv);
    
    return row;
}

// Handle feedback button clicks
function handleFeedback(btn, type) {
    const btns = btn.parentElement.querySelectorAll('.chat-feedback-btn');
    btns.forEach(b => b.classList.remove('active'));
    btn.classList.add('active');
}

// Update action indicator status
function updateActionIndicator(actionId, status, text) {
    const indicator = document.getElementById(actionId);
    if (indicator) {
        indicator.className = `chat-action-indicator ${status}`;
        const icon = status === 'complete' ? '✓' : status === 'error' ? '✕' : '⟳';
        indicator.innerHTML = `<span class="action-icon">${icon}</span> <span class="action-text">${text}</span>`;
    }
}

// Parse user message for action intents
function parseUserIntent(message) {
    const lowerMsg = message.toLowerCase();
    
    // =============== DETAILED VM DEPLOYMENT ===============
    // Check for detailed VM deployment with specs
    if ((lowerMsg.includes('deploy') || lowerMsg.includes('create')) && 
        (lowerMsg.includes('vm') || lowerMsg.includes('virtual machine')) &&
        (lowerMsg.includes('cpu') || lowerMsg.includes('ram') || lowerMsg.includes('memory') || 
         lowerMsg.includes('disk') || lowerMsg.includes('gb') || lowerMsg.includes('core'))) {
        
        // Parse VM details from message
        const vmDetails = parseVMDeploymentDetails(message);
        if (vmDetails.name) {
            return { command: 'deploy_vm_full', details: vmDetails };
        }
    }
    
    // Simple deploy/create VM with just a name
    if ((lowerMsg.includes('deploy') || lowerMsg.includes('create')) && 
        (lowerMsg.includes('vm') || lowerMsg.includes('virtual machine'))) {
        const nameMatch = message.match(/(?:named?|called?)\s+["']?([\w\-]+)["']?/i) ||
                          message.match(/vm\s+["']?([\w\-]+)["']?/i);
        if (nameMatch) {
            return { command: 'deploy_vm_full', details: { name: nameMatch[1] } };
        }
        return { command: 'create_vm' };
    }
    
    // VM start patterns
    if (lowerMsg.match(/start\s+(the\s+)?(vm|virtual\s+machine)\s+['"]?([\w\-]+)['"]?/i) ||
        lowerMsg.match(/start\s+['"]?([\w\-]+)['"]?\s*(vm)?/i)) {
        const match = message.match(/['"]?([\w\-]+)['"]?(?:\s+vm|\s+virtual)?\s*$/i) ||
                      message.match(/start\s+(?:the\s+)?(?:vm\s+)?['"]?([\w\-]+)['"]?/i);
        if (match) return { command: 'start_vm', target: match[1] };
    }
    
    // VM stop patterns
    if (lowerMsg.match(/stop\s+(the\s+)?(vm|virtual\s+machine)\s+['"]?([\w\-]+)['"]?/i) ||
        lowerMsg.match(/stop\s+['"]?([\w\-]+)['"]?/i) ||
        lowerMsg.match(/shut\s*down\s+['"]?([\w\-]+)['"]?/i)) {
        const match = message.match(/(?:stop|shut\s*down)\s+(?:the\s+)?(?:vm\s+)?['"]?([\w\-]+)['"]?/i);
        if (match) return { command: 'stop_vm', target: match[1] };
    }
    
    // VM restart patterns
    if (lowerMsg.match(/restart\s+['"]?([\w\-]+)['"]?/i) ||
        lowerMsg.match(/reboot\s+['"]?([\w\-]+)['"]?/i)) {
        const match = message.match(/(?:restart|reboot)\s+(?:the\s+)?(?:vm\s+)?['"]?([\w\-]+)['"]?/i);
        if (match) return { command: 'restart_vm', target: match[1] };
    }
    
    // Create VM patterns
    if (lowerMsg.includes('create') && (lowerMsg.includes('vm') || lowerMsg.includes('virtual machine'))) {
        return { command: 'create_vm' };
    }
    
    // List VMs
    if ((lowerMsg.includes('list') || lowerMsg.includes('show') || lowerMsg.includes('get')) && 
        (lowerMsg.includes('vm') || lowerMsg.includes('virtual machine')) &&
        !lowerMsg.includes('cluster') && !lowerMsg.includes('node')) {
        return { command: 'list_vms' };
    }
    
    // VM Status
    if (lowerMsg.includes('status') && (lowerMsg.includes('vm') || lowerMsg.includes('virtual')) &&
        !lowerMsg.includes('cluster') && !lowerMsg.includes('migration')) {
        const match = message.match(/status\s+(?:of\s+)?['"]?([\w\-]+)['"]?/i);
        if (match) return { command: 'vm_status', target: match[1] };
        return { command: 'list_vms' };
    }
    
    // Refresh VMs
    if (lowerMsg.includes('refresh') && (lowerMsg.includes('vm') || lowerMsg.includes('list'))) {
        return { command: 'refresh_vms' };
    }
    
    // Create VHD
    if (lowerMsg.includes('create') && (lowerMsg.includes('vhd') || lowerMsg.includes('disk') || lowerMsg.includes('hard disk'))) {
        return { command: 'create_vhd' };
    }
    
    // System stats
    if (lowerMsg.includes('system') && (lowerMsg.includes('stats') || lowerMsg.includes('performance') || lowerMsg.includes('usage'))) {
        return { command: 'system_stats' };
    }
    
    // Storage info
    if ((lowerMsg.includes('storage') || lowerMsg.includes('disk')) && 
        (lowerMsg.includes('info') || lowerMsg.includes('list') || lowerMsg.includes('show')) &&
        !lowerMsg.includes('migrate')) {
        return { command: 'list_storage' };
    }
    
    // =============== CLUSTER MANAGEMENT ===============
    
    // Cluster status
    if ((lowerMsg.includes('cluster') || lowerMsg.includes('failover')) && 
        (lowerMsg.includes('status') || lowerMsg.includes('state') || lowerMsg.includes('health'))) {
        return { command: 'cluster_status' };
    }
    
    // List clusters
    if ((lowerMsg.includes('list') || lowerMsg.includes('show') || lowerMsg.includes('get')) && 
        lowerMsg.includes('cluster') && !lowerMsg.includes('node')) {
        return { command: 'list_clusters' };
    }
    
    // List nodes
    if ((lowerMsg.includes('list') || lowerMsg.includes('show') || lowerMsg.includes('get')) && 
        lowerMsg.includes('node')) {
        return { command: 'list_nodes' };
    }
    
    // Validate cluster
    if (lowerMsg.includes('validate') && lowerMsg.includes('cluster')) {
        return { command: 'validate_cluster' };
    }
    
    // Enable clustering
    if ((lowerMsg.includes('enable') || lowerMsg.includes('install') || lowerMsg.includes('setup')) && 
        (lowerMsg.includes('cluster') || lowerMsg.includes('failover'))) {
        return { command: 'enable_clustering' };
    }
    
    // =============== MIGRATION OPERATIONS ===============
    
    // Live migration
    if (lowerMsg.includes('live') && lowerMsg.includes('migrat')) {
        const match = message.match(/(?:live\s+)?migrat(?:e|ion)\s+(?:vm\s+)?['"]?([\w\-]+)['"]?/i);
        if (match) return { command: 'live_migrate', target: match[1] };
        return { command: 'live_migrate' };
    }
    
    // Quick migration
    if (lowerMsg.includes('quick') && lowerMsg.includes('migrat')) {
        const match = message.match(/quick\s+migrat(?:e|ion)\s+(?:vm\s+)?['"]?([\w\-]+)['"]?/i);
        if (match) return { command: 'quick_migrate', target: match[1] };
        return { command: 'quick_migrate' };
    }
    
    // Storage migration
    if (lowerMsg.includes('storage') && lowerMsg.includes('migrat')) {
        const match = message.match(/storage\s+migrat(?:e|ion)\s+(?:for\s+)?(?:vm\s+)?['"]?([\w\-]+)['"]?/i);
        if (match) return { command: 'storage_migrate', target: match[1] };
        return { command: 'storage_migrate' };
    }
    
    // General migrate (defaults to live)
    if (lowerMsg.includes('migrat') && (lowerMsg.includes('vm') || lowerMsg.includes('virtual'))) {
        const match = message.match(/migrat(?:e|ion)\s+(?:vm\s+)?['"]?([\w\-]+)['"]?/i);
        if (match) return { command: 'live_migrate', target: match[1] };
        return { command: 'live_migrate' };
    }
    
    // Migration status
    if (lowerMsg.includes('migration') && lowerMsg.includes('status')) {
        return { command: 'migration_status' };
    }
    
    // =============== NODE OPERATIONS ===============
    
    // Node info
    if (lowerMsg.includes('node') && (lowerMsg.includes('info') || lowerMsg.includes('detail'))) {
        return { command: 'node_info' };
    }
    
    // Host info
    if (lowerMsg.includes('host') && (lowerMsg.includes('info') || lowerMsg.includes('detail'))) {
        return { command: 'host_info' };
    }
    
    // =============== NAVIGATION ===============
    
    if (lowerMsg.includes('go to') || lowerMsg.includes('open') || lowerMsg.includes('show me') || lowerMsg.includes('navigate')) {
        if (lowerMsg.includes('dashboard')) return { command: 'go_dashboard' };
        if (lowerMsg.includes('vm')) return { command: 'go_vms' };
        if (lowerMsg.includes('storage')) return { command: 'go_storage' };
        if (lowerMsg.includes('setting')) return { command: 'go_settings' };
        if (lowerMsg.includes('cluster') || lowerMsg.includes('migration')) return { command: 'go_clustering' };
    }
    
    // Create snapshot
    if ((lowerMsg.includes('snapshot') || lowerMsg.includes('checkpoint')) && 
        (lowerMsg.includes('create') || lowerMsg.includes('take') || lowerMsg.includes('make'))) {
        const match = message.match(/(?:of|for)\s+['"]?([\w\-]+)['"]?/i);
        if (match) return { command: 'snapshot_vm', target: match[1] };
    }
    
    return null; // No recognized command
}

// Parse detailed VM deployment specs from natural language
function parseVMDeploymentDetails(message) {
    const details = {
        name: null,
        cpu: 2,
        memory: 2048,
        diskSize: 50,
        iso: null,
        generation: 2
    };
    
    // Parse VM name - look for quoted names or "Named X" pattern
    const nameMatch = message.match(/["']([^"']+)["']/i) ||
                      message.match(/(?:named?|called?)\s+["']?([\w\-\.]+)["']?/i) ||
                      message.match(/vm\s+["']?([\w\-\.]+)["']?/i);
    if (nameMatch) {
        details.name = nameMatch[1];
    }
    
    // Parse CPU count
    const cpuMatch = message.match(/(?:cpu|cores?|processors?|vcpu)\s*[:\s]*([\d]+)/i) ||
                     message.match(/([\d]+)\s*(?:cpu|cores?|vcpu)/i);
    if (cpuMatch) {
        details.cpu = parseInt(cpuMatch[1]);
    }
    
    // Parse RAM/Memory
    const ramMatch = message.match(/(?:ram|memory)\s*[:\s]*([\d]+)\s*(?:gb|g)?/i) ||
                     message.match(/([\d]+)\s*(?:gb|g)?\s*(?:ram|memory)/i);
    if (ramMatch) {
        const ramValue = parseInt(ramMatch[1]);
        // If value is small, assume GB, otherwise MB
        details.memory = ramValue <= 128 ? ramValue * 1024 : ramValue;
    }
    
    // Parse Disk Size
    const diskMatch = message.match(/(?:disk|storage|hdd|vhd)\s*(?:space|size)?\s*[:\s]*([\d]+)\s*(?:gb|g)?/i) ||
                      message.match(/([\d]+)\s*(?:gb|g)?\s*(?:disk|storage)/i);
    if (diskMatch) {
        details.diskSize = parseInt(diskMatch[1]);
    }
    
    // Parse ISO
    const isoMatch = message.match(/(?:iso|image)\s*[:\s]*["']?([\w\-\.]+\.iso)["']?/i) ||
                     message.match(/([\w\-\.]+\.iso)/i);
    if (isoMatch) {
        details.iso = isoMatch[1];
    }
    
    // Parse Generation
    const genMatch = message.match(/gen(?:eration)?\s*[:\s]*([12])/i);
    if (genMatch) {
        details.generation = parseInt(genMatch[1]);
    }
    
    return details;
}

// Automated VM Deployment with step-by-step progress
async function deployVMAutomated(details, actionId, display) {
    const { name, cpu, memory, diskSize, iso, generation } = details;
    const memoryMB = memory;
    const memoryGB = (memory / 1024).toFixed(1);
    
    // Create a task for tracking
    const taskId = createTask('Deploy Virtual Machine', name);
    
    // Update action indicator with deployment starting
    updateActionIndicator(actionId, '', `🚀 Starting deployment of "${name}"...`);
    
    // Add a deployment log element
    const logDiv = document.createElement('div');
    logDiv.className = 'deployment-log';
    logDiv.style.cssText = 'margin-top: 12px; padding: 12px; background: rgba(0,217,255,0.05); border-radius: 8px; font-family: monospace; font-size: 11px; line-height: 1.8;';
    
    const actionRow = display.querySelector(`#${actionId}`)?.closest('.chat-message-row');
    const contentDiv = actionRow?.querySelector('.chat-message-content');
    if (contentDiv) {
        contentDiv.appendChild(logDiv);
    }
    
    function addLogEntry(step, message, status = 'running') {
        const icons = { running: '⟳', complete: '✓', error: '✕' };
        const colors = { running: '#00d9ff', complete: '#00ffaa', error: '#ff6b6b' };
        const entry = document.createElement('div');
        entry.id = `deploy-step-${step}`;
        entry.innerHTML = `<span style="color: ${colors[status]}">${icons[status]}</span> ${message}`;
        logDiv.appendChild(entry);
        display.scrollTop = display.scrollHeight;
    }
    
    function updateLogEntry(step, message, status) {
        const entry = document.getElementById(`deploy-step-${step}`);
        const icons = { running: '⟳', complete: '✓', error: '✕' };
        const colors = { running: '#00d9ff', complete: '#00ffaa', error: '#ff6b6b' };
        if (entry) {
            entry.innerHTML = `<span style="color: ${colors[status]}">${icons[status]}</span> ${message}`;
        }
    }
    
    try {
        // Step 1: Validate parameters
        addLogEntry(1, 'Validating deployment parameters...', 'running');
        await sleep(500);
        updateLogEntry(1, `Parameters validated - ${cpu} CPUs, ${memoryGB} GB RAM, ${diskSize} GB disk`, 'complete');
        updateTaskProgress(taskId, 10);
        
        // Step 2: Check Hyper-V availability
        addLogEntry(2, 'Checking Hyper-V availability...', 'running');
        const hypervCheck = await ipcRenderer.invoke('check-hyperv');
        if (!hypervCheck) {
            updateLogEntry(2, 'Hyper-V is not available', 'error');
            completeTask(taskId, false);
            updateActionIndicator(actionId, 'error', 'Deployment failed - Hyper-V not available');
            return 'Deployment failed: Hyper-V is not available on this system.';
        }
        updateLogEntry(2, 'Hyper-V is available and ready', 'complete');
        updateTaskProgress(taskId, 20);
        
        // Step 3: Get default paths
        addLogEntry(3, 'Retrieving default storage paths...', 'running');
        const pathResult = await ipcRenderer.invoke('execute-powershell', 'Get-VMHost | Select-Object VirtualHardDiskPath, VirtualMachinePath | ConvertTo-Json');
        let vhdPath = 'C:\\ProgramData\\Microsoft\\Windows\\Virtual Hard Disks';
        let vmPath = 'C:\\ProgramData\\Microsoft\\Windows\\Hyper-V';
        if (pathResult.success && pathResult.output) {
            try {
                const paths = JSON.parse(pathResult.output);
                vhdPath = paths.VirtualHardDiskPath || vhdPath;
                vmPath = paths.VirtualMachinePath || vmPath;
            } catch (e) {}
        }
        updateLogEntry(3, `Storage path: ${vhdPath}`, 'complete');
        updateTaskProgress(taskId, 30);
        
        // Step 4: Create the virtual hard disk
        addLogEntry(4, `Creating ${diskSize} GB virtual hard disk...`, 'running');
        const vhdFullPath = `${vhdPath}\\${name}.vhdx`;
        // Use single quotes for paths with spaces
        const createVhdCmd = `New-VHD -Path '${vhdFullPath}' -SizeBytes ${diskSize}GB -Dynamic`;
        const vhdResult = await ipcRenderer.invoke('execute-powershell', createVhdCmd);
        if (!vhdResult.success) {
            updateLogEntry(4, `Failed to create VHD: ${vhdResult.error || 'Unknown error'}`, 'error');
            completeTask(taskId, false);
            updateActionIndicator(actionId, 'error', 'Deployment failed - VHD creation error');
            return `Deployment failed while creating VHD: ${vhdResult.error}`;
        }
        updateLogEntry(4, `Virtual hard disk created: ${name}.vhdx (${diskSize} GB)`, 'complete');
        updateTaskProgress(taskId, 50);
        
        // Step 5: Create the virtual machine
        addLogEntry(5, `Creating virtual machine "${name}"...`, 'running');
        const createVmCmd = `New-VM -Name '${name}' -Generation ${generation} -MemoryStartupBytes ${memoryMB}MB -VHDPath '${vhdFullPath}'`;
        const vmResult = await ipcRenderer.invoke('execute-powershell', createVmCmd);
        if (!vmResult.success) {
            updateLogEntry(5, `Failed to create VM: ${vmResult.error || 'Unknown error'}`, 'error');
            completeTask(taskId, false);
            updateActionIndicator(actionId, 'error', 'Deployment failed - VM creation error');
            return `Deployment failed while creating VM: ${vmResult.error}`;
        }
        updateLogEntry(5, `Virtual machine "${name}" created successfully`, 'complete');
        updateTaskProgress(taskId, 65);
        
        // Step 6: Configure CPU
        addLogEntry(6, `Configuring ${cpu} virtual processors...`, 'running');
        const cpuCmd = `Set-VMProcessor -VMName '${name}' -Count ${cpu}`;
        await ipcRenderer.invoke('execute-powershell', cpuCmd);
        updateLogEntry(6, `Configured ${cpu} virtual processors`, 'complete');
        updateTaskProgress(taskId, 75);
        
        // Step 7: Connect to network
        addLogEntry(7, 'Connecting to virtual switch...', 'running');
        const switchResult = await ipcRenderer.invoke('execute-powershell', 'Get-VMSwitch | Select-Object -First 1 -ExpandProperty Name');
        if (switchResult.success && switchResult.output && switchResult.output.trim()) {
            const switchName = switchResult.output.trim();
            await ipcRenderer.invoke('execute-powershell', `Connect-VMNetworkAdapter -VMName '${name}' -SwitchName '${switchName}'`);
            updateLogEntry(7, `Connected to virtual switch: ${switchName}`, 'complete');
        } else {
            updateLogEntry(7, 'No virtual switch found - network not connected', 'complete');
        }
        updateTaskProgress(taskId, 85);
        
        // Step 8: Attach ISO if provided
        if (iso) {
            addLogEntry(8, `Attaching ISO image: ${iso}...`, 'running');
            
            // First, add a DVD drive to the VM
            await ipcRenderer.invoke('execute-powershell', `Add-VMDvdDrive -VMName '${name}'`);
            
            // Try to find the ISO in common locations
            const isoSearchCmd = `Get-ChildItem -Path 'C:\\','D:\\','E:\\' -Recurse -Filter '${iso}' -ErrorAction SilentlyContinue | Select-Object -First 1 -ExpandProperty FullName`;
            const isoSearchResult = await ipcRenderer.invoke('execute-powershell', isoSearchCmd);
            
            let isoAttached = false;
            if (isoSearchResult.success && isoSearchResult.output && isoSearchResult.output.trim()) {
                const isoPath = isoSearchResult.output.trim();
                const attachResult = await ipcRenderer.invoke('execute-powershell', `Set-VMDvdDrive -VMName '${name}' -Path '${isoPath}'`);
                if (attachResult.success) {
                    updateLogEntry(8, `ISO attached: ${isoPath}`, 'complete');
                    isoAttached = true;
                }
            }
            
            if (!isoAttached) {
                // Try the settings ISO path
                const savedSettings = localStorage.getItem('corelayer-settings');
                let isoLibPath = 'C:\\ISO';
                if (savedSettings) {
                    try { isoLibPath = JSON.parse(savedSettings).isoPath || isoLibPath; } catch(e) {}
                }
                const isoFullPath = `${isoLibPath}\\${iso}`;
                const attachResult = await ipcRenderer.invoke('execute-powershell', `Set-VMDvdDrive -VMName '${name}' -Path '${isoFullPath}'`);
                if (attachResult.success) {
                    updateLogEntry(8, `ISO attached: ${isoFullPath}`, 'complete');
                    isoAttached = true;
                }
            }
            
            if (!isoAttached) {
                updateLogEntry(8, `ISO '${iso}' not found - DVD drive added but empty`, 'complete');
            }
        } else {
            addLogEntry(8, 'No ISO specified - skipping DVD drive', 'complete');
        }
        updateTaskProgress(taskId, 90);
        
        // Step 9: Configure boot order
        addLogEntry(9, 'Configuring boot order...', 'running');
        const isLinux = iso && (iso.toLowerCase().includes('ubuntu') || iso.toLowerCase().includes('linux') || iso.toLowerCase().includes('debian') || iso.toLowerCase().includes('centos'));
        
        if (generation === 2) {
            // Gen 2: Disable Secure Boot for Linux and set DVD as first boot device
            if (isLinux) {
                await ipcRenderer.invoke('execute-powershell', `Set-VMFirmware -VMName '${name}' -EnableSecureBoot Off`);
            }
            if (iso) {
                await ipcRenderer.invoke('execute-powershell', `$dvd = Get-VMDvdDrive -VMName '${name}'; if($dvd) { Set-VMFirmware -VMName '${name}' -FirstBootDevice $dvd }`);
            }
            updateLogEntry(9, 'Boot order configured - DVD first' + (isLinux ? ', Secure Boot disabled' : ''), 'complete');
        } else {
            // Gen 1: Set boot order with CD first
            await ipcRenderer.invoke('execute-powershell', `Set-VMBios -VMName '${name}' -StartupOrder @('CD','IDE','LegacyNetworkAdapter','Floppy')`);
            updateLogEntry(9, 'Boot order configured - CD/DVD first', 'complete');
        }
        updateTaskProgress(taskId, 95);
        
        // Step 10: Finalize
        addLogEntry(10, 'Finalizing deployment...', 'running');
        await sleep(500);
        updateLogEntry(10, 'Deployment completed successfully!', 'complete');
        updateTaskProgress(taskId, 100);
        completeTask(taskId, true);
        
        // Update action indicator
        updateActionIndicator(actionId, 'complete', `✓ VM "${name}" deployed successfully!`);
        
        // Refresh VM list
        setTimeout(() => refreshVMs(), 1000);
        
        // Return success message
        const isoLine = iso ? `\n• ISO: ${iso}` : '';
        return `

🎉 **Deployment Complete!**

VM "${name}" has been created with:
• ${cpu} vCPUs
• ${memoryGB} GB RAM
• ${diskSize} GB disk${isoLine}

The VM is ready to start. Would you like me to start it now?`;
        
    } catch (error) {
        completeTask(taskId, false);
        updateActionIndicator(actionId, 'error', `Deployment failed: ${error.message}`);
        return `Deployment failed with error: ${error.message}`;
    }
}

// Helper sleep function
function sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
}

// Execute AI automation action
async function executeAIAction(intent, display, actionId) {
    const { command, target, details } = intent;
    
    try {
        switch (command) {
            
            // =============== AUTOMATED VM DEPLOYMENT ===============
            case 'deploy_vm_full':
                return await deployVMAutomated(details, actionId, display);
            
            case 'start_vm':
                updateActionIndicator(actionId, '', `Starting VM: ${target}...`);
                const startResult = await ipcRenderer.invoke('start-vm', target);
                if (startResult.success) {
                    updateActionIndicator(actionId, 'complete', `Successfully started ${target}`);
                    createTask('Start VM', target);
                    setTimeout(() => refreshVMs(), 2000);
                    return `I've started the virtual machine "${target}". It should be running now.`;
                } else {
                    updateActionIndicator(actionId, 'error', `Failed to start ${target}`);
                    // If VM not found, list available VMs
                    if (startResult.error && startResult.error.includes('not found')) {
                        const vmsResult = await ipcRenderer.invoke('get-vms');
                        if (vmsResult.success && vmsResult.vms && vmsResult.vms.length > 0) {
                            const vmNames = vmsResult.vms.map(v => v.Name).join(', ');
                            return `VM "${target}" was not found. Available VMs: ${vmNames}`;
                        }
                    }
                    return `I couldn't start "${target}". Error: ${startResult.error}`;
                }
                
            case 'stop_vm':
                updateActionIndicator(actionId, '', `Stopping VM: ${target}...`);
                const stopResult = await ipcRenderer.invoke('stop-vm', target);
                if (stopResult.success) {
                    updateActionIndicator(actionId, 'complete', `Successfully stopped ${target}`);
                    createTask('Stop VM', target);
                    setTimeout(() => refreshVMs(), 2000);
                    return `I've stopped the virtual machine "${target}".`;
                } else {
                    updateActionIndicator(actionId, 'error', `Failed to stop ${target}`);
                    return `I couldn't stop "${target}". Error: ${stopResult.error}`;
                }
                
            case 'restart_vm':
                updateActionIndicator(actionId, '', `Restarting VM: ${target}...`);
                const restartResult = await ipcRenderer.invoke('restart-vm', target);
                if (restartResult.success) {
                    updateActionIndicator(actionId, 'complete', `Successfully restarted ${target}`);
                    createTask('Restart VM', target);
                    setTimeout(() => refreshVMs(), 2000);
                    return `I've restarted the virtual machine "${target}".`;
                } else {
                    updateActionIndicator(actionId, 'error', `Failed to restart ${target}`);
                    return `I couldn't restart "${target}". Error: ${restartResult.error}`;
                }
                
            case 'list_vms':
                updateActionIndicator(actionId, '', 'Fetching VM list...');
                const vmsResult = await ipcRenderer.invoke('get-vms');
                if (vmsResult.success && vmsResult.vms) {
                    updateActionIndicator(actionId, 'complete', `Found ${vmsResult.vms.length} VMs`);
                    if (vmsResult.vms.length === 0) {
                        return 'There are no virtual machines configured on this host.';
                    }
                    let vmList = 'Here are your virtual machines:\n\n';
                    vmsResult.vms.forEach(vm => {
                        const status = vm.State === 'Running' ? '🟢' : '⚫';
                        vmList += `${status} ${vm.Name} - ${vm.State} (${vm.ProcessorCount} CPUs, ${Math.round((vm.MemoryStartup || 0) / 1024 / 1024)} MB)\n`;
                    });
                    return vmList;
                } else {
                    updateActionIndicator(actionId, 'error', 'Failed to get VMs');
                    return `I couldn't retrieve the VM list. Error: ${vmsResult.error}`;
                }
                
            case 'vm_status':
                updateActionIndicator(actionId, '', `Getting status for ${target}...`);
                const statusResult = await ipcRenderer.invoke('get-vm-details', target);
                if (statusResult.success && statusResult.details) {
                    const vm = statusResult.details;
                    updateActionIndicator(actionId, 'complete', `Got status for ${target}`);
                    return `VM: ${vm.Name}
State: ${vm.State}
CPUs: ${vm.ProcessorCount}
Memory: ${Math.round((vm.MemoryStartup || 0) / 1024 / 1024)} MB
Uptime: ${vm.Uptime || 'N/A'}
Generation: ${vm.Generation}`;
                } else {
                    updateActionIndicator(actionId, 'error', `VM not found: ${target}`);
                    return `I couldn't find a VM named "${target}".`;
                }
                
            case 'create_vm':
                updateActionIndicator(actionId, 'complete', 'Opening VM creation dialog');
                showCreateVMDialog();
                return 'I\'ve opened the Create VM dialog for you. Please fill in the details and click "Create VM" when ready.';
                
            case 'create_vhd':
                updateActionIndicator(actionId, 'complete', 'Opening VHD creation dialog');
                showCreateVHDDialog();
                return 'I\'ve opened the Create VHD dialog for you. Please configure the disk settings and click "Create VHD" when ready.';
                
            case 'refresh_vms':
                updateActionIndicator(actionId, '', 'Refreshing VM list...');
                await refreshVMs();
                updateActionIndicator(actionId, 'complete', 'VM list refreshed');
                return 'I\'ve refreshed the virtual machine list.';
                
            case 'system_stats':
                updateActionIndicator(actionId, '', 'Getting system stats...');
                const stats = await ipcRenderer.invoke('get-system-stats');
                updateActionIndicator(actionId, 'complete', 'Got system stats');
                return `System Performance:

CPU Usage: ${(stats.cpu || 0).toFixed(1)}%
Memory Usage: ${(stats.memory || 0).toFixed(1)}%
Disk Usage: ${(stats.disk || 0).toFixed(1)}%
Network I/O: ${(stats.network || 0).toFixed(1)} MB/s`;
                
            case 'list_storage':
                updateActionIndicator(actionId, 'complete', 'Navigate to Storage');
                switchView('storage');
                return 'I\'ve switched to the Storage view where you can see all your storage information.';
                
            case 'go_dashboard':
            case 'go_vms':
            case 'go_storage':
            case 'go_settings':
                const view = command.replace('go_', '');
                updateActionIndicator(actionId, 'complete', `Navigated to ${view}`);
                switchView(view);
                return `I've navigated to the ${view} view.`;
                
            case 'snapshot_vm':
                updateActionIndicator(actionId, '', `Creating snapshot for ${target}...`);
                const snapshotName = `Snapshot-${new Date().toISOString().replace(/[:.]/g, '-')}`;
                const snapResult = await ipcRenderer.invoke('create-checkpoint', { vmName: target, checkpointName: snapshotName });
                if (snapResult.success) {
                    updateActionIndicator(actionId, 'complete', `Snapshot created for ${target}`);
                    createTask('Create Snapshot', target);
                    return `I've created a snapshot named "${snapshotName}" for VM "${target}".`;
                } else {
                    updateActionIndicator(actionId, 'error', `Failed to create snapshot`);
                    return `I couldn't create a snapshot for "${target}". Error: ${snapResult.error}`;
                }
            
            // =============== CLUSTER MANAGEMENT ===============
            
            case 'cluster_status':
                updateActionIndicator(actionId, '', 'Checking cluster status...');
                try {
                    const clusterResult = await ipcRenderer.invoke('execute-powershell', 'Get-Cluster | Select-Object Name, State | ConvertTo-Json');
                    if (clusterResult.success && clusterResult.output && clusterResult.output.trim()) {
                        const cluster = JSON.parse(clusterResult.output);
                        updateActionIndicator(actionId, 'complete', 'Got cluster status');
                        return `Cluster Status:\n\nName: ${cluster.Name}\nState: ${cluster.State}`;
                    } else {
                        updateActionIndicator(actionId, 'complete', 'No clusters found');
                        return 'No failover clusters are configured on this host. You may need to install the Failover Clustering feature first.';
                    }
                } catch (e) {
                    updateActionIndicator(actionId, 'error', 'Cluster check failed');
                    return 'Could not retrieve cluster status. Failover Clustering may not be installed.';
                }
            
            case 'list_clusters':
                updateActionIndicator(actionId, '', 'Listing clusters...');
                try {
                    const clustersResult = await ipcRenderer.invoke('execute-powershell', 'Get-Cluster | Select-Object Name, State, Domain | ConvertTo-Json');
                    if (clustersResult.success && clustersResult.output && clustersResult.output.trim()) {
                        updateActionIndicator(actionId, 'complete', 'Found clusters');
                        const clusters = JSON.parse(clustersResult.output);
                        const clusterList = Array.isArray(clusters) ? clusters : [clusters];
                        let response = 'Failover Clusters:\n\n';
                        clusterList.forEach(c => {
                            response += `• ${c.Name} - ${c.State}\n`;
                        });
                        return response;
                    } else {
                        updateActionIndicator(actionId, 'complete', 'No clusters');
                        return 'No failover clusters found. To create a cluster, use Failover Cluster Manager or run New-Cluster in PowerShell.';
                    }
                } catch (e) {
                    updateActionIndicator(actionId, 'error', 'Failed to list clusters');
                    return 'Could not list clusters. Failover Clustering feature may not be installed.';
                }
            
            case 'list_nodes':
                updateActionIndicator(actionId, '', 'Listing cluster nodes...');
                try {
                    const nodesResult = await ipcRenderer.invoke('execute-powershell', 'Get-ClusterNode | Select-Object Name, State, NodeWeight | ConvertTo-Json');
                    if (nodesResult.success && nodesResult.output && nodesResult.output.trim()) {
                        updateActionIndicator(actionId, 'complete', 'Found nodes');
                        const nodes = JSON.parse(nodesResult.output);
                        const nodeList = Array.isArray(nodes) ? nodes : [nodes];
                        let response = 'Cluster Nodes:\n\n';
                        nodeList.forEach(n => {
                            const status = n.State === 'Up' ? '🟢' : '🔴';
                            response += `${status} ${n.Name} - ${n.State}\n`;
                        });
                        return response;
                    } else {
                        // Try getting local host info instead
                        const hostResult = await ipcRenderer.invoke('execute-powershell', 'Get-VMHost | Select-Object Name, LogicalProcessorCount, MemoryCapacity | ConvertTo-Json');
                        if (hostResult.success && hostResult.output) {
                            const host = JSON.parse(hostResult.output);
                            const memGB = host.MemoryCapacity ? (host.MemoryCapacity / (1024**3)).toFixed(1) : 'N/A';
                            updateActionIndicator(actionId, 'complete', 'Got host info');
                            return `This host is not part of a cluster.

Local Host: ${host.Name}
CPU Cores: ${host.LogicalProcessorCount}
Memory: ${memGB} GB`;
                        }
                        updateActionIndicator(actionId, 'complete', 'No cluster nodes');
                        return 'No cluster nodes found. This host may not be part of a cluster.';
                    }
                } catch (e) {
                    updateActionIndicator(actionId, 'error', 'Failed to list nodes');
                    return 'Could not list cluster nodes.';
                }
            
            case 'validate_cluster':
                updateActionIndicator(actionId, 'complete', 'Cluster validation info');
                return `To validate a cluster, run this PowerShell command:

Test-Cluster -Node Node1,Node2 -Include "All"

This will test:
• Hardware configuration
• Software configuration
• Network settings
• Storage connectivity

The validation report will be saved to your system.`;
            
            case 'enable_clustering':
                updateActionIndicator(actionId, 'complete', 'Clustering setup info');
                return `To enable Failover Clustering on Windows Server:

1. Run PowerShell as Administrator
2. Execute: Install-WindowsFeature -Name Failover-Clustering -IncludeManagementTools
3. Reboot the server
4. Create cluster: New-Cluster -Name "ClusterName" -Node Node1,Node2 -StaticAddress IP

Note: Failover Clustering requires Windows Server (not available on Windows 10/11).`;
            
            // =============== MIGRATION OPERATIONS ===============
            
            case 'live_migrate':
                if (target) {
                    updateActionIndicator(actionId, 'complete', 'Live migration info');
                    return `To live migrate VM "${target}":

Move-VM -Name "${target}" -DestinationHost "TargetHostName" -IncludeStorage

Requirements:
• Shared storage or SMB 3.0
• Same processor manufacturer
• Proper delegation configured
• Live Migration enabled on both hosts

Would you like me to navigate to the Clustering view to manage migrations?`;
                } else {
                    updateActionIndicator(actionId, 'complete', 'Live migration info');
                    switchView('clustering');
                    return `I've opened the Clustering view where you can manage live migrations.\n\nTo perform a live migration:\n1. Select a VM\n2. Click "Live Migration"\n3. Choose the destination host\n\nOr use PowerShell:\nMove-VM -Name "VMName" -DestinationHost "TargetHost"`;
                }
            
            case 'quick_migrate':
                updateActionIndicator(actionId, 'complete', 'Quick migration info');
                return `Quick Migration saves VM state before moving (causes brief downtime).

To quick migrate${target ? ' VM "' + target + '"' : ''}:

Move-ClusterVirtualMachineRole -Name "VMName" -Node "TargetNode"

Quick migration is useful when live migration isn't available.`;
            
            case 'storage_migrate':
                updateActionIndicator(actionId, 'complete', 'Storage migration info');
                return `To migrate VM storage${target ? ' for "' + target + '"' : ''} without downtime:

Move-VMStorage -VMName "VMName" -DestinationStoragePath "D:\\NewPath"

This moves VHD files while the VM keeps running.

You can also move specific components:
• -VirtualMachinePath for configuration
• -SnapshotFilePath for checkpoints`;
            
            case 'migration_status':
                updateActionIndicator(actionId, '', 'Checking migration status...');
                try {
                    const migResult = await ipcRenderer.invoke('execute-powershell', 'Get-VM | Where-Object {$_.Status -like "*Migrating*"} | Select-Object Name, Status | ConvertTo-Json');
                    if (migResult.success && migResult.output && migResult.output.trim() && migResult.output !== 'null') {
                        updateActionIndicator(actionId, 'complete', 'Found active migrations');
                        const migrations = JSON.parse(migResult.output);
                        const migList = Array.isArray(migrations) ? migrations : [migrations];
                        let response = 'Active Migrations:\n\n';
                        migList.forEach(m => {
                            response += `• ${m.Name} - ${m.Status}\n`;
                        });
                        return response;
                    } else {
                        updateActionIndicator(actionId, 'complete', 'No active migrations');
                        return 'No active migrations at this time. All VMs are in a stable state.';
                    }
                } catch (e) {
                    updateActionIndicator(actionId, 'error', 'Check failed');
                    return 'Could not check migration status.';
                }
            
            // =============== NODE OPERATIONS ===============
            
            case 'node_info':
            case 'host_info':
                updateActionIndicator(actionId, '', 'Getting host information...');
                try {
                    const hostInfoResult = await ipcRenderer.invoke('execute-powershell', 'Get-VMHost | Select-Object Name, LogicalProcessorCount, MemoryCapacity, VirtualHardDiskPath, VirtualMachinePath | ConvertTo-Json');
                    if (hostInfoResult.success && hostInfoResult.output) {
                        const host = JSON.parse(hostInfoResult.output);
                        const memGB = host.MemoryCapacity ? (host.MemoryCapacity / (1024**3)).toFixed(1) : 'N/A';
                        updateActionIndicator(actionId, 'complete', 'Got host info');
                        return `Hyper-V Host Information:

Name: ${host.Name}
CPU Cores: ${host.LogicalProcessorCount}
Total Memory: ${memGB} GB

Default Paths:
• VMs: ${host.VirtualMachinePath}
• VHDs: ${host.VirtualHardDiskPath}`;
                    } else {
                        updateActionIndicator(actionId, 'error', 'Failed to get host info');
                        return 'Could not retrieve host information.';
                    }
                } catch (e) {
                    updateActionIndicator(actionId, 'error', 'Error');
                    return 'Error getting host information.';
                }
            
            case 'go_clustering':
                updateActionIndicator(actionId, 'complete', 'Navigated to clustering');
                switchView('clustering');
                return 'I\'ve navigated to the Clustering view where you can manage clusters, migrations, and nodes.';
                
            default:
                updateActionIndicator(actionId, 'error', 'Unknown command');
                return null;
        }
    } catch (error) {
        updateActionIndicator(actionId, 'error', `Error: ${error.message}`);
        return `An error occurred: ${error.message}`;
    }
}

async function sendAIMessage() {
    const input = document.getElementById('chatInput');
    const display = document.getElementById('chatDisplay');
    
    if (!input || !display) return;
    
    const message = input.value.trim();
    if (!message) return;
    
    // Remove welcome message if present
    const welcome = display.querySelector('.ai-welcome');
    if (welcome) {
        welcome.remove();
    }
    
    // Add user message with ChatGPT style
    const userRow = createChatMessageRow('user', message);
    display.appendChild(userRow);
    
    // Clear input
    input.value = '';
    
    // Check for actionable intent
    const intent = parseUserIntent(message);
    const actionId = `action-${Date.now()}`;
    
    // Update status
    updateAIStatus('Processing...', false);
    display.scrollTop = display.scrollHeight;
    
    if (intent) {
        // This is an actionable command - execute it!
        const actionRow = createChatMessageRow('assistant', 'I understand. Let me do that for you...', {
            actionIndicator: 'Preparing to execute...',
            actionId: actionId,
            noFeedback: true
        });
        display.appendChild(actionRow);
        display.scrollTop = display.scrollHeight;
        
        // Execute the action
        const actionResult = await executeAIAction(intent, display, actionId);
        
        if (actionResult) {
            // Update the message with the result
            const textDiv = actionRow.querySelector('.chat-message-text');
            if (textDiv) {
                textDiv.textContent = actionResult;
            }
            // Add feedback buttons
            const contentDiv = actionRow.querySelector('.chat-message-content');
            if (contentDiv && !contentDiv.querySelector('.chat-message-actions')) {
                const actionsDiv = document.createElement('div');
                actionsDiv.className = 'chat-message-actions';
                actionsDiv.innerHTML = `
                    <button class="chat-feedback-btn" onclick="handleFeedback(this, 'up')" title="Good response">👍</button>
                    <button class="chat-feedback-btn" onclick="handleFeedback(this, 'down')" title="Bad response">👎</button>
                `;
                contentDiv.appendChild(actionsDiv);
            }
        }
    } else {
        // Add thinking indicator
        const thinkingRow = createChatMessageRow('thinking', 'AI is thinking...', { noFeedback: true });
        display.appendChild(thinkingRow);
        display.scrollTop = display.scrollHeight;
        
        try {
            // Send message to AI backend
            const result = await ipcRenderer.invoke('send-ai-message', message);
            
            // Remove thinking indicator
            if (thinkingRow.parentNode) {
                display.removeChild(thinkingRow);
            }
            
            if (result && result.success) {
                // Add AI response
                const aiRow = createChatMessageRow('assistant', result.response);
                display.appendChild(aiRow);
            } else {
                // Show error
                const errorRow = createChatMessageRow('error', `Error: ${result?.error || 'Failed to get response. Make sure Ollama is running.'}`, { noFeedback: true });
                display.appendChild(errorRow);
            }
        } catch (error) {
            // Remove thinking indicator if still there
            if (thinkingRow.parentNode) {
                display.removeChild(thinkingRow);
            }
            
            // Show error
            const errorRow = createChatMessageRow('error', `Error: ${error.message}`, { noFeedback: true });
            display.appendChild(errorRow);
        }
    }
    
    // Update status back to ready
    updateAIStatus('Ready', true);
    display.scrollTop = display.scrollHeight;
}

function updateAIStatus(text, isReady) {
    const statusEl = document.getElementById('aiStatus');
    if (statusEl) {
        const dot = statusEl.querySelector('.status-dot');
        const span = statusEl.querySelector('span:last-child');
        if (dot) {
            dot.style.backgroundColor = isReady ? '#00ffaa' : '#ffaa00';
        }
        if (span) {
            span.textContent = text;
        }
    }
}

function clearChat() {
    const display = document.getElementById('chatDisplay');
    if (display) {
        display.innerHTML = `
            <div class="ai-welcome">
                <div class="welcome-icon">🤖</div>
                <h3>Welcome to CoreLayer AI Assistant</h3>
                <p>I can help you manage your Hyper-V environment. Try commands like:</p>
                <ul>
                    <li><strong>"Start VM TestServer"</strong> - Start a virtual machine</li>
                    <li><strong>"List all VMs"</strong> - See all virtual machines</li>
                    <li><strong>"Show cluster status"</strong> - Check cluster health</li>
                    <li><strong>"Live migrate VM WebServer"</strong> - Migrate a VM</li>
                    <li><strong>"List cluster nodes"</strong> - See cluster nodes</li>
                    <li><strong>"Show host info"</strong> - View host details</li>
                    <li><strong>"Go to clustering"</strong> - Open cluster management</li>
                </ul>
            </div>
        `;
    }
    updateAIStatus('Ready', true);
}

// Add diagnostic button to VM toolbar
function addDiagnosticButton() {
    const vmToolbar = document.querySelector('.vm-toolbar');
    if (vmToolbar && !document.getElementById('diagnosticVMBtn')) {
        const diagBtn = document.createElement('button');
        diagBtn.className = 'toolbar-btn';
        diagBtn.id = 'diagnosticVMBtn';
        diagBtn.innerHTML = '🔍 Diagnose';
        diagBtn.onclick = runVMDiagnostics;
        vmToolbar.appendChild(diagBtn);
    }
}

// Run VM diagnostics
async function runVMDiagnostics() {
    const tbody = document.getElementById('vmTableBody');
    if (!tbody) return;
    
    let diagnosticInfo = [];
    setStatus('Running diagnostics...');
    
    tbody.innerHTML = '<tr><td colspan="5" style="text-align: center; color: #8a8a8d;">Running diagnostics...</td></tr>';
    
    // Test 1: Check Hyper-V availability
    try {
        const testResult = await ipcRenderer.invoke('check-hyperv');
        diagnosticInfo.push(`✅ Hyper-V Check: ${testResult ? 'Available' : 'Not Available'}`);
    } catch (e) {
        diagnosticInfo.push(`❌ Hyper-V Check: Failed - ${e.message}`);
    }
    
    // Test 2: PowerShell basic test
    try {
        const result = await ipcRenderer.invoke('run-hyperv-cmd', '$PSVersionTable.PSVersion.ToString()');
        if (result.success) {
            diagnosticInfo.push(`✅ PowerShell: Working (${result.stdout.trim()})`);
        } else {
            diagnosticInfo.push(`❌ PowerShell: Failed - ${result.error}`);
        }
    } catch (e) {
        diagnosticInfo.push(`❌ PowerShell: Exception - ${e.message}`);
    }
    
    // Test 3: Hyper-V module check
    try {
        const result = await ipcRenderer.invoke('run-hyperv-cmd', '(Get-Module -ListAvailable -Name Hyper-V).Name');
        if (result.success && result.stdout.includes('Hyper-V')) {
            diagnosticInfo.push(`✅ Hyper-V Module: Installed`);
        } else {
            diagnosticInfo.push(`❌ Hyper-V Module: Not found or not accessible`);
        }
    } catch (e) {
        diagnosticInfo.push(`❌ Hyper-V Module: Check failed`);
    }
    
    // Test 4: Try Get-VM command
    try {
        const result = await ipcRenderer.invoke('get-vms');
        if (result.success) {
            diagnosticInfo.push(`✅ Get-VM Command: Working (${result.vms.length} VMs found)`);
        } else {
            diagnosticInfo.push(`❌ Get-VM Command: ${result.error}`);
        }
    } catch (e) {
        diagnosticInfo.push(`❌ Get-VM: Exception - ${e.message}`);
    }
    
    // Display results
    tbody.innerHTML = `
        <tr>
            <td colspan="5" style="padding: 20px;">
                <div style="color: #00d9ff; margin-bottom: 15px; font-size: 12px;">
                    <strong>Diagnostic Results:</strong>
                </div>
                <div style="color: #e6e6e8; font-size: 11px; line-height: 2;">
                    ${diagnosticInfo.join('<br>')}
                </div>
                <div style="margin-top: 20px; padding-top: 15px; border-top: 1px solid #1a1f26;">
                    <div style="color: #8a8a8d; font-size: 10px; margin-bottom: 10px;">
                        <strong>Troubleshooting Steps:</strong><br>
                        1. Run the application as Administrator<br>
                        2. Open PowerShell as Admin and run: <code style="background: #1a1f26; padding: 2px 4px;">Enable-WindowsOptionalFeature -Online -FeatureName Microsoft-Hyper-V -All</code><br>
                        3. Ensure Hyper-V services are running: <code style="background: #1a1f26; padding: 2px 4px;">Get-Service vm*</code><br>
                        4. Check Windows Event Viewer for Hyper-V errors
                    </div>
                </div>
                <div style="margin-top: 15px;">
                    <button onclick="refreshVMs()" style="padding: 5px 15px; background: #00d9ff; border: none; color: #0a0e14; border-radius: 3px; cursor: pointer; font-weight: bold; margin-right: 10px;">
                        Retry Normal Refresh
                    </button>
                    <button onclick="runVMDiagnostics()" style="padding: 5px 15px; background: #1a1f26; border: 1px solid #00d9ff; color: #00d9ff; border-radius: 3px; cursor: pointer;">
                        Re-run Diagnostics
                    </button>
                </div>
            </td>
        </tr>
    `;
    
    setStatus('Diagnostics complete');
}

// ============================================
// CLUSTERING MANAGEMENT FUNCTIONS
// ============================================

// Initialize cluster tools view
function initClusterTools() {
    console.log('Initializing cluster tools...');
    
    // Set up tab switching
    setupClusteringTabs();
    
    // Set up button event handlers
    const clusterButtons = {
        'createClusterBtn': createCluster,
        'addNodeBtn': addNode,
        'removeNodeBtn': removeNode,
        'clusterStatusBtn': showClusterStatus,
        'clusterSettingsBtn': showClusterSettings,
        'clusterValidationBtn': validateCluster,
        'clusterReportsBtn': showClusterReports,
        'liveMigrateBtn': liveMigrate,
        'quickMigrateBtn': quickMigrate,
        'storageMigrateBtn': storageMigrate,
        'migrationStatusBtn': showMigrationStatus,
        'scheduledMigrateBtn': scheduledMigrate,
        'nodeConfigBtn': configureNode,
        'networkConfigBtn': configureNetwork,
        'storageConfigBtn': configureStorage,
        'resourceConfigBtn': configureResources,
        'nodeMonitoringBtn': monitorNodes,
        'enableClusteringBtn': enableClustering,
        'disableClusteringBtn': disableClustering,
        'clusterBackupBtn': backupCluster
    };
    
    // Attach event listeners
    for (const [id, handler] of Object.entries(clusterButtons)) {
        const btn = document.getElementById(id);
        if (btn) {
            // Remove existing listeners by cloning
            const newBtn = btn.cloneNode(true);
            btn.parentNode.replaceChild(newBtn, btn);
            
            newBtn.addEventListener('click', async (e) => {
                try {
                    await handler(e);
                } catch (error) {
                    console.error(`Error in ${id} handler:`, error);
                    alert(`Error executing action: ${error.message}`);
                }
            });
        }
    }
    
    // Load initial data for active tab
    loadClusterData();
    console.log('Cluster tools initialized');
}

// Set up clustering tab switching
function setupClusteringTabs() {
    const tabButtons = document.querySelectorAll('#clusteringView .tab-btn');
    
    tabButtons.forEach(button => {
        button.addEventListener('click', () => {
            const tabName = button.getAttribute('data-tab');
            
            // Remove active class from all buttons and content
            document.querySelectorAll('#clusteringView .tab-btn').forEach(btn => {
                btn.classList.remove('active');
            });
            document.querySelectorAll('#clusteringView .tab-content').forEach(content => {
                content.classList.remove('active');
                content.classList.add('hidden');
            });
            
            // Add active class to clicked button
            button.classList.add('active');
            
            // Show corresponding content
            const contentId = `${tabName}Tab`;
            const content = document.getElementById(contentId);
            if (content) {
                content.classList.remove('hidden');
                content.classList.add('active');
                
                // Refresh data for the selected tab
                switch(tabName) {
                    case 'clusterManagement':
                        loadClusterData();
                        break;
                    case 'migrations':
                        loadMigrationData();
                        break;
                    case 'nodeConfig':
                        loadNodeData();
                        break;
                    case 'hostClustering':
                        loadHostData();
                        break;
                }
            }
        });
    });
}

// Cluster Management Functions
async function createCluster() {
    alert('Create Cluster\n\nTo create a failover cluster:\n1. Install Failover Clustering feature on all nodes\n2. Run: New-Cluster -Name "ClusterName" -Node Node1,Node2 -StaticAddress IP\n\nRequires Windows Server with Failover Clustering feature.');
}

async function addNode() {
    alert('Add Node\n\nTo add a node to an existing cluster:\nRun: Add-ClusterNode -Name "NodeName" -Cluster "ClusterName"\n\nEnsure the node meets cluster requirements first.');
}

async function removeNode() {
    alert('Remove Node\n\nTo remove a node from a cluster:\nRun: Remove-ClusterNode -Name "NodeName" -Cluster "ClusterName" -Force\n\nEnsure workloads are migrated before removal.');
}

async function showClusterStatus() {
    setStatus('Checking cluster status...');
    try {
        const result = await ipcRenderer.invoke('execute-powershell', 'Get-Cluster | Select-Object Name, State | ConvertTo-Json');
        if (result.success && result.output) {
            alert(`Cluster Status:\n${result.output}`);
        } else {
            alert('No clusters found or Failover Clustering not installed.');
        }
    } catch (error) {
        alert('Could not retrieve cluster status. Failover Clustering may not be installed.');
    }
    setStatus('Ready');
}

async function showClusterSettings() {
    alert('Cluster Settings\n\nUse Failover Cluster Manager or PowerShell:\n• Get-Cluster | Format-List *\n• Set-ClusterQuorum for quorum settings\n• Get-ClusterNetwork for network configuration');
}

async function validateCluster() {
    alert('Validate Cluster\n\nRun cluster validation wizard:\nTest-Cluster -Node Node1,Node2 -Include "All"\n\nThis tests hardware and software configuration.');
}

async function showClusterReports() {
    alert('Cluster Reports\n\nAccess cluster reports via:\n1. Failover Cluster Manager > Reports\n2. Event Viewer > Applications and Services > Microsoft > Windows > FailoverClustering');
}

// Migration Functions
async function liveMigrate() {
    alert('Live Migration\n\nTo perform live migration:\nMove-VM -Name "VMName" -DestinationHost "TargetHost" -IncludeStorage\n\nRequires:\n• Shared storage or SMB storage\n• Same processor manufacturer\n• Configured delegation');
}

async function quickMigrate() {
    alert('Quick Migration\n\nQuick migration saves VM state before moving:\nMove-ClusterVirtualMachineRole -Name "VMName" -Node "TargetNode"\n\nCauses brief downtime during migration.');
}

async function storageMigrate() {
    alert('Storage Migration\n\nTo migrate VM storage:\nMove-VMStorage -VMName "VMName" -DestinationStoragePath "NewPath"\n\nCan be done without downtime.');
}

async function showMigrationStatus() {
    setStatus('Checking migration status...');
    alert('Migration Status\n\nCheck active migrations:\nGet-VMReplication\nGet-VM | Where-Object {$_.Status -like "*Migrating*"}');
    setStatus('Ready');
}

async function scheduledMigrate() {
    alert('Scheduled Migration\n\nUse Task Scheduler or System Center VMM to schedule migrations.\n\nOr create a PowerShell script with scheduled task.');
}

// Node Configuration Functions
async function configureNode() {
    alert('Node Configuration\n\nConfigure Hyper-V host settings:\n• Set-VMHost for host settings\n• Set-VMProcessor for processor compatibility\n• Configure virtual switch settings');
}

async function configureNetwork() {
    alert('Network Setup\n\nConfigure cluster networks:\n• New-VMSwitch for virtual switches\n• Get-ClusterNetwork for cluster networks\n• Set live migration network preferences');
}

async function configureStorage() {
    alert('Storage Configuration\n\nCluster storage options:\n• Cluster Shared Volumes (CSV)\n• SMB 3.0 file shares\n• Storage Spaces Direct (S2D)\n\nAdd-ClusterSharedVolume -Name "DiskName"');
}

async function configureResources() {
    alert('Resource Allocation\n\nConfigure resource pools and priorities:\n• New-VMResourcePool\n• Set-VMProcessor -RelativeWeight\n• Set-VMMemory -Priority');
}

async function monitorNodes() {
    setStatus('Loading node information...');
    try {
        const result = await ipcRenderer.invoke('execute-powershell', 'Get-VMHost | Select-Object Name, LogicalProcessorCount, MemoryCapacity | ConvertTo-Json');
        if (result.success && result.output) {
            alert(`Node Information:\n${result.output}`);
        } else {
            alert('Could not retrieve node information.');
        }
    } catch (error) {
        alert('Error monitoring nodes.');
    }
    setStatus('Ready');
}

// Host Clustering Functions
async function enableClustering() {
    alert('Enable Clustering\n\nTo enable Failover Clustering feature:\n\nInstall-WindowsFeature -Name Failover-Clustering -IncludeManagementTools\n\nRequires Windows Server and reboot.');
}

async function disableClustering() {
    alert('Disable Clustering\n\nTo disable Failover Clustering:\n1. Evict node from cluster first\n2. Remove-WindowsFeature -Name Failover-Clustering\n\nWarning: This will remove all cluster configuration.');
}

async function backupCluster() {
    alert('Cluster Backup\n\nBackup cluster configuration:\n• Export cluster configuration: Get-ClusterNode | Export-Clixml\n• Use Windows Server Backup for full backup\n• Backup quorum witness');
}

// Data Loading Functions
async function loadClusterData() {
    const tbody = document.getElementById('clusterTableBody');
    if (!tbody) return;
    
    tbody.innerHTML = '<tr><td colspan="6" style="text-align: center; color: #8a8a8d;">Checking for clusters...</td></tr>';
    
    try {
        const result = await ipcRenderer.invoke('execute-powershell', 'Get-Cluster | Select-Object Name, State | ConvertTo-Json');
        if (result.success && result.output && result.output.trim()) {
            const clusters = JSON.parse(result.output);
            const clusterArray = Array.isArray(clusters) ? clusters : [clusters];
            
            tbody.innerHTML = '';
            clusterArray.forEach(cluster => {
                const row = document.createElement('tr');
                row.innerHTML = `
                    <td>${cluster.Name || 'Unknown'}</td>
                    <td style="color: ${cluster.State === 'Online' ? '#00ffaa' : '#ff6b6b'}">${cluster.State || 'Unknown'}</td>
                    <td>-</td>
                    <td>-</td>
                    <td>-</td>
                    <td><button class="action-btn">Manage</button></td>
                `;
                tbody.appendChild(row);
            });
        } else {
            tbody.innerHTML = '<tr><td colspan="6" style="text-align: center; color: #8a8a8d;">No clusters found. Install Failover Clustering feature to manage clusters.</td></tr>';
        }
    } catch (error) {
        tbody.innerHTML = '<tr><td colspan="6" style="text-align: center; color: #8a8a8d;">Failover Clustering not available</td></tr>';
    }
}

async function loadMigrationData() {
    const tbody = document.getElementById('migrationTableBody');
    if (!tbody) return;
    
    tbody.innerHTML = '<tr><td colspan="7" style="text-align: center; color: #8a8a8d;">No active migrations</td></tr>';
}

async function loadNodeData() {
    const tbody = document.getElementById('nodeTableBody');
    if (!tbody) return;
    
    tbody.innerHTML = '<tr><td colspan="7" style="text-align: center; color: #8a8a8d;">Loading nodes...</td></tr>';
    
    try {
        const result = await ipcRenderer.invoke('execute-powershell', 'Get-VMHost | Select-Object Name, LogicalProcessorCount, MemoryCapacity | ConvertTo-Json');
        if (result.success && result.output) {
            const host = JSON.parse(result.output);
            const memGB = host.MemoryCapacity ? (host.MemoryCapacity / (1024**3)).toFixed(1) : 'N/A';
            
            tbody.innerHTML = `
                <tr>
                    <td>${host.Name || 'Local Host'}</td>
                    <td style="color: #00ffaa">Online</td>
                    <td>${host.LogicalProcessorCount || 'N/A'} cores</td>
                    <td>${memGB} GB</td>
                    <td>-</td>
                    <td>-</td>
                    <td><button class="action-btn">Configure</button></td>
                </tr>
            `;
        } else {
            tbody.innerHTML = '<tr><td colspan="7" style="text-align: center; color: #8a8a8d;">Could not load node information</td></tr>';
        }
    } catch (error) {
        tbody.innerHTML = '<tr><td colspan="7" style="text-align: center; color: #8a8a8d;">Error loading nodes</td></tr>';
    }
}

async function loadHostData() {
    const tbody = document.getElementById('hostTableBody');
    if (!tbody) return;
    
    tbody.innerHTML = '<tr><td colspan="7" style="text-align: center; color: #8a8a8d;">Loading host information...</td></tr>';
    
    try {
        const result = await ipcRenderer.invoke('execute-powershell', 'Get-VMHost | Select-Object Name, VirtualHardDiskPath, VirtualMachinePath | ConvertTo-Json');
        if (result.success && result.output) {
            const host = JSON.parse(result.output);
            
            tbody.innerHTML = `
                <tr>
                    <td>${host.Name || 'Local Host'}</td>
                    <td style="color: #00ffaa">Online</td>
                    <td>Standalone</td>
                    <td>-</td>
                    <td>Hyper-V</td>
                    <td>VM Host</td>
                    <td><button class="action-btn">Details</button></td>
                </tr>
            `;
        } else {
            tbody.innerHTML = '<tr><td colspan="7" style="text-align: center; color: #8a8a8d;">Could not load host information</td></tr>';
        }
    } catch (error) {
        tbody.innerHTML = '<tr><td colspan="7" style="text-align: center; color: #8a8a8d;">Error loading host data</td></tr>';
    }
}

// ==================== SETTINGS VIEW ====================

let settingsInitialized = false;

function initSettingsView() {
    if (settingsInitialized) return;
    settingsInitialized = true;
    
    // Settings tab navigation
    document.querySelectorAll('.settings-nav-btn').forEach(btn => {
        btn.addEventListener('click', () => {
            const tabName = btn.dataset.settingsTab;
            switchSettingsTab(tabName);
        });
    });
    
    // Save settings button
    const saveBtn = document.getElementById('saveSettingsBtn');
    if (saveBtn) {
        saveBtn.addEventListener('click', saveSettings);
    }
    
    // Reset settings button
    const resetBtn = document.getElementById('resetSettingsBtn');
    if (resetBtn) {
        resetBtn.addEventListener('click', resetSettings);
    }
    
    // Test AI connection button
    const testAIBtn = document.getElementById('testAIConnection');
    if (testAIBtn) {
        testAIBtn.addEventListener('click', testAIConnection);
    }
    
    // Real-time dark mode toggle
    const darkModeToggle = document.getElementById('settingDarkMode');
    if (darkModeToggle) {
        darkModeToggle.addEventListener('change', (e) => {
            if (e.target.checked) {
                document.body.classList.remove('light-mode');
            } else {
                document.body.classList.add('light-mode');
            }
        });
    }
    
    // Real-time accent color preview
    const colorPicker = document.getElementById('settingAccentColor');
    if (colorPicker) {
        colorPicker.addEventListener('input', (e) => {
            updateAccentColors(e.target.value);
            updateColorPresetSelection(e.target.value);
        });
    }
    
    // Color preset buttons
    document.querySelectorAll('.color-preset').forEach(btn => {
        btn.addEventListener('click', () => {
            const color = btn.dataset.color;
            if (color) {
                const colorPicker = document.getElementById('settingAccentColor');
                if (colorPicker) {
                    colorPicker.value = color;
                }
                updateAccentColors(color);
                updateColorPresetSelection(color);
            }
        });
    });
    
    // Real-time animations toggle
    const animationsToggle = document.getElementById('settingAnimations');
    if (animationsToggle) {
        animationsToggle.addEventListener('change', (e) => {
            if (e.target.checked) {
                document.body.classList.remove('no-animations');
            } else {
                document.body.classList.add('no-animations');
            }
        });
    }
    
    // Real-time compact mode toggle
    const compactToggle = document.getElementById('settingCompactMode');
    if (compactToggle) {
        compactToggle.addEventListener('change', (e) => {
            if (e.target.checked) {
                document.body.classList.add('compact-mode');
            } else {
                document.body.classList.remove('compact-mode');
            }
        });
    }
    
    // Load saved settings
    loadSettings();
    
    // Check AI connection status
    testAIConnection();
}

function updateColorPresetSelection(selectedColor) {
    document.querySelectorAll('.color-preset').forEach(btn => {
        btn.classList.toggle('active', btn.dataset.color.toLowerCase() === selectedColor.toLowerCase());
    });
}

function switchSettingsTab(tabName) {
    // Update nav buttons
    document.querySelectorAll('.settings-nav-btn').forEach(btn => {
        btn.classList.toggle('active', btn.dataset.settingsTab === tabName);
    });
    
    // Update panels
    document.querySelectorAll('.settings-panel').forEach(panel => {
        panel.classList.remove('active');
    });
    
    const panelMap = {
        'general': 'generalSettingsPanel',
        'hyperv': 'hypervSettingsPanel',
        'ai': 'aiSettingsPanel',
        'appearance': 'appearanceSettingsPanel',
        'about': 'aboutSettingsPanel'
    };
    
    const panel = document.getElementById(panelMap[tabName]);
    if (panel) {
        panel.classList.add('active');
    }
}

function loadSettings() {
    try {
        const savedSettings = localStorage.getItem('corelayer-settings');
        if (savedSettings) {
            const settings = JSON.parse(savedSettings);
            
            // General settings
            setCheckbox('settingAutoStart', settings.autoStart);
            setCheckbox('settingStartMinimized', settings.startMinimized);
            setCheckbox('settingConfirmActions', settings.confirmActions);
            setCheckbox('settingAutoRefresh', settings.autoRefresh);
            setSelectValue('settingRefreshInterval', settings.refreshInterval);
            
            // Hyper-V settings
            setInputValue('settingVMPath', settings.vmPath);
            setInputValue('settingVHDPath', settings.vhdPath);
            setInputValue('settingISOPath', settings.isoPath);
            setSelectValue('settingDefaultMemory', settings.defaultMemory);
            setSelectValue('settingDefaultCPUs', settings.defaultCPUs);
            setSelectValue('settingDefaultDisk', settings.defaultDisk);
            
            // AI settings
            setInputValue('settingOllamaURL', settings.ollamaURL);
            setSelectValue('settingAIModel', settings.aiModel);
            setCheckbox('settingAIEnabled', settings.aiEnabled);
            setCheckbox('settingAIAutoExecute', settings.aiAutoExecute);
            
            // Appearance settings
            setCheckbox('settingDarkMode', settings.darkMode !== false);
            setInputValue('settingAccentColor', settings.accentColor);
            setCheckbox('settingAnimations', settings.animations);
            setCheckbox('settingCompactMode', settings.compactMode);
            
            // Update color preset selection
            if (settings.accentColor) {
                updateColorPresetSelection(settings.accentColor);
            }
            
            // Apply settings to the application
            applySettings(settings);
        } else {
            // Apply default settings
            applySettings(getDefaultSettings());
        }
    } catch (error) {
        console.error('Error loading settings:', error);
    }
}

function getDefaultSettings() {
    return {
        autoStart: false,
        startMinimized: false,
        confirmActions: true,
        autoRefresh: true,
        refreshInterval: '10',
        vmPath: 'C:\\ProgramData\\Microsoft\\Windows\\Hyper-V',
        vhdPath: 'C:\\ProgramData\\Microsoft\\Windows\\Virtual Hard Disks',
        isoPath: 'C:\\ISO',
        defaultMemory: '2048',
        defaultCPUs: '2',
        defaultDisk: '50',
        ollamaURL: 'http://localhost:11434',
        aiModel: 'llama3',
        aiEnabled: true,
        aiAutoExecute: false,
        darkMode: true,
        accentColor: '#00d9ff',
        animations: true,
        compactMode: false
    };
}

function applySettings(settings) {
    // Apply dark/light mode
    if (settings.darkMode === false) {
        document.body.classList.add('light-mode');
    } else {
        document.body.classList.remove('light-mode');
    }
    
    // Apply accent color
    if (settings.accentColor) {
        document.documentElement.style.setProperty('--accent-color', settings.accentColor);
        updateAccentColors(settings.accentColor);
    }
    
    // Apply animations setting
    if (settings.animations === false) {
        document.body.classList.add('no-animations');
    } else {
        document.body.classList.remove('no-animations');
    }
    
    // Apply compact mode
    if (settings.compactMode === true) {
        document.body.classList.add('compact-mode');
    } else {
        document.body.classList.remove('compact-mode');
    }
    
    // Update refresh interval
    if (settings.refreshInterval) {
        window.statsRefreshInterval = parseInt(settings.refreshInterval) * 1000;
    }
    
    // Store settings globally for other functions to access
    window.appSettings = settings;
}

function updateAccentColors(color) {
    // Update CSS variables for accent color variations
    const root = document.documentElement;
    root.style.setProperty('--accent-color', color);
    root.style.setProperty('--accent-color-dim', color + '44');
    root.style.setProperty('--accent-color-bright', color);
    
    // Update specific elements that use the accent color
    const styleUpdate = document.getElementById('dynamic-accent-styles') || document.createElement('style');
    styleUpdate.id = 'dynamic-accent-styles';
    styleUpdate.textContent = `
        .sidebar-btn.active, .sidebar-btn:hover { color: ${color}; }
        .sidebar-btn::before { background: ${color}; }
        .sidebar-btn.active { background: linear-gradient(90deg, ${color}15, transparent); }
        .header-title { color: ${color}; }
        .settings-nav-btn.active { color: ${color}; border-left-color: ${color}; }
        .toggle-switch input:checked + .toggle-slider { background-color: ${color}33; }
        .toggle-switch input:checked + .toggle-slider:before { background-color: ${color}; }
        .settings-title { color: ${color}; }
        .about-name { color: ${color}; }
        .about-logo { border-color: ${color}44; }
        .settings-save-btn { background: linear-gradient(135deg, ${color}, ${color}aa); }
        .graph-widget .graph-title { color: ${color}; }
    `;
    if (!document.getElementById('dynamic-accent-styles')) {
        document.head.appendChild(styleUpdate);
    }
}

function applyTheme(theme) {
    const themeColors = {
        'dark-cyan': '#00d9ff',
        'dark-blue': '#4d88ff',
        'dark-purple': '#b366ff',
        'dark-green': '#00ff88'
    };
    
    const color = themeColors[theme] || themeColors['dark-cyan'];
    updateAccentColors(color);
    
    // Update the color picker to match
    const colorPicker = document.getElementById('settingAccentColor');
    if (colorPicker) {
        colorPicker.value = color;
    }
}

function saveSettings() {
    try {
        const settings = {
            // General
            autoStart: getCheckbox('settingAutoStart'),
            startMinimized: getCheckbox('settingStartMinimized'),
            confirmActions: getCheckbox('settingConfirmActions'),
            autoRefresh: getCheckbox('settingAutoRefresh'),
            refreshInterval: getSelectValue('settingRefreshInterval'),
            
            // Hyper-V
            vmPath: getInputValue('settingVMPath'),
            vhdPath: getInputValue('settingVHDPath'),
            isoPath: getInputValue('settingISOPath'),
            defaultMemory: getSelectValue('settingDefaultMemory'),
            defaultCPUs: getSelectValue('settingDefaultCPUs'),
            defaultDisk: getSelectValue('settingDefaultDisk'),
            
            // AI
            ollamaURL: getInputValue('settingOllamaURL'),
            aiModel: getSelectValue('settingAIModel'),
            aiEnabled: getCheckbox('settingAIEnabled'),
            aiAutoExecute: getCheckbox('settingAIAutoExecute'),
            
            // Appearance
            darkMode: getCheckbox('settingDarkMode'),
            accentColor: getInputValue('settingAccentColor'),
            animations: getCheckbox('settingAnimations'),
            compactMode: getCheckbox('settingCompactMode')
        };
        
        localStorage.setItem('corelayer-settings', JSON.stringify(settings));
        
        // Apply settings immediately
        applySettings(settings);
        
        // Show success message
        setStatus('Settings saved successfully');
        showNotification('Settings saved!', 'success');
    } catch (error) {
        console.error('Error saving settings:', error);
        showNotification('Failed to save settings', 'error');
    }
}

function resetSettings() {
    if (confirm('Are you sure you want to reset all settings to defaults?')) {
        localStorage.removeItem('corelayer-settings');
        
        const defaults = getDefaultSettings();
        
        // Reset form to defaults
        setCheckbox('settingAutoStart', defaults.autoStart);
        setCheckbox('settingStartMinimized', defaults.startMinimized);
        setCheckbox('settingConfirmActions', defaults.confirmActions);
        setCheckbox('settingAutoRefresh', defaults.autoRefresh);
        setSelectValue('settingRefreshInterval', defaults.refreshInterval);
        
        setInputValue('settingVMPath', defaults.vmPath);
        setInputValue('settingVHDPath', defaults.vhdPath);
        setInputValue('settingISOPath', defaults.isoPath);
        setSelectValue('settingDefaultMemory', defaults.defaultMemory);
        setSelectValue('settingDefaultCPUs', defaults.defaultCPUs);
        setSelectValue('settingDefaultDisk', defaults.defaultDisk);
        
        setInputValue('settingOllamaURL', defaults.ollamaURL);
        setSelectValue('settingAIModel', defaults.aiModel);
        setCheckbox('settingAIEnabled', defaults.aiEnabled);
        setCheckbox('settingAIAutoExecute', defaults.aiAutoExecute);
        
        setCheckbox('settingDarkMode', defaults.darkMode);
        setInputValue('settingAccentColor', defaults.accentColor);
        setCheckbox('settingAnimations', defaults.animations);
        setCheckbox('settingCompactMode', defaults.compactMode);
        updateColorPresetSelection(defaults.accentColor);
        
        // Apply default settings
        applySettings(defaults);
        
        showNotification('Settings reset to defaults', 'success');
    }
}

async function testAIConnection() {
    const statusEl = document.getElementById('aiConnectionStatus');
    if (!statusEl) return;
    
    const indicator = statusEl.querySelector('.status-indicator');
    const text = statusEl.querySelector('span:last-child');
    
    indicator.className = 'status-indicator checking';
    text.textContent = 'Checking...';
    
    try {
        const url = getInputValue('settingOllamaURL') || 'http://localhost:11434';
        const response = await fetch(`${url}/api/tags`, { 
            method: 'GET',
            timeout: 5000 
        });
        
        if (response.ok) {
            indicator.className = 'status-indicator connected';
            text.textContent = 'Connected';
        } else {
            indicator.className = 'status-indicator disconnected';
            text.textContent = 'Not responding';
        }
    } catch (error) {
        indicator.className = 'status-indicator disconnected';
        text.textContent = 'Disconnected';
    }
}

// Helper functions for settings
function setCheckbox(id, value) {
    const el = document.getElementById(id);
    if (el) el.checked = value === true || value === 'true';
}

function getCheckbox(id) {
    const el = document.getElementById(id);
    return el ? el.checked : false;
}

function setSelectValue(id, value) {
    const el = document.getElementById(id);
    if (el && value) el.value = value;
}

function getSelectValue(id) {
    const el = document.getElementById(id);
    return el ? el.value : '';
}

function setInputValue(id, value) {
    const el = document.getElementById(id);
    if (el && value) el.value = value;
}

function getInputValue(id) {
    const el = document.getElementById(id);
    return el ? el.value : '';
}

// Check if confirmation dialogs should be shown based on settings
function shouldConfirmAction() {
    if (window.appSettings && window.appSettings.confirmActions !== undefined) {
        return window.appSettings.confirmActions;
    }
    return true; // Default to showing confirmations
}

// Get AI settings
function getAISettings() {
    return {
        enabled: window.appSettings?.aiEnabled !== false,
        model: window.appSettings?.aiModel || 'llama3',
        url: window.appSettings?.ollamaURL || 'http://localhost:11434',
        autoExecute: window.appSettings?.aiAutoExecute === true
    };
}

// Get default VM settings from saved preferences
function getDefaultVMSettings() {
    return {
        memory: parseInt(window.appSettings?.defaultMemory) || 2048,
        cpus: parseInt(window.appSettings?.defaultCPUs) || 2,
        disk: parseInt(window.appSettings?.defaultDisk) || 50,
        vmPath: window.appSettings?.vmPath || 'C:\\ProgramData\\Microsoft\\Windows\\Hyper-V',
        vhdPath: window.appSettings?.vhdPath || 'C:\\ProgramData\\Microsoft\\Windows\\Virtual Hard Disks',
        isoPath: window.appSettings?.isoPath || 'C:\\ISO'
    };
}

function showNotification(message, type) {
    // Create a simple toast notification
    const toast = document.createElement('div');
    toast.style.cssText = `
        position: fixed;
        bottom: 20px;
        right: 20px;
        padding: 12px 20px;
        border-radius: 8px;
        font-size: 12px;
        z-index: 9999;
        animation: slideIn 0.3s ease;
        ${type === 'success' 
            ? 'background: #00ffaa22; color: #00ffaa; border: 1px solid #00ffaa44;' 
            : 'background: #ff555522; color: #ff5555; border: 1px solid #ff555544;'
        }
    `;
    toast.textContent = message;
    document.body.appendChild(toast);
    
    setTimeout(() => {
        toast.style.animation = 'fadeOut 0.3s ease';
        setTimeout(() => toast.remove(), 300);
    }, 3000);
}

// ==================== TASKS PANEL (VMware-style) ====================

const tasksList = [];
let taskIdCounter = 0;

function setupTasksPanel() {
    const tasksHeader = document.getElementById('tasksHeader');
    const tasksToggleBtn = document.getElementById('tasksToggleBtn');
    const tasksClearBtn = document.getElementById('tasksClearBtn');
    const tasksPanel = document.getElementById('tasksPanel');
    const mainArea = document.querySelector('.main-area');
    
    // Start collapsed by default
    tasksPanel?.classList.add('collapsed');
    
    // Toggle panel collapse
    if (tasksHeader) {
        tasksHeader.addEventListener('click', (e) => {
            if (!e.target.closest('.tasks-clear-btn')) {
                tasksPanel.classList.toggle('collapsed');
                // Adjust main area padding to fit above task panel
                if (mainArea) {
                    mainArea.style.paddingBottom = tasksPanel.classList.contains('collapsed') ? '36px' : '90px';
                }
            }
        });
    }
    
    // Clear completed tasks
    if (tasksClearBtn) {
        tasksClearBtn.addEventListener('click', (e) => {
            e.stopPropagation();
            clearCompletedTasks();
        });
    }
    
    // Update panel position when sidebar collapses
    const sidebar = document.getElementById('sidebar');
    if (sidebar) {
        const observer = new MutationObserver(() => {
            if (sidebar.classList.contains('collapsed')) {
                tasksPanel?.classList.add('sidebar-collapsed');
            } else {
                tasksPanel?.classList.remove('sidebar-collapsed');
            }
        });
        observer.observe(sidebar, { attributes: true, attributeFilter: ['class'] });
    }
}

function createTask(name, target, type = 'operation') {
    const taskId = ++taskIdCounter;
    const task = {
        id: taskId,
        name: name,
        target: target,
        type: type,
        status: 'running',
        progress: 0,
        startTime: new Date(),
        endTime: null
    };
    
    tasksList.unshift(task);
    renderTasks();
    
    return taskId;
}

function updateTaskProgress(taskId, progress) {
    const task = tasksList.find(t => t.id === taskId);
    if (task && task.status === 'running') {
        task.progress = Math.min(100, Math.max(0, progress));
        renderTasks();
    }
}

function completeTask(taskId, success = true) {
    const task = tasksList.find(t => t.id === taskId);
    if (task) {
        task.status = success ? 'success' : 'error';
        task.progress = 100;
        task.endTime = new Date();
        renderTasks();
        
        // Auto-remove successful tasks after 30 seconds
        if (success) {
            setTimeout(() => {
                const idx = tasksList.findIndex(t => t.id === taskId);
                if (idx > -1 && tasksList[idx].status === 'success') {
                    tasksList.splice(idx, 1);
                    renderTasks();
                }
            }, 30000);
        }
    }
}

function cancelTask(taskId) {
    const task = tasksList.find(t => t.id === taskId);
    if (task && task.status === 'running') {
        task.status = 'cancelled';
        task.endTime = new Date();
        renderTasks();
    }
}

function clearCompletedTasks() {
    const runningTasks = tasksList.filter(t => t.status === 'running');
    tasksList.length = 0;
    tasksList.push(...runningTasks);
    renderTasks();
}

function renderTasks() {
    const taskListEl = document.getElementById('tasksList');
    const tasksCountEl = document.getElementById('tasksCount');
    const tasksEmptyEl = document.getElementById('tasksEmpty');
    
    if (!taskListEl) return;
    
    // Update count
    const runningCount = tasksList.filter(t => t.status === 'running').length;
    if (tasksCountEl) {
        tasksCountEl.textContent = runningCount;
        tasksCountEl.style.display = runningCount > 0 ? 'inline' : 'none';
    }
    
    // Show/hide empty state
    if (tasksEmptyEl) {
        tasksEmptyEl.classList.toggle('hidden', tasksList.length > 0);
    }
    
    // Remove existing task items (keep empty state)
    taskListEl.querySelectorAll('.task-item').forEach(el => el.remove());
    
    // Render tasks
    tasksList.forEach(task => {
        const taskEl = document.createElement('div');
        taskEl.className = 'task-item';
        taskEl.dataset.taskId = task.id;
        
        const statusIcon = getTaskStatusIcon(task.status);
        const timeStr = formatTaskTime(task);
        
        taskEl.innerHTML = `
            <div class="task-status-icon ${task.status}">${statusIcon}</div>
            <div class="task-info">
                <div class="task-name">${escapeHtml(task.name)}</div>
                <div class="task-target">${escapeHtml(task.target)}</div>
            </div>
            <div class="task-progress-container">
                <div class="task-progress-bar">
                    <div class="task-progress-fill ${task.status === 'error' ? 'error' : ''}" style="width: ${task.progress}%"></div>
                </div>
                <div class="task-progress-text">${task.status === 'running' ? task.progress + '%' : task.status}</div>
            </div>
            <div class="task-time">${timeStr}</div>
            ${task.status === 'running' ? '<button class="task-cancel-btn" title="Cancel">✕</button>' : ''}
        `;
        
        // Cancel button handler
        const cancelBtn = taskEl.querySelector('.task-cancel-btn');
        if (cancelBtn) {
            cancelBtn.addEventListener('click', (e) => {
                e.stopPropagation();
                cancelTask(task.id);
            });
        }
        
        taskListEl.insertBefore(taskEl, tasksEmptyEl);
    });
}

function getTaskStatusIcon(status) {
    switch (status) {
        case 'running': return '⟳';
        case 'success': return '✓';
        case 'error': return '✗';
        case 'cancelled': return '⊘';
        default: return '○';
    }
}

function formatTaskTime(task) {
    if (task.status === 'running') {
        const elapsed = Math.floor((new Date() - task.startTime) / 1000);
        if (elapsed < 60) return `${elapsed}s`;
        return `${Math.floor(elapsed / 60)}m ${elapsed % 60}s`;
    } else if (task.endTime) {
        const duration = Math.floor((task.endTime - task.startTime) / 1000);
        if (duration < 60) return `${duration}s`;
        return `${Math.floor(duration / 60)}m ${duration % 60}s`;
    }
    return '';
}

// Update running task times periodically
setInterval(() => {
    const hasRunning = tasksList.some(t => t.status === 'running');
    if (hasRunning) {
        renderTasks();
    }
}, 1000);

// Helper to run tasks with progress tracking
async function runWithTask(name, target, asyncFn, progressUpdates = true) {
    const taskId = createTask(name, target);
    
    try {
        if (progressUpdates) {
            // Simulate progress updates for operations without real progress
            let progress = 0;
            const progressInterval = setInterval(() => {
                progress = Math.min(90, progress + Math.random() * 15);
                updateTaskProgress(taskId, Math.floor(progress));
            }, 500);
            
            const result = await asyncFn();
            
            clearInterval(progressInterval);
            updateTaskProgress(taskId, 100);
            completeTask(taskId, true);
            
            return result;
        } else {
            const result = await asyncFn();
            completeTask(taskId, true);
            return result;
        }
    } catch (error) {
        completeTask(taskId, false);
        throw error;
    }
}

// Initialize on load
window.addEventListener('DOMContentLoaded', () => {
    console.log('DOM Content Loaded, initializing app...');
    initApp();
});

// Error handler for uncaught errors
window.addEventListener('error', (event) => {
    console.error('Uncaught error:', event.error);
    setStatus('An error occurred');
});

// Log that the script loaded
console.log('Renderer.js loaded successfully');
