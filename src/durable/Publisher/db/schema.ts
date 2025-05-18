import { integer, sqliteTable, text } from 'drizzle-orm/sqlite-core';

export const subscribers = sqliteTable('subscribers', {
	id: integer('id', { mode: 'number' }).primaryKey({ autoIncrement: true }),
	subscriberId: text('subscriber_id').notNull(),
});
