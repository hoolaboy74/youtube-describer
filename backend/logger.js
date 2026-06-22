const fs = require('fs');
const path = require('path');
const https = require('https');

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

let lastSentMessage = '';
let lastSentTime = 0;

const sendTelegramMessage = (message) => {
  const token = process.env.TELEGRAM_BOT_TOKEN;
  const chatId = process.env.TELEGRAM_CHAT_ID;
  if (!token || !chatId) {
    console.log('Telegram Token or Chat ID missing in environment.');
    return;
  }

  const now = Date.now();
  // Deduplicate identical error messages within 10 seconds
  if (message === lastSentMessage && now - lastSentTime < 10000) {
    return;
  }
  lastSentMessage = message;
  lastSentTime = now;

  const truncatedMessage = message.length > 3000 ? message.substring(0, 3000) + '... (truncated)' : message;
  const data = JSON.stringify({
    chat_id: chatId,
    text: `🚨 [Vurator System Alert]\n\n${truncatedMessage}`
  });

  const options = {
    hostname: 'api.telegram.org',
    port: 443,
    path: `/bot${token}/sendMessage`,
    method: 'POST',
    family: 4,
    headers: {
      'Content-Type': 'application/json',
      'Content-Length': Buffer.byteLength(data)
    }
  };

  const req = https.request(options, (res) => {
    res.on('data', () => {});
  });

  req.on('error', (e) => {
    console.error('Failed to send Telegram alert:', e);
  });

  req.write(data);
  req.end();
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

  // Trigger Telegram alert for critical errors
  if (level === 'error') {
    sendTelegramMessage(logMessage.trim());
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

