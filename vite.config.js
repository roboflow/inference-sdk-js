import { resolve } from "path";
import { defineConfig } from "vite";
import dts from "vite-plugin-dts";

export default defineConfig({
    resolve: {
        alias: {
            "@roboflow/inference-sdk": resolve(__dirname, "src/index.ts")
        }
    },
    build: {
        sourcemap: true,
        lib: {
            entry: resolve(__dirname, "src/index.ts"),
            name: "RoboflowClient",
            fileName: (format) => `index${format === "umd" ? "" : "." + format}.js`,
            formats: ["umd", "es"]
        },
        outDir: "dist",
        emptyOutDir: true
    },
    plugins: [dts({
        include: ["src/**/*.ts"],
        outDir: "dist"
    })]
});
