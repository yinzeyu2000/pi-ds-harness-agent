import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

export default defineConfig({
	resolve: {
		alias: {
			"@pi-ds/harness-runtime/plugin-sdk": fileURLToPath(new URL("./src/plugin-sdk.ts", import.meta.url)),
			"@pi-ds/harness-runtime/testing": fileURLToPath(new URL("./src/testing/index.ts", import.meta.url)),
		},
	},
});
