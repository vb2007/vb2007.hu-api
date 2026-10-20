#!/usr/bin/env node
import { execFileSync } from "node:child_process";
import { nextVersion } from "./next-version.mjs";

export function versionBumpWarning({ devVersion, mainVersion, tags }) {
    if (devVersion !== mainVersion) return null;

    const { version } = nextVersion({ packageVersion: mainVersion, tags, headTags: [] });
    return `\`package.json\` is still ${mainVersion}, so merging releases v${version}. Bump it on \`dev\` for a minor or major release.`;
}

const git = (...args) => execFileSync("git", args, { encoding: "utf-8" });
const packageVersion = (ref) => JSON.parse(git("show", `${ref}:package.json`)).version;

if (import.meta.url === `file://${process.argv[1]}`) {
    const warning = versionBumpWarning({
        devVersion: packageVersion("origin/dev"),
        mainVersion: packageVersion("origin/main"),
        tags: git("tag", "--list", "v*").split("\n").filter(Boolean)
    });
    if (warning) console.log(warning);
}
