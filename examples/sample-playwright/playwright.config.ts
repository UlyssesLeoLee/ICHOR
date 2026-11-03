import { defineConfig } from '@playwright/test';
export default defineConfig({testDir:'./tests',use:{baseURL:'https://example.com'},timeout:20000,retries:0});
