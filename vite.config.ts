import { defineConfig, Plugin } from 'vite';
import { cloudflare } from '@cloudflare/vite-plugin';
import path from 'path';

export default defineConfig({
	plugins: [cloudflare()],
	resolve: {
		alias: {
			'@': path.resolve(__dirname, './src'),
		},
	},
	optimizeDeps: {
		esbuildOptions: {
			loader: {
				'.sql': 'text',
			},
		},
	},
});
