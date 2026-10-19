#!/usr/bin/env node
import { execFileSync } from "node:child_process";
import { appendFileSync, readFileSync } from "node:fs";

const SEMVER = /^(\d+)\.(\d+)\.(\d+)$/;

const parse = (v) => {
    const m = SEMVER.exec(v);
    return m ? [Number(m[1]), Number(m[2]), Number(m[3])] : null;
};
const compare = (a, b) => a[0] - b[0] || a[1] - b[1] || a[2] - b[2];
const format = (v) => v.join(".");

export function nextVersion({ packageVersion, tags, headTags }) {
    const toVersions = (list) =>
        list
            .map((t) => (t.startsWith("v") ? parse(t.slice(1)) : null))
            .filter(Boolean)
            .sort(compare);

    const atHead = toVersions(headTags);
    if (atHead.length > 0) {
        return { version: format(atHead.at(-1)), isRelease: false };
    }

    const pkg = parse(packageVersion);
    if (!pkg) throw new Error(`package.json version "${packageVersion}" is not x.y.z`);

    const latest = toVersions(tags).at(-1);
    if (!latest || compare(pkg, latest) > 0) {
        return { version: format(pkg), isRelease: true };
    }
    return { version: format([latest[0], latest[1], latest[2] + 1]), isRelease: true };
}

const git = (...args) =>
    execFileSync("git", args, { encoding: "utf-8" }).split("\n").filter(Boolean);

if (import.meta.url === `file://${process.argv[1]}`) {
    const { version, isRelease } = nextVersion({
        packageVersion: JSON.parse(readFileSync("package.json", "utf-8")).version,
        tags: git("tag", "--list", "v*"),
        headTags: git("tag", "--points-at", "HEAD")
    });
    const shortSha = git("rev-parse", "--short=7", "HEAD")[0];

    const lines = [`version=${version}`, `is_release=${isRelease}`, `short_sha=${shortSha}`];
    console.log(lines.join("\n"));
    if (process.env.GITHUB_OUTPUT)
        appendFileSync(process.env.GITHUB_OUTPUT, lines.join("\n") + "\n");
}
