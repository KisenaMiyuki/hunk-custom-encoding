/**
 * Test-only host stub (plan §9.2).
 *
 * In production the Hunk host serves `hunkdiff/extension` through its Bun
 * loader hook. Under `bun test` there is no host, so we map the same
 * specifier to the vendored official runtime (types/hunkdiff-extension/),
 * which is the real emitted module — `HunkExtensionUserError` instances
 * behave identically to what the host would serve.
 */
import { plugin } from "bun";
import { fileURLToPath } from "node:url";

const extensionRuntime = await import(
  fileURLToPath(new URL("../types/hunkdiff-extension/index.js", import.meta.url))
);

plugin({
  name: "hunkdiff-extension-host-stub",
  setup(build) {
    build.module("hunkdiff/extension", () => ({
      exports: extensionRuntime,
      loader: "object",
    }));
  },
});
