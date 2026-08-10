import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { controllerSetupFiles } from "../infra/setup.js";

function controllerScript(name: string): string {
  return readFileSync(
    new URL(`../controller/${name}`, import.meta.url),
    "utf8",
  );
}

function controllerSetupScript(name: string): URL {
  return new URL(`../controller/setup/${name}`, import.meta.url);
}

test("keeps controller setup fragments valid and version-independent", () => {
  const setup = controllerSetupFiles
    .map((name) => {
      const script = controllerSetupScript(name);
      execFileSync("bash", ["-n", fileURLToPath(script)]);
      return readFileSync(script, "utf8");
    })
    .join("\n");

  assert.match(setup, /kubectl_version=\{\{KUBECTL_VERSION\}\}/);
  assert.match(setup, /helm_version=\{\{HELM_VERSION\}\}/);
  assert.match(setup, /rustup_version=\{\{RUSTUP_VERSION\}\}/);
  assert.match(setup, /zig_version=\{\{ZIG_VERSION\}\}/);
  assert.doesNotMatch(setup, /kubectl_version=1\.|helm_version=4\./);
});

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
    const script = controllerScript(name);
    assert.match(script, /InaccessiblePaths=\/var\/lib\/datafusion-pr-bot/);
    assert.match(
      script,
      /PATH=\/var\/lib\/datafusion-pr-build\/\.cargo\/bin:\/usr\/local\/bin:\/usr\/bin/,
    );
    assert.match(script, /RUSTUP_TOOLCHAIN=1\.94\.0/);
  }
  const build = controllerScript("cargo-build");
  const fetch = controllerScript("cargo-fetch");
  assert.match(fetch, /nameserver.*\/etc\/resolv\.conf/);
  assert.match(fetch, /IPAddressAllow="\$\{dns_server\}"/);
  assert.match(build, /PrivateNetwork=yes/);
  assert.match(build, /--offline/);
  assert.match(build, /XDG_CACHE_HOME="\$\{cargo_home\}\/cache"/);
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
  assert.match(
    prepare,
    /runuser --user benchmark-build --group benchmark-cache --.*touch/s,
  );
  assert.doesNotMatch(prepare, /install --directory/);
  assert.doesNotMatch(prepare, /chown/);
});
