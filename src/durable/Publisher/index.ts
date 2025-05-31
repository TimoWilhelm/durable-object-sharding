import { DurableObject } from 'cloudflare:workers';
import type { PublishMessage } from '@/durable/shared';
import { count, eq } from 'drizzle-orm';
import { Temporal } from 'temporal-polyfill';
import * as schema from './db/schema';
import migrations from './db/drizzle/migrations.js';
import { DrizzleDurableObject } from '@/extension';

const MAX_CONNECTIONS = 2;

export class PublisherDurableObject extends DrizzleDurableObject<typeof schema, Env> {
	protected schema = schema;
	protected migrations = migrations;

	async alarm(alarmInfo?: AlarmInvocationInfo): Promise<void> {
		console.log('Alarm triggered', alarmInfo);

		await this.publish({
			id: self.crypto.randomUUID(),
			publisherId: this.ctx.id.toString(),
			content: 'ping',
		});

		const db = await this.getDb();
		const [{ count: numSubscribers }] = await db.select({ count: count() }).from(schema.subscribers);
		if (numSubscribers === 0) {
			await this.ctx.storage.deleteAll();
			return;
		}
		this.ctx.storage.setAlarm(Temporal.Now.instant().add({ seconds: 1 }).epochMilliseconds);
	}

	async subscribe(subscriberId: string): Promise<boolean> {
		const db = await this.getDb();
		const [{ count: numSubscribers }] = await db.select({ count: count() }).from(schema.subscribers);

		if (numSubscribers >= MAX_CONNECTIONS) {
			console.log(`Max connections reached: ${MAX_CONNECTIONS}`);
			return false;
		}

		await db.insert(schema.subscribers).values({ subscriberId });

		if ((await this.ctx.storage.getAlarm()) === null) {
			this.ctx.storage.setAlarm(Temporal.Now.instant().add({ seconds: 1 }).epochMilliseconds);
		}

		console.log(`New subscriber: ${subscriberId}`);

		return true;
	}

	async unsubscribe(subscriberId: string): Promise<void> {
		const db = await this.getDb();
		await db.delete(schema.subscribers).where(eq(schema.subscribers.subscriberId, subscriberId));
		console.log(`Removed subscriber: ${subscriberId}`);
		const id = this.env.DURABLE_SUBSCRIBER.idFromString(subscriberId);
		const stub = this.env.DURABLE_SUBSCRIBER.get(id);
		await stub.onUnsubscribed(this.ctx.id.toString());

		const [{ count: numSubscribers }] = await db.select({ count: count() }).from(schema.subscribers);
		if (numSubscribers === 0) {
			void this.ctx.blockConcurrencyWhile(async () => {
				await this.ctx.storage.deleteAlarm();
				await this.ctx.storage.deleteAll();
			});
		}
	}

	private async publish(message: PublishMessage): Promise<void> {
		console.log(`Publishing message: ${message.publisherId}: ${message.content}`);

		const db = await this.getDb();
		const subscribers = await db.query.subscribers.findMany({ columns: { subscriberId: true } });

		await Promise.all(
			subscribers.map(async ({ subscriberId }) => {
				const id = this.env.DURABLE_SUBSCRIBER.idFromString(subscriberId);
				const stub = this.env.DURABLE_SUBSCRIBER.get(id);
				try {
					await stub.onMessage(message);
				} catch (error) {
					console.error(`Error sending message to ${subscriberId}:`, error);
					await this.unsubscribe(subscriberId);
				}
			})
		);
	}
}
