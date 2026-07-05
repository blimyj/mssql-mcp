import { config } from 'dotenv';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

// Load mssql-mcp/.env by absolute path derived from THIS file's location, so it
// works no matter what working directory opencode (or anyone) launches us from.
// Any variable already present in process.env (e.g. passed by the client) wins.
const here = dirname(fileURLToPath(import.meta.url));
config({ path: resolve(here, '../.env') });
