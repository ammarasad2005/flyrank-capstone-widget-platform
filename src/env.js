import { existsSync } from 'node:fs';

// Node 20.19+ provides process.loadEnvFile. Keep .env optional so containers/CI
// can inject environment variables without a file.
if (existsSync('.env')) {
  process.loadEnvFile('.env');
}
