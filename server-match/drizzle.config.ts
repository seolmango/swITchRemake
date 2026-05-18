import { defineConfig } from 'drizzle-kit';
import * as dotenv from 'dotenv';
import * as path from 'path';

console.log(path.resolve(__dirname, '../.env'));

dotenv.config({
    path: path.resolve(__dirname, '../.env')
})

const db_url = `postgres://${process.env.DB_USER}:${process.env.DB_PASSWORD}@${process.env.DB_HOST}:${process.env.DB_PORT}/${process.env.DB_NAME}`;

export default defineConfig({
    schema: './src/database/schema.ts',
    out: './drizzle',
    dialect: 'postgresql',
    dbCredentials: {
        url: db_url
    }
})