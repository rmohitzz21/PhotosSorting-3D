import type { NextConfig } from "next";

const config: NextConfig = {
  skipProxyUrlNormalize: true,
  serverExternalPackages: [
    "@electric-sql/pglite",
    "@electric-sql/pglite-pgvector",
  ],
};
export default config;
