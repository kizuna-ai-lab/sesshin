import { execSync } from 'node:child_process';
export default function setup() {
  execSync('pnpm build', { stdio: 'inherit', cwd: process.cwd() });
}
