import { defineConfig } from "tsup";

export default defineConfig([
	{
		entry: ["src/index.ts"],
		format: ["esm", "cjs"],
		dts: false,
		sourcemap: true,
		clean: true,
		outDir: "dist",
	},
	{
		entry: ["src/cli.ts"],
		format: ["esm"],
		dts: false,
		// shebang is preserved from src/cli.ts
		outDir: "dist",
		clean: false,
	},
]);
