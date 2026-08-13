import { defineConfig } from 'vite';
import path from 'path';

export default defineConfig({
    resolve: {
        alias: {
            './libsodium.mjs': path.resolve(__dirname, 'node_modules/libsodium/dist/modules-esm/libsodium.mjs'),
        }
    },
    build: {
        target: 'es2022',
        manifest: false,
        rollupOptions: {
            output: {
                entryFileNames: `[name].js`,
                chunkFileNames: `[name].js`,
                assetFileNames: `[name].[ext]`,
                manualChunks(id) {
                    if (id.includes("node_modules")) return "vendor";
                },
            }
        }
    },
})