#!/usr/bin/env node
import { execFileSync } from "node:child_process";
import { appendFileSync, writeFileSync } from "node:fs";

const MERGE_SUBJECT = /^Merge pull request #(\d+) /;

export const prNumbers = (subjects) =>
    subjects
        .map((s) => MERGE_SUBJECT.exec(s)?.[1])
        .filter(Boolean)
        .map(Number);

export const buildBody = (repoUrl, prs) =>
    prs
        .map(({ number, issues }) =>
            [`- ${repoUrl}/pull/${number}`, ...issues.map((i) => `  - Resolves: #${i}`)].join("\n")
        )
        .join("\n");

const run = (cmd, ...args) => execFileSync(cmd, args, { encoding: "utf-8" }).trim();
const splitLines = (output) => output.split("\n").filter(Boolean);

const closingIssues = (number) =>
    splitLines(
        run(
            "gh",
            "pr",
            "view",
            String(number),
            "--json",
            "closingIssuesReferences",
            "--jq",
            ".closingIssuesReferences[].number"
        )
    ).map(Number);

if (import.meta.url === `file://${process.argv[1]}`) {
    const bodyFile = process.argv[2];
    if (!bodyFile) throw new Error("Usage: dev-to-main-body.mjs <body-file>");

    const subjects = splitLines(
        run("git", "log", "origin/main..origin/dev", "--merges", "--format=%s")
    );
    const prs = prNumbers(subjects).map((number) => ({ number, issues: closingIssues(number) }));

    const repo =
        process.env.GITHUB_REPOSITORY ??
        run("gh", "repo", "view", "--json", "nameWithOwner", "--jq", ".nameWithOwner");
    writeFileSync(bodyFile, buildBody(`https://github.com/${repo}`, prs) + "\n");

    const lines = [`count=${prs.length}`, `body_file=${bodyFile}`];
    console.log(lines.join("\n"));
    if (process.env.GITHUB_OUTPUT)
        appendFileSync(process.env.GITHUB_OUTPUT, lines.join("\n") + "\n");
}
