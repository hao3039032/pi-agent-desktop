import coreWebVitals from "eslint-config-next/core-web-vitals";
import typescript from "eslint-config-next/typescript";

const eslintConfig = [
  {
    ignores: [
      ".claude/**",
      ".next/**",
      ".next-desktop/**",
      "test-results/**",
      "src-tauri/resources/server/**",
      // Fork: distro build artifacts (third-party code).
      "src-tauri/resources/pi-seed/**",
      "src-tauri/resources/git/**",
      "src-tauri/target/**",
      // demo/ is a separate Next.js project with its own lint config.
      "demo/**",
      // static-frontend/ is the migration's Vite project with its own lint
      // setup (docs/migration/README.md); Next rules do not apply to it.
      "static-frontend/**",
      // Generated, minified library bundles (scripts/build-preview-runtime.mjs).
      "public/preview-runtime/**",
    ],
  },
  ...coreWebVitals,
  ...typescript,
  {
    rules: {
      "react-hooks/immutability": "off",
      "react-hooks/refs": "off",
      "react-hooks/set-state-in-effect": "off",
    },
  },
];

export default eslintConfig;
