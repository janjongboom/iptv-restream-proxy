import js from "@eslint/js";
import { defineConfig } from "eslint/config";
import globals from "globals";
import path from "node:path";
import { fileURLToPath } from "node:url";
import tseslint from "typescript-eslint";

import noUnsafeHtmlProperties from "./eslint/rules/no-unsafe-html-properties.js";

const ROOT_DIR = path.dirname(fileURLToPath(import.meta.url));

export default defineConfig(
    {
        ignores: [".hls/**", "node_modules/**", "vendor/**"],
    },
    js.configs.recommended,
    ...tseslint.configs.recommendedTypeChecked,
    ...tseslint.configs.strictTypeChecked,
    {
        files: ["server/**/*.ts", "client/**/*.ts"],
        languageOptions: {
            globals: {
                ...globals.browser,
                ...globals.node,
            },
            parserOptions: {
                project: "./tsconfig.eslint.json",
                tsconfigRootDir: ROOT_DIR,
            },
        },
        plugins: {
            local: {
                rules: {
                    "no-unsafe-html-properties": noUnsafeHtmlProperties,
                },
            },
        },
        rules: {
            "no-unused-vars": "off",
            "@typescript-eslint/consistent-type-imports": [
                "error",
                {
                    prefer: "type-imports",
                },
            ],
            "@typescript-eslint/no-explicit-any": "error",
            "@typescript-eslint/no-floating-promises": "error",
            "@typescript-eslint/no-misused-promises": [
                "error",
                {
                    checksVoidReturn: {
                        arguments: false,
                        attributes: false,
                    },
                },
            ],
            "@typescript-eslint/no-unnecessary-condition": "off",
            "@typescript-eslint/no-unnecessary-type-parameters": "off",
            "@typescript-eslint/no-unused-vars": [
                "error",
                {
                    argsIgnorePattern: "^_",
                    caughtErrorsIgnorePattern: "^_",
                },
            ],
            "@typescript-eslint/only-throw-error": "error",
            "@typescript-eslint/require-await": "off",
            "@typescript-eslint/restrict-template-expressions": "off",
            "local/no-unsafe-html-properties": "error",
        },
    },
);
