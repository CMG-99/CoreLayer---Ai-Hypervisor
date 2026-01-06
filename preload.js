/*
 * © 2026 CoreLayer
 * All Rights Reserved.
 *
 * This source code is provided for evaluation purposes only.
 * Copying, modification, redistribution, or commercial use
 * is strictly prohibited without prior written permission.
 */


/**
 * Preload Script - Security Bridge
 * 
 * This script runs in a privileged context and safely exposes
 * only the necessary IPC methods to the renderer process.
 * 
 * Security features:
 * - Context isolation enabled
 * - Only whitelisted IPC channels exposed
 * - Input validation on all exposed methods
 * - No direct Node.js API access in renderer
 */

const { contextBridge, ipcRenderer } = require('electron');

// Whitelist of allowed IPC channels for invoke (request-response)
const ALLOWED_INVOKE_CHANNELS = [
    // VM Operations
    'run-hyperv-cmd',
    'execute-powershell',
    'get-vms',
    'get-vm-details',
    'start-vm',
    'stop-vm',
    'restart-vm',
    'shutdown-vm',
    'turnoff-vm',
    'delete-vm',
    'edit-vm',
    'launch-vmconnect',
    'check-hyperv',
    
    // Storage Operations
    'get-physical-disks',
    'get-storage-pools',
    'get-volumes',
    'get-virtual-disks',
    'delete-virtual-disk',
    'get-vhds',
    'create-vhd',
    'attach-vhd',
    'detach-vhd',
    'resize-vhd',
    'convert-vhd',
    'compact-vhd',
    'delete-vhd',
    'get-vm-stores',
    'optimize-disk',
    'check-disk-health',
    
    // ISO Management
    'get-iso-library',
    'add-iso',
    'remove-iso',
    'browse-for-iso',
    
    // Checkpoint Operations
    'get-checkpoints',
    'create-checkpoint',
    'apply-checkpoint',
    'remove-checkpoint',
    
    // Cluster Operations
    'get-cluster-nodes',
    'get-cluster-status',
    'live-migrate-vm',
    
    // System Operations
    'get-system-stats',
    'get-host-info',
    'get-resource-path',
    'get-app-icon-base64',
    
    // Dialog Operations
    'show-open-dialog',
    'show-save-dialog',
    
    // QoS Operations
    'get-qos-policies',
    'create-qos-policy',
    'edit-qos-policy',
    'delete-qos-policy'
];

// Whitelist of allowed IPC channels for send (one-way)
const ALLOWED_SEND_CHANNELS = [
    'app-ready',
    'window-minimize',
    'window-maximize',
    'window-close'
];

// Whitelist of allowed IPC channels for receive (from main)
const ALLOWED_RECEIVE_CHANNELS = [
    'vm-status-update',
    'task-progress',
    'notification'
];

// Input sanitization helper
function sanitizeInput(input) {
    if (typeof input === 'string') {
        // Remove potential script injection patterns
        return input
            .replace(/<script\b[^<]*(?:(?!<\/script>)<[^<]*)*<\/script>/gi, '')
            .replace(/javascript:/gi, '')
            .replace(/on\w+\s*=/gi, '');
    }
    if (typeof input === 'object' && input !== null) {
        if (Array.isArray(input)) {
            return input.map(sanitizeInput);
        }
        const sanitized = {};
        for (const key of Object.keys(input)) {
            sanitized[key] = sanitizeInput(input[key]);
        }
        return sanitized;
    }
    return input;
}

// Validate channel is in whitelist
function isValidChannel(channel, allowedChannels) {
    return typeof channel === 'string' && allowedChannels.includes(channel);
}

// Expose protected APIs to renderer
contextBridge.exposeInMainWorld('api', {
    /**
     * Invoke an IPC handler and wait for response
     * @param {string} channel - The IPC channel name
     * @param  {...any} args - Arguments to pass
     * @returns {Promise<any>} - Response from main process
     */
    invoke: async (channel, ...args) => {
        if (!isValidChannel(channel, ALLOWED_INVOKE_CHANNELS)) {
            console.error(`Blocked IPC invoke to unauthorized channel: ${channel}`);
            throw new Error(`IPC channel "${channel}" is not allowed`);
        }
        
        // Sanitize arguments
        const sanitizedArgs = args.map(sanitizeInput);
        
        try {
            return await ipcRenderer.invoke(channel, ...sanitizedArgs);
        } catch (error) {
            console.error(`IPC invoke error on channel ${channel}:`, error);
            throw error;
        }
    },
    
    /**
     * Send a one-way message to main process
     * @param {string} channel - The IPC channel name
     * @param  {...any} args - Arguments to pass
     */
    send: (channel, ...args) => {
        if (!isValidChannel(channel, ALLOWED_SEND_CHANNELS)) {
            console.error(`Blocked IPC send to unauthorized channel: ${channel}`);
            return;
        }
        
        const sanitizedArgs = args.map(sanitizeInput);
        ipcRenderer.send(channel, ...sanitizedArgs);
    },
    
    /**
     * Listen for messages from main process
     * @param {string} channel - The IPC channel name
     * @param {Function} callback - Callback function
     * @returns {Function} - Unsubscribe function
     */
    on: (channel, callback) => {
        if (!isValidChannel(channel, ALLOWED_RECEIVE_CHANNELS)) {
            console.error(`Blocked IPC listener on unauthorized channel: ${channel}`);
            return () => {};
        }
        
        const subscription = (event, ...args) => callback(...args);
        ipcRenderer.on(channel, subscription);
        
        // Return unsubscribe function
        return () => {
            ipcRenderer.removeListener(channel, subscription);
        };
    },
    
    /**
     * Listen for a message from main process once
     * @param {string} channel - The IPC channel name
     * @param {Function} callback - Callback function
     */
    once: (channel, callback) => {
        if (!isValidChannel(channel, ALLOWED_RECEIVE_CHANNELS)) {
            console.error(`Blocked IPC once listener on unauthorized channel: ${channel}`);
            return;
        }
        
        ipcRenderer.once(channel, (event, ...args) => callback(...args));
    }
});

// Expose platform info (safe, read-only)
contextBridge.exposeInMainWorld('platform', {
    isWindows: process.platform === 'win32',
    isMac: process.platform === 'darwin',
    isLinux: process.platform === 'linux',
    arch: process.arch,
    version: process.versions.electron
});

// Expose secure utilities
contextBridge.exposeInMainWorld('secureUtils', {
    /**
     * Safely escape HTML to prevent XSS
     * @param {string} str - String to escape
     * @returns {string} - Escaped string
     */
    escapeHtml: (str) => {
        if (typeof str !== 'string') return str;
        const div = document.createElement('div');
        div.textContent = str;
        return div.innerHTML;
    },
    
    /**
     * Validate that a path doesn't contain directory traversal
     * @param {string} path - Path to validate
     * @returns {boolean} - True if safe
     */
    isPathSafe: (path) => {
        if (typeof path !== 'string') return false;
        // Block directory traversal attempts
        return !path.includes('..') && 
               !path.includes('//') && 
               !path.match(/^[a-z]:/i) !== null;
    },
    
    /**
     * Sanitize a string for use in PowerShell commands
     * @param {string} str - String to sanitize
     * @returns {string} - Sanitized string
     */
    sanitizeForPowerShell: (str) => {
        if (typeof str !== 'string') return '';
        // Escape single quotes by doubling them (PowerShell convention)
        return str.replace(/'/g, "''");
    }
});

console.log('Preload script loaded - Security bridge initialized');


