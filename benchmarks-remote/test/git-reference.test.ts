import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { datafusionDistributedGitReference } from "../src/@git-reference";

function git(root: string, ...arguments_: string[]): string {
    return execFileSync("git", ["-C", root, ...arguments_], {
        encoding: "utf8",
        stdio: ["ignore", "pipe", "ignore"],
    }).trim();
}

function repository(): string {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "benchmark-git-reference-"));
    git(root, "init", "--initial-branch", "main");
    fs.writeFileSync(path.join(root, "README.md"), "fixture\n");
    git(root, "add", "README.md");
    git(
        root,
        "-c",
        "user.name=Benchmark Test",
        "-c",
        "user.email=benchmark@example.invalid",
        "commit",
        "-m",
        "fixture",
    );
    return root;
}

test("uses the checked-out branch as the Git reference", () => {
    const root = repository();
    try {
        git(root, "switch", "-c", "feature/benchmark-label");
        assert.equal(
            datafusionDistributedGitReference(root),
            "feature/benchmark-label",
        );
    } finally {
        fs.rmSync(root, { recursive: true, force: true });
    }
});

test("uses the checked-out commit for a detached worktree", () => {
    const root = repository();
    try {
        const commit = git(root, "rev-parse", "--short=12", "HEAD");
        git(root, "switch", "--detach", "HEAD");
        assert.equal(datafusionDistributedGitReference(root), commit);
    } finally {
        fs.rmSync(root, { recursive: true, force: true });
    }
});

test("does not fall back to an unknown reference", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "benchmark-no-git-"));
    try {
        assert.throws(
            () => datafusionDistributedGitReference(root),
            /Could not determine the Git reference/,
        );
    } finally {
        fs.rmSync(root, { recursive: true, force: true });
    }
});
