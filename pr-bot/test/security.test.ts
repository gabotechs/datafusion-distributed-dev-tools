import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

function controllerScript(name: string): string {
  return readFileSync(
    new URL(`../controller/${name}`, import.meta.url),
    "utf8",
  );
}

test("validates every cache path passed to privileged build wrappers", () => {
  for (const name of ["prepare-cache", "cargo-fetch", "cargo-build"]) {
    const script = controllerScript(name);
    assert.match(script, /datafusion-pr-bot\/cache-paths/);
    assert.match(script, /validate_cache_path "\$\{target\}"/);
    assert.match(script, /validate_cache_path "\$\{cargo_home\}"/);
  }
  const helper = controllerScript("cache-paths");
  assert.match(
    helper,
    /\(targets\|cargo\)\/\(trusted\|untrusted\)-\[0-9a-f\]\{40\}/,
  );
  assert.match(helper, /\[0-9\]\+\/\(base\|head\)/);
});

test("hides controller state and cannot silently lose offline isolation", () => {
  for (const name of ["cargo-fetch", "cargo-build"]) {
    assert.match(
      controllerScript(name),
      /InaccessiblePaths=\/var\/lib\/datafusion-pr-bot/,
    );
  }
  const build = controllerScript("cargo-build");
  assert.match(build, /PrivateNetwork=yes/);
  assert.match(build, /--offline/);
  assert.match(build, /benchmarks\/Cargo\.toml/);
  assert.doesNotMatch(build, /benchmarks-remote/);
});

test("cache preparation performs filesystem changes as the build user", () => {
  const prepare = controllerScript("prepare-cache");
  assert.match(prepare, /umask 0007/);
  assert.match(
    prepare,
    /runuser --user benchmark-build --group benchmark-cache --.*mkdir/s,
  );
  assert.doesNotMatch(prepare, /install --directory/);
  assert.doesNotMatch(prepare, /chown/);
});
