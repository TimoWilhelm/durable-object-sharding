import { DurableObject } from 'cloudflare:workers';
import type { ChannelMessage } from '@/durable/shared';
import { count, eq } from 'drizzle-orm';
import { type DrizzleSqliteDODatabase, drizzle } from 'drizzle-orm/durable-sqlite';
import { migrate } from 'drizzle-orm/durable-sqlite/migrator';
import * as schema from './db/schema';
import migrations from './db/drizzle/migrations.js';

const MAX_CONNECTIONS = 100;

export class ChannelDurableObject extends DurableObject<Env> {

	private db: DrizzleSqliteDODatabase<typeof schema>;

	constructor(ctx: DurableObjectState, env: Env) {
		super(ctx, env);
		this.db = drizzle(this.ctx.storage, { schema, logger: false });
		this.ctx.blockConcurrencyWhile(async () => {
			await migrate(this.db, migrations);
		});
	}

	async subscribe(durableObjectId: string): Promise<boolean> {
		const subscribers = await this.db.query.subscribers.findMany();

		if (subscribers.length >= MAX_CONNECTIONS) {
			return false;
		}

		await this.db.insert(schema.subscribers).values({ durableObjectId });
		return true;
	}

	async unsubscribe(durableObjectId: string): Promise<void> {
		await this.db.delete(schema.subscribers).where(eq(schema.subscribers.durableObjectId, durableObjectId)).returning({});
		const [{ count: numSubscribers }] = await this.db.select({ count: count() }).from(schema.subscribers);

		if (numSubscribers === 0) {
			this.ctx.storage.deleteAll();
		}
	}

	private async publish(message: ChannelMessage): Promise<void> {
		const subscribers = await this.db.query.subscribers.findMany();
		for (const subscriber of subscribers) {
			const id = this.env.USER_DURABLE_OBJECT.idFromString(subscriber.durableObjectId);
			const stub = this.env.USER_DURABLE_OBJECT.get(id);
			await stub.onChannelMessage(message);
		}
	}
}
