import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
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

test("keeps the shared release installer valid", () => {
  const installer = fileURLToPath(
    new URL("../controller/install-release", import.meta.url),
  );
  execFileSync("bash", ["-n", installer]);
  const script = readFileSync(installer, "utf8");
  assert.match(script, /sha256sum/);
  assert.match(script, /chmod 0755 "\$\{release\}"/);
  assert.match(script, /controller\/datafusion-build/);
  assert.match(script, /\/etc\/sudoers\.d\/datafusion-pr-bot/);
  assert.match(script, /git clone -- "\$\{repository_url\}"/);
  assert.match(script, /benchmark-bot:benchmark-cache/);
  assert.match(script, /chmod --recursive g\+rX,o-rwx/);
  assert.match(
    script,
    /Environment=DATAFUSION_SOURCE_ROOT=\/opt\/datafusion-pr-bot\/datafusion-distributed/,
  );
  assert.match(script, /UMask=0027/);
  assert.match(script, /systemctl daemon-reload/);
  assert.match(script, /systemctl restart datafusion-pr-bot/);
});

test("isolates the shared harness build from controller credentials", () => {
  const buildPath = fileURLToPath(
    new URL("../controller/datafusion-build", import.meta.url),
  );
  execFileSync("bash", ["-n", buildPath]);
  const build = readFileSync(buildPath, "utf8");
  assert.match(build, /InaccessiblePaths=\/var\/lib\/datafusion-pr-bot/);
  assert.match(
    build,
    /find -P "\$\{source_root\}" -type f -exec chmod g\+r,o-rwx/,
  );
  assert.match(
    build,
    /PATH=\/var\/lib\/datafusion-pr-build\/\.cargo\/bin:\/usr\/local\/bin:\/usr\/bin/,
  );
  assert.match(build, /RUSTUP_TOOLCHAIN=1\.94\.0/);
  assert.match(build, /XDG_CACHE_HOME="\$\{cargo_home\}"/);
  assert.match(build, /nameserver.*\/etc\/resolv\.conf/);
  assert.match(build, /IPAddressAllow="\$\{dns_server\}"/);
  assert.match(build, /PrivateNetwork=yes/);
  assert.match(build, /--offline/);
  assert.match(
    build,
    /current\/benchmarks-remote\/engines\/datafusion\/Cargo\.toml/,
  );
  assert.match(build, /datafusion-distributed-benchmark-worker/);
  for (const obsolete of [
    "cache-paths",
    "prepare-cache",
    "cargo-fetch",
    "cargo-build",
  ]) {
    assert.equal(
      existsSync(
        fileURLToPath(new URL(`../controller/${obsolete}`, import.meta.url)),
      ),
      false,
    );
  }
});
