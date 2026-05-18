import { pgTable, serial, varchar, text, timestamp, jsonb } from 'drizzle-orm/pg-core';

export const users = pgTable('users', {
    id: serial('id').primaryKey(),
    email: varchar('email', { length: 255 }).notNull().unique(),
    passwordHash: text('password_hash').notNull(),
    nickname: varchar('nickname', { length: 50 }).notNull().unique(),
    stats: jsonb('stats').default({ wins: 0, losses: 0, rating: 1000 }).notNull(),
    createdAt: timestamp('created_at').defaultNow().notNull(),
    updatedAt: timestamp('updated_at').defaultNow().notNull(),
});