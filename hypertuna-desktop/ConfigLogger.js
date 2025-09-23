export class ConfigLogger {
    static log(operation, details) {
        const timestamp = new Date().toISOString();
        const logEntry = {
            timestamp,
            operation,
            module: details.module,
            method: details.method,
            filepath: details.filepath || 'localStorage',
            key: details.key,
            success: details.success !== undefined ? details.success : true,
            error: details.error,
            dataSize: details.dataSize
        };
        
        // Color coding for console
        const color = operation === 'SAVE' ? '\x1b[32m' : '\x1b[36m'; // Green for save, cyan for load
        const reset = '\x1b[0m';
        
        console.log(`${color}[CONFIG ${operation}]${reset} ${timestamp}`);
        console.log(`  Module: ${logEntry.module}`);
        console.log(`  Method: ${logEntry.method}`);
        console.log(`  Storage: ${logEntry.filepath}`);
        if (logEntry.key) console.log(`  Key: ${logEntry.key}`);
        if (logEntry.dataSize) console.log(`  Size: ${logEntry.dataSize} bytes`);
        if (logEntry.error) console.log(`  Error: ${logEntry.error}`);
        console.log('---');
        
        // Also store in localStorage for debugging
        try {
            const logs = JSON.parse(localStorage.getItem('config_logs') || '[]');
            logs.push(logEntry);
            // Keep only last 100 logs
            if (logs.length > 100) logs.shift();
            localStorage.setItem('config_logs', JSON.stringify(logs));
        } catch (e) {
            // Ignore logging errors
        }
        
        return logEntry;
    }
    
    static getDataSize(data) {
        try {
            return JSON.stringify(data).length;
        } catch {
            return 0;
        }
    }
}
