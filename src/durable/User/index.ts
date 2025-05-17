import { DurableObject } from 'cloudflare:workers';
import type { ChannelMessage } from '@/durable/shared';
import { type DrizzleSqliteDODatabase, drizzle } from 'drizzle-orm/durable-sqlite';
import { migrate } from 'drizzle-orm/durable-sqlite/migrator';
import * as schema from './db/schema';
import migrations from './db/drizzle/migrations.js';

const MAX_SHARDS = 100;
const DO_KEY = "CHANNEL";

export class UserDurableObject extends DurableObject<Env> {
	private db: DrizzleSqliteDODatabase<typeof schema>;

	constructor(ctx: DurableObjectState, env: Env) {
		super(ctx, env);
		this.db = drizzle(this.ctx.storage, { schema, logger: false });
		this.ctx.blockConcurrencyWhile(async () => {
			await migrate(this.db, migrations);
		});
	}

	async fetch(request: Request): Promise<Response> {
		const url = new URL(request.url);
		if (url.pathname === '/ws' && request.headers.get('Upgrade') === 'websocket') {
			const pair = new WebSocketPair();
			this.ctx.acceptWebSocket(pair[1]);

			return new Response(null, {
				status: 101,
				webSocket: pair[0],
			});
		}
		return new Response('Not found', { status: 404 });
	}

	async webSocketMessage(ws: WebSocket, message: string | ArrayBuffer): Promise<void> {
		const channelResult = await this.db.query.channel.findFirst();
		if (channelResult === undefined) {
			await this.subscribeToChannel();
		}
	}

	async webSocketClose(ws: WebSocket, code: number, reason: string, wasClean: boolean): Promise<void> {
		await this.handleClose(ws);
	}

	async webSocketError(ws: WebSocket, error: unknown): Promise<void> {
		await this.handleClose(ws);
	}

	async onChannelMessage(message: ChannelMessage): Promise<void> {
		const webSockets = this.ctx.getWebSockets();
		if (webSockets.length === 0) {
			await this.unsubscribeFromChannel(message.channelId);
			this.ctx.storage.deleteAll();
			return;
		}

		const channelResult = await this.db.query.channel.findFirst();
		if (channelResult === undefined || message.channelId !== channelResult.channelId) {
			console.warn('received message from invalid channel');
			await this.unsubscribeFromChannel(message.channelId);
			return;
		}

		console.log('Received message:', message);
		// TODO: propagate to clients
	}

	private async handleClose(webSocket: WebSocket): Promise<void> {
		const webSockets = this.ctx.getWebSockets();
		if (webSockets.length === 0) {
			const channelResult = await this.db.query.channel.findFirst();
			if (channelResult !== undefined) {
				await this.unsubscribeFromChannel(channelResult.channelId);
			}
			this.ctx.storage.deleteAll();
		}
	}

	private async unsubscribeFromChannel(channelId: string): Promise<void> {
		const stub = this.env.CHANNEL_DURABLE_OBJECT.idFromString(channelId);
		const channel = this.env.CHANNEL_DURABLE_OBJECT.get(stub);
		await channel.unsubscribe(this.ctx.id.toString());
	}

	private async subscribeToChannel(): Promise<void> {
		const channelResult = await this.db.query.channel.findFirst();

		if (channelResult !== undefined) {
			return;
		}

		for (let i = 0; i < MAX_SHARDS; i++) {
			const id = this.env.CHANNEL_DURABLE_OBJECT.idFromName(`${DO_KEY}_${i}`);
			const stub = this.env.CHANNEL_DURABLE_OBJECT.get(id);
			const subscribed = await stub.subscribe(this.ctx.id.toString());
			if (subscribed) {
				this.db.insert(schema.channel).values({ channelId: id.toString() });
				return;
			}
		}

		throw new Error('too many shards');
	}
}
