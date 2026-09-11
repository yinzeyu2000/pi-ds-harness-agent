import { createServiceToken, type HarnessPlugin } from "@pi-ds/harness-runtime/plugin-sdk";

export const EXAMPLE_GREETING = createServiceToken<string>("example.greeting");

export const exampleThirdPartyPlugin: HarnessPlugin<{ greeting: string }> = {
	manifest: { id: "example-third-party", version: "1.0.0", provides: [EXAMPLE_GREETING] },
	activate(context, config) {
		context.provide(EXAMPLE_GREETING, config.greeting);
	},
};
