import { defineConfig } from '@playwright/test';
export default defineConfig({ testDir: './tests', retries: 1, timeout: 20000, projects: [{ name: 'a' }] });
