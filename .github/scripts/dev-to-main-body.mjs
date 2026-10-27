#!/usr/bin/env node
import { execFileSync } from "node:child_process";
import { appendFileSync, writeFileSync } from "node:fs";

export const unreleasedPrs = (pulls, commits) => {
    const unreleased = new Set(commits);
    return pulls
        .filter(
            (pr) =>
                pr.merged_at && (unreleased.has(pr.merge_commit_sha) || unreleased.has(pr.head.sha))
        )
        .sort((a, b) => b.merged_at.localeCompare(a.merged_at));
};

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

    const repo =
        process.env.GITHUB_REPOSITORY ??
        run("gh", "repo", "view", "--json", "nameWithOwner", "--jq", ".nameWithOwner");
    const commits = splitLines(run("git", "rev-list", "origin/main..origin/dev"));
    const pulls = [];
    for (let page = 1; ; page++) {
        const batch = JSON.parse(
            run(
                "gh",
                "api",
                `repos/${repo}/pulls?state=closed&base=dev&per_page=100&page=${page}`,
                "--jq",
                "map({number, merged_at, merge_commit_sha, head: {sha: .head.sha}})"
            )
        );
        pulls.push(...batch);
        if (batch.length < 100) break;
    }
    const prs = unreleasedPrs(pulls, commits).map(({ number }) => ({
        number,
        issues: closingIssues(number)
    }));

    writeFileSync(bodyFile, buildBody(`https://github.com/${repo}`, prs) + "\n");

    const lines = [`count=${prs.length}`, `body_file=${bodyFile}`];
    console.log(lines.join("\n"));
    if (process.env.GITHUB_OUTPUT)
        appendFileSync(process.env.GITHUB_OUTPUT, lines.join("\n") + "\n");
}
