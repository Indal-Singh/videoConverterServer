import fs from 'fs-extra';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

class Logger {
    constructor(baseName) {
        this.logDir = path.join(process.cwd(), 'logs');
        this.logFile = path.join(this.logDir, `${baseName}_${Date.now()}.log`);
        this.initialize();
    }

    async initialize() {
        await fs.ensureDir(this.logDir);
        this.logStream = fs.createWriteStream(this.logFile);
    }

    log(message, type = 'INFO') {
        const timestamp = new Date().toISOString();
        const logMessage = `[${timestamp}] [${type}] ${message}\n`;
        
        // Write to file
        this.logStream.write(logMessage);
        
        // Write to console with colors
        const consoleMessage = this.getColoredMessage(message, type);
        console.log(consoleMessage);
    }

    getColoredMessage(message, type) {
        const colors = {
            INFO: '\x1b[36m', // Cyan
            ERROR: '\x1b[31m', // Red
            WARN: '\x1b[33m', // Yellow
            SUCCESS: '\x1b[32m', // Green
            DEBUG: '\x1b[35m' // Magenta
        };
        const reset = '\x1b[0m';
        return `${colors[type] || colors.INFO}[${type}] ${message}${reset}`;
    }

    info(message) {
        this.log(message, 'INFO');
    }

    error(message) {
        this.log(message, 'ERROR');
    }

    warn(message) {
        this.log(message, 'WARN');
    }

    success(message) {
        this.log(message, 'SUCCESS');
    }

    debug(message) {
        this.log(message, 'DEBUG');
    }

    async end() {
        if (this.logStream) {
            this.logStream.end();
        }
    }
}

export default Logger; 