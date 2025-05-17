export { UserDurableObject } from '@/durable/User';
export { ChannelDurableObject } from '@/durable/Channel';

export default {
	async fetch(request, env, ctx): Promise<Response> {
		const url = new URL(request.url);
		if (url.pathname === '/ws' && request.headers.get('Upgrade') === 'websocket') {
			const id: DurableObjectId = env.USER_DURABLE_OBJECT.idFromName('foo');
			const stub = env.USER_DURABLE_OBJECT.get(id);
			return stub.fetch(request);
		}
		return new Response('Not found', { status: 404 });
	},
} satisfies ExportedHandler<Env>;
