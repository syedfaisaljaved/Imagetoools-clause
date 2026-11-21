import { startServer } from './server.js';

const { PORT = 8080, AGENT_PORT = 8081, DATA_DIR, APP_PASSWORD = '', VNC_PORT = 6080, PARALLEL = 3 } = process.env;
startServer({ port: +PORT, agentPort: +AGENT_PORT, dataDir: DATA_DIR, password: APP_PASSWORD, vncPort: +VNC_PORT, parallel: Math.max(1, Math.min(6, +PARALLEL || 3)) });
console.log(`App on :${PORT}${APP_PASSWORD ? '' : ' (no password set!)'}, agent API on 127.0.0.1:${AGENT_PORT}`);
