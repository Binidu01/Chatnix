import { dirname } from "path";
import { fileURLToPath } from "url";
import { FlatCompat } from "@eslint/eslintrc";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const compat = new FlatCompat({
  baseDirectory: __dirname,
});

const eslintConfig = [
  ...compat.extends("next/core-web-vitals", "next/typescript"),
  {
    rules: {
      // Disable @ts-ignore vs @ts-expect-error rule
      "@typescript-eslint/ban-ts-comment": "off",
      
      // Allow 'any' type
      "@typescript-eslint/no-explicit-any": "off",
      
      // Allow unused variables
      "@typescript-eslint/no-unused-vars": "off",
      
      // Allow unescaped entities (quotes, apostrophes)
      "react/no-unescaped-entities": "off",
      
      // Allow img tags (if you want to keep using img instead of Image)
      "@next/next/no-img-element": "off",
      
      // Allow non-null assertions on optional chains
      "@typescript-eslint/no-non-null-asserted-optional-chain": "off",
      
      // Allow empty catch blocks
      "@typescript-eslint/no-empty-function": "off",
    },
  },
];

export default eslintConfig;