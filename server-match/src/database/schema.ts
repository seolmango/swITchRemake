import { pgTable, serial, varchar, text, timestamp, jsonb } from 'drizzle-orm/pg-core';

export const users = pgTable('users', {
    id: serial('id').primaryKey(),
    email: varchar('email', { length: 255 }).notNull().unique(),
    passwordHash: text('password_hash').notNull(),
    nickname: varchar('nickname', { length: 20 }).notNull().unique(),
    stats: jsonb('stats').default({ level: 0, xp: 0, games: 0, wins: 0, sw_try: 0, sw_su: 0, kill:0, death_order: 0 }).notNull(),
    createdAt: timestamp('created_at').defaultNow().notNull(),
    updatedAt: timestamp('updated_at').defaultNow().notNull(),
});