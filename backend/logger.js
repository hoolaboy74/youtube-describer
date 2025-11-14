const fs = require('fs');
const path = require('path');

const logsDir = path.join(__dirname, 'logs');

if (!fs.existsSync(logsDir)) {
  fs.mkdirSync(logsDir, { recursive: true });
}

const getLogFilePath = () => {
  // Get KST date string e.g., "2025-10-16"
  const kstDateString = new Date().toLocaleString('sv-SE', { timeZone: 'Asia/Seoul' });
  const datePart = kstDateString.substring(0, 10);
  return path.join(logsDir, `${datePart}.log`);
};

const log = (level, message) => {
  // Get KST timestamp string e.g., "2025-10-16 09:30:00"
  const timestamp = new Date().toLocaleString('sv-SE', { timeZone: 'Asia/Seoul' }).substring(0, 19);
  const logMessage = `[${timestamp}] [${level.toUpperCase()}] ${message}\n`;
  
  // Asynchronous append
  fs.appendFile(getLogFilePath(), logMessage, (err) => {
    if (err) {
      // Fallback to console if file logging fails
      console.error('Failed to write to log file:', err);
      console.error(logMessage);
    }
  });

  // Also log to console for immediate feedback during development
  if (process.env.NODE_ENV !== 'production') {
    console.log(logMessage.trim());
  }
};

const logger = {
  info: (...args) => log('info', args.join(' ')),
  warn: (...args) => log('warn', args.join(' ')),
  error: (...args) => {
    const message = args.map(arg => {
      if (arg instanceof Error) {
        return arg.stack || JSON.stringify(arg);
      }
      return arg;
    }).join(' ');
    log('error', message);
  },
  log: (...args) => log('info', args.join(' ')), // Treat .log as .info
};

module.exports = logger;
