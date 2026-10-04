import { defineConfig } from 'drizzle-kit';
import * as dotenv from 'dotenv';
import * as path from 'path';
import { databaseConnectionOptions } from './src/database/connection-options';

dotenv.config({
    path: path.resolve(__dirname, '../.env')
})

export default defineConfig({
    schema: './src/database/schema.ts',
    out: './drizzle',
    dialect: 'postgresql',
    dbCredentials: databaseConnectionOptions((name) => process.env[name]),
})
